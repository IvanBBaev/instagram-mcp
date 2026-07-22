/**
 * Account domain functions (Layer 1). Read-only Graph calls for the operated
 * Instagram professional account: profile fields, linked-account resolution
 * (Path B), and token introspection. Written against the {@link IgRequestFn}
 * network seam — this module never imports `core/http` or `core/auth`, and
 * never touches the `mcp`/`tools` layers. Errors raised by `req`
 * ({@link import('../core/types.js').InstagramError}) propagate unchanged.
 *
 * See docs/tools.md ("Package `account`") and docs/operations.md.
 */
import type { GraphListResponse, IgRequestFn } from '../core/types.js';

// --- get_account -----------------------------------------------------------

/** Profile of the operated account. Every field but `id` may be absent — Meta
 * omits hidden/unavailable fields rather than nulling them (CC-DATA-2). */
export interface AccountProfile {
  id: string;
  username?: string;
  name?: string;
  biography?: string;
  website?: string;
  profilePictureUrl?: string;
  followersCount?: number;
  followsCount?: number;
  mediaCount?: number;
}

/** Field set requested from `GET /{ig-id}` (docs/tools.md). */
const ACCOUNT_FIELDS =
  'username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count';

interface AccountWire {
  id: string;
  username?: string;
  name?: string;
  biography?: string;
  website?: string;
  profile_picture_url?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
}

/**
 * `GET /{ig-id}?fields=...` — profile of the operated account. `igId` is the
 * resolved IG professional-account ID (callers pass `'me'` to let the active
 * auth path resolve it). Host is left to the active auth provider's default.
 */
export async function getAccount(
  req: IgRequestFn,
  params: { igId: string },
): Promise<AccountProfile> {
  const wire = await req<AccountWire>({
    method: 'GET',
    path: `/${encodeURIComponent(params.igId)}`,
    params: { fields: ACCOUNT_FIELDS },
  });
  return {
    id: wire.id,
    username: wire.username,
    name: wire.name,
    biography: wire.biography,
    website: wire.website,
    profilePictureUrl: wire.profile_picture_url,
    followersCount: wire.followers_count,
    followsCount: wire.follows_count,
    mediaCount: wire.media_count,
  };
}

// --- list_linked_accounts (Path B only) ------------------------------------

/** A Facebook Page and the IG business account linked to it (if any). */
export interface LinkedAccount {
  pageId?: string;
  pageName?: string;
  igId?: string;
  igUsername?: string;
}

interface LinkedPageWire {
  id?: string;
  name?: string;
  instagram_business_account?: { id: string; username?: string };
}

/**
 * `GET /me/accounts?fields=name,instagram_business_account{id,username}` —
 * enumerate the Pages the token can act on and their linked IG accounts. This
 * is a Facebook-Graph endpoint (Path B / `fb-login` only); host is pinned to
 * graph.facebook.com so the tool's capability guard and the call agree.
 */
export async function listLinkedAccounts(req: IgRequestFn): Promise<LinkedAccount[]> {
  const res = await req<GraphListResponse<LinkedPageWire>>({
    method: 'GET',
    path: '/me/accounts',
    params: { fields: 'name,instagram_business_account{id,username}' },
    host: 'graph.facebook.com',
  });
  return (res.data ?? []).map((page) => ({
    pageId: page.id,
    pageName: page.name,
    igId: page.instagram_business_account?.id,
    igUsername: page.instagram_business_account?.username,
  }));
}

// --- token_status ----------------------------------------------------------

/** Parsed `GET /debug_token` payload (Path B). Fields are optional — Meta may
 * omit them, and `expires_at === 0` means the token never expires. */
export interface DebugTokenInfo {
  isValid?: boolean;
  appId?: string;
  type?: string;
  userId?: string;
  scopes?: string[];
  /** Unix seconds; `0` means "never expires". */
  expiresAtSec?: number;
  /** Unix seconds; Path-B data-access window end (independent of token validity). */
  dataAccessExpiresAtSec?: number;
}

interface DebugTokenWire {
  data?: {
    is_valid?: boolean;
    app_id?: string;
    type?: string;
    user_id?: string;
    scopes?: string[];
    expires_at?: number;
    data_access_expires_at?: number;
  };
}

/**
 * `GET /debug_token?input_token=<token>` on graph.facebook.com — token
 * introspection. Path B only: graph.instagram.com (Path A / `ig-login`) has no
 * `debug_token`, so Path-A callers must not invoke this (expiry is reported
 * `unknown` — CC-AUTH-7). The debugging `access_token` is injected by `req`.
 */
export async function debugToken(
  req: IgRequestFn,
  params: { inputToken: string },
): Promise<DebugTokenInfo> {
  const wire = await req<DebugTokenWire>({
    method: 'GET',
    path: '/debug_token',
    params: { input_token: params.inputToken },
    host: 'graph.facebook.com',
  });
  const d = wire.data ?? {};
  return {
    isValid: d.is_valid,
    appId: d.app_id,
    type: d.type,
    userId: d.user_id,
    scopes: d.scopes,
    expiresAtSec: d.expires_at,
    dataAccessExpiresAtSec: d.data_access_expires_at,
  };
}

/** Coarse expiry state derived from a token's `expires_at`. */
export type ExpiryState = 'unknown' | 'never' | 'valid' | 'expiring_soon' | 'expired';

export interface TokenExpirySummary {
  state: ExpiryState;
  /** ISO 8601 absolute expiry — stated even alongside `daysLeft` so a skewed
   * local clock is diagnosable (CC-AUTH-13). Absent for `unknown`/`never`. */
  expiresAt?: string;
  /** Whole days until expiry (may be negative for an already-expired token). */
  daysLeft?: number;
  /** Actionable remediation when the token is expired or nearing the refresh
   * threshold; otherwise absent. */
  warning?: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * Pure expiry math (no network) — driven by the injectable clock so tests are
 * deterministic (CC-AUTH-13). `expiresAtSec` semantics follow `debug_token`:
 * `undefined` → unknown (Path A, or a manually pasted token — CC-AUTH-7);
 * `0` → never expires. `warning` fires once the token is expired or within
 * `refreshAfterDays` of expiry.
 */
export function summarizeTokenExpiry(params: {
  expiresAtSec?: number;
  nowMs: number;
  refreshAfterDays: number;
}): TokenExpirySummary {
  const { expiresAtSec, nowMs, refreshAfterDays } = params;
  if (expiresAtSec === undefined) {
    return {
      state: 'unknown',
      warning:
        'Token expiry is unknown; re-acquire the token via the `login` CLI to record expiry metadata.',
    };
  }
  if (expiresAtSec === 0) {
    return { state: 'never' };
  }
  const expiresAtMs = expiresAtSec * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const daysLeft = Math.floor((expiresAtMs - nowMs) / MS_PER_DAY);
  if (expiresAtMs <= nowMs) {
    return {
      state: 'expired',
      expiresAt,
      daysLeft,
      warning: `Token expired at ${expiresAt}; run the \`login\` CLI to obtain a new one.`,
    };
  }
  if (daysLeft <= refreshAfterDays) {
    return {
      state: 'expiring_soon',
      expiresAt,
      daysLeft,
      warning: `Token expires at ${expiresAt} (~${daysLeft} day(s) left); run the \`refresh\` or \`login\` CLI.`,
    };
  }
  return { state: 'valid', expiresAt, daysLeft };
}
