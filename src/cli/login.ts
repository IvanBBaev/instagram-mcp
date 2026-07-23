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
 * exchanges (against an injected `fetch`), the expiry math, and persistence via
 * {@link writeCredentials}. The loopback redirect capture is a thin, best-effort
 * helper and is not part of the tested surface.
 *
 * The OAuth token endpoints (api.instagram.com, graph.*) are addressed here with
 * an injected `fetch`, deliberately outside the runtime SSRF allowlist in
 * `core/host.ts` (that gate governs model-driven Graph calls, not this operator
 * CLI). No token or secret value is ever written to stdout/stderr.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

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

/** Loopback redirect used to capture the authorization `code` (127.0.0.1). */
const DEFAULT_REDIRECT_PORT = 8723;
const DEFAULT_REDIRECT_URI = `http://localhost:${DEFAULT_REDIRECT_PORT}/callback`;

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

// --- Best-effort loopback capture (not part of the tested surface) ----------

/**
 * Bind a loopback HTTP server to the redirect URI's port and resolve with the
 * `code` once the browser is redirected back. Best-effort: it validates the
 * `state` and closes on the first matching request. Injected out in tests.
 */
function captureAuthorizationCode(params: { redirectUri: string; state: string }): Promise<string> {
  const url = new URL(params.redirectUri);
  const port = url.port !== '' ? Number(url.port) : DEFAULT_REDIRECT_PORT;

  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const error = reqUrl.searchParams.get('error');

      if (error !== null) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Authorization failed. You may close this window.');
        server.close();
        reject(new InstagramError(`Authorization was denied: ${error}`, { kind: 'auth' }));
        return;
      }
      if (code !== null) {
        const ok = state === params.state;
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' });
        res.end(
          ok
            ? 'Login complete. You may close this window and return to the terminal.'
            : 'State mismatch — request rejected.',
        );
        server.close();
        if (ok) resolve(code);
        else reject(new InstagramError('OAuth state mismatch — aborting.', { kind: 'auth' }));
        return;
      }
      // Unrelated request (e.g. favicon) — acknowledge without resolving.
      res.writeHead(204);
      res.end();
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
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
redirect URI whitelisted in the app's OAuth settings. Without those it cannot
run — there is no offline login. The token is written to the XDG/APPDATA env
file (chmod 0600 on POSIX) and is never printed.
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

    const capture = deps.captureCode ?? ((p) => captureAuthorizationCode(p));
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
