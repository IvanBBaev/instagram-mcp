/**
 * The `login` CLI subcommand — interactive browser OAuth to obtain and persist a
 * long-lived Instagram access token, for BOTH auth paths (docs/auth.md §1):
 *
 *  - `ig-login` (Path A): authorize on www.instagram.com → exchange the code on
 *    api.instagram.com for a short-lived token → exchange that on
 *    graph.instagram.com (`ig_exchange_token`) for a ~60-day long-lived token.
 *  - `fb-login` (Path B): authorize on www.facebook.com → exchange the code on
 *    graph.facebook.com → exchange (`fb_exchange_token`) for a long-lived token.
 *
 * HONESTY: a live login cannot run without a **registered Meta app** — an app id
 * and secret plus a redirect URI whitelisted in the app's OAuth settings. This
 * module therefore cannot be exercised end-to-end here; what IS verified by the
 * unit tests is the reusable core: authorize-URL construction, both token
 * exchanges (against an injected `fetch`), the expiry math, persistence via
 * {@link writeCredentials}, and — through injected server/clock fakes, never a
 * real socket or a real timer — the loopback capture's routing, `state` check
 * and timeout ({@link captureAuthorizationCode}).
 *
 * This module keeps the flow ({@link runLogin}) and its seams. The pieces it
 * sequences live beside it: the argv parser and help text in
 * `cli/login-args.ts`, the authorize URL and both token exchanges in
 * `cli/login-exchange.ts`, and the loopback redirect capture in
 * `cli/redirect-capture.ts` (split out unchanged on 2026-10-28).
 *
 * The OAuth token endpoints (api.instagram.com, graph.*) are addressed with
 * an injected `fetch`, deliberately outside the runtime SSRF allowlist in
 * `core/host.ts` (that gate governs model-driven Graph calls, not this operator
 * CLI). No token or secret value is ever written to stdout/stderr.
 */
import { randomBytes } from 'node:crypto';

import { createRedactor, surfaceForms } from '../core/redact.js';
import { DEFAULT_SCOPES } from './scopes.js';
import { writeCredentials } from '../core/config-write.js';
import { parseArgs, unknownArgumentLine } from './login-args.js';
import {
  buildAuthorizeUrl,
  computeExpiresAtSec,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
} from './login-exchange.js';
import {
  CAPTURE_TIMEOUT_MS,
  DEFAULT_REDIRECT_URI,
  captureAuthorizationCode,
  redirectUriProblem,
} from './redirect-capture.js';

// --- runLogin --------------------------------------------------------------

/** Injectable collaborators for {@link runLogin} (all default to real I/O). */
export interface LoginDeps {
  /** HTTP client for the token exchanges. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
  /** Open the authorize URL in a browser. Omitted ⇒ the URL is only printed. */
  openUrl?: (url: string) => void | Promise<void>;
  /** Env map for defaults / config-home resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Clock for expiry math. Defaults to `Date.now`. */
  now?: () => number;
  /** Capture the authorization `code`. Injected out in tests (no browser). */
  captureCode?: (params: {
    redirectUri: string;
    state: string;
    authorizeUrl: string;
  }) => Promise<string>;
  /** Persist step. Defaults to {@link writeCredentials}. */
  persist?: typeof writeCredentials;
  /** Diagnostics sink (stderr only — stdout is the MCP protocol channel). */
  stderr?: (msg: string) => void;
  /** Random OAuth `state` factory. Defaults to a crypto-random hex string. */
  makeState?: () => string;
}

const HELP_TEXT = `instagram-mcp-ai login — obtain and persist a long-lived token.

Usage:
  instagram-mcp-ai login --path <ig|fb> [options]

Options:
  --path, -p <ig|fb>     Auth path: ig (Instagram Login) or fb (Facebook Login). Required.
  --profile <name>       Account profile to write (default: "default").
  --app-id <id>          Meta app id       (or env IG_APP_ID).
  --app-secret <secret>  Meta app secret   (or env IG_APP_SECRET).
  --redirect-uri <uri>   OAuth redirect URI (default: ${DEFAULT_REDIRECT_URI}).
  --account-id <id>      IG professional-account id (optional).
  --scopes <csv>         Comma-separated scope override (default: per path).
  --help, -h             Show this help.

The long flags also take the --flag=value form, and the path may be given as
a bare word (login ig). Any other argument is refused with exit code 2.

A live login requires a REGISTERED META APP: the app id/secret above and a
redirect URI whitelisted in the app's OAuth settings. Meta matches redirect URIs
literally, so the value above must be registered VERBATIM under
"Valid OAuth Redirect URIs" — "127.0.0.1" and "localhost" are different entries,
and only the loopback address is bound here. Without those it cannot run — there
is no offline login. The token is written to the XDG/APPDATA env file
(chmod 0600 on POSIX) and is never printed.
If IG_ENV_FILE is set, the file it names (an absolute path; a leading ~ is the
home directory) is written instead:
it is the only env file the server reads while that variable is set.
`;

/**
 * The profile names the credentials file can be read back under: dotenv parses
 * only keys made of `[\w.-]`, so `IG_PROFILE_<NAME>_*` with any other character
 * in `<NAME>` is written by `login` and then silently dropped on load.
 */
const PROFILE_NAME = /^[a-z0-9_.-]+$/;

/**
 * Human-readable, token-free expiry line for the success message.
 *
 * `expiresAtSec` is `computeExpiresAtSec`'s answer, already bounded to a
 * recordable instant (after the epoch, before the year 10000), which a `Date`
 * can always hold. When it is `undefined` although the upstream DID send a
 * lifetime, that lifetime named no recordable instant with this clock (`1e300`,
 * or a sum at or before the epoch): the line says so and names the number — a lifetime, never a token or a secret —
 * instead of the misleading "no lifetime returned". (Unbounded, the sum once made
 * `toISOString()` throw inside `runLogin` after the credential was persisted.)
 */
function expiryLine(expiresAtSec: number | undefined, expiresInSec: number | undefined): string {
  if (expiresAtSec === 0) return 'Token expiry: never.\n';
  if (expiresAtSec !== undefined) {
    return `Token expires at ${new Date(expiresAtSec * 1000).toISOString()}.\n`;
  }
  if (expiresInSec === undefined) return 'Token expiry: unknown (no lifetime returned).\n';
  return (
    `Token expiry: unknown (upstream returned an expires_in of ${expiresInSec}, which ` +
    'resolves to no recordable timestamp; no expiry was stored).\n'
  );
}

/**
 * Run the `login` subcommand end-to-end and return a process exit code
 * (`0` success, `2` bad usage, `1` runtime failure). All output goes to stderr;
 * no token or secret value is ever printed.
 */
export async function runLogin(argv: string[], deps: LoginDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((msg: string) => void process.stderr.write(msg));
  const env = deps.env ?? process.env;
  const parsed = parseArgs(argv, env);

  // An unknown argument outranks `--help` on either side of it: the parser
  // stops at the first unknown token, so `--bogus --help` never sees the help
  // flag, and `--help` does not stop the parser (it sets a bit and reads on),
  // so `--help --bogus` still reaches the stray — deterministic, like
  // `git --bogus --help`. A line that asks for help AND carries a token the
  // command cannot act on is a line the operator will paste again once the
  // help is read; naming the token now is the shorter route.
  if ('unknownArgument' in parsed) {
    stderr(`${unknownArgumentLine(parsed)}\n\n${HELP_TEXT}`);
    return 2;
  }
  const opts = parsed;

  if (opts.help) {
    stderr(HELP_TEXT);
    return 0;
  }
  if (!PROFILE_NAME.test(opts.profile)) {
    stderr(
      "login: --profile takes only letters, digits, '_', '.' and '-' — a profile stored " +
        'under any other name could never be loaded back from the credentials file.\n',
    );
    return 2;
  }
  // Refused before anything is printed or opened: a redirect URI the listener
  // cannot receive sends the operator through Meta's consent screen for nothing.
  const redirectProblem = redirectUriProblem(opts.redirectUri);
  if (redirectProblem !== undefined) {
    stderr(`login: ${redirectProblem}\n`);
    return 2;
  }
  const path = opts.path;
  if (path === undefined) {
    stderr(`login: --path <ig|fb> is required.\n\n${HELP_TEXT}`);
    return 2;
  }
  const appId = opts.appId;
  const appSecret = opts.appSecret;
  if (appId === undefined || appSecret === undefined) {
    stderr(
      'login: an app id and app secret are required — pass --app-id/--app-secret ' +
        'or set IG_APP_ID/IG_APP_SECRET. A live login needs a registered Meta app.\n',
    );
    return 2;
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const persist = deps.persist ?? writeCredentials;
  const makeState = deps.makeState ?? (() => randomBytes(16).toString('hex'));
  const scopes = opts.scopes ?? [...DEFAULT_SCOPES[path]];
  const state = makeState();
  const redirectUri = opts.redirectUri;
  // Every secret this run holds or mints, collected as it appears so the
  // failure line below can mask it. The app secret is 32 hex with no token
  // shape, and a Page/Instagram token need not match the `EAA…`/`IG…` backstop,
  // so exact values are the only reliable mask (F-4). Each is registered in
  // BOTH spellings — as held, and form-encoded as `URLSearchParams` put it in
  // the query or the POST body — because the redactor matches exact substrings
  // and a transport or proxy that names the request quotes the encoded one
  // (CC-AUTH-76; `refresh` registers the same two forms).
  const secrets: string[] = [...surfaceForms(appSecret)];

  try {
    const authorizeUrl = buildAuthorizeUrl(path, { appId, redirectUri, scopes, state });
    stderr(`Open this URL in a browser to authorize (${path}):\n${authorizeUrl}\n`);
    if (deps.openUrl !== undefined) await deps.openUrl(authorizeUrl);

    // The waiting notice belongs to the real listener only — an injected capture
    // (tests, or an operator pasting the code) does not bind a socket or wait.
    let capture = deps.captureCode;
    if (capture === undefined) {
      stderr(
        `Waiting up to ${Math.round(CAPTURE_TIMEOUT_MS / 60_000)} minutes for the redirect to ` +
          `${redirectUri}. That EXACT URI must be listed under the Meta app's Valid OAuth ` +
          'Redirect URIs, or the browser never comes back here.\n',
      );
      capture = (p) => captureAuthorizationCode(p);
    }
    const code = await capture({ redirectUri, state, authorizeUrl });
    secrets.push(...surfaceForms(code));

    const short = await exchangeCodeForToken(
      path,
      { code, appId, appSecret, redirectUri },
      fetchFn,
    );
    secrets.push(...surfaceForms(short.accessToken));
    const long = await exchangeForLongLivedToken(
      path,
      { shortToken: short.accessToken, appId, appSecret },
      fetchFn,
    );
    secrets.push(...surfaceForms(long.accessToken));
    const expiresAtSec = computeExpiresAtSec(long.expiresInSec, now());

    const result = await persist(
      opts.profile,
      {
        accessToken: long.accessToken,
        authPath: path,
        accountId: opts.accountId ?? short.userId,
        appId,
        appSecret,
        expiresAtSec,
      },
      { env },
    );

    stderr(`Stored long-lived ${path} token for profile '${opts.profile}' at ${result.path}.\n`);
    stderr(expiryLine(expiresAtSec, long.expiresInSec));
    return 0;
  } catch (err) {
    // Only the message is surfaced (never a URL — the query carries secrets),
    // and it is redacted: it is upstream text (a Graph `error.message`, a
    // listener or filesystem error) that can quote any value this run sent or
    // minted. The redactor is local — this process exits right after, so a
    // global registration would reach nothing (see the `login` dispatch in
    // `src/index.ts`).
    const message = err instanceof Error ? err.message : String(err);
    const redact = createRedactor({ extraSecrets: secrets });
    stderr(`login failed: ${String(redact(message))}\n`);
    return 1;
  }
}
