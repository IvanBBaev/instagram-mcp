/**
 * Core configuration & account profiles (Layer 0).
 *
 * Parses the default profile from the bare `IG_*` environment variables and any
 * number of named profiles from `IG_PROFILE_<NAME>_*`, resolves each profile's
 * auth path, and exposes the active-account context (`AsyncLocalStorage`) the
 * registry uses to select a profile per tool call.
 *
 * Pure and deterministic: no network, no filesystem, no logging. Env-file
 * loading (dotenv), atomic rewrites and secret redaction live in other layers;
 * this module only reads an already-materialized environment map.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { InstagramError } from './types.js';
import type { AuthPath, ResolvedProfile } from './types.js';

/** Env map shape — both `process.env` and dotenv produce this. */
export type Env = Record<string, string | undefined>;

/** Result of {@link loadProfiles}. */
export interface LoadedProfiles {
  /** Every resolved profile; the default (`name === 'default'`) is always first. */
  profiles: ResolvedProfile[];
  /**
   * Profile used when a tool call passes no `account` (from `IG_ACTIVE_PROFILE`,
   * else `'default'`). Not validated here — {@link resolveProfile} throws a
   * clear error if it names a profile that does not exist.
   */
  defaultName: string;
}

/** Name of the profile built from the bare `IG_*` vars. */
export const DEFAULT_PROFILE_NAME = 'default';

/** Env prefix for named profiles. */
const NAMED_PREFIX = 'IG_PROFILE_';

/** Per-profile env suffixes, shared by the default and named profiles. */
const SUFFIXES = ['ACCESS_TOKEN', 'AUTH_PATH', 'ACCOUNT_ID', 'APP_ID', 'APP_SECRET'] as const;
type Suffix = (typeof SUFFIXES)[number];

/**
 * Accepted alias suffixes, mapped to their canonical suffix. `AUTH_MODE` is the
 * name used by the env catalog (architecture §12) and `.env.example`;
 * `AUTH_PATH` is this module's canonical name and what `login`/`refresh` write.
 * Both spellings work on the default **and** named profiles, so
 * `IG_PROFILE_<NAME>_*` really is "the same keys, prefixed". The canonical
 * suffix wins when a profile sets both.
 */
const SUFFIX_ALIASES: Readonly<Record<string, Suffix>> = { AUTH_MODE: 'AUTH_PATH' };

/**
 * Every accepted suffix spelling, longest first: if one suffix is ever an
 * underscore-boundary suffix of another (say `_ID` alongside `_ACCOUNT_ID`), the
 * shorter one would match first and slice the profile name short. No current
 * pair overlaps that way, so the order is not observable today — it is the
 * invariant that keeps adding a suffix from being a silent mis-parse.
 */
const READABLE_SUFFIXES: readonly string[] = [...SUFFIXES, ...Object.keys(SUFFIX_ALIASES)].sort(
  (a, b) => b.length - a.length,
);

/** The raw (string) fields collected for one profile before validation. */
type RawProfile = Partial<Record<Suffix, string>>;

const AUTH_PATHS: readonly AuthPath[] = ['ig-login', 'fb-login'];

function isAuthPath(value: string): value is AuthPath {
  return (AUTH_PATHS as readonly string[]).includes(value);
}

/** Trimmed value, or `undefined` when unset / blank. */
function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The concrete env var name a profile field is read from (for error messages). */
function envVarFor(name: string, suffix: string): string {
  return name === DEFAULT_PROFILE_NAME
    ? `IG_${suffix}`
    : `${NAMED_PREFIX}${name.toUpperCase()}_${suffix}`;
}

/** Collect the bare `IG_*` fields for the default profile. */
function readDefaultRaw(env: Env): RawProfile {
  return {
    ACCESS_TOKEN: env.IG_ACCESS_TOKEN,
    // `IG_AUTH_MODE` is the operator-facing name — architecture §12,
    // `.env.example` and every guide document that one; `IG_AUTH_PATH` matches
    // this module's field and is accepted as an alias. See
    // {@link SUFFIX_ALIASES}, which gives named profiles the same pair.
    // `IG_AUTH_PATH` wins when both are set, mirroring the named-profile rule
    // ("the canonical suffix wins") — note that makes the alias beat the
    // documented spelling, which only matters if an operator sets both.
    AUTH_PATH: clean(env.IG_AUTH_PATH) ?? clean(env.IG_AUTH_MODE),
    ACCOUNT_ID: env.IG_ACCOUNT_ID,
    APP_ID: env.IG_APP_ID,
    APP_SECRET: env.IG_APP_SECRET,
  };
}

/** Group `IG_PROFILE_<NAME>_<SUFFIX>` vars by lowercased profile name. */
function readNamedRaw(env: Env): Map<string, RawProfile> {
  const out = new Map<string, RawProfile>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith(NAMED_PREFIX)) continue;
    const rest = key.slice(NAMED_PREFIX.length);
    const spelling = READABLE_SUFFIXES.find(
      (s) => rest.length > s.length + 1 && rest.endsWith(`_${s}`),
    );
    if (spelling === undefined) continue;
    const suffix = SUFFIX_ALIASES[spelling] ?? (spelling as Suffix);
    const name = rest.slice(0, rest.length - (spelling.length + 1)).toLowerCase();
    // The bare `IG_*` vars own the default profile; ignore a colliding named one.
    if (name === '' || name === DEFAULT_PROFILE_NAME) continue;
    const existing = out.get(name) ?? {};
    // An alias never overwrites the canonical spelling (`_AUTH_PATH` wins).
    if (spelling !== suffix && existing[suffix] !== undefined) continue;
    existing[suffix] = value;
    out.set(name, existing);
  }
  return out;
}

/**
 * Resolve a profile's auth path: an explicit `AUTH_PATH` wins (rejected if it is
 * not a known value); otherwise infer `fb-login` when both an app id and app
 * secret are present (Path B needs them for `appsecret_proof`), else `ig-login`.
 */
function resolveAuthPath(name: string, raw: RawProfile): AuthPath {
  const explicit = clean(raw.AUTH_PATH);
  if (explicit !== undefined) {
    if (!isAuthPath(explicit)) {
      // Name both accepted spellings: the caller may have set either one, and a
      // message naming the variable they did not set reads like a bug.
      throw new InstagramError(
        `${envVarFor(name, 'AUTH_MODE')} (alias ${envVarFor(name, 'AUTH_PATH')}) has an unknown value '${explicit}'; expected 'ig-login' or 'fb-login'.`,
        { kind: 'validation' },
      );
    }
    return explicit;
  }
  const hasApp = clean(raw.APP_ID) !== undefined && clean(raw.APP_SECRET) !== undefined;
  return hasApp ? 'fb-login' : 'ig-login';
}

/** Validate and materialize one profile from its raw fields. */
function buildProfile(name: string, raw: RawProfile): ResolvedProfile {
  const accessToken = clean(raw.ACCESS_TOKEN);
  const appId = clean(raw.APP_ID);
  const appSecret = clean(raw.APP_SECRET);
  const accountId = clean(raw.ACCOUNT_ID);
  const authPath = resolveAuthPath(name, raw);

  if (accessToken === undefined) {
    throw new InstagramError(
      `Profile '${name}' has no access token; set ${envVarFor(name, 'ACCESS_TOKEN')}.`,
      { kind: 'validation' },
    );
  }
  if (authPath === 'fb-login' && (appId === undefined || appSecret === undefined)) {
    throw new InstagramError(
      `Profile '${name}' uses fb-login but is missing ${envVarFor(name, 'APP_ID')} / ${envVarFor(name, 'APP_SECRET')}.`,
      { kind: 'validation' },
    );
  }

  return { name, authPath, accessToken, accountId, appId, appSecret };
}

/**
 * Parse the default profile and all named profiles from `env`.
 *
 * @throws InstagramError `kind: 'validation'` — no default token, an unknown
 *   auth-path value, or an fb-login profile missing app credentials.
 */
export function loadProfiles(env: Env = process.env): LoadedProfiles {
  const defaultRaw = readDefaultRaw(env);
  if (clean(defaultRaw.ACCESS_TOKEN) === undefined) {
    throw new InstagramError(
      'No default profile configured; set IG_ACCESS_TOKEN (the default account token).',
      { kind: 'validation' },
    );
  }

  const profiles: ResolvedProfile[] = [buildProfile(DEFAULT_PROFILE_NAME, defaultRaw)];
  for (const [name, raw] of readNamedRaw(env)) {
    profiles.push(buildProfile(name, raw));
  }

  const active = clean(env.IG_ACTIVE_PROFILE)?.toLowerCase();
  return { profiles, defaultName: active ?? DEFAULT_PROFILE_NAME };
}

/**
 * Return the profile named `name` (case-insensitive), or the default profile
 * when `name` is omitted / blank.
 *
 * @throws InstagramError `kind: 'validation'` naming the configured profiles
 *   (names only — never token values) when no match is found.
 */
export function resolveProfile(profiles: ResolvedProfile[], name?: string): ResolvedProfile {
  const requested = clean(name) ?? DEFAULT_PROFILE_NAME;
  const target = requested.toLowerCase();
  const found = profiles.find((p) => p.name === target);
  if (found === undefined) {
    const names = profiles.map((p) => p.name).join(', ') || '(none)';
    throw new InstagramError(
      `Unknown account profile '${requested}'; configured profiles: ${names}.`,
      { kind: 'validation' },
    );
  }
  return found;
}

// --- Active-account context ------------------------------------------------

const accountContext = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `name` as the active account. Nested calls override; the value
 * is retrieved anywhere downstream via {@link currentAccount}. Always resolves
 * to a promise so sync and async handlers share one call shape.
 */
export function withAccount<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  return accountContext.run(name, async () => fn());
}

/** The active account name, or `undefined` outside any {@link withAccount}. */
export function currentAccount(): string | undefined {
  return accountContext.getStore();
}
