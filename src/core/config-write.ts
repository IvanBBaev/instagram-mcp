/**
 * Credential persistence (Layer 0). Writes/updates the resolved credentials for
 * one account profile into the runtime env file, using the exact key scheme
 * `core/config.ts` reads back (so a write always round-trips through
 * {@link import('./config.js').loadProfiles}).
 *
 * Storage rules (docs/security.md §2, docs/architecture.md §6):
 *  - Path: `<XDG_CONFIG_HOME | ~/.config>/instagram-mcp-ai/.env` on POSIX;
 *    `%APPDATA%\instagram-mcp-ai\.env` on Windows.
 *  - Atomic, comment-preserving rewrite: existing comments and unrelated keys are
 *    kept; only the profile's credential keys are inserted/updated; the file is
 *    written to a temp sibling and `rename`d into place.
 *  - `chmod 0600` on POSIX after writing; SKIP on Windows (NTFS ACLs apply —
 *    CC-CFG-8).
 *  - Never logs, prints, or otherwise surfaces token/secret values — this module
 *    only writes to the target file.
 *
 * `opts.configDir` / `opts.env` are injection points so tests write to a temp
 * directory without touching the real config home.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { DEFAULT_PROFILE_NAME } from './config.js';
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
   * Persisted as forward-looking token metadata per docs/auth.md §3; it is NOT
   * read by `core/config.ts` today, so it never affects the profile round-trip.
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
  /** Env map for config-home resolution (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
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
 * The concrete env var name for a profile field — identical scheme to
 * `config.ts`'s `envVarFor`: the default profile uses bare `IG_<SUFFIX>`, named
 * profiles use `IG_PROFILE_<NAME_UPPER>_<SUFFIX>`.
 */
function envKey(profileName: string, suffix: string): string {
  return profileName === DEFAULT_PROFILE_NAME
    ? `IG_${suffix}`
    : `IG_PROFILE_${profileName.toUpperCase()}_${suffix}`;
}

/** Resolve the config-home base directory (POSIX XDG / Windows APPDATA). */
function configHome(opts: WriteCredentialsOptions): string {
  const override = clean(opts.configDir);
  if (override !== undefined) return override;

  const env = opts.env ?? process.env;
  if (process.platform === 'win32') {
    const appData = clean(env.APPDATA);
    return appData ?? path.join(homedir(), 'AppData', 'Roaming');
  }
  const xdg = clean(env.XDG_CONFIG_HOME);
  return xdg ?? path.join(homedir(), '.config');
}

/** Absolute path of the env file for the given options. */
function resolveEnvFilePath(opts: WriteCredentialsOptions): string {
  return path.join(configHome(opts), SERVER_DIR, ENV_FILE_NAME);
}

/**
 * Format a value for the env file so `dotenv` parses it back verbatim. Simple
 * token/secret shapes are emitted bare. Otherwise SINGLE quotes are preferred:
 * `dotenv` treats a single-quoted value as a literal (no escape processing), so
 * spaces, `=`, `#`, and embedded double quotes round-trip exactly. Only when the
 * value itself contains a single quote or a newline do we fall back to double
 * quotes, where `dotenv` reverses `\n` / `\r` (it does NOT un-escape `\"`, so a
 * literal double quote is never emitted via the double-quoted form).
 */
function formatValue(value: string): string {
  if (/^[A-Za-z0-9_@%+./:=~-]*$/.test(value)) return value;
  if (!/['\r\n]/.test(value)) return `'${value}'`;
  const escaped = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/** The env key on an assignment line (`KEY=...`, optional `export`), else undefined. */
function keyOf(line: string): string | undefined {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match?.[1];
}

/** Build the ordered set of `KEY -> formatted value` assignments for a profile. */
function buildUpdates(profileName: string, creds: Credentials): Map<string, string> {
  const updates = new Map<string, string>();
  const set = (suffix: string, value: string | undefined): void => {
    const v = clean(value);
    if (v !== undefined) updates.set(envKey(profileName, suffix), formatValue(v));
  };
  set('ACCESS_TOKEN', creds.accessToken);
  set('AUTH_PATH', creds.authPath);
  set('ACCOUNT_ID', creds.accountId);
  set('APP_ID', creds.appId);
  set('APP_SECRET', creds.appSecret);
  if (creds.expiresAtSec !== undefined) {
    // Metadata key — config.ts does not read it (unknown suffix), so it never
    // perturbs the profile round-trip; token-status / doctor tooling consume it.
    updates.set(envKey(profileName, 'TOKEN_EXPIRES_AT'), String(creds.expiresAtSec));
  }
  return updates;
}

/**
 * Merge `updates` into the existing env-file text: replace the value of any key
 * already present in place, preserving every comment, blank line, and unrelated
 * key; append the remaining keys at the end. A fresh file gets a short header.
 */
function mergeEnv(existing: string, updates: Map<string, string>): string {
  const remaining = new Map(updates);
  const hadContent = existing.length > 0;
  const lines = hadContent ? existing.split(/\r?\n/) : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const out = lines.map((line) => {
    const key = keyOf(line);
    if (key !== undefined && remaining.has(key)) {
      const value = remaining.get(key);
      remaining.delete(key);
      return `${key}=${value ?? ''}`;
    }
    return line;
  });

  if (!hadContent) {
    out.push('# instagram-mcp-ai credentials — written by the `login` CLI.');
    out.push('# Keep private (chmod 0600); never commit this file.');
  }
  for (const [key, value] of remaining) out.push(`${key}=${value}`);

  return `${out.join('\n')}\n`;
}

/** Read the current file text, treating a missing file as empty. */
async function readExisting(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Write `content` atomically: temp sibling → `chmod 0600` (POSIX) → `rename`.
 * The mode is set on the temp file before the rename so the final file is never
 * momentarily world-readable; on Windows chmod is skipped (CC-CFG-8).
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  const posix = process.platform !== 'win32';
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  if (posix) await chmod(tmp, 0o600);
  await rename(tmp, filePath);
  if (posix) await chmod(filePath, 0o600);
}

/**
 * Write/update the resolved credentials for `profileName` into the env file.
 *
 * @param profileName Profile to write — `'default'` uses the bare `IG_*` keys;
 *   any other name uses the `IG_PROFILE_<NAME>_*` keys (case-insensitive).
 * @returns The file path written and the env keys that were created/updated.
 * @throws {InstagramError} `kind: 'validation'` when `accessToken` is blank.
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
  const filePath = resolveEnvFilePath(opts);
  const existing = await readExisting(filePath);
  const updates = buildUpdates(name, creds);
  await atomicWrite(filePath, mergeEnv(existing, updates));
  return { path: filePath, keys: [...updates.keys()] };
}
