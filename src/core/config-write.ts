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
 */
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parse as parseEnv } from 'dotenv';

import {
  DEFAULT_PROFILE_NAME,
  TOKEN_EXPIRES_AT_SUFFIX,
  envVarFor,
  formatExpiryRecord,
} from './config.js';
import { assertNotShellSpelling, expandHomeTilde, homeDirectory } from './home-path.js';
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
 * rather than ignored — but it is resolved against the cwd here, so that every
 * path this module returns is absolute no matter which branch produced it. The
 * returned path is what {@link writeCredentials} reports to the operator, and a
 * `./instagram-mcp-ai/.env` in a CLI's output names a different file once the
 * operator has changed directory to look at it. A `~` / `~/…` is the home
 * directory, not a folder named `~` in the cwd (CC-CFG-60), and a spelling
 * only a shell can expand is refused (CC-CFG-61).
 */
function configHome(opts: WriteCredentialsOptions): string {
  const explicit = clean(opts.configDir);
  if (explicit !== undefined) {
    const expanded = expandHomeTilde(explicit, process.platform);
    assertNotShellSpelling(expanded, 'configDir', STORE_PURPOSE);
    return path.resolve(expanded);
  }
  return resolveConfigHome(opts.env ?? process.env);
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
      `IG_ENV_FILE is set to ${JSON.stringify(expanded)}, which is not an absolute file name. ` +
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
 * Format a value for the env file so `dotenv` parses it back verbatim AND a POSIX
 * shell that `source`s the file assigns it without running any of it. Simple
 * token/secret shapes are emitted bare. Otherwise SINGLE quotes are preferred:
 * both readers treat a single-quoted value as a literal (no escape processing,
 * no expansion), so spaces, `=`, `#`, `$`, backticks, backslashes and embedded
 * double quotes round-trip exactly. A value holding a single quote or a CR/LF —
 * which must be escaped to stay on one physical line — goes in DOUBLE quotes,
 * where `dotenv` reverses `\n` / `\r` but un-escapes nothing else. That form is
 * emitted only when the value holds none of `$`, `` ` ``, `"` and `\`, the four
 * characters a shell still acts on inside double quotes; for any other value
 * this returns `undefined` and {@link writeCredentials} refuses the write.
 *
 * Corner case (CC-CFG-59): the store is sourceable (`mergeEnv` keeps `export`
 * for exactly that reason, CC-PROC-176), and the fallbacks this replaced were
 * not. A value holding a `'` went in backticks — command substitution to a
 * shell — so `x'; touch f` ran `touch f` on `source`; one holding both `'` and a
 * backtick went in double quotes, where the backticks ran just the same. No
 * spelling is literal to both readers once `'` meets one of those four: dotenv
 * has no escape for a quote inside its quoted forms, and `'\''` is not dotenv
 * syntax. Refusing is safe in practice — the values written here are Meta ids,
 * tokens and app secrets, none of which contain these characters — and it is
 * loud, before anything is written. A CR/LF value still reads back through a
 * shell as the two characters `\` + `n`: a different value, never a command.
 *
 * Corner case (CC-CFG-53): the double-quoted form used to be the ONLY fallback
 * for a single quote, and it cannot carry everything. dotenv does not un-escape
 * `\"`, so a value with `'`, `"` and `#` (`it's "a" #1`) closed at its inner `"`
 * and read back as `it's "a`; and a literal `\` + `n` beside a `'` came back as a
 * real newline. Both are now refused here; {@link assertReadsBack} still catches
 * a value that runs into a hand-edited line of the file.
 *
 * Equivalent-mutant note: two mutations of this function survive the whole suite
 * and neither is observable. Tightening the bare-value class to `+` differs only
 * on the empty string, and the sole caller is `buildUpdates`'s `set`, which runs
 * `clean()` first — that maps a blank value to `undefined`, so `formatValue('')`
 * is unreachable. Swapping the two escape passes is unobservable for EVERY input:
 * a CR is replaced by the two characters `\` + `r` and an LF by `\` + `n`, and
 * neither replacement contains a CR or an LF, so neither pass can create or
 * destroy a match for the other. A CRLF pair renders as `\r\n` in both orders.
 */
function formatValue(value: string): string | undefined {
  if (/^[A-Za-z0-9_@%+./:=~-]*$/.test(value)) return value;
  if (!/['\r\n]/.test(value)) return `'${value}'`;
  if (/[$`"\\]/.test(value)) return undefined;
  const escaped = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * The assignment on an env-file line — the `export`/indentation prefix and the
 * key (`KEY=...`, optional `export`) — else undefined.
 *
 * The prefix is returned rather than discarded because {@link mergeEnv} replaces
 * the VALUE on a line, not the line. Recognising a leading `export ` and then
 * dropping it on the way back out silently downgrades an exported variable to a
 * local one: `source`ing the repaired file sets nothing in any child process,
 * while `cat` shows a perfectly fresh token (CC-PROC-176).
 *
 * Equivalent-mutant note: admitting a digit as the first character
 * (`[A-Za-z0-9_]`) and demanding a second character (`*` -> `+`) both survive the
 * suite, and neither can be told apart from this pattern. The only use of the
 * returned key is a lookup in `mergeEnv`'s `updates` map, and every key in that
 * map comes from `envVarFor`: `IG_<SUFFIX>` or `IG_PROFILE_<NAME>_<SUFFIX>`,
 * always letter-leading and never shorter than three characters. A line the
 * mutated pattern classifies differently therefore always misses the map, and
 * `mergeEnv` returns it verbatim on both paths.
 */
function assignmentOn(line: string): { prefix: string; key: string } | undefined {
  // The key class is dotenv's own (`[\w.-]`), not the POSIX identifier class. A
  // profile name may carry `-` or `.` (CC-AUTH-18: `Second-Studio`), and dotenv
  // reads the `IG_PROFILE_<NAME>_ACCESS_TOKEN` key it produces, hyphen and all,
  // from the file. With the narrower class that line was never recognised, so
  // every `login`/`refresh` appended a fresh assignment below it and left the
  // superseded token on disk in plaintext.
  const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line);
  const prefix = match?.[1];
  const key = match?.[2];
  // Both groups are non-optional in the pattern above, so a match always fills
  // both, and only a non-match reaches the refusal below — the `key` half of the
  // test is evaluated on every matching line and can never be true. It is still
  // written out rather than assumed, for two measured reasons. Deleting it does
  // not compile: `key` stays `string | undefined` and the return type refuses it.
  // And writing it instead as a `?? ''` default would leave a range no input can
  // execute, which drops branch coverage below the gate — the two defaults this
  // replaced cost exactly that, and the honest fix is a guard the suite reaches,
  // not an exclusion.
  if (prefix === undefined || key === undefined) return undefined;
  return { prefix, key };
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
 * Merge `updates` into the existing env-file text: replace the VALUE of EVERY
 * assignment of a key already present, keeping the rest of that line — its
 * indentation and any leading `export ` — and preserving every comment, blank
 * line, and unrelated key; append the keys that were not present at the end;
 * drop every assignment of a key in `removals`. A fresh file gets a short header.
 *
 * One byte-level normalisation is deliberate: {@link assignmentOn} accepts
 * `KEY = value`, and the rewrite emits `KEY=value`. A POSIX shell reads the spaced
 * form as a command invocation, so collapsing it is what makes a file this module
 * has touched a file `source` can still read.
 */
function mergeEnv(
  existing: string,
  updates: Map<string, string>,
  removals: ReadonlySet<string>,
): string {
  const seen = new Set<string>();
  const hadContent = existing.length > 0;
  const lines = hadContent ? existing.split(/\r?\n/) : [];
  // Equivalent-mutant note: dropping the length guard is unobservable. On an
  // empty `lines` the index is `-1`, which reads back as `undefined` and is not
  // `''`, so nothing is popped on that path either.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const kept = lines.filter((line) => {
    const assignment = assignmentOn(line);
    return assignment === undefined || !removals.has(assignment.key);
  });
  const out = kept.map((line) => {
    const assignment = assignmentOn(line);
    if (assignment === undefined) return line;
    const { prefix, key } = assignment;
    const value = updates.get(key);
    // Equivalent-mutant note: `=== undefined` and `!value` are interchangeable.
    // Every value in the map is `formatValue` of a non-blank string, and the only
    // input for which `formatValue` returns `''` is `''` itself, which `clean` has
    // already turned into `undefined` before the map is built. The entry that
    // comes closest to falsy is the expiry record for `expiresAtSec: 0` (“never
    // expires”), and that renders as `0:<fingerprint>`, a truthy string. So no
    // entry can hold a falsy value, and no line is treated differently.
    if (value === undefined) return line;
    // Corner case: the SAME key assigned more than once. Rewriting only the first
    // occurrence — the natural spelling, where the update is consumed as it is
    // applied — leaves the later assignment holding the old value, and dotenv's
    // last-one-wins rule then hands the reader exactly that: a revoked token both
    // stays on disk in plaintext and beats the fresh one written above it. A
    // duplicate is ordinary in a hand-edited file (an operator appends a line
    // rather than editing the one already there). Rewriting every occurrence also
    // makes the merge idempotent on a file it has already repaired.
    seen.add(key);
    // `prefix` carries the line's indentation and its `export ` keyword back out.
    // Dropping it would rewrite a sourced env store into a set of local variables
    // on every login and every refresh — see the note on {@link assignmentOn}.
    return `${prefix}${key}=${value}`;
  });

  if (!hadContent) {
    out.push('# instagram-mcp-ai credentials — written by the `login` CLI.');
    out.push('# Keep private (chmod 0600); never commit this file.');
  }
  // Appended AFTER the existing content, so that if an assignment of the same key
  // survives above in a shape `assignmentOn` does not recognise, the value written here
  // is still the one a last-one-wins reader resolves.
  for (const [key, value] of updates) if (!seen.has(key)) out.push(`${key}=${value}`);

  return `${out.join('\n')}\n`;
}

/**
 * Refuse a merged store that would not read back as intended (CC-CFG-53).
 *
 * The check runs the merged text through dotenv's own parser — the reader the
 * server uses — rather than trusting {@link formatValue} line by line, because
 * a quoted value is not always confined to its line: dotenv's quoted forms skip a
 * backslash-escaped quote, so a value ending in `\` can run on into a later line
 * that holds the same quote and swallow it. Every key this write sets must read
 * back as its value, every key it removes must be gone, and every OTHER key must
 * read back exactly as it did before the merge, so a write for one profile can
 * never silently rewrite another's. Only key names reach the message, never a
 * value, and nothing is written.
 */
function assertReadsBack(
  filePath: string,
  existing: string,
  merged: string,
  values: ReadonlyMap<string, string>,
  removals: ReadonlySet<string>,
): void {
  // Maps, not the parsed records, so a key can never resolve to an
  // `Object.prototype` member.
  const before = new Map(Object.entries(parseEnv(existing)));
  const after = new Map(Object.entries(parseEnv(merged)));
  // `values.keys()` is belt-and-braces: a set key missing from `after` was
  // swallowed by some other value, and that value is itself in `before` or `after`
  // and reads back wrong, so dropping the spread survives every test.
  const keys = new Set([...before.keys(), ...after.keys(), ...values.keys()]);
  const wrong = [...keys].filter((key) => {
    const want = values.has(key)
      ? values.get(key)
      : removals.has(key)
        ? undefined
        : before.get(key);
    return after.get(key) !== want;
  });
  if (wrong.length > 0) {
    throw new InstagramError(
      `Cannot write the credential store at ${filePath}: ${wrong.join(', ')} would not read ` +
        'back as written, so nothing was written; a value holds characters the env-file ' +
        'format cannot carry, or a hand-edited line in the file runs into it',
      { kind: 'validation' },
    );
  }
}

/**
 * The remedy each side of the store names when `node:fs` refuses it. A lookup
 * rather than a conditional so that {@link storeFailure} has no branch of its
 * own: the two verbs are reached by different tests, and each message is pinned
 * whole.
 */
const STORE_REMEDY = {
  read: 'check the permissions on the file and its directory',
  write: 'check free space and the permissions on its directory',
} as const;

/**
 * Wrap a `node:fs` failure from the credential store in the one error shape the
 * rest of the server speaks (CC-CFG-12, the "error surface" half).
 *
 * Before this, a failing `mkdir`/`chmod`/`writeFile`/`rename` — and any read
 * failure other than "not there yet" — escaped {@link writeCredentials} as the
 * raw `node:fs` error: an `Error` whose message is `ENOSPC: no space left on
 * device, open '/…/.env.3f9a2c.tmp'`, naming a temp sibling the operator has
 * never heard of and no remedy. Everything that reaches the `login` CLI or the
 * MCP boundary is otherwise an `InstagramError` with a `kind`, so this was the
 * one path on which the operator met Node's wording instead of ours.
 *
 * The message names the file the operator knows about (the store, never the temp
 * sibling), the `code` — the only part of the raw error worth carrying, since
 * `ENOSPC` vs `EACCES` is the diagnosis — and the remedy for that side. The raw
 * error rides along as `cause`, so nothing is lost for a log that wants the
 * syscall and the temp path. `kind: 'validation'` is the kind this repo already
 * gives a local-environment failure with a raw error as `cause` (the OAuth
 * redirect listener in `cli/login.ts`): nothing upstream was involved, it is
 * not retryable (`core/http.ts` retries only `rate_limit`/`upstream`), and it
 * is the operator, not the model, who can act on it.
 *
 * `code` is interpolated as-is: every `node:fs/promises` rejection carries one,
 * and a `?? 'unknown'` fallback would be a branch no test can take.
 */
function storeFailure(
  err: unknown,
  verb: keyof typeof STORE_REMEDY,
  filePath: string,
): InstagramError {
  const { code } = err as NodeJS.ErrnoException;
  return new InstagramError(
    `Cannot ${verb} the credential store at ${filePath} (${code}): ${STORE_REMEDY[verb]}`,
    { kind: 'validation', cause: err },
  );
}

/**
 * Read the current file text, treating a missing file as empty.
 *
 * Only `ENOENT` means "there is no store yet". Any other failure (`EISDIR`,
 * `ENOTDIR`, `EACCES`, `ELOOP`, …) means the file may exist and cannot be seen,
 * and continuing would replace an unread store — so it is wrapped and rethrown,
 * never treated as empty.
 */
async function readExisting(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw storeFailure(err, 'read', filePath);
  }
}

/**
 * The file a write to `filePath` must replace: `filePath` itself, or — when that
 * name is a symlink — the file the link resolves to.
 *
 * Corner case (CC-CFG-68, the symlink half of CC-CFG-12): the rename used to
 * land on the LINK, turning it into a regular file. A store kept in a dotfiles
 * repository and linked into place silently stopped receiving tokens after the
 * first `login`, while every read (dotenv, {@link readExisting}) had always
 * followed the link — so the bytes read and the bytes written were not the same
 * file. Resolving the link first puts the temp sibling, the lock and the rename
 * beside the target: the replacement is still a fresh 0600 inode renamed into
 * place, never an in-place write, and two links to one store now contend for
 * the one lock beside it instead of each taking its own.
 *
 * Every LINK in the chain is judged, and only links are resolved: a symlinked
 * DIRECTORY on the way (macOS's `/var` → `/private/var`) is left out of the
 * reported path. Three refusals keep anyone else from choosing where
 * credentials go:
 *  - a link owned by another user is not followed — the name's own link or any
 *    link after it (CC-CFG-73). Whoever can plant a link at the store's name
 *    would otherwise pick which of our files is rewritten and re-permissioned,
 *    and the owner of a link in the MIDDLE of a chain picks the file just as
 *    surely: `realpath` used to follow every hop after the first one blind. A
 *    chain is walked hop by hop rather than refused outright, because dotfiles
 *    managers (GNU Stow folding, a relinked checkout) do produce chains of the
 *    operator's own links. The config-home directory is 0700, so this bites only
 *    in a directory the operator shares. Where there is no uid (Windows, which
 *    needs a privilege to create a link at all) the check is skipped.
 *  - a DIRECTORY on the way — every component of the store's directory and of
 *    each hop's, a directory link and the directory it leads to alike — owned
 *    by neither this user nor root is refused (CC-CFG-74). Its owner can
 *    rename or re-point what lies beneath it at will, so it chooses the file as
 *    surely as the owner of a store link; the kernel follows it on every open
 *    and used to be the only one that looked. Root is accepted because every
 *    path starts in root's directories (`/`, `/private`, the `/var` link, `/tmp`)
 *    and root can rewrite any file anyway. Store links themselves stay strictly
 *    the operator's own: a root-owned link at the store's name is still refused.
 *    Residual, accepted: a directory owned by this user or by root is not judged
 *    by its mode, so a group-writable one of the operator's own, or sticky `/tmp`
 *    (where others can create but not replace entries), is walked through.
 *  - a dangling link, at any hop, is refused rather than creating a store at
 *    whatever path it happens to name.
 * A chain longer than {@link MAX_LINK_HOPS} is reported as `ELOOP`, the code the
 * kernel gives a link loop. The target's directory is the operator's, like
 * `IG_ENV_FILE`'s: it is neither created nor re-permissioned.
 *
 * Resolved before the lock (to fail fast and to know WHICH lock to take) and
 * again under it (CC-CFG-72): see {@link writeCredentials}. A store directory
 * the write is about to create is judged only by the second pass, once it
 * exists.
 */
async function followStoreLink(filePath: string): Promise<string> {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch {
    // Nothing at the name yet (or nothing that can be seen): the read below
    // tells a missing store from an unreadable one.
    entry = undefined;
  }
  if (entry === undefined || !entry.isSymbolicLink()) {
    await judgeStoreDirectory(filePath);
    return filePath;
  }
  try {
    return await resolveLinkChain(filePath, entry);
  } catch (err) {
    if (err instanceof InstagramError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InstagramError(
        `Cannot write the credential store at ${filePath}: it is a symbolic link whose ` +
          'target does not exist; create the target file, or replace the link with a ' +
          'regular file',
        { kind: 'validation' },
      );
    }
    throw storeFailure(err, 'read', filePath);
  }
}

/**
 * Owner-check every directory on the way to a store that is not a link
 * (CC-CFG-74). Only the refusal is raised: a directory that cannot be walked
 * yet — the config home before its first write creates it — is left to the
 * read, the `mkdir` and the second pass under the lock, which report it better.
 */
async function judgeStoreDirectory(filePath: string): Promise<void> {
  try {
    await realDirectory(path.dirname(filePath), filePath);
  } catch (err) {
    if (err instanceof InstagramError) throw err;
  }
}

/** Links followed before a chain is reported as a loop — Linux's own limit. */
const MAX_LINK_HOPS = 40;

/**
 * The physical path of the absolute directory `dir`, walked one component at a time the way
 * the kernel walks it: a directory link is replaced by its target (relative to
 * the directory holding it) and a `..` is taken from wherever the walk has
 * physically arrived — never cancelled against the name before it. Every
 * component, links and their targets alike, must be owned by this user or by
 * root (CC-CFG-74); where there is no uid (Windows) nothing is judged and
 * `realpath` answers.
 *
 * @throws {InstagramError} for a component owned by another user; the raw fs
 *   error (`ENOENT`, `ENOTDIR`, `ELOOP` past {@link MAX_LINK_HOPS}) otherwise.
 */
async function realDirectory(dir: string, filePath: string): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) return realpath(dir);
  // Split as given: `path.resolve` would cancel a `..` as text. Every store path
  // is absolute by now (`StoreTarget.filePath`).
  const pending = dir.split('/');
  let resolved = '/';
  let hops = 0;
  for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
    // `resolved` is physical, so joining `..` onto it climbs the real tree.
    const component = path.join(resolved, name);
    const entry = await lstat(component);
    if (entry.uid !== uid && entry.uid !== 0) {
      throw new InstagramError(
        `Cannot write the credential store at ${filePath}: the path component ${component} ` +
          'on the way to it is owned by another user, so the store is not written through ' +
          'it; keep the store under directories owned by you or by root',
        { kind: 'validation' },
      );
    }
    if (!entry.isSymbolicLink()) {
      resolved = component;
      continue;
    }
    if (hops === MAX_LINK_HOPS) {
      throw Object.assign(new Error(`too many levels of symbolic links at ${filePath}`), {
        code: 'ELOOP',
      });
    }
    hops += 1;
    const target = await readlink(component);
    pending.unshift(...target.split('/'));
    if (path.isAbsolute(target)) resolved = '/';
  }
  return resolved;
}

/**
 * Walk the link chain that starts at `filePath` (whose `lstat` is `entry`), one
 * hop at a time, refusing a hop owned by another user; the real path of the file
 * it ends at. Each relative target is resolved against the real directory of the
 * link holding it, as the kernel resolves it: a `..` in a target is climbed
 * physically by {@link realDirectory}, never cancelled against the name before
 * it, and every directory on the way is owner-checked there (CC-CFG-74).
 *
 * @throws {InstagramError} for a link or a directory owned by another user; the
 *   raw fs error (`ENOENT` for a dangling hop, `ELOOP` past {@link MAX_LINK_HOPS})
 *   otherwise.
 */
async function resolveLinkChain(
  filePath: string,
  entry: Awaited<ReturnType<typeof lstat>>,
): Promise<string> {
  const uid = process.getuid?.();
  let current = filePath;
  let hops = 0;
  while (entry.isSymbolicLink()) {
    if (hops === MAX_LINK_HOPS) {
      throw Object.assign(new Error(`too many levels of symbolic links at ${filePath}`), {
        code: 'ELOOP',
      });
    }
    hops += 1;
    if (uid !== undefined && entry.uid !== uid) {
      throw new InstagramError(
        current === filePath
          ? `Cannot write the credential store at ${filePath}: it is a symbolic link owned ` +
              'by another user, so it is not followed; replace it with a regular file or a ' +
              'link of your own'
          : `Cannot write the credential store at ${filePath}: the symbolic link ${current} ` +
              'on the way to it is owned by another user, so it is not followed; replace it ' +
              'with a regular file or a link of your own',
        { kind: 'validation' },
      );
    }
    const target = await readlink(current);
    const holder = await realDirectory(path.dirname(current), filePath);
    // Joined, not resolved: `path.resolve` would cancel a `..` against the name
    // before it, which the kernel does not do when that name is a link.
    current = path.isAbsolute(target) ? target : `${holder}/${target}`;
    entry = await lstat(current);
  }
  return path.join(await realDirectory(path.dirname(current), filePath), path.basename(current));
}

/** Create the store directory at 0700, tightening one that already exists. */
async function prepareStoreDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  // One wrapper around each half of the sequence (CC-CFG-12): whichever fs call
  // fails, the operator is told about the store, not about the step. The temp
  // sibling is cleaned up by `replaceFile` (CC-CFG-48) and flushed before its
  // rename (CC-CFG-54); a symlinked store is written through the link
  // (`followStoreLink`, CC-CFG-68).
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Corner case: the directory is already there at a looser mode. `mkdir`
    // applies `mode` only to directories it CREATES, so a store that predates
    // this rule — or one an operator recreated by hand, `chmod -R`'d, or restored
    // from an archive that dropped modes — keeps whatever it had. 0600 on the
    // file does not cover that: write permission on the DIRECTORY is what lets
    // another local account rename our `.env` away and leave its own behind, and
    // the next `login` then writes a fresh token into a file somebody else
    // controls. Unconditional rather than stat-then-chmod — the wanted mode is a
    // constant, so the check would only add a race with the same outcome. If the
    // directory belongs to another user this now fails loudly instead of quietly
    // filling a store we cannot secure.
    if (process.platform !== 'win32') await chmod(dir, 0o700);
  } catch (err) {
    throw storeFailure(err, 'write', filePath);
  }
}

/**
 * Write `content` atomically and durably: temp sibling (created 0600, `fsync`ed)
 * → `chmod 0600` (POSIX) → `rename` → directory `fsync` (POSIX, best-effort).
 * The mode is set on the temp file before the rename so the final file is never
 * momentarily world-readable; on Windows chmod is skipped (CC-CFG-8).
 *
 * Equivalence note, corrected on 2026-09-23: the mode is narrowed three times —
 * the `open` create mode, the chmod on the temp file, and the chmod after
 * the rename — and this note used to bless dropping any ONE of them as
 * unobservable. Measured: only the LAST one is. Dropping the create mode is
 * killed by "no file in the store is group- or world-accessible, not even
 * mid-write", which samples the directory every event-loop turn and catches the
 * temp while it still carries the umask-widened create mode; dropping the chmod
 * on the temp is killed by "the temp file is brought to 0600 whatever the
 * ambient umask". Only the post-rename chmod survives alone — `rename` carries
 * the temp's mode over, so by the time it runs the file is already 0600 — and it
 * stays as the belt to those braces. See the longer note in
 * test/core/config-write.test.ts.
 *
 * Dropping `encoding: 'utf8'` is unobservable for the same reason no test asserts
 * it: `writeFile` already defaults to utf8 for string content. It is written out
 * so the encoding is a property of this call rather than of a Node default.
 */
async function replaceFile(filePath: string, content: string): Promise<void> {
  const posix = process.platform !== 'win32';
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    // `wx`: the random name is ours alone, so an entry already there is refused
    // rather than followed — a planted symlink never receives the credentials.
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(content, { encoding: 'utf8' });
      // Flushed BEFORE the rename (CC-CFG-54). Without it a power loss shortly
      // after the rename can leave the new name pointing at a file whose data
      // never reached the disk — a zero-length `.env` that has lost every
      // profile's credentials, not just the one being written. `login` and
      // `refresh` are rare, so the disk barrier costs nothing that matters.
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (posix) await chmod(tmp, 0o600);
    await rename(tmp, filePath);
    if (posix) await chmod(filePath, 0o600);
    // The rename itself is durable only once the directory entry is flushed.
    if (posix) await syncDir(path.dirname(filePath));
  } catch (err) {
    // The temp sibling holds the full credential set. Left behind by a failed
    // `chmod` or `rename`, it is a second copy of every secret that no later
    // write replaces or cleans up (each write picks a fresh random name). After
    // a successful rename it no longer exists, so `force` makes this a no-op.
    await rm(tmp, { force: true }).catch(() => undefined);
    throw storeFailure(err, 'write', filePath);
  }
}

/**
 * Flush a directory so a rename inside it survives a power loss. POSIX only —
 * Windows cannot open a directory for `fsync` — and best-effort: it runs after
 * the rename has already replaced the store, so a filesystem that refuses a
 * directory `fsync` (`EINVAL` on some network mounts) must not turn a completed
 * write into a reported failure.
 */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Durability of the directory entry is a bonus, not a precondition.
  }
}

/** How long a writer waits for another writer's lock before giving up. */
const LOCK_TIMEOUT_MS = 10_000;
/**
 * A lock older than this is taken to belong to a writer that crashed — but only
 * when its owner cannot be checked directly (see {@link lockIsStale}).
 */
const LOCK_STALE_MS = 30_000;
/** Pause between attempts to take a held lock. */
const LOCK_RETRY_MS = 20;
/**
 * What this process writes into a lock it takes: its pid and host, so a waiter
 * can ask whether the owner is still running instead of guessing from the age,
 * then a nonce that makes each lock's record its own (CC-CFG-62): a writer
 * removes a lock only while the record there is still the one it took, or the
 * one it judged stale — never a lock another writer has taken since.
 */
function newLockRecord(): string {
  return `${process.pid}@${hostname()}@${randomBytes(16).toString('hex')}\n`;
}
/**
 * The locks this process holds right now, each with the record it wrote. A
 * record naming this very process is alive only while it is the one held here:
 * one it failed to release (CC-CFG-56), or one left by a crashed predecessor
 * that ran under the same pid (a container's pid 1 after a restart), would
 * otherwise look held until this process exits.
 */
const heldLocks = new Map<string, string>();

/**
 * The record at `lockPath`, or `''` when there is none to read: gone, a
 * directory or a dangling link at the name. Every judgement and every removal
 * reads through here, so "unreadable" compares equal to itself (CC-CFG-55's
 * directory is still judged, and still fails its removal loudly).
 */
async function readLockRecord(lockPath: string): Promise<string> {
  return readFile(lockPath, 'utf8').catch(() => '');
}

/**
 * Remove the lock at `lockPath` only if it still holds `expected`. POSIX has no
 * compare-and-unlink, so a record that changes between this read and the
 * unlink is still removed — a window of one syscall, where the unconditional
 * `rm` this replaced was open for as long as the lock existed (CC-CFG-62).
 * Errors from the unlink propagate; the caller decides whether they matter.
 */
async function removeLockIf(lockPath: string, expected: string): Promise<void> {
  if ((await readLockRecord(lockPath)) !== expected) return;
  await rm(lockPath, { force: true });
}

/**
 * Give back a lock this process took. It is forgotten first, whatever happens
 * next (CC-CFG-58), and removed best-effort (CC-CFG-56) — and only while it is
 * still ours: a lock cleared under this writer and taken by another is that
 * writer's to release (CC-CFG-62). That includes a lock with no record yet,
 * which is another writer caught between its create and its write; whatever
 * else sits at the name (a directory, a dangling link) is left for the next
 * writer to judge, as a lock whose release failed always was.
 */
async function releaseLock(lockPath: string, record: string): Promise<void> {
  heldLocks.delete(lockPath);
  await removeLockIf(lockPath, record).catch(() => undefined);
}

/**
 * Age of the lock at `lockPath` in milliseconds. A lock that cannot be stat'ed —
 * released between our failed create and this call, or a dangling link that
 * nothing will ever remove — is reported as infinitely old, so the caller
 * clears it and tries again at once.
 */
async function lockAge(lockPath: string): Promise<number> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** A lock record: `pid@host`, optionally followed by `@` and a 128-bit hex nonce. */
const LOCK_RECORD = /^([1-9]\d{0,8})@(.+?)(?:@[0-9a-f]{32})?\n$/;

/**
 * Whether the process named in a lock record is still running, or `undefined`
 * when the record cannot answer that: empty (a lock from a writer that predates
 * the record, or one caught between its create and its write), unreadable (a
 * directory or a dangling link at the name), malformed, or naming another host,
 * whose pids mean nothing here. Pid 0 and negative pids are never parsed: to
 * `kill` they address a process GROUP, not the owner.
 *
 * Signal 0 checks existence without delivering anything. Only `ESRCH` means the
 * owner is gone; `EPERM` is a live process owned by another user, and any other
 * failure is taken as alive too, so a doubt leaves the lock in place.
 *
 * Both record shapes parse: `pid@host` from a build before CC-CFG-62 and
 * `pid@host@nonce` from this one. The nonce is matched as exactly 32 hex digits
 * so a host name is never cut short at an `@` of its own.
 */
function lockOwnerAlive(lockPath: string, record: string): boolean | undefined {
  const owner = LOCK_RECORD.exec(record);
  if (owner?.[2] !== hostname()) return undefined;
  const pid = Number(owner[1]);
  if (pid === process.pid) return heldLocks.get(lockPath) === record;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Whether a held lock belongs to a writer that can no longer release it.
 *
 * Corner case (CC-CFG-58): the age alone used to decide, so a LIVE writer
 * slower than {@link LOCK_STALE_MS} — a hung `fsync` on a network home, a
 * debugger pause, a laptop lid closed mid-login — had its lock cleared under it.
 * The next writer then read the store before the slow one renamed its copy in,
 * and whichever renamed last discarded the other profile's fresh token. A lock
 * whose owner is recorded on this host is now judged by asking the kernel
 * whether that pid still runs, and its age is ignored. A heartbeat (re-touching
 * the lock) was rejected: it stalls in exactly the pauses above, so it would
 * only move the threshold.
 *
 * The age is still the fallback wherever the owner cannot be asked (see
 * {@link lockOwnerAlive}), which keeps crash recovery for a lock written by an
 * older build and for a store shared across machines. Residuals, accepted: a
 * crashed owner's pid reused by an unrelated process keeps the lock "alive", so
 * the next writer times out with a message telling the operator to delete the
 * lock — a wait, never a lost token; two hosts that share a hostname AND a home
 * directory can judge each other's live writer dead; a writer on another host
 * slower than {@link LOCK_STALE_MS} is still cleared by age, as before.
 */
async function lockIsStale(lockPath: string, record: string): Promise<boolean> {
  const alive = lockOwnerAlive(lockPath, record);
  if (alive !== undefined) return !alive;
  return (await lockAge(lockPath)) > LOCK_STALE_MS;
}

/**
 * Take the lock: create it exclusively and record this process as its owner.
 * Returns the record written, or `undefined` when another writer holds the lock.
 */
async function acquireLock(lockPath: string, filePath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (err) {
    // `EEXIST` is the one failure waiting can cure: another writer holds the
    // lock. Anything else (`ENAMETOOLONG`, `EACCES` on a directory an ACL has
    // closed) will not clear by retrying, so it fails now like any other step.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw storeFailure(err, 'write', filePath);
    }
    return undefined;
  }
  const record = newLockRecord();
  try {
    await handle.writeFile(record);
  } catch (err) {
    // A lock without its record would be judged by age alone; rather than hold
    // one, give it back (best-effort) and fail like any other write step.
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw storeFailure(err, 'write', filePath);
  }
  await handle.close();
  heldLocks.set(lockPath, record);
  return record;
}

/**
 * Run `critical` while holding an exclusive lock on the store.
 *
 * `writeCredentials` is a read-modify-write of ONE file shared by every profile.
 * The rename makes each write atomic, but not the sequence: two writers — a
 * `login` for one profile and a `refresh` for another, two server windows
 * refreshing at once (CC-AUTH-14), or two calls in one process — each read the
 * same old text, each merge in their own keys, and the second rename discards
 * the first writer's credentials without a word. The lock is a sibling file
 * created with `O_EXCL` (`wx`), which is atomic on every local filesystem, at
 * 0600 like everything else in the directory, holding its owner's pid and host.
 * A holder that crashed leaves it behind, so one {@link lockIsStale} judges
 * abandoned is cleared; otherwise a writer that waits past `timeoutMs` stops
 * with an error naming the lock file, rather than writing without it.
 *
 * Corner case (CC-CFG-62): every removal used to be an unconditional `rm` of
 * the NAME. Two waiters that judged the same stale lock could both clear it, the
 * later `rm` taking the earlier one's fresh lock with it; and a writer whose own
 * lock had been cleared under it (judged by age from another host, or by that
 * race) released by `rm` too, deleting whichever writer's lock sat there by then
 * and letting a third writer in beside it. Each lock now carries a nonce, and a
 * lock is removed only while its record is still the one judged stale, or the
 * one this writer took. Residual, accepted: POSIX has no compare-and-unlink, so
 * a lock replaced between that read and the unlink is still removed — one
 * syscall wide, and only after a writer has crashed or been judged so. A build
 * from before the nonce parses no owner from a new record and judges it by age
 * alone, as it judges a lock from another host.
 */
async function withStoreLock(
  filePath: string,
  timeoutMs: number,
  critical: () => Promise<void>,
): Promise<void> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  let held: string | undefined;
  while ((held = await acquireLock(lockPath, filePath)) === undefined) {
    if (Date.now() >= deadline) {
      throw new InstagramError(
        `Cannot write the credential store at ${filePath}: its lock ${lockPath} is held by ` +
          `another writer and was not released within ${timeoutMs} ms; retry once any ` +
          'other login or refresh has finished, or delete the lock file if none is running',
        { kind: 'validation' },
      );
    }
    const record = await readLockRecord(lockPath);
    if (await lockIsStale(lockPath, record)) {
      // A stale lock that cannot be cleared (a directory now sits at the name, or
      // the store directory refuses the unlink) will not clear by waiting either,
      // and its raw `node:fs` error must not escape unwrapped (CC-CFG-55).
      try {
        await removeLockIf(lockPath, record);
      } catch (err) {
        throw storeFailure(err, 'write', filePath);
      }
    }
    await sleep(LOCK_RETRY_MS);
  }
  try {
    await critical();
  } catch (err) {
    // Released best-effort on this path: whatever made the write fail (a
    // directory that turned unwritable, say) can make the release fail too, and
    // its raw error must not replace the one that says why the write failed.
    await releaseLock(lockPath, held);
    throw err;
  }
  // Best-effort on the success path too (CC-CFG-56). The store has already been
  // replaced, so a failed release must not report a completed save as a failure
  // — the caller would retry a `login` whose token is already on disk. A lock left
  // behind costs at most one wait: the next writer clears it once its owner has
  // exited, or fails naming it if even that is impossible.
  await releaseLock(lockPath, held);
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
