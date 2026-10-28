/**
 * Insights metric catalogue (Layer 1): the post-2025 metric, period, breakdown
 * and timeframe vocabularies, the defaults served when a caller names no
 * metrics, the per-`media_product_type` matrix, and the client-side checks that
 * refuse a combination Graph would reject. Data and pure validation only — no
 * request is built here. The fetch code is `api/insights.ts`, which re-exports
 * everything in this file, so importers keep that one module path; this file
 * is the one that changes when Meta's metrics table does.
 *
 * Corner cases decided here (the rest of docs/corner-cases.md §6 is accounted
 * for in the `api/insights.ts` header):
 *  - CC-INS-2: per-`media_product_type` metric matrix; invalid combos refused
 *    client-side with the valid set listed. The same matrix is what a caller who
 *    names a product type and no metrics is served by default (CC-INS-14).
 *  - CC-INS-7: the metric vocabularies below contain only the post-2025 set,
 *    so legacy names are rejected at the tool's zod enum before any call.
 *  - CC-INS-25: `time_series` for `reach` only, a combination rule taken from
 *    Meta's metrics table.
 *
 * Metric availability can differ by auth path, but docs/tools.md marks none of
 * these tools path-specific, so the specs leave `ToolSpec.paths` undefined. The
 * one per-metric path rule — the Facebook-Login-only `total_*` media metrics —
 * is enforced per call from the profile's auth path, and the `breakdown`
 * combination rules sit beside it (CC-INS-31).
 */
import { InstagramError } from '../core/types.js';
import type { AuthPath } from '../core/types.js';

// --- Metric / period / breakdown vocabularies (post-2025 set) ---------------

/**
 * Account-level metrics (docs/tools.md §insights `get_account_insights`).
 *
 * `reposts` was added 2026-10-28 from Meta's account-insights reference
 * (*[verified 2026-10-28 — Instagram Account Insights reference,
 * developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights]*:
 * period `day`, `total_value` only, no breakdown, no login restriction). It is
 * accepted but NOT part of {@link DEFAULT_ACCOUNT_METRICS}: a name Graph does
 * not know fails the whole request, and no live call has met it yet
 * *[verify — live: `GET /{ig-id}/insights?metric=reposts&period=day&metric_type=total_value` on both hosts]*.
 */
export const ACCOUNT_METRICS = Object.freeze([
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
  'reposts',
] as const);
export type AccountMetric = (typeof ACCOUNT_METRICS)[number];

/**
 * The account metrics requested when the caller names none (and names no
 * breakdown or time series). This is the eleven-metric set the server has
 * always sent; a metric added to {@link ACCOUNT_METRICS} later joins it only
 * after a live call has confirmed it, so an addition can never break the
 * default report.
 */
export const DEFAULT_ACCOUNT_METRICS: readonly AccountMetric[] = Object.freeze([
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
]);

/**
 * Account-insights `breakdown` dimensions (one per call), and which metrics
 * each one may be sent with (CC-INS-31). From Meta's account metrics table
 * *[verified 2026-10-28 — Instagram Account Insights reference]*. A breakdown
 * works only with `metric_type=total_value`, and naming a metric that does not
 * support it fails the whole request, so both are refused before the call.
 *
 * `follower_type` is listed in that table for `views` but has no documented
 * values and no entry in the breakdown section, so it is left out
 * *[verify — live: `GET /{ig-id}/insights?metric=views&period=day&metric_type=total_value&breakdown=follower_type`]*.
 */
export const ACCOUNT_BREAKDOWNS = Object.freeze([
  'media_product_type',
  'follow_type',
  'contact_button_type',
] as const);
export type AccountBreakdown = (typeof ACCOUNT_BREAKDOWNS)[number];

/** The metrics each {@link ACCOUNT_BREAKDOWNS} dimension may be sent with. */
export const ACCOUNT_BREAKDOWN_METRICS: Readonly<
  Record<AccountBreakdown, readonly AccountMetric[]>
> = Object.freeze({
  media_product_type: Object.freeze([
    'views',
    'reach',
    'total_interactions',
    'likes',
    'comments',
    'shares',
    'saves',
  ] as const),
  follow_type: Object.freeze(['reach', 'follows_and_unfollows'] as const),
  contact_button_type: Object.freeze(['profile_links_taps'] as const),
});

/**
 * Media-level metrics. Validity depends on `media_product_type` — see
 * {@link MEDIA_METRIC_MATRIX} (CC-INS-2). (Note the account/media naming quirk
 * Meta keeps: account uses `saves`, media uses `saved`.)
 *
 * The first nine are the original post-2025 set. The rest were added
 * 2026-10-28 from Meta's media-insights reference *[verified 2026-10-28 —
 * Instagram Media Insights reference,
 * developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights]*;
 * which product types take each is in {@link MEDIA_METRIC_MATRIX}, and the
 * three `total_*` metrics are Facebook Login only ({@link FB_LOGIN_MEDIA_METRICS}).
 * None of them is in a default set, so a caller gets one only by naming it.
 * Retired names (`impressions`, `plays`, `clips_replays_count`,
 * `ig_reels_aggregated_all_plays_count`, `video_views`) are not, and never
 * were, in this list (CC-INS-7).
 */
export const MEDIA_METRICS = Object.freeze([
  'views',
  'reach',
  'likes',
  'comments',
  'saved',
  'shares',
  'total_interactions',
  'navigation',
  'replies',
  'reposts',
  'facebook_views',
  'crossposted_views',
  'reels_skip_rate',
  'ig_reels_avg_watch_time',
  'ig_reels_video_view_total_time',
  'link_clicks',
  'follows',
  'profile_visits',
  'profile_activity',
  'total_views',
  'total_likes',
  'total_comments',
] as const);
export type MediaMetric = (typeof MEDIA_METRICS)[number];

/**
 * Media metrics Meta serves on the Facebook-Login host (`fb-login`,
 * graph.facebook.com) only: "These total metrics are available for Instagram
 * API with Facebook Login only" *[verified 2026-10-28 — Instagram Media
 * Insights reference]*. They include engagement from promoted media. An
 * `ig-login` profile is refused before the call (CC-INS-31). That
 * graph.instagram.com really rejects them is
 * *[verify — live: `GET /{media-id}/insights?metric=total_views` on the Instagram-Login host]*.
 */
export const FB_LOGIN_MEDIA_METRICS: readonly MediaMetric[] = Object.freeze([
  'total_views',
  'total_likes',
  'total_comments',
]);

/**
 * The metric set requested when the caller names no metrics AND the product
 * type is unknown or unstated. It is the FEED/REELS row of
 * {@link MEDIA_DEFAULT_METRICS_BY_TYPE} verbatim; `getMediaInsights`
 * (`api/insights.ts`) prefers the row for a product type it recognises
 * (CC-INS-14).
 */
export const DEFAULT_MEDIA_METRICS: readonly MediaMetric[] = Object.freeze([
  'views',
  'reach',
  'likes',
  'comments',
  'saved',
  'shares',
  'total_interactions',
]);

/**
 * The metrics requested per `media_product_type` when the caller names none
 * (CC-INS-14). Deliberately narrower than {@link MEDIA_METRIC_MATRIX}: the
 * newer metrics are opt-in, because some fail the whole request on media they
 * do not fit (`crossposted_views` errors on a reel never shared to Facebook)
 * and the `total_*` ones are Path B only.
 */
export const MEDIA_DEFAULT_METRICS_BY_TYPE: Readonly<Record<string, readonly MediaMetric[]>> =
  Object.freeze({
    FEED: Object.freeze([
      'views',
      'reach',
      'likes',
      'comments',
      'saved',
      'shares',
      'total_interactions',
    ] as const),
    REELS: Object.freeze([
      'views',
      'reach',
      'likes',
      'comments',
      'saved',
      'shares',
      'total_interactions',
    ] as const),
    STORY: Object.freeze([
      'views',
      'reach',
      'replies',
      'shares',
      'total_interactions',
      'navigation',
    ] as const),
  });

/**
 * Which media metrics are valid per `media_product_type` (CC-INS-2). Keys are
 * the known Meta product types; an unknown type (Meta adds new ones — CC-DATA-6
 * open vocabulary) skips client validation and lets Meta be the authority.
 * Rows follow Meta's media metrics table *[verified 2026-10-28 — Instagram
 * Media Insights reference]*. Carousel children have no insights at all.
 */
export const MEDIA_METRIC_MATRIX: Record<string, readonly MediaMetric[]> = Object.freeze({
  FEED: Object.freeze([
    'views',
    'reach',
    'likes',
    'comments',
    'saved',
    'shares',
    'total_interactions',
    'reposts',
    'facebook_views',
    'follows',
    'profile_visits',
    'profile_activity',
    'total_views',
    'total_likes',
    'total_comments',
  ] as const),
  REELS: Object.freeze([
    'views',
    'reach',
    'likes',
    'comments',
    'saved',
    'shares',
    'total_interactions',
    'reposts',
    'facebook_views',
    'crossposted_views',
    'reels_skip_rate',
    'ig_reels_avg_watch_time',
    'ig_reels_video_view_total_time',
    'total_views',
    'total_likes',
    'total_comments',
  ] as const),
  STORY: Object.freeze([
    'views',
    'reach',
    'replies',
    'shares',
    'total_interactions',
    'navigation',
    'reposts',
    'facebook_views',
    'link_clicks',
    'follows',
    'profile_visits',
    'profile_activity',
    'total_views',
  ] as const),
});

/**
 * Media-insights `breakdown` dimensions, and the single metric each may be
 * sent with (CC-INS-31): `action_type` with `profile_activity`,
 * `story_navigation_action_type` with `navigation` *[verified 2026-10-28 —
 * Instagram Media Insights reference]*. Meta answers a breakdown on any other
 * metric with a generic error for the whole request, so that is refused first.
 */
export const MEDIA_BREAKDOWNS = Object.freeze([
  'action_type',
  'story_navigation_action_type',
] as const);
export type MediaBreakdown = (typeof MEDIA_BREAKDOWNS)[number];

/** The metrics each {@link MEDIA_BREAKDOWNS} dimension may be sent with. */
export const MEDIA_BREAKDOWN_METRICS: Readonly<Record<MediaBreakdown, readonly MediaMetric[]>> =
  Object.freeze({
    action_type: Object.freeze(['profile_activity'] as const),
    story_navigation_action_type: Object.freeze(['navigation'] as const),
  });

/** Audience-demographics metrics (docs/tools.md `get_audience_demographics`). */
export const DEMOGRAPHIC_METRICS = Object.freeze([
  'follower_demographics',
  'engaged_audience_demographics',
] as const);
export type DemographicMetric = (typeof DEMOGRAPHIC_METRICS)[number];

/** Demographics breakdown dimension (one per call). */
export const DEMOGRAPHIC_BREAKDOWNS = Object.freeze(['age', 'gender', 'city', 'country'] as const);
export type DemographicBreakdown = (typeof DEMOGRAPHIC_BREAKDOWNS)[number];

/** Demographics `timeframe` (required; replaces `since`/`until`). */
export const DEMOGRAPHIC_TIMEFRAMES = Object.freeze([
  'last_14_days',
  'last_30_days',
  'last_90_days',
  'prev_month',
  'this_month',
  'this_week',
] as const);
export type DemographicTimeframe = (typeof DEMOGRAPHIC_TIMEFRAMES)[number];

/** Aggregation period for account metrics. */
export const ACCOUNT_PERIODS = Object.freeze(['day', 'week', 'days_28'] as const);
export type AccountPeriod = (typeof ACCOUNT_PERIODS)[number];

/** `metric_type`: aggregated total vs per-interval series. */
export const METRIC_TYPES = Object.freeze(['total_value', 'time_series'] as const);
export type MetricType = (typeof METRIC_TYPES)[number];

/**
 * The account metrics Graph serves as a per-interval series (CC-INS-25).
 *
 * Meta's metrics table for `GET /{ig-id}/insights` lists `total_value` as the
 * ONLY metric type of every account metric in {@link ACCOUNT_METRICS} except
 * `reach`, which alone also takes `time_series` (the legacy `impressions` was
 * the other one). A `metric_type=time_series` request naming any other metric
 * is rejected by Graph as a whole, so it is refused before the call with the
 * valid set named, and the default metric set under `time_series` is this list
 * rather than all eleven — the same "default for the thing the caller named"
 * rule as CC-INS-14.
 */
export const TIME_SERIES_ACCOUNT_METRICS: readonly AccountMetric[] = Object.freeze(['reach']);

/** Account-metric retention window (docs/operations.md §4). */
export const RETENTION_DAYS = 90;

// NOTE: `follower_count` is a plausible post-2025 account metric but is a
// `[verify — live probe]` item in docs/workplan.md (T-D5); it is deliberately
// left out of ACCOUNT_METRICS until a live probe confirms it, so we never offer
// an unverified metric.

/**
 * CC-INS-2: refuse metrics that are invalid for a known `media_product_type`.
 * Unknown/omitted product types pass through (open vocabulary — CC-DATA-6);
 * Meta remains the final authority.
 *
 * Equivalent-mutant note: dropping the `=== ''` arm of the first guard changes
 * nothing. A blank string falls through to `MEDIA_METRIC_MATRIX['']`, which is
 * `undefined` (the matrix keys are FEED/REELS/STORY, and `''` is not on
 * `Object.prototype`), so the very next line returns anyway; `''.toUpperCase()`
 * cannot throw. The arm stays because it states the intent — "blank is the same
 * as absent" — at the guard rather than leaving it to a lookup miss two lines
 * down. Do not contort a test into "killing" it.
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

/**
 * CC-INS-31: refuse the Facebook-Login-only media metrics
 * ({@link FB_LOGIN_MEDIA_METRICS}) on any other auth path, before the call. An
 * omitted path is treated as Path A, the same rule `api/media.ts` applies to its
 * Path B fields: the smaller vocabulary is the one every token can use.
 */
export function validateMediaMetricsForPath(
  metrics: readonly MediaMetric[],
  authPath: AuthPath | undefined,
): void {
  if (authPath === 'fb-login') return;
  const refused = metrics.filter((m) => FB_LOGIN_MEDIA_METRICS.includes(m));
  if (refused.length > 0) {
    throw new InstagramError(
      `Metric(s) ${refused.join(', ')} are available with Instagram API with Facebook Login only (an fb-login profile); this profile's auth path is ${authPath ?? 'ig-login'}. Use views, likes or comments for the organic counts.`,
      { kind: 'permission' },
    );
  }
}

/**
 * CC-INS-31: refuse metrics that cannot be sent with `breakdown`. Graph fails
 * the whole request when one named metric does not support the breakdown, so
 * the caller is told which ones do instead of spending the call.
 */
export function validateBreakdownMetrics(
  metrics: readonly string[],
  breakdown: string,
  allowed: readonly string[],
): void {
  const invalid = metrics.filter((m) => !allowed.includes(m));
  if (invalid.length > 0) {
    throw new InstagramError(
      `Metric(s) ${invalid.join(', ')} cannot be broken down by ${breakdown}. Breakdown ${breakdown} is available only for: ${allowed.join(', ')}. Request the other metrics in a separate call without breakdown.`,
      { kind: 'validation' },
    );
  }
}
