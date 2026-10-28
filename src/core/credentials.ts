/**
 * The env-file credential provider — the default {@link CredentialProvider}
 * (V3-P1, architecture §13) — and the auth provider that reads a profile's
 * CURRENT credentials through it on every attempt.
 *
 * The env-file provider is a thin port over the parser and the writer that
 * already exist: `load` / `resolve` read through `loadProfiles` /
 * `resolveProfile` (`core/config.ts`), `store` writes through
 * `writeCredentials` (`core/config-write.ts`). So the same env file, the same
 * keys and the same error messages hold as before the port existed.
 *
 * A stored update is kept in an in-process overlay on top of what the env
 * yields: the env map the server started with is not re-read from disk, so
 * without the overlay a later `load` would hand back the token `store` just
 * replaced.
 */

import { DEFAULT_PROFILE_NAME, loadProfiles, resolveProfile, type Env } from './config.js';
import { writeCredentials, type WriteCredentialsOptions } from './config-write.js';
import { createAuthProvider } from './auth.js';
import { processSecrets } from './redact.js';
import { isRecordableExpiry } from './time.js';
import { InstagramError } from './types.js';
import type { Clock } from './clock.js';
import type {
  AuthProvider,
  CredentialProvider,
  CredentialReceipt,
  CredentialUpdate,
  ProfileSet,
  ResolvedProfile,
  SecretRegistry,
} from './types.js';

/** Injection points for {@link envFileCredentialProvider}. */
export interface EnvFileCredentialOptions {
  /** Env map profiles are parsed from (default: `process.env`, read at `load` time). */
  env?: Env;
  /** Where returned and stored secrets are registered (default: the process-wide registry). */
  secrets?: Pick<SecretRegistry, 'register'>;
  /** Passed to `writeCredentials` on `store` (target directory, env, lock timeout). */
  write?: WriteCredentialsOptions;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A shallow copy, so a caller mutating a returned profile cannot reach the snapshot. */
function copy(profile: ResolvedProfile): ResolvedProfile {
  return { ...profile };
}

/**
 * The default credential provider: profiles from the env (`IG_ACCESS_TOKEN`,
 * `IG_PROFILE_<NAME>_*`, as loaded from the env file at start-up), writes to
 * the env file `writeCredentials` resolves (`IG_ENV_FILE`, else the XDG one).
 */
export function envFileCredentialProvider(opts: EnvFileCredentialOptions = {}): CredentialProvider {
  const secrets = opts.secrets ?? processSecrets;
  /** Profiles written by {@link store} in this process, by name. */
  const overlay = new Map<string, ResolvedProfile>();
  let snapshot: ProfileSet | undefined;

  const registerProfile = (profile: ResolvedProfile): void => {
    secrets.register(profile.accessToken);
    if (profile.appSecret !== undefined) secrets.register(profile.appSecret);
  };

  /** Re-read the env, lay the overlay on top and make that the snapshot. */
  const reload = (): ProfileSet => {
    const { profiles, defaultName } = loadProfiles(opts.env ?? process.env);
    const merged = profiles.map((p) => overlay.get(p.name) ?? p);
    for (const [name, profile] of overlay) {
      if (!merged.some((p) => p.name === name)) merged.push(profile);
    }
    merged.forEach(registerProfile);
    snapshot = { profiles: merged, defaultName };
    return snapshot;
  };

  /** The snapshot, loaded on first use (a `resolve` or `store` before any `load`). */
  const current = (): ProfileSet => snapshot ?? reload();

  return {
    kind: 'env-file',
    // `then` turns a parse or lookup error into a rejection, never a throw.
    load: () =>
      Promise.resolve().then(() => {
        const { profiles, defaultName } = reload();
        return { profiles: profiles.map(copy), defaultName };
      }),
    resolve: (name) =>
      Promise.resolve().then(() => {
        const set = current();
        const profile = resolveProfile(set.profiles, clean(name) ?? set.defaultName);
        registerProfile(profile);
        return copy(profile);
      }),
    async store(name, update: CredentialUpdate): Promise<CredentialReceipt> {
      // Registered first: from here on a failure message cannot carry them.
      secrets.register(update.accessToken);
      if (update.appSecret !== undefined) secrets.register(update.appSecret);
      const set = current();
      // Normalised exactly as `writeCredentials` keys it, so the snapshot and
      // the file agree on which profile was written.
      const key = (clean(name) ?? DEFAULT_PROFILE_NAME).toLowerCase();
      const existing = set.profiles.find((p) => p.name === key);
      const authPath = update.authPath ?? existing?.authPath;
      if (authPath === undefined) {
        throw new InstagramError(`Profile '${key}' is new; its auth path is required.`, {
          kind: 'validation',
        });
      }
      const accountId = clean(update.accountId) ?? existing?.accountId;
      const appId = clean(update.appId) ?? existing?.appId;
      const appSecret = clean(update.appSecret) ?? existing?.appSecret;
      const written = await writeCredentials(
        key,
        {
          accessToken: update.accessToken,
          authPath,
          accountId,
          appId,
          appSecret,
          expiresAtSec: update.expiresAtSec,
        },
        opts.write,
      );
      // `writeCredentials` refused a blank token, so `clean` is defined here.
      const accessToken = clean(update.accessToken) as string;
      const expiresAtSec = update.expiresAtSec;
      const profile: ResolvedProfile = {
        name: key,
        authPath,
        accessToken,
        accountId,
        appId,
        appSecret,
        // Mirrors what `loadProfiles` would read back: a recordable expiry is
        // written fingerprinted (so never unverified); anything else is cleared.
        ...(expiresAtSec !== undefined &&
          isRecordableExpiry(expiresAtSec) && { tokenExpiresAtSec: expiresAtSec }),
      };
      overlay.set(key, profile);
      const index = set.profiles.findIndex((p) => p.name === key);
      if (index === -1) set.profiles.push(profile);
      else set.profiles[index] = profile;
      return { location: written.path, keys: written.keys };
    },
  };
}

/**
 * An {@link AuthProvider} for `profile` whose `authParams` reads the profile's
 * CURRENT credentials from `credentials` on every attempt, so a token rotated
 * through {@link CredentialProvider.store} is used by the very next request
 * without a restart.
 *
 * The provider for the start-up profile is built eagerly, so a profile the
 * auth layer refuses (fb-login without an app secret) still fails at
 * construction exactly as `createAuthProvider` does, and `path` /
 * `defaultHost` come from it.
 */
export function resolvingAuthProvider(
  credentials: Pick<CredentialProvider, 'resolve'>,
  profile: ResolvedProfile,
  clock: Pick<Clock, 'now'>,
): AuthProvider {
  const initial = createAuthProvider(profile, clock);
  return {
    path: initial.path,
    defaultHost: initial.defaultHost,
    async authParams(host) {
      const latest = await credentials.resolve(profile.name);
      return createAuthProvider(latest, clock).authParams(host);
    },
  };
}
