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
 * The OAuth token endpoints (api.instagram.com, graph.*) are addressed here with
 * an injected `fetch`, deliberately outside the runtime SSRF allowlist in
 * `core/host.ts` (that gate governs model-driven Graph calls, not this operator
 * CLI). No token or secret value is ever written to stdout/stderr.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { systemClock } from '../core/clock.js';
import type { Clock } from '../core/clock.js';
import { GRAPH_VERSION } from '../core/host.js';
import { DEFAULT_PROFILE_NAME } from '../core/config.js';
import { InstagramError } from '../core/types.js';
import type { AuthPath } from '../core/types.js';
import { writeCredentials } from '../core/config-write.js';

// --- Endpoints (docs/auth.md §1) -------------------------------------------

const IG_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH_BASE = 'https://graph.instagram.com';
const FB_WWW_BASE = 'https://www.facebook.com';
const FB_GRAPH_BASE = 'https://graph.facebook.com';

/**
 * Loopback redirect used to capture the authorization `code`.
 *
 * The host is the literal `127.0.0.1`, NOT `localhost`, and it must stay that
 * way: {@link captureAuthorizationCode} binds a single loopback address, while
 * `localhost` resolves to `::1` before `127.0.0.1` on most macOS and Windows
 * boxes. With the two spellings disagreeing the browser hits a closed IPv6
 * socket, the `code` never arrives, and `login` waits forever.
 *
 * OPERATOR NOTE: this exact string is what Meta redirects to, so it must be
 * registered verbatim in the Meta app (App settings → Instagram/Facebook Login →
 * Valid OAuth Redirect URIs). An app whitelisted with the old
 * `http://localhost:8723/callback` must have `http://127.0.0.1:8723/callback`
 * added (or `--redirect-uri` passed) — Meta matches redirect URIs literally.
 */
const DEFAULT_REDIRECT_PORT = 8723;
/** The only loopback addresses this CLI will bind (see {@link listenHostFor}). */
const LOOPBACK_IPV4 = '127.0.0.1';
const LOOPBACK_IPV6 = '::1';
export const DEFAULT_REDIRECT_URI = `http://${LOOPBACK_IPV4}:${DEFAULT_REDIRECT_PORT}/callback`;

/**
 * Absolute budget for the browser round-trip. Without it a redirect that never
 * arrives (wrong/unregistered redirect URI, closed browser tab, loopback
 * mismatch) leaves `login` hanging with no diagnostic — defect: the listener had
 * no timeout at all.
 */
const CAPTURE_TIMEOUT_MS = 5 * 60_000;

/** Default granular scopes per path (docs/auth.md §1). */
const DEFAULT_SCOPES: Record<AuthPath, readonly string[]> = {
  'ig-login': [
    'instagram_business_basic',
    'instagram_business_content_publish',
    'instagram_business_manage_comments',
    'instagram_business_manage_messages',
    'instagram_business_manage_insights',
  ],
  'fb-login': [
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',
    'instagram_manage_insights',
    'instagram_manage_messages',
    'pages_show_list',
    'pages_read_engagement',
    'business_management',
  ],
};

// --- Pure helper: authorize URL --------------------------------------------

/** Inputs for {@link buildAuthorizeUrl}. */
export interface AuthorizeParams {
  appId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
}

/**
 * Build the browser authorization URL for `path`. `ig-login` targets the
 * Instagram authorization window; `fb-login` targets the versioned Facebook
 * OAuth dialog. Scopes are comma-joined per Meta's `scope` convention.
 */
export function buildAuthorizeUrl(path: AuthPath, params: AuthorizeParams): string {
  const query = new URLSearchParams({
    client_id: params.appId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: params.scopes.join(','),
    state: params.state,
  });
  const base =
    path === 'ig-login' ? IG_AUTHORIZE_URL : `${FB_WWW_BASE}/${GRAPH_VERSION}/dialog/oauth`;
  return `${base}?${query.toString()}`;
}

// --- Pure helpers: token exchanges -----------------------------------------

/** A short-lived token from the code exchange. */
export interface ShortLivedToken {
  accessToken: string;
  /** `ig-login` returns the IG-scoped user id alongside the token. */
  userId?: string;
  /** `fb-login` returns the token lifetime in seconds. */
  expiresInSec?: number;
}

/** A long-lived token from the exchange. */
export interface LongLivedToken {
  accessToken: string;
  /** Lifetime in seconds (`0`/absent ⇒ never-expiring / unknown). */
  expiresInSec?: number;
}

/** Inputs for {@link exchangeCodeForToken}. */
export interface CodeExchangeParams {
  code: string;
  appId: string;
  appSecret: string;
  redirectUri: string;
}

/** Inputs for {@link exchangeForLongLivedToken}. */
export interface LongLivedExchangeParams {
  shortToken: string;
  appId: string;
  appSecret: string;
}

/** Coerce an unknown JSON value into a record. */
function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strOrUndef(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** Read `access_token` from an exchange body, or throw an auth error. */
function requireToken(json: Record<string, unknown>): string {
  const token = json.access_token;
  if (typeof token !== 'string' || token === '') {
    throw new InstagramError('Token exchange response did not include an access_token.', {
      kind: 'auth',
    });
  }
  return token;
}

/**
 * Turn a non-2xx exchange response into an {@link InstagramError}. Only the
 * status and the Graph error message are surfaced — never the request URL, which
 * carries the app secret / token in its query string.
 */
function exchangeError(status: number, body: unknown): InstagramError {
  const err = toRecord(toRecord(body).error);
  const message =
    typeof err.message === 'string' && err.message !== ''
      ? err.message
      : `OAuth token exchange failed (HTTP ${status}).`;
  const kind = status === 400 || status === 401 || status === 403 ? 'auth' : 'upstream';
  return new InstagramError(message, { kind, status });
}

/** Read a JSON body, throwing a mapped error on a non-2xx response. */
async function readJsonOrThrow(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text();
  let parsed: unknown = {};
  if (raw !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // EQUIVALENT-MUTANT NOTE: writing `{}` here instead of `raw` cannot be
      // observed. Both consumers funnel the value through `toRecord`, and
      // `toRecord` of a string is `{}` — the error path reads
      // `toRecord(toRecord(parsed).error)` and the success path `toRecord(parsed)`,
      // so a non-JSON body already contributes nothing either way. Keeping `raw`
      // is deliberate: it is the only thing that would let a future reader of
      // this value see what actually arrived. There is no behaviour to assert,
      // so do not contort a test into 'killing' it.
      parsed = raw;
    }
  }
  if (!res.ok) throw exchangeError(res.status, parsed);
  return toRecord(parsed);
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<Record<string, unknown>> {
  return readJsonOrThrow(await fetchFn(url, { method: 'GET' }));
}

async function postForm(
  fetchFn: typeof fetch,
  url: string,
  body: URLSearchParams,
): Promise<Record<string, unknown>> {
  return readJsonOrThrow(
    await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }),
  );
}

/**
 * Exchange an authorization `code` for a short-lived token.
 *  - `ig-login`: POST api.instagram.com/oauth/access_token (form body).
 *  - `fb-login`: GET graph.facebook.com/<v>/oauth/access_token (query).
 */
export async function exchangeCodeForToken(
  path: AuthPath,
  params: CodeExchangeParams,
  fetchFn: typeof fetch = fetch,
): Promise<ShortLivedToken> {
  if (path === 'ig-login') {
    const body = new URLSearchParams({
      client_id: params.appId,
      client_secret: params.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: params.redirectUri,
      code: params.code,
    });
    const json = await postForm(fetchFn, IG_TOKEN_URL, body);
    return { accessToken: requireToken(json), userId: strOrUndef(json.user_id) };
  }

  const query = new URLSearchParams({
    client_id: params.appId,
    client_secret: params.appSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
  });
  const json = await getJson(
    fetchFn,
    `${FB_GRAPH_BASE}/${GRAPH_VERSION}/oauth/access_token?${query.toString()}`,
  );
  return { accessToken: requireToken(json), expiresInSec: numOrUndef(json.expires_in) };
}

/**
 * Exchange a short-lived token for a long-lived one.
 *  - `ig-login`: GET graph.instagram.com/access_token?grant_type=ig_exchange_token.
 *  - `fb-login`: GET graph.facebook.com/<v>/oauth/access_token?grant_type=fb_exchange_token.
 */
export async function exchangeForLongLivedToken(
  path: AuthPath,
  params: LongLivedExchangeParams,
  fetchFn: typeof fetch = fetch,
): Promise<LongLivedToken> {
  if (path === 'ig-login') {
    const query = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: params.appSecret,
      access_token: params.shortToken,
    });
    const json = await getJson(fetchFn, `${IG_GRAPH_BASE}/access_token?${query.toString()}`);
    return { accessToken: requireToken(json), expiresInSec: numOrUndef(json.expires_in) };
  }

  const query = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: params.appId,
    client_secret: params.appSecret,
    fb_exchange_token: params.shortToken,
  });
  const json = await getJson(
    fetchFn,
    `${FB_GRAPH_BASE}/${GRAPH_VERSION}/oauth/access_token?${query.toString()}`,
  );
  return { accessToken: requireToken(json), expiresInSec: numOrUndef(json.expires_in) };
}

/**
 * Absolute token expiry (Unix seconds) from an exchange's `expires_in` and the
 * current time. `undefined` in ⇒ `undefined` (unknown); a non-positive lifetime
 * ⇒ `0` ("never expires") — matching `debug_token`/`summarizeTokenExpiry`.
 */
export function computeExpiresAtSec(
  expiresInSec: number | undefined,
  nowMs: number,
): number | undefined {
  if (expiresInSec === undefined) return undefined;
  if (expiresInSec <= 0) return 0;
  return Math.floor(nowMs / 1000) + Math.floor(expiresInSec);
}

// --- Loopback capture of the authorization code -----------------------------

/** The subset of a `node:http` request this module reads. */
export interface CallbackRequest {
  url?: string | undefined;
}

/** The subset of a `node:http` response this module drives. */
export interface CallbackResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** The subset of a `node:http` server this module drives. */
export interface CallbackServer {
  listen(port: number, host: string): void;
  close(): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

/** Server factory seam — `node:http` in production, a fake (no socket) in tests. */
export type CreateCallbackServer = (
  handler: (req: CallbackRequest, res: CallbackResponse) => void,
) => CallbackServer;

const defaultCreateServer: CreateCallbackServer = (handler) =>
  createServer((req, res) => {
    handler(req, res);
  });

/** What the listener should do with one inbound request. */
export type CallbackOutcome =
  | { kind: 'ignore'; status: number; body: string }
  | { kind: 'code'; code: string; status: number; body: string }
  | { kind: 'denied'; status: number; body: string; reason: string }
  | { kind: 'state-mismatch'; status: number; body: string };

/**
 * Decide what an inbound loopback request means. Pure, so the routing rules are
 * testable without a socket.
 *
 * The **path check** is load-bearing: anything on this port that is not the
 * redirect path (a stray `GET /`, a probe, a favicon fetch that inherited the
 * query string) is answered 404 and ignored, so it can neither resolve the
 * capture with a bogus `code` nor abort a login that is still in flight.
 */
export function classifyCallbackRequest(params: {
  requestUrl: string | undefined;
  expectedPath: string;
  state: string;
}): CallbackOutcome {
  // The base is only a parsing anchor — a loopback listener has no other origin.
  const url = new URL(params.requestUrl ?? '/', `http://${LOOPBACK_IPV4}`);
  if (url.pathname !== params.expectedPath) {
    return { kind: 'ignore', status: 404, body: 'Not found.' };
  }

  const error = url.searchParams.get('error');
  if (error !== null) {
    return {
      kind: 'denied',
      status: 400,
      body: 'Authorization failed. You may close this window.',
      reason: url.searchParams.get('error_description') ?? error,
    };
  }

  const code = url.searchParams.get('code');
  if (code === null) {
    return { kind: 'ignore', status: 400, body: 'Missing authorization code.' };
  }
  if (url.searchParams.get('state') !== params.state) {
    return { kind: 'state-mismatch', status: 400, body: 'State mismatch — request rejected.' };
  }
  return {
    kind: 'code',
    code,
    status: 200,
    body: 'Login complete. You may close this window and return to the terminal.',
  };
}

/**
 * The address to bind for a redirect URI. Only loopback is accepted: binding a
 * routable interface would expose the authorization-code catcher to the network.
 * `localhost` is normalized to {@link LOOPBACK_IPV4} — Node would resolve it and
 * bind whichever family DNS returns first, which is precisely the mismatch this
 * CLI must avoid (see {@link DEFAULT_REDIRECT_URI}).
 */
export function listenHostFor(redirectUri: string): string {
  const hostname = new URL(redirectUri).hostname.toLowerCase();
  if (hostname === LOOPBACK_IPV4 || hostname === 'localhost') return LOOPBACK_IPV4;
  // The WHATWG URL parser keeps IPv6 hosts bracketed; `listen` wants them bare.
  if (hostname === `[${LOOPBACK_IPV6}]` || hostname === LOOPBACK_IPV6) return LOOPBACK_IPV6;
  throw new InstagramError(
    `login can only capture the OAuth redirect on loopback, but --redirect-uri points at "${hostname}". ` +
      `Use ${DEFAULT_REDIRECT_URI} (and register it in your Meta app), or capture the code yourself.`,
    { kind: 'validation' },
  );
}

/** Injectable collaborators for {@link captureAuthorizationCode}. */
export interface CaptureDeps {
  /** Server factory. Defaults to `node:http`; tests inject a socket-free fake. */
  createServerImpl?: CreateCallbackServer;
  /** Clock the timeout runs on. Defaults to the system clock. */
  clock?: Clock;
  /** Absolute wait budget. Defaults to {@link CAPTURE_TIMEOUT_MS} (5 minutes). */
  timeoutMs?: number;
}

/**
 * Bind a loopback HTTP server on the redirect URI's port and resolve with the
 * `code` once the browser is redirected back.
 *
 * Guarantees: it binds the address the redirect URI names (loopback only), only
 * requests on the redirect **path** are considered, the OAuth `state` must
 * match, and the wait is bounded by `timeoutMs` — after which the listener is
 * closed and the promise rejects with a message naming the likely causes. The
 * server is closed on every exit path.
 */
export function captureAuthorizationCode(
  params: { redirectUri: string; state: string },
  deps: CaptureDeps = {},
): Promise<string> {
  const url = new URL(params.redirectUri);
  const port = url.port !== '' ? Number(url.port) : DEFAULT_REDIRECT_PORT;
  /* c8 ignore start -- the `'/'` arm is unreachable through this function: the
     WHATWG parser normalises an empty path to `/` for every special scheme, and
     `listenHostFor` below rejects anything that is not loopback http. It stays
     because an empty `expectedPath` would make the route match nothing at all. */
  const expectedPath = url.pathname === '' ? '/' : url.pathname;
  /* c8 ignore stop */
  const clock = deps.clock ?? systemClock;
  const timeoutMs = deps.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const createServerImpl = deps.createServerImpl ?? defaultCreateServer;

  let listenHost: string;
  try {
    listenHost = listenHostFor(params.redirectUri);
  } catch (err) {
    /* c8 ignore start -- the `new Error(String(err))` arm is defensive: the only
       thrower here is `listenHostFor`, which raises an `InstagramError`. It exists
       because `catch` is typed `unknown`, and rejecting with a bare value would
       give `runLogin`'s handler nothing to print. */
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    /* c8 ignore stop */
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    // Aborting cancels the pending timeout sleep (and clears its timer, so a
    // successful login does not hold the event loop open for five minutes).
    const finished = new AbortController();

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      finished.abort();
      server.close();
      action();
    };

    const server = createServerImpl((req, res) => {
      const outcome = classifyCallbackRequest({
        requestUrl: req.url,
        expectedPath,
        state: params.state,
      });
      res.writeHead(outcome.status, { 'content-type': 'text/plain' });
      res.end(outcome.body);

      switch (outcome.kind) {
        case 'ignore':
          return; // Not the redirect — keep waiting.
        case 'code':
          settle(() => resolve(outcome.code));
          return;
        case 'denied':
          settle(() =>
            reject(
              new InstagramError(`Authorization was denied: ${outcome.reason}`, {
                kind: 'auth',
              }),
            ),
          );
          return;
        case 'state-mismatch':
          settle(() =>
            reject(new InstagramError('OAuth state mismatch — aborting.', { kind: 'auth' })),
          );
          return;
      }
    });

    server.on('error', (err) => {
      settle(() =>
        reject(
          new InstagramError(
            `Could not listen on ${listenHost}:${port} for the OAuth redirect (${err.message}). ` +
              'Another login may be running, or the port is taken — pass --redirect-uri with a free ' +
              'port that is also registered in your Meta app.',
            { kind: 'validation', cause: err },
          ),
        ),
      );
    });

    server.listen(port, listenHost);

    void clock.sleep(timeoutMs, finished.signal).then(
      () => {
        settle(() =>
          reject(
            new InstagramError(
              `Timed out after ${Math.round(timeoutMs / 60_000)} minute(s) waiting for the OAuth ` +
                `redirect to ${params.redirectUri}. Check that this EXACT URI is registered in your ` +
                'Meta app (App settings -> Instagram/Facebook Login -> Valid OAuth Redirect URIs), ' +
                'that you completed the browser prompt, and that the redirect URI host matches the ' +
                `address this listener bound (${listenHost}) — a URI spelled "localhost" can resolve ` +
                'to ::1 and never reach it.',
              { kind: 'upstream' },
            ),
          ),
        );
      },
      () => {
        // Aborted because the capture already settled — nothing to do.
      },
    );
  });
}

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

interface LoginOptions {
  path?: AuthPath;
  profile: string;
  appId?: string;
  appSecret?: string;
  redirectUri: string;
  accountId?: string;
  scopes?: string[];
  help: boolean;
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

A live login requires a REGISTERED META APP: the app id/secret above and a
redirect URI whitelisted in the app's OAuth settings. Meta matches redirect URIs
literally, so the value above must be registered VERBATIM under
"Valid OAuth Redirect URIs" — "127.0.0.1" and "localhost" are different entries,
and only the loopback address is bound here. Without those it cannot run — there
is no offline login. The token is written to the XDG/APPDATA env file
(chmod 0600 on POSIX) and is never printed.
`;

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

/** Parse argv (with env fallbacks) into resolved {@link LoginOptions}. */
function parseArgs(argv: string[], env: NodeJS.ProcessEnv): LoginOptions {
  const opts: LoginOptions = {
    profile: DEFAULT_PROFILE_NAME,
    redirectUri: DEFAULT_REDIRECT_URI,
    help: false,
    appId: clean(env.IG_APP_ID),
    appSecret: clean(env.IG_APP_SECRET),
    accountId: clean(env.IG_ACCOUNT_ID),
    path: normalizePath(clean(env.IG_AUTH_PATH) ?? clean(env.IG_AUTH_MODE)),
  };

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
        opts.help = true;
        break;
      case '-p':
      case '--path':
        opts.path = normalizePath(value());
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
        break;
      case '--scopes': {
        const v = clean(value());
        if (v !== undefined) {
          opts.scopes = v
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '');
        }
        break;
      }
      default:
        // A bare positional token may name the path (`login ig`).
        if (!arg.startsWith('-') && opts.path === undefined) opts.path = normalizePath(arg);
        break;
    }
  }
  return opts;
}

/** Human-readable, token-free expiry line for the success message. */
function expiryLine(expiresAtSec: number | undefined): string {
  if (expiresAtSec === undefined) return 'Token expiry: unknown (no lifetime returned).\n';
  if (expiresAtSec === 0) return 'Token expiry: never.\n';
  return `Token expires at ${new Date(expiresAtSec * 1000).toISOString()}.\n`;
}

/**
 * Run the `login` subcommand end-to-end and return a process exit code
 * (`0` success, `2` bad usage, `1` runtime failure). All output goes to stderr;
 * no token or secret value is ever printed.
 */
export async function runLogin(argv: string[], deps: LoginDeps = {}): Promise<number> {
  const stderr = deps.stderr ?? ((msg: string) => void process.stderr.write(msg));
  const env = deps.env ?? process.env;
  const opts = parseArgs(argv, env);

  if (opts.help) {
    stderr(HELP_TEXT);
    return 0;
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

    const short = await exchangeCodeForToken(
      path,
      { code, appId, appSecret, redirectUri },
      fetchFn,
    );
    const long = await exchangeForLongLivedToken(
      path,
      { shortToken: short.accessToken, appId, appSecret },
      fetchFn,
    );
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
    stderr(expiryLine(expiresAtSec));
    return 0;
  } catch (err) {
    // Only the message is surfaced (never a URL — the query carries secrets).
    const message = err instanceof Error ? err.message : String(err);
    stderr(`login failed: ${message}\n`);
    return 1;
  }
}
