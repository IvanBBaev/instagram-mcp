/**
 * Unit tests for the fan-out tool specs (V3-F1). Handlers run against a
 * hand-built {@link ToolContext}; the opted-in case gets its `profiles`
 * directory from `fakeProfileDirectory`, so each profile is read through its
 * own context exactly as the registry would build it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext, ToolResult, ToolSpec } from '../../src/mcp/define.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
} from '../../src/core/types.js';
import { InstagramError } from '../../src/core/types.js';
import { toInstagramError } from '../../src/core/errors.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { fakeProfileDirectory } from '../helpers/ports.js';
import { testSettings } from '../helpers/settings.js';
import { fence } from '../../src/mcp/result.js';
import { FANOUT_OFF_NOTE, fanoutTools } from '../../src/tools/fanout.js';

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

const defaultProfile: ResolvedProfile = {
  name: 'default',
  authPath: 'ig-login',
  accessToken: 'token-default',
};
const brandProfile: ResolvedProfile = {
  name: 'brand',
  authPath: 'fb-login',
  accessToken: 'token-brand',
  accountId: '17841400000000002',
};
const shopProfile: ResolvedProfile = {
  name: 'shop',
  authPath: 'ig-login',
  accessToken: 'token-shop',
};

/** One call a profile's `req` received, tagged with the profile that made it. */
interface Call {
  profile: string;
  opts: IgRequestOptions;
}

function profileReq(
  profile: ResolvedProfile,
  calls: Call[],
  responder: (profile: ResolvedProfile) => unknown,
): IgRequestFn {
  return async <T>(opts: IgRequestOptions): Promise<T> => {
    calls.push({ profile: profile.name, opts });
    return responder(profile) as T;
  };
}

function ctxFor(
  profile: ResolvedProfile,
  calls: Call[],
  responder: (profile: ResolvedProfile) => unknown,
  pretty = false,
): ToolContext {
  return {
    req: profileReq(profile, calls, responder),
    settings: testSettings({ prettyJson: pretty }),
    profile,
    clock: fakeClock(0),
    log: noopLog,
  };
}

const tool: ToolSpec = (() => {
  const found = fanoutTools.find((t) => t.name === 'instagram_get_accounts_overview');
  assert.ok(found, 'the overview tool is present');
  return found;
})();

function sc(res: ToolResult): Record<string, unknown> {
  assert.ok(res.structuredContent, 'structuredContent is present');
  // As the client sees it: an absent optional field is dropped, not `undefined`.
  return JSON.parse(JSON.stringify(res.structuredContent)) as Record<string, unknown>;
}

const BODIES: Record<string, unknown> = {
  default: {
    id: '17841400000000001',
    username: 'me_default',
    followers_count: 100,
    follows_count: 10,
    media_count: 7,
  },
  brand: {
    id: '17841400000000002',
    username: 'the_brand',
    followers_count: 2500,
    follows_count: 3,
    media_count: 40,
  },
  shop: {
    id: '17841400000000003',
    username: 'shop',
    followers_count: 50,
    follows_count: 0,
    media_count: 1,
  },
};

test('fanoutTools exposes the one read-only overview tool in the account package', () => {
  assert.deepEqual(
    fanoutTools.map((t) => t.name),
    ['instagram_get_accounts_overview'],
  );
  assert.ok(Object.isFrozen(fanoutTools));
  assert.equal(tool.package, 'account');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.ok(tool.description.includes('IG_FANOUT_PROFILES'));
});

test('off: only the selected profile is read, fanout is false and the note says how to opt in', async () => {
  const calls: Call[] = [];
  const res = await tool.handler(
    {},
    ctxFor(defaultProfile, calls, (p) => BODIES[p.name]),
  );
  assert.equal(res.isError, undefined);
  const out = sc(res);
  assert.equal(out.fanout, false);
  assert.equal(out.note, FANOUT_OFF_NOTE);
  assert.ok(FANOUT_OFF_NOTE.includes('IG_FANOUT_PROFILES'));
  assert.deepEqual(out.profiles, [
    {
      name: 'default',
      authPath: 'ig-login',
      ok: true,
      igId: '17841400000000001',
      username: fence('me_default'),
      followersCount: 100,
      followsCount: 10,
      mediaCount: 7,
    },
  ]);
  assert.deepEqual(out.totals, {
    profiles: 1,
    ok: 1,
    failed: 0,
    followersCount: 100,
    mediaCount: 7,
  });
  assert.deepEqual(
    calls.map((c) => [c.profile, c.opts.method, c.opts.path]),
    [['default', 'GET', '/me']],
  );
});

test('off: a configured account id is the path that is read', async () => {
  const calls: Call[] = [];
  const res = await tool.handler(
    {},
    ctxFor(brandProfile, calls, (p) => BODIES[p.name]),
  );
  const out = sc(res);
  assert.equal(out.fanout, false);
  assert.deepEqual(
    calls.map((c) => c.opts.path),
    ['/17841400000000002'],
  );
  const [row] = out.profiles as Record<string, unknown>[];
  assert.equal(row?.accountId, '17841400000000002');
  assert.equal(row?.authPath, 'fb-login');
});

test('on: every opted-in profile is read through its own context, in order, with totals', async () => {
  const calls: Call[] = [];
  const responder = (p: ResolvedProfile): unknown => BODIES[p.name];
  const directory = fakeProfileDirectory(
    { profiles: [defaultProfile, brandProfile, shopProfile], defaultName: 'default' },
    (p) => ctxFor(p, calls, responder),
  );
  const ctx: ToolContext = { ...ctxFor(defaultProfile, calls, responder), profiles: directory };
  const out = sc(await tool.handler({}, ctx));
  assert.equal(out.fanout, true);
  assert.equal(out.note, undefined);
  assert.deepEqual(
    calls.map((c) => [c.profile, c.opts.path]),
    [
      ['default', '/me'],
      ['brand', '/17841400000000002'],
      ['shop', '/me'],
    ],
  );
  const rows = out.profiles as Record<string, unknown>[];
  assert.deepEqual(
    rows.map((r) => [r.name, r.ok, r.username]),
    [
      ['default', true, fence('me_default')],
      ['brand', true, fence('the_brand')],
      ['shop', true, fence('shop')],
    ],
  );
  assert.deepEqual(out.totals, {
    profiles: 3,
    ok: 3,
    failed: 0,
    followersCount: 2650,
    mediaCount: 48,
  });
});

test('on: a failing profile is reported with its error and does not fail the others', async () => {
  const calls: Call[] = [];
  const plain = new Error('socket hang up');
  const responder = (p: ResolvedProfile): unknown => {
    if (p.name === 'brand') {
      throw new InstagramError('Token expired. Run login again.', { kind: 'auth' });
    }
    if (p.name === 'shop') throw plain;
    return BODIES[p.name];
  };
  const directory = fakeProfileDirectory(
    { profiles: [defaultProfile, brandProfile, shopProfile], defaultName: 'default' },
    (p) => ctxFor(p, calls, responder),
  );
  const ctx: ToolContext = { ...ctxFor(defaultProfile, calls, responder), profiles: directory };
  const res = await tool.handler({}, ctx);
  assert.equal(res.isError, undefined, 'a partial failure is still a report');
  const out = sc(res);
  const rows = out.profiles as Record<string, unknown>[];
  assert.deepEqual(rows[1], {
    name: 'brand',
    authPath: 'fb-login',
    accountId: '17841400000000002',
    ok: false,
    error: { kind: 'auth', message: 'Token expired. Run login again.' },
  });
  const shopError = toInstagramError(plain);
  assert.deepEqual(rows[2], {
    name: 'shop',
    authPath: 'ig-login',
    ok: false,
    error: { kind: shopError.kind, message: shopError.message },
  });
  assert.deepEqual(out.totals, {
    profiles: 3,
    ok: 1,
    failed: 2,
    followersCount: 100,
    mediaCount: 7,
  });
});

test('on: a profile whose context cannot be built is reported as failed', async () => {
  const calls: Call[] = [];
  const ctx: ToolContext = {
    ...ctxFor(defaultProfile, calls, (p) => BODIES[p.name]),
    profiles: {
      defaultName: 'default',
      list: () => [{ name: 'gone', authPath: 'ig-login' }],
      contextFor: (name) =>
        Promise.reject(new InstagramError(`Unknown profile ${name}.`, { kind: 'validation' })),
    },
  };
  const out = sc(await tool.handler({}, ctx));
  assert.deepEqual(out.profiles, [
    {
      name: 'gone',
      authPath: 'ig-login',
      ok: false,
      error: { kind: 'validation', message: 'Unknown profile gone.' },
    },
  ]);
  assert.equal(calls.length, 0);
});

test('a body with missing or wrong-typed fields leaves them absent and adds 0 to the totals', async () => {
  const calls: Call[] = [];
  const res = await tool.handler(
    {},
    ctxFor(defaultProfile, calls, () => ({
      id: 42,
      username: ['not', 'a', 'string'],
      followers_count: '100',
      media_count: null,
    })),
  );
  const out = sc(res);
  assert.deepEqual(out.profiles, [{ name: 'default', authPath: 'ig-login', ok: true }]);
  assert.deepEqual(out.totals, {
    profiles: 1,
    ok: 1,
    failed: 0,
    followersCount: 0,
    mediaCount: 0,
  });
});

test('prettyJson pretty-prints the text block', async () => {
  const calls: Call[] = [];
  const res = await tool.handler(
    {},
    ctxFor(defaultProfile, calls, (p) => BODIES[p.name], true),
  );
  const [block] = res.content;
  assert.ok(block && block.type === 'text' && block.text.includes('\n  "fanout": false'));
});
