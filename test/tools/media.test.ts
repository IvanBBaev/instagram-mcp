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
import { registerTools } from '../../src/mcp/registry.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { mediaTools } from '../../src/tools/media.js';
import { testSettings } from '../helpers/settings.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
  return testSettings(overrides);
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

test('instagram_list_media reads ONE page unless the caller asks for fetchAll', async () => {
  // The default is the whole cost model of this tool: a single page is one
  // Graph call, `fetchAll` is a cursor walk that can burn up to IG_MAX_ITEMS
  // worth of rate limit before it returns. If the handler defaulted the flag to
  // ON, every caller that just wants "the latest posts" would silently pay for
  // a full walk — and the tool description promises the opposite ("Returns a
  // single page by default"). The edge below keeps offering a cursor, so a
  // defaulted-on walk is directly visible as a second request.
  const responder = (opts: IgRequestOptions) =>
    opts.params?.after === undefined
      ? { data: [{ id: '1' }], paging: { cursors: { after: 'A1' } } }
      : { data: [{ id: '2' }], paging: {} };
  const { req, calls } = fakeReq(responder);

  const res = await tool('instagram_list_media').handler({}, makeCtx(req));

  const sc = res.structuredContent as {
    items: Array<{ id: string }>;
    paging: { after?: string; truncated: boolean };
  };
  assert.equal(calls.length, 1, 'no fetchAll means exactly one Graph request');
  assert.equal(sc.items.length, 1, 'only the first page is returned');
  assert.equal(sc.items[0]?.id, '1');
  // ...and the cursor is handed back so the caller can continue deliberately.
  assert.equal(sc.paging.after, 'A1');
  assert.equal(sc.paging.truncated, false, 'a deliberate single page is not a truncated read');
});

test('instagram_list_media forwards the page-size hint and the resume cursor to Graph', async () => {
  // Both arguments are pure pass-through, which is exactly why they rot
  // silently: dropping `after` makes every "next page" call re-fetch page one
  // (an infinite loop for a paging client), and dropping `limit` quietly
  // ignores the caller's page size and takes whatever default Graph feels like.
  // The handler still succeeds in both cases, so only the outgoing request
  // shows it.
  const { req, calls } = fakeReq(() => ({ data: [], paging: {} }));

  await tool('instagram_list_media').handler({ limit: 25, after: 'CURSOR-A1' }, makeCtx(req));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.params?.limit, 25, 'the page-size hint reaches Graph');
  assert.equal(calls[0]?.params?.after, 'CURSOR-A1', 'the resume cursor reaches Graph');
});

test('instagram_list_media falls back to /me/media when the profile has no account id', async () => {
  const { req, calls } = fakeReq(() => ({ data: [], paging: {} }));
  const ctx = makeCtx(req, { profile: { accountId: undefined } });

  await tool('instagram_list_media').handler({}, ctx);

  assert.equal(calls[0]?.path, '/me/media');
});

test('instagram_list_media surfaces the pager note and logs the fetchAll it was given', async () => {
  // `note` is the pager's only channel for "I stopped early and here is why".
  // Dropping it leaves a truncated listing that looks like an ordinary cap, so
  // the model re-walks the same stuck edge instead of resuming from `after`.
  const { req } = fakeReq((opts) =>
    opts.params?.after === undefined
      ? { data: [{ id: '1' }], paging: { cursors: { after: 'A1' } } }
      : { data: [], paging: { cursors: { after: 'A2' } } },
  );

  const res = await tool('instagram_list_media').handler(
    { fetchAll: true },
    makeCtx(req, { settings: { maxItems: 50 } }),
  );

  const sc = res.structuredContent as { note?: string; paging: { after?: string } };
  assert.match(String(sc.note), /resume from `after`/);
  assert.equal(sc.paging.after, 'A2');

  // And the audit line states the walk mode on both sides — never `undefined`.
  const fn = tool('instagram_list_media').logFields;
  assert.ok(fn);
  assert.equal(fn({ fetchAll: true }).fetchAll, true);
  assert.equal(fn({ limit: 10 }).fetchAll, false);
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

test('instagram_get_media treats an EMPTY inline children edge as "not expanded"', async () => {
  // Graph does not always answer the inline `children{...}` expansion with the
  // items; the album can come back with `children: { data: [] }`, which the api
  // layer flattens to an empty array rather than to `undefined`. Testing only
  // `children === undefined` would accept that empty array as a complete answer
  // and report an album with no items at all — the carousel silently loses its
  // photos, and the `/children` fallback that exists precisely for this case
  // never fires. Absent and empty are the same state here: nothing expanded.
  const responder = (opts: IgRequestOptions) => {
    if (opts.path === '/M7')
      return { id: 'M7', media_type: 'CAROUSEL_ALBUM', children: { data: [] } };
    if (opts.path === '/M7/children') return { data: [{ id: 'k1', media_type: 'IMAGE' }] };
    throw new Error(`unexpected ${opts.path}`);
  };
  const { req, calls } = fakeReq(responder);

  const res = await tool('instagram_get_media').handler({ mediaId: 'M7' }, makeCtx(req));

  const sc = res.structuredContent as { children?: Array<{ id: string }> };
  assert.equal(calls.length, 2, 'an empty inline expansion must still hit the /children edge');
  assert.equal(calls[1]?.path, '/M7/children');
  assert.equal(sc.children?.length, 1, 'the album resolves its items after all');
  assert.equal(sc.children?.[0]?.id, 'k1');
});

test('instagram_get_media does not invent an empty children list when the edge answers nothing', async () => {
  // The fallback is a *fallback*: when the `/children` edge also comes back
  // empty we know nothing new, so the field stays absent. Assigning the empty
  // array anyway would state something Instagram never said — CC-DATA-2's rule
  // is that undisclosed data is omitted, and `children: []` reads as the
  // positive claim "this album provably has no items", which a caller may act
  // on (skip the album, report it as broken) instead of retrying.
  const responder = (opts: IgRequestOptions) => {
    if (opts.path === '/M8') return { id: 'M8', media_type: 'CAROUSEL_ALBUM' };
    if (opts.path === '/M8/children') return { data: [] };
    throw new Error(`unexpected ${opts.path}`);
  };
  const { req, calls } = fakeReq(responder);

  const res = await tool('instagram_get_media').handler({ mediaId: 'M8' }, makeCtx(req));

  const sc = res.structuredContent as { children?: Array<{ id: string }> };
  assert.equal(calls.length, 2, 'the fallback was attempted');
  assert.equal(sc.children, undefined, 'an empty edge leaves `children` absent, never []');
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

// --- the declared input/output schemas, against a REAL McpServer ------------

/**
 * Everything above calls `spec.handler` directly, which is the right seam for
 * behaviour but never touches the spec's declared `input` / `output` schemas:
 * a direct call parses nothing, so a bound, a `.min(1)` or a `.passthrough()`
 * could be changed here without a single assertion noticing. The MCP SDK is
 * what actually enforces those declarations — it validates `arguments` against
 * the (strict) input schema *before* our callback runs and re-parses
 * `structuredContent` against the output schema *after* it returns
 * (`server/mcp.js` `validateToolInput` / `validateToolOutput`) — so the tests
 * below register the real specs on a real `McpServer` and drive them through a
 * real `Client` over `InMemoryTransport`, the same way test/mcp/registry.test.ts
 * does for the registry itself. Nothing else observes the schemas as shipped.
 */
async function liveMediaServer(req: IgRequestFn): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: 'instagram-mcp-ai-media-test', version: '0.0.0' });
  registerTools({
    server,
    tools: mediaTools,
    profiles: [makeProfile()],
    defaultProfileName: 'default',
    settings: makeSettings(),
    clock: fakeClock(0),
    log: noopLog,
    makeRequest: () => req,
    env: {},
  });

  const client = new Client({ name: 'media-test-client', version: '0.0.0' });
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
 * Flatten a `tools/call` result's text content. Typed `unknown` because the SDK
 * client returns a union that also carries the legacy `{ toolResult }` shape.
 */
function callText(res: unknown): string {
  const raw = (res as { content?: unknown }).content;
  const content = Array.isArray(raw) ? (raw as { text?: unknown }[]) : [];
  return content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
}

test('real McpServer: an additive Meta field on a media ITEM survives output validation', async () => {
  // CC-DATA-6/7: Meta adds fields to `/media` without warning (`is_shared_to_feed`
  // and `alt_text` both arrived that way). The item schema is `.passthrough()`
  // so those ride through untouched. Closing it would turn every such addition
  // into an "Output validation error" — the whole listing fails, for data the
  // caller never asked for, and only the day Meta ships the field.
  const { req } = fakeReq(() => ({
    data: [{ id: '1', media_type: 'IMAGE', is_shared_to_feed: true }],
    paging: {},
  }));
  const live = await liveMediaServer(req);
  try {
    const res = await live.client.callTool({ name: 'instagram_list_media', arguments: {} });

    assert.equal(res.isError, undefined, `an unknown item field must not fail: ${callText(res)}`);
    const sc = res.structuredContent as { items: Array<Record<string, unknown>> };
    assert.equal(sc.items[0]?.is_shared_to_feed, true, 'and it reaches the caller intact');
  } finally {
    await live.close();
  }
});

test('real McpServer: an additive Meta field on a carousel CHILD survives output validation', async () => {
  // Same contract one level down. Children come from the `children{...}`
  // expansion, whose field set Meta extends independently of the parent's, so
  // the child schema needs its own `.passthrough()` — and a closed child schema
  // fails the *entire* get_media call, not just the child.
  const { req } = fakeReq(() => ({
    id: 'M1',
    media_type: 'CAROUSEL_ALBUM',
    children: { data: [{ id: 'c1', media_type: 'IMAGE', alt_text: 'a described photo' }] },
  }));
  const live = await liveMediaServer(req);
  try {
    const res = await live.client.callTool({
      name: 'instagram_get_media',
      arguments: { mediaId: 'M1' },
    });

    assert.equal(res.isError, undefined, `an unknown child field must not fail: ${callText(res)}`);
    const sc = res.structuredContent as { children?: Array<Record<string, unknown>> };
    assert.equal(sc.children?.[0]?.alt_text, 'a described photo');
  } finally {
    await live.close();
  }
});

test('real McpServer: list_media publishes paging.truncated as a REQUIRED field', async () => {
  // `truncated` is the tool's only honest signal that a listing is incomplete.
  // Declaring it optional would let a client legitimately read `paging` with no
  // `truncated` at all and conclude "not truncated" — the exact silent-data-loss
  // reading the flag exists to prevent — and would stop the SDK from ever
  // catching a handler that forgot to set it. The published JSON Schema is
  // where that promise is visible to a client.
  const { req } = fakeReq(() => ({ data: [], paging: {} }));
  const live = await liveMediaServer(req);
  try {
    const { tools } = await live.client.listTools();
    const listed = tools.find((t) => t.name === 'instagram_list_media');
    assert.ok(listed, 'instagram_list_media is registered');

    const output = listed.outputSchema as {
      required?: string[];
      properties?: { paging?: { required?: string[]; properties?: Record<string, unknown> } };
    };
    const paging = output.properties?.paging;
    assert.ok(paging, 'the output schema declares a paging object');
    assert.deepEqual(paging.required, ['truncated'], 'truncated is required, `after` is not');
    assert.deepEqual(output.required, ['items', 'paging'], 'and both halves are required');
  } finally {
    await live.close();
  }
});

test('real McpServer: the page-size hint is held to the documented 1–100 range', async () => {
  // `limit` is forwarded verbatim to Graph, so the bounds are the only thing
  // standing between a model's guess and a rejected upstream request. 0 is the
  // interesting one: it is not "no limit", it is a page Graph will not return,
  // and accepting it turns a typo into an empty listing that looks like an
  // account with no media. 101 is the documented ceiling (docs/tools.md and the
  // argument's own description say 1–100); raising it silently ships a promise
  // the API does not keep.
  const { req, calls } = fakeReq(() => ({ data: [], paging: {} }));
  const live = await liveMediaServer(req);
  try {
    for (const limit of [0, 101]) {
      const res = await live.client.callTool({
        name: 'instagram_list_media',
        arguments: { limit },
      });
      assert.equal(res.isError, true, `limit=${limit} must be rejected: ${callText(res)}`);
      assert.match(callText(res), /limit/, 'the rejection names the offending argument');
    }
    assert.equal(calls.length, 0, 'an out-of-range page size never reaches Graph');

    // Positive control: the bounds themselves are valid, so this is a range
    // check and not merely "any limit is rejected".
    for (const limit of [1, 100]) {
      const ok = await live.client.callTool({ name: 'instagram_list_media', arguments: { limit } });
      assert.equal(ok.isError, undefined, `limit=${limit} is inside the documented range`);
    }
    assert.equal(calls.length, 2, 'both in-range calls did reach Graph');
  } finally {
    await live.close();
  }
});

test('real McpServer: an empty mediaId is rejected before any request is built', async () => {
  // `getMedia` builds its path as `/${mediaId}`, so an empty id addresses the
  // API root: a request that is either a hard 400 or, worse, some unrelated
  // node, reported back as an opaque upstream failure. `.min(1)` turns that
  // into an argument error naming the field, at zero cost and before the token
  // is ever put on the wire.
  const { req, calls } = fakeReq(() => ({ id: 'never' }));
  const live = await liveMediaServer(req);
  try {
    const res = await live.client.callTool({
      name: 'instagram_get_media',
      arguments: { mediaId: '' },
    });

    assert.equal(res.isError, true, `an empty mediaId must be rejected: ${callText(res)}`);
    assert.equal(calls.length, 0, 'and nothing is ever requested from Graph');

    // Positive control: a real id on the same server does go through.
    const ok = await live.client.callTool({
      name: 'instagram_get_media',
      arguments: { mediaId: 'M1' },
    });
    assert.equal(ok.isError, undefined);
    assert.equal(calls.length, 1);
  } finally {
    await live.close();
  }
});
