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
import { InstagramError, type IgRequestFn } from '../core/types.js';
import { describeWireValue, isRecordableExpiry, isoFromEpochSeconds } from '../core/time.js';
import { fetchPagedEdge, type PagedResult } from './media.js';

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
 * Is a cast Graph body a plain object that fields can be read off? `req` CASTS
 * the body rather than validating it, so JSON `null`, a scalar or a list can
 * arrive where an object is declared. Local on purpose: `api/media.ts` spells
 * the same test inline in its private `normalizeDetail`, and there is no shared
 * helper to import.
 */
function isObjectBody(body: unknown): body is object {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

/**
 * `GET /{ig-id}?fields=...` — profile of the operated account. `igId` is the
 * resolved IG professional-account ID (callers pass `'me'` to let the active
 * auth path resolve it). Host is left to the active auth provider's default.
 *
 * A body that is not an object at all (JSON `null`, a number, a text body, a
 * list) is no profile, and is refused as a malformed answer — the same
 * `upstream` refusal `getMedia` gives (CC-DATA-84). `null` used to throw a
 * raw TypeError on `wire.id`, whose engine text reached `get_account` and the
 * `doctor` reachability line; a scalar or a list read as a profile with every
 * field absent.
 */
export async function getAccount(
  req: IgRequestFn,
  params: { igId: string },
): Promise<AccountProfile> {
  const body = await req<unknown>({
    method: 'GET',
    path: `/${encodeURIComponent(params.igId)}`,
    params: { fields: ACCOUNT_FIELDS },
  });
  if (!isObjectBody(body)) {
    throw new InstagramError('Instagram returned no account object for this id. Retry later.', {
      kind: 'upstream',
    });
  }
  const wire = body as AccountWire;
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
 *
 * `/me/accounts` is a paginated edge (25 Pages per page by default), so the
 * cursor is followed up to `maxItems`. Reading only the first page dropped
 * every Page past it without a trace, and the tool promises the whole set.
 * The whole {@link PagedResult} is returned, not just its items: a walk the
 * cap cut short must say so (`truncated`, `after`, `note`), exactly as the
 * media, comments and tagged listings do — returning the bare array hid it.
 */
export async function listLinkedAccounts(
  req: IgRequestFn,
  maxItems: number,
  after?: string,
): Promise<PagedResult<LinkedAccount>> {
  return fetchPagedEdge<LinkedPageWire, LinkedAccount>(
    req,
    (cursor) => ({
      method: 'GET',
      path: '/me/accounts',
      params: {
        fields: 'name,instagram_business_account{id,username}',
        ...(cursor === undefined ? {} : { after: cursor }),
      },
      host: 'graph.facebook.com',
    }),
    { maxItems, fetchAll: true, ...(after === undefined ? {} : { after }) },
    (row) => {
      // The body is cast, so a `data` entry can be `null`, and reading `.id` off
      // it threw a TypeError that failed the whole enumeration as an `upstream`
      // error. A non-object entry (or a list) is handed through untouched: the
      // tool layer leaves it out and counts it, as `normalizeComment` does
      // (CC-COM-16).
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return row as LinkedAccount;
      }
      return {
        pageId: row.id,
        pageName: row.name,
        igId: row.instagram_business_account?.id,
        igUsername: row.instagram_business_account?.username,
      };
    },
  );
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
  const body = await req<unknown>({
    method: 'GET',
    path: '/debug_token',
    params: { input_token: params.inputToken },
    host: 'graph.facebook.com',
  });
  // A body that is not an object is refused like the profile read above
  // (CC-DATA-85). `null` threw a raw TypeError on `.data`, and a scalar or a
  // list read as an envelope with no `data` — every field unknown, which would
  // present "Meta sent nonsense" to `token_status` / `doctor` as "Meta disclosed
  // nothing". The `{}` envelope (no `data`) is a real answer and is unaffected.
  if (!isObjectBody(body)) {
    throw new InstagramError('Instagram returned no token introspection object. Retry later.', {
      kind: 'upstream',
    });
  }
  const wire = body as DebugTokenWire;
  // Equivalent-mutant note: `??` and `||` are indistinguishable here too, and
  // for a stronger reason than at the list edge above. `d` is only ever read
  // through optional property accesses, so ANY falsy-but-not-nullish stand-in a
  // `||` would substitute yields `undefined` for all seven fields
  // — character-for-character the same summary `{}` produces. That is why the
  // exact set does not have to be enumerated correctly for the conclusion to
  // hold, and the enumeration above it was wrong until 2026-09-23: `JSON.parse`
  // rejects a bare `NaN` literal, and admits `-0`.
  // No input, well-formed or malformed, separates the two. `??` is kept because
  // the guard is about a MISSING `data` wrapper, not about a falsy one.
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
   * threshold, or when the expiry comes from an unverified (bare, hand-set)
   * record (CC-AUTH-70); otherwise absent. */
  warning?: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * Pure expiry math (no network) — driven by the injectable clock so tests are
 * deterministic (CC-AUTH-13). `expiresAtSec` semantics follow `debug_token`:
 * `undefined` → unknown (Path A with no usable record, a manually pasted token,
 * or `debug_token` omitting `expires_at` — CC-AUTH-7);
 * `0` → never expires. `warning` fires once the token is expired or within
 * `refreshAfterDays` of expiry.
 *
 * `expires_at` is unvalidated wire data. Any value outside the range the
 * Path-A record accepts — a whole number of Unix seconds up to
 * 9999-12-31T23:59:59Z (`isRecordableExpiry`) — is reported as `unknown`, on
 * both paths (CC-AUTH-68): a negative, a fraction, or an expiry in epoch
 * milliseconds is not an answer `debug_token` gives. It may also be an instant
 * no `Date` can represent: `JSON.parse` turns Meta's `1e400` into `Infinity`, a corrupt or
 * hand-edited credential record can carry `NaN`, and any magnitude past the
 * ±8.64e15 ms `Date` range is equally unrepresentable. It may also not be a
 * number at all: `DebugTokenWire` types it `number?`, and `req` CASTS its
 * payload rather than validating it. All of those are reported as `unknown`
 * with a warning naming the offending value — never thrown. Two
 * reasons for that shape. First, a throw: `toISOString` raises a bare
 * `RangeError`, which is not an `InstagramError`, so no layer above classifies
 * it — and it would escape a PURE function into `doctor` / `token_status`, the
 * two diagnostics an operator runs precisely because they already suspect the
 * token, crashing the answer instead of giving it. Second, `unknown` rather than
 * a new {@link ExpiryState} (every caller switches on this union) or an existing
 * neighbour: it is literally true — the expiry is not knowable from this payload
 * — whereas `expired` would declare a possibly healthy token dead (burning a
 * rotation, and marking the install unhealthy in `doctor`), and `valid`/`never`
 * would certify an uninspectable one and suppress every future refresh warning.
 */
export function summarizeTokenExpiry(params: {
  expiresAtSec?: number;
  nowMs: number;
  refreshAfterDays: number;
  /**
   * The env var the expiry was read from when it is a LOCAL record (Path A:
   * `IG_TOKEN_EXPIRES_AT` / `IG_PROFILE_<NAME>_TOKEN_EXPIRES_AT`), not live
   * `debug_token` data. It changes only the wording: a record is metadata
   * `login`/`refresh` wrote beside the token they stored, so it is absent for a
   * hand-pasted token and ignored for a token replaced by hand — the remedies
   * differ from Path B's, where re-running `login` records nothing that
   * `debug_token` would read.
   */
  recordedIn?: string;
  /**
   * With `recordedIn`: the record carries no token fingerprint (a bare
   * `<seconds>` set by hand), so it was read as written and never checked
   * against the token (CC-AUTH-70). Every state that reports the record's
   * expiry then says so in `warning`, `valid` and `never` included.
   */
  recordUnverified?: boolean;
}): TokenExpirySummary {
  const { expiresAtSec, nowMs, refreshAfterDays, recordedIn, recordUnverified } = params;
  // A fingerprinted record reads back only for the token it was written for
  // (CC-AUTH-59), so it IS a statement about this token. A bare one set by hand
  // is read as written and bound to nothing (CC-AUTH-70): every dated answer
  // built from it says so, `valid` and `never` included, which would otherwise
  // present a hand-typed number as a fact about this token.
  const unverifiedNote =
    recordedIn === undefined || recordUnverified !== true
      ? undefined
      : `${recordedIn} records this expiry without a token fingerprint (a record set by hand), so it is taken as written and not checked against the token: if the token was replaced since, it describes the old one. Run the \`refresh\` or \`login\` CLI to record an expiry bound to the token.`;
  const recordNote =
    recordedIn === undefined
      ? ''
      : unverifiedNote === undefined
        ? ` This is the expiry \`login\`/\`refresh\` recorded in ${recordedIn} for this token.`
        : ` ${unverifiedNote}`;
  const unverifiedWarning =
    unverifiedNote === undefined
      ? {}
      : { warning: `Token expiry is unverified: ${unverifiedNote}` };
  if (expiresAtSec === undefined) {
    return {
      state: 'unknown',
      warning:
        recordedIn === undefined
          ? 'Token expiry is unknown: `debug_token` reported no `expires_at` for this token.'
          : `Token expiry is unknown: no usable expiry is recorded in ${recordedIn} for this token (a hand-pasted token has none, a record that is not whole Unix seconds (one in milliseconds, say) is not read, and a record from a different source than the token, or written for a different token, is ignored). Run the \`login\` CLI to mint a token and record its expiry, or set ${recordedIn} to the token's expiry in Unix seconds.`,
    };
  }
  if (expiresAtSec === 0) {
    return { state: 'never', ...unverifiedWarning };
  }
  // The "is this an instant at all" question is asked once, in `core/time.ts`.
  // This module used to carry its own copy of that guard — same threshold, same
  // clauses, same reasoning — and the copies drifted: a retraction taken here on
  // 2026-09-22 was never propagated to the twin, so the two contradicted each
  // other in their own comments (CC-PROC-165), and neither copy asked whether
  // `expires_at` was a number at all. Delegating makes that drift impossible.
  // It costs this module nothing it promises: `core/time.ts` imports nothing,
  // and the header's no-`core/http`/no-`core/auth` guarantee is about the
  // network, not about Layer 0.
  //
  // `expiresAtSec === 0` above is compared strictly on purpose: `"0"`, `false`
  // and `[]` are not the never-expires sentinel, they are values that are not
  // numbers, and they fall through to here rather than certifying an
  // uninspectable token as immortal.
  //
  // Both paths are held to the same range (CC-AUTH-68): a whole number of Unix
  // seconds up to 9999-12-31T23:59:59Z (`isRecordableExpiry`). Path A's reader
  // already refused anything else, but Path B's `expires_at` was bounded only by
  // the `Date` range, so an expiry in epoch MILLISECONDS read back as a valid
  // token dated in the year 58692, and a negative value as a token that expired
  // in 1969 — dates neither source can mean. They are now `unknown` with the
  // value named, as they are on Path A.
  const expiresAt = isRecordableExpiry(expiresAtSec)
    ? isoFromEpochSeconds(expiresAtSec)
    : undefined;
  if (expiresAt === undefined) {
    return {
      state: 'unknown',
      warning:
        recordedIn === undefined
          ? `Token expiry is unknown: upstream reported an \`expires_at\` of ${describeWireValue(expiresAtSec)}, which is not a representable timestamp.`
          : `Token expiry is unknown: ${recordedIn} records ${describeWireValue(expiresAtSec)}, which is not a representable timestamp; set it to the token's expiry in Unix seconds.`,
    };
  }
  // Safe by construction: an ISO answer is proof that `expiresAtSec` was a
  // number whose product is a finite instant inside `Date` range, so no `NaN`
  // can reach `daysLeft` — where it would fail both tests below and report a
  // plainly `valid` token.
  const expiresAtMs = expiresAtSec * 1000;
  const daysLeft = Math.floor((expiresAtMs - nowMs) / MS_PER_DAY);
  if (expiresAtMs <= nowMs) {
    return {
      state: 'expired',
      expiresAt,
      daysLeft,
      warning: `Token expired at ${expiresAt}; run the \`login\` CLI to obtain a new one.${recordNote}`,
    };
  }
  if (daysLeft <= refreshAfterDays) {
    return {
      state: 'expiring_soon',
      expiresAt,
      daysLeft,
      warning: `Token expires at ${expiresAt} (~${daysLeft} day(s) left); run the \`refresh\` or \`login\` CLI.${recordNote}`,
    };
  }
  return { state: 'valid', expiresAt, daysLeft, ...unverifiedWarning };
}

/** Coarse state of the Path-B data-access window (`data_access_expires_at`). */
export type DataAccessState = 'none' | 'unknown' | 'open' | 'expired';

export interface DataAccessExpirySummary {
  state: DataAccessState;
  /** ISO 8601 end of the window. Present for `open` and `expired` only. */
  expiresAt?: string;
  /** Set for `unknown` (the value Meta sent) and `expired` (the remedy). */
  warning?: string;
}

/**
 * Pure summary of `debug_token`'s `data_access_expires_at` (Path B), shared by
 * `token_status` and `doctor` so the two diagnostics cannot disagree about it.
 * The window expires independently of the token (CC-AUTH-12): a token can be
 * `is_valid: true` with a lapsed window, and every Instagram data read then
 * fails with a permission error.
 *
 * - `undefined` (Meta omits it for tokens with no window) and `0` (Meta's "no
 *   expiry / not applicable", CC-DATA-113) are both `none`: no line, no warning.
 * - Anything outside the recorded range (`isRecordableExpiry`, CC-AUTH-71) or
 *   not a number at all (CC-AUTH-45) is `unknown`, with the value named, so
 *   "Meta sent nonsense" never reads as "Meta sent nothing".
 * - A window that closed at or before `nowMs` is `expired`, with a warning. It
 *   used to be published as a bare past date with no warning at all, and
 *   `doctor` did not show the window whatever its state (CC-AUTH-77).
 *
 * The `0` guard is strict on purpose: `isRecordableExpiry(0)` is true, so
 * without it the sentinel would render as a window that closed in 1970, and
 * `null`, `false` or `''` are not the sentinel but values that are not numbers.
 */
export function summarizeDataAccessExpiry(params: {
  dataAccessExpiresAtSec?: number;
  nowMs: number;
}): DataAccessExpirySummary {
  const { dataAccessExpiresAtSec: sec, nowMs } = params;
  if (sec === undefined || sec === 0) return { state: 'none' };
  if (!isRecordableExpiry(sec)) {
    return {
      state: 'unknown',
      warning: `Data-access expiry is unknown: upstream reported a \`data_access_expires_at\` of ${describeWireValue(sec)}, which is not a representable timestamp.`,
    };
  }
  // Safe by construction: `isRecordableExpiry` admits only whole seconds inside
  // the `Date` range, so the render cannot throw and the product is finite.
  const expiresAt = isoFromEpochSeconds(sec) as string;
  if (sec * 1000 <= nowMs) {
    return {
      state: 'expired',
      expiresAt,
      warning: `Data access expired at ${expiresAt}: the token can still be valid, but reads of Instagram data fail with a permission error until the app is re-authorized; run the \`login\` CLI to renew the data-access window.`,
    };
  }
  return { state: 'open', expiresAt };
}
