/**
 * Item-count bounds on array arguments (`tools/arrays.ts`).
 *
 * zod 4 runs `.min()` / `.max()` length checks on any value with a `length`,
 * even after the type check has refused it, so a single string handed to an
 * array argument came back with a second issue phrased about *characters*
 * ("Too big: expected string to have <=10 characters") next to the real one.
 * These drive the live registry seam — the text the model is actually handed —
 * for every bounded array argument, in both directions: a wrong-typed value
 * gets the type error alone, and a real array outside its bounds still gets the
 * item-count message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolResult } from '../../src/mcp/define.js';
import { registerTools } from '../../src/mcp/registry.js';
import type { Logger, ResolvedProfile } from '../../src/core/types.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { testSettings } from '../helpers/settings.js';
import { allTools } from '../../src/tools/index.js';
import { boundedArray } from '../../src/tools/arrays.js';

type RegisterCb = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

function registerAll(): Map<string, RegisterCb> {
  const cbs = new Map<string, RegisterCb>();
  const server = {
    registerTool(name: string, _config: unknown, cb: RegisterCb) {
      cbs.set(name, cb);
      return {};
    },
  } as unknown as McpServer;
  const igProfile: ResolvedProfile = { name: 'default', authPath: 'ig-login', accessToken: 'tok' };
  registerTools({
    server,
    tools: allTools,
    profiles: [igProfile],
    defaultProfileName: 'default',
    settings: testSettings(),
    clock: fakeClock(1_700_000_000_000),
    log: silent,
    makeRequest: () => () => Promise.reject(new Error('NO-NETWORK-MARKER')),
    env: { IG_TOOL_PACKAGES: 'all' },
    confirm: { isSupported: () => false, ask: () => Promise.reject(new Error('unused')) },
  });
  return cbs;
}

function textOf(res: ToolResult): string {
  return res.content.map((c) => c.text).join('\n');
}

/** Every bounded array argument, with the other arguments its tool requires. */
const ARRAY_FIELDS = [
  {
    tool: 'instagram_post_image',
    field: 'imageUrls',
    base: {},
    item: 'https://cdn/a.jpg',
    max: 10,
  },
  {
    tool: 'instagram_create_media_container',
    field: 'children',
    base: { mediaType: 'CAROUSEL' },
    item: '17841400008460056',
    max: 10,
  },
  { tool: 'instagram_get_account_insights', field: 'metrics', base: {}, item: 'reach' },
  {
    tool: 'instagram_get_media_insights',
    field: 'metrics',
    base: { media_id: '17841400008460056' },
    item: 'reach',
  },
  {
    tool: 'instagram_get_audience_demographics',
    field: 'metrics',
    base: { breakdown: 'age', timeframe: 'last_30_days' },
    item: 'follower_demographics',
  },
] as const;

test('a string handed to an array argument gets the type error alone, not a character count (CC-PUB-67)', async () => {
  const cbs = registerAll();
  for (const { tool, field, base, item } of ARRAY_FIELDS) {
    const cb = cbs.get(tool);
    assert.ok(cb, `${tool} is registered`);
    // The long string trips a `<=10` bound and the empty one a `>=1` bound —
    // both used to add a second, character-phrased issue.
    for (const value of [item.repeat(3), '']) {
      const text = textOf(await cb({ ...base, [field]: value }));
      assert.ok(
        text.endsWith(`: ${field}: Invalid input: expected array, received string.`),
        `${tool}.${field} = ${JSON.stringify(value)} carries exactly the type issue: ${text}`,
      );
      assert.equal(text.includes('characters'), false, `no string-length rule: ${text}`);
    }
  }
});

test('a real array outside its bounds still gets the item-count message (CC-PUB-67)', async () => {
  const cbs = registerAll();
  for (const spec of ARRAY_FIELDS) {
    const { tool, field, base, item } = spec;
    const cb = cbs.get(tool)!;
    const empty = textOf(await cb({ ...base, [field]: [] }));
    assert.ok(
      empty.includes(`${field}: Too small: expected array to have >=`),
      `${tool}.${field} = [] is refused by its minimum: ${empty}`,
    );
    if ('max' in spec) {
      const over = textOf(await cb({ ...base, [field]: Array(spec.max + 1).fill(item) }));
      assert.ok(
        over.includes(`${field}: Too big: expected array to have <=${spec.max} items`),
        `${tool}.${field} with ${spec.max + 1} items is refused by its maximum: ${over}`,
      );
    }
  }
});

test('boundedArray publishes the same item bounds as .min()/.max() (CC-PUB-67)', () => {
  const plain = z.toJSONSchema(z.array(z.string()).min(2).max(10));
  assert.deepEqual(z.toJSONSchema(boundedArray(z.string(), 2, 10)), plain);
  assert.deepEqual(
    z.toJSONSchema(boundedArray(z.string(), 1)),
    z.toJSONSchema(z.array(z.string()).min(1)),
  );
  const bounded = boundedArray(z.string(), 2, 3);
  assert.equal(bounded.safeParse(['a', 'b']).success, true);
  assert.equal(bounded.safeParse(['a', 'b', 'c']).success, true);
  assert.equal(bounded.safeParse(['a']).success, false);
  assert.equal(bounded.safeParse(['a', 'b', 'c', 'd']).success, false);
  const notArray = bounded.safeParse('abcd');
  assert.equal(notArray.success, false);
  assert.deepEqual(
    notArray.error?.issues.map((i) => i.code),
    ['invalid_type'],
  );
});
