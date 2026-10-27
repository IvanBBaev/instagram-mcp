/**
 * Credential persistence (Layer 0). Writes/updates the resolved credentials for
 * one account profile into the runtime env file, using the exact key scheme
 * `core/config.ts` reads back (so a write always round-trips through
 * {@link import('./config.js').loadProfiles}).
 *
 * Storage rules (docs/security.md §2, docs/architecture.md §6):
 *  - Target: `<XDG_CONFIG_HOME | ~/.config>/instagram-mcp-ai/.env` on POSIX;
 *    `%APPDATA%\instagram-mcp-ai\.env` on Windows — unless `IG_ENV_FILE` names
 *    an absolute file (a leading `~` is the home directory), which is then the
 *    one written, since it is the only file the server reads while it is set.
 *  - A store that is a symlink is written THROUGH it: the temp sibling, the lock
 *    and the rename sit beside the link's target, so the link survives.
 *  - Atomic, comment-preserving rewrite: existing comments and unrelated keys are
 *    kept; only the profile's credential keys are inserted/updated (and a stale
 *    recorded expiry removed when the new token has none); the file is
 *    written to a temp sibling and `rename`d into place.
 *  - `chmod 0600` on POSIX after writing; SKIP on Windows (NTFS ACLs apply —
 *    CC-CFG-8).
 *  - Never logs, prints, or otherwise surfaces token/secret values — this module
 *    only writes to the target file.
 *
 * `opts.configDir` / `opts.env` are injection points so tests write to a temp
 * directory without touching the real config home.
 *
 * This module owns the store's location and the profile key scheme, and
 * {@link writeCredentials} sequences the write. The mechanics live beside it
 * (split out unchanged on 2026-10-27): the env-file format in `core/env-file.ts`,
 * symlink resolution in `core/store-link.ts`, the atomic read / replace in
 * `core/atomic-write.ts` and the writer lock in `core/config-lock.ts`.
 */
import path from 'node:path';

import { prepareStoreDir, readExisting, replaceFile } from './atomic-write.js';
import { LOCK_TIMEOUT_MS, withStoreLock } from './config-lock.js';
import {
  DEFAULT_PROFILE_NAME,
  TOKEN_EXPIRES_AT_SUFFIX,
  envVarFor,
  formatExpiryRecord,
} from './config.js';
import { assertReadsBack, formatValue, mergeEnv } from './env-file.js';
import { assertNotShellSpelling, expandHomeTilde, homeDirectory, quote } from './home-path.js';
import { followStoreLink } from './store-link.js';
import { isRecordableExpiry } from './time.js';
import { InstagramError } from './types.js';
import type { AuthPath } from './types.js';

/** Directory name under the config home — mirrors `index.ts`'s `SERVER_NAME`. */
const SERVER_DIR = 'instagram-mcp-ai';
/** The env file written under {@link SERVER_DIR}. */
const ENV_FILE_NAME = '.env';

/** The credential fields a `login`/`refresh` flow resolves for one profile. */
export interface Credentials {
  /** Long-lived access token (secret). Required. */
  accessToken: string;
  /** Resolved auth path — written explicitly so the read-back is unambiguous. */
  authPath: AuthPath;
  /** IG professional-account id, when known (skips a later lookup). */
  accountId?: string;
  /** Meta app id (Path B / token exchange). */
  appId?: string;
  /** Meta app secret (secret). */
  appSecret?: string;
  /**
   * Token expiry as Unix seconds from the exchange (`0` means "never expires").
   * Persisted as token metadata per docs/auth.md §3 and read back by
   * `core/config.ts` into the profile's `tokenExpiresAtSec` (the only expiry
   * Path A has). When absent — or not a value that reader accepts, see
   * `isRecordableExpiry` in `core/time.ts` — any expiry previously recorded for
   * the profile is REMOVED: it described the token being replaced.
   */
  expiresAtSec?: number;
}

/** Injection points for {@link writeCredentials}. */
export interface WriteCredentialsOptions {
  /**
   * Override the config-home base (the `<XDG_CONFIG_HOME | ~/.config>` /
   * `%APPDATA%` segment). The file is written at
   * `<configDir>/instagram-mcp-ai/.env`. Used by tests to target a temp dir.
   * A relative value is resolved against the platform config home (the one
   * `env` selects), never against the working directory (CC-CFG-11): `profiles`
   * writes `<config home>/profiles/instagram-mcp-ai/.env`.
   */
  configDir?: string;
  /**
   * Env map for resolving the target (defaults to `process.env`): a non-blank
   * `IG_ENV_FILE` that is absolute once a leading `~` is expanded names the file
   * itself, else the config home is
   * resolved from `XDG_CONFIG_HOME` / `APPDATA`. Ignored for the target when
   * `configDir` is given.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * How long to wait for another writer's lock on the store before giving up
   * (default 10 s). Exposed so a test can hold the lock without a long wait.
   */
  lockTimeoutMs?: number;
}

/** Result of a successful {@link writeCredentials} call. */
export interface WriteCredentialsResult {
  /** Absolute path of the env file that was written. */
  path: string;
  /** Env keys created or updated — names only, never values. */
  keys: string[];
}

/** Trimmed value, or `undefined` when unset / blank. */
function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The home directory's `~` / `~/…` is spelled out ({@link expandHomeTilde}) and
 * a spelling only a shell can resolve is refused ({@link assertNotShellSpelling})
 * by the rule `core/home-path.ts` shares with the write-journal resolver.
 *
 * Corner case (CC-CFG-60): a shell expands `~` in `XDG_CONFIG_HOME=~/cfg`
 * before `login` ever sees it, but an MCP client's JSON `env` block passes the
 * text verbatim. The server then saw a RELATIVE `~/cfg`, ignored it (CC-CFG-24)
 * and read `~/.config/instagram-mcp-ai/.env`, while the `login` the operator ran
 * in a terminal had written `$HOME/cfg/instagram-mcp-ai/.env` — the fresh token
 * sat where the server never looked, and the account read as unconfigured.
 * Expanding it makes both processes land on `$HOME/cfg` whichever of them
 * received the unexpanded form. The same text as an explicit `configDir` used to
 * be `path.resolve`d into a directory literally named `~` under the cwd.
 *
 * Corner case (CC-CFG-61): `~user`, `$HOME/…` or `%VAR%…` is refused rather
 * than ignored as a plain relative value is. Ignoring it would be silent in
 * exactly the case where a shell elsewhere DID expand it — `login` from a
 * terminal writes to `$HOME/cfg` while the server, handed the literal
 * `$HOME/cfg`, reads the default home — so it stops both with the variable named.
 */
const STORE_PURPOSE = 'to find the credential store';

/**
 * A config-home value the environment supplied, or `undefined` when it cannot be
 * used as one. The XDG base-directory spec requires these variables to hold
 * ABSOLUTE paths and says an implementation encountering a relative one "should
 * consider the path invalid and ignore it"; `%APPDATA%` is absolute by
 * construction, so the same rule costs nothing on Windows.
 *
 * Honoring a relative value would resolve it against the process cwd, which for
 * an MCP server is whatever directory the client happened to spawn it from: an
 * `XDG_CONFIG_HOME=.` inherited from a shell profile would drop a 0600
 * credentials file into the user's current project instead of their config home,
 * and the next start from another directory would read a different file and
 * report the account as unconfigured (CC-CFG-24).
 *
 * Two spellings are not "relative" in that sense and are settled first: the
 * home directory's `~` is expanded (CC-CFG-60), and any other shell-only
 * spelling is refused (CC-CFG-61).
 *
 * @throws {InstagramError} `kind: 'validation'` for a shell-only spelling.
 */
function absoluteHome(
  value: string | undefined,
  variable: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (value === undefined) return undefined;
  const expanded = expandHomeTilde(value, platform);
  if (path.isAbsolute(expanded)) return expanded;
  assertNotShellSpelling(expanded, variable, STORE_PURPOSE);
  return undefined;
}

/**
 * Resolve the config-home base directory for the running platform:
 * `%APPDATA%` (default `<home>\AppData\Roaming`) on Windows, `$XDG_CONFIG_HOME`
 * (default `~/.config`) everywhere else — docs/architecture.md §6, CC-CFG-8.
 *
 * Exported so every consumer resolves the SAME directory: the entry point reads
 * the env file from here (`src/index.ts`) and this module writes it, so a
 * consumer that hard-coded the XDG rule would, on Windows, read from a different
 * place than `login`/`refresh` write to.
 *
 * @throws {InstagramError} `kind: 'validation'` when the variable holds a spelling
 *   only a shell can expand (CC-CFG-61).
 */
export function resolveConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = absoluteHome(clean(env.APPDATA), 'APPDATA', platform);
    return appData ?? path.join(homeDirectory(platform), 'AppData', 'Roaming');
  }
  const xdg = absoluteHome(clean(env.XDG_CONFIG_HOME), 'XDG_CONFIG_HOME', platform);
  // CC-CFG-69: the fallback is only as absolute as the home directory under it.
  return xdg ?? path.join(homeDirectory(platform), '.config');
}

/**
 * Config-home base for one write: the explicit override, else the platform's.
 *
 * An explicit `configDir` is a caller's own choice, so a relative one is obeyed
 * rather than ignored — but it is resolved against the platform config home
 * ({@link resolveConfigHome}), never against the cwd, so that every path this
 * module returns is absolute no matter which branch produced it. A `~` / `~/…`
 * is the home directory, not a folder named `~` in the cwd (CC-CFG-60), and a
 * spelling only a shell can expand is refused (CC-CFG-61).
 *
 * Corner case (CC-CFG-11): a relative `configDir` used to be resolved against
 * the process cwd, so a caller deposited a 0600 credential file under whatever
 * directory it happened to run in — the same leak CC-CFG-24 closed for a
 * relative `XDG_CONFIG_HOME`. Rejecting it would break a caller who means a
 * sub-directory; resolving it against the config home keeps the store under the
 * directory every other store path lives in, and the rule is stated on
 * {@link WriteCredentialsOptions.configDir} so the retarget is announced.
 */
function configHome(opts: WriteCredentialsOptions): string {
  const explicit = clean(opts.configDir);
  const env = opts.env ?? process.env;
  if (explicit !== undefined) {
    const expanded = expandHomeTilde(explicit, process.platform);
    assertNotShellSpelling(expanded, 'configDir', STORE_PURPOSE);
    // The config home is consulted only for a relative value: an absolute one
    // stands on its own, even beside a config-home variable that would be refused.
    // No normalization here: `resolveStoreTarget` path.joins the result.
    if (path.isAbsolute(expanded)) return expanded;
    return path.resolve(resolveConfigHome(env), expanded);
  }
  return resolveConfigHome(env);
}

/**
 * The env file a set, trimmed, non-blank `IG_ENV_FILE` names, or `undefined`
 * when it is unset or blank. The ONE reading of the variable: the entry loads
 * this file (`src/index.ts`) and {@link resolveStoreTarget} writes it, so the two
 * cannot disagree about which file it is.
 *
 * Corner case (CC-CFG-66): an MCP client's JSON `env` hands `~/x.env` over
 * unexpanded. The entry passed it to dotenv, which expands a leading `~` itself,
 * so the server READ the file — and then `login` / `refresh` refused the same
 * value as relative, leaving the one store variable that replaces the candidate
 * list unable to take the spelling `XDG_CONFIG_HOME` already accepts.
 * dotenv's expansion is also blind to what follows the `~`: `~root/x.env` was
 * read as `<home>/root/x.env`. The home directory's own `~` is now expanded
 * here, and any other spelling only a shell can resolve — `~user`, `$HOME/…`,
 * `%APPDATA%…` — is refused with the variable named (CC-CFG-67), before it
 * reaches dotenv.
 *
 * Corner case (CC-CFG-70): a RELATIVE value is refused here too. It used to be
 * returned as it was, so the entry read it against the cwd its MCP client chose
 * while the writer refused it: the server could run for weeks on a file that no
 * `refresh` would ever update. Refusing it at this one reading makes both sides
 * agree, and the entry now stops at start-up — the safer of the two behaviours,
 * and the one `.env.example` has always documented ("must be an absolute path").
 * Resolving it against the cwd instead was rejected: the cwd of an MCP server
 * is unknowable from the shell that runs `login` (CC-CFG-24).
 *
 * @throws {InstagramError} `kind: 'validation'` for a shell-only spelling or a
 *   relative file name.
 */
export function namedEnvFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = clean(env.IG_ENV_FILE);
  if (named === undefined) return undefined;
  const expanded = expandHomeTilde(named, process.platform);
  assertNotShellSpelling(expanded, 'IG_ENV_FILE', STORE_PURPOSE);
  if (!path.isAbsolute(expanded)) {
    throw new InstagramError(
      `IG_ENV_FILE is set to ${quote(expanded)}, which is not an absolute file name. ` +
        'A relative name is resolved against the working directory of whichever process ' +
        'reads it — for the server, the directory its MCP client starts it in — so the ' +
        'server and login / refresh could each use a different file; set IG_ENV_FILE to an ' +
        'absolute file name (a leading "~" is the home directory) and try again.',
      { kind: 'validation' },
    );
  }
  return expanded;
}

/** Where one write goes, and whether the directory holding it is ours to manage. */
interface StoreTarget {
  /** Absolute path of the env file. */
  filePath: string;
  /**
   * `true` for the config-home store, whose directory this module creates at
   * 0700; `false` for a file the operator named through `IG_ENV_FILE`, whose
   * directory is theirs — it is neither created nor re-permissioned.
   */
  ownDir: boolean;
}

/**
 * The env file one write targets.
 *
 * An explicit `configDir` wins (it is how tests and callers pin the store).
 * Otherwise a non-blank `IG_ENV_FILE` names the target, because it is the ONLY
 * file the server loads when it is set (`src/index.ts`): writing the config-home
 * store instead leaves the operator with a fresh token in a file nothing reads
 * while the server keeps serving the old one, and the stored expiry the
 * warnings rely on goes stale with it (CC-CFG-63).
 *
 * The value is absolute by the time it gets here: {@link namedEnvFile} refuses a
 * relative one for the entry and this writer alike (CC-CFG-70), and expands a
 * leading `~` for both.
 *
 * @throws {InstagramError} `kind: 'validation'` (from {@link namedEnvFile}) for a
 *   relative `IG_ENV_FILE`, or one only a shell can expand.
 */
function resolveStoreTarget(opts: WriteCredentialsOptions): StoreTarget {
  if (clean(opts.configDir) === undefined) {
    const named = namedEnvFile(opts.env ?? process.env);
    if (named !== undefined) {
      // As given, never `path.normalize`d: the entry opens this exact string, and
      // normalizing cancels a `..` as text, which after a directory link names a
      // different file than the kernel opens (CC-CFG-76).
      return { filePath: named, ownDir: false };
    }
  }
  return { filePath: path.join(configHome(opts), SERVER_DIR, ENV_FILE_NAME), ownDir: true };
}

/**
 * Build the ordered set of `KEY -> value` assignments for a profile — the values
 * as they must read back, before {@link formatValue} quotes them for the file.
 *
 * The key scheme comes from `config.ts`'s {@link envVarFor} rather than from a
 * local copy of the rule. `envVarFor` is the single place that NAMES a profile's
 * variables: `config.ts` and `auth.ts` use it to tell the operator which var to
 * set when a credential is missing or malformed. A writer with its own copy can
 * drift from it — a changed prefix, a dropped `toUpperCase` — and the symptom is
 * silent: `login` writes one key while every diagnostic instructs the operator to
 * set another, and the operator "fixes" a variable nothing reads.
 */
function buildUpdates(profileName: string, creds: Credentials): Map<string, string> {
  const updates = new Map<string, string>();
  const set = (suffix: string, value: string | undefined): void => {
    const v = clean(value);
    // Equivalent-mutant note: `v !== undefined` and a bare truthiness test are
    // interchangeable here — `clean` maps a blank value to `undefined`, so the
    // only string that ever reaches this guard is non-empty, hence truthy.
    if (v !== undefined) updates.set(envVarFor(profileName, suffix), v);
  };
  set('ACCESS_TOKEN', creds.accessToken);
  set('AUTH_PATH', creds.authPath);
  set('ACCOUNT_ID', creds.accountId);
  set('APP_ID', creds.appId);
  set('APP_SECRET', creds.appSecret);
  // Only a value the reader accepts is written (CC-AUTH-65). Anything else —
  // a negative, a fraction, a millisecond epoch from a direct caller — is
  // treated like no lifetime, so the previous record is removed below rather
  // than left describing the new token, or replaced by one that reads as unknown.
  if (creds.expiresAtSec !== undefined && isRecordableExpiry(creds.expiresAtSec)) {
    // Metadata key — config.ts reads it back as `tokenExpiresAtSec` for
    // token_status / doctor, but never as a credential field. The suffix is
    // config.ts's constant so its recognised-name audit (`isProfileEnvName`)
    // vouches for exactly the key written here.
    // It goes through `formatValue` like every other value, which is a no-op: a
    // recordable expiry is a whole number of at most twelve digits, so `String`
    // renders it as plain digits and it is emitted unquoted.
    // The record carries the token's fingerprint (CC-AUTH-59), so a token later
    // replaced by hand does not inherit it. The fingerprint is hex and `:` is in
    // the bare-value class, so the value is emitted unquoted all the same.
    updates.set(
      envVarFor(profileName, TOKEN_EXPIRES_AT_SUFFIX),
      formatExpiryRecord(creds.expiresAtSec, creds.accessToken),
    );
  }
  return updates;
}

/**
 * Refuse a profile name whose keys would not read back as that same profile.
 *
 * `envVarFor` upper-cases the name into `IG_PROFILE_<NAME>_*` and `config.ts`
 * lower-cases it again on the way in, through dotenv, whose key class is
 * `[\w.-]`. A name outside that class breaks the round trip this module promises:
 * `my brand` produces a key dotenv never reads, so the token is written and the
 * profile does not exist; `straße` upper-cases to `STRASSE` and comes back as a
 * different profile, `strasse`. Letters, digits, `_`, `.` and `-` survive both
 * case folds unchanged, so they are the whole accepted set. The name is echoed —
 * it is an identifier the operator typed, never a credential.
 */
function assertStorableProfileName(name: string): void {
  if (!/^[a-z0-9_.-]+$/.test(name)) {
    throw new InstagramError(
      `Profile name ${JSON.stringify(name)} cannot be stored: use only letters, digits, ` +
        '"_", "." and "-"',
      { kind: 'validation' },
    );
  }
}

/**
 * Write/update the resolved credentials for `profileName` into the env file.
 *
 * @param profileName Profile to write — `'default'` uses the bare `IG_*` keys;
 *   any other name uses the `IG_PROFILE_<NAME>_*` keys (case-insensitive).
 * @returns The file path written and the env keys that were created/updated.
 * @throws {InstagramError} `kind: 'validation'` when `accessToken` is blank, when
 *   the profile name is not one the env scheme can read back, when another writer
 *   holds the store's lock past `lockTimeoutMs`, when a value holds a `'` or a
 *   CR/LF together with one of `$`, `` ` ``, `"`, `\` (CC-CFG-59), when the
 *   merged store would not read back every key as intended (CC-CFG-53), and
 *   — with the raw `node:fs` error as `cause` — when the store cannot be read
 *   (other than not existing yet) or written (CC-CFG-12).
 */
export async function writeCredentials(
  profileName: string,
  creds: Credentials,
  opts: WriteCredentialsOptions = {},
): Promise<WriteCredentialsResult> {
  if (clean(creds.accessToken) === undefined) {
    throw new InstagramError('writeCredentials: an access token is required.', {
      kind: 'validation',
    });
  }
  const name = (clean(profileName) ?? DEFAULT_PROFILE_NAME).toLowerCase();
  assertStorableProfileName(name);
  const target = resolveStoreTarget(opts);
  // Everything from here on works on the file the name resolves to, so a
  // symlinked store keeps its link (CC-CFG-68); only the directory holding the
  // NAME is prepared below, because that is the one this module owns.
  const filePath = await followStoreLink(target.filePath);
  // Fail fast on a store that cannot be read, before the directory is touched.
  // The authoritative read is the one repeated under the lock below.
  await readExisting(filePath);
  const values = buildUpdates(name, creds);
  const updates = new Map<string, string>();
  const unquotable: string[] = [];
  for (const [key, value] of values) {
    const formatted = formatValue(value);
    if (formatted === undefined) unquotable.push(key);
    else updates.set(key, formatted);
  }
  if (unquotable.length > 0) {
    // Refused before the directory or the lock is touched (CC-CFG-59). Only the
    // keys are named: the values are secrets.
    throw new InstagramError(
      `Cannot write the credential store at ${filePath}: ${unquotable.join(', ')} holds a ` +
        'single quote or a line break together with one of $ ` " \\, which no env-file ' +
        'quoting keeps literal for both dotenv and a shell that sources the file, so ' +
        'nothing was written',
      { kind: 'validation' },
    );
  }
  // A token written without a lifetime must not inherit the previous token's
  // recorded expiry: `token_status`/`doctor` read that line back, and a stale one
  // reports the NEW token as expiring (or expired) on the OLD token's schedule.
  const expiryKey = envVarFor(name, TOKEN_EXPIRES_AT_SUFFIX);
  const removals = new Set(updates.has(expiryKey) ? [] : [expiryKey]);
  // The operator's own directory (`IG_ENV_FILE`) is left exactly as it is: a
  // missing one fails the write below instead of being invented at 0700.
  if (target.ownDir) await prepareStoreDir(target.filePath);
  await withStoreLock(filePath, opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS, async () => {
    // CC-CFG-72: the name was resolved BEFORE the lock, so a link re-pointed
    // while this write waited would send the token to the file the link used to
    // name — under a lock on that file, while every reader now opens another. It
    // is resolved again here, where no other writer of that file can run, and a
    // change stops the write instead of guessing which file was meant.
    const now = await followStoreLink(target.filePath);
    if (now !== filePath) {
      throw new InstagramError(
        `Cannot write the credential store at ${target.filePath}: it named ${filePath} when ` +
          `this write began and names ${now} now that the write holds the lock, so nothing ` +
          'was written; run the command again',
        { kind: 'validation' },
      );
    }
    const existing = await readExisting(filePath);
    const merged = mergeEnv(existing, updates, removals);
    assertReadsBack(filePath, existing, merged, values, removals);
    await replaceFile(filePath, merged);
  });
  return { path: filePath, keys: [...updates.keys()] };
}
