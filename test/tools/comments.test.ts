/**
 * Unit tests for the comment tool specs (Layer 3). A hand-built fake
 * {@link ToolContext} drives each handler. Read tools are asserted to fence
 * untrusted `text`/`username` and cap with maxItems; write tools are asserted
 * to PREVIEW without `apply` (issuing no mutating request) and to PERFORM with
 * `apply:true`; `delete_comment` is additionally shown to stay a preview
 * without IG_ALLOW_DESTRUCTIVE and to proceed with both flags set. `fence` is
 * imported so expected values come from the real implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { commentsTools } from '../../src/tools/comments.js';

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
  const found = commentsTools.find((s) => s.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

// --- surface / spec shape --------------------------------------------------

test('commentsTools exposes 8 comments-package tools + the media-package toggle', () => {
  assert.equal(commentsTools.length, 9);

  const commentsPkg = commentsTools
    .filter((t) => t.package === 'comments')
    .map((t) => t.name)
    .sort();
  assert.deepEqual(commentsPkg, [
    'instagram_create_comment',
    'instagram_delete_comment',
    'instagram_get_comment',
    'instagram_hide_comment',
    'instagram_list_comments',
    'instagram_list_tagged_media',
    'instagram_reply_to_comment',
    'instagram_unhide_comment',
  ]);

  const mediaPkg = commentsTools.filter((t) => t.package === 'media').map((t) => t.name);
  assert.deepEqual(mediaPkg, ['instagram_set_comments_enabled']);
});

test('read tools are read-only; write tools are not; delete carries the destructive hint', () => {
  const readOnly = [
    'instagram_list_comments',
    'instagram_get_comment',
    'instagram_list_tagged_media',
  ];
  for (const name of readOnly) {
    assert.equal(tool(name).annotations.readOnlyHint, true, `${name} readOnlyHint`);
    assert.equal(tool(name).annotations.openWorldHint, true, `${name} openWorldHint`);
  }

  const writes = [
    'instagram_reply_to_comment',
    'instagram_create_comment',
    'instagram_hide_comment',
    'instagram_unhide_comment',
    'instagram_delete_comment',
    'instagram_set_comments_enabled',
  ];
  for (const name of writes) {
    assert.notEqual(tool(name).annotations.readOnlyHint, true, `${name} not read-only`);
    assert.equal(tool(name).annotations.openWorldHint, true, `${name} openWorldHint`);
    assert.ok('apply' in tool(name).input, `${name} declares its own apply`);
  }

  assert.equal(tool('instagram_delete_comment').annotations.destructiveHint, true);
  for (const name of [
    'instagram_hide_comment',
    'instagram_unhide_comment',
    'instagram_set_comments_enabled',
  ]) {
    assert.equal(tool(name).annotations.idempotentHint, true, `${name} idempotentHint`);
  }
});

// --- read tools ------------------------------------------------------------

test('list_comments caps at maxItems, marks truncated, and fences text + username (incl. replies)', async () => {
  const responder = (opts: IgRequestOptions) => {
    const after = opts.params?.after;
    if (after === undefined)
      return {
        data: [
          {
            id: 'c1',
            text: 'hello @someone',
            username: 'bob',
            replies: { data: [{ id: 'r1', text: 'reply-text', username: 'ann' }] },
          },
        ],
        paging: { cursors: { after: 'A1' } },
      };
    if (after === 'A1')
      return { data: [{ id: 'c2', text: 'second' }], paging: { cursors: { after: 'A2' } } };
    throw new Error('unexpected');
  };
  const { req, calls } = fakeReq(responder);
  const ctx = makeCtx(req, { settings: { maxItems: 1 } });

  const res = await tool('instagram_list_comments').handler({ mediaId: 'M1', fetchAll: true }, ctx);

  const scv = res.structuredContent as {
    items: Array<{
      id: string;
      text?: string;
      username?: string;
      replies?: Array<{ text?: string; username?: string }>;
    }>;
    paging: { after?: string; truncated: boolean };
  };
  assert.equal(scv.items.length, 1);
  assert.equal(scv.paging.truncated, true);
  assert.equal(scv.paging.after, 'A1');
  assert.equal(scv.items[0]?.text, fence('hello @someone'));
  assert.equal(scv.items[0]?.username, fence('bob'));
  assert.notEqual(scv.items[0]?.username, 'bob');
  assert.equal(scv.items[0]?.replies?.[0]?.text, fence('reply-text'));
  assert.equal(scv.items[0]?.replies?.[0]?.username, fence('ann'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, '/M1/comments');
});

test('get_comment fences text + username and surfaces hidden/parent/media context', async () => {
  const raw = {
    id: 'C1',
    text: 'a comment',
    username: 'bob',
    hidden: true,
    parent_id: 'P1',
    media: { id: 'M1', media_type: 'IMAGE' },
  };
  const { req, calls } = fakeReq(() => raw);

  const res = await tool('instagram_get_comment').handler({ commentId: 'C1' }, makeCtx(req));

  const scv = res.structuredContent as {
    id: string;
    text?: string;
    username?: string;
    hidden?: boolean;
    parent_id?: string;
    media?: { id: string };
  };
  assert.equal(scv.id, 'C1');
  assert.equal(scv.text, fence('a comment'));
  assert.equal(scv.username, fence('bob'));
  assert.equal(scv.hidden, true);
  assert.equal(scv.parent_id, 'P1');
  assert.equal(scv.media?.id, 'M1');
  assert.equal(calls[0]?.path, '/C1');
});

test('list_tagged_media uses /{ig-id}/tags, falls back to /me/tags, and fences caption + username', async () => {
  const { req, calls } = fakeReq(() => ({
    data: [{ id: 't1', caption: 'look here', username: 'friend' }],
    paging: {},
  }));
  const res = await tool('instagram_list_tagged_media').handler({}, makeCtx(req));

  const scv = res.structuredContent as {
    items: Array<{ id: string; caption?: string; username?: string }>;
  };
  assert.equal(scv.items[0]?.caption, fence('look here'));
  assert.equal(scv.items[0]?.username, fence('friend'));
  assert.equal(calls[0]?.path, '/999/tags');

  const { req: req2, calls: calls2 } = fakeReq(() => ({ data: [], paging: {} }));
  await tool('instagram_list_tagged_media').handler(
    {},
    makeCtx(req2, { profile: { accountId: undefined } }),
  );
  assert.equal(calls2[0]?.path, '/me/tags');
});

// --- write tools: preview vs apply -----------------------------------------

test('reply_to_comment previews without apply (no request) and performs with apply:true', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'reply-1' }));

  const preview = await tool('instagram_reply_to_comment').handler(
    { commentId: 'C1', message: 'hi' },
    makeCtx(req),
  );
  assert.equal(preview.structuredContent?.mode, 'preview');
  assert.equal(calls.length, 0, 'preview must not touch the network');

  const applied = await tool('instagram_reply_to_comment').handler(
    { commentId: 'C1', message: 'hi', apply: true },
    makeCtx(req),
  );
  assert.equal(applied.structuredContent?.replyId, 'reply-1');
  assert.equal(applied.structuredContent?.parentCommentId, 'C1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/C1/replies');
  assert.equal(calls[0]?.params?.message, 'hi');
});

test('create_comment previews without apply and performs with apply:true', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'comment-1' }));

  const preview = await tool('instagram_create_comment').handler(
    { mediaId: 'M1', message: 'nice' },
    makeCtx(req),
  );
  assert.equal(preview.structuredContent?.mode, 'preview');
  assert.equal(calls.length, 0);

  const applied = await tool('instagram_create_comment').handler(
    { mediaId: 'M1', message: 'nice', apply: true },
    makeCtx(req),
  );
  assert.equal(applied.structuredContent?.commentId, 'comment-1');
  assert.equal(calls[0]?.path, '/M1/comments');
  assert.equal(calls[0]?.params?.message, 'nice');
});

test('hide_comment previews without apply and POSTs hide=true with apply:true', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  const preview = await tool('instagram_hide_comment').handler({ commentId: 'C1' }, makeCtx(req));
  assert.equal(preview.structuredContent?.mode, 'preview');
  assert.equal(calls.length, 0);

  const applied = await tool('instagram_hide_comment').handler(
    { commentId: 'C1', apply: true },
    makeCtx(req),
  );
  assert.equal(applied.structuredContent?.hidden, 'C1');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/C1');
  assert.equal(calls[0]?.params?.hide, true);
});

test('unhide_comment POSTs hide=false with apply:true', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  const applied = await tool('instagram_unhide_comment').handler(
    { commentId: 'C1', apply: true },
    makeCtx(req),
  );
  assert.equal(applied.structuredContent?.unhidden, 'C1');
  assert.equal(calls[0]?.params?.hide, false);
});

test('set_comments_enabled (media package) previews without apply and POSTs comment_enabled with apply:true', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  const preview = await tool('instagram_set_comments_enabled').handler(
    { mediaId: 'M1', enabled: false },
    makeCtx(req),
  );
  assert.equal(preview.structuredContent?.mode, 'preview');
  assert.equal(calls.length, 0);

  const applied = await tool('instagram_set_comments_enabled').handler(
    { mediaId: 'M1', enabled: false, apply: true },
    makeCtx(req),
  );
  assert.equal(applied.structuredContent?.mediaId, 'M1');
  assert.equal(applied.structuredContent?.commentsEnabled, false);
  assert.equal(calls[0]?.path, '/M1');
  assert.equal(calls[0]?.params?.comment_enabled, false);
});

// --- delete_comment: double gate -------------------------------------------

test('delete_comment stays a preview with apply:true but no IG_ALLOW_DESTRUCTIVE', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  const res = await tool('instagram_delete_comment').handler(
    { commentId: 'C1', apply: true },
    makeCtx(req), // allowDestructive defaults to false
  );

  assert.equal(res.structuredContent?.mode, 'preview');
  assert.ok(String(res.content[0]?.text).includes('IG_ALLOW_DESTRUCTIVE'));
  assert.equal(calls.length, 0, 'destructive write must not run without the second gate');
});

test('delete_comment proceeds with apply:true AND allowDestructive', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  const res = await tool('instagram_delete_comment').handler(
    { commentId: 'C1', apply: true },
    makeCtx(req, { settings: { allowDestructive: true } }),
  );

  assert.equal(res.structuredContent?.deleted, 'C1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'DELETE');
  assert.equal(calls[0]?.path, '/C1');
});
