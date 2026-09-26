import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { insightsTools } from '../../src/tools/insights.js';
import {
  ACCOUNT_METRICS,
  ACCOUNT_PERIODS,
  DEMOGRAPHIC_BREAKDOWNS,
  DEMOGRAPHIC_METRICS,
  DEMOGRAPHIC_TIMEFRAMES,
  MEDIA_METRICS,
  METRIC_TYPES,
} from '../../src/api/insights.js';
import type { ToolContext, ToolSpec } from '../../src/mcp/define.js';
import { InstagramError, isInstagramError } from '../../src/core/types.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
  Settings,
} from '../../src/core/types.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { testSettings } from '../helpers/settings.js';
import { registerTools } from '../../src/mcp/registry.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const NOW_MS = 1_700_000_000_000;

/** The missing-metric note, spelled out so a reworded note fails here. */
function missingNote(names: readonly string[]): string {
  return (
    `Instagram returned no data for the requested metric(s): ${names.join(', ')}. ` +
    'They are absent from metrics, not zero.'
  );
}
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY = 24 * 60 * 60;

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

const settings: Settings = testSettings();

// Every seam these tools touch is injected (`req`, `clock`, `log`, `settings`),
// so nothing here has a legitimate reason to open a socket. Trapping the global
// makes that a checked property rather than a convention: a handler that ever
// bypassed `ctx.req` would otherwise reach Meta with whatever token the machine
// running `npm test` happens to have.
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('network access is not allowed in this suite');
};
after(() => {
  globalThis.fetch = realFetch;
});

/** A ToolContext whose `req` records outgoing options and returns a canned body. */
function makeCtx(opts: { response?: unknown; accountId?: string; nowMs?: number }): {
  ctx: ToolContext;
  calls: IgRequestOptions[];
} {
  const calls: IgRequestOptions[] = [];
  const req: IgRequestFn = async <T>(o: IgRequestOptions): Promise<T> => {
    calls.push(o);
    return (opts.response ?? { data: [] }) as T;
  };
  const profile: ResolvedProfile = {
    name: 'default',
    authPath: 'ig-login',
    accessToken: 'tok',
    accountId: opts.accountId ?? '17841400000000000',
  };
  const ctx: ToolContext = {
    req,
    settings,
    profile,
    clock: fakeClock(opts.nowMs ?? NOW_MS),
    log: noopLogger,
  };
  return { ctx, calls };
}

function toolByName(name: string): ToolSpec {
  const spec = insightsTools.find((t) => t.name === name);
  if (!spec) throw new Error(`missing tool ${name}`);
  return spec;
}

/** The registry registers `input` with `.strict()`; mirror that for input tests. */
function strictInput(spec: ToolSpec) {
  return z.object(spec.input).strict();
}

// --- surface / metadata -----------------------------------------------------

test('the insights package exports exactly four tools, all read-only and open-world', () => {
  assert.equal(insightsTools.length, 4);
  for (const t of insightsTools) {
    // The annotation record is the whole basis on which a client decides how much
    // ceremony a call needs, and `--read-only` in this server drops every tool
    // whose `readOnlyHint` is not exactly `true`. Pin the record as a whole: an
    // *extra* hint is not free either — `idempotentHint: false` would tell a
    // client that re-issuing this GET may not be safe, which is precisely the
    // retry it should make after a rate-limit error.
    assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: true });
    assert.equal(t.package, 'insights');
    assert.equal(t.paths, undefined, `${t.name} should not be path-specific`);
    assert.ok(t.output, `${t.name} should declare an output schema`);
  }
});

test('insights tool names match docs/tools.md exactly', () => {
  const names = insightsTools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'instagram_get_account_insights',
    'instagram_get_audience_demographics',
    'instagram_get_media_insights',
    'instagram_get_online_followers',
  ]);
});

test('the exported array keeps the name/title pairs and the order docs/tools.md lists', () => {
  // `name` is the wire identifier a saved prompt or client config calls by, and
  // `title` is the human label a tool picker shows next to it — a model choosing
  // between four sibling read tools has little else to go on. The array order is
  // registration order, hence `tools/list` order, hence the order a model reads
  // them in; docs/tools.md §insights documents this sequence.
  assert.deepEqual(
    insightsTools.map((t) => [t.name, t.title]),
    [
      ['instagram_get_account_insights', 'Get account insights'],
      ['instagram_get_media_insights', 'Get media insights'],
      ['instagram_get_audience_demographics', 'Get audience demographics'],
      ['instagram_get_online_followers', 'Get online followers'],
    ],
  );
});

test('each description states the operational limit a caller has to plan around', () => {
  // Nothing else reaches the model: the four tools share one shape, so the
  // description is where the non-obvious constraints live. Each claim below
  // changes what a caller *does* — it asks for a narrower range, passes a
  // product-type hint, reads a 100-follower error as expected rather than as a
  // bug, or stops treating online_followers as permanent.
  const describe = (name: string): string => toolByName(name).description;

  const account = describe('instagram_get_account_insights');
  assert.ok(account.includes("bounded by Meta's 90-day retention"), account);
  assert.ok(account.includes('Returns aggregated totals by default'), account);

  const media = describe('instagram_get_media_insights');
  assert.ok(media.includes('rejected client-side'), media);

  const demographics = describe('instagram_get_audience_demographics');
  assert.ok(demographics.includes('at least 100 followers'), demographics);

  const online = describe('instagram_get_online_followers');
  assert.ok(online.includes('last 30 days only'), online);
  assert.ok(online.includes('deprecation watch-list'), online);
});

test('every input field is described', () => {
  for (const t of insightsTools) {
    for (const [field, schema] of Object.entries(t.input)) {
      assert.ok(schema.description, `${t.name}.${field} must have a .describe()`);
    }
  }
});

test('each tool declares exactly the arguments its handler forwards', () => {
  // The registry parses arguments with `.strict()`, so the declared key set *is*
  // the accepted key set. An extra key is therefore not inert: it becomes a
  // second spelling the schema advertises and validates but that no handler ever
  // reads, so a caller that picks it gets the silent api-layer default and an
  // answer to a question it did not ask.
  const keys = (name: string): string[] => Object.keys(toolByName(name).input).sort();

  assert.deepEqual(keys('instagram_get_account_insights'), [
    'metric_type',
    'metrics',
    'period',
    'since',
    'until',
  ]);
  assert.deepEqual(keys('instagram_get_media_insights'), [
    'media_id',
    'media_product_type',
    'metrics',
  ]);
  assert.deepEqual(keys('instagram_get_audience_demographics'), [
    'breakdown',
    'metrics',
    'timeframe',
  ]);
  assert.deepEqual(keys('instagram_get_online_followers'), []);
});

// --- input validation (mirrors the registry's `.strict()`) ------------------

test('account insights input rejects legacy metric names (CC-INS-7)', () => {
  const schema = strictInput(toolByName('instagram_get_account_insights'));
  assert.equal(schema.safeParse({ metrics: ['impressions'] }).success, false);
  assert.equal(schema.safeParse({ metrics: ['profile_views'] }).success, false);
  assert.equal(schema.safeParse({ metrics: ['video_views'] }).success, false);
  assert.equal(schema.safeParse({ metrics: ['views', 'reach'] }).success, true);
  assert.equal(schema.safeParse({}).success, true); // all fields optional
});

test('a metric name one edit away from a member is refused, not repaired', () => {
  // The enum is the whole contract: Graph is case-sensitive about metric names
  // and rejects the request as a whole when one of them is off. A normaliser
  // that lower-cased or trimmed its way to a member would forward a request the
  // caller never spelled, and the published schema would still list only the
  // exact members. Both tools are checked because each carries its own enum.
  const account = strictInput(toolByName('instagram_get_account_insights'));
  for (const nearMiss of ['Views', 'VIEWS', 'views ', ' reach', 'reach\n']) {
    assert.equal(
      account.safeParse({ metrics: [nearMiss] }).success,
      false,
      `account insights refuses ${JSON.stringify(nearMiss)}`,
    );
  }
  const media = strictInput(toolByName('instagram_get_media_insights'));
  for (const nearMiss of ['Views', 'REACH', 'views ', ' reach', 'likes\n']) {
    assert.equal(
      media.safeParse({ media_id: 'm1', metrics: [nearMiss] }).success,
      false,
      `media insights refuses ${JSON.stringify(nearMiss)}`,
    );
  }
});

test('an EMPTY metric list is refused by all three tools, not sent as `metric=`', () => {
  // The api layer substitutes its default only for an ABSENT list
  // (`params.metrics ?? DEFAULT`), so `metrics: []` used to pass the schema and
  // go out as `metric=` — a Graph call spent on a request naming nothing to
  // measure. Omitting the argument is how a caller asks for the default set.
  const cases: Array<[string, Record<string, unknown>]> = [
    ['instagram_get_account_insights', {}],
    ['instagram_get_media_insights', { media_id: 'm1' }],
    ['instagram_get_audience_demographics', { breakdown: 'age', timeframe: 'this_month' }],
  ];
  for (const [name, base] of cases) {
    const schema = strictInput(toolByName(name));
    assert.equal(schema.safeParse({ ...base, metrics: [] }).success, false, `${name} refuses []`);
    assert.equal(schema.safeParse(base).success, true, `${name} still accepts an omitted list`);
  }
});

test('account insights input rejects unknown arguments', () => {
  const schema = strictInput(toolByName('instagram_get_account_insights'));
  assert.equal(schema.safeParse({ bogus: 1 }).success, false);
});

test('account insights accepts every metric, period and metric_type the api layer supports', () => {
  // The tool enum is the only gate a caller meets: a member missing from it is
  // not "undocumented", it is unreachable — the request is refused before any
  // call is made, and the tool description keeps advertising it. Drive the
  // vocabularies straight off the api module so the two cannot drift apart.
  const schema = strictInput(toolByName('instagram_get_account_insights'));

  assert.equal(schema.safeParse({ metrics: [...ACCOUNT_METRICS] }).success, true);
  for (const metric of ACCOUNT_METRICS) {
    assert.equal(schema.safeParse({ metrics: [metric] }).success, true, metric);
  }
  for (const period of ACCOUNT_PERIODS) {
    assert.equal(schema.safeParse({ period }).success, true, period);
  }
  for (const metricType of METRIC_TYPES) {
    assert.equal(schema.safeParse({ metric_type: metricType }).success, true, metricType);
  }
});

test('account insights refuses a period or metric_type Graph does not serve', () => {
  // The sweep above proves every published value is REACHABLE; it says nothing
  // about what else gets through, and a plain `z.string()` in either slot would
  // satisfy it just as happily. Both fields are copied verbatim onto the query
  // string, so anything the gate lets through is spent as a real, rate-limited
  // call that comes back as an opaque Graph error — and the wrong answers here
  // are the plausible ones, not absurd ones: `lifetime` is a genuine period
  // elsewhere in this very package (online followers asks for it by name),
  // `month` and `days_7` are the shapes a caller extrapolates from `days_28`,
  // and `total` / `timeseries` are one keystroke off the two real metric types.
  // Refusing them at the boundary turns a burned call and a cryptic upstream
  // message into an argument error that names the allowed set.
  const schema = strictInput(toolByName('instagram_get_account_insights'));

  for (const period of ['lifetime', 'month', 'days_7', 'DAY', '']) {
    assert.equal(schema.safeParse({ period }).success, false, `period: ${period}`);
  }
  for (const metricType of ['total', 'total_values', 'timeseries', 'TIME_SERIES', '']) {
    assert.equal(
      schema.safeParse({ metric_type: metricType }).success,
      false,
      `metric_type: ${metricType}`,
    );
  }
});

test('the account tool applies no defaults of its own — omitted stays omitted', () => {
  // Every default for this tool lives in `api/insights.ts`, which is also where
  // the retention clamp and the metric vocabulary live. A default injected here
  // would reach the api layer as an explicit caller choice, so the api can no
  // longer tell "the caller asked for a week" from "nobody said anything", and
  // the audit line would record a period the operator never typed.
  const schema = strictInput(toolByName('instagram_get_account_insights'));
  assert.deepEqual(schema.parse({}), {});
});

test('the account time window must be whole Unix seconds', () => {
  // `since`/`until` go onto the query string verbatim. Meta reads them as Unix
  // seconds, so a fractional value is serialized as "1700000000.5" and comes back
  // as an opaque API error — after the rate-limited call has already been spent.
  const schema = strictInput(toolByName('instagram_get_account_insights'));

  assert.equal(schema.safeParse({ since: NOW_SEC - DAY, until: NOW_SEC }).success, true);
  assert.equal(schema.safeParse({ since: NOW_SEC - 0.5 }).success, false);
  assert.equal(schema.safeParse({ until: NOW_SEC + 0.5 }).success, false);
  assert.equal(schema.safeParse({ since: '1700000000' }).success, false);
});

test('media insights input requires media_id and rejects legacy metrics', () => {
  const schema = strictInput(toolByName('instagram_get_media_insights'));
  assert.equal(schema.safeParse({ metrics: ['views'] }).success, false); // media_id missing
  assert.equal(schema.safeParse({ media_id: 'm1', metrics: ['video_views'] }).success, false);
  // Enum accepts a story-only metric; the media-type matrix is an api-layer concern.
  assert.equal(schema.safeParse({ media_id: 'm1', metrics: ['navigation'] }).success, true);
  assert.equal(schema.safeParse({ media_id: 'm1', media_product_type: 'REELS' }).success, true);
  // `.min(1)` is load-bearing, not decoration: an empty id is not "missing" to
  // zod, so without it the handler would happily build `GET //insights` and burn
  // a rate-limited call on a request that cannot succeed.
  assert.equal(schema.safeParse({ media_id: '' }).success, false);
});

test('media insights accepts every media metric and defaults nothing at the tool boundary', () => {
  const schema = strictInput(toolByName('instagram_get_media_insights'));
  for (const metric of MEDIA_METRICS) {
    assert.equal(schema.safeParse({ media_id: 'm1', metrics: [metric] }).success, true, metric);
  }
  // No tool-level default: `metrics` omitted must stay omitted so the api layer
  // picks the seven-metric default set *and* knows the caller did not choose it,
  // and `media_product_type` omitted must stay omitted so the matrix check is
  // skipped rather than run against a product type nobody supplied.
  assert.deepEqual(schema.parse({ media_id: 'm1' }), { media_id: 'm1' });
});

test('media_product_type stays an open vocabulary (CC-DATA-6)', () => {
  // Meta adds product types without warning, and the hint is only ever used to
  // *refuse* known-bad metric combinations. Closing it to today's three values
  // would turn tomorrow's new type into a hard client-side rejection of a call
  // that Meta would have answered, and would reject the lowercase spelling the
  // api layer already normalizes.
  const schema = strictInput(toolByName('instagram_get_media_insights'));
  assert.equal(schema.safeParse({ media_id: 'm1', media_product_type: 'feed' }).success, true);
  assert.equal(schema.safeParse({ media_id: 'm1', media_product_type: 'CLIPS' }).success, true);
  assert.equal(schema.safeParse({ media_id: 'm1', media_product_type: 42 }).success, false);
});

test('demographics input requires both breakdown and timeframe', () => {
  const schema = strictInput(toolByName('instagram_get_audience_demographics'));
  assert.equal(schema.safeParse({ breakdown: 'age' }).success, false); // no timeframe
  assert.equal(schema.safeParse({ timeframe: 'last_30_days' }).success, false); // no breakdown
  assert.equal(schema.safeParse({ breakdown: 'age', timeframe: 'last_30_days' }).success, true);
  assert.equal(schema.safeParse({ breakdown: 'height', timeframe: 'last_30_days' }).success, false); // bad enum
});

test('demographics accepts both populations and every published breakdown and timeframe', () => {
  // The engaged-audience population is the whole reason `metrics` is exposed
  // here; a vocabulary that quietly dropped it would leave the caller with the
  // follower base as its only reachable answer, described by a tool that still
  // advertises the other one. Breakdown and timeframe are the two required
  // arguments — every documented value has to be reachable.
  const schema = strictInput(toolByName('instagram_get_audience_demographics'));
  const base = { breakdown: 'age', timeframe: 'this_week' };

  for (const metric of DEMOGRAPHIC_METRICS) {
    assert.equal(schema.safeParse({ ...base, metrics: [metric] }).success, true, metric);
  }
  for (const breakdown of DEMOGRAPHIC_BREAKDOWNS) {
    assert.equal(schema.safeParse({ ...base, breakdown }).success, true, breakdown);
  }
  for (const timeframe of DEMOGRAPHIC_TIMEFRAMES) {
    assert.equal(schema.safeParse({ ...base, timeframe }).success, true, timeframe);
  }
  // And, as everywhere else in this package, no tool-level default is injected.
  assert.deepEqual(schema.parse(base), base);
});

test('demographics refuses a timeframe or population Graph does not serve', () => {
  // The same asymmetry, and this tool is where it bites hardest: of its three
  // arguments only `breakdown` has ever been tested negatively, so `timeframe`
  // and `metrics` could both decay to `z.string()` with every test in this file
  // still green. `timeframe` is mandatory and has no server-side default, so a
  // bogus one is not quietly degraded into "the usual window" — it is a spent
  // call answered with a generic error, and `last_7_days` / `last_60_days` are
  // precisely the windows someone extrapolates from the real `last_14_days` and
  // `last_90_days`. A stray `metrics` entry is worse, because it does not fail
  // alone: the api layer joins the array into a single `metric` parameter, so
  // one unrecognized population takes the valid one down with it and the caller
  // loses the answer they actually asked for.
  const schema = strictInput(toolByName('instagram_get_audience_demographics'));
  const base = { breakdown: 'age', timeframe: 'this_week' };

  for (const timeframe of ['last_7_days', 'last_60_days', 'prev_week', 'lifetime', '']) {
    assert.equal(
      schema.safeParse({ ...base, timeframe }).success,
      false,
      `timeframe: ${timeframe}`,
    );
  }
  for (const metric of ['audience_demographics', 'follower_demographic', 'reach', '']) {
    assert.equal(
      schema.safeParse({ ...base, metrics: [metric] }).success,
      false,
      `metrics: ${metric}`,
    );
  }
});

test('online followers input takes no arguments', () => {
  const schema = strictInput(toolByName('instagram_get_online_followers'));
  assert.equal(schema.safeParse({}).success, true);
  assert.equal(schema.safeParse({ period: 'lifetime' }).success, false);
});

// --- handlers ---------------------------------------------------------------

test('account insights handler returns text + structuredContent and builds the request', async () => {
  const wire = { data: [{ name: 'views', total_value: { value: 5 } }], paging: { next: 'n' } };
  const { ctx, calls } = makeCtx({ response: wire, accountId: '999' });
  const res = await toolByName('instagram_get_account_insights').handler({}, ctx);

  assert.equal(res.content[0]?.type, 'text');
  // The whole body, not just `metrics`. `json()` assigns its argument straight
  // to `result.structuredContent` and validates nothing against the declared
  // output schema, so whatever this handler puts in the object it returns is
  // what the model reads — and a reader that only ever asked `.metrics`,
  // `.window` and `.notes` by name could not see a field ADDED beside them.
  // Measured: replacing `return json(result)` with
  // `return json({ ...result, byMetric: Object.fromEntries(result.metrics.map((m) => [m.name, m])) })`
  // — an internal index that hands back the full metric history for a request
  // that asked for one metric — survived every one of the 448 tests in the
  // twelve files that observe these tools (448 pass, 0 fail, exit 0), because
  // no assertion anywhere looked at the object as a whole. This pin is that
  // assertion, and it is safely whole: every value below is derived from the
  // canned wire body and the fixed (empty) arguments, so nothing here is
  // volatile. `window.since` and `window.until` are spelled out as `undefined`
  // on purpose — the api always writes the window as `{ since, until, clamped }`,
  // so both are OWN keys even when the caller passed no range, and
  // `node:assert/strict`'s `deepEqual` counts an own key valued `undefined`.
  // The bare call asks for all eleven default metrics and the wire answers
  // `views` alone, so the other ten are named as missing rather than reading
  // as a complete answer.
  const missing = ACCOUNT_METRICS.filter((m) => m !== 'views');
  assert.deepEqual(res.structuredContent, {
    metrics: wire.data,
    window: { since: undefined, until: undefined, clamped: false },
    notes: [missingNote(missing)],
    paging: wire.paging,
    missingMetrics: missing,
  });
  assert.equal(calls[0]?.path, '/999/insights');
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.params?.metric_type, 'total_value');
});

test("account insights forwards the caller's metrics, period and metric_type verbatim", async () => {
  // Every one of these three arguments has a *silent* default one layer down:
  // the api falls back to all eleven ACCOUNT_METRICS, `period=day` and
  // `metric_type=total_value`. So a handler that dropped an argument would still
  // produce a well-formed answer — just an answer to a different question than
  // the caller asked, at a different (and for the metric list, much larger)
  // rate-limit cost. Only the outgoing params can tell the two apart.
  const { ctx, calls } = makeCtx({ response: { data: [] }, accountId: '42' });

  await toolByName('instagram_get_account_insights').handler(
    { metrics: ['reach'], period: 'week', metric_type: 'time_series' },
    ctx,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, '/42/insights');
  // Each assertion pins one argument against the default it would silently
  // decay to: the full metric set, `day`, and `total_value` respectively.
  // (`reach` alone: it is the only metric Graph serves as a time series —
  // CC-INS-25.)
  assert.equal(calls[0]?.params?.metric, 'reach');
  assert.equal(calls[0]?.params?.period, 'week');
  assert.equal(calls[0]?.params?.metric_type, 'time_series');
});

test('account insights handler clamps an old "since" using the injected clock (CC-INS-3)', async () => {
  const { ctx, calls } = makeCtx({ response: { data: [] }, accountId: '1', nowMs: NOW_MS });
  const since = NOW_SEC - 200 * DAY;
  const until = NOW_SEC - DAY;
  const res = await toolByName('instagram_get_account_insights').handler({ since, until }, ctx);

  const floor = NOW_SEC - 90 * DAY;
  const sc = res.structuredContent as {
    window: { clamped: boolean; since?: number };
    notes: string[];
  };
  assert.equal(sc.window.clamped, true);
  assert.equal(sc.window.since, floor);
  assert.equal(calls[0]?.params?.since, floor);
  assert.ok(sc.notes.length > 0);
});

test('account insights forwards both ends of an in-retention window and reports it unclamped', async () => {
  // Dropping `until` does not fail — it widens the range to "now", so a caller
  // asking about a finished week silently gets a range that runs to today. The
  // reply carries no marker of that: `clamped` stays false, the notes stay empty,
  // and the numbers look like a perfectly ordinary answer. The echoed window and
  // the outgoing params are the only places the substitution is visible.
  // Every default metric answers, so an empty `notes` means "not clamped" and
  // nothing else.
  const full = { data: ACCOUNT_METRICS.map((name) => ({ name, total_value: { value: 1 } })) };
  const { ctx, calls } = makeCtx({ response: full, accountId: '42', nowMs: NOW_MS });
  const since = NOW_SEC - 10 * DAY;
  const until = NOW_SEC - 3 * DAY;

  const res = await toolByName('instagram_get_account_insights').handler({ since, until }, ctx);

  assert.equal(calls[0]?.params?.since, since);
  assert.equal(calls[0]?.params?.until, until);
  assert.deepEqual((res.structuredContent as { window: unknown }).window, {
    since,
    until,
    clamped: false,
  });
  assert.deepEqual((res.structuredContent as { notes: unknown }).notes, []);
});

test('insights results are serialized compactly, not pretty-printed', async () => {
  // The text block is the copy of the payload the model actually reads, and every
  // byte of it is context the caller pays for. An eleven-metric account payload
  // pretty-printed at two-space indent is several times the size of the same
  // answer compact — for a read tool a caller may poll, that is the difference
  // between a cheap refresh and one that crowds out the conversation.
  const wire = { data: [{ name: 'views', total_value: { value: 5 } }] };
  const { ctx } = makeCtx({ response: wire });

  const cases: Array<[string, Record<string, unknown>]> = [
    ['instagram_get_account_insights', {}],
    ['instagram_get_media_insights', { media_id: 'm1' }],
    ['instagram_get_audience_demographics', { breakdown: 'age', timeframe: 'this_week' }],
    ['instagram_get_online_followers', {}],
  ];
  for (const [name, args] of cases) {
    const res = await toolByName(name).handler(args, ctx);
    const text = String(res.content[0]?.text);
    assert.equal(text, JSON.stringify(res.structuredContent), name);
    assert.equal(text.includes('\n'), false, name);
  }
});

test('account insights logs the metric selection, naming the implicit set "default"', () => {
  // `metrics` is what decides which numbers came back, so it is the field that
  // makes an audit line answer "what did this call actually ask for?". The
  // omitted case is deliberately logged as the string `default` rather than
  // `undefined`, so a reader can tell "the caller took the post-2025 set" apart
  // from "the selection went missing somewhere". That naming is only half the
  // contract: an explicit selection has to survive to the log too, otherwise
  // every line reads `default` and the field stops carrying any information at
  // all — a plausible-looking audit trail that is silently the same for every
  // call. Pin both halves.
  const fn = toolByName('instagram_get_account_insights').logFields;
  assert.ok(fn);
  assert.deepEqual(fn({ metrics: ['views', 'reach'], period: 'day' }).metrics, ['views', 'reach']);
  assert.equal(fn({ period: 'day' }).metrics, 'default');
});

test('account insights: a bare time_series asks for reach, and a total-only metric with it is refused (CC-INS-25)', async () => {
  const ok = makeCtx({ response: { data: [{ name: 'reach', values: [{ value: 1 }] }] } });
  const res = await toolByName('instagram_get_account_insights').handler(
    { metric_type: 'time_series' },
    ok.ctx,
  );
  assert.equal(ok.calls[0]?.params?.metric, 'reach');
  assert.equal(ok.calls[0]?.params?.metric_type, 'time_series');
  assert.equal((res.structuredContent as { missingMetrics?: unknown }).missingMetrics, undefined);

  const refused = makeCtx({ response: { data: [] } });
  await assert.rejects(
    async () =>
      toolByName('instagram_get_account_insights').handler(
        { metrics: ['reach', 'views'], metric_type: 'time_series' },
        refused.ctx,
      ),
    (e: unknown) =>
      isInstagramError(e) && e.kind === 'validation' && e.message.startsWith('Metric(s) views '),
  );
  assert.equal(refused.calls.length, 0);
});

test('account insights refuses a window that ends before it starts (CC-INS-26)', async () => {
  const { ctx, calls } = makeCtx({ response: { data: [] }, nowMs: NOW_MS });
  await assert.rejects(
    async () =>
      toolByName('instagram_get_account_insights').handler(
        { since: NOW_SEC, until: NOW_SEC - DAY },
        ctx,
      ),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('audience demographics sends period=lifetime, which Meta marks required (CC-INS-27)', async () => {
  const { ctx, calls } = makeCtx({ response: { data: [] } });
  await toolByName('instagram_get_audience_demographics').handler(
    { breakdown: 'age', timeframe: 'this_month' },
    ctx,
  );
  assert.equal(calls[0]?.params?.period, 'lifetime');
});

test('media insights handler propagates the media-type matrix error (CC-INS-2)', async () => {
  const { ctx, calls } = makeCtx({ response: { data: [] } });
  await assert.rejects(
    async () =>
      toolByName('instagram_get_media_insights').handler(
        { media_id: 'm1', metrics: ['navigation'], media_product_type: 'REELS' },
        ctx,
      ),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('media insights handler reads the MEDIA node and defaults to the post-2025 metric set', async () => {
  const wire = {
    data: [
      { name: 'views', period: 'lifetime', values: [{ value: 120 }] },
      { name: 'reach', period: 'lifetime', values: [{ value: 90 }] },
    ],
  };
  const { ctx, calls } = makeCtx({ response: wire, accountId: '999' });

  const res = await toolByName('instagram_get_media_insights').handler({ media_id: 'm1' }, ctx);

  // Media insights hang off the media object, never off the operated account.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.path, '/m1/insights');
  assert.equal(
    calls[0]?.params?.metric,
    'views,reach,likes,comments,saved,shares,total_interactions',
  );

  const sc = res.structuredContent as { mediaId: string; metrics: unknown[] };
  assert.equal(sc.mediaId, 'm1');
  assert.deepEqual(sc.metrics, wire.data);
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(String(res.content[0]?.text)), sc);
});

test('media insights forwards an explicit metric selection and passes its own output schema', async () => {
  const wire = { data: [{ name: 'saved', total_value: { value: 3 }, unknown_future_field: 1 }] };
  const { ctx, calls } = makeCtx({ response: wire });
  const spec = toolByName('instagram_get_media_insights');

  const res = await spec.handler({ media_id: 'm2', metrics: ['saved', 'shares'] }, ctx);

  assert.equal(calls[0]?.params?.metric, 'saved,shares');
  // The declared output schema must accept what the handler actually returns,
  // including fields Meta may add later (CC-DATA-7).
  const parsed = z.object(spec.output ?? {}).parse(res.structuredContent);
  assert.equal((parsed as { mediaId: string }).mediaId, 'm2');
});

test('media insights with no rows is an empty result, not an error', async () => {
  // Insights on media created before the account went professional, or on an
  // expired story, come back without a `data` array at all.
  const { ctx } = makeCtx({ response: {} });

  const res = await toolByName('instagram_get_media_insights').handler({ media_id: 'm3' }, ctx);

  assert.equal(res.isError, undefined);
  // Empty is still not an error, but it is no longer indistinguishable from an
  // answer with nothing to report: every requested default metric is named.
  const missing = ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'];
  assert.deepEqual(res.structuredContent, {
    mediaId: 'm3',
    metrics: [],
    missingMetrics: missing,
    note: missingNote(missing),
  });
});

test('media insights logs the metric selection, naming the implicit set "default"', () => {
  // Media metrics are the post-2025 set unless the caller overrides them. An
  // audit line that logged `undefined` for the common case could not be told
  // apart from a call whose metrics were dropped on the way in.
  const fn = toolByName('instagram_get_media_insights').logFields;
  assert.ok(fn);
  assert.deepEqual(fn({ media_id: 'm1', metrics: ['saved', 'shares'] }).metrics, [
    'saved',
    'shares',
  ]);
  assert.equal(fn({ media_id: 'm1' }).metrics, 'default');
});

test('demographics handler forwards breakdown, timeframe and metric_type=total_value', async () => {
  const wire = { data: [{ name: 'follower_demographics', total_value: { value: 1 } }] };
  const { ctx, calls } = makeCtx({ response: wire, accountId: '5' });
  const res = await toolByName('instagram_get_audience_demographics').handler(
    { breakdown: 'city', timeframe: 'this_month' },
    ctx,
  );
  // The reply echoes the two arguments that decide what the numbers mean: the
  // same rows read as "my followers' cities this month" or as something else
  // entirely depending on them, and a caller comparing several breakdowns has
  // nothing but this echo to tell the answers apart.
  assert.deepEqual(res.structuredContent, {
    metrics: wire.data,
    breakdown: 'city',
    timeframe: 'this_month',
  });
  assert.equal(calls[0]?.path, '/5/insights');
  assert.equal(calls[0]?.params?.breakdown, 'city');
  assert.equal(calls[0]?.params?.timeframe, 'this_month');
  assert.equal(calls[0]?.params?.metric_type, 'total_value');
});

test('demographics forwards the requested population instead of the default one', async () => {
  // `metrics` defaults to ["follower_demographics"] in the api layer, so asking
  // for the engaged audience and silently getting the follower base back is a
  // wrong answer that looks entirely plausible — the two populations differ only
  // in their numbers. The outgoing `metric` param is the only witness.
  const { ctx, calls } = makeCtx({ response: { data: [] }, accountId: '5' });

  await toolByName('instagram_get_audience_demographics').handler(
    { metrics: ['engaged_audience_demographics'], breakdown: 'country', timeframe: 'last_14_days' },
    ctx,
  );

  assert.equal(calls[0]?.params?.metric, 'engaged_audience_demographics');
  assert.equal(calls[0]?.params?.breakdown, 'country');
  assert.equal(calls[0]?.params?.timeframe, 'last_14_days');
});

test('demographics logs the population it was asked for, naming the implicit one "default"', () => {
  // The two demographic populations — everyone who follows the account, and
  // everyone who engaged with it — produce rows that are structurally identical
  // and numerically different. An audit line that logged `default` for both
  // could not answer which one a past call read, which is the one question this
  // field exists for; and logging `undefined` for the omitted case would make a
  // dropped selection look like the ordinary one. Both halves are pinned.
  const fn = toolByName('instagram_get_audience_demographics').logFields;
  assert.ok(fn);
  assert.deepEqual(
    fn({
      metrics: ['engaged_audience_demographics'],
      breakdown: 'city',
      timeframe: 'this_week',
    }).metrics,
    ['engaged_audience_demographics'],
  );
  assert.equal(fn({ breakdown: 'city', timeframe: 'this_week' }).metrics, 'default');
});

test('online followers handler requests the lifetime online_followers metric', async () => {
  const wire = { data: [{ name: 'online_followers', values: [{ value: { '0': 12 } }] }] };
  const { ctx, calls } = makeCtx({ response: wire, accountId: '7' });
  const res = await toolByName('instagram_get_online_followers').handler({}, ctx);

  assert.deepEqual(res.structuredContent, { metrics: wire.data });
  assert.equal(calls[0]?.path, '/7/insights');
  assert.equal(calls[0]?.params?.metric, 'online_followers');
  assert.equal(calls[0]?.params?.period, 'lifetime');
});

// --- the declared output contract -------------------------------------------
//
// `registerOne` hands `spec.output` to the MCP server as the tool's
// `outputSchema`, and the SDK does two things with it: it publishes it in
// `tools/list` as JSON Schema — `required` list included — and it validates
// every `structuredContent` against it before the result reaches the client
// (see test/mcp/registry.test.ts, "outputSchema handling ..."). So what is
// *required* here is a promise made to clients and a runtime guard on our own
// handlers at once. Relaxing a field to `.optional()` keeps every happy-path
// parse green while telling clients the field may simply not be there and
// removing the SDK's ability to catch a handler that stopped emitting it. These
// tests therefore assert the negatives: which payloads the declaration rejects.

test('the account-insights output schema requires notes, the clamp flag and named metric rows', () => {
  const spec = toolByName('instagram_get_account_insights');
  const schema = z.object(spec.output ?? {});
  const row = { name: 'views', total_value: { value: 5 } };

  // Baseline: the real handler shape parses, paging optional.
  assert.equal(
    schema.safeParse({ metrics: [row], window: { clamped: false }, notes: [] }).success,
    true,
  );

  // `notes` carries the retention-clamp disclosure. Declared optional, a client
  // has no guarantee it will ever see one, and "no notes" stops being a fact.
  assert.equal(schema.safeParse({ metrics: [row], window: { clamped: false } }).success, false);

  // `window.clamped` is the boolean a caller reads to know whether the numbers
  // cover the range it asked for (CC-INS-3). Absent must not be legal — an
  // absent flag reads as "not clamped" to every consumer that checks it.
  assert.equal(
    schema.safeParse({ metrics: [row], window: { since: 1, until: 2 }, notes: [] }).success,
    false,
  );

  // The metric rows are declared rows, not an anonymous bag of records: a row
  // without a `name`, or with a non-string one, is not a metric anybody can read.
  assert.equal(
    schema.safeParse({ metrics: [{ period: 'day' }], window: { clamped: false }, notes: [] })
      .success,
    false,
  );
  assert.equal(
    schema.safeParse({ metrics: [{ name: 42 }], window: { clamped: false }, notes: [] }).success,
    false,
  );
  // …while additive Meta fields still pass through untouched (CC-DATA-7).
  assert.equal(
    schema.safeParse({
      metrics: [{ name: 'views', unknown_future_field: 1 }],
      window: { clamped: false, future: 'x' },
      notes: [],
    }).success,
    true,
  );

  // `metrics` and `window` are the answer and the range it covers. Either one
  // optional and a reply that lost it still validates: the caller sees an empty
  // insights view, or numbers with no statement of the period they cover.
  assert.equal(schema.safeParse({ window: { clamped: false }, notes: [] }).success, false);
  assert.equal(schema.safeParse({ metrics: [row], notes: [] }).success, false);

  // The notes are prose meant to be shown verbatim ("the range was clamped to
  // the retention window"); an untyped array lets a structured object through
  // that a client would render as [object Object].
  assert.equal(
    schema.safeParse({ metrics: [row], window: { clamped: false }, notes: [{ msg: 'clamped' }] })
      .success,
    false,
  );
  // …and the element type has to be `string` specifically, not merely "not an
  // object". Every negative above is satisfied by any element declaration this
  // repo might plausibly typo into — `z.array(z.number())` rejects the object
  // too, and the only other fixture in this test is the empty array, which every
  // element type accepts. So the one payload that separates them has to be
  // asserted directly: the real clamp sentence the api layer emits (CC-INS-3),
  // the sole note this tool ever produces, parsing as-is. Without it the field
  // could be declared as an array of anything at all and this test would still
  // pass, while the SDK's output validation started rejecting every clamped
  // window the handler returned.
  assert.equal(
    schema.safeParse({
      metrics: [row],
      window: { since: 1, until: 2, clamped: true },
      notes: [
        '`since` was clamped to the 90-day retention floor; data older than that is not retained by Meta.',
      ],
    }).success,
    true,
  );

  // `paging` must be declared under exactly that name: `z.object` strips keys it
  // does not know, so an undeclared or renamed cursor is dropped by the SDK's own
  // output validation and pagination silently stops after page one.
  const parsed = schema.parse({
    metrics: [row],
    window: { clamped: false },
    notes: [],
    paging: { next: 'cursor-2' },
  }) as { paging?: unknown };
  assert.deepEqual(parsed.paging, { next: 'cursor-2' });
});

test('the media-insights output schema requires the mediaId it answered for', () => {
  const spec = toolByName('instagram_get_media_insights');
  const schema = z.object(spec.output ?? {});

  assert.equal(schema.safeParse({ mediaId: 'm1', metrics: [{ name: 'views' }] }).success, true);

  // The echoed `mediaId` is how a caller that fanned out over several posts
  // pairs a result with its media. Optional, the numbers arrive unattributable —
  // and the SDK would no longer stop a handler that dropped it.
  assert.equal(schema.safeParse({ metrics: [{ name: 'views' }] }).success, false);

  // Same named-row requirement as above, asserted here on the shared metric-row
  // schema so it holds independently of the account-insights declaration.
  assert.equal(
    schema.safeParse({ mediaId: 'm1', metrics: [{ period: 'lifetime' }] }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ mediaId: 'm1', metrics: [{ name: 'views', unknown_future_field: 1 }] })
      .success,
    true,
  );

  // `metrics` is the answer itself. Optional, "this post has no insights" and
  // "the handler forgot to attach them" become the same reply.
  assert.equal(schema.safeParse({ mediaId: 'm1' }).success, false);
});

test('the shared metric-row declaration types every field it names and keeps the rest', () => {
  // One row schema backs all four tools, so a slip here is a silent relaxation of
  // the whole package's structured output at once. Each declared field is a field
  // a client may render or chart: `period` and `title` are labels, `id` is what a
  // caller keys a stored series on, and `values`/`total_value` are the numbers.
  // A field declared but untyped (or renamed) still parses green under
  // `.passthrough()` — only these negatives can tell.
  const schema = z.object(toolByName('instagram_get_media_insights').output ?? {});
  const row = (extra: Record<string, unknown>): boolean =>
    schema.safeParse({ mediaId: 'm1', metrics: [{ name: 'views', ...extra }] }).success;

  assert.equal(row({ period: 'lifetime' }), true);
  assert.equal(row({ period: 42 }), false);
  assert.equal(row({ title: 42 }), false);
  assert.equal(row({ description: 42 }), false);
  assert.equal(row({ id: 42 }), false);

  // `values` is the per-interval series: an array of objects, not scalars.
  assert.equal(row({ values: [{ value: 1, end_time: '2026-01-01T00:00:00+0000' }] }), true);
  assert.equal(row({ values: [5] }), false);
  assert.equal(row({ values: { value: 1 } }), false);

  // `total_value` is the aggregate object Meta returns for metric_type=total_value.
  assert.equal(row({ total_value: { value: 5 } }), true);
  assert.equal(row({ total_value: 5 }), false);

  // …and everything Meta adds later survives validation instead of being dropped
  // on the floor between the handler and the client (CC-DATA-7).
  const parsed = schema.parse({
    mediaId: 'm1',
    metrics: [{ name: 'views', unknown_future_field: 7 }],
  }) as { metrics: Array<Record<string, unknown>> };
  assert.equal(parsed.metrics[0]?.unknown_future_field, 7);
});

test('the demographics output schema keeps the rows named and both dimensions attached', () => {
  const spec = toolByName('instagram_get_audience_demographics');
  const schema = z.object(spec.output ?? {});
  const rows = [{ name: 'follower_demographics', total_value: { value: 1 } }];

  // Baseline, spelled exactly as the handler emits it: this also pins the two
  // field *names*, since a renamed required key makes this very payload invalid.
  assert.equal(
    schema.safeParse({ metrics: rows, breakdown: 'city', timeframe: 'this_month' }).success,
    true,
  );

  // Demographic rows are the same declared metric rows as everywhere else — a
  // bare record bag would accept an unnamed row nobody can label a chart with.
  assert.equal(
    schema.safeParse({
      metrics: [{ total_value: { value: 1 } }],
      breakdown: 'city',
      timeframe: 'x',
    }).success,
    false,
  );

  // Each of the three fields is load-bearing: the rows are the answer, and the
  // breakdown/timeframe are what say which question it answers. Optional, a
  // client fanning out over breakdowns can silently lose the label.
  assert.equal(schema.safeParse({ breakdown: 'city', timeframe: 'this_month' }).success, false);
  assert.equal(schema.safeParse({ metrics: rows, timeframe: 'this_month' }).success, false);
  assert.equal(schema.safeParse({ metrics: rows, breakdown: 'city' }).success, false);
});

test('the online-followers output schema requires the metrics array under that name', () => {
  const spec = toolByName('instagram_get_online_followers');
  const schema = z.object(spec.output ?? {});

  // This tool takes no arguments, so the declared output is the entire contract
  // published for it in `tools/list` — and the only runtime check that the
  // handler still returns the hourly series at all.
  assert.equal(
    schema.safeParse({ metrics: [{ name: 'online_followers', values: [{ value: {} }] }] }).success,
    true,
  );
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ metrics: [{ values: [] }] }).success, false);
});

// --- model-facing contracts -------------------------------------------------
// A tool description and its `.describe()` texts are not documentation: they are
// the only instructions the model gets before it decides whether, and with what
// arguments, to spend a call. Coverage cannot see a word of them — the strings
// are data hanging off a spec object, so a rewrite that inverts their meaning
// runs every line of this package exactly as it ran before. Each fragment below
// is pinned because a model that read the opposite of it would act differently
// (CC-PROC-74).

/** The `.describe()` text of one declared argument (the model-facing contract). */
function describeOf(shape: z.ZodRawShape, key: string): string {
  return shape[key]?.description ?? '';
}

/** Assert a model-facing string still carries an exact contract fragment. */
function assertMentions(body: string, fragment: string): void {
  assert.ok(body.includes(fragment), `missing from the model-facing text: ${fragment}`);
}

test('account insights describes the post-2025 set, the default shape and the retention clamp', () => {
  const spec = toolByName('instagram_get_account_insights');
  const d = spec.description;
  assertMentions(
    d,
    'Account-level insights for the operated Instagram professional account (GET /{ig-id}/insights).',
  );
  // The 2025-01-08 purge is the single fact that decides whether a model asks a
  // question Meta can still answer. Dropped from the description, the model
  // reaches for the vocabulary it learned from years of older material and
  // spends the call on a metric that no longer exists.
  assertMentions(d, 'Uses the post-2025 views-centric metric set.');
  assertMentions(
    d,
    "Returns aggregated totals by default; time ranges are bounded by Meta's 90-day retention.",
  );

  const metrics = describeOf(spec.input, 'metrics');
  // The default list is interpolated from ACCOUNT_METRICS rather than typed out,
  // so this asserts the text a model reads still names exactly the metrics the
  // handler would send — a list that drifted from the enum would promise data
  // the call does not ask for.
  assertMentions(metrics, `Defaults to all of: ${ACCOUNT_METRICS.join(', ')};`);
  // The default follows the metric_type (CC-INS-25): a model that reads "all
  // eleven" and asks for a time series has been told to make a call Graph
  // rejects as a whole.
  assertMentions(metrics, 'with metric_type "time_series" it defaults to reach.');
  assertMentions(
    metrics,
    'Legacy names (impressions, profile_views, video_views) no longer exist and are rejected.',
  );
  assertMentions(describeOf(spec.input, 'period'), 'Aggregation period. Defaults to "day".');
  // The two metric_type values return different SHAPES, not different numbers.
  // A model told the wrong default looks for `values[]` in a body that carries
  // `total_value`, and reports the account has no data.
  assertMentions(
    describeOf(spec.input, 'metric_type'),
    'Return an aggregated "total_value" (default) or a per-interval "time_series".',
  );
  assertMentions(
    describeOf(spec.input, 'metric_type'),
    'Instagram serves "time_series" only for: reach; any other metric with it is refused.',
  );
  assertMentions(describeOf(spec.input, 'until'), 'Must not be before since.');

  // Seconds, not milliseconds: the same instant expressed in the other unit
  // lands in the year 55000 — outside retention, so the request is refused
  // rather than silently answered for the wrong window.
  assertMentions(describeOf(spec.input, 'since'), 'Range start as a Unix timestamp in seconds.');
  assertMentions(describeOf(spec.input, 'until'), 'Range end as a Unix timestamp in seconds.');
  assertMentions(describeOf(spec.input, 'until'), 'Omit for the default 24h lookback.');
  // Clamped-and-flagged and rejected are different outcomes, and only the
  // description says which range gets which. A model that expects a rejection
  // for both never reads the flag, and reports a clamped window as the one it
  // asked for.
  assertMentions(
    describeOf(spec.input, 'since'),
    'a partially-old range is clamped and flagged; a fully-old range is rejected.',
  );
});

test('media insights describes the product-type dependency and the empty-answer cases', () => {
  const spec = toolByName('instagram_get_media_insights');
  const d = spec.description;
  assertMentions(d, 'Insights for a single media object (GET /{media-id}/insights).');
  // The hint is what turns a wasted call into a local refusal. Described as
  // optional decoration, a model omits it and pays a round trip to learn that
  // `navigation` is story-only.
  assertMentions(
    d,
    'The valid metric set varies by media_product_type; supply media_product_type to have ' +
      'invalid combinations rejected client-side.',
  );
  // An empty body here is a property of the media, not a failure of the tool.
  // Without this sentence a model retries, or tells the operator their account
  // has no insights at all.
  assertMentions(
    d,
    'Insights on media created before the account became professional, or on an expired story, ' +
      'may return empty or error.',
  );

  const metrics = describeOf(spec.input, 'metrics');
  // Both halves of the per-product-type default (CC-INS-14), not just the feed
  // one. A description that names the feed set and stops is worse than no
  // description for the story case: it tells the model the exact request that
  // used to come back as a client-side refusal.
  assertMentions(
    metrics,
    'Defaults to the set valid for the media: views, reach, likes, comments, saved, shares, ' +
      'total_interactions for a feed post or a reel, and views, reach, replies, shares, ' +
      'total_interactions, navigation when media_product_type is STORY.',
  );
  assertMentions(metrics, 'An absent or unrecognized media_product_type gets the feed set.');
  assertMentions(
    metrics,
    'Validity depends on the media type: "navigation" and "replies" are story-only and are ' +
      'refused for feed posts and reels.',
  );

  const hint = describeOf(spec.input, 'media_product_type');
  // Naming where the value comes from is what makes the hint reachable: a model
  // that cannot source it guesses a spelling, and an unrecognised one silently
  // disables the client-side check it was supposed to enable.
  assertMentions(hint, 'known values: FEED, REELS, STORY; obtainable from instagram_get_media');
  assertMentions(
    hint,
    'When supplied and recognized, it selects the default metric set for that type and ' +
      'invalid metric/type combinations are refused before the call is spent.',
  );
});

test('audience demographics describes the 100-follower floor and that it takes a timeframe', () => {
  const spec = toolByName('instagram_get_audience_demographics');
  const d = spec.description;
  assertMentions(
    d,
    'Follower / engaged-audience demographics for the operated account ' +
      '(GET /{ig-id}/insights with metric_type=total_value).',
  );
  // The floor is Meta's, not this server's, and it is the likeliest reason a
  // perfectly formed call comes back as an error. A model that has not been
  // told reads that error as a broken token or a missing permission.
  assertMentions(
    d,
    'Requires a timeframe and an account with at least 100 followers; below that threshold ' +
      'Meta returns an error naming the 100-follower rule.',
  );

  assertMentions(
    describeOf(spec.input, 'metrics'),
    'Defaults to ["follower_demographics"]; "engaged_audience_demographics" describes the ' +
      'accounts that engaged.',
  );
  // "single" is the load-bearing word: the argument is one dimension, never a
  // list, and a model that reads it as a list sends an array to an enum and
  // gets a validation error in place of the breakdown it wanted.
  assertMentions(
    describeOf(spec.input, 'breakdown'),
    'The single dimension to break the demographics down by.',
  );
  const timeframe = describeOf(spec.input, 'timeframe');
  // These are the only insights that do NOT take since/until. Left unsaid, a
  // model reaches for the window arguments its sibling tool taught it and the
  // call is refused for a reason the arguments do not explain.
  assertMentions(
    timeframe,
    'The window the demographics are computed over (demographics use timeframe, not since/until).',
  );
  assertMentions(timeframe, 'Requires an account with at least 100 followers.');
});

test('online followers describes its 30-day window and its own deprecation risk', () => {
  const spec = toolByName('instagram_get_online_followers');
  const d = spec.description;
  assertMentions(
    d,
    "Hourly distribution of when the account's followers are online " +
      '(GET /{ig-id}/insights?metric=online_followers&period=lifetime).',
  );
  // `period=lifetime` in the URL reads as "all time". It is not: the series
  // covers 30 days, and a model that charts it as the account's history draws a
  // conclusion about a year from one month of data.
  assertMentions(d, 'Data covers the last 30 days only.');
  // This tool can start failing without anything here changing. Saying so is
  // what lets a model report a removed metric as removed instead of retrying it
  // or blaming the token.
  assertMentions(
    d,
    'This metric is on the deprecation watch-list (present in the legacy reference, absent ' +
      'from the current docs tree) and may return a "metric no longer available" error in ' +
      'future API versions.',
  );

  // No arguments at all: the description is the entire model-facing contract,
  // which is why every sentence of it is pinned above.
  assert.deepEqual(Object.keys(spec.input), []);
});

// --- published contract -----------------------------------------------------

/**
 * One live `McpServer` with the four insights tools registered, reachable
 * through a real `Client` over an in-memory transport. The test below asserts on
 * the PUBLISHED contract — what an MCP host is actually handed — and the
 * published form only exists after the registry and the SDK have compiled the
 * zod shapes, so a real server is the only place it can be read.
 */
async function liveInsightsServer(
  req: IgRequestFn,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = new McpServer({ name: 'instagram-mcp-ai-insights-test', version: '0.0.0' });
  registerTools({
    server,
    tools: insightsTools,
    profiles: [
      {
        name: 'default',
        authPath: 'ig-login',
        accessToken: 'tok',
        accountId: '17841400000000000',
      },
    ],
    defaultProfileName: 'default',
    settings,
    clock: fakeClock(NOW_MS),
    log: noopLogger,
    makeRequest: () => req,
    // `insights` is part of the default `core` selection, but naming it keeps
    // this server to exactly these four tools no matter what `core` grows to.
    env: { IG_TOOL_PACKAGES: 'insights' },
  });
  const client = new Client({ name: 'insights-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * The published form of one tool, reduced to what a host is actually told: the
 * `$schema` dialect marker is dropped because it is the SDK's choice of
 * JSON-Schema draft and says nothing about this package, and the `account`
 * property is dropped because `mcp/registry.ts` injects it into every tool in
 * the server (its own tests own it — pinning it here would make every insights
 * golden a hostage to a registry change).
 */
function pinned(schema: unknown): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined;
  const out: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  delete out.$schema;
  const properties = out.properties as Record<string, unknown> | undefined;
  if (properties !== undefined) {
    const ownProperties = { ...properties };
    delete ownProperties.account;
    out.properties = ownProperties;
  }
  return out;
}

/**
 * The one metric row all four tools publish (`insightMetricOutput`). Written out
 * once because the four genuinely publish one shape: if any of them ever
 * diverges, its comparison below fails and the divergence has to be made on
 * purpose. It is a hand-written expectation like everything else here, never
 * read off the schema under test.
 */
const PUBLISHED_METRIC_ROW = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    period: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    id: { type: 'string' },
    values: { type: 'array', items: { type: 'object', additionalProperties: {} } },
    total_value: { type: 'object', additionalProperties: {} },
    omittedValues: {
      type: 'integer',
      description:
        'How many intervals Instagram sent in values that were unreadable and left out (a ' +
        'values that is not a list counts as one); values then covers less than the whole ' +
        'period, or is missing, so a sum over it is partial.',
    },
    omittedTotalValues: {
      type: 'integer',
      description:
        'How many measurements Instagram sent in total_value (its value, a breakdown, or one ' +
        'breakdown result) that were unreadable and left out; the total or a sum over the ' +
        'breakdowns is then partial or missing.',
    },
  },
  required: ['name'],
  additionalProperties: true,
};

/**
 * The exact contract the four insights tools publish, transcribed by hand from
 * src/tools/insights.ts rather than captured from the running server: an
 * expectation derived from the object under test pins nothing.
 *
 * What this catches: the defect class where first-party model-facing text — a
 * tool `description`, a `title`, an argument's `.describe()` — is rewritten into
 * something materially worse while every `assertMentions(...)` fragment in this
 * file still passes. A fragment pins only the bytes it quotes: the words around
 * it, the words before the first quoted phrase, and anything ADDED (no fragment
 * can assert absence) are all free to rot under a fully green suite.
 *
 * Why a model reading worse wording acts differently FOR THIS PACKAGE:
 *
 *   - `insights` is in the default `core` selection, so this text is in front of
 *     every operator's model, not behind an opt-in like `discovery`.
 *   - These descriptions are the only statement anywhere in the server that the
 *     metric vocabulary is the POST-2025 one. Meta deleted `impressions`,
 *     `profile_views` and `video_views`; a model that reads "pre-2025 set" reaches
 *     for names that no longer exist, and the enum refuses them one call at a time
 *     without ever saying why the whole family is gone.
 *   - `media_product_type` is an OPTIONAL hint whose entire value is refusing an
 *     impossible metric/type combination before the call is spent. Published as
 *     "Required", a model that cannot obtain the product type either refuses a
 *     call it could have made or invents a value — and an invented hint makes the
 *     client-side matrix refuse a combination that was actually valid.
 *   - `timeframe` is the one REQUIRED window argument in a package where every
 *     sibling tool takes `since`/`until`. Published as "Optional", a model omits
 *     it and gets a Graph error that names nothing it passed.
 *   - `since` says the bare call is a 24h lookback. That sentence is the only
 *     thing standing between "yesterday" and "the last month" when a model reads
 *     a number out of an unparameterised call and puts it in a report.
 *   - On demographics, `metrics` selects a POPULATION (followers vs the accounts
 *     that engaged) and `breakdown` selects the DIMENSION (age/gender/city/
 *     country). Calling `metrics` a set of "breakdowns" collapses the two axes,
 *     and the failure mode is silent: the call succeeds and the model reports
 *     engaged-audience numbers as follower numbers.
 *   - `media_id` is validated by `graphObjectId()`, i.e. `[A-Za-z0-9_-]{1,64}` —
 *     a permalink shortcode passes that pattern unchanged. Text inviting one is
 *     not caught locally; it is caught by Meta, after the call is spent.
 *
 * Mutants measured as surviving the whole tools+api surface before this test
 * existed (test/tools/*.test.ts + test/api/*.test.ts + test/mcp/registry.test.ts
 * + test/mcp/tool-metadata-contract.test.ts + test/docs-sync.test.ts, all green
 * at 816 passed / 0 failed with the mutation in place):
 *   - `media_id` describe gains `(accepts a permalink shortcode too)`
 *   - `media_product_type` describe `Optional product-type hint` -> `Required …`
 *   - `timeframe` describe `Required. The window …` -> `Optional. The window …`
 *   - `metrics` describe `(post-2025 set)` -> `(pre-2025 set)`
 *   - `since` describe `default 24h lookback` -> `default 30-day lookback`
 *   - demographics `metrics` describe `Which demographic populations to fetch.`
 *     -> `Which demographic breakdowns to fetch.`
 */
const PUBLISHED_CONTRACT: Record<string, unknown> = {
  instagram_get_account_insights: {
    name: 'instagram_get_account_insights',
    title: 'Get account insights',
    description:
      'Account-level insights for the operated Instagram professional account ' +
      '(GET /{ig-id}/insights). Uses the post-2025 views-centric metric set. Returns aggregated ' +
      "totals by default; time ranges are bounded by Meta's 90-day retention. A requested " +
      'metric Instagram returned no data for is listed in missingMetrics and explained in ' +
      'notes; it is absent, not zero. Credentials are stripped from the paging URLs.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        metrics: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string',
            enum: [
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
            ],
          },
          description:
            'Account metrics to fetch (post-2025 set). Defaults to all of: views, reach, ' +
            'accounts_engaged, total_interactions, likes, comments, shares, saves, replies, ' +
            'follows_and_unfollows, profile_links_taps; with metric_type "time_series" it ' +
            'defaults to reach. Legacy names (impressions, ' +
            'profile_views, video_views) no longer exist and are rejected.',
        },
        period: {
          type: 'string',
          enum: ['day', 'week', 'days_28'],
          description: 'Aggregation period. Defaults to "day".',
        },
        metric_type: {
          type: 'string',
          enum: ['total_value', 'time_series'],
          description:
            'Return an aggregated "total_value" (default) or a per-interval "time_series". ' +
            'Instagram serves "time_series" only for: reach; any other metric with it is refused.',
        },
        since: {
          type: 'integer',
          description:
            "Range start as a Unix timestamp in seconds. Omit for Meta's default 24h lookback. " +
            'Data older than the 90-day retention window is not available — a partially-old ' +
            'range is clamped and flagged; a fully-old range is rejected.',
        },
        until: {
          type: 'integer',
          description:
            'Range end as a Unix timestamp in seconds. Omit for the default 24h lookback. ' +
            'Must not be before since.',
        },
      },
      // No `required` list: every account-insights argument is optional, which is
      // what makes a bare call legal and the 24h default above load-bearing.
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        metrics: { type: 'array', items: PUBLISHED_METRIC_ROW },
        window: {
          type: 'object',
          properties: {
            since: { type: 'number' },
            until: { type: 'number' },
            clamped: { type: 'boolean' },
          },
          required: ['clamped'],
          additionalProperties: true,
        },
        notes: { type: 'array', items: { type: 'string' } },
        paging: { type: 'object', additionalProperties: {} },
        missingMetrics: { type: 'array', items: { type: 'string' } },
      },
      required: ['metrics', 'window', 'notes'],
      additionalProperties: false,
    },
  },

  instagram_get_media_insights: {
    name: 'instagram_get_media_insights',
    title: 'Get media insights',
    description:
      'Insights for a single media object (GET /{media-id}/insights). The valid metric set ' +
      'varies by media_product_type; supply media_product_type to have invalid combinations ' +
      'rejected client-side. Insights on media created before the account became professional, ' +
      'or on an expired story, may return empty or error. A requested metric Instagram ' +
      'returned no data for is listed in missingMetrics and explained in note; it is absent, ' +
      'not zero.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        media_id: {
          type: 'string',
          minLength: 1,
          pattern: '^[A-Za-z0-9_-]{1,64}$',
          description: 'The media object ID to fetch insights for.',
        },
        metrics: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string',
            enum: [
              'views',
              'reach',
              'likes',
              'comments',
              'saved',
              'shares',
              'total_interactions',
              'navigation',
              'replies',
            ],
          },
          description:
            'Media metrics to fetch. Defaults to the set valid for the media: views, reach, ' +
            'likes, comments, saved, shares, total_interactions for a feed post or a reel, and ' +
            'views, reach, replies, shares, total_interactions, navigation when ' +
            'media_product_type is STORY. An absent or unrecognized media_product_type gets the ' +
            'feed set. Validity depends on the media type: "navigation" and "replies" are ' +
            'story-only and are refused for feed posts and reels.',
        },
        media_product_type: {
          type: 'string',
          description:
            'Optional product-type hint (known values: FEED, REELS, STORY; obtainable from ' +
            'instagram_get_media). When supplied and recognized, it selects the default metric ' +
            'set for that type and invalid metric/type combinations are refused before the ' +
            'call is spent.',
        },
      },
      required: ['media_id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        mediaId: { type: 'string' },
        metrics: { type: 'array', items: PUBLISHED_METRIC_ROW },
        missingMetrics: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
      required: ['mediaId', 'metrics'],
      additionalProperties: false,
    },
  },

  instagram_get_audience_demographics: {
    name: 'instagram_get_audience_demographics',
    title: 'Get audience demographics',
    description:
      'Follower / engaged-audience demographics for the operated account ' +
      '(GET /{ig-id}/insights with metric_type=total_value). Requires a timeframe and an ' +
      'account with at least 100 followers; below that threshold Meta returns an error naming ' +
      'the 100-follower rule. A requested metric Instagram returned no data for is listed in ' +
      'missingMetrics and explained in note; it is absent, not zero.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        metrics: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string',
            enum: ['follower_demographics', 'engaged_audience_demographics'],
          },
          description:
            'Which demographic populations to fetch. Defaults to ["follower_demographics"]; ' +
            '"engaged_audience_demographics" describes the accounts that engaged.',
        },
        breakdown: {
          type: 'string',
          enum: ['age', 'gender', 'city', 'country'],
          description: 'The single dimension to break the demographics down by.',
        },
        timeframe: {
          type: 'string',
          enum: [
            'last_14_days',
            'last_30_days',
            'last_90_days',
            'prev_month',
            'this_month',
            'this_week',
          ],
          description:
            'Required. The window the demographics are computed over (demographics use ' +
            'timeframe, not since/until). Requires an account with at least 100 followers.',
        },
      },
      required: ['breakdown', 'timeframe'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        metrics: { type: 'array', items: PUBLISHED_METRIC_ROW },
        breakdown: { type: 'string' },
        timeframe: { type: 'string' },
        missingMetrics: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
      required: ['metrics', 'breakdown', 'timeframe'],
      additionalProperties: false,
    },
  },

  instagram_get_online_followers: {
    name: 'instagram_get_online_followers',
    title: 'Get online followers',
    description:
      "Hourly distribution of when the account's followers are online " +
      '(GET /{ig-id}/insights?metric=online_followers&period=lifetime). Data covers the last ' +
      '30 days only. This metric is on the deprecation watch-list (present in the legacy ' +
      'reference, absent from the current docs tree) and may return a "metric no longer ' +
      'available" error in future API versions. When Instagram returns no online_followers ' +
      'data, missingMetrics and note say so rather than an empty metrics list standing alone.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    // This tool takes no arguments of its own, so the published input carries
    // nothing but the registry's injected `account` — which `pinned()` removes.
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        metrics: { type: 'array', items: PUBLISHED_METRIC_ROW },
        missingMetrics: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
      required: ['metrics'],
      additionalProperties: false,
    },
  },
};

test('real McpServer: the published contract of every insights tool is pinned exactly', async () => {
  const { ctx } = makeCtx({ response: { data: [] } });
  const live = await liveInsightsServer(ctx.req);
  try {
    const { tools } = await live.client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      Object.keys(PUBLISHED_CONTRACT).sort(),
      'the registered set is exactly the pinned set — nothing added, nothing dropped',
    );
    for (const [name, expected] of Object.entries(PUBLISHED_CONTRACT)) {
      const listed = tools.find((t) => t.name === name);
      assert.ok(listed, `${name} is registered`);
      assert.deepEqual(
        {
          name: listed.name,
          title: listed.title,
          description: listed.description,
          annotations: listed.annotations,
          inputSchema: pinned(listed.inputSchema),
          outputSchema: pinned(listed.outputSchema),
        },
        expected,
        `${name} publishes its pinned contract`,
      );
    }
  } finally {
    await live.close();
  }
});

// --- publishable metric rows (CC-INS-15) ------------------------------------

test('a metric row Meta typed loosely costs the caller that field, not the call (CC-INS-15)', async () => {
  // `api/insights.ts` CASTS the Graph body, so `InsightMetric.name: string`
  // promises only that Meta put something there, and the registry validates
  // `structuredContent` against `insightMetricOutput` on the way out. Measured
  // against a reply carrying the third row below, before the mapper existed:
  // `MCP error -32602: Output validation error: Invalid structured content for
  // tool instagram_get_account_insights: Required at metrics[0].name` — twenty
  // good metrics lost to one nameless row. A real McpServer/Client pair is used
  // for that reason: calling the handler directly never runs that validator.
  const { ctx } = makeCtx({
    response: {
      data: [
        // Every declared-but-optional field, each the wrong type at once.
        { name: 'views', period: null, title: 7, description: [], id: {}, values: 'nope' },
        // The salvageable row: `values` loses its degenerate intervals and keeps
        // the real one, because a time series with one bad interval is still a
        // time series.
        {
          name: 'reach',
          period: 'day',
          title: 'Reach',
          description: 'Accounts reached',
          id: '17841400000000000/insights/reach/day',
          values: [{ value: 1, end_time: '2026-09-23T07:00:00+0000' }, null, 'x', ['y'], 3],
          total_value: { value: 2 },
        },
        // No name, a non-string name, and three things that are not rows at all:
        // there is no honest value to invent for `name`, so these go whole.
        { period: 'day' },
        { name: 42 },
        null,
        'x',
        ['y'],
        // A `total_value` that is not an object, and an additive Meta field that
        // must still ride along untouched (CC-DATA-7).
        { name: 'likes', total_value: 5, brand_new_meta_field: 5 },
      ],
      paging: null,
    },
  });
  const live = await liveInsightsServer(ctx.req);

  try {
    const res = await live.client.callTool({
      name: 'instagram_get_account_insights',
      arguments: {},
    });
    assert.notEqual(res.isError, true, 'one mistyped row must not cost the caller every metric');
    // Asserted field by field rather than as one object: `window` is computed
    // here from already-validated inputs and carries `since`/`until` as own keys
    // holding `undefined`, which an in-memory transport preserves and a real
    // stdio one would drop in `JSON.stringify`. Pinning that difference would
    // pin the transport, not the contract under test.
    const sc = res.structuredContent as Record<string, unknown>;
    assert.deepEqual(sc.metrics, [
      // The `values: 'nope'` that went is counted like the likes row's
      // non-object `total_value` below (CC-INS-24).
      { name: 'views', omittedValues: 1 },
      {
        name: 'reach',
        period: 'day',
        title: 'Reach',
        description: 'Accounts reached',
        id: '17841400000000000/insights/reach/day',
        values: [{ value: 1, end_time: '2026-09-23T07:00:00+0000' }],
        omittedValues: 4,
        total_value: { value: 2 },
      },
      { name: 'likes', brand_new_meta_field: 5, omittedTotalValues: 1 },
    ]);
    assert.equal(
      Object.hasOwn(sc, 'paging'),
      false,
      'a null paging is dropped, not republished as null',
    );
    // Only the three rows with a string name count as delivered; the default
    // metrics they do not cover are named, through the live output validator.
    const missing = ACCOUNT_METRICS.filter((m) => !['views', 'reach', 'likes'].includes(m));
    assert.deepEqual(sc.missingMetrics, missing);
    assert.deepEqual(sc.notes, [missingNote(missing)]);
  } finally {
    await live.close();
  }
});

test('an insights series that lost intervals says how many, and a clean one says nothing (CC-INS-18)', async () => {
  // Filtering an unreadable interval out of `values` keeps the call alive
  // (CC-INS-15), but a model summing the series it was handed would state a
  // partial total as the whole period's. The count is the server's own: a wire
  // field of the same name is removed first, so a mistyped one can neither be
  // republished as ours nor fail the output validation of the whole call.
  const { ctx } = makeCtx({
    response: {
      data: [
        { name: 'reach', values: [{ value: 1 }, null, { value: 2 }], omittedValues: 'lots' },
        { name: 'views', values: [{ value: 3 }], omittedValues: 7 },
        { name: 'likes', values: [], omittedValues: 7 },
      ],
    },
  });
  const live = await liveInsightsServer(ctx.req);

  try {
    const res = await live.client.callTool({
      name: 'instagram_get_account_insights',
      arguments: {},
    });
    assert.notEqual(
      res.isError,
      true,
      'a wire omittedValues of the wrong type must not fail the call',
    );
    const sc = res.structuredContent as Record<string, unknown>;
    assert.deepEqual(sc.metrics, [
      { name: 'reach', values: [{ value: 1 }, { value: 2 }], omittedValues: 1 },
      { name: 'views', values: [{ value: 3 }] },
      { name: 'likes', values: [] },
    ]);
  } finally {
    await live.close();
  }
});

test('an interval with no readable measurement is counted, not published as data (CC-INS-19)', async () => {
  // `values[]` entries were kept whenever they were objects, so an interval whose
  // `value` was `null`, a string or absent was published beside the real ones and
  // `omittedValues` stayed silent: a model summing the series read `null` as
  // nothing and stated a partial total as the whole period's. A finite number and
  // an object (the per-hour map `online_followers` sends) are the readable shapes.
  const { ctx } = makeCtx({
    response: {
      data: [
        {
          name: 'reach',
          values: [
            { value: 1, end_time: 'a' },
            { value: null, end_time: 'b' },
            { value: '2', end_time: 'c' },
            { end_time: 'd' },
            { value: Number.NaN, end_time: 'e' },
            { value: { '0': 4 }, end_time: 'f' },
            { value: 0, end_time: 'g' },
          ],
        },
      ],
    },
  });
  const live = await liveInsightsServer(ctx.req);

  try {
    const res = await live.client.callTool({
      name: 'instagram_get_account_insights',
      arguments: {},
    });
    assert.notEqual(res.isError, true);
    const sc = res.structuredContent as Record<string, unknown>;
    assert.deepEqual(sc.metrics, [
      {
        name: 'reach',
        values: [
          { value: 1, end_time: 'a' },
          { value: { '0': 4 }, end_time: 'f' },
          { value: 0, end_time: 'g' },
        ],
        omittedValues: 4,
      },
    ]);
  } finally {
    await live.close();
  }
});

test('a per-bucket interval map with an unreadable member is counted, not published as data (CC-INS-23)', async () => {
  // CC-INS-19 held a scalar `value` to "finite number" but let ANY object
  // through as a map, so `{ "0": "12", "1": null }` was published as an hourly
  // `online_followers` distribution — the `Record<string, number>` the api type
  // declares — and a model reading "when are my followers online" summed a
  // string and a null into it. A map is readable only when every member is a
  // finite number; one bad member costs the whole interval, counted, because a
  // quietly missing hour is the partial-total defect over again. An empty map
  // lost nothing and stays.
  const { ctx } = makeCtx({
    response: {
      data: [
        {
          name: 'online_followers',
          values: [
            { value: { '0': 4, '1': 0 }, end_time: 'a' },
            { value: { '0': '12', '1': 3 }, end_time: 'b' },
            { value: { '0': null }, end_time: 'c' },
            { value: { '0': { nested: 1 } }, end_time: 'd' },
            { value: { '0': [1] }, end_time: 'e' },
            { value: {}, end_time: 'f' },
          ],
        },
      ],
    },
  });
  const live = await liveInsightsServer(ctx.req);

  try {
    const res = await live.client.callTool({
      name: 'instagram_get_online_followers',
      arguments: {},
    });
    assert.notEqual(res.isError, true);
    const sc = res.structuredContent as Record<string, unknown>;
    assert.deepEqual(sc.metrics, [
      {
        name: 'online_followers',
        values: [
          { value: { '0': 4, '1': 0 }, end_time: 'a' },
          { value: {}, end_time: 'f' },
        ],
        omittedValues: 4,
      },
    ]);
  } finally {
    await live.close();
  }
});

test('a `values` that is present but not a list is counted as lost, not dropped silently (CC-INS-24)', async () => {
  // `metricRow` deleted a non-list `values` and said nothing, so
  // `{ name: 'reach', values: null }` was published as a bare `{ name: 'reach' }`
  // — a row that arrived, is therefore not in `missingMetrics`, and does not say
  // it lost its only measurement. A non-object `total_value` has counted as one
  // lost measurement all along (CC-INS-20); `values` now counts the same way. An
  // absent `values` is a row that sent none and stays silent.
  const { ctx } = makeCtx({
    response: {
      data: [
        { name: 'views', values: null },
        { name: 'reach', values: 'nope' },
        { name: 'likes', values: { value: 1 } },
        { name: 'comments', values: 0 },
        { name: 'shares', total_value: { value: 3 } },
      ],
    },
  });
  const live = await liveInsightsServer(ctx.req);

  try {
    const res = await live.client.callTool({
      name: 'instagram_get_account_insights',
      arguments: { metrics: ['views', 'reach', 'likes', 'comments', 'shares'] },
    });
    assert.notEqual(res.isError, true);
    const sc = res.structuredContent as Record<string, unknown>;
    assert.deepEqual(sc.metrics, [
      { name: 'views', omittedValues: 1 },
      { name: 'reach', omittedValues: 1 },
      { name: 'likes', omittedValues: 1 },
      { name: 'comments', omittedValues: 1 },
      { name: 'shares', total_value: { value: 3 } },
    ]);
  } finally {
    await live.close();
  }
});

test('an unreadable total_value measurement is counted, not published as data (CC-INS-20)', async () => {
  // `total_value` was kept whenever it was an object, so a `value` of `null` or
  // `'12'` reached the caller as the metric's total — the defect CC-INS-19
  // closed for `values[]`, one field over. A present non-object total counts as
  // one measurement lost; a clean total counts nothing; a wire field of the same
  // name is replaced by the server's own count, so it can never fail the call.
  const { ctx } = makeCtx({
    response: {
      data: [
        { name: 'views', total_value: { value: 12 }, omittedTotalValues: 'lots' },
        { name: 'reach', total_value: { value: null } },
        { name: 'likes', total_value: { value: '12' } },
        { name: 'comments', total_value: { value: Number.POSITIVE_INFINITY } },
        { name: 'shares', total_value: null },
        { name: 'saves', total_value: ['7'] },
        { name: 'replies', total_value: { value: 0 }, omittedTotalValues: 3 },
        { name: 'follows', total_value: {} },
        { name: 'profile_links_taps', total_value: { value: 'x', extra_meta_field: 1 } },
        { name: 'website_clicks', total_value: { value: 5, breakdowns: 'by city' } },
      ],
    },
  });
  const live = await liveInsightsServer(ctx.req);

  try {
    const res = await live.client.callTool({
      name: 'instagram_get_account_insights',
      arguments: {},
    });
    assert.notEqual(res.isError, true);
    const sc = res.structuredContent as Record<string, unknown>;
    assert.deepEqual(sc.metrics, [
      { name: 'views', total_value: { value: 12 } },
      { name: 'reach', omittedTotalValues: 1 },
      { name: 'likes', omittedTotalValues: 1 },
      { name: 'comments', omittedTotalValues: 1 },
      { name: 'shares', omittedTotalValues: 1 },
      { name: 'saves', omittedTotalValues: 1 },
      { name: 'replies', total_value: { value: 0 } },
      // An empty object is what Meta sent and claims nothing; it is kept as is.
      { name: 'follows', total_value: {} },
      // A total left with no readable measurement goes whole, an additive key
      // beside it included: `{ extra_meta_field: 1 }` published as the metric's
      // total would read as a total that exists. The count says what was lost.
      { name: 'profile_links_taps', omittedTotalValues: 1 },
      // A readable total survives the loss of an unreadable breakdown beside it.
      { name: 'website_clicks', total_value: { value: 5 }, omittedTotalValues: 1 },
    ]);
  } finally {
    await live.close();
  }
});

test('an unreadable demographic breakdown result is counted, not published as a bucket (CC-INS-21)', async () => {
  // Demographics arrive as `total_value.breakdowns[].results[]`, one bucket per
  // result. A bucket whose count is `null` or a string, or whose
  // `dimension_values` is not a list of strings, was published beside the real
  // ones: a model summing the buckets stated a partial audience as the whole.
  // Each bad result, each entry with no readable `results` list, and a
  // `breakdowns` that is not a list each count as one; the good buckets stay in
  // order, and extra keys on an entry ride along (CC-DATA-7).
  const { ctx } = makeCtx({
    response: {
      data: [
        {
          name: 'follower_demographics',
          total_value: {
            breakdowns: [
              {
                dimension_keys: ['city'],
                results: [
                  { dimension_values: ['London'], value: 12 },
                  { dimension_values: ['Paris'], value: null },
                  { dimension_values: ['Rome'], value: '3' },
                  { dimension_values: 'Oslo', value: 4 },
                  { dimension_values: [5], value: 4 },
                  null,
                  { dimension_values: ['Sofia'], value: 0 },
                ],
              },
              null,
              { dimension_keys: ['age'], results: 'nope' },
              { dimension_keys: ['gender'] },
            ],
          },
        },
        { name: 'engaged_audience_demographics', total_value: { breakdowns: { city: 1 } } },
        // A row nobody asked for still rides along (CC-DATA-7) and is judged the same.
        {
          name: 'reached_audience_demographics',
          total_value: { breakdowns: [{ dimension_keys: ['city'], results: [{ value: 'x' }] }] },
        },
      ],
    },
  });
  const live = await liveInsightsServer(ctx.req);

  try {
    const res = await live.client.callTool({
      name: 'instagram_get_audience_demographics',
      arguments: {
        metrics: ['follower_demographics', 'engaged_audience_demographics'],
        breakdown: 'city',
        timeframe: 'this_month',
      },
    });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    const sc = res.structuredContent as Record<string, unknown>;
    assert.deepEqual(sc.metrics, [
      {
        name: 'follower_demographics',
        total_value: {
          breakdowns: [
            {
              dimension_keys: ['city'],
              results: [
                { dimension_values: ['London'], value: 12 },
                { dimension_values: ['Sofia'], value: 0 },
              ],
            },
          ],
        },
        omittedTotalValues: 8,
      },
      // Nothing readable left: the object goes rather than being published empty.
      { name: 'engaged_audience_demographics', omittedTotalValues: 1 },
      { name: 'reached_audience_demographics', omittedTotalValues: 1 },
    ]);
  } finally {
    await live.close();
  }
});

test('a clean demographic breakdown passes through whole and counts nothing (CC-INS-21)', async () => {
  // The positive half: an entry whose `results` list is EMPTY is a readable
  // answer ("no buckets"), not a lost one, and an absent `value` on a
  // demographics total is Meta's normal shape, not a dropped measurement.
  const total = {
    breakdowns: [
      {
        dimension_keys: ['age', 'gender'],
        results: [{ dimension_values: ['18-24', 'F'], value: 5 }],
      },
      { dimension_keys: ['city'], results: [] },
    ],
  };
  const { ctx } = makeCtx({
    response: { data: [{ name: 'follower_demographics', total_value: total }] },
  });
  const live = await liveInsightsServer(ctx.req);

  try {
    const res = await live.client.callTool({
      name: 'instagram_get_audience_demographics',
      arguments: { metrics: ['follower_demographics'], breakdown: 'age', timeframe: 'this_month' },
    });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    const sc = res.structuredContent as Record<string, unknown>;
    assert.deepEqual(sc.metrics, [{ name: 'follower_demographics', total_value: total }]);
  } finally {
    await live.close();
  }
});

test('a `data` that is not a list is an empty page, and a real `paging` object survives (CC-INS-15)', async () => {
  // `metrics: res.data ?? []` types the edge as a list; the wire is not obliged
  // to agree. Measured before the mapper: `Expected array, received object at
  // metrics`. `paging` is the only other field of this result that comes off the
  // wire — it is republished when it really is an object and dropped when it is
  // not, and the previous test covers the dropping half.
  const { ctx } = makeCtx({
    response: { data: { name: 'views' }, paging: { cursors: { after: 'C1' } } },
  });
  const live = await liveInsightsServer(ctx.req);

  try {
    const res = await live.client.callTool({
      name: 'instagram_get_account_insights',
      arguments: {},
    });
    assert.notEqual(res.isError, true, 'an object where a list was promised is not a caller error');
    const sc = res.structuredContent as Record<string, unknown>;
    assert.deepEqual(sc.metrics, []);
    assert.deepEqual(sc.paging, { cursors: { after: 'C1' } });
    // ...and it is said to be unreadable, not "no data" (CC-INS-22), through
    // the live output validator.
    assert.deepEqual(sc.missingMetrics, [...ACCOUNT_METRICS]);
    assert.deepEqual(sc.notes, [
      'Instagram returned the metric list in a shape that is not a list, so none of the ' +
        `requested metric(s) could be read: ${ACCOUNT_METRICS.join(', ')}. They are unknown, not zero.`,
    ]);
  } finally {
    await live.close();
  }
});

test('the other three insights tools repair rows the same way and never invent a `paging` (CC-INS-15)', async () => {
  // All four tools publish `metrics` against the same schema, so all four share
  // one mapper; only the account tool's result carries `paging` at all, and the
  // mapper must not add the key to the three that do not declare it.
  const cases: ReadonlyArray<{ name: string; args: Record<string, unknown>; rest: object }> = [
    {
      name: 'instagram_get_media_insights',
      args: { media_id: '17841400000000001' },
      rest: {
        mediaId: '17841400000000001',
        missingMetrics: ['reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
        note: missingNote(['reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions']),
      },
    },
    {
      name: 'instagram_get_audience_demographics',
      args: { breakdown: 'city', timeframe: 'last_30_days' },
      rest: {
        breakdown: 'city',
        timeframe: 'last_30_days',
        missingMetrics: ['follower_demographics'],
        note: missingNote(['follower_demographics']),
      },
    },
    {
      name: 'instagram_get_online_followers',
      args: {},
      rest: { missingMetrics: ['online_followers'], note: missingNote(['online_followers']) },
    },
  ];

  for (const c of cases) {
    const { ctx } = makeCtx({
      response: { data: [{ period: 'day' }, { name: 'views', period: null }] },
    });
    const live = await liveInsightsServer(ctx.req);
    try {
      const res = await live.client.callTool({ name: c.name, arguments: c.args });
      assert.notEqual(res.isError, true, `${c.name} must not fail on a degenerate row`);
      assert.deepEqual(
        res.structuredContent,
        { ...c.rest, metrics: [{ name: 'views' }] },
        `${c.name} drops the nameless row, keeps the named one, and adds no paging`,
      );
    } finally {
      await live.close();
    }
  }
});

test('a typed Graph error reaches a real SDK client as a typed error, not a schema rejection (CC-DATA-61)', async () => {
  // Measured with @modelcontextprotocol/sdk 1.30.0: `Client.callTool` validates
  // `structuredContent` against the tool's outputSchema whenever it is present,
  // `isError` or not. An error result that carried `{ error: {...} }` therefore
  // came back from every tool with an outputSchema as `MCP error -32602:
  // Structured content does not match the tool's output schema`, and the
  // follower-threshold refusal (code 100) the model needs to explain was lost.
  const refusal = new InstagramError('Not enough followers for this metric', {
    kind: 'validation',
    status: 400,
    code: 100,
    subcode: 2108006,
  });
  const req: IgRequestFn = async () => {
    throw refusal;
  };
  const cases: ReadonlyArray<{ name: string; args: Record<string, unknown> }> = [
    { name: 'instagram_get_online_followers', args: {} },
    {
      name: 'instagram_get_audience_demographics',
      args: { breakdown: 'city', timeframe: 'last_30_days' },
    },
  ];
  for (const c of cases) {
    const live = await liveInsightsServer(req);
    try {
      // `listTools` first: the client only validates against schemas it has seen.
      const { tools } = await live.client.listTools();
      assert.notEqual(
        tools.find((t) => t.name === c.name)?.outputSchema,
        undefined,
        `${c.name} publishes an outputSchema, so the client validates its results`,
      );
      const res = await live.client.callTool({ name: c.name, arguments: c.args });
      assert.deepEqual(
        res,
        {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Instagram error (validation): Not enough followers for this metric (code 100, subcode 2108006)',
            },
          ],
        },
        `${c.name} hands the client the typed error in text and no structuredContent`,
      );
    } finally {
      await live.close();
    }
  }
});
