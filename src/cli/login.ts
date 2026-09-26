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

import { MAX_RESPONSE_BYTES, readCappedText } from '../core/body.js';
import { systemClock } from '../core/clock.js';
import type { Clock } from '../core/clock.js';
import { GRAPH_VERSION } from '../core/host.js';
import { expiryFromLifetime, lifetimeFromWire } from '../core/time.js';
import { DEFAULT_PROFILE_NAME } from '../core/config.js';
import { MAX_GRAPH_MESSAGE_LENGTH, toInstagramError } from '../core/errors.js';
import { createRedactor } from '../core/redact.js';
import { surfaceForms } from '../core/refresh.js';
import { InstagramError } from '../core/types.js';
import type { AuthPath } from '../core/types.js';
import { quoteUntrusted, visibleText } from '../core/untrusted.js';
import { DEFAULT_SCOPES } from './scopes.js';
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

/**
 * An id field as a string, or `undefined` when there is none to trust.
 *
 * A number is re-stringified only while it is a safe integer. IDs in this family
 * are 17 digits — past 2^53, where `JSON.parse` has already rounded the literal
 * to the nearest double before this function sees it. `String()` of that double
 * is a DIFFERENT id (`17841400008765431` arrives as `…432`), and `runLogin`
 * persists it as the profile's account id: every later call would address an
 * account the operator never named, and nothing would say why (CC-AUTH-60).
 * Absent is the honest answer — Path A then addresses `me`, and `--account-id`
 * still sets it explicitly.
 */
function strOrUndef(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/**
 * The Instagram-Login code exchange (api.instagram.com) has been documented in
 * two shapes: the flat `{access_token, user_id, permissions}` and the same record
 * wrapped as `{data: [{...}]}`. Exactly one wrapped entry is unwrapped; anything
 * that could name two different tokens or accounts — several entries, or a
 * top-level `access_token` beside a `data` entry — is refused rather than
 * guessed, since picking one would persist a credential the operator may not
 * have authorized. An empty or absent `data` leaves the body as it came, so a
 * body with no token still fails as "did not include an access_token".
 */
function unwrapIgCodeExchange(json: Record<string, unknown>): Record<string, unknown> {
  const data = json.data;
  if (!Array.isArray(data) || data.length === 0) return json;
  if (data.length > 1 || json.access_token !== undefined) {
    const why =
      data.length > 1
        ? `data holds ${data.length} entries`
        : 'it carries an access_token both at the top level and inside data';
    throw new InstagramError(
      `Instagram code exchange response is ambiguous: ${why}; expected exactly one. ` +
        'Nothing was stored; run login again.',
      { kind: 'upstream' },
    );
  }
  return toRecord(data[0]);
}

/**
 * Read `access_token` from an exchange body, or throw an auth error.
 *
 * Blank-aware, like `isNonBlank` in `core/refresh.ts` (CC-AUTH-75): a
 * whitespace-only token used to pass the `=== ''` test, so a short token of
 * spaces was sent on to the long-lived exchange beside the app secret, and a
 * long one reached `writeCredentials`, whose "an access token is required"
 * blamed the local call for Meta's reply. Refused, never trimmed: a padded
 * token that has a value is kept verbatim, as `refresh` keeps it.
 */
function requireToken(json: Record<string, unknown>): string {
  const token = json.access_token;
  if (typeof token !== 'string' || token.trim() === '') {
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
 *
 * Meta's message is untrusted text on its way to the operator's terminal as the
 * `login failed:` line, so it is bounded and defused exactly as `mapGraphError`
 * bounds the same field (CC-DATA-93): cut at {@link MAX_GRAPH_MESSAGE_LENGTH}
 * code points between words, controls and separators escaped. Before that a
 * newline in it printed a second, forged line under `login failed:`. It is not
 * token-stripped here — the `runLogin` catch redacts the finished message with
 * every secret this run holds — which is exactly why the cut is word-safe: a
 * cut through the app secret would leave a prefix that redactor cannot match.
 */
function exchangeError(status: number, body: unknown): InstagramError {
  const err = toRecord(toRecord(body).error);
  // A message of only whitespace, zero-width or bidi characters says nothing,
  // and escaped it printed as a row of `\u{…}` in place of the status line that
  // does say something (CC-DATA-96).
  const text = visibleText(err.message);
  const message =
    text !== undefined
      ? quoteUntrusted(text, MAX_GRAPH_MESSAGE_LENGTH, undefined, { wordSafe: true })
      : `OAuth token exchange failed (HTTP ${status}).`;
  const kind = status === 400 || status === 401 || status === 403 ? 'auth' : 'upstream';
  return new InstagramError(message, { kind, status });
}

/**
 * The refusal for an exchange reply over {@link MAX_RESPONSE_BYTES}
 * (CC-PROC-203). `readJsonOrThrow` called `res.text()` until 2026-09-24, so a
 * proxy or captive portal answering a token endpoint with an endless stream was
 * buffered whole while the operator watched a login that never finished.
 *
 * Always `upstream` with the status, never `auth` — even on a 400/401/403, where
 * {@link exchangeError} would say `auth`. That mapping reads Meta's verdict out
 * of the body, and a body this size was never read, so there is no verdict to
 * report; `auth` would send the operator to re-check an app secret that may be
 * fine. The message quotes nothing from the body: a token reply is exactly the
 * body that can carry a token, and `runLogin` prints this message to stderr.
 */
function exchangeTooLarge(status: number, seen: string): InstagramError {
  return new InstagramError(
    `OAuth token exchange response body is larger than the ${MAX_RESPONSE_BYTES / (1024 * 1024)} ` +
      `MiB this server buffers (${seen}); it was discarded unread. A token reply is a few ` +
      'hundred bytes, so check what any proxy between this machine and Meta is returning.',
    { kind: 'upstream', status },
  );
}

/**
 * Read a JSON body, throwing a mapped error on a non-2xx response. Bounded by
 * {@link MAX_RESPONSE_BYTES}, like every other reader of a Meta body.
 */
async function readJsonOrThrow(res: Response): Promise<Record<string, unknown>> {
  const raw = await readCappedText(res, exchangeTooLarge);
  let parsed: unknown = {};
  // Equivalent-mutant note: dropping this `raw !== ''` test is unobservable too.
  // An empty body would then reach `JSON.parse('')`, which throws, so the catch
  // below sets `parsed = ''` — and `toRecord('')` is `{}`, exactly the initial
  // value. The guard stays because "an empty body is not a parse failure" is the
  // true statement about the wire, and routing it through an exception to arrive
  // at the same place would make the next reader hunt for a difference.
  if (raw !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Equivalent-mutant note: writing `{}` here instead of `raw` cannot be
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

/**
 * Per-request budget for each token exchange: the same 30 s `refresh` gives its
 * exchange (`EXCHANGE_TIMEOUT_MS` in `core/refresh.ts`) and the Graph seam its
 * requests. Without it an endpoint that accepts the connection and never
 * answers parks `login` forever after the browser step, with the one-time code
 * already spent (CC-AUTH-72). The timeout also governs the body read.
 */
export const LOGIN_EXCHANGE_TIMEOUT_MS = 30_000;

/**
 * Both helpers refuse redirects (CC-AUTH-73). A 3xx from a token endpoint has
 * no legitimate meaning, and following one would replay the credentials: a
 * 307/308 on the ig-login POST re-sends the form body (`client_secret` and the
 * code) to whatever host `Location` names, and a GET redirect carries the secret
 * in its query. `refresh` refuses redirects for the same reason.
 */
async function getJson(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return sendExchange(fetchFn, url, { method: 'GET' }, timeoutMs);
}

async function postForm(
  fetchFn: typeof fetch,
  url: string,
  body: URLSearchParams,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return sendExchange(
    fetchFn,
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    timeoutMs,
  );
}

/**
 * The one transport both helpers share. Every failure leaves as an
 * {@link InstagramError} (CC-AUTH-74): a transport fault, a refused redirect
 * and the {@link LOGIN_EXCHANGE_TIMEOUT_MS} abort (a `DOMException`
 * `TimeoutError`, from the fetch or from the body read) used to escape raw, so
 * the exported exchanges broke their typed contract exactly where `refresh` and
 * the Graph seam wrap the same failures with `toInstagramError` (`upstream`,
 * original on `cause`). A mapped Graph error passes through unchanged.
 */
async function sendExchange(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  try {
    return await readJsonOrThrow(
      await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }),
    );
  } catch (err) {
    throw toInstagramError(err);
  }
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
  timeoutMs: number = LOGIN_EXCHANGE_TIMEOUT_MS,
): Promise<ShortLivedToken> {
  if (path === 'ig-login') {
    const body = new URLSearchParams({
      client_id: params.appId,
      client_secret: params.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: params.redirectUri,
      code: params.code,
    });
    const json = unwrapIgCodeExchange(await postForm(fetchFn, IG_TOKEN_URL, body, timeoutMs));
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
    timeoutMs,
  );
  return {
    accessToken: requireToken(json),
    expiresInSec: numOrUndef(lifetimeFromWire(json.expires_in)),
  };
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
  timeoutMs: number = LOGIN_EXCHANGE_TIMEOUT_MS,
): Promise<LongLivedToken> {
  if (path === 'ig-login') {
    const query = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: params.appSecret,
      access_token: params.shortToken,
    });
    const json = await getJson(
      fetchFn,
      `${IG_GRAPH_BASE}/access_token?${query.toString()}`,
      timeoutMs,
    );
    return {
      accessToken: requireToken(json),
      expiresInSec: numOrUndef(lifetimeFromWire(json.expires_in)),
    };
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
    timeoutMs,
  );
  return {
    accessToken: requireToken(json),
    expiresInSec: numOrUndef(lifetimeFromWire(json.expires_in)),
  };
}

/**
 * Absolute token expiry (Unix seconds) from an exchange's `expires_in` and the
 * current time — `expiryFromLifetime` (`core/time.ts`), the one reading
 * `refresh` shares (CC-AUTH-64):
 *
 *  - `undefined` in ⇒ `undefined` (unknown).
 *  - Exactly `0` ⇒ `0` ("never expires") — the `debug_token` convention.
 *  - A NEGATIVE lifetime is a past instant — not `0`. Mapping it to "never"
 *    stored a token the upstream had just called expired as immortal,
 *    silencing every later expiry warning.
 *  - A sum that is not a recordable instant (at or before the epoch, or past
 *    9999-12-31, `1e300` included) ⇒ `undefined`: it is not persisted, so the
 *    store never carries a value its own reader rejects.
 */
export function computeExpiresAtSec(
  expiresInSec: number | undefined,
  nowMs: number,
): number | undefined {
  return expiryFromLifetime(expiresInSec, nowMs);
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
 * The reason a denied authorization gives, as the `Authorization was denied:`
 * line may print it (CC-DATA-100).
 *
 * Both parameters arrive in the redirect's query string, which anything able to
 * reach the loopback port can write — and the line goes to the operator's
 * terminal. Until 2026-09-24 the value was printed as received: a `%0A` in
 * `error_description` forged a second line under the refusal, an ANSI escape
 * repainted the terminal, and the length was bounded only by the URL. It is now
 * cut and escaped by the rule Graph error text follows, word-safe
 * because the `runLogin` catch redacts the finished message downstream
 * (see `QuoteOptions.wordSafe`). A description with nothing visible in it falls back to the
 * `error` code, and a blank code to a fixed phrase, so the line never ends in
 * nothing.
 */
function deniedReason(query: URLSearchParams): string {
  const reason =
    visibleText(query.get('error_description')) ??
    visibleText(query.get('error')) ??
    'no reason given';
  return quoteUntrusted(reason, MAX_GRAPH_MESSAGE_LENGTH, undefined, { wordSafe: true });
}

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
  //
  // Equivalent-mutant note: spelling the fallback `''` instead of `'/'` survives,
  // because `new URL('', base)` resolves to the base and its path normalises to
  // `/` for a special scheme. `'/'` stays because it says what an absent
  // `req.url` should be treated as; `''` says only "resolve the base again".
  const url = new URL(params.requestUrl ?? '/', `http://${LOOPBACK_IPV4}`);
  if (url.pathname !== params.expectedPath) {
    return { kind: 'ignore', status: 404, body: 'Not found.' };
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  // What the request CLAIMS to be, decided before deciding whether to believe
  // it. Splitting the two halves is the whole point: the denial used to be
  // ANSWERED here, above the state comparison, so a forged `?error=` ended the
  // capture without ever being asked for the secret (CC-PROC-174).
  const claim: CallbackOutcome | null =
    error !== null
      ? {
          kind: 'denied',
          status: 400,
          body: 'Authorization failed. You may close this window.',
          reason: deniedReason(url.searchParams),
        }
      : code !== null
        ? {
            kind: 'code',
            code,
            status: 200,
            body: 'Login complete. You may close this window and return to the terminal.',
          }
        : null;

  // Carrying neither parameter makes this no authorization response at all — a
  // reloaded tab, a prefetch, a probe. Those keep the listener waiting, which
  // also keeps the gate below from seeing anything but a request claiming to BE
  // the redirect: an operator refreshing the page must not abort their own login.
  if (claim === null) {
    return { kind: 'ignore', status: 400, body: 'Missing authorization code.' };
  }
  // `get` returns the FIRST occurrence, which is what makes a repeated
  // `&state=`/`&code=` appended by a third party unable to decide the comparison.
  //
  // NOT an equivalence, measured 2026-09-23: `!=` here is KILLED, and by the one
  // test this note used to cite as merely pinning its premise. The note claimed
  // the two spellings cannot be told apart, and that claim was an argument about
  // the signature rather than about the suite. By the declared type it holds:
  // the left side is `string | null`, `params.state` is a `string`, and `==`
  // differs from `===` across that pair only when both sides are nullish, which
  // a `string` right side excludes. But "classifyCallbackRequest rejects a
  // callback when the expected state is itself absent" deliberately steps
  // outside the signature — it passes `state: undefined`, which is what a
  // JavaScript caller, or a future optional `state`, actually produces. There
  // `get('state')` is `null`, `null != undefined` is `false`, and the `!=`
  // spelling ANSWERS `code`: it hands the authorization code to a forged
  // callback. This is the CSRF check, the strict comparison is load-bearing,
  // and the suite proves it rather than the type merely implying it.
  //
  // The gate stands in front of BOTH answers, the denial included. RFC 6749
  // §4.1.2.1 requires the authorization server to echo `state` on the ERROR
  // redirect too whenever the request carried one, and this client always sends
  // one — so a denial that arrives without it did not come from Meta, and
  // reporting it to the operator as their own refusal sends them to look at the
  // one place that cannot explain it (CC-PROC-174).
  if (url.searchParams.get('state') !== params.state) {
    return { kind: 'state-mismatch', status: 400, body: 'State mismatch — request rejected.' };
  }
  return claim;
}

/**
 * The address to bind for a redirect URI. This is an accept-list of the two
 * addresses the capture server actually binds — {@link LOOPBACK_IPV4} and
 * {@link LOOPBACK_IPV6} — plus `localhost` as a spelling of the first; binding a
 * routable interface would expose the authorization-code catcher to the network.
 *
 * It is deliberately NARROWER than “loopback”, and the refusal message says so.
 * `127.0.0.2` (all of 127/8 is loopback), the rooted `localhost.` and
 * `[::ffff:127.0.0.1]` are loopback addresses that this function refuses, so a
 * message phrased as “not loopback” would be false for them — and false in the
 * one direction that matters, telling an operator who did the right thing that
 * they did the wrong thing.
 *
 * `localhost` is normalized to {@link LOOPBACK_IPV4} — Node would resolve it and
 * bind whichever family DNS returns first, which is precisely the mismatch this
 * CLI must avoid (see {@link DEFAULT_REDIRECT_URI}).
 */
export function listenHostFor(redirectUri: string): string {
  // NOT redundant, though it was recorded as such until 2026-09-23. The WHATWG
  // parser ASCII-lowercases the host of every SPECIAL scheme, so
  // `new URL('http://LOCALHOST/').hostname` is indeed `'localhost'` — but nothing
  // confines this function to a special scheme, and the parser leaves the host of
  // `foo://LOCALHOST:8723/callback` exactly as typed. Drop the call and that URI
  // stops being loopback, so `login` refuses to bind. Pinned by "listenHostFor
  // lowercases the host itself, for the schemes the parser will not". The
  // case-insensitivity of a host is a property of DNS, not of this parser, and the
  // comparisons below are the security boundary — they must not depend on which
  // scheme the input happened to use.
  const hostname = new URL(redirectUri).hostname.toLowerCase();
  if (hostname === LOOPBACK_IPV4 || hostname === 'localhost') return LOOPBACK_IPV4;
  // The WHATWG URL parser keeps IPv6 hosts bracketed; `listen` wants them bare.
  //
  // Equivalent-mutant note: the second half — the BARE `::1` — is unreachable
  // through this function, so dropping it survives. A bare IPv6 host does not
  // parse at all (`new URL('http://::1:8723/')` throws), and every spelling that
  // does parse comes back bracketed and compressed (`[::0:1]` and
  // `[0:0:0:0:0:0:0:1]` both normalise to `[::1]`). It stays because
  // `listenHostFor` is exported and its contract is "an address this CLI binds",
  // not "the output of `URL.hostname`" — a caller handing it an address from
  // `listen` itself, where bare is the spelling, must not be refused the very
  // value this function returns.
  if (hostname === `[${LOOPBACK_IPV6}]` || hostname === LOOPBACK_IPV6) return LOOPBACK_IPV6;
  throw new InstagramError(
    `login can only capture the OAuth redirect on ${LOOPBACK_IPV4} or [${LOOPBACK_IPV6}], ` +
      `but --redirect-uri points at "${hostname}". ` +
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
 * requests on the redirect **path** are considered, the OAuth `state` must match
 * before ANY answer is honoured — a denial included, because the authorization
 * server echoes `state` on the error redirect too — and the wait is bounded by
 * `timeoutMs` — after which the listener is
 * closed and the promise rejects with a message naming the likely causes. The
 * server is closed on every exit path.
 */
export function captureAuthorizationCode(
  params: { redirectUri: string; state: string },
  deps: CaptureDeps = {},
): Promise<string> {
  const url = new URL(params.redirectUri);
  const port = url.port !== '' ? Number(url.port) : DEFAULT_REDIRECT_PORT;
  // The `'/'` arm is reached by a redirect URI whose scheme is not special:
  // the WHATWG parser normalises an empty path to `/` only for special schemes,
  // `listenHostFor` below checks the HOST and not the scheme, and nothing between
  // `--redirect-uri` and this line checks it either. Pinned by
  // "captureAuthorizationCode routes a pathless redirect URI to the root path" —
  // it was marked unreachable and coverage-excluded until 2026-09-23. Without the
  // arm an empty `expectedPath` would make the route match nothing at all.
  const expectedPath = url.pathname === '' ? '/' : url.pathname;
  const clock = deps.clock ?? systemClock;
  const timeoutMs = deps.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const createServerImpl = deps.createServerImpl ?? defaultCreateServer;

  let listenHost: string;
  try {
    listenHost = listenHostFor(params.redirectUri);
  } catch (err) {
    // The `new Error(String(err))` arm is unreachable, and until 2026-09-23 this
    // comment named the wrong reason for it. `listenHostFor` does not only raise
    // `InstagramError`: it re-parses the URI with `new URL`, which raises a
    // `TypeError` for a string that does not parse. What rules that out here is
    // the `new URL(params.redirectUri)` above — it parsed the same string before
    // this try block was entered, so the re-parse cannot fail. Either thrower is
    // an `Error` in any case. The arm exists because `catch` is typed `unknown`,
    // and rejecting with a bare value would give `runLogin`'s handler nothing to
    // print. The ignore covers the arm, not the `return` (CC-PROC-128).
    return Promise.reject(
      /* c8 ignore next */
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    // Aborting cancels the pending timeout sleep (and clears its timer, so a
    // successful login does not hold the event loop open for five minutes).
    const finished = new AbortController();

    // Equivalent-mutant note: moving `action()` above `server.close()` survives
    // the suite, and genuinely cannot be observed — `action` only settles this
    // promise, whose continuations run in a later microtask, so the close still
    // happens first in real time either way. The order stays as written because
    // it is the one that is true under a future `action` that does more than
    // settle: release the socket, then hand control away.
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
interface UnknownArgument {
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
 * The profile names the credentials file can be read back under: dotenv parses
 * only keys made of `[\w.-]`, so `IG_PROFILE_<NAME>_*` with any other character
 * in `<NAME>` is written by `login` and then silently dropped on load.
 */
const PROFILE_NAME = /^[a-z0-9_.-]+$/;

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
function unknownArgumentLine({ unknownArgument, hint, after }: UnknownArgument): string {
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
  return `login: unknown argument '${unknownArgument}'${suffix}.`;
}

/**
 * Parse argv (with env fallbacks) into resolved {@link LoginOptions}, or stop
 * at the first token the parser does not recognise ({@link UnknownArgument}).
 */
function parseArgs(argv: string[], env: NodeJS.ProcessEnv): LoginOptions | UnknownArgument {
  const opts: LoginOptions = {
    profile: DEFAULT_PROFILE_NAME,
    redirectUri: DEFAULT_REDIRECT_URI,
    help: false,
    appId: clean(env.IG_APP_ID),
    appSecret: clean(env.IG_APP_SECRET),
    accountId: clean(env.IG_ACCOUNT_ID),
    path: normalizePath(clean(env.IG_AUTH_PATH) ?? clean(env.IG_AUTH_MODE)),
  };
  // Whether the command line has named the path yet — by `--path`/`-p` (well
  // or badly spelled) or by the one bare positional. The env value above is a
  // default, not a spelling on the line, so it does not count: with
  // `IG_AUTH_PATH=fb` in an MCP client's config, `login ig` is one explicit
  // request, not a second one, and it wins over the default exactly as
  // `--path ig` does.
  let pathOnArgv = false;

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
        // carrying the secret. Every other token is echoed whole; it is an
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
  return opts;
}

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
