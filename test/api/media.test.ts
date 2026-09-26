/**
 * Unit tests for the media api layer (Layer 1). These use a **fake**
 * {@link IgRequestFn} returning canned Graph list/paging payloads — no network,
 * no `mcp`/result dependency — so they run standalone. They cover the
 * pagination cap, cursor handling, carousel-child fetching, and the CC-DATA
 * corner cases owed by T-D2 (CC-DATA-1/2/4/5/6).
 */
import { after as afterAll, test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import {
  fetchPagedEdge,
  getMedia,
  getMediaChildren,
  listMedia,
  UNUSABLE_CURSOR_NOTE,
} from '../../src/api/media.js';

/**
 * The one seam this layer may use is the injected {@link IgRequestFn}, and every
 * test below hands it a fake. Poisoning the global transport makes that
 * structural rather than conventional: code that reached for `fetch` directly —
 * or a helper that quietly fell back to it — dies offline here instead of
 * calling Meta with whatever credentials happen to sit on the machine running
 * the suite. Restored in `after()` so nothing leaks to other files.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('api/media unit tests must never touch the network');
};
afterAll(() => {
  globalThis.fetch = realFetch;
});

/**
 * The exact field sets this layer must ask Graph for, pinned character-for-
 * character and deliberately duplicated from the source rather than imported.
 * Graph returns exactly what was requested and nothing more, so a field that
 * quietly falls out of the selection is not an error anywhere — it is a media
 * object the client can no longer link to (`permalink`), sort (`timestamp`) or
 * tell a reel from a story by (`media_product_type`), and a wrong separator
 * makes Graph reject or ignore the whole selection.
 */
const EXPECTED_MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,' +
  'timestamp,like_count,comments_count';
const EXPECTED_CHILD_FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,timestamp';
const EXPECTED_MEDIA_DETAIL_FIELDS = `${EXPECTED_MEDIA_FIELDS},children{${EXPECTED_CHILD_FIELDS}}`;

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

test('listMedia returns a single page with its cursor and forwards limit/fields', async () => {
  const page = {
    data: [
      { id: '1', caption: 'a', media_type: 'IMAGE' },
      { id: '2', media_type: 'VIDEO' },
    ],
    paging: { cursors: { after: 'CUR' }, next: 'https://graph/next' },
  };
  const { req, calls } = fakeReq(() => page);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 200, limit: 25 });

  assert.equal(res.items.length, 2);
  assert.equal(res.after, 'CUR');
  assert.equal(res.truncated, false);
  assert.equal(res.note, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.path, '/999/media');
  assert.equal(calls[0]?.params?.limit, 25);
  assert.equal(calls[0]?.params?.after, undefined);
  // The list call must send the LIST field set, exactly. A subset is invisible
  // at runtime — Graph happily omits what was never asked for, so the tool just
  // renders media with no permalink or no timestamp. The detail set is equally
  // wrong here: an inline `children{...}` expansion on every page of a listing
  // multiplies the quota a plain feed read spends, for children nobody asked for.
  assert.equal(calls[0]?.params?.fields, EXPECTED_MEDIA_FIELDS);
});

test('listMedia sends exactly the documented query parameters and invents no page size', async () => {
  // `limit` is a page-size HINT that belongs to the CALLER. A default injected
  // here overrides whatever Instagram would have chosen and does it invisibly:
  // the caller sets no limit, receives a short page, and concludes the account
  // has fewer posts than it does — or, with `fetchAll`, burns four times the
  // requests walking the same feed in smaller slices. Any extra parameter
  // smuggled onto a feed read is the same class of defect: it is a different
  // Graph request from the one the tool documents and the operator authorised.
  const { req, calls } = fakeReq(() => ({ data: [], paging: {} }));

  await listMedia(req, { igAccountId: '999', maxItems: 50 });

  assert.equal(calls.length, 1);
  // The WHOLE options record is pinned, not `params` alone. Every other slot on
  // `IgRequestOptions` — `host`, `idempotent`, `signal`, `body` — is optional, so a
  // key ADDED beside `params` is invisible to the compiler and was invisible to
  // this file: before this equality existed, adding `host: 'graph.facebook.com'`
  // to the builder in `api/media.ts` left the whole api + tools + registry suite
  // green (479 tests passing, 0 failures, exit 0). That single key is a real
  // incident, not a cosmetic one: `core/http` resolves `opts.host ?? defaultHost`,
  // so it sends the operator's access token — and, on Path B, the
  // `appsecret_proof` derived from the app secret — to a host they never
  // configured. The same blind spot covers `idempotent: false`, which switches
  // off the 429/5xx retry on a plain feed read, and a `body` on a GET, which
  // attaches a form payload to a listing. One equality closes all of them.
  //
  // `limit` and `after` are written out with an explicit `undefined` on purpose:
  // that is the literal shape a first, unhinted page builds, and
  // `node:assert/strict`'s deepEqual compares OWN keys, so naming them is what
  // keeps the pin honest in both directions — it fails on a default page size
  // smuggled in as much as on the keys disappearing.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/999/media',
    params: { fields: EXPECTED_MEDIA_FIELDS, limit: undefined, after: undefined },
  });
});

test('listMedia hands back every field Graph disclosed, not a reduced projection', async () => {
  // The list normalizer is the identity ON PURPOSE: whatever Graph disclosed for
  // a media object is what the tool renders. A normalizer that rebuilds the
  // object instead silently drops fields that WERE successfully read — a feed of
  // bare ids with no `permalink` to open and no `timestamp` to sort by — or
  // writes a placeholder `undefined` over one. CC-DATA-2 reserves an absent key
  // for "Instagram withheld this"; a key we blanked ourselves tells the model
  // the author hid a caption that is sitting right there in the response.
  const item = {
    id: '1',
    caption: 'hello',
    media_type: 'IMAGE',
    media_product_type: 'FEED',
    media_url: 'https://cdn.example/1.jpg',
    permalink: 'https://instagram.com/p/1',
    thumbnail_url: 'https://cdn.example/t1.jpg',
    timestamp: '2026-01-01T00:00:00+0000',
    like_count: 7,
    comments_count: 3,
  };
  const { req } = fakeReq(() => ({ data: [item], paging: {} }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 10 });

  assert.deepEqual(res.items, [item]);
  assert.deepEqual(Object.keys(res.items[0] ?? {}), [
    'id',
    'caption',
    'media_type',
    'media_product_type',
    'media_url',
    'permalink',
    'thumbnail_url',
    'timestamp',
    'like_count',
    'comments_count',
  ]);
});

test('listMedia resumes from the supplied cursor instead of restarting page one', async () => {
  // The `after` a truncated read handed back is the caller's ONLY way to
  // continue. Dropping it on the way into the walk silently replays the newest
  // page: a client paging through a 2000-post feed gets the same first 25 posts
  // forever, never reaches the older media, and burns quota doing it — while
  // every response still looks perfectly valid.
  const responder = (opts: IgRequestOptions) => {
    if (opts.params?.after === 'RESUME')
      return {
        data: [{ id: '3' }, { id: '4' }],
        paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' },
      };
    return {
      data: [{ id: '1' }, { id: '2' }],
      paging: { cursors: { after: 'RESUME' }, next: 'https://graph.facebook.com/next' },
    };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 200, after: 'RESUME' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.params?.after, 'RESUME');
  assert.deepEqual(
    res.items.map((i) => i.id),
    ['3', '4'],
  );
  assert.equal(res.after, 'NEXT');
});

test('listMedia never invents a resume cursor, and a complete result carries only the keys it has', async () => {
  // Two defects with one shape, both about claiming state the walk does not have.
  // (1) Seeding the OUTGOING cursor with the incoming one means a walk that ran
  // cleanly to the end still reports `after`, so a client looping "while
  // paging.after" re-reads the same tail forever and pays quota for it — the
  // classic non-terminating pagination bug, and it only appears on RESUMED reads,
  // so the first page of every listing looks fine. (2) Writing `after`/`note`
  // unconditionally puts keys holding `undefined` on the result. `tools/media.ts`
  // copies the result key by key into structured output typed `after?: string`,
  // so a present-but-undefined cursor is either a schema violation on a perfectly
  // good listing or an `after=undefined` echoed back to Graph on the next call.
  const responder = (opts: IgRequestOptions) => {
    if (opts.params?.after === 'RESUME') return { data: [{ id: '3' }], paging: {} };
    throw new Error('the walk must start from the supplied cursor');
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, {
    igAccountId: '999',
    maxItems: 100,
    after: 'RESUME',
    fetchAll: true,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(
    res.items.map((i) => i.id),
    ['3'],
  );
  assert.equal(res.truncated, false);
  assert.deepEqual(Object.keys(res).sort(), ['items', 'truncated']);
});

test('listMedia fetchAll caps at maxItems and withholds the cursor it cut a page on', async () => {
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

  const res = await listMedia(req, { igAccountId: '999', maxItems: 3, fetchAll: true });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2', '3'],
  );
  assert.equal(res.truncated, true);
  assert.equal(calls.length, 2);
  // The cap fell between `3` and `4`, INSIDE the second page. `A2` is that
  // page's trailing boundary, so a caller who resumes from it starts at `5` and
  // media `4` is gone from the listing with nothing anywhere saying so — not the
  // item array, not `truncated`, not a note. A Graph cursor cannot address an
  // offset inside a page, so there is no honest cursor for this stop to hand
  // back (CC-DATA-47): it withholds the one it has and explains itself instead.
  assert.equal('after' in res, false, 'a cursor past the dropped item is worse than no cursor');
  assert.equal(
    res.note,
    'stopped at the item cap part-way through a page — no cursor addresses the items ' +
      'dropped here, so there is nothing to resume from; re-read with a smaller limit',
  );
});

test('listMedia fetchAll stopping exactly at the cap with no more data is NOT truncated (CC-DATA-4)', async () => {
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

  const res = await listMedia(req, { igAccountId: '999', maxItems: 4, fetchAll: true });

  assert.equal(res.items.length, 4);
  assert.equal(res.truncated, false);
  assert.equal(res.after, undefined);
});

test('listMedia fetchAll filling the cap while more remains IS truncated (CC-DATA-4)', async () => {
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
    throw new Error('unexpected');
  };
  const { req } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 4, fetchAll: true });

  assert.equal(res.items.length, 4);
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'A2');
});

test('listMedia fetchAll flags a last page that overflowed the cap even with no cursor left', async () => {
  // The edge ended (no `after`) but the cap cut the last page short. The overflow
  // is then the ONLY evidence that items were dropped, so a truncation check that
  // consults nothing but the cursor reports this read as complete — and hands
  // back no cursor either, which makes the discarded tail unreachable rather than
  // merely deferred. This is precisely the shape a reconciliation job trips over:
  // it reads a "complete" feed, sees a post missing, and deletes or re-publishes
  // against media that is still live.
  const { req, calls } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }, { id: '3' }],
    paging: {},
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 2, fetchAll: true });

  assert.equal(calls.length, 1);
  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2'],
  );
  assert.equal(res.truncated, true, 'the dropped third item must be admitted');
  assert.equal('after' in res, false, 'the edge ended — there is no cursor to resume from');
  // Truncated with no cursor, and yet NOT the unusable-cursor case: the edge said
  // it was finished, so the tail is missing because the cap dropped it, not because
  // Graph handed back something that could not be sent again. The two stops keep
  // their own sentences, and this is the assertion that holds the boundary — the
  // mid-page note must never read "on an unusable cursor" when the cursor was
  // simply absent. It is also the shape that proves the mid-page note is about
  // the ITEMS and not about a cursor: there is no cursor here at all, and the
  // dropped tail is just as unreachable (CC-DATA-47).
  assert.equal(
    res.note,
    'stopped at the item cap part-way through a page — no cursor addresses the items ' +
      'dropped here, so there is nothing to resume from; re-read with a smaller limit',
    'an exhausted edge is not an unusable cursor',
  );
});

test('listMedia fetchAll keeps a partial result when a cursor goes stale mid-listing (CC-DATA-1)', async () => {
  const responder = (opts: IgRequestOptions) => {
    if (opts.params?.after === undefined)
      return {
        data: [{ id: '1' }, { id: '2' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    throw new InstagramError('cursor invalid', { kind: 'validation', code: 100 });
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 100, fetchAll: true });

  assert.equal(res.items.length, 2);
  assert.equal(res.truncated, true);
  assert.ok(res.note?.includes('stale'));
  assert.equal(calls.length, 2);
});

test('listMedia propagates a non-Graph failure mid-walk instead of noting a stale cursor (CC-DATA-1)', async () => {
  // CC-DATA-1 licenses exactly ONE swallow: a Graph error on a cursor that went
  // stale between pages. Everything else mid-walk is a failed read — a response
  // body that died in transit (undici rejects with a bare TypeError), an auth or
  // token-store failure raised inside the seam, a bug in this layer. Rendering
  // those as a truncated page tells the client "that is all your media", so a
  // caller that reconciles or deletes against the result acts on data it never
  // actually read, and the real failure never reaches a log or a human.
  const transport = (opts: IgRequestOptions) => {
    if (opts.params?.after === undefined)
      return {
        data: [{ id: '1' }, { id: '2' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    throw new TypeError('terminated');
  };
  const { req: transportReq, calls: transportCalls } = fakeReq(transport);

  await assert.rejects(
    () => listMedia(transportReq, { igAccountId: '999', maxItems: 100, fetchAll: true }),
    (e: unknown) => e instanceof TypeError && e.message === 'terminated',
  );
  assert.equal(transportCalls.length, 2);

  // A thrown non-Error must not be laundered into a note either.
  const { req: thrownStringReq } = fakeReq((opts: IgRequestOptions) => {
    if (opts.params?.after === undefined)
      return {
        data: [{ id: '1' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    throw 'socket hang up' as unknown as Error;
  });

  await assert.rejects(
    () => listMedia(thrownStringReq, { igAccountId: '999', maxItems: 100, fetchAll: true }),
    (e: unknown) => e === 'socket hang up',
  );
});

test('listMedia propagates a mid-walk Graph error that is not a stale cursor (CC-DATA-105)', async () => {
  // CC-DATA-1 swallows a STALE CURSOR, which Graph reports as an invalid
  // parameter (code 100 -> `validation`). Every other Graph failure on page 2+
  // used to be swallowed with it and published as "cursor may be stale —
  // restart the listing": an expired token, a revoked permission, a rate limit
  // and a Meta outage all came back as a short, successful-looking page whose
  // advice (restart now) is wrong for each of them — a rate-limited caller that
  // restarts at once spends the quota again. They now propagate with their own
  // kind, so the tool layer renders the real, actionable error.
  const cases = [
    { kind: 'auth', code: 190 },
    { kind: 'permission', code: 10 },
    { kind: 'rate_limit', code: 4 },
    { kind: 'upstream', code: 2 },
  ] as const;
  for (const { kind, code } of cases) {
    const { req, calls } = fakeReq((opts: IgRequestOptions) => {
      if (opts.params?.after === undefined)
        return {
          data: [{ id: '1' }, { id: '2' }],
          paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
        };
      throw new InstagramError(`page 2 ${kind}`, { kind, code });
    });

    await assert.rejects(
      () => listMedia(req, { igAccountId: '999', maxItems: 100, fetchAll: true }),
      (e: unknown) => e instanceof InstagramError && e.kind === kind && e.code === code,
      `a mid-walk ${kind} error must propagate`,
    );
    assert.equal(calls.length, 2, `${kind}: the walk reached page 2`);
  }
});

// --- fetchAll termination guards -------------------------------------------
//
// Every case below would spin forever (or replay the same request) without a
// bound in the cursor walk. The fake edge therefore trips a plain `Error` once
// the call count is clearly past what a correct walk needs: it is NOT an
// InstagramError, so the CC-DATA-1 branch cannot swallow it and a runaway loop
// fails the test loudly instead of hanging the suite.
function runawayGuard(limit: number): () => void {
  let n = 0;
  return () => {
    n += 1;
    if (n > limit) throw new Error(`runaway pagination: ${n} requests for a bounded walk`);
  };
}

test('listMedia treats an explicit fetchAll: false as one page, exactly like omitting it', async () => {
  // `tools/media.ts` passes `fetchAll: args.fetchAll ?? false`, so the flag
  // reaching this layer is ALWAYS defined — testing it for `undefined` instead of
  // for falsiness therefore never takes the single-page branch at all. Every
  // ordinary `instagram_list_media` call silently becomes a full multi-page walk
  // of the account's feed, up to the item cap and the fifty-page ceiling: dozens
  // of Graph requests and a stalled tool call where the caller asked for one page.
  const guard = runawayGuard(4);
  const responder = () => {
    guard();
    return {
      data: [{ id: '1' }],
      paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
    };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 100, fetchAll: false });

  assert.equal(calls.length, 1, 'fetchAll: false must not follow the cursor');
  assert.equal(res.after, 'A1');
  assert.equal(res.truncated, false);
  assert.equal(res.note, undefined);
});

test('listMedia fetchAll blames the repeated cursor first when the stuck page is also empty', async () => {
  // Both progress guards can match the same page. They must stay ONE chained
  // decision so the first — and strictest — diagnosis wins: "the edge returned
  // the same cursor twice" says this edge will never advance and the cursor is
  // useless, while "a page returned no items" reads as ordinary filtering that a
  // retry gets past. Handing the caller the softer note points them straight back
  // into the request loop this guard exists to break.
  const guard = runawayGuard(4);
  const responder = (opts: IgRequestOptions) => {
    guard();
    if (opts.params?.after === undefined)
      return {
        data: [{ id: '1' }],
        paging: { cursors: { after: 'STUCK' }, next: 'https://graph.facebook.com/next' },
      };
    return {
      data: [],
      paging: { cursors: { after: 'STUCK' }, next: 'https://graph.facebook.com/next' },
    };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 100, fetchAll: true });

  assert.equal(calls.length, 2);
  assert.ok(
    res.note?.includes('same cursor'),
    `expected the repeated-cursor diagnosis, got: ${String(res.note)}`,
  );
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'STUCK');
});

test('listMedia fetchAll does not accept a null cursor as proof the edge is exhausted', async () => {
  // CC-DATA-11. The intent of this test is unchanged and is the whole point:
  // only an ABSENT `after` means "that was the last page". A cursor key that is
  // present but serialized as JSON `null` is off-contract data, not a statement
  // of completeness, and reporting the read as complete would leave the caller no
  // flag, no note and no way to discover that media was left behind.
  //
  // What changed is the BEHAVIOUR that expresses it, and with it the call count
  // (2 -> 1). The old assertion defended a second request that could only ever be
  // a byte-identical repeat of the first: `buildUrl` skips a null query param
  // (`core/host.ts`), so `after: null` is `after` absent, and page 2 was page 1.
  // The old fake hid that by answering the second call with a fresh `{ id: '2' }`
  // page keyed off `params.after === undefined` — forward progress no transport
  // can actually produce. Against a real Graph the walk returned `1,1` and only
  // stopped when the repeated-cursor guard fired a page later. The fake below is
  // therefore faithful instead: identical request, identical answer, every time.
  //
  // So the intent is now asserted directly rather than through a proxy — the read
  // says it is incomplete, says why, and offers no cursor — which is strictly more
  // than a call count ever said, and none of it holds if a null is treated as an
  // ending.
  const guard = runawayGuard(4);
  const responder = () => {
    guard();
    return {
      data: [{ id: '1' }],
      paging: { cursors: { after: null }, next: 'https://graph.facebook.com/next' },
    };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 100, fetchAll: true });

  assert.equal(res.truncated, true, 'a null cursor is not proof the edge is exhausted');
  // "unusable", not "null": the guard is written once for every cursor that names
  // no position in the edge. The empty-string half has its own test below.
  assert.ok(
    res.note?.includes('unusable cursor'),
    `expected the unusable-cursor diagnosis, got: ${String(res.note)}`,
  );
  // No resume is offered, because none exists: the only cursor on hand is the
  // unusable one. `deepEqual` on the whole result catches an `after` that is
  // present-and-null as well as one that is present-and-undefined.
  assert.equal('after' in res, false, 'an unusable cursor must not be offered as a resume point');
  // The duplication the old call count licensed. A second identical request can
  // only re-return page 1, so `['1', '1']` is the failure this now pins down.
  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1'],
    'the walk must not re-fetch and duplicate the page it already has',
  );
  assert.equal(calls.length, 1, 'stopping beats re-issuing a request already answered');
});

test('listMedia never publishes a JSON-null cursor as a resume cursor', async () => {
  // The single-page read is the DEFAULT path (`fetchAll` is off unless asked
  // for), and it is where a null cursor did real damage. Nothing validates the
  // Graph body — `req` casts it — so `paging.cursors.after: null` was copied
  // straight into `PagedResult.after`, a field declared `string | undefined`,
  // because `null !== undefined`. `tools/media.ts` then copies that key into
  // `structuredContent.paging.after`, whose output schema is
  // `z.string().optional()`, and the MCP SDK validates structured content against
  // the declared output schema: the result is `McpError: Output validation error
  // — Invalid structured content ... Expected string, received null`. A page that
  // was read perfectly, over a live token, is returned to the model as a failed
  // tool call, and no amount of retrying fixes it because the response is the
  // same every time.
  //
  // The absent key is the honest answer: a cursor that cannot be sent back is
  // not a cursor. It must be absent, not present-and-null and not present-and-
  // undefined — `deepEqual` compares own enumerable keys, so it catches both.
  const { req, calls } = fakeReq(() => ({
    data: [{ id: '1' }],
    paging: { cursors: { after: null }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 200 });

  assert.equal(calls.length, 1);
  assert.equal('after' in res, false, 'a null cursor is not a cursor — the key must be absent');
  // …and not proof of the end either (CC-DATA-11): absent means finished,
  // present-but-unusable means unknown, so the page is published as truncated.
  assert.deepEqual(res, { items: [{ id: '1' }], truncated: true, note: UNUSABLE_CURSOR_NOTE });
});

test('listMedia never publishes an empty-string cursor the caller would be refused for', async () => {
  // The milder sibling, and it fails one layer later instead of one layer
  // earlier: `after: ''` passes the OUTPUT schema (`z.string().optional()`) and
  // reaches the model as a perfectly ordinary-looking cursor — but every tool
  // INPUT schema in the server types `after` as `z.string().min(1)`, so the
  // instant the model pages forward with the cursor it was just given, the call
  // is rejected as a validation error against an argument the server itself
  // produced. A cursor the server will not accept back is indistinguishable, to
  // the caller, from a broken tool.
  const { req, calls } = fakeReq(() => ({
    data: [{ id: '1' }],
    paging: { cursors: { after: '' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 200 });

  assert.equal(calls.length, 1);
  assert.equal('after' in res, false, 'an unusable cursor must not be offered as a resume point');
  assert.deepEqual(res, { items: [{ id: '1' }], truncated: true, note: UNUSABLE_CURSOR_NOTE });
});

test('listMedia keeps truncated: true when the cap is reached and the cursor is unusable', async () => {
  // Dropping an off-contract cursor must NOT be mistaken for proving the read was
  // complete. The cap was hit with a cursor key present, so the walk cannot show
  // the edge was exhausted, and `truncated` stays true exactly as before — the
  // caller is told data may remain, it is simply not handed a cursor that would
  // fail the moment it was used. This is the same shape the walk already returns
  // when the last page overflows the cap with no cursor left at all.
  const { req, calls } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }],
    paging: { cursors: { after: null }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 2, fetchAll: true });

  assert.equal(calls.length, 1);
  assert.equal(res.truncated, true, 'an unprovable read is never downgraded to complete');
  assert.equal('after' in res, false);
  // `truncated` with no `after` is honest but mute, and on this path it is the
  // ONLY signal the caller gets — the cap stop normally explains itself with the
  // cursor, and here there is no cursor to explain it with. So the note carries
  // the reason instead. It must not read as "retry with a bigger cap": a larger
  // `maxItems` would not stop here at all, it would run into the walk's own
  // unusable-cursor guard and stop on the same cursor with the same items.
  assert.ok(
    res.note?.includes('item cap'),
    `expected the capped-stop diagnosis, got: ${String(res.note)}`,
  );
  assert.equal(
    res.note?.includes('resume from `after`'),
    false,
    'a stop with no cursor must not tell the caller to resume from one',
  );
  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2'],
  );
});

test('listMedia fetchAll stops on an empty-string cursor exactly as it stops on a null one', async () => {
  // The fetchAll sibling of `listMedia never publishes an empty-string cursor…`,
  // which pins only the single-page read, and the deliberate twin of the null test
  // above. Kept SEPARATE rather than folded into it so the next maintainer can see
  // both shapes were considered and got the same verdict on purpose.
  //
  // Same verdict, because `''` names no position in the edge either. Not the same
  // mechanism, which is why one test could not have honestly stood for both:
  // `buildUrl` drops a null query param, so `after: null` repeats the previous
  // request byte for byte, whereas `''` really does reach the wire as `&after=`
  // and asks Graph for a position that does not exist. That is an accident of
  // serialisation, not a difference in meaning — and `''` is the shape every tool
  // input schema rejects as `z.string().min(1)`, so a walk that followed it would
  // be chasing a cursor the caller is forbidden to send.
  const guard = runawayGuard(4);
  const responder = () => {
    guard();
    return {
      data: [{ id: '1' }],
      paging: { cursors: { after: '' }, next: 'https://graph.facebook.com/next' },
    };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 100, fetchAll: true });

  assert.equal(res.truncated, true, 'an empty cursor is not proof the edge is exhausted');
  assert.ok(
    res.note?.includes('unusable cursor'),
    `expected the unusable-cursor diagnosis, got: ${String(res.note)}`,
  );
  assert.equal('after' in res, false, 'an unusable cursor must not be offered as a resume point');
  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1'],
    'the walk must not re-fetch and duplicate the page it already has',
  );
  assert.equal(calls.length, 1, 'an empty cursor is no more resumable than a null one');
});

test('listMedia treats a cursor of the wrong TYPE as unusable, not as a cursor', async () => {
  // The third shape `isUsableCursor` is written for, and until now the only one
  // no test could see. `null` and `''` exercise its `!== ''` half; both are falsy,
  // so relaxing the whole predicate to `Boolean(after)` still handles them and
  // survives every other cursor test in this file. What separates the two
  // spellings is a cursor that is TRUTHY but not a string — and nothing validates
  // the Graph body, `req` CASTS it, so `paging.cursors.after` declared
  // `string | undefined` in fact holds whatever the wire sent: a number from a
  // gateway that re-encoded an opaque token, an object from a shape change.
  //
  // Two distinct failures ride on the `typeof` half, which is why both paths are
  // asserted here:
  //   - the walk would SEND it. `cursor = nextAfter` puts a non-string into the
  //     next request's `after` param, and `core/host.ts` stringifies query params,
  //     so `12345` reaches Graph as `&after=12345` — a request the caller never
  //     asked for against a position that does not exist.
  //   - the result would PUBLISH it. `PagedResult.after` is `string | undefined`
  //     and `tools/media.ts` copies it into `structuredContent.paging.after`,
  //     whose output schema is `z.string().optional()`; the MCP SDK validates
  //     structured content, so a perfectly good read comes back to the model as an
  //     output validation error — the exact CC-DATA-11 failure the null cursor
  //     caused, reached by a different shape.
  const guard = runawayGuard(4);
  const walkResponder = () => {
    guard();
    return {
      data: [{ id: '1' }],
      paging: { cursors: { after: 12345 }, next: 'https://graph.facebook.com/next' },
    };
  };
  const walk = fakeReq(walkResponder);

  const res = await listMedia(walk.req, { igAccountId: '999', maxItems: 100, fetchAll: true });

  assert.equal(
    walk.calls.length,
    1,
    'a non-string cursor must never be sent back as `after` — the walk stops instead',
  );
  assert.equal(res.truncated, true, 'a cursor of the wrong type is not proof of completeness');
  assert.ok(
    res.note?.includes('unusable cursor'),
    `expected the unusable-cursor diagnosis, got: ${String(res.note)}`,
  );
  assert.equal('after' in res, false, 'a non-string cursor must not be offered as a resume point');

  // The single-page path publishes whatever the edge handed back, so it is the
  // one that hands the wrong type straight to the output schema. It must not
  // read the cursor as the end of the edge either (CC-DATA-11).
  const single = fakeReq(() => ({
    data: [{ id: '1' }],
    paging: { cursors: { after: 12345 }, next: 'https://graph.facebook.com/next' },
  }));

  const page = await listMedia(single.req, { igAccountId: '999', maxItems: 200 });

  assert.deepEqual(page, { items: [{ id: '1' }], truncated: true, note: UNUSABLE_CURSOR_NOTE });
});

test('listMedia fetchAll stops when a page returns no items but still advertises a cursor', async () => {
  // Graph does this for privacy-filtered / deleted items: `data: []` with a live
  // `after`. The cap can then never be reached, so only a progress guard ends it.
  const guard = runawayGuard(6);
  const responder = (opts: IgRequestOptions) => {
    guard();
    const after = opts.params?.after;
    if (after === undefined)
      return {
        data: [{ id: '1' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    return {
      data: [],
      paging: { cursors: { after: `${String(after)}+` }, next: 'https://graph.facebook.com/next' },
    };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 100, fetchAll: true });

  assert.equal(calls.length, 2); // first page, then the empty one that ends it
  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1'],
  );
  assert.equal(res.truncated, true); // more may remain — never reported complete
  assert.equal(res.after, 'A1+'); // resumable exactly where the walk gave up
  assert.ok(res.note?.includes('no items'));
});

test('listMedia fetchAll stops when the edge repeats the same cursor (no forward progress)', async () => {
  // A repeated `after` means the next request is byte-for-byte the previous one.
  const guard = runawayGuard(6);
  const responder = () => {
    guard();
    return {
      data: [{ id: '1' }, { id: '2' }],
      paging: { cursors: { after: 'STUCK' }, next: 'https://graph.facebook.com/next' },
    };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 100, fetchAll: true });

  assert.equal(calls.length, 2); // page 1, then the page that repeats its cursor
  assert.equal(res.items.length, 4);
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'STUCK');
  assert.ok(res.note?.includes('same cursor'));
});

test('listMedia fetchAll stops at the per-call page ceiling and stays resumable', async () => {
  // A huge maxItems with one item per page: only the page ceiling ends this.
  const guard = runawayGuard(80);
  const responder = (opts: IgRequestOptions) => {
    guard();
    const n = opts.params?.after === undefined ? 0 : Number(String(opts.params.after).slice(1));
    return {
      data: [{ id: String(n) }],
      paging: { cursors: { after: `A${n + 1}` }, next: 'https://graph.facebook.com/next' },
    };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 10_000, fetchAll: true });

  assert.equal(calls.length, 50);
  assert.equal(res.items.length, 50);
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'A50');
  assert.ok(res.note?.includes('50 pages'));
});

/**
 * Pin all seven pagination `note` texts by whole-string equality.
 *
 * Every other assertion in this file matches a fragment — `'stale'`, `'no
 * items'`, `'same cursor'`, `'item cap'`, `'unusable cursor'`, `'50 pages'` —
 * and so does `test/api/comments.test.ts`, which shares this walk. A fragment
 * pins the DIAGNOSIS and leaves the rest of the sentence unowned, yet the rest
 * of the sentence is the part the caller acts on: each note ends either in
 * "resume from `after`" or in an explicit statement that there is nothing to
 * resume from, and `tools/media.ts` hands the string to the model verbatim with
 * no other instruction attached. A rewrite that turned "nothing to resume from"
 * into "resume from `after`" would keep every fragment match in the suite green
 * while telling the model to re-request an edge position that does not exist.
 *
 * So the whole sentence is behaviour. It is pinned here once, in a table, rather
 * than by tightening the fragment assertions above: those tests are about the
 * walk's stopping rules — items, cursor, `truncated` — and stay readable as
 * such, while this one owns the wording and fails loudly when it drifts.
 */
test('every pagination note is pinned by its whole sentence', async () => {
  const stale = (opts: IgRequestOptions) => {
    if (opts.params?.after === undefined)
      return {
        data: [{ id: '1' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    throw new InstagramError('cursor invalid', { kind: 'validation', code: 100 });
  };
  const emptyPage = (opts: IgRequestOptions) => {
    const after = opts.params?.after;
    if (after === undefined)
      return {
        data: [{ id: '1' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    return {
      data: [],
      paging: { cursors: { after: `${String(after)}+` }, next: 'https://graph.facebook.com/next' },
    };
  };
  const ceiling = (opts: IgRequestOptions) => {
    const n = opts.params?.after === undefined ? 0 : Number(String(opts.params.after).slice(1));
    return {
      data: [{ id: String(n) }],
      paging: { cursors: { after: `A${n + 1}` }, next: 'https://graph.facebook.com/next' },
    };
  };

  const cases: {
    label: string;
    responder: (opts: IgRequestOptions) => unknown;
    maxItems: number;
    guard: number;
    note: string;
  }[] = [
    {
      label: 'a cursor that went stale mid-walk',
      responder: stale,
      maxItems: 100,
      guard: 4,
      note: 'cursor may be stale (data changed between pages) — restart the listing',
    },
    {
      label: 'the item cap reached on an unusable cursor',
      responder: () => ({
        data: [{ id: '1' }, { id: '2' }],
        paging: { cursors: { after: null }, next: 'https://graph.facebook.com/next' },
      }),
      maxItems: 2,
      guard: 4,
      note: 'stopped at the item cap on an unusable cursor — nothing to resume from',
    },
    {
      label: 'the item cap reached part-way through a page',
      responder: () => ({
        data: [{ id: '1' }, { id: '2' }, { id: '3' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      }),
      maxItems: 2,
      guard: 4,
      note:
        'stopped at the item cap part-way through a page — no cursor addresses the items ' +
        'dropped here, so there is nothing to resume from; re-read with a smaller limit',
    },
    {
      label: 'an unusable cursor below the cap',
      responder: () => ({
        data: [{ id: '1' }],
        paging: { cursors: { after: null }, next: 'https://graph.facebook.com/next' },
      }),
      maxItems: 100,
      guard: 4,
      note: 'the edge returned an unusable cursor (no way to continue) — the listing may be incomplete',
    },
    {
      label: 'the same cursor twice',
      responder: () => ({
        data: [{ id: '1' }],
        paging: { cursors: { after: 'STUCK' }, next: 'https://graph.facebook.com/next' },
      }),
      maxItems: 100,
      guard: 4,
      note: 'the edge returned the same cursor twice (no forward progress) — resume from `after`',
    },
    {
      label: 'a page with no items while more remained',
      responder: emptyPage,
      maxItems: 100,
      guard: 4,
      note: 'a page returned no items while more remained (filtered or deleted) — resume from `after`',
    },
    {
      label: 'the per-call page ceiling',
      responder: ceiling,
      maxItems: 10_000,
      guard: 80,
      note: 'stopped after 50 pages (per-call page ceiling) — resume from `after`',
    },
  ];

  for (const c of cases) {
    const guard = runawayGuard(c.guard);
    const { req } = fakeReq((opts) => {
      guard();
      return c.responder(opts);
    });

    const res = await listMedia(req, {
      igAccountId: '999',
      maxItems: c.maxItems,
      fetchAll: true,
    });

    assert.equal(res.note, c.note, `wrong note for ${c.label}`);
    assert.equal(res.truncated, true, `${c.label} must never be published as a complete read`);
  }

  // The promise each sentence makes about resuming has to match what the result
  // actually carries, which is the half a fragment match can never see. The
  // three notes that say there is nothing to resume from must come with no
  // `after`, and every note that says "resume from `after`" must come with one.
  const noResume = await listMedia(
    fakeReq(() => ({
      data: [{ id: '1' }, { id: '2' }],
      paging: { cursors: { after: null }, next: 'https://graph.facebook.com/next' },
    })).req,
    { igAccountId: '999', maxItems: 2, fetchAll: true },
  );
  assert.equal('after' in noResume, false, 'a "nothing to resume from" note carries no cursor');
  // The mid-page stop is the one where a cursor DOES exist and is still withheld,
  // so it is the only one of the three where the promise and the result could
  // drift apart without any other assertion noticing (CC-DATA-47).
  const midPage = await listMedia(
    fakeReq(() => ({
      data: [{ id: '1' }, { id: '2' }, { id: '3' }],
      paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
    })).req,
    { igAccountId: '999', maxItems: 2, fetchAll: true },
  );
  assert.equal('after' in midPage, false, 'a withheld cursor must not reappear in the result');

  const resumable = await listMedia(
    fakeReq(() => ({
      data: [{ id: '1' }],
      paging: { cursors: { after: 'STUCK' }, next: 'https://graph.facebook.com/next' },
    })).req,
    { igAccountId: '999', maxItems: 100, fetchAll: true },
  );
  assert.equal(
    resumable.after,
    'STUCK',
    'a "resume from `after`" note carries the cursor it names',
  );
});

test('listMedia fetchAll ends the walk on a MISSING cursor, not an empty one', async () => {
  // A page with no `paging.next` (here, no `paging` at all) is Graph saying
  // "that was the last page" — the one and only clean end of a walk
  // (CC-DATA-115). Testing for an empty-string
  // cursor instead never matches, so the exhausted page falls through into the
  // progress guards: a complete listing comes back flagged `truncated` with a
  // bogus "same cursor twice" note, and the missing cursor is copied back into
  // `cursor`, restarting the walk at page one until the page ceiling stops it.
  const guard = runawayGuard(6);
  const responder = (opts: IgRequestOptions) => {
    guard();
    if (opts.params?.after === undefined)
      return {
        data: [{ id: '1' }, { id: '2' }],
        paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next' },
      };
    return { data: [{ id: '3' }], paging: {} };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 100, fetchAll: true });

  assert.equal(calls.length, 2); // the second page exhausts the edge and ends it
  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2', '3'],
  );
  assert.equal(res.truncated, false); // a completed walk is never flagged truncated
  assert.equal(res.after, undefined);
  assert.equal(res.note, undefined);
});

test('listMedia treats a page with no data key as empty rather than crashing', async () => {
  // Graph omits `data` entirely on some empty edges instead of sending `[]`.
  // Reading `.length` off the missing key would be a TypeError inside the loop
  // — a listing of an account with no posts would fail instead of returning [].
  const { req } = fakeReq(() => ({ paging: {} }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 10 });

  assert.deepEqual(res.items, []);
  assert.equal(res.truncated, false);
  assert.equal(res.after, undefined);
});

test('listMedia marks a single page truncated when the page itself overflows maxItems', async () => {
  // One page can exceed the cap on its own (the caller asked for limit 25 with
  // maxItems 2). Without `truncated` the caller reads two of three items and is
  // told the listing was complete.
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }, { id: '3' }],
    paging: { cursors: { after: 'CUR' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 2, limit: 25 });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2'],
  );
  assert.equal(res.truncated, true, 'the dropped third item must be admitted');
  // …and gets no cursor, because `CUR` is not one. It is the boundary AFTER item
  // `3`, the very item the cap just discarded, so continuing from it drops `3`
  // out of the caller's world entirely (CC-DATA-47). `api/discovery.ts` reaches
  // the same verdict on its own walk, in its own words.
  assert.equal('after' in res, false, 'a cursor that skips the dropped item is not a cursor');
  assert.equal(
    res.note,
    'stopped at the item cap part-way through a page — no cursor addresses the items ' +
      'dropped here, so there is nothing to resume from; re-read with a smaller limit',
  );
});

test('listMedia floors a fractional maxItems into an integer cap (CC-DATA-4)', async () => {
  // `maxItems` is a plain `number` on PageParams and this walk is the ONE cap
  // every listing in the server passes through — comments, tagged media, feeds.
  // An unfloored cap makes `items.length >= cap` admit one item beyond the cap
  // and, worse, never register the overflow: the caller asked for 2, receives 3,
  // and is told the read was complete. The clamp must produce a whole number
  // before it is ever compared against a length.
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }, { id: '3' }],
    paging: { cursors: { after: 'CUR' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 2.5, limit: 25 });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2'],
  );
  assert.equal(res.truncated, true, 'the dropped third item must be admitted');
  assert.equal('after' in res, false, 'the cap cut the page short (CC-DATA-47)');
});

test('listMedia honours a maxItems of 0 by returning nothing and admitting it', async () => {
  // `maxItems` is the resolved `IG_MAX_ITEMS`, which an operator can set to 0 to
  // freeze reads — during an incident, or while a token is being rotated. A cap
  // quietly floored to a minimum of 1 hands back a media object anyway: the
  // freeze leaks one post per call, and nothing in the response says the cap was
  // overridden. The zero must reach the comparison intact, and the read must
  // still be reported as truncated because data demonstrably remained.
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }],
    paging: { cursors: { after: 'CUR' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 0 });

  assert.deepEqual(res.items, [], 'a cap of zero admits zero items');
  assert.equal(res.truncated, true, 'nothing was read while data existed — never "complete"');
  // A frozen read is the extreme of the mid-page cut: the cap fell BEFORE item
  // `1`, so `CUR` skips the whole page. Handing it back would let a caller page
  // straight through the freeze collecting cursors and reading nothing, without
  // one response admitting the window it walked over (CC-DATA-47).
  assert.equal('after' in res, false, 'a freeze must not hand out a cursor past the freeze');
});

test('a capped read never hands back a cursor that resumes past what it dropped (CC-DATA-47)', async () => {
  // The property the CC-DATA-47 assertions above exist to guarantee, stated as a
  // property rather than as a shape: follow whatever cursor the walk publishes
  // and the caller must land on the next item it has NOT seen. Every other test
  // here pins one stop's fields, which is a description of today's answer; this
  // one fails for ANY page-boundary cursor the cap might publish, including ones
  // nobody has thought of. Both walks are driven, because `fetchAll` and the
  // single page reach the cap through different branches of the same decision.
  //
  // The edge is ten items in pages of five, so a cap of three always lands
  // INSIDE the first page — the only arrangement where the page boundary and the
  // cap disagree, and therefore the only one that can tell a dropped item from a
  // deferred one.
  const EDGE = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1) }));
  const responder = (opts: IgRequestOptions) => {
    const raw = opts.params?.after;
    const start = raw === undefined ? 0 : Number(String(raw).slice(1));
    const next = start + 5;
    const data = EDGE.slice(start, next);
    return next < EDGE.length
      ? {
          data,
          paging: { cursors: { after: `P${next}` }, next: 'https://graph.facebook.com/next' },
        }
      : { data, paging: {} };
  };

  for (const fetchAll of [false, true]) {
    const lane = `fetchAll=${String(fetchAll)}`;
    const first = await listMedia(fakeReq(responder).req, {
      igAccountId: '999',
      maxItems: 3,
      fetchAll,
    });

    assert.deepEqual(
      first.items.map((i) => i.id),
      ['1', '2', '3'],
      `${lane} read the wrong first slice`,
    );
    assert.equal(first.truncated, true, `${lane} hid the dropped tail`);

    if (first.after === undefined) {
      // No cursor is an acceptable answer — but only when the result SAYS so.
      assert.match(first.note ?? '', /nothing to resume from/, `${lane} gave no cursor, no reason`);
      continue;
    }

    const second = await listMedia(fakeReq(responder).req, {
      igAccountId: '999',
      maxItems: 3,
      fetchAll,
      after: first.after,
    });
    assert.equal(
      second.items[0]?.id,
      '4',
      `${lane} resumed from ${first.after}, which skips the items the cap dropped`,
    );
  }
});

test('fetchPagedEdge maps every raw item through the caller-supplied normalizer', async () => {
  // The walk is generic and shared — `api/comments.ts` runs it with a normalizer
  // that flattens Graph's nested `replies` edge into a plain array. `listMedia`
  // passes the identity, so a walk that pushed the RAW item and skipped the
  // callback would look perfectly healthy through every other test in this file
  // while handing every OTHER caller unflattened wire shapes under a
  // domain-typed key. This is the only test that can tell the two apart.
  const { req } = fakeReq(() => ({ data: [{ n: 1 }, { n: 2 }], paging: {} }));

  const res = await fetchPagedEdge<{ n: number }, { id: string }>(
    req,
    (cursor) => ({ method: 'GET', path: '/edge', params: { after: cursor } }),
    { maxItems: 10 },
    (raw) => ({ id: `n${raw.n}` }),
  );

  assert.deepEqual(res.items, [{ id: 'n1' }, { id: 'n2' }]);
});

test('listMedia propagates a first-page error instead of hiding it', async () => {
  const { req } = fakeReq(() => {
    throw new InstagramError('boom', { kind: 'upstream', status: 500 });
  });

  await assert.rejects(
    () => listMedia(req, { igAccountId: '999', maxItems: 10 }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'upstream',
  );
});

test('getMedia flattens inline carousel children and passes unknown enums through (CC-DATA-6)', async () => {
  const raw = {
    id: 'M1',
    caption: 'hi',
    media_type: 'CAROUSEL_ALBUM',
    media_product_type: 'FUTURE_TYPE',
    children: {
      data: [
        { id: 'c1', media_type: 'IMAGE' },
        { id: 'c2', media_type: 'VIDEO' },
      ],
    },
  };
  const { req, calls } = fakeReq(() => raw);

  const detail = await getMedia(req, { mediaId: 'M1' });

  assert.equal(detail.id, 'M1');
  assert.equal(detail.media_product_type, 'FUTURE_TYPE');
  assert.equal(detail.children?.length, 2);
  assert.equal(detail.children?.[0]?.id, 'c1');
  assert.equal(calls[0]?.path, '/M1');
  // Pinned character-for-character. This is the ONE call where children arrive
  // inline, and the comma before `children{` is the only thing separating the
  // expansion from `comments_count`. Lose it and Graph is asked for a field
  // literally named `comments_countchildren{...}` — the entire get_media read
  // errors out, for every carousel and every single-image post alike.
  assert.equal(calls[0]?.params?.fields, EXPECTED_MEDIA_DETAIL_FIELDS);
});

test('getMedia reads with GET and sends nothing beyond the detail field set', async () => {
  // The verb is not cosmetic on `/{media-id}`: Graph accepts POST there to MUTATE
  // the object (that is how `comment_enabled` is toggled) and DELETE to destroy
  // it. A read tool that issues either performs an unannounced write on the very
  // media the model was only asked to inspect, and it does so past every control
  // the server has — `readOnlyHint: true` keeps it out of the write-mode gate and
  // out of the applied-write journal, so there is no preview, no confirmation and
  // no record. It also flips the transport's method-derived idempotency, so the
  // call stops being retried on a 5xx. An extra query parameter is the milder
  // cousin of the same defect: `limit` on a single-object read is a request
  // Graph never documented answering.
  const { req, calls } = fakeReq(() => ({ id: 'M9' }));

  await getMedia(req, { mediaId: 'M9' });

  assert.equal(calls.length, 1);
  // Pinned as one record rather than field by field, for the reason spelled out
  // on the `listMedia` request above: the narrow reads that used to stand here
  // could not see a key ADDED to the options object. Measured on this exact call
  // site — adding `host: 'graph.facebook.com'` to the `req` literal in
  // `api/media.ts` ran 479 tests with 0 failures and exit 0, so a single-object
  // read would have started shipping the access token to an unconfigured host
  // with the suite still reporting green.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/M9',
    params: { fields: EXPECTED_MEDIA_DETAIL_FIELDS },
  });
});

test('getMedia tolerates fields Meta omits rather than nulls (CC-DATA-2)', async () => {
  // CC-DATA-2 is an OMISSION contract, not a null-ing one: a field Meta withheld
  // must come back as an ABSENT KEY, never as a present key holding `undefined`.
  // Reading `detail.x` cannot tell those apart, so every check below is doubled
  // with an `in` test — and `'children' in detail` is precisely how a caller asks
  // "is this a carousel album?". A present-but-undefined `children` answers "yes"
  // for a single image, and a client that then walks `detail.children` for the
  // album's parts crashes on a post that never had any. The same trap sits under
  // `like_count`: the key's absence is "the author hid it", a key holding
  // `undefined` is a count we claim to have read and cannot state.
  const { req } = fakeReq(() => ({ id: 'M2', media_type: 'IMAGE' }));

  const detail = await getMedia(req, { mediaId: 'M2' });

  assert.equal(detail.id, 'M2');
  assert.equal(detail.like_count, undefined);
  assert.equal(detail.media_url, undefined);
  assert.equal(detail.children, undefined);
  assert.equal(
    'children' in detail,
    false,
    'a media with no children edge must not carry a `children` key at all',
  );
  assert.equal('like_count' in detail, false, 'a withheld count is absent, not undefined');
  assert.equal('media_url' in detail, false, 'a withheld url is absent, not undefined');
  // And the key set as a whole, because the normalizer is free to invent any
  // field back: `deepEqual` compares own enumerable keys, so a placeholder
  // `undefined` written under ANY of the optional names fails here too.
  assert.deepEqual(detail, { id: 'M2', media_type: 'IMAGE' });
  assert.deepEqual(Object.keys(detail).sort(), ['id', 'media_type']);
});

test('getMedia omits children when the inline edge arrives with no data array (CC-DATA-2)', async () => {
  // `children{...}` is always ASKED for by the detail field set, so Graph can
  // answer with the envelope and nothing in it. The flattener must key off the
  // `data` array, not off the envelope: assigning `children` unconditionally
  // leaks either the raw `{ data: … }` wire shape into a field typed
  // `MediaChild[]`, or an `undefined` under a key whose mere presence means
  // "album". Both read as a carousel whose parts are unusable.
  const { req } = fakeReq(() => ({ id: 'M3', media_type: 'IMAGE', children: {} }));

  const detail = await getMedia(req, { mediaId: 'M3' });

  assert.equal('children' in detail, false, 'an empty children envelope yields no key');
  assert.deepEqual(detail, { id: 'M3', media_type: 'IMAGE' });
});

test('getMedia omits children when the inline edge carries a null data payload (CC-DATA-2)', async () => {
  // Same envelope, one step worse: `children: { data: null }` instead of a
  // missing key. The flattener must key off the ARRAY it is about to copy, not
  // off whether the key exists, because copying `null` into a field DECLARED as
  // `MediaChild[]` produces a detail that claims to be an album and whose parts
  // cannot be read. Nothing downstream re-checks that type: the carousel
  // fallback in `tools/media.ts` reaches straight for `media.children.length`,
  // so the whole `instagram_get_media` call dies with a raw TypeError on exactly
  // the media type the fallback exists to rescue.
  const { req } = fakeReq(() => ({
    id: 'M4',
    media_type: 'CAROUSEL_ALBUM',
    children: { data: null },
  }));

  const detail = await getMedia(req, { mediaId: 'M4' });

  assert.equal('children' in detail, false, 'a null child payload yields no `children` key');
  assert.deepEqual(detail, { id: 'M4', media_type: 'CAROUSEL_ALBUM' });
});

test('getMedia keeps an empty children array as an empty array, not as an absent edge (CC-PROC-46)', async () => {
  // The third Graph answer, and the one the two tests above must not be allowed
  // to swallow: `children: { data: [] }` is an edge that WAS read and holds
  // nothing. That is a different fact from "not disclosed" — it is what Graph
  // sends for an album whose every child has since been deleted, or for a media
  // whose children the token may list but which has none — and `[]` is the
  // shape that says so. A guard that tests the array's LENGTH instead of its
  // presence (`children?.data?.length`) folds this case into the undisclosed one
  // and drops the key, so the consumer can no longer tell an album Graph
  // declined to expand from one it expanded to nothing; the `in` test a caller
  // uses to ask "is this a carousel?" then answers no for a carousel.
  const { req } = fakeReq(() => ({
    id: 'M5',
    media_type: 'CAROUSEL_ALBUM',
    children: { data: [] },
  }));

  const detail = await getMedia(req, { mediaId: 'M5' });

  assert.equal('children' in detail, true, 'an empty child array is still a children edge');
  assert.deepEqual(detail, { id: 'M5', media_type: 'CAROUSEL_ALBUM', children: [] });
});

test('getMedia propagates an InstagramError for a deleted/expired object (CC-DATA-5)', async () => {
  const { req } = fakeReq(() => {
    throw new InstagramError('object no longer exists', {
      kind: 'validation',
      code: 100,
      subcode: 33,
    });
  });

  await assert.rejects(
    () => getMedia(req, { mediaId: 'gone' }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
});

test('getMediaChildren lists a carousel edge with the child field set', async () => {
  const { req, calls } = fakeReq(() => ({
    data: [
      { id: 'c1', media_type: 'IMAGE' },
      { id: 'c2', media_type: 'VIDEO' },
    ],
  }));

  const children = await getMediaChildren(req, { mediaId: 'M1' });

  assert.equal(children.length, 2);
  assert.equal(children[0]?.id, 'c1');
  // The `/children` edge is a read like any other, and this call is issued
  // automatically by `instagram_get_media` whenever a carousel arrives without
  // its inline expansion — nobody asks for it, so nobody would recognise it as
  // the source of a mutation. A POST or DELETE here would run entirely inside a
  // tool annotated `readOnlyHint: true`, bypassing the write gate and the
  // journal, and would also lose the retry that GET's idempotency buys.
  //
  // Method, path, params and body are asserted as ONE record. This call is the
  // one in the module nobody requests by name, which makes an added key hardest
  // to notice here: adding `host: 'graph.facebook.com'` to this builder in
  // `api/media.ts` passed 479 tests with 0 failures and exit 0 against the api,
  // tools and registry suites combined, because nothing in this file ever read
  // `host`, `idempotent` or `signal` on a recorded call.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/M1/children',
    params: { fields: EXPECTED_CHILD_FIELDS },
  });
});

test('getMediaChildren returns an empty array when the edge has no data', async () => {
  const { req } = fakeReq(() => ({}));

  const children = await getMediaChildren(req, { mediaId: 'x' });

  assert.deepEqual(children, []);
});

test('listMedia fetchAll stops when the edge cycles back to a cursor it already followed', async () => {
  // A misbehaving edge that alternates `A → B → A` never repeats the cursor it
  // was just given, so a guard that only compares against the previous cursor
  // re-reads pages already in hand until the cap: the listing comes back with
  // the same items several times over and, when the cap ends it, with no note.
  const guard = runawayGuard(6);
  const { req, calls } = fakeReq((opts) => {
    guard();
    const after = opts.params?.after;
    const next = after === 'A' ? 'B' : 'A';
    return {
      data: [{ id: `after-${String(after ?? 'start')}` }],
      paging: { cursors: { after: next }, next: 'https://graph.facebook.com/next' },
    };
  });

  const res = await listMedia(req, { igAccountId: '999', maxItems: 10, fetchAll: true });

  assert.equal(calls.length, 3); // start, A, B — then B hands back A again
  assert.deepEqual(
    res.items.map((i) => i.id),
    ['after-start', 'after-A', 'after-B'],
  );
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'A');
  assert.equal(
    res.note,
    'the edge returned the same cursor twice (no forward progress) — resume from `after`',
  );
});

test('a walk resumed from `after` stops when the edge cycles back to that starting cursor', async () => {
  // The caller's own starting cursor is one the walk has already sent, so an
  // edge that leads back to it (`X → Y → X`) is the same cycle as above.
  const guard = runawayGuard(6);
  const { req, calls } = fakeReq((opts) => {
    guard();
    const after = String(opts.params?.after);
    return {
      data: [{ id: `after-${after}` }],
      paging: {
        cursors: { after: after === 'X' ? 'Y' : 'X' },
        next: 'https://graph.facebook.com/next',
      },
    };
  });

  const res = await listMedia(req, {
    igAccountId: '999',
    maxItems: 10,
    fetchAll: true,
    after: 'X',
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    res.items.map((i) => i.id),
    ['after-X', 'after-Y'],
  );
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'X');
  assert.ok(res.note?.includes('same cursor'));
});

test('getMedia keeps inline children only when `children.data` is an array (CC-DATA-66)', async () => {
  // A truthy but malformed edge used to be passed through as `children`, which
  // both skipped the /children fallback in the tool and published a value the
  // output schema rejects. Absent is the honest reading: nothing was listed.
  for (const children of [{ data: 'x' }, { data: {} }, 'x', 7, null]) {
    const { req } = fakeReq(() => ({ id: 'M1', media_type: 'CAROUSEL_ALBUM', children }));

    const detail = await getMedia(req, { mediaId: 'M1' });

    assert.equal(detail.id, 'M1');
    assert.equal('children' in detail, false, `children=${JSON.stringify(children)}`);
  }
});

test('getMedia refuses a body that is not an object instead of throwing a TypeError', async () => {
  for (const body of [null, 'x', [], 7]) {
    const { req } = fakeReq(() => body);
    await assert.rejects(
      () => getMedia(req, { mediaId: 'M1' }),
      (e: unknown) =>
        e instanceof InstagramError &&
        e.kind === 'upstream' &&
        e.message === 'Instagram returned no media object for this id. Retry later.',
      `body=${JSON.stringify(body)}`,
    );
  }
});

test('getMediaChildren accepts only an array `data` and survives a null body (CC-DATA-67)', async () => {
  for (const body of [{ data: 'abc' }, { data: { id: 'c1' } }, null, 'x']) {
    const { req } = fakeReq(() => body);

    const children = await getMediaChildren(req, { mediaId: 'M1' });

    assert.deepEqual(children, [], `body=${JSON.stringify(body)}`);
  }
});

/**
 * Every shape a 200 answer can take once `req` has CAST it instead of validating
 * it, where the page carries no readable listing: a `data` that is an object,
 * `null` or a scalar, and a body that is not an envelope at all. `data: 'abc'`
 * is the quiet one — it is iterable, so it used to become three one-character
 * "items" rather than a crash.
 */
const UNREADABLE_PAGES: readonly unknown[] = [
  { data: { id: '1' } },
  { data: null },
  { data: 'abc' },
  { data: 7 },
  { data: 0 },
  { data: true },
  null,
  'x',
  7,
  [],
];

test('fetchPagedEdge reports an unreadable page as an incomplete read, not a crash or an empty listing (CC-DATA-69)', async () => {
  // A page whose `data` is not a list threw a raw TypeError out of the walk
  // (`data is not iterable`, or `Cannot read properties of null` for a null
  // body), which the registry rendered as an `upstream` failure of the whole
  // listing. Swallowing it into `{ items: [] }` would be worse: that is the
  // exact answer an account with no media gets, so the model would report
  // "nothing here" for a read that never happened. The honest answer is an
  // empty, truncated listing that says why.
  for (const body of UNREADABLE_PAGES) {
    for (const fetchAll of [false, true]) {
      const { req, calls } = fakeReq(() => body);

      const res = await listMedia(req, { igAccountId: '999', maxItems: 200, fetchAll });

      const label = `body=${JSON.stringify(body)} fetchAll=${fetchAll}`;
      assert.equal(calls.length, 1, `one request, no retry loop: ${label}`);
      assert.deepEqual(res.items, [], label);
      assert.equal(res.truncated, true, `an unread page is never a complete listing: ${label}`);
      assert.match(res.note ?? '', /unreadable page/, label);
      // There was no cursor to retry from: the failed page was the first one.
      assert.equal('after' in res, false, label);
    }
  }

  // The contrast that keeps the rule narrow: Graph OMITS `data` on some empty
  // edges (see `listLinkedAccounts treats a response with no data key as no
  // pages`), and that is a read that succeeded with nothing in it.
  const { req } = fakeReq(() => ({}));
  assert.deepEqual(await listMedia(req, { igAccountId: '999', maxItems: 200 }), {
    items: [],
    truncated: false,
  });
});

test('fetchPagedEdge keeps the pages it read and resumes AT an unreadable page, never past it (CC-DATA-70)', async () => {
  // Page 2 is unreadable but advertises a perfectly usable cursor. Following it
  // would silently skip page 2's items; publishing it would hand the caller the
  // same hole. The position that re-reads the failed page is the cursor that
  // REQUESTED it, so that is the one published.
  const { req, calls } = fakeReq((opts) =>
    opts.params?.after === undefined
      ? {
          data: [{ id: '1' }],
          paging: { cursors: { after: 'CUR1' }, next: 'https://graph.facebook.com/next' },
        }
      : {
          data: { id: 'x' },
          paging: { cursors: { after: 'CUR2' }, next: 'https://graph.facebook.com/next' },
        },
  );

  const res = await listMedia(req, { igAccountId: '999', maxItems: 200, fetchAll: true });

  assert.equal(calls.length, 2, 'the cursor on an unreadable page is not followed');
  assert.deepEqual(res.items, [{ id: '1' }]);
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'CUR1');
  assert.match(res.note ?? '', /unreadable page/);

  // The single-page read resumed from a caller's cursor answers the same way:
  // the retry position is the cursor the caller just sent.
  const single = fakeReq(() => ({
    data: 'abc',
    paging: { cursors: { after: 'CUR9' }, next: 'https://graph.facebook.com/next' },
  }));
  const page = await fetchPagedEdge(
    single.req,
    (after) => ({ method: 'GET', path: '/999/media', params: { after } }),
    { maxItems: 200, after: 'CUR5' },
    (m: unknown) => m,
  );
  assert.deepEqual(page.items, []);
  assert.equal(page.truncated, true);
  assert.equal(page.after, 'CUR5');
});

// --- end of listing: `paging.next`, not `paging.cursors.after` (CC-DATA-115) ---
//
// Graph marks the LAST page of an edge by omitting `paging.next`; `cursors` are
// still sent on it (Meta's "Paginated Results" reference, and the inline
// `replies` rule already pinned as CC-COM-15). The hand-written
// `test/fixtures/example-list-comments.json` is exactly that shape: a
// `cursors.after` and no `next`.

const LAST_PAGE_CURSOR = 'SYNTHETIC_OPAQUE_LAST';

test('listMedia publishes no resume cursor for the last page, whose cursors ride along without `next` (CC-DATA-115)', async () => {
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }],
    paging: { cursors: { before: 'B', after: LAST_PAGE_CURSOR } },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 200 });

  assert.deepEqual(res, { items: [{ id: '1' }, { id: '2' }], truncated: false });
});

test('listMedia fetchAll ends on the page without `next` — no extra request, no bogus truncation (CC-DATA-115)', async () => {
  const responder = (opts: IgRequestOptions) => {
    if (opts.params?.after === undefined)
      return {
        data: [{ id: '1' }, { id: '2' }],
        paging: {
          cursors: { after: 'A1' },
          next: 'https://graph.facebook.com/v25.0/999/media?after=A1',
        },
      };
    if (opts.params?.after === 'A1')
      return { data: [{ id: '3' }], paging: { cursors: { after: LAST_PAGE_CURSOR } } };
    throw new Error(`the walk followed a cursor past the last page: ${String(opts.params?.after)}`);
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 200, fetchAll: true });

  assert.equal(calls.length, 2, 'the last page ends the walk');
  assert.deepEqual(res, { items: [{ id: '1' }, { id: '2' }, { id: '3' }], truncated: false });
});

test('listMedia fetchAll whose cap lands exactly on the final page boundary is complete, not truncated (CC-DATA-115)', async () => {
  const responder = (opts: IgRequestOptions) =>
    opts.params?.after === undefined
      ? {
          data: [{ id: '1' }, { id: '2' }],
          paging: { cursors: { after: 'A1' }, next: 'https://graph.facebook.com/next?after=A1' },
        }
      : { data: [{ id: '3' }, { id: '4' }], paging: { cursors: { after: LAST_PAGE_CURSOR } } };
  const { req } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 4, fetchAll: true });

  assert.deepEqual(res, {
    items: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }],
    truncated: false,
  });
});

test('listMedia resumes from the `after` inside `paging.next` when Graph sends no `cursors` (CC-DATA-115)', async () => {
  const responder = (opts: IgRequestOptions) => {
    if (opts.params?.after === undefined)
      return {
        data: [{ id: '1' }],
        paging: { next: 'https://graph.facebook.com/v25.0/999/media?limit=1&after=FROM_URL' },
      };
    if (opts.params?.after === 'FROM_URL') return { data: [{ id: '2' }], paging: {} };
    throw new Error(`unexpected cursor ${String(opts.params?.after)}`);
  };
  const single = await listMedia(fakeReq(responder).req, { igAccountId: '999', maxItems: 200 });
  assert.deepEqual(single, { items: [{ id: '1' }], truncated: false, after: 'FROM_URL' });

  const { req, calls } = fakeReq(responder);
  const all = await listMedia(req, { igAccountId: '999', maxItems: 200, fetchAll: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(all, { items: [{ id: '1' }, { id: '2' }], truncated: false });
});

test('listMedia prefers `cursors.after` over the `after` in `paging.next` (CC-DATA-115)', async () => {
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }],
    paging: { cursors: { after: 'CURSOR' }, next: 'https://graph.facebook.com/next?after=URL' },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 200 });

  assert.equal(res.after, 'CURSOR');
});

test('listMedia reports a `next` it cannot resume from as truncated, never as complete (CC-DATA-115)', async () => {
  // `next` says more remains; with no cursor and no `after` in the URL (a URL
  // paged by some other parameter, or not a URL at all) there is no position to
  // publish. That is the CC-DATA-11 "present but unusable" verdict, not the end.
  for (const next of [
    'https://graph.facebook.com/v25.0/999/media?limit=25&until=1700000000',
    'not a url',
    'https://graph.facebook.com/next?after=',
    42,
    null,
  ]) {
    const single = await listMedia(fakeReq(() => ({ data: [{ id: '1' }], paging: { next } })).req, {
      igAccountId: '999',
      maxItems: 200,
    });
    assert.deepEqual(
      single,
      { items: [{ id: '1' }], truncated: true, note: UNUSABLE_CURSOR_NOTE },
      `single page, next=${String(next)}`,
    );

    const { req, calls } = fakeReq(() => ({ data: [{ id: '1' }], paging: { next } }));
    const all = await listMedia(req, { igAccountId: '999', maxItems: 200, fetchAll: true });
    assert.equal(calls.length, 1, `fetchAll must not re-read page one, next=${String(next)}`);
    assert.deepEqual(all, { items: [{ id: '1' }], truncated: true, note: UNUSABLE_CURSOR_NOTE });
  }
});

test('listMedia refuses a `next` URL that names `after` twice, and never follows a foreign host (CC-DATA-117)', async () => {
  // Which copy of a duplicated parameter a server honours is its own choice, so
  // picking either could resume from a position the link never meant: the
  // duplicate is the CC-DATA-11 "present but unusable" stop.
  for (const next of [
    'https://graph.facebook.com/next?after=A&after=B',
    'https://graph.facebook.com/next?after=A&after=A',
  ]) {
    const { req, calls } = fakeReq(() => ({ data: [{ id: '1' }], paging: { next } }));
    const all = await listMedia(req, { igAccountId: '999', maxItems: 200, fetchAll: true });
    assert.equal(calls.length, 1, next);
    assert.deepEqual(all, { items: [{ id: '1' }], truncated: true, note: UNUSABLE_CURSOR_NOTE });
  }

  // A single `after` is read however odd the link: the URL itself is never
  // requested, and the decoded value travels as one ordinary query parameter to
  // the same edge, so neither the host nor an encoded `&` can steer the request.
  const { req, calls } = fakeReq((opts) =>
    opts.params?.after === undefined
      ? {
          data: [{ id: '1' }],
          paging: { next: 'https://evil.example/x?after=A%26access_token%3DX&limit=9' },
        }
      : { data: [{ id: '2' }], paging: {} },
  );
  const all = await listMedia(req, { igAccountId: '999', maxItems: 200, fetchAll: true });
  assert.deepEqual(all, { items: [{ id: '1' }, { id: '2' }], truncated: false });
  assert.deepEqual(
    { path: calls[1]?.path, host: calls[1]?.host, after: calls[1]?.params?.after },
    { path: calls[0]?.path, host: calls[0]?.host, after: 'A&access_token=X' },
  );
  assert.equal(calls[1]?.params?.limit, calls[0]?.params?.limit, "the link's limit is not adopted");
});

test('listMedia fetchAll stops on a `next`-only edge that keeps naming the same cursor (CC-DATA-115)', async () => {
  const guard = runawayGuard(4);
  const { req, calls } = fakeReq(() => {
    guard();
    return {
      data: [{ id: '1' }],
      paging: { next: 'https://graph.facebook.com/next?after=LOOP' },
    };
  });

  const res = await listMedia(req, { igAccountId: '999', maxItems: 200, fetchAll: true });

  assert.equal(calls.length, 2);
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'LOOP');
  assert.match(res.note ?? '', /same cursor twice/);
});

test('listMedia treats an unusable cursor on the LAST page as the end, not as a broken edge (CC-DATA-115)', async () => {
  // Without `next` the edge is finished; whatever sits in `cursors.after` is
  // then irrelevant, usable or not.
  for (const after of [null, '', 7]) {
    const { req } = fakeReq(() => ({ data: [{ id: '1' }], paging: { cursors: { after } } }));
    const res = await listMedia(req, { igAccountId: '999', maxItems: 200, fetchAll: true });
    assert.deepEqual(res, { items: [{ id: '1' }], truncated: false }, `after=${String(after)}`);
  }
});

test('listMedia tolerates a `paging` that is not an object, and a `cursors: null` beside `next` (CC-DATA-115)', async () => {
  const flat = await listMedia(fakeReq(() => ({ data: [{ id: '1' }], paging: null })).req, {
    igAccountId: '999',
    maxItems: 200,
  });
  assert.deepEqual(flat, { items: [{ id: '1' }], truncated: false });

  const nulled = await listMedia(
    fakeReq(() => ({
      data: [{ id: '1' }],
      paging: { cursors: null, next: 'https://graph.facebook.com/next?after=U' },
    })).req,
    { igAccountId: '999', maxItems: 200 },
  );
  assert.equal(nulled.after, 'U');
});

test('listMedia keeps `cursors.after` authoritative: an unusable one is not replaced by the URL (CC-DATA-115)', async () => {
  // The URL fallback is for a page with NO cursor. A cursor Graph did send and
  // that cannot be used is CC-DATA-11 evidence about this edge, and quietly
  // swapping in another value would hide it.
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }],
    paging: { cursors: { after: '' }, next: 'https://graph.facebook.com/next?after=U' },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 200 });

  assert.deepEqual(res, { items: [{ id: '1' }], truncated: true, note: UNUSABLE_CURSOR_NOTE });
});
