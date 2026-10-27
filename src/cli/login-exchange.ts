/**
 * The OAuth half of the `login` CLI subcommand that talks to Meta: the browser
 * authorization URL and the two token exchanges, for BOTH auth paths
 * (docs/auth.md §1). Each function branches on the path, so Path A
 * (`ig-login`: api.instagram.com, then graph.instagram.com) and Path B
 * (`fb-login`: graph.facebook.com twice) live side by side here:
 *
 *  - {@link buildAuthorizeUrl} — the www.instagram.com / www.facebook.com prompt.
 *  - {@link exchangeCodeForToken} — the authorization `code` for a short-lived token.
 *  - {@link exchangeForLongLivedToken} — that token for a ~60-day long-lived one.
 *  - {@link computeExpiresAtSec} — the expiry math over the exchange's lifetime.
 *
 * Every exchange goes through an injected `fetch`, deliberately outside the
 * runtime SSRF allowlist in `core/host.ts` (that gate governs model-driven Graph
 * calls, not this operator CLI). The flow that sequences them is
 * {@link import('./login.js').runLogin}. Moved unchanged from `cli/login.ts` on
 * 2026-10-28.
 */
import { MAX_RESPONSE_BYTES, readCappedText } from '../core/body.js';
import { GRAPH_VERSION } from '../core/host.js';
import { expiryFromLifetime, lifetimeFromWire } from '../core/time.js';
import { MAX_GRAPH_MESSAGE_LENGTH, toInstagramError } from '../core/errors.js';
import { InstagramError } from '../core/types.js';
import type { AuthPath } from '../core/types.js';
import { quoteUntrusted, visibleText } from '../core/untrusted.js';

// --- Endpoints (docs/auth.md §1) -------------------------------------------

const IG_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH_BASE = 'https://graph.instagram.com';
const FB_WWW_BASE = 'https://www.facebook.com';
const FB_GRAPH_BASE = 'https://graph.facebook.com';

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
