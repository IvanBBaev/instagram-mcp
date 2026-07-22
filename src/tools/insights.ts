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
} from '../api/insights.js';

const PACKAGE = 'insights';

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * Permissive structuredContent shape for one metric row: known post-2025 fields
 * declared, unknown ones passed through so additive Meta changes never break
 * structured output (CC-DATA-7).
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
  })
  .passthrough();

// --- instagram_get_account_insights ----------------------------------------

const accountInsightsInput = {
  metrics: z
    .array(z.enum(ACCOUNT_METRICS))
    .optional()
    .describe(
      `Account metrics to fetch (post-2025 set). Defaults to all of: ${ACCOUNT_METRICS.join(', ')}. Legacy names (impressions, profile_views, video_views) no longer exist and are rejected.`,
    ),
  period: z.enum(ACCOUNT_PERIODS).optional().describe('Aggregation period. Defaults to "day".'),
  metric_type: z
    .enum(METRIC_TYPES)
    .optional()
    .describe('Return an aggregated "total_value" (default) or a per-interval "time_series".'),
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
    .describe('Range end as a Unix timestamp in seconds. Omit for the default 24h lookback.'),
};

const accountInsightsTool = defineTool({
  name: 'instagram_get_account_insights',
  title: 'Get account insights',
  description:
    "Account-level insights for the operated Instagram professional account (GET /{ig-id}/insights). Uses the post-2025 views-centric metric set. Returns aggregated totals by default; time ranges are bounded by Meta's 90-day retention.",
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
  },
  logFields: (args) => ({
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
    return json(result);
  },
});

// --- instagram_get_media_insights ------------------------------------------

const mediaInsightsInput = {
  media_id: z.string().min(1).describe('The media object ID to fetch insights for.'),
  metrics: z
    .array(z.enum(MEDIA_METRICS))
    .optional()
    .describe(
      'Media metrics to fetch. Defaults to views, reach, likes, comments, saved, shares, total_interactions. Validity depends on the media type: "navigation" and "replies" are story-only and are refused for feed posts and reels.',
    ),
  media_product_type: z
    .string()
    .optional()
    .describe(
      'Optional product-type hint (known values: FEED, REELS, STORY; obtainable from instagram_get_media). When supplied and recognized, invalid metric/type combinations are refused before the call is spent.',
    ),
};

const mediaInsightsTool = defineTool({
  name: 'instagram_get_media_insights',
  title: 'Get media insights',
  description:
    'Insights for a single media object (GET /{media-id}/insights). The valid metric set varies by media_product_type; supply media_product_type to have invalid combinations rejected client-side. Insights on media created before the account became professional, or on an expired story, may return empty or error.',
  package: PACKAGE,
  annotations: readOnly,
  input: mediaInsightsInput,
  output: {
    mediaId: z.string(),
    metrics: z.array(insightMetricOutput),
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
    return json(result);
  },
});

// --- instagram_get_audience_demographics -----------------------------------

const audienceDemographicsInput = {
  metrics: z
    .array(z.enum(DEMOGRAPHIC_METRICS))
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
    'Follower / engaged-audience demographics for the operated account (GET /{ig-id}/insights with metric_type=total_value). Requires a timeframe and an account with at least 100 followers; below that threshold Meta returns an error naming the 100-follower rule.',
  package: PACKAGE,
  annotations: readOnly,
  input: audienceDemographicsInput,
  output: {
    metrics: z.array(insightMetricOutput),
    breakdown: z.string(),
    timeframe: z.string(),
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
    return json(result);
  },
});

// --- instagram_get_online_followers ----------------------------------------

const onlineFollowersInput = {};

const onlineFollowersTool = defineTool({
  name: 'instagram_get_online_followers',
  title: 'Get online followers',
  description:
    'Hourly distribution of when the account\'s followers are online (GET /{ig-id}/insights?metric=online_followers&period=lifetime). Data covers the last 30 days only. This metric is on the deprecation watch-list (present in the legacy reference, absent from the current docs tree) and may return a "metric no longer available" error in future API versions.',
  package: PACKAGE,
  annotations: readOnly,
  input: onlineFollowersInput,
  output: {
    metrics: z.array(insightMetricOutput),
  },
  handler: async (_args, ctx) => {
    const result = await getOnlineFollowers(ctx.req, {
      accountId: ctx.profile.accountId,
    });
    return json(result);
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
export const insightsTools: ToolSpec[] = [
  accountInsightsTool,
  mediaInsightsTool,
  audienceDemographicsTool,
  onlineFollowersTool,
] as unknown as ToolSpec[];
