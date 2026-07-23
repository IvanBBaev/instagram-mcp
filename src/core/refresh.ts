/**
 * Token refresh + refresh-decision logic (Layer 1). Written against the
 * {@link IgRequestFn} network seam — this module performs the long-lived-token
 * exchange for each auth path and answers "is this token close enough to expiry
 * to refresh?". It never imports `core/http`, `core/auth`, or the `mcp`/`tools`
 * layers, and it never reads or writes credential storage.
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
import { InstagramError } from './types.js';
import type { AuthPath, GraphHost, IgRequestFn } from './types.js';

/** Wire shape shared by both token-exchange endpoints. `expires_in` is seconds
 * from now; Meta omits it for a token that never expires. */
interface TokenExchangeWire {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/** The refreshed token plus its computed absolute expiry (unix seconds, matching
 * `debug_token`'s `expires_at` so the result feeds `summarizeTokenExpiry`
 * directly). `expiresAtSec` is absent when the upstream omits `expires_in`. */
export interface RefreshResult {
  accessToken: string;
  expiresAtSec?: number;
}

/**
 * Exchange the current long-lived token for a fresh one, per auth path. This is
 * the raw exchange only — see the module doc for why it does not persist.
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
export async function refreshToken(
  req: IgRequestFn,
  params: {
    authPath: AuthPath;
    accessToken: string;
    appId?: string;
    appSecret?: string;
    /** Injectable clock (unix ms) for computing `expiresAtSec`; defaults to now. */
    nowMs?: number;
  },
): Promise<RefreshResult> {
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

  const wire = await req<TokenExchangeWire>({
    method: 'GET',
    path,
    params: query,
    host,
  });

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
