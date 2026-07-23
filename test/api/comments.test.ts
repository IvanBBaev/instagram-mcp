/**
 * Unit tests for the comments api layer (Layer 1). A **fake**
 * {@link IgRequestFn} returns canned Graph payloads — no network, no
 * `mcp`/result dependency — so they run standalone. They cover the reply-edge
 * normalization, cursor pagination (cap + CC-DATA-1/4), single-comment context,
 * the `/tags` edge, and the exact method/path/params of every write call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import {
  createComment,
  deleteComment,
  getComment,
  listComments,
  listTaggedMedia,
  replyToComment,
  setCommentHidden,
  setCommentsEnabled,
} from '../../src/api/comments.js';

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

// --- listComments ----------------------------------------------------------

test('listComments returns a single page, forwards fields/limit, and flattens inline replies', async () => {
  const page = {
    data: [
      {
        id: 'c1',
        text: 'nice',
        username: 'bob',
        like_count: 2,
        replies: { data: [{ id: 'r1', text: 'thanks', username: 'me' }] },
      },
      { id: 'c2', text: 'ok' },
    ],
    paging: { cursors: { after: 'CUR' } },
  };
  const { req, calls } = fakeReq(() => page);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 200, limit: 25 });

  assert.equal(res.items.length, 2);
  assert.equal(res.after, 'CUR');
  assert.equal(res.truncated, false);
  assert.equal(res.items[0]?.replies?.length, 1);
  assert.equal(res.items[0]?.replies?.[0]?.id, 'r1');
  assert.equal(res.items[1]?.replies, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.path, '/M1/comments');
  assert.equal(calls[0]?.params?.limit, 25);
  assert.equal(calls[0]?.params?.after, undefined);
  assert.ok(String(calls[0]?.params?.fields).includes('text'));
  assert.ok(String(calls[0]?.params?.fields).includes('replies{'));
});

test('listComments fetchAll caps at maxItems and reports truncated with a resume cursor', async () => {
  const responder = (opts: IgRequestOptions) => {
    const after = opts.params?.after;
    if (after === undefined)
      return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'A1' } } };
    if (after === 'A1')
      return { data: [{ id: '3' }, { id: '4' }], paging: { cursors: { after: 'A2' } } };
    throw new Error(`unexpected cursor ${String(after)}`);
  };
  const { req, calls } = fakeReq(responder);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 3, fetchAll: true });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2', '3'],
  );
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'A2');
  assert.equal(calls.length, 2);
});

test('listComments fetchAll stopping exactly at the cap with no more data is NOT truncated (CC-DATA-4)', async () => {
  const responder = (opts: IgRequestOptions) => {
    const after = opts.params?.after;
    if (after === undefined)
      return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'A1' } } };
    if (after === 'A1') return { data: [{ id: '3' }, { id: '4' }], paging: {} };
    throw new Error('unexpected');
  };
  const { req } = fakeReq(responder);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 4, fetchAll: true });

  assert.equal(res.items.length, 4);
  assert.equal(res.truncated, false);
  assert.equal(res.after, undefined);
});

test('listComments fetchAll keeps a partial result when a cursor goes stale mid-listing (CC-DATA-1)', async () => {
  const responder = (opts: IgRequestOptions) => {
    if (opts.params?.after === undefined)
      return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'A1' } } };
    throw new InstagramError('cursor invalid', { kind: 'validation', code: 100 });
  };
  const { req, calls } = fakeReq(responder);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 100, fetchAll: true });

  assert.equal(res.items.length, 2);
  assert.equal(res.truncated, true);
  assert.ok(res.note?.includes('stale'));
  assert.equal(calls.length, 2);
});

test('listComments propagates a first-page error instead of hiding it', async () => {
  const { req } = fakeReq(() => {
    throw new InstagramError('boom', { kind: 'upstream', status: 500 });
  });

  await assert.rejects(
    () => listComments(req, { mediaId: 'M1', maxItems: 10 }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'upstream',
  );
});

// --- getComment ------------------------------------------------------------

test('getComment fetches by id with the detail field set and flattens replies + context', async () => {
  const raw = {
    id: 'C1',
    text: 'hi',
    username: 'bob',
    like_count: 3,
    hidden: false,
    parent_id: 'P1',
    media: { id: 'M1', media_type: 'IMAGE', permalink: 'https://ig/p/1' },
    replies: { data: [{ id: 'R1', text: 'yo', username: 'ann' }] },
  };
  const { req, calls } = fakeReq(() => raw);

  const detail = await getComment(req, { commentId: 'C1' });

  assert.equal(detail.id, 'C1');
  assert.equal(detail.hidden, false);
  assert.equal(detail.parent_id, 'P1');
  assert.equal(detail.media?.id, 'M1');
  assert.equal(detail.replies?.length, 1);
  assert.equal(detail.replies?.[0]?.id, 'R1');
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.path, '/C1');
  assert.ok(String(calls[0]?.params?.fields).includes('hidden'));
  assert.ok(String(calls[0]?.params?.fields).includes('parent_id'));
  assert.ok(String(calls[0]?.params?.fields).includes('media{'));
});

test('getComment propagates an InstagramError for a deleted comment (CC-DATA-5)', async () => {
  const { req } = fakeReq(() => {
    throw new InstagramError('object no longer exists', { kind: 'validation', code: 100 });
  });

  await assert.rejects(
    () => getComment(req, { commentId: 'gone' }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
});

// --- listTaggedMedia -------------------------------------------------------

test('listTaggedMedia lists the /tags edge with the tagged-media field set and paginates', async () => {
  const responder = (opts: IgRequestOptions) => {
    const after = opts.params?.after;
    if (after === undefined)
      return {
        data: [{ id: 't1', caption: 'tagged', username: 'friend' }],
        paging: { cursors: { after: 'A1' } },
      };
    if (after === 'A1') return { data: [{ id: 't2' }], paging: {} };
    throw new Error('unexpected');
  };
  const { req, calls } = fakeReq(responder);

  const res = await listTaggedMedia(req, { igId: '999', maxItems: 100, fetchAll: true });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['t1', 't2'],
  );
  assert.equal(res.truncated, false);
  assert.equal(calls[0]?.path, '/999/tags');
  assert.ok(String(calls[0]?.params?.fields).includes('caption'));
  assert.ok(String(calls[0]?.params?.fields).includes('permalink'));
});

// --- writes ----------------------------------------------------------------

test('replyToComment POSTs to the /replies edge with the message', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'reply-1' }));

  const r = await replyToComment(req, { commentId: 'C1', message: 'hello' });

  assert.equal(r.id, 'reply-1');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/C1/replies');
  assert.equal(calls[0]?.params?.message, 'hello');
});

test('createComment POSTs to the media /comments edge with the message', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'comment-1' }));

  const r = await createComment(req, { mediaId: 'M1', message: 'nice post' });

  assert.equal(r.id, 'comment-1');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/M1/comments');
  assert.equal(calls[0]?.params?.message, 'nice post');
});

test('setCommentHidden POSTs hide=true and hide=false to the comment node', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  await setCommentHidden(req, { commentId: 'C1', hide: true });
  await setCommentHidden(req, { commentId: 'C1', hide: false });

  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/C1');
  assert.equal(calls[0]?.params?.hide, true);
  assert.equal(calls[1]?.params?.hide, false);
});

test('deleteComment issues a DELETE on the comment node', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  await deleteComment(req, { commentId: 'C1' });

  assert.equal(calls[0]?.method, 'DELETE');
  assert.equal(calls[0]?.path, '/C1');
  assert.equal(calls[0]?.params, undefined);
});

test('setCommentsEnabled POSTs comment_enabled to the media node', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  await setCommentsEnabled(req, { mediaId: 'M1', enabled: false });

  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/M1');
  assert.equal(calls[0]?.params?.comment_enabled, false);
});
