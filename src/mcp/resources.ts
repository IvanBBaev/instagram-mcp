/**
 * MCP resources — read-only views over this server's own tools, plus a static
 * metric glossary.
 *
 * Layer 2 (MCP-facing). Four fixed URIs, each served for the DEFAULT account
 * profile (the profile a tool call without `account` runs as):
 *
 *  - `instagram://account/profile` — what `instagram_get_account` returns;
 *  - `instagram://media/recent` — the first page of `instagram_list_media`
 *    (`limit: 10`);
 *  - `instagram://insights/account` — `instagram_get_account_insights` with no
 *    arguments: the default metric set over the default 24 h lookback;
 *  - `instagram://reference/metrics` — the metric, period and breakdown
 *    vocabularies the insights tools accept, taken verbatim from `api/insights`.
 *
 * **One path, not a second one.** A Graph-backed resource reads through the
 * registered tool's own {@link ToolCaller} — the very wrapper `tools/call` runs:
 * strict argument parse, profile resolution in the account context, the
 * call-time auth-path guard, the per-profile request seam, the handler's
 * output projection and untrusted-text `fence()`, then the secret redactor and
 * the invisible-character escape. The resource body is that result's text
 * block, byte for byte, so it can carry nothing the tool's result could not.
 * A tool error is raised as a JSON-RPC error whose message is the tool's own
 * (already redacted) error text.
 *
 * **Gating.** A Graph-backed resource is registered only when its backing tool
 * was registered (after the package profile, the deny list, forced read-only
 * packages and the auth-path filter), so no configuration can reach Graph
 * through a resource that it could not reach through a tool. The glossary
 * performs no I/O; it is listed only when an insights tool it describes is
 * registered. URIs and bodies carry no profile name, token or account id
 * beyond what the backing tool itself returns.
 */

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolCaller } from './registry.js';
import {
  ACCOUNT_METRICS,
  ACCOUNT_PERIODS,
  DEFAULT_MEDIA_METRICS,
  DEMOGRAPHIC_BREAKDOWNS,
  DEMOGRAPHIC_METRICS,
  DEMOGRAPHIC_TIMEFRAMES,
  MEDIA_METRICS,
  MEDIA_METRIC_MATRIX,
  METRIC_TYPES,
  RETENTION_DAYS,
  TIME_SERIES_ACCOUNT_METRICS,
} from '../api/insights.js';

const JSON_MIME = 'application/json';

/** One resource: metadata, the tools that gate it, and how its body is produced. */
export interface ResourceSpec {
  readonly name: string;
  readonly uri: string;
  readonly title: string;
  readonly description: string;
  /** Registered only when at least one of these tools is registered. */
  readonly requires: readonly string[];
  /** Graph-backed: the tool to read through and its fixed arguments. */
  readonly tool?: { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
  /** Static: the body, rendered without I/O. */
  readonly body?: () => string;
}

function toolResource(spec: {
  name: string;
  uri: string;
  title: string;
  description: string;
  tool: string;
  args: Record<string, unknown>;
}): ResourceSpec {
  return Object.freeze({
    name: spec.name,
    uri: spec.uri,
    title: spec.title,
    description: spec.description,
    requires: Object.freeze([spec.tool]),
    tool: Object.freeze({ name: spec.tool, args: Object.freeze({ ...spec.args }) }),
  });
}

/** The insights vocabularies, verbatim from `api/insights` — nothing invented here. */
export function metricGlossary(): Record<string, unknown> {
  return {
    note:
      'Metric names the insights tools accept (the post-2025 Graph set). Validity of a media ' +
      'metric depends on media_product_type; an unknown product type is left to Instagram.',
    account: {
      tool: 'instagram_get_account_insights',
      metrics: [...ACCOUNT_METRICS],
      periods: [...ACCOUNT_PERIODS],
      metricTypes: [...METRIC_TYPES],
      timeSeriesMetrics: [...TIME_SERIES_ACCOUNT_METRICS],
      retentionDays: RETENTION_DAYS,
    },
    media: {
      tool: 'instagram_get_media_insights',
      metrics: [...MEDIA_METRICS],
      defaultMetrics: [...DEFAULT_MEDIA_METRICS],
      byProductType: Object.fromEntries(
        Object.entries(MEDIA_METRIC_MATRIX).map(([type, metrics]) => [type, [...metrics]]),
      ),
    },
    demographics: {
      tool: 'instagram_get_audience_demographics',
      metrics: [...DEMOGRAPHIC_METRICS],
      breakdowns: [...DEMOGRAPHIC_BREAKDOWNS],
      timeframes: [...DEMOGRAPHIC_TIMEFRAMES],
    },
  };
}

const profile = toolResource({
  name: 'instagram_account_profile',
  uri: 'instagram://account/profile',
  title: 'Account profile',
  description:
    'Profile of the operated account under the default profile: the result of ' +
    'instagram_get_account. Username, name, biography and website are fenced untrusted text.',
  tool: 'instagram_get_account',
  args: {},
});

const recentMedia = toolResource({
  name: 'instagram_recent_media',
  uri: 'instagram://media/recent',
  title: 'Recent media',
  description:
    'The 10 most recent feed posts, reels and albums of the operated account under the default ' +
    'profile: the first page of instagram_list_media. Captions are fenced untrusted text.',
  tool: 'instagram_list_media',
  args: { limit: 10 },
});

const insightsSnapshot = toolResource({
  name: 'instagram_insights_snapshot',
  uri: 'instagram://insights/account',
  title: 'Account insights snapshot',
  description:
    'Account insights under the default profile for the last 24 hours, default metric set and ' +
    'period: instagram_get_account_insights called with no arguments.',
  tool: 'instagram_get_account_insights',
  args: {},
});

const glossary: ResourceSpec = Object.freeze({
  name: 'instagram_metric_glossary',
  uri: 'instagram://reference/metrics',
  title: 'Insights metric glossary',
  description:
    'The metric names, periods, metric types, demographic breakdowns and timeframes the ' +
    'insights tools accept, and which media metrics are valid per media_product_type. Static.',
  requires: Object.freeze([
    'instagram_get_account_insights',
    'instagram_get_media_insights',
    'instagram_get_audience_demographics',
  ]),
  body: () => JSON.stringify(metricGlossary(), null, 2),
});

/** Every resource this server knows, in listing order. */
export const RESOURCES: readonly ResourceSpec[] = Object.freeze([
  profile,
  recentMedia,
  insightsSnapshot,
  glossary,
]);

/** The text of a tool result's first block (the JSON body `json()` and `errorResult()` write). */
function firstText(result: Awaited<ReturnType<ToolCaller>>): string {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
}

/**
 * Register each resource whose gate is met by `callers` (the tools
 * `registerTools` actually exposed). Returns the registered resource names.
 */
export function registerResources(
  server: McpServer,
  callers: ReadonlyMap<string, ToolCaller>,
): string[] {
  const names: string[] = [];
  for (const spec of RESOURCES) {
    if (!spec.requires.some((tool) => callers.has(tool))) continue;
    const read = async (uri: URL) => {
      let text: string;
      if (spec.tool === undefined) {
        text = (spec.body as () => string)();
      } else {
        const result = await (callers.get(spec.tool.name) as ToolCaller)({ ...spec.tool.args });
        text = firstText(result);
        if (result.isError === true) {
          throw new ProtocolError(ProtocolErrorCode.InternalError, text);
        }
      }
      return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text }] };
    };
    server.registerResource(
      spec.name,
      spec.uri,
      { title: spec.title, description: spec.description, mimeType: JSON_MIME },
      read,
    );
    names.push(spec.name);
  }
  return names;
}
