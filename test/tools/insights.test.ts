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
import { isInstagramError } from '../../src/core/types.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
  Settings,
} from '../../src/core/types.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { testSettings } from '../helpers/settings.js';

const NOW_MS = 1_700_000_000_000;
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
  assert.ok(res.structuredContent);
  assert.deepEqual((res.structuredContent as { metrics: unknown }).metrics, wire.data);
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
    { metrics: ['views', 'reach'], period: 'week', metric_type: 'time_series' },
    ctx,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, '/42/insights');
  // Each assertion pins one argument against the default it would silently
  // decay to: the full metric set, `day`, and `total_value` respectively.
  assert.equal(calls[0]?.params?.metric, 'views,reach');
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
  const { ctx, calls } = makeCtx({ response: { data: [] }, accountId: '42', nowMs: NOW_MS });
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
  assert.deepEqual(res.structuredContent, { mediaId: 'm3', metrics: [] });
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
