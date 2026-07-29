/**
 * Token refresh + refresh-decision logic (Layer 1). This module performs the
 * long-lived-token exchange for each auth path and answers "is this token close
 * enough to expiry to refresh?". It never imports `core/http`, `core/auth`, or
 * the `mcp`/`tools` layers, and it never reads or writes credential storage.
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
 * update the XDG env file (the only token home per D2 option (a)). Tokens
 * injected via the MCP client's `env` are static: they cannot be persisted here,
 * so `token_status` warns instead of auto-refreshing (docs/auth.md §3 design
 * gate). Keeping the exchange pure also keeps it deterministically testable.
 */
import { mapGraphError, toInstagramError } from './errors.js';
import { buildUrl } from './host.js';
import { InstagramError } from './types.js';
// `IgRequestFn` is deliberately NOT imported here: this module must not be able
// to reach the auth-injecting Graph seam even by accident (see the header).
import type { AuthPath, GraphHost } from './types.js';

/** Wire shape shared by both token-exchange endpoints. `expires_in` is seconds
 * from now; Meta omits it for a token that never expires. */
interface TokenExchangeWire {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
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
 * Build the default {@link TokenExchangeFn}: a plain `GET` that reuses
 * `buildUrl` (SSRF allowlist + pinned Graph version, identical to the Graph
 * seam) and `mapGraphError`, minus every auth param. Cross-host redirects are
 * refused, and the URL is never logged or surfaced — its query carries the app
 * secret and both tokens.
 */
export function createTokenExchange(
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): TokenExchangeFn {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? EXCHANGE_TIMEOUT_MS;

  return async <T>(req: TokenExchangeRequest): Promise<T> => {
    const url = buildUrl(req.host, req.path, req.params);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toInstagramError(err);
    }

    let body: unknown;
    try {
      body = parseBody(await res.text());
    } catch (err) {
      throw toInstagramError(err);
    }

    if (!res.ok) {
      throw mapGraphError(res.status, body, res.headers.get('x-fb-trace-id') ?? undefined);
    }
    return body as T;
  };
}

/** The refreshed token plus its computed absolute expiry (unix seconds, matching
 * `debug_token`'s `expires_at` so the result feeds `summarizeTokenExpiry`
 * directly). `expiresAtSec` is absent when the upstream omits `expires_in`. */
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
 * path are missing; kind `upstream` when the response has no `access_token`.
 */
export async function refreshToken(params: RefreshParams): Promise<RefreshResult> {
  const { authPath, accessToken, appId, appSecret } = params;

  if (!accessToken) {
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
    if (!appId || !appSecret) {
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

  const exchange = params.exchange ?? createTokenExchange();
  const wire = await exchange<TokenExchangeWire>({ host, path, params: query });

  if (!wire.access_token) {
    throw new InstagramError('Token refresh response did not include an access_token.', {
      kind: 'upstream',
      cause: wire,
    });
  }

  const nowMs = params.nowMs ?? Date.now();
  const expiresAtSec =
    typeof wire.expires_in === 'number' ? Math.floor(nowMs / 1000) + wire.expires_in : undefined;

  return { accessToken: wire.access_token, expiresAtSec };
}

/**
 * Decide whether a token is close enough to expiry to refresh, given a threshold
 * in days. Consumes the `{ state, daysLeft }` shape produced by
 * {@link import('../api/account.js').summarizeTokenExpiry} (a full summary is
 * accepted structurally):
 *
 * - `never` → false (token never expires).
 * - unknown expiry (`daysLeft` absent, e.g. a Path-A pasted token — CC-AUTH-7) →
 *   false: we cannot prove it is within the threshold, so we do not churn it.
 * - otherwise → true when `daysLeft <= thresholdDays` (an already-expired token
 *   has a negative `daysLeft`, so it qualifies).
 */
export function needsRefresh(
  summary: { state: string; daysLeft?: number },
  thresholdDays: number,
): boolean {
  if (summary.state === 'never') return false;
  if (summary.daysLeft === undefined) return false;
  return summary.daysLeft <= thresholdDays;
}
