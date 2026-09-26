/**
 * Token refresh (Layer 1). This module performs the long-lived-token exchange
 * for each auth path. It does not decide WHEN to refresh: refresh is
 * operator-driven (docs/auth.md §3), and `IG_REFRESH_AFTER_DAYS` is only the
 * `expiring_soon` threshold `summarizeTokenExpiry` warns at (CC-AUTH-67). It
 * never imports `core/http`, `core/auth`, or the `mcp`/`tools` layers, and it
 * never reads or writes credential storage.
 * The capped body reader it shares with the Graph seam lives in `core/body`
 * for exactly that reason: taking it from `core/http` would bring the seam along.
 *
 * ## Why the exchange does NOT ride the `IgRequestFn` Graph seam
 *
 * `IgRequestFn` (built by `core/http.ts`) merges the active
 * {@link import('./types.js').AuthProvider}'s params into **every** call —
 * `access_token` always, plus an `appsecret_proof` HMAC whenever the target host
 * is `graph.facebook.com` (`core/auth.ts`). That is exactly right for Graph
 * calls, and exactly wrong here: the two OAuth token-exchange endpoints
 * authenticate themselves and Meta documents a fixed parameter set for each
 * (docs/auth.md §1) —
 *
 *   - ig-login: `GET /refresh_access_token?grant_type=ig_refresh_token&access_token=…`
 *   - fb-login: `GET /oauth/access_token?grant_type=fb_exchange_token&client_id=…
 *     &client_secret=…&fb_exchange_token=…`
 *
 * Routing those through the authenticated seam sent the fb-login exchange an
 * extra `access_token` **plus** an `appsecret_proof` that the endpoint does not
 * ask for, and — because the merge lets the provider's params win — silently
 * replaced the `access_token` of the ig-login refresh with whichever token the
 * active profile happened to hold. So the exchange uses its own transport
 * ({@link TokenExchangeFn}): the same URL construction (SSRF allowlist + pinned
 * version via `buildUrl`) and the same error mapping, with **no** auth
 * injection. It is a separate type from `IgRequestFn`, produced only here and in
 * the composition root — a tool only ever receives an `IgRequestFn`, and
 * `IgRequestOptions` carries no "skip auth" flag, so no tool can opt itself out
 * of auth by accident (docs/security.md §3).
 *
 * Trade-off: the exchange loses the seam's retry/backoff, usage-header parsing
 * and per-host concurrency. `refresh` is a one-shot operator command, so a
 * transport failure surfaces to the operator instead of being retried; the
 * timeout is kept ({@link EXCHANGE_TIMEOUT_MS}).
 *
 * ## D2 refresh-persistence trap (docs/roadmap.md gate D2, CC-AUTH-4/14)
 *
 * A refreshed token that is not written back to its home is **lost on restart**
 * — the process keeps using the new token in memory, but the next boot reads the
 * stale one from the config channel and may serve an already-expired token. This
 * module deliberately does **not** persist: it returns the freshly exchanged
 * `{ accessToken, expiresAtSec }` and leaves durability to the caller. The
 * `refresh` CLI is the sole writer — it calls `writeCredentials` to atomically
 * update the XDG env file (the only token home per D2 option (a)) — or, when
 * `IG_ENV_FILE` names an absolute file, that file, since it is the only one the
 * server then reads (CC-CFG-63). Tokens
 * injected via the MCP client's `env` are static: they cannot be persisted here,
 * so `token_status` warns instead of auto-refreshing (docs/auth.md §3 design
 * gate). Keeping the exchange pure also keeps it deterministically testable.
 */
import { MAX_RESPONSE_BYTES, readCappedText } from './body.js';
import { mapGraphError, toInstagramError } from './errors.js';
import { buildUrl } from './host.js';
import { createRedactor } from './redact.js';
import { expiryFromLifetime } from './time.js';
import { InstagramError } from './types.js';
// `IgRequestFn` is deliberately NOT imported here: this module must not be able
// to reach the auth-injecting Graph seam even by accident (see the header).
import type { AuthPath, GraphHost } from './types.js';

/**
 * Wire shape shared by both token-exchange endpoints. `expires_in` is seconds
 * from now; Meta omits it for a token that never expires.
 *
 * Every field is `unknown`, and that is deliberate. This interface describes what
 * Meta is *documented* to send; the value handed to it is a `JSON.parse` result
 * from a host we do not control, so declaring `access_token?: string` would be a
 * claim the type system then enforces nowhere. It was written that way, and the
 * `!wire.access_token` truthiness guard that went with it accepted `12345`,
 * `true` and `{}` as a token and returned them typed `string` — a shape the
 * caller (`writeCredentials`) meets with a raw `TypeError` from `.trim()`, after
 * which the operator is told their local config is at fault. Typing the wire
 * honestly forces {@link refreshToken} to narrow before it promises anything.
 */
interface TokenExchangeWire {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
}

/**
 * True when `value` is a string carrying at least one non-whitespace character.
 *
 * Used on both sides of the exchange — the caller's inputs and Meta's response —
 * because `!x` is too weak for a credential in either direction. A blank-but-
 * present `accessToken` sailed through `!accessToken` and was sent to Meta as
 * `access_token=%20%20%20`; a blank-but-present `access_token` in the reply
 * sailed back out as a `RefreshResult` and was written to the credential file.
 */
function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// --- The un-authenticated OAuth transport ----------------------------------

/**
 * Per-request budget for a token exchange, mirroring the `IG_TIMEOUT_MS`
 * default (`core/settings.ts`). The exchange is not retried — see the module doc.
 */
const EXCHANGE_TIMEOUT_MS = 30_000;

/** One GET against a self-authenticating OAuth endpoint. */
export interface TokenExchangeRequest {
  host: GraphHost;
  /** Path after the version segment, leading slash, no host. */
  path: string;
  /** The COMPLETE query string. Nothing is appended — that is the whole point. */
  params: Record<string, string>;
}

/**
 * Transport for the OAuth token-exchange endpoints. Deliberately **not**
 * `IgRequestFn`: it sends exactly the params it is given and never adds
 * `access_token` or `appsecret_proof` (module doc). Injected in tests.
 */
export type TokenExchangeFn = <T>(req: TokenExchangeRequest) => Promise<T>;

/**
 * The refusal for an exchange reply over {@link MAX_RESPONSE_BYTES}
 * (CC-PROC-203). This transport called `res.text()` until 2026-09-24, so a proxy
 * or captive portal answering the token endpoint with an endless stream was
 * buffered whole by the one command an operator runs to keep their token alive.
 *
 * `upstream`, carrying the status, because that is how this module reports every
 * other failure on the far side of the socket (`mapGraphError`'s fallback, the
 * missing-`access_token` refusal). Not `auth`: nothing about the size says the
 * credential was rejected, and an `auth` kind would send the operator to
 * re-login against a proxy fault. The message quotes nothing from the body — a
 * token-exchange reply is exactly the body that can carry a token — and it still
 * passes through {@link redactExchangeSecrets} on the way out, like every throw.
 */
function exchangeTooLarge(status: number, seen: string): InstagramError {
  return new InstagramError(
    `Token exchange response body is larger than the ${MAX_RESPONSE_BYTES / (1024 * 1024)} MiB ` +
      `this server buffers (${seen}); it was discarded unread. A token reply is a few hundred ` +
      'bytes, so check what any proxy between this server and Meta is returning.',
    { kind: 'upstream', status },
  );
}

/** Read a response body as JSON when possible, else as raw text (for errors). */
function parseBody(text: string): unknown {
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Query parameters whose VALUE is a credential, as opposed to a routing constant.
 * `grant_type` and `client_id` are deliberately absent: an app id is public and
 * both are the first thing an operator needs to see when diagnosing a rejected
 * exchange, so masking them would buy nothing and cost the diagnosis.
 */
const SECRET_PARAM_KEYS: readonly string[] = ['access_token', 'client_secret', 'fb_exchange_token'];

/**
 * Every spelling of `value` that can appear in a string this module surfaces:
 * the credential as the caller holds it, and the credential as `buildUrl` wrote
 * it into the query. Exported for `cli/login.ts`, whose exchanges put the same
 * credentials through the same encoder (CC-AUTH-76).
 *
 * `createRedactor` masks **exact substrings** — there is no shape matching for a
 * registered secret, by design (`core/redact.ts`). `buildUrl` serialises the
 * query with `URLSearchParams`, which form-encodes it: `+` becomes `%2B`, `/`
 * becomes `%2F`, `=` becomes `%3D`, a space becomes `+`. So registering only the
 * raw value masked a credential that survived encoding unchanged and missed the
 * same credential once it had been through the URL — the exact string a
 * transport that names the failing request puts in its message. Registering both
 * spellings is what makes the "no credential VALUE reaches an
 * operator-visible message" guarantee hold for a credential the module did not
 * choose the alphabet of, rather than only for one that happens to be URL-safe. (A hex app
 * secret and an `EAA…` token are URL-safe; an arbitrary stored token, which is
 * all this module is promised, is not.)
 *
 * Both spellings are returned unconditionally, even when they are identical:
 * `createRedactor` de-duplicates through a `Set`, so the duplicate costs
 * nothing, and a `raw === encoded ? … : …` test would add a branch whose two
 * arms produce the same redaction for every input.
 *
 * Equivalence note, corrected on 2026-09-23: the `'v'` key is a placeholder with
 * no observable identity, but NOT for "any single-character name" — only for one
 * the form encoder leaves alone. `URLSearchParams` percent-encodes the KEY as
 * well as the value, so a name outside `[0-9A-Za-z*._-]` widens the `<name>=`
 * prefix past the fixed `'v='.length` slice: `'%'` serialises as `%25=<encoded>`
 * and the slice then yields `5=<encoded>`, registering a mask that matches
 * nothing the transport will ever print. Measured 2026-09-23: renaming the key to
 * `'%'` is killed by "a credential is masked in BOTH the spelling it has and the
 * spelling the URL has". Inside the URL-safe alphabet the rename is genuinely
 * unobservable — the name encodes to itself and the same two-character slice
 * strips it.
 * The slice length is NOT equivalent and is pinned: taking one character less
 * registers `=<encoded>` instead of `<encoded>`, which still masks the value
 * inside a URL (where a `=` always precedes it) and masks nothing at all in the
 * message where Meta quotes the value back on its own.
 */
export function surfaceForms(value: string): readonly string[] {
  const encoded = new URLSearchParams([['v', value]]).toString().slice('v='.length);
  return [value, encoded];
}

/**
 * Re-throw an exchange failure with every credential this request put on the
 * wire masked out of the surfaced `message`.
 *
 * This is the module's redaction boundary, and it exists because the two obvious
 * assumptions are both false:
 *
 *  1. *"`errors.ts` already strips tokens."* It strips the three shapes it knows —
 *     `EAA…`, `IG…`, and 64-hex `appsecret_proof`. A Meta **app secret** is 32 hex
 *     characters and matches none of them. `error.message` on a rejected exchange
 *     routinely quotes the offending parameter back, so a wrong `client_secret`
 *     arrives inside the exact field `mapGraphError` promotes to `message` — and
 *     the `refresh` CLI writes that message to stderr verbatim.
 *  2. *"The URL is never surfaced, so it cannot leak."* Nothing enforced that. A
 *     `fetch` implementation is free to name the request in its error (`undici`
 *     happens to say a bare "fetch failed"; a proxy agent, a stubbed transport, or
 *     a future runtime need not), and that error's message went straight through
 *     `toInstagramError`. One substituted transport away from the app secret and
 *     BOTH tokens in one string.
 *
 * So the values are registered with `core/redact.ts` — the frozen redaction
 * contract — for the lifetime of this one call, rather than trusting a shape
 * dictionary to recognise them. `cause` is untouched: it holds Meta's raw body
 * for log-time inspection and is itself redacted at every sink that reaches a
 * client (`mcp/registry.ts`, the logger, the write journal).
 *
 * Known limit, stated rather than papered over: `createRedactor` ignores an
 * `extraSecrets` entry shorter than `MIN_REGISTERED_SECRET_LENGTH` (8), because a
 * two-character "secret" would mask half the message. A real Meta app secret is
 * 32 hex characters and a real token far longer, so the floor is only reachable
 * with a toy fixture.
 */
function redactExchangeSecrets(
  err: InstagramError,
  params: Record<string, string>,
): InstagramError {
  const extraSecrets = SECRET_PARAM_KEYS.map((key) => params[key])
    .filter((value): value is string => value !== undefined)
    .flatMap((value) => surfaceForms(value));
  // `String(...)` rather than a cast: `createRedactor` is typed `(unknown) =>
  // unknown` because it deep-clones arbitrary payloads, and a `typeof === string`
  // check here would be a branch no input could ever take the false arm of.
  const message = String(createRedactor({ extraSecrets })(err.message));
  if (message === err.message) return err;
  return new InstagramError(message, {
    kind: err.kind,
    status: err.status,
    code: err.code,
    subcode: err.subcode,
    fbtraceId: err.fbtraceId,
    cause: err.cause,
  });
}

/**
 * Build the default {@link TokenExchangeFn}: a plain `GET` that reuses
 * `buildUrl` (SSRF allowlist + pinned Graph version, identical to the Graph
 * seam) and `mapGraphError`, minus every auth param.
 *
 * **Redirects are refused outright** — `redirect: 'error'`, not `'manual'` and
 * not a cross-host test. A 3xx from an OAuth token endpoint has no legitimate
 * meaning, and following one would replay the query — app secret and both tokens
 * — to whatever host the `Location` header named. (The comment here said
 * "cross-host redirects are refused", which understated the guard: a same-host
 * redirect is refused too, and a reader who trusted that sentence might have
 * "restored" the weaker behaviour it described.)
 *
 * Everything thrown out of the returned function passes through
 * {@link redactExchangeSecrets}, so no credential VALUE in the query can reach
 * an operator-visible message — enforced, no longer merely asserted.
 *
 * The URL itself is NOT masked, and that is the deliberate half. Only the
 * {@link SECRET_PARAM_KEYS} values are replaced; the host, the path, the
 * `grant_type` and the `client_id` survive verbatim, because they are what
 * separates a misconfigured app from a network fault and an app id is public
 * either way. `a transport error naming the request URL cannot carry the query
 * out` asserts both halves positively — the secrets absent AND the host, the
 * reason and the app id present. An earlier draft of this sentence read "the
 * URL … cannot reach an operator-visible message", which described a whole-URL
 * mask this module has never performed and its own tests forbid; a reader who
 * trusted it could have "restored" it and destroyed the diagnosis, the same
 * trap the redirect paragraph above records (CC-PROC-189).
 */
export function createTokenExchange(
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): TokenExchangeFn {
  // Equivalent-mutant note: `??` vs `||` survives the suite on `fetchImpl`, but
  // not because the two are interchangeable in principle. `typeof fetch` is
  // erased before this line runs and nothing validates what arrives, so every
  // falsy non-function an untyped caller can pass (`0`, `''`, `false`, `NaN`)
  // separates them: `??` keeps the value and the call throws a local
  // `TypeError`, while `||` would silently substitute the live
  // `globalThis.fetch`. `??` is kept because it fails closed. Nothing pins the
  // difference HERE, where the fallback is the global a test stub already owns;
  // the seam where it costs something is `params.exchange` in `refreshToken`,
  // where the same mutation reaches the network carrying a client secret, and
  // there it IS pinned. `timeoutMs` below is a third case, pinned directly: `0`
  // is a legitimate budget that `||` would silently promote to 30 s.
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? EXCHANGE_TIMEOUT_MS;

  return async <T>(req: TokenExchangeRequest): Promise<T> => {
    // One try block around the whole exchange, so there is exactly one exit for
    // a failure and therefore exactly one place redaction can be forgotten.
    // `buildUrl`'s own rejections (SSRF allowlist, unpinned path) are inside it
    // deliberately — they are thrown with the offending URL in hand.
    try {
      const url = buildUrl(req.host, req.path, req.params);
      const res = await doFetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Bounded like every other reader of a Meta body (CC-PROC-203). A read that
      // fails mid-stream — the timeout signal also governs the body — lands in
      // the catch below as a transport error, the same as before.
      const body = parseBody(await readCappedText(res, exchangeTooLarge));
      if (!res.ok) {
        // Present-but-empty is not a trace id. `mapGraphError` ran its
        // non-empty filter over the id it found in the BODY only — the header
        // argument was adopted verbatim until 2026-09-24 — so `x-fb-trace-id: ` (a blank
        // value, which a proxy or a load balancer in front of Meta can emit)
        // arrived on the error as `fbtraceId: ''`. That is an id-shaped field
        // with no id in it: it prints as a plausible reference in the line the
        // operator forwards to Meta support, and it passes every
        // `fbtraceId !== undefined` check between here and the sink. Absent is
        // the honest answer, and it is the one this module already gives when
        // the header is missing altogether.
        const traceId = res.headers.get('x-fb-trace-id');
        throw mapGraphError(res.status, body, isNonBlank(traceId) ? traceId : undefined);
      }
      return body as T;
    } catch (err) {
      // `toInstagramError` returns an existing `InstagramError` unchanged, so a
      // mapped Graph error keeps its kind/status/code and only gains masking.
      throw redactExchangeSecrets(toInstagramError(err), req.params);
    }
  };
}

/**
 * The refreshed token plus its computed absolute expiry (unix **integer**
 * seconds, matching `debug_token`'s `expires_at` so the result feeds
 * `summarizeTokenExpiry` directly).
 *
 * `accessToken` is guaranteed to be a non-blank string — the wire value is
 * narrowed, not cast. `expiresAtSec` is absent when the upstream omits
 * `expires_in`, and equally when it sends one that names no recordable instant
 * (`1e999` parses to `Infinity`); "no expiry known" is the honest answer in both
 * cases, and `token_status` then reports the expiry as unknown. `expires_in: 0` gives
 * `expiresAtSec: 0`, "never expires" (`expiryFromLifetime` in `core/time.ts`).
 */
export interface RefreshResult {
  accessToken: string;
  expiresAtSec?: number;
}

/** Inputs for {@link refreshToken}. */
export interface RefreshParams {
  authPath: AuthPath;
  accessToken: string;
  appId?: string;
  appSecret?: string;
  /** Injectable clock (unix ms) for computing `expiresAtSec`; defaults to now. */
  nowMs?: number;
  /**
   * Transport for the exchange. Defaults to {@link createTokenExchange}() —
   * override in tests. Note this is a {@link TokenExchangeFn}, never the
   * auth-injecting `IgRequestFn` (module doc).
   */
  exchange?: TokenExchangeFn;
}

/**
 * Exchange the current long-lived token for a fresh one, per auth path. This is
 * the raw exchange only — see the module doc for why it does not persist, and
 * why it does not use the `IgRequestFn` Graph seam.
 *
 * - **Path A (`ig-login`)**: `GET /refresh_access_token?grant_type=ig_refresh_token`
 *   on `graph.instagram.com`. Refreshes a long-lived IG User token, which Meta
 *   only accepts when the token is ≥ 24 h old and unexpired (docs/auth.md §1).
 * - **Path B (`fb-login`)**: the Facebook long-lived exchange
 *   `GET /oauth/access_token?grant_type=fb_exchange_token` on `graph.facebook.com`,
 *   which requires `client_id`/`client_secret` (the app credentials).
 *
 * `nowMs` is an injectable clock (defaults to `Date.now()`) used only to turn the
 * relative `expires_in` into an absolute `expiresAtSec`; tests pass a fixed value
 * so the computed expiry is deterministic (CC-AUTH-13).
 *
 * @throws {@link InstagramError} kind `validation` when required params for the
 * path are missing or blank; kind `upstream` when the response carries no usable
 * `access_token`. Nothing else escapes: a malformed reply is refused with a
 * typed error, never with a raw `TypeError` from reading a field off it. The one
 * exception is a caller who supplies a non-function `exchange`: that value is
 * kept rather than replaced by the default transport, so the `TypeError` it
 * raises is local and reaches no socket (CC-AUTH-44).
 */
export async function refreshToken(params: RefreshParams): Promise<RefreshResult> {
  const { authPath, accessToken, appId, appSecret } = params;

  // Blank-aware, not merely truthy: `'   '` is a present-but-empty credential,
  // and `!accessToken` waved it through to be sent to Meta as `%20%20%20`. The
  // `typeof` half also stops a non-string reaching `.trim()` — this is exported,
  // so the compiler is not the only caller.
  if (!isNonBlank(accessToken)) {
    throw new InstagramError('refreshToken requires a non-empty accessToken', {
      kind: 'validation',
    });
  }

  let host: GraphHost;
  let path: string;
  let query: Record<string, string>;

  if (authPath === 'ig-login') {
    host = 'graph.instagram.com';
    path = '/refresh_access_token';
    query = { grant_type: 'ig_refresh_token', access_token: accessToken };
  } else if (authPath === 'fb-login') {
    if (!isNonBlank(appId) || !isNonBlank(appSecret)) {
      throw new InstagramError(
        'fb-login token refresh requires both appId and appSecret (the fb_exchange_token grant).',
        { kind: 'validation' },
      );
    }
    host = 'graph.facebook.com';
    path = '/oauth/access_token';
    query = {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: accessToken,
    };
  } else {
    throw new InstagramError(`Unknown auth path for token refresh: ${String(authPath)}`, {
      kind: 'validation',
    });
  }

  // Equivalent-mutant note: a `TokenExchangeFn` VALUE is indeed never falsy, but
  // `params.exchange` is a declaration, not a validation — exactly as the
  // paragraph below says of `exchange<TokenExchangeWire>`, and exactly as the
  // `accessToken` guard above already assumes when it notes that the compiler is
  // not this function's only caller. So `??` and `||` ARE separable here, and
  // they separate in the direction that matters: given `exchange: 0`, `??` keeps
  // it and throws a local `TypeError` having opened no socket, while `||` would
  // build a real `createTokenExchange()` and put `client_secret` on the wire to
  // graph.facebook.com. `??` stays because it fails closed, and that direction is
  // pinned by "a non-function transport at the exchange seam fails closed, off
  // the network".
  const exchange = params.exchange ?? createTokenExchange();
  const wire = await exchange<TokenExchangeWire>({ host, path, params: query });

  // `exchange<TokenExchangeWire>` is a CAST, not a validation — the generic only
  // tells the compiler what we hope arrived. A `200` whose body is JSON `null`
  // (or a bare string, which `parseBody` yields for a non-JSON reply) used to
  // reach `wire.access_token` and throw a raw `TypeError: Cannot read properties
  // of null`, breaking this function's own `@throws` contract at the exact moment
  // the operator most needs a diagnosable error. Narrow first, read after.
  //
  // Both halves carry weight, and this note said otherwise until 2026-09-23. It
  // claimed the `typeof wire === 'object'` half could not be separated from
  // `wire !== null` by any input a transport can produce, on an enumeration that
  // read "a string, a number or a boolean" — all three of which are indeed read
  // through harmlessly to the same `isNonBlank` refusal with the same
  // `cause: wire`. The enumeration omitted `undefined`, whose `typeof` is
  // `'undefined'` and which `!== null` waves straight through: with only the null
  // check, `body.access_token` throws a raw `TypeError: Cannot read properties of
  // undefined`, which is the exact failure the paragraph above says this line
  // exists to prevent. The default transport cannot produce it (`parseBody`
  // answers `{}` for an empty body and `JSON.parse` never yields `undefined`),
  // but `params.exchange` is an injected seam and a transport that falls off the
  // end resolves with `undefined`. Pinned by "a transport that resolves with
  // nothing is refused, not dereferenced". A FUNCTION carrying an `access_token`
  // property would separate them too, and that one really is unreachable here.
  const body: TokenExchangeWire = typeof wire === 'object' && wire !== null ? wire : {};

  // Refuse, never repair. Trimming or coercing a malformed token here would write
  // a value Meta never issued into the credential file and leave the operator
  // debugging an auth failure one process later.
  const token = body.access_token;
  if (!isNonBlank(token)) {
    throw new InstagramError('Token refresh response did not include a usable access_token.', {
      kind: 'upstream',
      cause: wire,
    });
  }

  const nowMs = params.nowMs ?? Date.now();
  // `expires_in` is untrusted arithmetic input, and `login` reads the same field
  // off the same exchanges: both go through `expiryFromLifetime`
  // (`core/time.ts`), so the two can no longer disagree about what a value
  // means (CC-AUTH-64). `0` is "never expires" there, as it is in
  // `debug_token` and in the stored record; this module used to read it as
  // "expires now", so a never-expiring token run through `refresh` was
  // recorded, and reported, as expired. `1e999` (valid JSON, parsed to
  // `Infinity`) and a finite-but-absurd `1e21` used to be persisted as values no
  // consumer could represent; like a missing field, they are now "no expiry
  // known". A non-finite `nowMs` lands on the same `undefined`.
  return { accessToken: token, expiresAtSec: expiryFromLifetime(body.expires_in, nowMs) };
}
