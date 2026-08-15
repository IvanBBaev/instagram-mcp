/**
 * Unit tests for the media api layer (Layer 1). These use a **fake**
 * {@link IgRequestFn} returning canned Graph list/paging payloads — no network,
 * no `mcp`/result dependency — so they run standalone. They cover the
 * pagination cap, cursor handling, carousel-child fetching, and the CC-DATA
 * corner cases owed by T-D2 (CC-DATA-1/2/4/5/6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import { getMedia, getMediaChildren, listMedia } from '../../src/api/media.js';

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

test('listMedia resumes from the supplied cursor instead of restarting page one', async () => {
  // The `after` a truncated read handed back is the caller's ONLY way to
  // continue. Dropping it on the way into the walk silently replays the newest
  // page: a client paging through a 2000-post feed gets the same first 25 posts
  // forever, never reaches the older media, and burns quota doing it — while
  // every response still looks perfectly valid.
  const responder = (opts: IgRequestOptions) => {
    if (opts.params?.after === 'RESUME')
      return { data: [{ id: '3' }, { id: '4' }], paging: { cursors: { after: 'NEXT' } } };
    return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'RESUME' } } };
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

test('listMedia fetchAll caps at maxItems and reports truncated with a resume cursor', async () => {
  const responder = (opts: IgRequestOptions) => {
    const after = opts.params?.after;
    if (after === undefined)
      return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'A1' } } };
    if (after === 'A1')
      return { data: [{ id: '3' }, { id: '4' }], paging: { cursors: { after: 'A2' } } };
    throw new Error(`unexpected cursor ${String(after)}`);
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 3, fetchAll: true });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2', '3'],
  );
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'A2');
  assert.equal(calls.length, 2);
});

test('listMedia fetchAll stopping exactly at the cap with no more data is NOT truncated (CC-DATA-4)', async () => {
  const responder = (opts: IgRequestOptions) => {
    const after = opts.params?.after;
    if (after === undefined)
      return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'A1' } } };
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
      return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'A1' } } };
    if (after === 'A1')
      return { data: [{ id: '3' }, { id: '4' }], paging: { cursors: { after: 'A2' } } };
    throw new Error('unexpected');
  };
  const { req } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 4, fetchAll: true });

  assert.equal(res.items.length, 4);
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'A2');
});

test('listMedia fetchAll keeps a partial result when a cursor goes stale mid-listing (CC-DATA-1)', async () => {
  const responder = (opts: IgRequestOptions) => {
    if (opts.params?.after === undefined)
      return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'A1' } } };
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
      return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'A1' } } };
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
      return { data: [{ id: '1' }], paging: { cursors: { after: 'A1' } } };
    throw 'socket hang up' as unknown as Error;
  });

  await assert.rejects(
    () => listMedia(thrownStringReq, { igAccountId: '999', maxItems: 100, fetchAll: true }),
    (e: unknown) => e === 'socket hang up',
  );
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

test('listMedia fetchAll stops when a page returns no items but still advertises a cursor', async () => {
  // Graph does this for privacy-filtered / deleted items: `data: []` with a live
  // `after`. The cap can then never be reached, so only a progress guard ends it.
  const guard = runawayGuard(6);
  const responder = (opts: IgRequestOptions) => {
    guard();
    const after = opts.params?.after;
    if (after === undefined) return { data: [{ id: '1' }], paging: { cursors: { after: 'A1' } } };
    return { data: [], paging: { cursors: { after: `${String(after)}+` } } };
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
    return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'STUCK' } } };
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
    return { data: [{ id: String(n) }], paging: { cursors: { after: `A${n + 1}` } } };
  };
  const { req, calls } = fakeReq(responder);

  const res = await listMedia(req, { igAccountId: '999', maxItems: 10_000, fetchAll: true });

  assert.equal(calls.length, 50);
  assert.equal(res.items.length, 50);
  assert.equal(res.truncated, true);
  assert.equal(res.after, 'A50');
  assert.ok(res.note?.includes('50 pages'));
});

test('listMedia fetchAll ends the walk on a MISSING cursor, not an empty one', async () => {
  // A page with no `paging.cursors.after` is Graph saying "that was the last
  // page" — the one and only clean end of a walk. Testing for an empty-string
  // cursor instead never matches, so the exhausted page falls through into the
  // progress guards: a complete listing comes back flagged `truncated` with a
  // bogus "same cursor twice" note, and the missing cursor is copied back into
  // `cursor`, restarting the walk at page one until the page ceiling stops it.
  const guard = runawayGuard(6);
  const responder = (opts: IgRequestOptions) => {
    guard();
    if (opts.params?.after === undefined)
      return { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'A1' } } };
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
    paging: { cursors: { after: 'CUR' } },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 2, limit: 25 });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2'],
  );
  assert.equal(res.truncated, true, 'the dropped third item must be admitted');
  assert.equal(res.after, 'CUR', 'and the caller gets a cursor to continue from');
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
    paging: { cursors: { after: 'CUR' } },
  }));

  const res = await listMedia(req, { igAccountId: '999', maxItems: 2.5, limit: 25 });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2'],
  );
  assert.equal(res.truncated, true, 'the dropped third item must be admitted');
  assert.equal(res.after, 'CUR');
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
  assert.equal(calls[0]?.path, '/M1/children');
  assert.equal(calls[0]?.params?.fields, EXPECTED_CHILD_FIELDS);
});

test('getMediaChildren returns an empty array when the edge has no data', async () => {
  const { req } = fakeReq(() => ({}));

  const children = await getMediaChildren(req, { mediaId: 'x' });

  assert.deepEqual(children, []);
});
