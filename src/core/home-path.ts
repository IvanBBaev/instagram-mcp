/**
 * Home-directory spellings in environment-supplied paths (Layer 0).
 *
 * An MCP client's JSON `env` block hands a value to the server verbatim, while
 * the same line in a shell profile is expanded before any program sees it. A
 * leading `~` therefore reaches this server unexpanded in exactly the setups
 * where a terminal elsewhere expanded it, and `node:fs` would treat it as a
 * directory NAMED `~` under the cwd. This module settles the two spellings once:
 * the home directory's own `~` is expanded (CC-CFG-60), and any other spelling
 * only a shell can resolve is refused (CC-CFG-61).
 *
 * Shared by the config-home resolver in `core/config-write.ts` (CC-CFG-60/61)
 * and the settings loader (state home, write journal), so the two cannot drift.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { InstagramError } from './types.js';

/**
 * A leading `~` that means "the home directory": `~` alone, or `~` followed by a
 * separator. On Windows a backslash separates too.
 */
export function homeTilde(platform: NodeJS.Platform): RegExp {
  return platform === 'win32' ? /^~(?=$|[/\\])/ : /^~(?=$|\/)/;
}

/**
 * A spelling only a shell can resolve: `~user` / `~+` (a tilde prefix other than
 * the home directory's own), `$VAR` / `${VAR}`, or `%VAR%`. Tested AFTER
 * {@link expandHomeTilde}, so the home's own `~` never reaches it.
 *
 * Only the START is judged, on purpose. A leading spelling is what turns the
 * value into a relative name (or one dotenv reinterprets), so it lands somewhere
 * the operator did not mean. A `$` or `%` further in sits inside a path that is
 * already absolute, which every reader and writer here opens byte for byte, so
 * it cannot split them. It is also how real names are spelled: a UNC admin
 * share (`\\host\C$\…`), `C:\$Recycle.Bin`, a URL-encoded or plain `100%`
 * directory — and a false refusal here stops the server from starting at all.
 * A literal name that does not exist still fails loudly, with the path echoed.
 */
const SHELL_SPELLING = /^(?:~|\$|%)/;

/**
 * Format and line/paragraph separators (bidi overrides, zero-width marks,
 * U+2028/U+2029). `JSON.stringify` already escapes every control character, but
 * passes these through untouched, so a quoted value could still reorder or split
 * the line it is printed on.
 */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * `value` as a JSON string literal with every invisible character escaped. An
 * astral match (the Unicode tag block is `Cf`) is two UTF-16 code units, so it is
 * escaped unit by unit, exactly as JSON spells a surrogate pair.
 */
function quote(value: string): string {
  return JSON.stringify(value).replace(INVISIBLE, (c) =>
    c
      .split('')
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  );
}

/**
 * The home directory, refused unless it is absolute (CC-CFG-69).
 *
 * `os.homedir()` returns `$HOME` (`%USERPROFILE%` on Windows) VERBATIM whenever
 * the variable is set — blank, `"   "` or relative included. Every path built on
 * it was then relative, and a relative credential path follows the cwd: with
 * `HOME="   "` a `~` config dir wrote `<cwd>/   /instagram-mcp-ai/.env`, a
 * directory `ls` prints as nothing. The cwd of an MCP server is whatever its
 * client chose (CC-CFG-24), so such a path is refused rather than resolved.
 *
 * @throws {InstagramError} `kind: 'validation'`, naming the variable to fix.
 */
export function homeDirectory(platform: NodeJS.Platform): string {
  const home = homedir();
  if (isAbsolute(home)) return home;
  const variable = platform === 'win32' ? 'USERPROFILE' : 'HOME';
  throw new InstagramError(
    `the home directory is ${quote(home)} (from ${variable}), which is not an absolute path, ` +
      'so a file under it would be looked for in whatever directory the process was started ' +
      `from; set ${variable} to an absolute path`,
    { kind: 'validation' },
  );
}

/**
 * The home directory's `~` / `~/…` spelled out; any other value unchanged. The
 * home is consulted only when the value names it, so an odd `$HOME` never stops
 * a value that does not depend on it.
 *
 * @throws {InstagramError} via {@link homeDirectory} when `~` names a home that
 *   is not absolute.
 */
export function expandHomeTilde(value: string, platform: NodeJS.Platform): string {
  return homeTilde(platform).test(value) ? join(homeDirectory(platform), value.slice(1)) : value;
}

/**
 * Refuse a value {@link SHELL_SPELLING} matches, naming `source` and what the
 * path was for (`purpose`, e.g. "for the write journal"). The value is echoed: it
 * is a path, never a secret — but through {@link quote}, so it cannot forge or
 * repaint the stderr line it is reported on.
 *
 * @throws {InstagramError} `kind: 'validation'`.
 */
export function assertNotShellSpelling(value: string, source: string, purpose: string): void {
  if (SHELL_SPELLING.test(value)) {
    throw new InstagramError(
      `${source} is ${quote(value)}, which only a shell can expand — it is not a path this ` +
        `server can use ${purpose}; set it to an absolute path`,
      { kind: 'validation' },
    );
  }
}
