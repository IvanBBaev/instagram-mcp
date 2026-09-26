/**
 * `insights` package tool specs (Layer 3). Four read-only tools over the
 * post-2025 metric set. Each is a {@link ToolSpec} (tools-as-data); the handler
 * calls the `api/insights.ts` domain function with `ctx.req` and shapes the
 * result via `mcp/result.ts`. InstagramError from the api/mapping layer is left
 * to propagate — the registry renders it.
 *
 * docs/tools.md marks none of these path-specific, so `paths` is left undefined
 * (both auth paths) on every spec.
 */
import { z } from 'zod';
import { graphObjectId } from './ids.js';
import { defineTool } from '../mcp/define.js';
import type { ToolSpec } from '../mcp/define.js';
import { json } from '../mcp/result.js';
import {
  getAccountInsights,
  getAudienceDemographics,
  getMediaInsights,
  getOnlineFollowers,
  ACCOUNT_METRICS,
  ACCOUNT_PERIODS,
  DEMOGRAPHIC_BREAKDOWNS,
  DEMOGRAPHIC_METRICS,
  DEMOGRAPHIC_TIMEFRAMES,
  MEDIA_METRICS,
  METRIC_TYPES,
  RETENTION_DAYS,
  TIME_SERIES_ACCOUNT_METRICS,
} from '../api/insights.js';

const PACKAGE = 'insights';

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * Permissive structuredContent shape for one metric row: known post-2025 fields
 * declared, unknown ones passed through so additive Meta changes never break
 * structured output (CC-DATA-7).
 *
 * Permissive about UNKNOWN keys is not the same as permissive about the declared
 * ones: `name` is required and the rest are typed, and this schema is enforced on
 * the way out. {@link metricRows} is what keeps a row that violates it from
 * failing the whole call (CC-INS-15).
 */
const insightMetricOutput = z
  .object({
    name: z.string(),
    period: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    id: z.string().optional(),
    values: z.array(z.record(z.unknown())).optional(),
    total_value: z.record(z.unknown()).optional(),
    omittedValues: z
      .number()
      .int()
      .optional()
      .describe(
        'How many intervals Instagram sent in values that were unreadable and left out (a ' +
          'values that is not a list counts as one); values then covers less than the whole ' +
          'period, or is missing, so a sum over it is partial.',
      ),
    omittedTotalValues: z
      .number()
      .int()
      .optional()
      .describe(
        'How many measurements Instagram sent in total_value (its value, a breakdown, or one ' +
          'breakdown result) that were unreadable and left out; the total or a sum over the ' +
          'breakdowns is then partial or missing.',
      ),
  })
  .passthrough();

// --- Publishable values ----------------------------------------------------
//
// Everything below exists for one reason: `api/insights.ts` CASTS the Graph body
// (`core/host` says so outright), so `InsightMetric.name: string` means no more
// than "whatever Meta put in the JSON". The four handlers publish `metrics`
// against {@link insightMetricOutput}, and one row whose `name` is missing, or
// whose `values` is not a list of objects, fails structured-output validation and
// takes the WHOLE call down as `MCP error -32602` — the caller gets a protocol
// error instead of the other nineteen metrics that were perfectly fine
// (CC-INS-15). `metrics` and `paging` are the only two fields any of the four
// results takes off the wire; `window`, `notes`, `mediaId`, `breakdown`,
// `timeframe`, `missingMetrics` and `note` are computed by the api layer from
// already-validated inputs, so they need no re-check. (`paging` has already had
// its credential parameters stripped there.)

/**
 * True for a non-null, non-array object.
 *
 * Deliberately a third private copy: `mcp/result.ts` and `tools/discovery.ts`
 * each carry their own. The predicate is four tokens long and exporting it would
 * make a Layer-3 tool module a dependency of Layer 2; the same open owner
 * decision that leaves `core/errors.ts` and `core/redact.ts` with duplicate token
 * lists applies here (CC-PROC-19), and it is not mine to settle unilaterally.
 *
 * `z.record(z.unknown())` — what `values[]`, `total_value` and `paging` are
 * declared as — rejects `null` and an array for exactly the same reasons, so this
 * guard and that schema agree on every input by construction.
 */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `Array.isArray` with the element type `unknown` rather than `any`. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** A finite JSON number — the only readable measurement. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * An interval a caller can read a measurement from: an object whose `value` is a
 * finite number (a time series or a count) or a map of finite numbers (a
 * per-hour or per-bucket map, as `online_followers` sends). An interval whose
 * `value` is absent, `null` or a string passed the object check and was
 * published as if it were data — a model summing the series then folded a
 * `null` in as nothing, or concatenated a string, and stated a partial total as
 * the whole period's. Such an interval is left out and counted like any other
 * unreadable one (CC-INS-18).
 *
 * The map's members are held to the same rule as the scalar (CC-INS-23): any
 * object used to pass, so `{ "0": "12", "1": null }` was published as an hourly
 * distribution — the `Record<string, number>` `InsightValue` declares — and a
 * model reading "when are my followers online" summed a string and a null into
 * it. A map with one unreadable member is unreadable as a whole, not trimmed:
 * an hour quietly missing from a distribution is the partial-total defect over
 * again, and `omittedValues` can only count whole intervals. An empty map lost
 * nothing and stays readable, as an empty `total_value` does.
 */
function isReadableInterval(value: unknown): value is Record<string, unknown> {
  if (!isRecordObject(value)) return false;
  const v = value.value;
  return isFiniteNumber(v) || (isRecordObject(v) && Object.values(v).every(isFiniteNumber));
}

/** One breakdown result a caller can read: its bucket names and a finite count. */
function isReadableBreakdownResult(value: unknown): boolean {
  if (!isRecordObject(value)) return false;
  const dims = value.dimension_values;
  return (
    isFiniteNumber(value.value) && isUnknownArray(dims) && dims.every((d) => typeof d === 'string')
  );
}

/**
 * A metric's `total_value` -> what can be published of it, and how many of its
 * measurements could not be.
 *
 * `total_value` was published whenever it was an object, so a `value` of `null`
 * or `'12'`, or a demographic bucket whose count was not a number, reached the
 * caller as data — the same defect CC-INS-19 closed for `values[]`. Each
 * measurement is judged on its own and the unreadable ones are counted: the
 * scalar `value`, a `breakdowns` entry with no readable `results` list (or a
 * `breakdowns` that is not a list at all), and each result without a finite
 * `value` and string `dimension_values`. A `total_value` that is present but not
 * an object counts as one. An object that lost measurements and has no readable
 * one left is dropped whole, additive keys included, rather than published as a
 * total that exists; one that was sent empty lost nothing and is kept as it was.
 */
function totalValue(raw: unknown): { kept?: Record<string, unknown>; omitted: number } {
  if (raw === undefined) return { omitted: 0 };
  if (!isRecordObject(raw)) return { omitted: 1 };
  const tv: Record<string, unknown> = { ...raw };
  let omitted = 0;
  let readableResults = 0;
  if (tv.value !== undefined && !isFiniteNumber(tv.value)) {
    delete tv.value;
    omitted += 1;
  }
  const breakdowns = tv.breakdowns;
  if (isUnknownArray(breakdowns)) {
    const kept: Record<string, unknown>[] = [];
    for (const entry of breakdowns) {
      if (!isRecordObject(entry) || !isUnknownArray(entry.results)) {
        omitted += 1;
        continue;
      }
      const results = entry.results.filter(isReadableBreakdownResult);
      omitted += entry.results.length - results.length;
      readableResults += results.length;
      kept.push({ ...entry, results });
    }
    tv.breakdowns = kept;
  } else if (breakdowns !== undefined) {
    delete tv.breakdowns;
    omitted += 1;
  }
  if (omitted > 0 && tv.value === undefined && readableResults === 0) return { omitted };
  return { kept: tv, omitted };
}

/**
 * Keep a string field only when the wire really sent a string, else drop it.
 *
 * Every field this touches is `.optional()` on {@link insightMetricOutput}, so
 * dropping the one bad field costs the caller that field and nothing else — the
 * row keeps its `name` and the page keeps the row. Mirrors `stringField` in
 * `tools/discovery.ts`; these are never fenced because none of them is
 * third-party prose — `period`, `title` and `description` are Meta's own metric
 * vocabulary and `id` is spent on the next call, not read.
 */
function stringField(rec: Record<string, unknown>, key: string): void {
  if (typeof rec[key] !== 'string') delete rec[key];
}

/**
 * One untrusted metric object -> a publishable row. Additive Meta fields ride
 * along untouched (CC-DATA-7 — the schema is `.passthrough()`); every field the
 * schema names is re-checked against the type it promises.
 *
 * `values` is filtered rather than dropped whole: a time series with one
 * degenerate interval is still a time series, and the same "lose the entry, not
 * the page" rule `tools/discovery.ts` applies to media entries applies to
 * intervals. A `values` that is not a list at all has no salvageable part and
 * goes — and is counted as one omitted interval, as a non-object `total_value`
 * counts as one omitted measurement (CC-INS-24). It used to go silently, so
 * `{ name: 'reach', values: null }` was published as a bare `{ name: 'reach' }`:
 * a row that arrived, is not in `missingMetrics`, and says nothing about having
 * lost its only measurement. An ABSENT `values` is a row that sent none and
 * stays silent.
 *
 * The filtered intervals are COUNTED in `omittedValues` (CC-INS-18): a model
 * that sums or averages the series it was handed would otherwise report a
 * total over fewer intervals than Instagram sent as the whole period. A wire
 * field of that name is removed first, so the count is always ours — and one of
 * the wrong type could not fail the call's output validation either.
 */
function metricRow(m: Record<string, unknown>): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...m };
  stringField(rec, 'period');
  stringField(rec, 'title');
  stringField(rec, 'description');
  stringField(rec, 'id');
  delete rec.omittedValues;
  const values = rec.values;
  if (isUnknownArray(values)) {
    const kept = values.filter(isReadableInterval);
    rec.values = kept;
    if (kept.length < values.length) rec.omittedValues = values.length - kept.length;
  } else if (values !== undefined) {
    delete rec.values;
    rec.omittedValues = 1;
  }
  delete rec.omittedTotalValues;
  const total = totalValue(rec.total_value);
  if (total.kept === undefined) delete rec.total_value;
  else rec.total_value = total.kept;
  if (total.omitted > 0) rec.omittedTotalValues = total.omitted;
  return rec;
}

/**
 * The wire's `data` -> the publishable `metrics` array.
 *
 * A row is dropped, not repaired, when it is not an object or its `name` is not a
 * string: `name` is the only required field on {@link insightMetricOutput} and
 * there is no honest value to invent for it — a row nobody can name is a row
 * nobody can read. A `data` that is not an array at all (Graph has been observed
 * to answer an object where the type says list) never gets here: `api/insights.ts`
 * turns it into an empty `metrics` list and says so in its note
 * (CC-INS-22), so the rows are always a list — of untrusted elements.
 */
function metricRows(value: readonly unknown[]): Record<string, unknown>[] {
  return value
    .filter((row): row is Record<string, unknown> => isRecordObject(row))
    .filter((row) => typeof row.name === 'string')
    .map(metricRow);
}

/**
 * Make one api-layer result publishable. Shared by all four handlers because all
 * four publish `metrics` against the same schema and only the account tool also
 * carries `paging` — a `paging` that never existed is not deleted into existence,
 * and `metrics` is normalized the same way for every tool (CC-INS-15).
 *
 * Takes an already-spread copy so the api-layer result the caller holds is not
 * mutated, and so the interface -> index-signature widening happens at the call
 * site where TypeScript will do it implicitly.
 */
function publishable(out: Record<string, unknown>): Record<string, unknown> {
  out.metrics = metricRows(out.metrics as readonly unknown[]);
  if ('paging' in out && !isRecordObject(out.paging)) delete out.paging;
  return out;
}

// --- instagram_get_account_insights ----------------------------------------

// Every `metrics` array below is `.min(1)`. The api layer substitutes its
// default only for an ABSENT list (`params.metrics ?? DEFAULT`), so an empty one
// went out as `metric=` — a Graph call spent on a request that names nothing to
// measure. Omit the argument to get the default set.
const accountInsightsInput = {
  metrics: z
    .array(z.enum(ACCOUNT_METRICS))
    .min(1)
    .optional()
    .describe(
      `Account metrics to fetch (post-2025 set). Defaults to all of: ${ACCOUNT_METRICS.join(', ')}; with metric_type "time_series" it defaults to ${TIME_SERIES_ACCOUNT_METRICS.join(', ')}. Legacy names (impressions, profile_views, video_views) no longer exist and are rejected.`,
    ),
  period: z.enum(ACCOUNT_PERIODS).optional().describe('Aggregation period. Defaults to "day".'),
  metric_type: z
    .enum(METRIC_TYPES)
    .optional()
    .describe(
      `Return an aggregated "total_value" (default) or a per-interval "time_series". Instagram serves "time_series" only for: ${TIME_SERIES_ACCOUNT_METRICS.join(', ')}; any other metric with it is refused.`,
    ),
  since: z
    .number()
    .int()
    .optional()
    .describe(
      `Range start as a Unix timestamp in seconds. Omit for Meta's default 24h lookback. Data older than the ${RETENTION_DAYS}-day retention window is not available — a partially-old range is clamped and flagged; a fully-old range is rejected.`,
    ),
  until: z
    .number()
    .int()
    .optional()
    .describe(
      'Range end as a Unix timestamp in seconds. Omit for the default 24h lookback. Must not be before since.',
    ),
};

const accountInsightsTool = defineTool({
  name: 'instagram_get_account_insights',
  title: 'Get account insights',
  description:
    "Account-level insights for the operated Instagram professional account (GET /{ig-id}/insights). Uses the post-2025 views-centric metric set. Returns aggregated totals by default; time ranges are bounded by Meta's 90-day retention. A requested metric Instagram returned no data for is listed in missingMetrics and explained in notes; it is absent, not zero. Credentials are stripped from the paging URLs.",
  package: PACKAGE,
  annotations: readOnly,
  input: accountInsightsInput,
  output: {
    metrics: z.array(insightMetricOutput),
    window: z
      .object({
        since: z.number().optional(),
        until: z.number().optional(),
        clamped: z.boolean(),
      })
      .passthrough(),
    notes: z.array(z.string()),
    paging: z.record(z.unknown()).optional(),
    missingMetrics: z.array(z.string()).optional(),
  },
  logFields: (args) => ({
    // Equivalent-mutant note: `??` and `||` are indistinguishable on this
    // operand, here and in the two sibling logFields below. The registry
    // strict-parses the arguments before `logFields` ever runs, so `args.metrics`
    // is only ever a metric array or `undefined`; the two operators differ solely
    // on falsy non-nullish values (`''`, `0`, `false`, `NaN`), and an empty array
    // is truthy — and `.min(1)` refuses `metrics: []` before this runs anyway —
    // so both spellings log the array itself or `'default'` for an omitted one.
    // No difference is observable through the result, the outgoing request or
    // the audit line, so do not contort a test into 'killing' it.
    metrics: args.metrics ?? 'default',
    period: args.period,
    metric_type: args.metric_type,
    since: args.since,
    until: args.until,
  }),
  handler: async (args, ctx) => {
    const result = await getAccountInsights(ctx.req, {
      accountId: ctx.profile.accountId,
      metrics: args.metrics,
      period: args.period,
      metricType: args.metric_type,
      since: args.since,
      until: args.until,
      nowMs: ctx.clock.now(),
    });
    return json(publishable({ ...result }), { pretty: ctx.settings.prettyJson });
  },
});

// --- instagram_get_media_insights ------------------------------------------

const mediaInsightsInput = {
  media_id: graphObjectId().describe('The media object ID to fetch insights for.'),
  // CC-INS-14: the default is per-product-type, so the description has to be too
  // — a model that reads "defaults to <the feed set>" and then names a story has
  // been told that the call it is about to make is the one that used to come
  // back as a client-side refusal.
  metrics: z
    .array(z.enum(MEDIA_METRICS))
    .min(1)
    .optional()
    .describe(
      'Media metrics to fetch. Defaults to the set valid for the media: views, reach, likes, comments, saved, shares, total_interactions for a feed post or a reel, and views, reach, replies, shares, total_interactions, navigation when media_product_type is STORY. An absent or unrecognized media_product_type gets the feed set. Validity depends on the media type: "navigation" and "replies" are story-only and are refused for feed posts and reels.',
    ),
  media_product_type: z
    .string()
    .optional()
    .describe(
      'Optional product-type hint (known values: FEED, REELS, STORY; obtainable from instagram_get_media). When supplied and recognized, it selects the default metric set for that type and invalid metric/type combinations are refused before the call is spent.',
    ),
};

const mediaInsightsTool = defineTool({
  name: 'instagram_get_media_insights',
  title: 'Get media insights',
  description:
    'Insights for a single media object (GET /{media-id}/insights). The valid metric set varies by media_product_type; supply media_product_type to have invalid combinations rejected client-side. Insights on media created before the account became professional, or on an expired story, may return empty or error. A requested metric Instagram returned no data for is listed in missingMetrics and explained in note; it is absent, not zero.',
  package: PACKAGE,
  annotations: readOnly,
  input: mediaInsightsInput,
  output: {
    mediaId: z.string(),
    metrics: z.array(insightMetricOutput),
    missingMetrics: z.array(z.string()).optional(),
    note: z.string().optional(),
  },
  logFields: (args) => ({
    media_id: args.media_id,
    metrics: args.metrics ?? 'default',
    media_product_type: args.media_product_type,
  }),
  handler: async (args, ctx) => {
    const result = await getMediaInsights(ctx.req, {
      mediaId: args.media_id,
      metrics: args.metrics,
      mediaProductType: args.media_product_type,
    });
    return json(publishable({ ...result }), { pretty: ctx.settings.prettyJson });
  },
});

// --- instagram_get_audience_demographics -----------------------------------

const audienceDemographicsInput = {
  metrics: z
    .array(z.enum(DEMOGRAPHIC_METRICS))
    .min(1)
    .optional()
    .describe(
      'Which demographic populations to fetch. Defaults to ["follower_demographics"]; "engaged_audience_demographics" describes the accounts that engaged.',
    ),
  breakdown: z
    .enum(DEMOGRAPHIC_BREAKDOWNS)
    .describe('The single dimension to break the demographics down by.'),
  timeframe: z
    .enum(DEMOGRAPHIC_TIMEFRAMES)
    .describe(
      'Required. The window the demographics are computed over (demographics use timeframe, not since/until). Requires an account with at least 100 followers.',
    ),
};

const audienceDemographicsTool = defineTool({
  name: 'instagram_get_audience_demographics',
  title: 'Get audience demographics',
  description:
    'Follower / engaged-audience demographics for the operated account (GET /{ig-id}/insights with metric_type=total_value). Requires a timeframe and an account with at least 100 followers; below that threshold Meta returns an error naming the 100-follower rule. A requested metric Instagram returned no data for is listed in missingMetrics and explained in note; it is absent, not zero.',
  package: PACKAGE,
  annotations: readOnly,
  input: audienceDemographicsInput,
  output: {
    metrics: z.array(insightMetricOutput),
    breakdown: z.string(),
    timeframe: z.string(),
    missingMetrics: z.array(z.string()).optional(),
    note: z.string().optional(),
  },
  logFields: (args) => ({
    metrics: args.metrics ?? 'default',
    breakdown: args.breakdown,
    timeframe: args.timeframe,
  }),
  handler: async (args, ctx) => {
    const result = await getAudienceDemographics(ctx.req, {
      accountId: ctx.profile.accountId,
      metrics: args.metrics,
      breakdown: args.breakdown,
      timeframe: args.timeframe,
    });
    return json(publishable({ ...result }), { pretty: ctx.settings.prettyJson });
  },
});

// --- instagram_get_online_followers ----------------------------------------

const onlineFollowersInput = {};

const onlineFollowersTool = defineTool({
  name: 'instagram_get_online_followers',
  title: 'Get online followers',
  description:
    'Hourly distribution of when the account\'s followers are online (GET /{ig-id}/insights?metric=online_followers&period=lifetime). Data covers the last 30 days only. This metric is on the deprecation watch-list (present in the legacy reference, absent from the current docs tree) and may return a "metric no longer available" error in future API versions. When Instagram returns no online_followers data, missingMetrics and note say so rather than an empty metrics list standing alone.',
  package: PACKAGE,
  annotations: readOnly,
  input: onlineFollowersInput,
  output: {
    metrics: z.array(insightMetricOutput),
    missingMetrics: z.array(z.string()).optional(),
    note: z.string().optional(),
  },
  handler: async (_args, ctx) => {
    const result = await getOnlineFollowers(ctx.req, {
      accountId: ctx.profile.accountId,
    });
    return json(publishable({ ...result }), { pretty: ctx.settings.prettyJson });
  },
});

/**
 * The `insights` package tool surface (docs/tools.md §insights).
 *
 * `as unknown as ToolSpec[]`: `ToolSpec<ConcreteShape>` is not assignable to
 * `ToolSpec<ZodRawShape>` because `handler`/`logFields` are contravariant in the
 * input shape (a concrete handler cannot accept an arbitrary raw-shape arg). The
 * per-tool arg typing is still fully checked at each `defineTool` call site; the
 * cast only widens for the aggregate array. Matches `mediaTools` (T-D2).
 */
export const insightsTools: readonly ToolSpec[] = Object.freeze([
  accountInsightsTool,
  mediaInsightsTool,
  audienceDemographicsTool,
  onlineFollowersTool,
] as unknown as ToolSpec[]);
