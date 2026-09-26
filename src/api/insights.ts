/**
 * Insights domain (Layer 1). Read-only account + media insights, built on the
 * post-2025-01-08 metric set (views-centric; `impressions`/`video_views`/
 * `profile_views` are gone and never referenced). Pure functions over the
 * injected {@link IgRequestFn} seam — no `core/http`/`core/auth` imports.
 *
 * Corner cases owned here (docs/corner-cases.md §6). All eight rows of that
 * section are accounted for below, including the two this file does NOT decide,
 * so a reader can tell "not our problem" from "we forgot" (CC-PROC-192):
 *  - CC-INS-2: per-`media_product_type` metric matrix; invalid combos refused
 *    client-side with the valid set listed. The same matrix is what a caller who
 *    names a product type and no metrics is served by default (CC-INS-14).
 *  - CC-INS-3: `since`/`until` outside the 90-day retention are refused (fully
 *    out of window) or clamped + flagged (partially in window).
 *  - CC-INS-7: the metric vocabularies below contain only the post-2025 set,
 *    so legacy names are rejected at the tool's zod enum before any call.
 *  - CC-INS-8: CC-INS-3's refusal keys on the window's END alone, so the
 *    `since`-less "everything up to <date>" shape is refused here too instead of
 *    being spent on Graph and answered with an indistinguishable empty result.
 * The CC-INS-25..27 rows (docs/corner-cases.md) are the combination rules taken
 * from Meta's metrics table: `time_series` for `reach` only (25), a window
 * that must not end before it starts (26), and `period=lifetime` on the
 * demographics request (27).
 * CC-INS-1/5/6 are honest tool-description text + propagated `InstagramError`
 * from the mapping layer (`core/errors.ts`), not client-side logic here.
 * CC-INS-4 — which timezone Meta cuts the daily buckets in — is still open, and
 * it is open here in the strong sense: no timezone conversion happens anywhere
 * in this module. The caller's epochs go out as supplied (CC-INS-3's retention
 * clamp is the only value this file ever rewrites), so whatever a live call
 * settles lands in the tool descriptions, not in this layer.
 * The later CC-INS rows (9 onwards) sit in the post-M5 register rather than in
 * §6 and are cited at the individual sites they constrain.
 *
 * Metric availability can differ by auth path, but docs/tools.md marks none of
 * these tools path-specific, so the specs leave `ToolSpec.paths` undefined.
 */
import { InstagramError } from '../core/types.js';
import type { GraphPaging, IgRequestFn, IgRequestOptions } from '../core/types.js';

// --- Metric / period / breakdown vocabularies (post-2025 set) ---------------

/** Account-level metrics (docs/tools.md §insights `get_account_insights`). */
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
] as const);
export type AccountMetric = (typeof ACCOUNT_METRICS)[number];

/**
 * Media-level metrics. Validity depends on `media_product_type` — see
 * {@link MEDIA_METRIC_MATRIX} (CC-INS-2). `navigation`/`replies` are story-only.
 * (Note the account/media naming quirk Meta keeps: account uses `saves`, media
 * uses `saved`.)
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
] as const);
export type MediaMetric = (typeof MEDIA_METRICS)[number];

/**
 * The metric set requested when the caller names no metrics AND the product
 * type is unknown or unstated. It is the FEED/REELS row of
 * {@link MEDIA_METRIC_MATRIX} verbatim; {@link getMediaInsights} prefers the
 * matrix row for a product type it recognises (CC-INS-14).
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
 * Which media metrics are valid per `media_product_type` (CC-INS-2). Keys are
 * the known Meta product types; an unknown type (Meta adds new ones — CC-DATA-6
 * open vocabulary) skips client validation and lets Meta be the authority.
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
 * is rejected by Graph as a whole, so it is refused here with the valid set
 * named, and the default metric set under `time_series` is this list rather
 * than all eleven — the same "default for the thing the caller named" rule as
 * CC-INS-14.
 */
export const TIME_SERIES_ACCOUNT_METRICS: readonly AccountMetric[] = Object.freeze(['reach']);

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
 * The requested metric names Graph returned no row for, in request order.
 *
 * Graph answers a multi-metric insights call with one row per metric it has data
 * for and simply leaves the rest out — an account below a threshold, a metric
 * not yet computed for fresh media, a metric Meta stopped serving. Without this
 * list the model reads "no row for `shares`" as nothing at all, and a summary
 * built on the rows that did arrive states a partial picture as a whole one (or
 * worse, reports the gap as zero). A row counts only when it is an object whose
 * `name` is a string — the same test `tools/insights.ts` applies before it
 * publishes a row — so a metric whose row is unpublishable is reported missing
 * rather than silently vanishing between the two layers. A `data` that is not a
 * list (the body is a cast, not a proof) means every requested metric is missing.
 */
export function findMissingMetrics(requested: readonly string[], data: unknown): string[] {
  const returned = new Set<string>();
  if (Array.isArray(data)) {
    for (const row of data as unknown[]) {
      if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
        const name = (row as Record<string, unknown>).name;
        if (typeof name === 'string') returned.add(name);
      }
    }
  }
  return requested.filter((m) => !returned.has(m));
}

/** The note published beside a non-empty {@link findMissingMetrics} list. */
export function missingMetricsNote(missing: readonly string[]): string {
  return (
    `Instagram returned no data for the requested metric(s): ${missing.join(', ')}. ` +
    'They are absent from metrics, not zero.'
  );
}

/** Query parameters that carry a credential and never belong in a result. */
const CREDENTIAL_PARAMS = ['access_token', 'appsecret_proof'] as const;

/**
 * Strip credentials out of a Graph `paging` block before it is returned.
 *
 * Graph's `paging.next` / `paging.previous` are complete request URLs, and Graph
 * builds them from the request it was sent — `access_token` and, with an app
 * secret configured, `appsecret_proof` included. The account-insights result
 * hands `paging` back as delivered, so without this the operator's token would
 * ride into the model's context inside a URL. The registry's result redactor
 * masks known token shapes on the way out, but that is the last line, not the
 * only one: this layer knows exactly which parameters are credentials and has no
 * reason to pass them up at all. Only a string that parses as a URL AND carries
 * one of those parameters is rewritten; anything else (cursors, a non-URL
 * string, a non-object `paging`) is returned untouched, and the block is copied
 * rather than mutated.
 */
export function sanitizePaging(paging: unknown): unknown {
  if (typeof paging !== 'object' || paging === null || Array.isArray(paging)) return paging;
  const out: Record<string, unknown> = { ...(paging as Record<string, unknown>) };
  for (const key of ['next', 'previous']) {
    const value = out[key];
    if (typeof value !== 'string') continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (!CREDENTIAL_PARAMS.some((p) => url.searchParams.has(p))) continue;
    for (const p of CREDENTIAL_PARAMS) url.searchParams.delete(p);
    out[key] = url.toString();
  }
  return out;
}

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
 * The note published beside {@link findMissingMetrics} when the metric list
 * itself was unreadable (CC-INS-22): every requested metric is then unknown,
 * which is not the same fact as Instagram having no row for it.
 */
export function unreadableMetricsNote(missing: readonly string[]): string {
  return (
    'Instagram returned the metric list in a shape that is not a list, so none of the ' +
    `requested metric(s) could be read: ${missing.join(', ')}. They are unknown, not zero.`
  );
}

/** One insights answer as far as it could be read (see {@link readInsightsBody}). */
interface InsightsRead {
  /** The rows of `data`; empty for an absent or unreadable `data`. */
  rows: InsightMetric[];
  /** True when `data` was present but not a list (`null` included). */
  unreadable: boolean;
  /** The wire `paging`, as delivered (not yet sanitised). */
  paging: unknown;
}

/**
 * The cast wire body of an insights read -> its rows, and whether they could be
 * read at all.
 *
 * `req` casts the body rather than validating it, so a `GraphListResponse`'s
 * `data: T[]` promises nothing. A body that is not an object at all (JSON `null`, a number,
 * a text body, a list) is no insights answer, and is refused as a malformed one
 * — the same `upstream` refusal `get_account` and `get_comment` give
 * (CC-DATA-83..85, CC-DATA-86). `null` used to throw a raw TypeError on
 * `.data`, whose engine text reached the caller, and a scalar or a list read as
 * an answer that simply had no rows.
 *
 * An object with no `data` is Graph's empty answer and reads as no rows, as
 * before (CC-INS-17). A `data` that is present but not a list — `null`
 * included — is the CC-DATA-69/CC-DATA-81 rule: it is said, not passed off as an
 * empty result. It used to be handed up as `metrics` untouched (an object where
 * the type says list) and its metrics reported as "no data, absent, not zero",
 * which states an unreadable answer as a known one (CC-INS-22). The call
 * still survives — `paging` may be perfectly good — with `metrics: []`, every
 * requested metric in `missingMetrics`, and {@link unreadableMetricsNote}.
 */
function readInsightsBody(body: unknown): InsightsRead {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InstagramError('Instagram returned no insights object. Retry later.', {
      kind: 'upstream',
    });
  }
  const wire = body as { data?: unknown; paging?: unknown };
  const data = wire.data;
  if (data === undefined) return { rows: [], unreadable: false, paging: wire.paging };
  if (!Array.isArray(data)) return { rows: [], unreadable: true, paging: wire.paging };
  return { rows: data as InsightMetric[], unreadable: false, paging: wire.paging };
}

/**
 * The requested metrics that cannot be read off `read`, and the note that says
 * why: all of them with {@link unreadableMetricsNote} when the list itself was
 * unreadable, else the rowless ones with {@link missingMetricsNote}.
 */
function missingFrom(
  requested: readonly string[],
  read: InsightsRead,
): { missing: string[]; note: string } | undefined {
  const missing = findMissingMetrics(requested, read.rows);
  if (missing.length === 0) return undefined;
  return {
    missing,
    note: read.unreadable ? unreadableMetricsNote(missing) : missingMetricsNote(missing),
  };
}

/**
 * Attach `missingMetrics` and its `note` to a result that has no `notes` list.
 * Both keys are set only when something is missing, never as `undefined`.
 */
function withMissing<T extends { missingMetrics?: string[]; note?: string }>(
  result: T,
  requested: readonly string[],
  read: InsightsRead,
): T {
  const gap = missingFrom(requested, read);
  if (gap !== undefined) {
    result.missingMetrics = gap.missing;
    result.note = gap.note;
  }
  return result;
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
  /** Requested metrics with no row in `metrics`; present only when non-empty. */
  missingMetrics?: string[];
}

export async function getAccountInsights(
  req: IgRequestFn,
  params: AccountInsightsParams,
): Promise<AccountInsightsResult> {
  const accountId = requireAccountId(params.accountId);
  // Equivalent-mutant note: `??` and `||` are indistinguishable at every one of
  // the five param `??` sites in this module — this one, `period`/`metric_type`
  // below, and the metric defaults in {@link getMediaInsights} and
  // {@link getAudienceDemographics}. The two operators differ only on falsy
  // non-nullish operands, and no such value reaches any of these expressions:
  // the caller's value has been through the tool layer's schema, so it is an
  // array or a member of a string union that does not contain `''`. (The four
  // `res.data ?? []` fallbacks this note used to cover are gone: a wire `data`
  // is now judged by {@link readInsightsBody}, where a `data: ''` is exactly
  // what separates "absent" from "unreadable".)
  //
  // `??` stays because the rule meant everywhere here is "only an ABSENT value
  // falls back"; an empty array is truthy, so `||` would swallow nothing here
  // that `??` keeps. Do not contort a test into 'killing' any of them.
  const metricType = params.metricType ?? 'total_value';
  const metrics =
    params.metrics ??
    (metricType === 'time_series' ? TIME_SERIES_ACCOUNT_METRICS : ACCOUNT_METRICS);
  // CC-INS-25: only `reach` is served as a time series. The whole request
  // would otherwise be spent and rejected by Graph for the other metrics in it.
  if (metricType === 'time_series') {
    const invalid = metrics.filter((m) => !TIME_SERIES_ACCOUNT_METRICS.includes(m));
    if (invalid.length > 0) {
      throw new InstagramError(
        `Metric(s) ${invalid.join(', ')} are not available with metric_type time_series. Instagram serves a time series only for: ${TIME_SERIES_ACCOUNT_METRICS.join(', ')}. Request the other metrics with metric_type total_value.`,
        { kind: 'validation' },
      );
    }
  }
  const notes: string[] = [];

  let since = params.since;
  const until = params.until;
  let clamped = false;

  // CC-INS-26: a window that ends before it starts holds nothing. It is
  // refused before the call, not spent on Graph and answered with an empty
  // result that reads like an account with no activity. Equal bounds are a
  // valid one-instant window (Meta's range is inclusive).
  if (since !== undefined && until !== undefined && since > until) {
    throw new InstagramError(
      `\`since\` (${since}) is after \`until\` (${until}); the insights window must start before it ends.`,
      { kind: 'validation' },
    );
  }

  // CC-INS-3: 90-day retention. Refuse a window entirely in the past; clamp a
  // window that only partially reaches back before the floor.
  //
  // This arm used to carry an equivalent-mutant note claiming that dropping it
  // is unobservable, because `Math.floor(undefined / 1000)` is `NaN` and every
  // `<` against `NaN` is false. Measured 2026-09-23: that reasoning describes a
  // program TypeScript will not build. `params.nowMs` is `number | undefined`,
  // so deleting the check is not an edit the compiler lets through — it is
  // `error TS18048: 'params.nowMs' is possibly 'undefined'`, and the mutant it
  // excuses was never stageable in the first place (CC-PROC-192).
  //
  // The stageable neighbour is the arm dropped together with a `?? Date.now()`
  // default, and that one is a real behaviour change: a caller who supplies no
  // clock would have its window judged against the machine's wall clock, which
  // is exactly the rule this arm exists to refuse. Held by "a clock-less call
  // runs no retention logic at all, whatever the epochs say" rather than argued
  // about. The rule itself is unchanged: leaning on NaN comparison semantics to
  // switch a validation off is a booby trap, because the first branch added here
  // that uses `>=`, `!==` or `isNaN` would start firing on every clock-less call.
  if (params.nowMs !== undefined && (since !== undefined || until !== undefined)) {
    // `Math.floor` is load-bearing: `nowMs` is wall-clock milliseconds, so a
    // plain division yields a fractional epoch that would be clamped INTO
    // `window.since` and serialised into the query string as `1699...5`.
    const floor = Math.floor(params.nowMs / 1000) - RETENTION_SECONDS;
    // The END of the window decides whether anything is left to fetch: if
    // `until` is already older than the floor, the range holds no retained data
    // whatever `since` says — including the `since`-less "everything up to
    // <date>" shape, which Graph would answer with a silent empty result.
    if (until !== undefined && until < floor) {
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
    path: `/${encodeURIComponent(accountId)}/insights`,
    params: {
      metric: metrics.join(','),
      period: params.period ?? 'day',
      metric_type: metricType,
      since,
      until,
    },
  };
  const read = readInsightsBody(await req<unknown>(opts));
  const result: AccountInsightsResult = {
    metrics: read.rows,
    window: { since, until, clamped },
    notes,
    paging: sanitizePaging(read.paging) as GraphPaging | undefined,
  };
  const gap = missingFrom(metrics, read);
  if (gap !== undefined) {
    result.missingMetrics = gap.missing;
    notes.push(gap.note);
  }
  return result;
}

// --- Media insights ---------------------------------------------------------

export interface MediaInsightsParams {
  mediaId: string;
  /**
   * When omitted, the {@link MEDIA_METRIC_MATRIX} row for `mediaProductType` is
   * requested if that type is recognised, and {@link DEFAULT_MEDIA_METRICS}
   * otherwise (CC-INS-14).
   */
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
  /** Requested metrics with no row in `metrics`; present only when non-empty. */
  missingMetrics?: string[];
  /** {@link missingMetricsNote} for `missingMetrics`; present with it. */
  note?: string;
}

export async function getMediaInsights(
  req: IgRequestFn,
  params: MediaInsightsParams,
): Promise<MediaInsightsResult> {
  // CC-INS-14: the default is the set valid for THIS product type. Defaulting to
  // the feed set for everything made `getMediaInsights({ mediaProductType:
  // 'STORY' })` with no `metrics` throw a client-side validation error every
  // time, because the feed set carries `likes`, `comments` and `saved` and the
  // STORY row does not — the tool description tells the caller that naming the
  // product type buys an early refusal of INVALID combinations, not a refusal of
  // the combination the api layer itself chose. A recognised type takes its own
  // row; an unrecognised or unstated one (CC-DATA-6 open vocabulary) falls
  // through to the feed set exactly as before, and the FEED/REELS rows are
  // element-for-element identical to it, so STORY is the only behaviour change.
  const metrics =
    params.metrics ??
    MEDIA_METRIC_MATRIX[params.mediaProductType?.toUpperCase() ?? ''] ??
    DEFAULT_MEDIA_METRICS;
  validateMediaMetrics(metrics, params.mediaProductType);
  const read = readInsightsBody(
    await req<unknown>({
      method: 'GET',
      path: `/${encodeURIComponent(params.mediaId)}/insights`,
      params: { metric: metrics.join(',') },
    }),
  );
  return withMissing<MediaInsightsResult>(
    { mediaId: params.mediaId, metrics: read.rows },
    metrics,
    read,
  );
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
  /** Requested metrics with no row in `metrics`; present only when non-empty. */
  missingMetrics?: string[];
  /** {@link missingMetricsNote} for `missingMetrics`; present with it. */
  note?: string;
}

export async function getAudienceDemographics(
  req: IgRequestFn,
  params: AudienceDemographicsParams,
): Promise<AudienceDemographicsResult> {
  const accountId = requireAccountId(params.accountId);
  const metrics = params.metrics ?? (['follower_demographics'] as const);
  const read = readInsightsBody(
    await req<unknown>({
      method: 'GET',
      path: `/${encodeURIComponent(accountId)}/insights`,
      params: {
        metric: metrics.join(','),
        // CC-INS-27: Meta's reference marks `period` required and lists
        // `lifetime` as the only period of both demographics metrics.
        period: 'lifetime',
        metric_type: 'total_value',
        breakdown: params.breakdown,
        timeframe: params.timeframe,
      },
    }),
  );
  return withMissing<AudienceDemographicsResult>(
    { metrics: read.rows, breakdown: params.breakdown, timeframe: params.timeframe },
    metrics,
    read,
  );
}

// --- Online followers -------------------------------------------------------

export interface OnlineFollowersParams {
  accountId?: string;
}

export interface OnlineFollowersResult {
  metrics: InsightMetric[];
  /** `['online_followers']` when Graph returned no row for it; else absent. */
  missingMetrics?: string[];
  /** {@link missingMetricsNote} for `missingMetrics`; present with it. */
  note?: string;
}

export async function getOnlineFollowers(
  req: IgRequestFn,
  params: OnlineFollowersParams,
): Promise<OnlineFollowersResult> {
  const accountId = requireAccountId(params.accountId);
  const read = readInsightsBody(
    await req<unknown>({
      method: 'GET',
      path: `/${encodeURIComponent(accountId)}/insights`,
      params: { metric: 'online_followers', period: 'lifetime' },
    }),
  );
  return withMissing<OnlineFollowersResult>({ metrics: read.rows }, ['online_followers'], read);
}
