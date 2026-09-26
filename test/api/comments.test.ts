/**
 * Unit tests for the comments api layer (Layer 1). A **fake**
 * {@link IgRequestFn} returns canned Graph payloads — no network, no
 * `mcp`/result dependency — so they run standalone. They cover the reply-edge
 * normalization, cursor pagination (cap + CC-DATA-1/4), single-comment context,
 * the `/tags` edge, and the exact method/path/params of every write call, plus
 * the transport-shape invariants (no body, no host pin, no idempotency
 * override) that decide whether a call may be replayed or re-targeted.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import { loadFixture } from '../helpers/fixtures.js';
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

// This layer is defined by NOT owning a socket: every Graph call goes through
// the injected `req` seam, which is where auth, SSRF checks, retries and the
// write journal live. A direct `fetch` here would bypass all of it and, in a
// developer's shell, would talk to Meta with the operator's real token. A
// throwing stand-in turns that from a silent live call into an instant failure.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = () => {
  throw new Error('api/comments must not open a socket — it only calls the injected req seam');
};
after(() => {
  globalThis.fetch = realFetch;
});

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

/**
 * Transport-shape invariants every call in this module must satisfy.
 *
 * These four fields are optional, so leaving them out is invisible to the
 * compiler and to any assertion about method/path/params — yet each one changes
 * what the transport is allowed to do with the request:
 *
 * - `host`: pinning it overrides `auth.defaultHost`, sending the call (and the
 *   token plus its `appsecret_proof`) to a host the operator did not configure.
 * - `idempotent`: `core/http` derives it from the method — GET retries on 5xx and
 *   429, POST/DELETE do not. Declaring a write idempotent lets a timed-out reply
 *   or comment be replayed, so one tool call posts twice; declaring a read
 *   non-idempotent silently drops its throttle retries.
 * - `body`: this API is query-parameter based. A body appearing alongside the
 *   params means the same values travel twice, and a form body is not covered by
 *   the param-key assertions below — a smuggled field would never be noticed.
 * - `signal`: the timeout belongs to the transport, not to this layer.
 *   `core/http` builds a per-attempt `AbortSignal.timeout` from the operator's
 *   configured budget and combines it with the CALLER's signal
 *   (`AbortSignal.any([opts.signal, timeout])`), then treats
 *   `opts.signal?.aborted` as "stop, do not retry". A signal minted inside
 *   `api/comments.ts` therefore imposes a deadline nobody configured and, once
 *   it fires, cancels the retry loop with it.
 *
 * Together with the `method`/`path`/`params` assertions at each call site these
 * four cover every slot on `IgRequestOptions`, which is what makes the helper a
 * real guard against an ADDED key rather than a reminder about a known list.
 * The `signal` line is the one that was missing, and its absence was measured
 * rather than assumed: adding `signal: AbortSignal.timeout(30_000)` to the
 * `getComment` request in `api/comments.ts` ran the api, tools and registry
 * suites with 479 tests passing, 0 failures and exit 0.
 */
function assertPlainGraphCall(opts: IgRequestOptions | undefined): void {
  assert.ok(opts, 'expected a request to have been issued');
  assert.equal(opts.host, undefined, 'must not override the configured Graph host');
  assert.equal(opts.idempotent, undefined, 'idempotency must be derived from the method');
  assert.equal(opts.body, undefined, 'this API is query-parameter based — no request body');
  assert.equal(opts.signal, undefined, 'the abort deadline belongs to the transport');
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
        timestamp: '2026-01-02T03:04:05+0000',
        like_count: 2,
        replies: { data: [{ id: 'r1', text: 'thanks', username: 'me' }] },
      },
      { id: 'c2', text: 'ok' },
    ],
    paging: { cursors: { after: 'CUR' }, next: 'https://graph.facebook.com/next' },
  };
  const { req, calls } = fakeReq(() => page);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 200, limit: 25 });

  assert.equal(res.items.length, 2);
  assert.equal(res.after, 'CUR');
  assert.equal(res.truncated, false);
  assert.equal(res.items[0]?.replies?.length, 1);
  assert.equal(res.items[0]?.replies?.[0]?.id, 'r1');
  assert.equal(res.items[1]?.replies, undefined);
  // Normalization rebuilds each comment field by field. A key lost on the way
  // out is indistinguishable from Graph never sending it (CC-DATA-2), so the
  // model concludes the comment has no timestamp / no likes rather than that we
  // dropped them — it then mis-ranks what to answer and cannot tell a fresh
  // comment from a two-year-old one when deciding whether to reply at all.
  assert.equal(res.items[0]?.timestamp, '2026-01-02T03:04:05+0000');
  assert.equal(res.items[0]?.like_count, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.path, '/M1/comments');
  assert.equal(calls[0]?.params?.limit, 25);
  assert.equal(calls[0]?.params?.after, undefined);
  assert.equal(calls[0]?.params?.fields, EXPECTED_COMMENT_FIELDS);
  assertPlainGraphCall(calls[0]);
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

test('listComments keeps every reply, in the order Instagram returned them', async () => {
  // Replies arrive oldest-first, which is the order a human read them in. Losing
  // replies (or reversing them) rewrites the conversation the model reasons over:
  // it answers a question that was already answered further down the thread, or
  // it replies to the opening complaint as if the follow-up apology never
  // happened. Nothing in the types or in a length-only check catches either.
  const page = {
    data: [
      {
        id: 'c1',
        replies: { data: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] },
      },
    ],
    paging: {},
  };
  const { req } = fakeReq(() => page);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 10 });

  assert.deepEqual(res.items[0]?.replies, [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
});

test('listComments tells an absent reply edge apart from an empty one', async () => {
  // Three different Graph answers must stay three different domain answers:
  // no `replies` key at all means "not disclosed" (CC-DATA-2) and must stay
  // absent; an envelope with a `data` array of zero means "read, and there are
  // none" and must materialize as `[]`; an envelope with no `data` at all is the
  // first case wearing the second's clothes and must NOT leak the raw envelope
  // into a field typed `Comment[]`. Collapsing them either invents a thread the
  // model never read or hands it an object where it expects an array — the first
  // closes unanswered threads, the second throws inside the tool layer.
  const page = {
    data: [
      { id: 'c1', text: 'no edge at all' },
      { id: 'c2', text: 'envelope with no data', replies: {} },
      { id: 'c3', text: 'edge read, zero replies', replies: { data: [] } },
    ],
    paging: {},
  };
  const { req } = fakeReq(() => page);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 10 });

  assert.deepEqual(res.items, [
    { id: 'c1', text: 'no edge at all' },
    { id: 'c2', text: 'envelope with no data' },
    { id: 'c3', text: 'edge read, zero replies', replies: [] },
  ]);
  assert.equal('replies' in (res.items[1] ?? {}), false);
  assert.equal('replies' in (res.items[2] ?? {}), true);
});

test('listComments fetchAll caps at maxItems and withholds the cursor it cut a page on', async () => {
  const responder = (opts: IgRequestOptions) => {
    const after = opts.params?.after;
    if (after === undefined)
      return {
        data: [{ id: '1' }, { id: '2' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    if (after === 'A1')
      return {
        data: [{ id: '3' }, { id: '4' }],
        paging: { cursors: { after: 'A2' }, next: 'https://graph.facebook.com/next' },
      };
    throw new Error(`unexpected cursor ${String(after)}`);
  };
  const { req, calls } = fakeReq(responder);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 3, fetchAll: true });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2', '3'],
  );
  assert.equal(res.truncated, true);
  // The cap fell between comment `3` and comment `4`, so `A2` — the boundary at
  // the END of that page — is not a position the caller can resume from without
  // losing `4`. Comments share `fetchPagedEdge` with media, so the CC-DATA-47
  // verdict reaches this listing too: no cursor, and a note that says why.
  assert.equal('after' in res, false, 'a cursor past the dropped comment is worse than none');
  assert.equal(
    res.note,
    'stopped at the item cap part-way through a page — no cursor addresses the items ' +
      'dropped here, so there is nothing to resume from; re-read with a smaller limit',
  );
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
      return {
        data: [{ id: '1' }, { id: '2' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
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
      return {
        data: [{ id: '1' }, { id: '2' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    throw new InstagramError('cursor invalid', { kind: 'validation', code: 100 });
  };
  const { req, calls } = fakeReq(responder);

  const res = await listComments(req, { mediaId: 'M1', maxItems: 100, fetchAll: true });

  assert.equal(res.items.length, 2);
  assert.equal(res.truncated, true);
  assert.ok(res.note?.includes('stale'));
  assert.equal(calls.length, 2);
});

test('listComments propagates a mid-walk rate limit instead of calling it a stale cursor (CC-DATA-105)', async () => {
  // The shared walk swallows only a stale cursor (`validation`). A rate limit
  // on page 2 is not one, and "restart the listing" is the wrong advice for it.
  const { req, calls } = fakeReq((opts: IgRequestOptions) => {
    if (opts.params?.after === undefined)
      return {
        data: [{ id: '1' }, { id: '2' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    throw new InstagramError('slow down', { kind: 'rate_limit', code: 4 });
  });

  await assert.rejects(
    () => listComments(req, { mediaId: 'M1', maxItems: 100, fetchAll: true }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'rate_limit',
  );
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
    if (after === undefined)
      return {
        data: [{ id: 'c1' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    return {
      data: [],
      paging: { cursors: { after: `${String(after)}+` }, next: 'https://graph.facebook.com/next' },
    };
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
    return {
      data: [{ id: 'c1' }, { id: 'c2' }],
      paging: { cursors: { after: 'STUCK' }, next: 'https://graph.facebook.com/next' },
    };
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.path, '/C1');
  assert.equal(calls[0]?.params?.fields, EXPECTED_DETAIL_FIELDS);
  assertPlainGraphCall(calls[0]);
});

test('getComment flattens the reply thread recursively and keeps its order', async () => {
  // `get_comment` is what an agent calls before deciding to hide or delete: it
  // reads the thread under a comment to judge intent. A reply array that arrives
  // reversed, or with the nested envelope passed through unflattened, makes that
  // judgement on a conversation that never took place — and the follow-up action
  // is destructive and, for delete, irreversible.
  const raw = {
    id: 'C1',
    replies: {
      data: [
        { id: 'R1', text: 'first' },
        { id: 'R2', text: 'second', replies: { data: [{ id: 'R2a', text: 'nested' }] } },
        { id: 'R3', text: 'third' },
      ],
    },
  };
  const { req } = fakeReq(() => raw);

  const detail = await getComment(req, { commentId: 'C1' });

  assert.deepEqual(detail, {
    id: 'C1',
    replies: [
      { id: 'R1', text: 'first' },
      { id: 'R2', text: 'second', replies: [{ id: 'R2a', text: 'nested' }] },
      { id: 'R3', text: 'third' },
    ],
  });
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

test('getComment tells an empty reply edge apart from a dataless envelope', async () => {
  // The mirror of the listComments case, on the read that precedes moderation.
  // `{ data: [] }` is a thread that was read and is empty — the model may act.
  // `{}` discloses nothing, so the key must stay absent rather than leak Graph's
  // envelope object into a field the domain type promises is an array.
  const empty = fakeReq(() => ({ id: 'C1', replies: { data: [] } }));
  const dataless = fakeReq(() => ({ id: 'C2', replies: {} }));

  assert.deepEqual(await getComment(empty.req, { commentId: 'C1' }), { id: 'C1', replies: [] });
  assert.deepEqual(await getComment(dataless.req, { commentId: 'C2' }), { id: 'C2' });
});

test('getComment refuses a body that is not an object instead of throwing a TypeError (CC-DATA-83)', async () => {
  // `req` casts the body. `null` used to be destructured into a raw TypeError,
  // and a scalar or a list was spread into an id-less record (a list even into
  // `{ "0": … }`). Each is now the same `upstream` refusal `getMedia` gives.
  for (const body of [null, 'x', 7, true, [], [{ id: 'C1' }]]) {
    const { req, calls } = fakeReq(() => body);
    await assert.rejects(
      () => getComment(req, { commentId: 'C1' }),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'upstream' &&
        e.message === 'Instagram returned no comment object for this id. Retry later.',
      `body=${JSON.stringify(body)}`,
    );
    assert.equal(calls.length, 1, 'the read is issued once and not retried here');
  }
});

test('a reply thread Graph cut at its first page is marked, and a complete one is not (CC-COM-15)', async () => {
  // The inline `replies` edge is paged like any other: with more replies than
  // fit, Graph sends the first page plus `paging.next`. The envelope used to be
  // dropped whole, so a thread cut at its first page read as the whole
  // conversation — and moderation judges a thread by what it contains. Only
  // `next` proves a further page: `cursors` ride on the last page too, and an
  // empty or non-string `next` points nowhere.
  const next = 'https://graph.instagram.com/v25.0/C1/replies?after=QVFI&access_token=IGQ_SECRET';
  const { req } = fakeReq(() => ({
    data: [
      { id: 'C1', replies: { data: [{ id: 'R1' }], paging: { cursors: { after: 'A' }, next } } },
      { id: 'C2', replies: { data: [{ id: 'R2' }], paging: { cursors: { after: 'B' } } } },
      { id: 'C3', replies: { data: [], paging: { next: '' } } },
      { id: 'C4', replies: { data: [{ id: 'R4' }], paging: { next: 7 } } },
      { id: 'C5', replies: { paging: { next } } },
    ],
  }));

  const res = await listComments(req, { mediaId: 'M1', maxItems: 10 });

  assert.deepEqual(res.items, [
    { id: 'C1', replies: [{ id: 'R1' }], repliesTruncated: true },
    { id: 'C2', replies: [{ id: 'R2' }] },
    { id: 'C3', replies: [] },
    { id: 'C4', replies: [{ id: 'R4' }] },
    // No readable page, but a further one announced: the thread is still cut.
    { id: 'C5', repliesTruncated: true },
  ]);
  assert.equal(JSON.stringify(res).includes('IGQ_SECRET'), false, 'the next URL is never kept');

  const detail = fakeReq(() => ({ id: 'C1', replies: { data: [{ id: 'R1' }], paging: { next } } }));
  assert.deepEqual(await getComment(detail.req, { commentId: 'C1' }), {
    id: 'C1',
    replies: [{ id: 'R1' }],
    repliesTruncated: true,
  });
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
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
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

test('listTaggedMedia issues a plain GET and forwards the caller page size verbatim', async () => {
  // `/tags` names an account, not a media, and the same node id answers to POST
  // and DELETE on other edges. A read that silently becomes a write travels as a
  // `readOnlyHint: true` tool — it never reaches the write gate, never asks for
  // confirmation and never lands in the journal. `limit` must be the caller's
  // page-size hint and nothing else: substituting the walk cap turns one page
  // request into a whole-budget request, and misspelling the key makes Graph fall
  // back to its own default so `maxItems` boundaries stop lining up with pages.
  const item = {
    id: 't1',
    caption: 'tagged me',
    media_type: 'IMAGE',
    media_url: 'https://cdn.example/t1.jpg',
    permalink: 'https://instagram.example/p/t1',
    timestamp: '2026-02-03T04:05:06+0000',
    username: 'friend',
  };
  const { req, calls } = fakeReq(() => ({ data: [item], paging: {} }));

  const res = await listTaggedMedia(req, { igId: '999', maxItems: 100, limit: 40 });

  // The projection is the identity: every requested field must reach the caller,
  // or a tagged-media listing degrades into a list of bare ids with no caption,
  // permalink or author to judge — and the model cannot tell that from an edge
  // that genuinely disclosed nothing.
  assert.deepEqual(res.items, [item]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.path, '/999/tags');
  assert.equal(calls[0]?.params?.fields, EXPECTED_TAGGED_FIELDS);
  assert.equal(calls[0]?.params?.limit, 40);
  assert.equal(calls[0]?.params?.after, undefined);
  assertPlainGraphCall(calls[0]);
});

test('listTaggedMedia reads one page unless the caller asked to walk them all', async () => {
  // Walking every page by default turns one tool call into an unbounded fan-out
  // against an edge the operator does not control the size of: it burns the
  // account's rate-limit budget and floods the model's context with media it
  // never asked for. `fetchAll` is the caller's decision, not the module's.
  const { req, calls } = fakeReq(() => ({
    data: [{ id: 't1' }],
    paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await listTaggedMedia(req, { igId: '999', maxItems: 100 });

  assert.equal(calls.length, 1);
  assert.equal(res.after, 'A1');
  assert.equal(res.truncated, false);
  // No `limit` stated by the caller means no `limit` on the wire — the module
  // must not invent a page size Graph would otherwise pick itself.
  assert.equal(calls[0]?.params?.limit, undefined);
});

// --- writes ----------------------------------------------------------------

test('replyToComment POSTs to the /replies edge with the message', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'reply-1' }));

  const r = await replyToComment(req, { commentId: 'C1', message: 'hello' });

  assert.equal(r.id, 'reply-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/C1/replies');
  assert.deepEqual(calls[0]?.params, { message: 'hello' });
  // A public reply cannot be un-posted quietly: if the transport is told this
  // write is idempotent, a timed-out request is retried and the account posts
  // the same reply twice under a stranger's comment.
  assertPlainGraphCall(calls[0]);
});

test('createComment POSTs to the media /comments edge with the message', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'comment-1' }));

  const r = await createComment(req, { mediaId: 'M1', message: 'nice post' });

  assert.equal(r.id, 'comment-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/M1/comments');
  assert.deepEqual(calls[0]?.params, { message: 'nice post' });
  // Same replay hazard as a reply, in public and under someone else's post.
  assertPlainGraphCall(calls[0]);
});

test('setCommentHidden POSTs hide=true and hide=false to the comment node', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  await setCommentHidden(req, { commentId: 'C1', hide: true });
  await setCommentHidden(req, { commentId: 'C1', hide: false });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/C1');
  assert.deepEqual(calls[0]?.params, { hide: true });
  assert.deepEqual(calls[1]?.params, { hide: false });
  // Hiding is idempotent in effect but must still be sent as a plain POST: the
  // transport decides retries from the method, and a host pin here would send a
  // moderation write — with the token — to a host the operator never configured.
  assertPlainGraphCall(calls[0]);
  assertPlainGraphCall(calls[1]);
});

test('deleteComment issues a DELETE on the comment node', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  await deleteComment(req, { commentId: 'C1' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'DELETE');
  assert.equal(calls[0]?.path, '/C1');
  assert.equal(calls[0]?.params, undefined);
  // The one irreversible write in this module. Marking it idempotent would let
  // the transport replay it after a timeout, and a replayed DELETE against an
  // already-deleted node comes back as a Graph error the caller then reports as
  // a failure for a deletion that in fact went through.
  assertPlainGraphCall(calls[0]);
});

test('setCommentsEnabled POSTs comment_enabled to the media node in both directions', async () => {
  const { req, calls } = fakeReq(() => ({ success: true }));

  await setCommentsEnabled(req, { mediaId: 'M1', enabled: false });
  await setCommentsEnabled(req, { mediaId: 'M2', enabled: true });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/M1');
  assert.deepEqual(calls[0]?.params, { comment_enabled: false });
  // Both directions are asserted because a toggle wired to a constant still
  // passes every "disable" test while being unable to re-enable: the operator
  // asks to reopen comments, the tool reports success, and the post stays shut.
  assert.equal(calls[1]?.path, '/M2');
  assert.deepEqual(calls[1]?.params, { comment_enabled: true });
  assertPlainGraphCall(calls[0]);
  assertPlainGraphCall(calls[1]);
});

/**
 * The text a write posts is model- or operator-authored, and this layer is a
 * transport: it must forward the message exactly as given.
 *
 * Every other message assertion in this file uses a short plain word ('hello',
 * 'nice post'), and a plain word is a fixed point of almost every string
 * transformation — trimming it, Unicode-normalizing it or truncating it to a
 * hundred characters all leave it unchanged. So a builder that quietly edits the
 * message passes the whole file. On a real reply that costs the operator a
 * public post they did not write: a long answer silently cut in half mid-
 * sentence, a deliberate blank line before a signature stripped, or a ligature
 * or combining accent rewritten inside a customer's own name.
 *
 * The fixture is therefore chosen to be a fixed point of NOTHING, and the three
 * self-checks below keep it that way — they fail if the constant is ever
 * softened into something a transformation would pass through untouched.
 */
const VERBATIM_MESSAGE =
  '  Thanks for flagging this — the fix is live now.\n\n' +
  'Full details: https://example.invalid/changelog#comments\n' +
  'Written for a customer whose name carries a \uFB01 ligature and a combining ' +
  'accent (e\u0301), plus an emoji \u{1F44D}, and long enough to run past any ' +
  'well-meant truncation an api layer might be tempted to apply.  ';

test('a comment write posts the message byte-for-byte — no trim, no truncation, no normalization', async () => {
  assert.notEqual(
    VERBATIM_MESSAGE,
    VERBATIM_MESSAGE.trim(),
    'the fixture must have surrounding whitespace, or it cannot catch a trim',
  );
  assert.notEqual(
    VERBATIM_MESSAGE,
    VERBATIM_MESSAGE.normalize('NFKC'),
    'the fixture must contain a character NFKC rewrites, or it cannot catch normalization',
  );
  assert.ok(
    VERBATIM_MESSAGE.length > 100,
    'the fixture must be long enough that a truncating builder produces a different string',
  );

  const reply = fakeReq(() => ({ id: 'reply-1' }));
  await replyToComment(reply.req, { commentId: 'C1', message: VERBATIM_MESSAGE });
  assert.deepEqual(reply.calls[0]?.params, { message: VERBATIM_MESSAGE });

  const created = fakeReq(() => ({ id: 'comment-1' }));
  await createComment(created.req, { mediaId: 'M1', message: VERBATIM_MESSAGE });
  assert.deepEqual(created.calls[0]?.params, { message: VERBATIM_MESSAGE });
});

test('the acknowledging writes return what Graph answered, never a locally invented success', async () => {
  // hide/unhide, delete and the comment toggle are typed to return Graph's
  // acknowledgement, but every other assertion about them in this file looks at
  // the REQUEST they build. That leaves the response path completely unpinned: a
  // body synthesized here after an `await` — `{ success: true }` — satisfies the
  // declared return type, the request assertions and the compiler alike, while
  // reporting a write that Graph explicitly refused as a write that happened.
  // The `deepEqual` is against the whole answer, extra Graph keys included, so a
  // reshaped acknowledgement fails too: this layer passes the ack through, it
  // does not decide what an ack means.
  const denial = { success: false, error_user_msg: 'the caller does not own this object' };

  assert.deepEqual(await deleteComment(fakeReq(() => denial).req, { commentId: 'C1' }), denial);
  assert.deepEqual(
    await setCommentHidden(fakeReq(() => denial).req, { commentId: 'C1', hide: true }),
    denial,
  );
  assert.deepEqual(
    await setCommentsEnabled(fakeReq(() => denial).req, { mediaId: 'M1', enabled: true }),
    denial,
  );

  // CC-DATA-2 on the write side: an acknowledgement with no `success` key is
  // Meta disclosing nothing, and must not be back-filled into a positive one.
  const silentAck = await deleteComment(fakeReq(() => ({})).req, { commentId: 'C2' });
  assert.deepEqual(silentAck, {});
  assert.equal('success' in silentAck, false, 'an unstated result stays unstated');
});

// --- request shape: the whole parameter object, not a sample of it ----------

test('each read sends exactly the parameters it declares — nothing rides along', async () => {
  // `params` becomes the query string verbatim, so every key here reaches Meta.
  // The assertions elsewhere in this file read individual keys, which leaves the
  // object open at the top: an extra `fields`, `since`, `access_token` or
  // `appsecret_proof` smuggled into a builder passes every value-by-value check
  // while changing what the call asks for — or, for an auth key, which
  // credentials it travels with, since `core/http` appends the real ones to
  // whatever is already there. Pinning the object whole is the only assertion
  // that fails on an ADDED key. The `limit`/`after` keys are asserted present
  // with an `undefined` value on purpose: that is the literal shape a first,
  // unhinted page builds, and deepStrictEqual compares own keys, so writing
  // them out is what keeps the pin honest in both directions.
  const { req: r1, calls: c1 } = fakeReq(() => ({ data: [], paging: {} }));
  await listComments(r1, { mediaId: 'M1', maxItems: 50 });
  assert.deepEqual(c1[0]?.params, {
    fields: EXPECTED_COMMENT_FIELDS,
    limit: undefined,
    after: undefined,
  });

  const { req: r2, calls: c2 } = fakeReq(() => ({ id: 'C1' }));
  await getComment(r2, { commentId: 'C1' });
  assert.deepEqual(c2[0]?.params, { fields: EXPECTED_DETAIL_FIELDS });

  const { req: r3, calls: c3 } = fakeReq(() => ({ data: [], paging: {} }));
  await listTaggedMedia(r3, { igId: '999', maxItems: 50, limit: 25, after: 'CUR' });
  assert.deepEqual(c3[0]?.params, {
    fields: EXPECTED_TAGGED_FIELDS,
    limit: 25,
    after: 'CUR',
  });
});

// --- reply envelope: the third shape Graph can send ------------------------

test('a reply envelope carrying a null data is read as "not disclosed", never dereferenced', async () => {
  // `req` casts the Graph body rather than validating it, so the declared
  // `{ data?: RawComment[] }` records what Meta documents, not what arrives.
  // Alongside the absent key and `{ data: [] }` there is a third shape in the
  // wild — `{ "data": null }` — and it means the same thing as the first: the
  // edge was not disclosed. The guard is a truthiness test precisely so that
  // shape lands in the "absent" bucket; testing the key for `!== undefined`
  // instead would let `null` through to `.map()` and turn one odd comment in a
  // page into a TypeError that fails the entire listing.
  const { req } = fakeReq(() => ({
    data: [{ id: 'c1', text: 'hi', replies: { data: null } }],
    paging: {},
  }));

  const page = await listComments(req, { mediaId: 'M1', maxItems: 10 });

  assert.deepEqual(page.items, [{ id: 'c1', text: 'hi' }]);
  assert.equal('replies' in (page.items[0] ?? {}), false, 'no key, not an empty array');
});

test('getComment reads a null reply data the same way, without crashing the read', async () => {
  // Same wire shape, second normalizer. The two flatteners are separate
  // functions, so this guard can drift on its own: a detail read that throws on
  // `{ "data": null }` makes a single moderation lookup fail outright, which is
  // the read a model performs right before deciding whether to hide or delete.
  const { req } = fakeReq(() => ({ id: 'C1', hidden: false, replies: { data: null } }));

  const detail = await getComment(req, { commentId: 'C1' });

  assert.deepEqual(detail, { id: 'C1', hidden: false });
  assert.equal('replies' in detail, false, 'an undisclosed thread stays undisclosed');
});

test('a reply envelope whose data is not an array is read as "not disclosed", never mapped', async () => {
  // The body is cast, not validated: `{ "data": {} }` is truthy, so a truthiness
  // guard handed it to `.map()` and one odd comment failed the whole listing
  // (and the single-comment read) with a TypeError.
  const { req } = fakeReq(() => ({
    data: [{ id: 'c1', text: 'hi', replies: { data: {} } }],
    paging: {},
  }));
  const page = await listComments(req, { mediaId: 'M1', maxItems: 10 });
  assert.deepEqual(page.items, [{ id: 'c1', text: 'hi' }]);

  const detail = await getComment(fakeReq(() => ({ id: 'C1', replies: { data: 'x' } })).req, {
    commentId: 'C1',
  });
  assert.deepEqual(detail, { id: 'C1' });
});

test('listComments hands a null entry through for the tool layer to count, not a crashed page (CC-COM-16)', async () => {
  // The body is cast, so `data` can hold `null` — at the top level or inside an
  // inline reply edge. Destructuring it threw a TypeError out of the walk, which
  // failed the whole listing; the entry is now passed through untouched, and
  // `tools/comments` leaves it out and counts it.
  const { req } = fakeReq(() => ({
    data: [null, 'junk', { id: 'c1', replies: { data: [null, { id: 'r1' }] } }],
    paging: {},
  }));

  const res = await listComments(req, { mediaId: 'M1', maxItems: 200 });

  // A non-object entry is handed through as-is too — spreading a string would
  // turn it into an object of characters.
  assert.deepEqual(res, {
    items: [null, 'junk', { id: 'c1', replies: [null, { id: 'r1' }] }],
    truncated: false,
  });
});

test('listComments reports a single page ending on an unusable cursor as truncated (CC-DATA-11)', async () => {
  const { req } = fakeReq(() => ({
    data: [{ id: 'c1' }],
    paging: { cursors: { after: '' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await listComments(req, { mediaId: 'M1', maxItems: 200 });

  assert.deepEqual(res, {
    items: [{ id: 'c1' }],
    truncated: true,
    note: 'the edge returned an unusable cursor (no way to continue) — the listing may be incomplete',
  });
});

test('listComments and listTaggedMedia report an unreadable page instead of crashing (CC-DATA-71)', async () => {
  // Both edges walk through the shared `fetchPagedEdge`, so a `data` that is not
  // a list (or a body that is not an envelope) used to throw a raw TypeError out
  // of both. It must come back as an empty, truncated page that says why — never
  // as the plain `{ items: [] }` a post with no comments gets.
  for (const body of [{ data: { id: 'c1' } }, { data: null }, { data: 'abc' }, null, 7]) {
    const label = `body=${JSON.stringify(body)}`;
    const comments = await listComments(fakeReq(() => body).req, { mediaId: 'M1', maxItems: 200 });
    assert.deepEqual(comments.items, [], label);
    assert.equal(comments.truncated, true, label);
    assert.match(comments.note ?? '', /unreadable page/, label);

    const tagged = await listTaggedMedia(fakeReq(() => body).req, {
      igId: 'me',
      maxItems: 200,
      fetchAll: true,
    });
    assert.deepEqual(tagged.items, [], label);
    assert.equal(tagged.truncated, true, label);
    assert.match(tagged.note ?? '', /unreadable page/, label);
  }
});

test('listComments reads the example fixtures by `paging.next`: cursors without `next` end the listing (CC-DATA-115)', async () => {
  // `example-list-comments.json` is a last page: `cursors.after` and no `next`.
  const last = loadFixture<unknown>('example-list-comments.json');
  const done = await listComments(fakeReq(() => last).req, { mediaId: 'M1', maxItems: 200 });
  assert.equal(done.items.length, 2);
  assert.equal(done.truncated, false);
  assert.equal('after' in done, false, 'the last page publishes no resume cursor');

  // `example-list-media.json` carries `next`, so its `cursors.after` resumes.
  const more = loadFixture<unknown>('example-list-media.json');
  const page = await listComments(fakeReq(() => more).req, { mediaId: 'M1', maxItems: 200 });
  assert.equal(page.truncated, false);
  assert.equal(page.after, 'SYNTHETIC_OPAQUE_2');
});
