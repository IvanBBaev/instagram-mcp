/**
 * Shared helpers for tests that exercise the per-platform config-home
 * resolution owned by `src/core/config-write.ts` (and reused by the entry's
 * env-file lookup).
 *
 * The resolver reads a DIFFERENT variable per platform — `%APPDATA%` on win32,
 * `$XDG_CONFIG_HOME` everywhere else — so a test that injects only one of them
 * does not merely fail on the other platform: with no recognized variable the
 * resolver falls back to the REAL user config home. Because `writeCredentials`
 * merges into an existing file and replaces the keys it owns, a Windows
 * developer running `npm test` would have their live `IG_ACCESS_TOKEN`
 * overwritten with a fake test token. Always build the injected env through
 * {@link configHomeEnv} so the temp directory is honored on every platform.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Directory created under the config home — mirrors `SERVER_DIR` in config-write.ts. */
export const SERVER_DIR = 'instagram-mcp-ai';

/**
 * An env map that points the platform's config-home resolution at `dir`.
 *
 * Only the variable the running platform actually reads is set — deliberately,
 * so a resolver that consulted the wrong one would fall back to the real config
 * home and fail the test instead of silently passing.
 *
 * `platform` defaults to the running platform and exists so this mapping can be
 * asserted for BOTH platforms from either one. Without it the win32 arm is only
 * ever executed on Windows, which is exactly the arm whose absence corrupts a
 * Windows developer's real credentials — the case least affordable to leave
 * unproven on the machine where the suite actually runs.
 */
export function configHomeEnv(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return platform === 'win32' ? { APPDATA: dir } : { XDG_CONFIG_HOME: dir };
}

/** The env file `writeCredentials` produces under a config-home base. */
export function envFileIn(configHome: string): string {
  return path.join(configHome, SERVER_DIR, '.env');
}

/** A fresh throwaway config-home base under the OS temp directory. */
export async function makeTempConfigHome(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}
