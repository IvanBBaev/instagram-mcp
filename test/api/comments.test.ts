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

// --- wire field sets -------------------------------------------------------
//
// Mirrors of `COMMENT_FIELDS` / `COMMENT_DETAIL_FIELDS` / `TAGGED_MEDIA_FIELDS`,
// which are module-private in `api/comments.ts`. Graph returns exactly the
// fields it was asked for and silently omits the rest, so a field dropped from
// a set is never a compile error — it is a tool that quietly stops reporting
// timestamps or like counts. These are pinned byte-for-byte and asserted by
// equality, not by substring: a substring check passes on a set with holes in it.
const EXPECTED_COMMENT_FIELDS =
  'id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}';
const EXPECTED_DETAIL_FIELDS =
  'id,text,username,timestamp,like_count,hidden,parent_id,media{id,media_type,permalink},' +
  'replies{id,text,username,timestamp,like_count}';
const EXPECTED_TAGGED_FIELDS = 'id,caption,media_type,media_url,permalink,timestamp,username';

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
  assert.equal(calls[0]?.params?.fields, EXPECTED_COMMENT_FIELDS);
});

test('listComments normalizes replies recursively so a reply-of-a-reply is a flat array too', async () => {
  // Graph nests the reply edge at every level: a reply that has replies of its
  // own arrives as `{ replies: { data: [...] } }`, never as an array. Flattening
  // only the outermost level leaks that raw envelope into a field the domain
  // type declares to be `Comment[]` — a lie the compiler cannot catch. The model
  // reading the thread sees a sub-conversation of zero, and closes a support
  // thread that still has unanswered replies underneath it.
  const page = {
    data: [
      {
        id: 'c1',
        text: 'nice',
        replies: { data: [{ id: 'r1', text: 'thanks', replies: { data: [{ id: 'r1a' }] } }] },
      },
    ],
    paging: {},
  };
  const { req } = fakeReq(() => page);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 10 });

  assert.deepEqual(res.items, [
    { id: 'c1', text: 'nice', replies: [{ id: 'r1', text: 'thanks', replies: [{ id: 'r1a' }] }] },
  ]);
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
  // `maxItems` is the walk cap, not a page size. Leaking it into Graph's `limit`
  // makes every request ask for a page sized to the whole budget — an edge that
  // trims or rejects oversized pages then changes where cursor boundaries fall,
  // and the resume cursor we hand back no longer lines up with what the caller
  // already saw. When the caller states no `limit`, nothing must travel in it.
  assert.equal(calls[0]?.params?.limit, undefined);
  assert.equal(calls[1]?.params?.limit, undefined);
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

// --- fetchAll termination guards (shared walk — see test/api/media.test.ts) --
//
// `listComments` and `listMedia` go through the SAME paginator, so these two
// cases exist on both sides: a guard removed from the shared helper must not be
// able to pass one suite and fail the other. The fake edge throws a plain
// `Error` (not an InstagramError, which CC-DATA-1 would swallow) once the call
// count is past a bounded walk, so a runaway loop fails instead of hanging.
function runawayGuard(limit: number): () => void {
  let n = 0;
  return () => {
    n += 1;
    if (n > limit) throw new Error(`runaway pagination: ${n} requests for a bounded walk`);
  };
}

test('listComments fetchAll stops when a page returns no items but still advertises a cursor', async () => {
  const guard = runawayGuard(6);
  const responder = (opts: IgRequestOptions) => {
    guard();
    const after = opts.params?.after;
    if (after === undefined) return { data: [{ id: 'c1' }], paging: { cursors: { after: 'A1' } } };
    return { data: [], paging: { cursors: { after: `${String(after)}+` } } };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 100, fetchAll: true });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    res.items.map((c) => c.id),
    ['c1'],
  );
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'A1+');
  assert.ok(res.note?.includes('no items'));
});

test('listComments fetchAll stops when the edge repeats the same cursor (no forward progress)', async () => {
  const guard = runawayGuard(6);
  const responder = () => {
    guard();
    return { data: [{ id: 'c1' }, { id: 'c2' }], paging: { cursors: { after: 'STUCK' } } };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 100, fetchAll: true });

  assert.equal(calls.length, 2);
  assert.equal(res.items.length, 4);
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'STUCK');
  assert.ok(res.note?.includes('same cursor'));
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
  assert.equal(calls[0]?.params?.fields, EXPECTED_DETAIL_FIELDS);
});

test('getComment omits replies entirely when Graph returned none (CC-DATA-2)', async () => {
  // CC-DATA-2: Meta omits what it will not disclose, and we must not invent it
  // back. A payload with no reply edge means "unknown", not "known to have zero
  // replies" — materializing `replies: []` tells the model the thread was read
  // and found empty. That is the difference between an agent asking to check
  // again and an agent confidently resolving a comment it never actually saw.
  const raw = { id: 'C1', text: 'hi', username: 'bob', hidden: false };
  const { req } = fakeReq(() => raw);

  const detail = await getComment(req, { commentId: 'C1' });

  assert.equal('replies' in detail, false);
  assert.deepEqual(detail, { id: 'C1', text: 'hi', username: 'bob', hidden: false });
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
  assert.equal(calls[0]?.params?.fields, EXPECTED_TAGGED_FIELDS);
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
