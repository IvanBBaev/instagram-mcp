/**
 * The command line of the `login` CLI subcommand: the argv parser
 * ({@link parseArgs}) with its env fallbacks, and its refusal of any token it
 * does not recognise ({@link unknownArgumentLine}).
 *
 * Pure — nothing here does I/O; the env map is passed in. The help text, the
 * profile-name rule and the flow that acts on the parsed options stay in
 * {@link import('./login.js').runLogin}'s module. Moved unchanged from
 * `cli/login.ts` on 2026-10-28.
 */
import { DEFAULT_PROFILE_NAME, envVarFor } from '../core/config.js';
import { createRedactor } from '../core/redact.js';
import type { AuthPath } from '../core/types.js';
import { escapeControls } from '../core/untrusted.js';
import { DEFAULT_REDIRECT_URI } from './redirect-capture.js';

export interface LoginOptions {
  path?: AuthPath;
  profile: string;
  appId?: string;
  appSecret?: string;
  redirectUri: string;
  accountId?: string;
  scopes?: string[];
  help: boolean;
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Map a `--path` token (`ig`/`fb`/`ig-login`/`fb-login`) to an {@link AuthPath}. */
function normalizePath(value: string | undefined): AuthPath | undefined {
  const s = clean(value)?.toLowerCase();
  if (s === 'ig' || s === 'ig-login') return 'ig-login';
  if (s === 'fb' || s === 'fb-login') return 'fb-login';
  return undefined;
}

/**
 * The parser's other answer: the first argv token it does not recognise.
 *
 * An unknown argument is a usage error, never a no-op. Until 2026-09-19 the
 * parser skipped anything it did not know, so `--scope x` (the singular slip of
 * `--scopes`) requested the DEFAULT scopes and the operator sat through a
 * consent screen for a token missing the one permission they had typed
 * (CC-CFG-17), and `-p=ig` was dropped and blamed on a missing `--path`.
 * Refusing is the only reading that cannot mint a token the operator did not
 * ask for. Parsing stops at the first such token, so exactly one is named.
 */
export interface UnknownArgument {
  unknownArgument: string;
  /** A parenthetical remediation for the refusal line, when one is known. */
  hint?: string;
  /**
   * Set when the token directly follows a value-taking flag spelling: the line
   * then names that flag and never echoes the token (see {@link parseArgs}).
   */
  after?: string;
}

/**
 * Every spelling that takes a value. The token after one of these is the value
 * the operator meant for it whenever the flag itself was swallowed as the value
 * of the flag before it (`--app-id --app-secret <secret>`) or given empty inline
 * (`--app-secret= <secret>`), so a refusal must not print it.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-p',
  '--path',
  '--profile',
  '--app-id',
  '--app-secret',
  '--redirect-uri',
  '--account-id',
  '--scopes',
]);

/**
 * Known near-miss spellings, for a `did you mean …?` hint on the refusal.
 * Not a fuzzy matcher — each entry is a slip with a concrete origin:
 * `--scope` is one keystroke short of the flag and is the slip CC-CFG-17
 * recorded; `--auth-path` / `--auth-mode` are the env variables
 * `IG_AUTH_PATH` / `IG_AUTH_MODE` with their prefix dropped — what an operator
 * who configured the path in the environment types when asked for it on the
 * command line.
 */
const NEAR_MISSES: ReadonlyMap<string, string> = new Map([
  ['--scope', '--scopes'],
  ['--auth-path', '--path'],
  ['--auth-mode', '--path'],
]);

/** The one-line refusal for an argv token the parser does not know. */
export function unknownArgumentLine({ unknownArgument, hint, after }: UnknownArgument): string {
  if (after !== undefined) {
    // Only a long flag takes an inline value (`-p=ig` is refused), so the
    // advice spells `-p` long.
    const inline = after === '-p' ? '--path' : after;
    return (
      `login: unexpected argument after '${after}' (not shown — it may be the value meant ` +
      `for that flag; pass it as ${inline}=<value>).`
    );
  }
  const suffix = hint === undefined ? '' : ` (${hint})`;
  return `login: unknown argument '${echoedArgument(unknownArgument)}'${suffix}.`;
}

/**
 * A bare run of 32 or more hex digits: the shape of a Meta app secret. Local
 * to this refusal on purpose — the shared redactor matches token SHAPES only,
 * and a 32-hex run is too common in ordinary text (ids, hashes) to mask
 * everywhere, but an argv token `login` does not know is exactly where a
 * secret pasted as a positional lands (CC-CFG-83).
 */
const BARE_HEX_SECRET = /(?<![0-9A-Za-z])[0-9A-Fa-f]{32,}(?![0-9A-Za-z])/g;

/**
 * The spelling of a refused argv token that is safe to print. A single-dash
 * token is never split at `=` by the parser, so its value would otherwise be
 * echoed with it: `-app-secret=<secret>` is a slip of the long flag carrying
 * the secret. It is named only up to and including the `=` (`-app-secret=`,
 * `-p=`), which still shows the spelling that failed. What remains goes
 * through the token-shape redactor, as on the entry's own refusals
 * (CC-PROC-208), and then through {@link BARE_HEX_SECRET}, so a token or an
 * app secret pasted as a positional reads `[REDACTED]`. Last, every control
 * character is written as a JSON escape (`\uXXXX`), so an ANSI sequence or a
 * newline in the token cannot repaint the terminal or forge a line.
 */
function echoedArgument(token: string): string {
  const eq = token.indexOf('=');
  const cut = token.startsWith('-') && eq !== -1 ? token.slice(0, eq + 1) : token;
  return escapeControls(String(createRedactor()(cut)).replace(BARE_HEX_SECRET, '[REDACTED]'));
}

/**
 * Parse argv (with env fallbacks) into resolved {@link LoginOptions}, or stop
 * at the first token the parser does not recognise ({@link UnknownArgument}).
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): LoginOptions | UnknownArgument {
  const opts: LoginOptions = {
    profile: DEFAULT_PROFILE_NAME,
    redirectUri: DEFAULT_REDIRECT_URI,
    help: false,
    appId: clean(env.IG_APP_ID),
    appSecret: clean(env.IG_APP_SECRET),
    path: normalizePath(clean(env.IG_AUTH_PATH) ?? clean(env.IG_AUTH_MODE)),
  };
  // Whether the command line has named the path yet — by `--path`/`-p` (well
  // or badly spelled) or by the one bare positional. The env value above is a
  // default, not a spelling on the line, so it does not count: with
  // `IG_AUTH_PATH=fb` in an MCP client's config, `login ig` is one explicit
  // request, not a second one, and it wins over the default exactly as
  // `--path ig` does.
  let pathOnArgv = false;
  // Whether `--account-id` was on the line. Its env fallback is read after
  // the loop because it depends on `--profile` (CC-CFG-84).
  let accountIdOnArgv = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    let flag = arg;
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flag = arg.slice(0, eq);
        inline = arg.slice(eq + 1);
      }
    }
    const value = (): string | undefined => (inline !== undefined ? inline : argv[++i]);

    switch (flag) {
      case '-h':
      case '--help':
        // A bit, not an early return: the rest of the line is still parsed,
        // so an unknown token after `--help` is refused (see `runLogin`).
        opts.help = true;
        break;
      case '-p':
      case '--path':
        opts.path = normalizePath(value());
        pathOnArgv = true;
        break;
      case '--profile': {
        const v = clean(value());
        if (v !== undefined) opts.profile = v.toLowerCase();
        break;
      }
      case '--app-id':
        opts.appId = clean(value());
        break;
      case '--app-secret':
        opts.appSecret = clean(value());
        break;
      case '--redirect-uri': {
        const v = clean(value());
        if (v !== undefined) opts.redirectUri = v;
        break;
      }
      case '--account-id':
        opts.accountId = clean(value());
        accountIdOnArgv = true;
        break;
      case '--scopes': {
        // A value that names no scope at all (`--scopes=`, `--scopes ,`) is
        // "not given", not "request nothing": `scope=` on the authorize URL
        // mints a token no tool can use.
        const list = (clean(value()) ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
        if (list.length > 0) opts.scopes = list;
        break;
      }
      default: {
        // Anything the switch did not claim is either the one bare positional
        // this command accepts — an auth-path name (`login ig`) — or an
        // argument the parser does not know, which is refused. `normalizePath`
        // is the whole test: it answers for exactly four bare spellings (`ig`,
        // `fb`, `ig-login`, `fb-login`), none of which starts with a dash, so a
        // flag-shaped token (`--bogus`, `-x`, `-p=ig`) is refused by the same
        // line as a stray word, and no separate dash guard is needed.
        //
        // What is echoed is `flag`, not `arg`: for a long flag with an inline
        // value that is the name before the `=`, because the value is exactly
        // what would have followed `--app-secret` — `--app-secrett=…` is a typo
        // carrying the secret. A single-dash token is never split, so the
        // refusal cuts it after its `=` for the same reason (`-app-secret=…`
        // is named `-app-secret=`; see `echoedArgument`). Every other token is
        // echoed whole, token shapes and bare hex secrets masked; it is an
        // argv token the operator typed, never a value the parser consumed.
        //
        // The one exception is a token right after a value-taking flag spelling.
        // That flag was itself consumed as the value of the flag before it
        // (`--app-id --app-secret <secret>`) or given an empty inline value
        // (`--app-secret= <secret>`), so this token is the value the operator
        // meant for it — the secret, in the case that matters — and the line
        // names the flag instead.
        const positional = normalizePath(arg);
        if (positional === undefined) {
          const prev = argv[i - 1] ?? '';
          // Only a bare spelling (necessarily swallowed as a value, or it would
          // have consumed this token) or one with an EMPTY inline value counts:
          // after `--app-secret=x` the flag has its value and this token is a
          // genuine stray, named as usual. No `--` test is needed on the `=`
          // form: `-p=` is itself refused before this token is reached.
          const prevFlag = prev.endsWith('=') ? prev.slice(0, -1) : prev;
          if (VALUE_FLAGS.has(prevFlag)) {
            return { unknownArgument: flag, after: prevFlag };
          }
          const meant = NEAR_MISSES.get(flag);
          return meant === undefined
            ? { unknownArgument: flag }
            : { unknownArgument: flag, hint: `did you mean ${meant}?` };
        }
        // A second path name is refused too, whichever spelling gave the first:
        // the flag is the authoritative form and may repeat (last wins, as
        // before), but a positional after ANY explicit path is a stray token,
        // not an override. `--path fb ig` used to run Path B and drop the `ig`
        // in silence; `login ig fb` cannot be granted either reading safely,
        // because the two paths use different hosts and different credentials.
        // The word itself is a known one, so the line says why it is refused.
        if (pathOnArgv) return { unknownArgument: arg, hint: 'the auth path is already given' };
        opts.path = positional;
        pathOnArgv = true;
        break;
      }
    }
  }
  // The account id is per profile, so its env fallback is the profile's own
  // key: `IG_ACCOUNT_ID` for the default, `IG_PROFILE_<NAME>_ACCOUNT_ID` for a
  // named one. Bare `IG_ACCOUNT_ID` is usually the config-home `.env` a
  // default-profile login wrote, and the entry loads it before `login` runs;
  // read for `--profile biz`, it outranked Meta's `user_id` and stored the
  // DEFAULT account as biz's, so every biz call addressed the wrong account
  // (CC-CFG-84).
  if (!accountIdOnArgv) opts.accountId = clean(env[envVarFor(opts.profile, 'ACCOUNT_ID')]);
  return opts;
}
