/**
 * Unit tests for the media tool specs (Layer 3). A minimal fake
 * {@link ToolContext} drives each handler; assertions cover the ToolResult
 * shape, structuredContent, caption fencing, the maxItems cap, and
 * InstagramError propagation.
 *
 * Note: these exercise `tools/media.ts`, which imports `mcp/result.ts` (owned
 * by T-B2). Until that lands they cannot compile/run — the api-layer tests in
 * `test/api/media.test.ts` cover the same paging/child logic with no such
 * dependency. `fence` is imported here so the expected fenced caption is
 * computed from the real implementation rather than hard-coded delimiters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type {
  IgRequestFn,
  IgRequestOptions,
  Logger,
  ResolvedProfile,
  Settings,
} from '../../src/core/types.js';
import type { ToolContext, ToolSpec } from '../../src/mcp/define.js';
import { fence } from '../../src/mcp/result.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { mediaTools } from '../../src/tools/media.js';

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    maxConcurrent: 4,
    maxItems: 200,
    refreshAfterDays: 45,
    timeoutMs: 30000,
    logLevel: 'info',
    prettyJson: false,
    writeMode: 'preview',
    allowDestructive: false,
    transport: 'stdio',
    httpHost: '127.0.0.1',
    httpPort: 3000,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: 'default',
    authPath: 'ig-login',
    accessToken: 'TOKEN',
    accountId: '999',
    ...overrides,
  };
}

function makeCtx(
  req: IgRequestFn,
  overrides: { settings?: Partial<Settings>; profile?: Partial<ResolvedProfile> } = {},
): ToolContext {
  return {
    req,
    settings: makeSettings(overrides.settings),
    profile: makeProfile(overrides.profile),
    clock: fakeClock(0),
    log: noopLog,
  };
}

function fakeReq(responder: (opts: IgRequestOptions) => unknown): {
  req: IgRequestFn;
  calls: IgRequestOptions[];
} {
  const calls: IgRequestOptions[] = [];
  const req: IgRequestFn = async <T>(opts: IgRequestOptions): Promise<T> => {
    calls.push(opts);
    return responder(opts) as T;
  };
  return { req, calls };
}

function tool(name: string): ToolSpec {
  const found = mediaTools.find((s) => s.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

test('mediaTools exposes exactly the two read-only specs from docs/tools.md', () => {
  assert.deepEqual(mediaTools.map((t) => t.name).sort(), [
    'instagram_get_media',
    'instagram_list_media',
  ]);
  for (const t of mediaTools) {
    assert.equal(t.package, 'media');
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.openWorldHint, true);
    assert.notEqual(t.annotations.destructiveHint, true);
  }
});

test('instagram_list_media caps at maxItems, marks truncated, and fences captions', async () => {
  const responder = (opts: IgRequestOptions) => {
    const after = opts.params?.after;
    if (after === undefined)
      return {
        data: [{ id: '1', caption: 'hello @someone', media_type: 'IMAGE' }],
        paging: { cursors: { after: 'A1' } },
      };
    if (after === 'A1')
      return { data: [{ id: '2', caption: 'world' }], paging: { cursors: { after: 'A2' } } };
    throw new Error('unexpected');
  };
  const { req, calls } = fakeReq(responder);
  const ctx = makeCtx(req, { settings: { maxItems: 1 } });

  const res = await tool('instagram_list_media').handler({ fetchAll: true }, ctx);

  assert.ok(Array.isArray(res.content));
  assert.equal(res.content[0]?.type, 'text');

  const sc = res.structuredContent as {
    items: Array<{ id: string; caption?: string }>;
    paging: { after?: string; truncated: boolean };
  };
  assert.equal(sc.items.length, 1);
  assert.equal(sc.items[0]?.id, '1');
  assert.equal(sc.paging.truncated, true);
  assert.equal(sc.paging.after, 'A1');
  assert.equal(sc.items[0]?.caption, fence('hello @someone'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, '/999/media');
});

test('instagram_list_media falls back to /me/media when the profile has no account id', async () => {
  const { req, calls } = fakeReq(() => ({ data: [], paging: {} }));
  const ctx = makeCtx(req, { profile: { accountId: undefined } });

  await tool('instagram_list_media').handler({}, ctx);

  assert.equal(calls[0]?.path, '/me/media');
});

test('instagram_get_media returns a fenced caption and inline carousel children', async () => {
  const raw = {
    id: 'M1',
    caption: 'a caption',
    media_type: 'CAROUSEL_ALBUM',
    children: {
      data: [
        { id: 'c1', media_type: 'IMAGE' },
        { id: 'c2', media_type: 'VIDEO' },
      ],
    },
  };
  const { req, calls } = fakeReq(() => raw);

  const res = await tool('instagram_get_media').handler({ mediaId: 'M1' }, makeCtx(req));

  const sc = res.structuredContent as {
    id: string;
    caption?: string;
    children?: Array<{ id: string }>;
  };
  assert.equal(sc.id, 'M1');
  assert.equal(sc.caption, fence('a caption'));
  assert.equal(sc.children?.length, 2);
  assert.equal(calls.length, 1); // children were inline — no extra call
});

test('instagram_get_media fetches the /children edge when inline children are absent', async () => {
  const responder = (opts: IgRequestOptions) => {
    if (opts.path === '/M9') return { id: 'M9', media_type: 'CAROUSEL_ALBUM' };
    if (opts.path === '/M9/children') return { data: [{ id: 'k1', media_type: 'IMAGE' }] };
    throw new Error(`unexpected ${opts.path}`);
  };
  const { req, calls } = fakeReq(responder);

  const res = await tool('instagram_get_media').handler({ mediaId: 'M9' }, makeCtx(req));

  const sc = res.structuredContent as { children?: Array<{ id: string }> };
  assert.equal(sc.children?.length, 1);
  assert.equal(sc.children?.[0]?.id, 'k1');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.path, '/M9/children');
});

test('instagram_get_media lets an InstagramError propagate for the registry to map', async () => {
  const { req } = fakeReq(() => {
    throw new InstagramError('object no longer exists', { kind: 'validation', code: 100 });
  });

  await assert.rejects(
    async () => {
      await tool('instagram_get_media').handler({ mediaId: 'gone' }, makeCtx(req));
    },
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
});
