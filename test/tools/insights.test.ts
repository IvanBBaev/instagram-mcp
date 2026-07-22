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

const settings: Settings = {
  maxConcurrent: 4,
  maxItems: 200,
  refreshAfterDays: 45,
  timeoutMs: 30_000,
  logLevel: 'info',
  prettyJson: false,
  writeMode: 'preview',
  allowDestructive: false,
  transport: 'stdio',
  httpHost: '127.0.0.1',
  httpPort: 3000,
};

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

test('online followers handler requests the lifetime online_followers metric', async () => {
  const { ctx, calls } = makeCtx({ response: { data: [] }, accountId: '7' });
  const res = await toolByName('instagram_get_online_followers').handler({}, ctx);

  assert.ok(res.structuredContent);
  assert.equal(calls[0]?.path, '/7/insights');
  assert.equal(calls[0]?.params?.metric, 'online_followers');
  assert.equal(calls[0]?.params?.period, 'lifetime');
});
