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
import { createHash } from 'node:crypto';
import { isRecordableExpiry } from './time.js';
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
 * suffix wins when a profile sets both — unless it is blank, in which case the
 * alias is consulted (`clean(canonical) ?? clean(alias)`), the same rule on
 * both kinds of profile.
 */
const SUFFIX_ALIASES: Readonly<Record<string, Suffix>> = { AUTH_MODE: 'AUTH_PATH' };

/**
 * Every accepted suffix spelling, longest first: if one suffix is ever an
 * underscore-boundary suffix of another (say `_ID` alongside `_ACCOUNT_ID`), the
 * shorter one would match first and slice the profile name short. No current
 * pair overlaps that way, so the order is not observable today — it is the
 * invariant that keeps adding a suffix from being a silent mis-parse.
 *
 * Equivalent-mutant note: reversing the comparator therefore survives the suite,
 * and no test can kill it without inventing an overlapping suffix that the module
 * does not have. The sort stays because the failure it prevents is silent (a
 * profile name truncated at the wrong underscore, so the variable is read into a
 * profile nobody configured) and it is the day a suffix is ADDED that the order
 * starts mattering — exactly the day nobody re-derives this.
 */
const READABLE_SUFFIXES: readonly string[] = longestFirst([
  ...SUFFIXES,
  ...Object.keys(SUFFIX_ALIASES),
]);

/**
 * The credential-metadata suffix `login`/`refresh` persist beside the token
 * (`core/config-write.ts`): the token's absolute expiry in Unix seconds (`0` =
 * never expires). It is read back into {@link ResolvedProfile.tokenExpiresAtSec}
 * — Path A has no `debug_token`, so this record is the only expiry
 * `token_status` and `doctor` can report for it — but it is metadata, not a
 * credential field: it never creates a profile on its own, and a value that is
 * not a recordable expiry (`isRecordableExpiry`) is dropped (expiry unknown),
 * never an error.
 * The recognised-name audit ({@link isProfileEnvName}) must know it too, or the
 * server would warn about its own handwriting on every start after a `login`.
 */
export const TOKEN_EXPIRES_AT_SUFFIX = 'TOKEN_EXPIRES_AT';

/**
 * A short, one-way fingerprint of an access token: the first 12 hex digits of
 * its SHA-256. It binds a recorded expiry to the token it was written for
 * (CC-AUTH-59), so a token replaced by hand — or passed by the client while a
 * file still holds another token's record — does not inherit that record. It
 * is never the token: 48 bits of a digest of a long random secret identify the
 * token among the ones an operator has held, and recover nothing of it.
 */
export function tokenFingerprint(accessToken: string): string {
  return createHash('sha256').update(accessToken.trim()).digest('hex').slice(0, 12);
}

/**
 * The value `login`/`refresh` write under {@link TOKEN_EXPIRES_AT_SUFFIX}:
 * `<unix seconds>:<fingerprint>`. {@link parseExpiresAt} reads it back, and a
 * bare `<unix seconds>` (a record set by hand, or written before records carried
 * a fingerprint) is still read, unchecked against the token.
 */
export function formatExpiryRecord(expiresAtSec: number, accessToken: string): string {
  return `${expiresAtSec}:${tokenFingerprint(accessToken)}`;
}

/**
 * Every suffix that makes an `IG_<SUFFIX>` / `IG_PROFILE_<NAME>_<SUFFIX>` key
 * one this server owns: the fields it reads, their aliases, and the metadata it
 * writes. Same longest-first order as {@link READABLE_SUFFIXES}, for the same
 * reason.
 */
const OWNED_SUFFIXES: readonly string[] = longestFirst([
  ...READABLE_SUFFIXES,
  TOKEN_EXPIRES_AT_SUFFIX,
]);

/** The env var that selects the profile used when a tool call passes no `account`. */
const ACTIVE_PROFILE_ENV = 'IG_ACTIVE_PROFILE';

function longestFirst(suffixes: readonly string[]): readonly string[] {
  return [...suffixes].sort((a, b) => b.length - a.length);
}

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

/**
 * The concrete env var name a profile field is read from (for error messages).
 *
 * Exported so a sibling `core/` module that validates the SAME profile fields
 * (`core/auth.ts`, on the fb-login app secret) names the variable the operator
 * must actually set, rather than keeping its own copy of the scheme that can
 * drift from the one the parser reads.
 */
export function envVarFor(name: string, suffix: string): string {
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

/**
 * Split an `IG_PROFILE_<NAME>_<SUFFIX>` key into its lowercased profile name and
 * the suffix spelling it carries, or `undefined` when the key is not one the
 * named-profile scheme reads: no `IG_PROFILE_` prefix, a suffix outside
 * `suffixes`, an empty name (`IG_PROFILE__ACCESS_TOKEN`), or the name `default`
 * — the bare `IG_*` vars own the default profile, so a colliding named one is
 * ignored. ONE classifier for {@link readNamedRaw} (which reads the keys) and
 * {@link isProfileEnvName} (which vouches for them), so the audit can never
 * accept a key the parser drops, or the reverse.
 *
 * Equivalent-mutant note: the `name === ''` test is redundant with the
 * `rest.length > s.length + 1` guard — that guard is what rejects
 * `IG_PROFILE__ACCESS_TOKEN`, and a name can only come out empty when it
 * passes — so single-point mutation of EITHER survives the suite (relaxing the
 * guard to `>=` admits the empty name, which this test then drops; and dropping
 * this test leaves the guard doing the job). Removing both is observable. They
 * stay as a pair because they are guarding different mistakes: one is about
 * slicing a name out of a key, the other about which names are allowed to
 * exist, and a future edit to either has no reason to know it is the last line
 * of defence.
 */
function splitNamedKey(
  key: string,
  suffixes: readonly string[],
): { name: string; spelling: string } | undefined {
  if (!key.startsWith(NAMED_PREFIX)) return undefined;
  const rest = key.slice(NAMED_PREFIX.length);
  const spelling = suffixes.find((s) => rest.length > s.length + 1 && rest.endsWith(`_${s}`));
  if (spelling === undefined) return undefined;
  const name = rest.slice(0, rest.length - (spelling.length + 1)).toLowerCase();
  if (name === '' || name === DEFAULT_PROFILE_NAME) return undefined;
  return { name, spelling };
}

/**
 * Whether `key` is an environment variable the profile scheme owns: a field of
 * the default profile in either spelling (`IG_ACCESS_TOKEN`, `IG_AUTH_MODE`,
 * `IG_AUTH_PATH`, …), the same field of a named profile
 * (`IG_PROFILE_<NAME>_ACCESS_TOKEN`), the credential metadata `login` persists
 * beside them ({@link TOKEN_EXPIRES_AT_SUFFIX}), or `IG_ACTIVE_PROFILE`.
 *
 * This is the profile half of the recognised `IG_*` namespace; the composition
 * root joins it with the halves `core/settings.ts` and `mcp/registry.ts` own to
 * warn about a name nothing reads (CC-CFG-13). The classification is exactly
 * {@link readNamedRaw}'s — a named key carrying the reserved `default` name, or
 * no name at all, is one the parser drops, so here it is unrecognised and gets
 * reported, which is the whole point: until 2026-09-19 it was dropped without a
 * word.
 */
export function isProfileEnvName(key: string): boolean {
  if (key === ACTIVE_PROFILE_ENV) return true;
  if (key.startsWith(NAMED_PREFIX)) return splitNamedKey(key, OWNED_SUFFIXES) !== undefined;
  return OWNED_SUFFIXES.some((suffix) => key === `IG_${suffix}`);
}

/**
 * Group `IG_PROFILE_<NAME>_<SUFFIX>` vars by lowercased profile name.
 *
 * Alias spellings are collected apart from the canonical ones and folded in
 * once the walk is over, so the outcome never depends on `Object.entries`
 * order and a present-but-blank canonical falls through to the alias exactly
 * as `readDefaultRaw` does with `clean(IG_AUTH_PATH) ?? clean(IG_AUTH_MODE)`.
 * (Folding while walking would need to know whether the value already stored
 * came from the canonical or the alias spelling — the order-dependence this
 * shape exists to rule out.)
 */
function readNamedRaw(env: Env): Map<string, RawProfile> {
  const out = new Map<string, RawProfile>();
  const aliased = new Map<string, RawProfile>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const split = splitNamedKey(key, READABLE_SUFFIXES);
    if (split === undefined) continue;
    const { name, spelling } = split;
    const suffix = SUFFIX_ALIASES[spelling] ?? (spelling as Suffix);
    // Register the profile on its first key of EITHER spelling: `loadProfiles`
    // reports profiles in the order the env introduced them, and an alias-only
    // profile must not be pushed to the back just because it is folded in later.
    const existing = out.get(name) ?? {};
    out.set(name, existing);
    if (spelling === suffix) {
      existing[suffix] = value;
      continue;
    }
    const aliases = aliased.get(name) ?? {};
    aliases[suffix] = value;
    aliased.set(name, aliases);
  }
  for (const [name, raw] of out) {
    const aliases = aliased.get(name);
    if (aliases === undefined) continue;
    for (const suffix of Object.keys(aliases) as Suffix[]) {
      raw[suffix] = clean(raw[suffix]) ?? clean(aliases[suffix]);
    }
  }
  return out;
}

/**
 * The longest unknown `AUTH_MODE`/`AUTH_PATH` value the refusal echoes back.
 * Every plausible typo of a mode name ('instagram_business_login' is 24) fits;
 * an app secret (32 hex) or any access token does not.
 */
const MAX_ECHOED_AUTH_PATH_LENGTH = 24;

/**
 * Resolve a profile's auth path: an explicit `AUTH_PATH` wins (rejected if it is
 * not a known value); otherwise infer `fb-login` when both an app id and app
 * secret are present (Path B needs them for `appsecret_proof`), else `ig-login`.
 */
function resolveAuthPath(name: string, raw: RawProfile): AuthPath {
  const explicit = clean(raw.AUTH_PATH);
  if (explicit !== undefined) {
    // Case-insensitive like every other enum knob (CC-CFG-13) and like
    // `login --path`, which already folds `IG`/`FB`; the canonical lower-case
    // value is what every `authPath === 'fb-login'` downstream compares against.
    const path = explicit.toLowerCase();
    if (!isAuthPath(path)) {
      // Name both accepted spellings: the caller may have set either one, and a
      // message naming the variable they did not set reads like a bug. Echo the
      // value as typed — the operator is looking for it in their own file — but
      // only while it is short enough to be a mistyped mode name. A longer value
      // is far more likely a credential pasted into the wrong variable, and this
      // refusal is thrown before any secret is registered, so only the
      // token-shape backstop would stand between it and stderr: a 32-hex app
      // secret matches no shape and would print verbatim.
      const shown =
        explicit.length <= MAX_ECHOED_AUTH_PATH_LENGTH
          ? `'${explicit}'`
          : `of ${explicit.length} characters (not echoed — it may be a credential set under the wrong name)`;
      throw new InstagramError(
        `${envVarFor(name, 'AUTH_MODE')} (alias ${envVarFor(name, 'AUTH_PATH')}) has an unknown value ${shown}; expected 'ig-login' or 'fb-login'.`,
        { kind: 'validation' },
      );
    }
    return path;
  }
  const hasApp = clean(raw.APP_ID) !== undefined && clean(raw.APP_SECRET) !== undefined;
  return hasApp ? 'fb-login' : 'ig-login';
}

/**
 * The recorded token expiry, or `undefined` when it is absent or unusable.
 *
 * The value is operator-editable file content, so it is validated rather than
 * trusted: only a plain non-negative integer of Unix seconds (`0` is the
 * never-expires sentinel) no later than 9999-12-31T23:59:59Z is accepted,
 * optionally followed by `:` and the {@link tokenFingerprint} of the token it
 * was recorded for (what `login`/`refresh` write) — which must then be the
 * fingerprint of `accessToken`. Anything else — an ISO string, a fraction, a
 * sign, `Infinity`, an absurd magnitude, an expiry in epoch milliseconds
 * (thirteen digits, past the ceiling — CC-AUTH-66) — reads as "expiry
 * unknown". Refusing to start over a metadata line would be out of all
 * proportion, and guessing at what a malformed line meant would report an
 * expiry nobody recorded.
 *
 * `unverified` is `true` for a bare `<seconds>` record: it is still read (the
 * unknown-expiry warning tells operators to set one by hand, and records from
 * before the fingerprint are bare), but nothing ties it to the token, so the
 * diagnostics report it as unverified rather than as a token fact (CC-AUTH-70).
 */
function parseExpiresAt(
  value: string | undefined,
  accessToken: string,
): { sec: number; unverified: boolean } | undefined {
  const v = clean(value);
  const record = v === undefined ? null : /^(\d+)(?::([0-9a-f]{12}))?$/.exec(v);
  if (record === null) return undefined;
  // A fingerprinted record describes the token it was written for and no other
  // (CC-AUTH-59): a mismatch means the token was replaced since, so the expiry
  // is unknown rather than the previous token's.
  // Equivalent-mutant note: loosening the fingerprint class (`[0-9a-f]+`, or
  // admitting upper case) survives, because a fingerprint of any other shape
  // cannot equal `tokenFingerprint()`'s 12 lower-case hex digits and so fails
  // the comparison below instead of the pattern — unknown either way. The
  // strict class stays so the pattern documents the format it reads.
  const [, digits, fingerprint] = record;
  if (fingerprint !== undefined && fingerprint !== tokenFingerprint(accessToken)) return undefined;
  const sec = Number(digits);
  // The same predicate the writers apply (CC-AUTH-65), so a record `login` or
  // `refresh` wrote always reads back, and one they would refuse never does.
  return isRecordableExpiry(sec) ? { sec, unverified: fingerprint === undefined } : undefined;
}

/**
 * Collect each named profile's recorded expiry, keyed by lowercased name. Kept
 * apart from {@link readNamedRaw} on purpose: an expiry line left behind for a
 * profile whose token was removed must not conjure that profile back into
 * existence (and fail the start on its missing token).
 */
function readNamedExpiries(env: Env): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const split = splitNamedKey(key, OWNED_SUFFIXES);
    if (split?.spelling === TOKEN_EXPIRES_AT_SUFFIX) out.set(split.name, value);
  }
  return out;
}

/**
 * The literal an MCPB host may pass for an optional `user_config` field the user
 * left empty: the unexpanded template itself, e.g. `${user_config.IG_ACCOUNT_ID}`.
 */
const MCPB_UNSET_PLACEHOLDER = /^\$\{user_config\.[^}]+\}$/;

/**
 * The `IG_*` keys of `env` whose value is an unexpanded MCPB `user_config`
 * placeholder (CC-CFG-46). Such a value means "the user set nothing", so the
 * composition root deletes these keys before anything reads the environment:
 * read as a value, the template would outrank the config-home file (the client's
 * environment always wins) and be sent to Graph as an account id, or name a
 * nonexistent `IG_ENV_FILE` and refuse the start. Only the whole value counts —
 * a token or caption that merely contains the text is left alone.
 */
export function unsetPlaceholderKeys(env: Env): string[] {
  return Object.keys(env).filter(
    (key) => key.startsWith('IG_') && MCPB_UNSET_PLACEHOLDER.test(env[key]?.trim() ?? ''),
  );
}

/** The profile and suffix spelling an owned `IG_*` key belongs to, if any. */
function ownedKeyOf(key: string): { name: string; spelling: string } | undefined {
  if (key.startsWith(NAMED_PREFIX)) return splitNamedKey(key, OWNED_SUFFIXES);
  const spelling = OWNED_SUFFIXES.find((s) => key === `IG_${s}`);
  return spelling === undefined ? undefined : { name: DEFAULT_PROFILE_NAME, spelling };
}

/**
 * The recorded-expiry keys ({@link TOKEN_EXPIRES_AT_SUFFIX}) that came from a
 * different source than their profile's access token, per `sourceOf` (an env
 * file path, or the process environment the MCP client passed in).
 *
 * A record describes the token `login`/`refresh` stored beside it. The env
 * files are merged under the client's environment key by key, so a token the
 * client passes (or one a higher-priority file supplies) can end up paired with
 * an expiry the file recorded for a DIFFERENT token — and `token_status` /
 * `doctor` would then report that other token's expiry as this one's. The
 * composition root drops these keys, so the expiry reads as unknown instead.
 * A token hand-edited inside the same file as its record is not detectable
 * here; the record's token fingerprint catches that case when the profile is
 * built ({@link tokenFingerprint}). This check still matters for a record that
 * carries no fingerprint.
 */
export function strayExpiryKeys(env: Env, sourceOf: (key: string) => string): string[] {
  const tokenKeys = new Map<string, string>();
  const expiryKeys: Array<{ key: string; name: string }> = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const owned = ownedKeyOf(key);
    if (owned?.spelling === 'ACCESS_TOKEN') tokenKeys.set(owned.name, key);
    else if (owned?.spelling === TOKEN_EXPIRES_AT_SUFFIX)
      expiryKeys.push({ key, name: owned.name });
  }
  return expiryKeys
    .filter(({ key, name }) => {
      const tokenKey = tokenKeys.get(name);
      return tokenKey !== undefined && sourceOf(tokenKey) !== sourceOf(key);
    })
    .map(({ key }) => key);
}

/** Validate and materialize one profile from its raw fields. */
function buildProfile(name: string, raw: RawProfile, expiresAtRaw?: string): ResolvedProfile {
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

  const expiry = parseExpiresAt(expiresAtRaw, accessToken);
  // Only set when known, so a profile without a record has no such key at all;
  // the unverified flag likewise appears only on a bare record (CC-AUTH-70).
  return {
    name,
    authPath,
    accessToken,
    accountId,
    appId,
    appSecret,
    ...(expiry !== undefined && { tokenExpiresAtSec: expiry.sec }),
    ...(expiry?.unverified === true && { tokenExpiryUnverified: true as const }),
  };
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

  const profiles: ResolvedProfile[] = [
    buildProfile(DEFAULT_PROFILE_NAME, defaultRaw, env[`IG_${TOKEN_EXPIRES_AT_SUFFIX}`]),
  ];
  const expiries = readNamedExpiries(env);
  for (const [name, raw] of readNamedRaw(env)) {
    profiles.push(buildProfile(name, raw, expiries.get(name)));
  }

  const active = clean(env[ACTIVE_PROFILE_ENV])?.toLowerCase();
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
