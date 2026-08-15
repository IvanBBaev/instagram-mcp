import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { insightsTools } from '../../src/tools/insights.js';
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
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.openWorldHint, true);
    assert.equal(t.annotations.destructiveHint, undefined);
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

test('every input field is described', () => {
  for (const t of insightsTools) {
    for (const [field, schema] of Object.entries(t.input)) {
      assert.ok(schema.description, `${t.name}.${field} must have a .describe()`);
    }
  }
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

test('demographics input requires both breakdown and timeframe', () => {
  const schema = strictInput(toolByName('instagram_get_audience_demographics'));
  assert.equal(schema.safeParse({ breakdown: 'age' }).success, false); // no timeframe
  assert.equal(schema.safeParse({ timeframe: 'last_30_days' }).success, false); // no breakdown
  assert.equal(schema.safeParse({ breakdown: 'age', timeframe: 'last_30_days' }).success, true);
  assert.equal(schema.safeParse({ breakdown: 'height', timeframe: 'last_30_days' }).success, false); // bad enum
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
  const { ctx, calls } = makeCtx({ response: { data: [] }, accountId: '5' });
  await toolByName('instagram_get_audience_demographics').handler(
    { breakdown: 'city', timeframe: 'this_month' },
    ctx,
  );
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
  const { ctx, calls } = makeCtx({ response: { data: [] }, accountId: '7' });
  const res = await toolByName('instagram_get_online_followers').handler({}, ctx);

  assert.ok(res.structuredContent);
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
});
