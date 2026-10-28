/**
 * In-memory fakes for the 3.0 ports frozen by V3-01 (`src/core/types.ts`,
 * `src/mcp/define.ts`). Downstream tasks test against these instead of each
 * hand-rolling its own, so every fake honours the same documented contract:
 * case-insensitive profile lookup, secrets registered before they leave the
 * provider, a journal that can be told to fail, a ledger with the eviction rule.
 */
import { createRedactor } from '../../src/core/redact.js';
import { resolveProfile } from '../../src/core/config.js';
import { InstagramError, toProfileSummary } from '../../src/core/types.js';
import type {
  CredentialProvider,
  CredentialReceipt,
  CredentialUpdate,
  HashtagBudgetLedger,
  ProfileSet,
  ResolvedProfile,
  SecretRegistry,
} from '../../src/core/types.js';
import type {
  ProfileDirectory,
  ToolContext,
  WriteJournal,
  WriteJournalEntry,
} from '../../src/mcp/define.js';

/** Minimum length `registerSecret` accepts; mirrored so the fake behaves the same. */
const MIN_SECRET_LENGTH = 8;

// --- SecretRegistry ---------------------------------------------------------

export interface MemorySecretRegistry extends SecretRegistry {
  /** Every secret registered with THIS registry, in insertion order. */
  readonly secrets: ReadonlySet<string>;
}

/**
 * A registry with its own secret set. Its redactors mask that set (read live)
 * plus their `extraSecrets`; they are built on `createRedactor`, so they also
 * mask anything in the process-wide registry — a superset, never a gap.
 */
export function memorySecretRegistry(): MemorySecretRegistry {
  const secrets = new Set<string>();
  return {
    secrets,
    register(secret) {
      if (secret.length >= MIN_SECRET_LENGTH) secrets.add(secret);
    },
    redactor(opts) {
      const extra = opts?.extraSecrets ?? [];
      return (value) => createRedactor({ extraSecrets: [...secrets, ...extra] })(value);
    },
  };
}

// --- CredentialProvider -----------------------------------------------------

export interface MemoryCredentialProvider extends CredentialProvider {
  /** Every `store` call, in order — inspect, never mutate. */
  readonly stores: ReadonlyArray<{ name: string; update: CredentialUpdate }>;
}

/**
 * A {@link CredentialProvider} over an in-memory profile list. `resolve`
 * returns a copy of the CURRENT record, so a test can `store` a new token and
 * watch the next `resolve` pick it up — rotation without restart.
 */
export function memoryCredentialProvider(
  initial: ProfileSet,
  secrets: SecretRegistry = memorySecretRegistry(),
): MemoryCredentialProvider {
  const profiles = initial.profiles.map((p) => ({ ...p }));
  const stores: Array<{ name: string; update: CredentialUpdate }> = [];

  const registerAll = (p: ResolvedProfile): void => {
    secrets.register(p.accessToken);
    if (p.appSecret !== undefined) secrets.register(p.appSecret);
  };

  return {
    kind: 'memory',
    stores,
    load() {
      for (const p of profiles) registerAll(p);
      return Promise.resolve({
        profiles: profiles.map((p) => ({ ...p })),
        defaultName: initial.defaultName,
      });
    },
    resolve(name) {
      // A blank or absent name is the set's default, as the registry resolves it.
      const wanted = name === undefined || name.trim() === '' ? initial.defaultName : name;
      return Promise.resolve().then(() => {
        const found = resolveProfile(profiles, wanted);
        registerAll(found);
        return { ...found };
      });
    },
    store(name, update) {
      const key = name.trim().toLowerCase();
      if (update.accessToken.trim() === '') {
        return Promise.reject(
          new InstagramError('A stored access token must be non-blank.', { kind: 'validation' }),
        );
      }
      secrets.register(update.accessToken);
      if (update.appSecret !== undefined) secrets.register(update.appSecret);
      const index = profiles.findIndex((p) => p.name === key);
      const current = profiles[index];
      const authPath = update.authPath ?? current?.authPath;
      if (authPath === undefined) {
        return Promise.reject(
          new InstagramError(`Profile '${key}' is new; its auth path is required.`, {
            kind: 'validation',
          }),
        );
      }
      const accountId = update.accountId ?? current?.accountId;
      const appId = update.appId ?? current?.appId;
      const appSecret = update.appSecret ?? current?.appSecret;
      // Expiry and the "unverified" mark described the replaced token: an
      // absent `expiresAtSec` clears them rather than keeping the old record.
      const next: ResolvedProfile = {
        name: key,
        authPath,
        accessToken: update.accessToken,
        ...(accountId !== undefined && { accountId }),
        ...(appId !== undefined && { appId }),
        ...(appSecret !== undefined && { appSecret }),
        ...(update.expiresAtSec !== undefined && { tokenExpiresAtSec: update.expiresAtSec }),
      };
      if (current === undefined) profiles.push(next);
      else profiles[index] = next;
      stores.push({ name: key, update: { ...update } });
      const receipt: CredentialReceipt = {
        location: `memory:${key}`,
        keys: Object.keys(update).sort(),
      };
      return Promise.resolve(receipt);
    },
  };
}

// --- WriteJournal -----------------------------------------------------------

export interface MemoryJournal extends WriteJournal {
  /** Every appended entry, as received (already redacted by the gate). */
  readonly entries: readonly WriteJournalEntry[];
  /** When set, `append` rejects with this error instead of recording. */
  failWith: Error | undefined;
}

/** A {@link WriteJournal} that keeps entries in memory and can be made to fail. */
export function memoryJournal(): MemoryJournal {
  const entries: WriteJournalEntry[] = [];
  return {
    entries,
    failWith: undefined,
    append(entry) {
      if (this.failWith !== undefined) return Promise.reject(this.failWith);
      entries.push({ ...entry });
      return Promise.resolve();
    },
  };
}

// --- HashtagBudgetLedger ----------------------------------------------------

/** The documented ledger rule over a private map — the reference implementation. */
export function memoryHashtagLedger(): HashtagBudgetLedger {
  const byAccount = new Map<string, Map<string, number>>();
  return {
    record(accountId, hashtag, nowMs, windowMs) {
      let seen = byAccount.get(accountId);
      if (seen === undefined) {
        seen = new Map();
        byAccount.set(accountId, seen);
      }
      for (const [tag, firstSeen] of seen) {
        if (nowMs - firstSeen >= windowMs) seen.delete(tag);
      }
      if (!seen.has(hashtag)) seen.set(hashtag, nowMs);
      return seen.size;
    },
  };
}

// --- ProfileDirectory -------------------------------------------------------

/**
 * A {@link ProfileDirectory} over `profiles`: `list` is their summaries,
 * `contextFor` resolves the name like the registry and hands it to `build`.
 */
export function fakeProfileDirectory(
  set: ProfileSet,
  build: (profile: ResolvedProfile) => ToolContext,
): ProfileDirectory {
  return {
    defaultName: set.defaultName,
    list: () => set.profiles.map(toProfileSummary),
    contextFor: (name) => Promise.resolve().then(() => build(resolveProfile(set.profiles, name))),
  };
}
