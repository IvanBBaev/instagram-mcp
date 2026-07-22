/**
 * Insights domain (Layer 1). Read-only account + media insights, built on the
 * post-2025-01-08 metric set (views-centric; `impressions`/`video_views`/
 * `profile_views` are gone and never referenced). Pure functions over the
 * injected {@link IgRequestFn} seam — no `core/http`/`core/auth` imports.
 *
 * Corner cases owned here (docs/corner-cases.md §6):
 *  - CC-INS-2: per-`media_product_type` metric matrix; invalid combos refused
 *    client-side with the valid set listed.
 *  - CC-INS-3: `since`/`until` outside the 90-day retention are refused (fully
 *    out of window) or clamped + flagged (partially in window).
 *  - CC-INS-7: the metric vocabularies below contain only the post-2025 set,
 *    so legacy names are rejected at the tool's zod enum before any call.
 * CC-INS-1/5/6 are honest tool-description text + propagated `InstagramError`
 * from the mapping layer (`core/errors.ts`), not client-side logic here.
 *
 * Metric availability can differ by auth path, but docs/tools.md marks none of
 * these tools path-specific, so the specs leave `ToolSpec.paths` undefined.
 */
import { InstagramError } from '../core/types.js';
import type {
  GraphListResponse,
  GraphPaging,
  IgRequestFn,
  IgRequestOptions,
} from '../core/types.js';

// --- Metric / period / breakdown vocabularies (post-2025 set) ---------------

/** Account-level metrics (docs/tools.md §insights `get_account_insights`). */
export const ACCOUNT_METRICS = [
  'views',
  'reach',
  'accounts_engaged',
  'total_interactions',
  'likes',
  'comments',
  'shares',
  'saves',
  'replies',
  'follows_and_unfollows',
  'profile_links_taps',
] as const;
export type AccountMetric = (typeof ACCOUNT_METRICS)[number];

/**
 * Media-level metrics. Validity depends on `media_product_type` — see
 * {@link MEDIA_METRIC_MATRIX} (CC-INS-2). `navigation`/`replies` are story-only.
 * (Note the account/media naming quirk Meta keeps: account uses `saves`, media
 * uses `saved`.)
 */
export const MEDIA_METRICS = [
  'views',
  'reach',
  'likes',
  'comments',
  'saved',
  'shares',
  'total_interactions',
  'navigation',
  'replies',
] as const;
export type MediaMetric = (typeof MEDIA_METRICS)[number];

/** The common media set requested when the caller names no metrics. */
export const DEFAULT_MEDIA_METRICS: readonly MediaMetric[] = [
  'views',
  'reach',
  'likes',
  'comments',
  'saved',
  'shares',
  'total_interactions',
];

/**
 * Which media metrics are valid per `media_product_type` (CC-INS-2). Keys are
 * the known Meta product types; an unknown type (Meta adds new ones — CC-DATA-6
 * open vocabulary) skips client validation and lets Meta be the authority.
 */
export const MEDIA_METRIC_MATRIX: Record<string, readonly MediaMetric[]> = {
  FEED: ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
  REELS: ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
  STORY: ['views', 'reach', 'replies', 'shares', 'total_interactions', 'navigation'],
};

/** Audience-demographics metrics (docs/tools.md `get_audience_demographics`). */
export const DEMOGRAPHIC_METRICS = [
  'follower_demographics',
  'engaged_audience_demographics',
] as const;
export type DemographicMetric = (typeof DEMOGRAPHIC_METRICS)[number];

/** Demographics breakdown dimension (one per call). */
export const DEMOGRAPHIC_BREAKDOWNS = ['age', 'gender', 'city', 'country'] as const;
export type DemographicBreakdown = (typeof DEMOGRAPHIC_BREAKDOWNS)[number];

/** Demographics `timeframe` (required; replaces `since`/`until`). */
export const DEMOGRAPHIC_TIMEFRAMES = [
  'last_14_days',
  'last_30_days',
  'last_90_days',
  'prev_month',
  'this_month',
  'this_week',
] as const;
export type DemographicTimeframe = (typeof DEMOGRAPHIC_TIMEFRAMES)[number];

/** Aggregation period for account metrics. */
export const ACCOUNT_PERIODS = ['day', 'week', 'days_28'] as const;
export type AccountPeriod = (typeof ACCOUNT_PERIODS)[number];

/** `metric_type`: aggregated total vs per-interval series. */
export const METRIC_TYPES = ['total_value', 'time_series'] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

/** Account-metric retention window (docs/operations.md §4). */
export const RETENTION_DAYS = 90;
const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60;

// NOTE: `follower_count` is a plausible post-2025 account metric but is a
// `[verify — live probe]` item in docs/workplan.md (T-D5); it is deliberately
// left out of ACCOUNT_METRICS until a live probe confirms it, so we never offer
// an unverified metric.

// --- Graph insights wire shapes --------------------------------------------

/** One row of a `total_value.breakdowns[]` result. */
export interface InsightBreakdownResult {
  dimension_values: string[];
  value: number;
}

/** A `total_value.breakdowns[]` entry (dimension keys + result rows). */
export interface InsightBreakdown {
  dimension_keys?: string[];
  results?: InsightBreakdownResult[];
}

/** Aggregated value for a `metric_type=total_value` metric. */
export interface InsightTotalValue {
  value?: number;
  breakdowns?: InsightBreakdown[];
}

/** A per-interval value for a time-series metric. */
export interface InsightValue {
  value: number | Record<string, number>;
  end_time?: string;
}

/** A single insights metric object as returned by Graph. */
export interface InsightMetric {
  name: string;
  period?: string;
  title?: string;
  description?: string;
  id?: string;
  values?: InsightValue[];
  total_value?: InsightTotalValue;
}

type InsightsWire = GraphListResponse<InsightMetric>;

// --- Helpers ----------------------------------------------------------------

/** Account-level insights target `/{ig-id}/insights`; the id must be resolved. */
function requireAccountId(accountId: string | undefined): string {
  if (accountId === undefined || accountId === '') {
    throw new InstagramError(
      'No Instagram account ID resolved for this profile. Set IG_ACCOUNT_ID (or a profile-scoped account ID) so account-level insights can target /{ig-id}/insights.',
      { kind: 'validation' },
    );
  }
  return accountId;
}

/**
 * CC-INS-2: refuse metrics that are invalid for a known `media_product_type`.
 * Unknown/omitted product types pass through (open vocabulary — CC-DATA-6);
 * Meta remains the final authority.
 */
export function validateMediaMetrics(
  metrics: readonly MediaMetric[],
  mediaProductType?: string,
): void {
  if (mediaProductType === undefined || mediaProductType === '') return;
  const allowed = MEDIA_METRIC_MATRIX[mediaProductType.toUpperCase()];
  if (allowed === undefined) return;
  const invalid = metrics.filter((m) => !allowed.includes(m));
  if (invalid.length > 0) {
    throw new InstagramError(
      `Metric(s) ${invalid.join(', ')} are not valid for media_product_type ${mediaProductType.toUpperCase()}. Valid metrics for this type: ${allowed.join(', ')}.`,
      { kind: 'validation' },
    );
  }
}

// --- Account insights -------------------------------------------------------

export interface AccountInsightsParams {
  /** Resolved IG professional-account id (`ctx.profile.accountId`). */
  accountId?: string;
  /** Defaults to the full {@link ACCOUNT_METRICS} set when omitted. */
  metrics?: readonly AccountMetric[];
  period?: AccountPeriod;
  metricType?: MetricType;
  /** Range start as a Unix timestamp in **seconds**. */
  since?: number;
  /** Range end as a Unix timestamp in **seconds**. */
  until?: number;
  /** Epoch **milliseconds** "now" for the 90-day retention clamp (from the clock). */
  nowMs?: number;
}

/** The effective time window applied to an account-insights request. */
export interface AccountInsightsWindow {
  since?: number;
  until?: number;
  /** True when `since` was raised to the 90-day retention floor (CC-INS-3). */
  clamped: boolean;
}

export interface AccountInsightsResult {
  metrics: InsightMetric[];
  window: AccountInsightsWindow;
  /** Human-readable flags (e.g. a retention clamp) surfaced to the model. */
  notes: string[];
  paging?: GraphPaging;
}

export async function getAccountInsights(
  req: IgRequestFn,
  params: AccountInsightsParams,
): Promise<AccountInsightsResult> {
  const accountId = requireAccountId(params.accountId);
  const metrics = params.metrics ?? ACCOUNT_METRICS;
  const notes: string[] = [];

  let since = params.since;
  const until = params.until;
  let clamped = false;

  // CC-INS-3: 90-day retention. Refuse a window entirely in the past; clamp a
  // window that only partially reaches back before the floor.
  if (params.nowMs !== undefined && (since !== undefined || until !== undefined)) {
    const floor = Math.floor(params.nowMs / 1000) - RETENTION_SECONDS;
    if (since !== undefined && until !== undefined && until < floor) {
      throw new InstagramError(
        `Requested insights window is entirely outside the ${RETENTION_DAYS}-day retention limit. Account metrics are only available for the last ${RETENTION_DAYS} days.`,
        { kind: 'validation' },
      );
    }
    if (since !== undefined && since < floor) {
      since = floor;
      clamped = true;
      notes.push(
        `\`since\` was clamped to the ${RETENTION_DAYS}-day retention floor; data older than that is not retained by Meta.`,
      );
    }
  }

  const opts: IgRequestOptions = {
    method: 'GET',
    path: `/${accountId}/insights`,
    params: {
      metric: metrics.join(','),
      period: params.period ?? 'day',
      metric_type: params.metricType ?? 'total_value',
      since,
      until,
    },
  };
  const res = await req<InsightsWire>(opts);
  return { metrics: res.data ?? [], window: { since, until, clamped }, notes, paging: res.paging };
}

// --- Media insights ---------------------------------------------------------

export interface MediaInsightsParams {
  mediaId: string;
  /** Defaults to {@link DEFAULT_MEDIA_METRICS} when omitted. */
  metrics?: readonly MediaMetric[];
  /**
   * Optional hint (e.g. `FEED` / `REELS` / `STORY`) enabling the CC-INS-2
   * client-side metric-matrix check before the call is spent.
   */
  mediaProductType?: string;
}

export interface MediaInsightsResult {
  mediaId: string;
  metrics: InsightMetric[];
}

export async function getMediaInsights(
  req: IgRequestFn,
  params: MediaInsightsParams,
): Promise<MediaInsightsResult> {
  const metrics = params.metrics ?? DEFAULT_MEDIA_METRICS;
  validateMediaMetrics(metrics, params.mediaProductType);
  const res = await req<InsightsWire>({
    method: 'GET',
    path: `/${params.mediaId}/insights`,
    params: { metric: metrics.join(',') },
  });
  return { mediaId: params.mediaId, metrics: res.data ?? [] };
}

// --- Audience demographics --------------------------------------------------

export interface AudienceDemographicsParams {
  accountId?: string;
  /** Defaults to `['follower_demographics']` when omitted. */
  metrics?: readonly DemographicMetric[];
  breakdown: DemographicBreakdown;
  timeframe: DemographicTimeframe;
}

export interface AudienceDemographicsResult {
  metrics: InsightMetric[];
  breakdown: DemographicBreakdown;
  timeframe: DemographicTimeframe;
}

export async function getAudienceDemographics(
  req: IgRequestFn,
  params: AudienceDemographicsParams,
): Promise<AudienceDemographicsResult> {
  const accountId = requireAccountId(params.accountId);
  const metrics = params.metrics ?? (['follower_demographics'] as const);
  const res = await req<InsightsWire>({
    method: 'GET',
    path: `/${accountId}/insights`,
    params: {
      metric: metrics.join(','),
      metric_type: 'total_value',
      breakdown: params.breakdown,
      timeframe: params.timeframe,
    },
  });
  return { metrics: res.data ?? [], breakdown: params.breakdown, timeframe: params.timeframe };
}

// --- Online followers -------------------------------------------------------

export interface OnlineFollowersParams {
  accountId?: string;
}

export interface OnlineFollowersResult {
  metrics: InsightMetric[];
}

export async function getOnlineFollowers(
  req: IgRequestFn,
  params: OnlineFollowersParams,
): Promise<OnlineFollowersResult> {
  const accountId = requireAccountId(params.accountId);
  const res = await req<InsightsWire>({
    method: 'GET',
    path: `/${accountId}/insights`,
    params: { metric: 'online_followers', period: 'lifetime' },
  });
  return { metrics: res.data ?? [] };
}
