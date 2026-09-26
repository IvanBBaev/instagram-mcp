/**
 * Unit tests for the discovery api layer (Layer 1). These use a **fake**
 * {@link IgRequestFn} returning canned Graph payloads — no network, no
 * `mcp`/result dependency — so they run standalone. They assert the Path-B host
 * pin (graph.facebook.com), the exact paths/params (user_id present; the `edge`
 * selecting top vs recent; the business_discovery field spec), the maxItems cap,
 * and CC-DATA-2/6 tolerance.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import { InstagramError } from '../../src/core/types.js';
import {
  BUSINESS_MEDIA_CURSOR_PATTERN,
  INSTAGRAM_USERNAME_PATTERN,
  MEDIA_MORE_NOTE,
  discoverBusiness,
  NO_PROFILE_NOTE,
  getHashtagMedia,
  searchHashtag,
} from '../../src/api/discovery.js';
import { CAP_MID_PAGE_NOTE, UNREADABLE_PAGE_NOTE } from '../../src/api/media.js';

// Every Graph call in this layer goes through the injected IgRequestFn seam, so
// nothing here may open a socket. Poisoning `fetch` for the whole file makes that
// structural rather than aspirational: if this module (or a future refactor of it)
// ever reached for the network directly, the test would die offline instead of
// hitting Meta with the developer's real token — which on these endpoints costs
// more than latency, since every ig_hashtag_search consumes one of the 30 unique
// hashtag slots Meta grants an account per rolling 7 days.
const realFetch = globalThis.fetch;
const forbidFetch: typeof fetch = () => {
  throw new Error('unit tests must not reach the network');
};
globalThis.fetch = forbidFetch;
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
 * The field sets these endpoints must ask Graph for, mirrored from
 * `api/discovery.ts` rather than imported: Graph returns exactly the fields it
 * was asked for and silently omits the rest, so a field dropped from a private
 * constant is never a compile error — it is a discovery tool that quietly stops
 * reporting like counts or permalinks. Kept as arrays because the assertions
 * below read better that way; joined where a request record is pinned whole.
 */
const EXPECTED_HASHTAG_MEDIA_FIELDS = [
  'id',
  'caption',
  'media_type',
  'media_url',
  'permalink',
  'timestamp',
  'like_count',
  'comments_count',
];

/**
 * The single `fields` value `discoverBusiness` builds for `igId: '999'`,
 * `username: 'target'`, `mediaLimit: 10` — pinned character-for-character
 * because it is one interpolated string and every part of it is load bearing.
 */
const EXPECTED_DISCOVERY_FIELD_SPEC =
  'business_discovery.username(target){' +
  'id,username,name,biography,website,followers_count,follows_count,media_count,' +
  'media.limit(10){id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count}}';

// --- searchHashtag ---------------------------------------------------------

test('searchHashtag hits /ig_hashtag_search on graph.facebook.com with user_id and q', async () => {
  const { req, calls } = fakeReq(() => ({ data: [{ id: '17843' }, { id: '17844' }] }));

  const refs = await searchHashtag(req, { igId: '999', query: 'nofilter' });

  assert.deepEqual(
    refs?.map((r) => r.id),
    ['17843', '17844'],
  );
  assert.equal(calls.length, 1);
  // The options object is pinned WHOLE, not method/host/path/params one field at
  // a time. The `Object.keys(...)` check further down already guards the query
  // string against an added parameter, but nothing guarded the record that
  // carries it: `idempotent`, `body` and `signal` are optional on
  // `IgRequestOptions` and are read nowhere in this file. Measured before this
  // equality existed — adding `idempotent: false` to this call in
  // `api/discovery.ts` ran the api, tools and registry suites with 479 tests
  // passing, 0 failures and exit 0. On this endpoint that is worse than it looks:
  // `core/http` retries a rate-limited GET, and every `ig_hashtag_search` spends
  // one of the 30 unique-hashtag slots Meta grants per rolling 7 days, so losing
  // the retry turns a transient 429 into a burned slot and a failed tool call.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/ig_hashtag_search',
    params: { user_id: '999', q: 'nofilter' },
    host: 'graph.facebook.com',
  });
});

test('searchHashtag returns an empty array when Graph omits data', async () => {
  const { req } = fakeReq(() => ({}));
  const refs = await searchHashtag(req, { igId: '999', query: 'x' });
  assert.deepEqual(refs, []);
});

test('searchHashtag forwards the query byte-for-byte and sends nothing but user_id and q', async () => {
  // Normalisation belongs to the tool layer, which strips the "#" and lower-cases
  // — and keys the advisory 30-unique-hashtags/7-days counter on exactly that
  // normalised form. A second, different normalisation down here would make the
  // tag SEARCHED diverge from the tag COUNTED, so the budget would drift out of
  // step with Meta's real ledger and the hard rejection would arrive with the
  // counter still reporting headroom. The api layer therefore stays a
  // pass-through: whatever it was handed is what goes on the wire.
  //
  // The parameter set is pinned in the closed direction too. `ig_hashtag_search`
  // honours `fields`, so an invented one would REPLACE the default selection and
  // drop the `id` that every downstream call (top_media, recent_media) is keyed
  // on; an invented `limit` would cut the id list. Both would break silently, and
  // each attempt spends one of the 30 hashtag slots.
  // Each probe carries a marker for one normalisation that must NOT happen here:
  // a leading "#", a trailing space, mixed case, and leading whitespace.
  for (const query of ['#NoFilter ', '  spaced.tag']) {
    const { req, calls } = fakeReq(() => ({ data: [{ id: '17843' }] }));

    await searchHashtag(req, { igId: '999', query });

    assert.equal(calls[0]?.params?.q, query);
    assert.deepEqual(Object.keys(calls[0]?.params ?? {}).sort(), ['q', 'user_id']);
  }
});

// --- getHashtagMedia -------------------------------------------------------

test('getHashtagMedia top edge reads /top_media with user_id on graph.facebook.com', async () => {
  const { req, calls } = fakeReq(() => ({
    data: [{ id: 'm1', caption: 'hi', media_type: 'IMAGE' }],
    paging: { cursors: { after: 'CUR' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'top',
    maxItems: 200,
    limit: 25,
  });

  assert.equal(res.items.length, 1);
  assert.equal(res.after, 'CUR');
  assert.equal(res.truncated, false);
  // The whole REQUEST is pinned, not a sample of it, and as one record rather
  // than field by field. Two different blind spots are closed by the one
  // equality. The field set: `id` is what every follow-up depends on (fetch the
  // media, read its comments, build a permalink), and dropping it yields a page
  // of captions nothing can act on. The record around it: `idempotent`, `body`
  // and `signal` are optional on `IgRequestOptions` and appear nowhere in this
  // file, so a key added beside `params` was unobservable — measured, adding
  // `idempotent: false` to this call in `api/discovery.ts` left 479 tests
  // passing with 0 failures and exit 0. `after` is written out with an explicit
  // `undefined` because that is the literal shape a first, uncontinued page
  // builds and deepEqual compares own keys; naming it is what makes the pin fail
  // if the key ever stops being sent, as well as if a `before` appears next to it.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/H1/top_media',
    params: {
      user_id: '999',
      fields: EXPECTED_HASHTAG_MEDIA_FIELDS.join(','),
      limit: 25,
      after: undefined,
    },
    host: 'graph.facebook.com',
  });
});

test('getHashtagMedia issues a GET and sends exactly user_id, fields, limit and after', async () => {
  // The method is not decoration: `core/http` derives idempotency from it
  // (`idempotent ?? method === 'GET'`), so a read issued as POST or DELETE is
  // dropped out of the retry path. A 429 or a 500 that the backoff would have
  // ridden out then surfaces as a hard tool failure — and on a hashtag edge the
  // retry is the cheap half, since the expensive part (the id lookup) is already
  // paid for out of the 30-slot weekly budget.
  //
  // The parameter set is pinned both ways. `limit` must stay UNDEFINED when the
  // caller passed none: inventing a page size caps every page at that number no
  // matter how high IG_MAX_ITEMS is, and because the page then arrives already
  // short, `truncated` stays false — the operator is told the answer is complete
  // while receiving a fraction of it. And no extra key may appear: `before`
  // alongside `after` is a self-contradictory page request that Graph resolves in
  // an undocumented direction, so paging silently walks backwards or repeats.
  const { req, calls } = fakeReq(() => ({ data: [] }));

  await getHashtagMedia(req, { hashtagId: 'H1', igId: '999', edge: 'top', maxItems: 200 });

  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.params?.limit, undefined);
  assert.deepEqual(Object.keys(calls[0]?.params ?? {}).sort(), [
    'after',
    'fields',
    'limit',
    'user_id',
  ]);
});

test('getHashtagMedia recent edge reads /recent_media', async () => {
  const { req, calls } = fakeReq(() => ({ data: [{ id: 'm2', media_type: 'VIDEO' }] }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H2',
    igId: '999',
    edge: 'recent',
    maxItems: 200,
  });

  assert.equal(res.items[0]?.id, 'm2');
  // CC-DATA-2: fields Meta omits stay undefined.
  assert.equal(res.items[0]?.caption, undefined);
  assert.equal(calls[0]?.path, '/H2/recent_media');
});

test('getHashtagMedia caps the page at maxItems and marks it truncated', async () => {
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }, { id: '3' }],
    paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'top',
    maxItems: 2,
  });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2'],
  );
  assert.equal(res.truncated, true);
  // The cursor is withheld on a truncated page: 'NEXT' points past item 3, which
  // the cap just dropped, so returning it would let the caller skip it silently.
  assert.equal(res.after, undefined);
  // And the stop is explained with the same words `fetchPagedEdge` uses for the
  // same stop, so the hashtag walk reads like every other paged listing.
  assert.equal(res.note, CAP_MID_PAGE_NOTE);
});

test('getHashtagMedia withholds the cursor when the cap cut the page mid-way', async () => {
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }],
    paging: { cursors: { after: 'PAST_ITEM_4' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'recent',
    maxItems: 2,
  });

  // Items 3 and 4 arrived but were cut. A Graph cursor addresses a page
  // boundary, so 'PAST_ITEM_4' cannot resume from item 3 — handing it back would
  // lose those two items with no signal. `truncated` alone is the honest answer.
  assert.equal(res.truncated, true);
  assert.equal(res.after, undefined);
  assert.equal(Object.hasOwn(res, 'after'), false);
});

test('getHashtagMedia within the cap returns the page in Graph order and is not truncated', async () => {
  // Order is the entire product of these two edges — `top_media` is ranked by
  // engagement, `recent_media` by recency — and neither item carries a rank or a
  // sortable key the caller could use to rebuild it. Handing the page back
  // re-ordered would answer "the top posts for #x" with the weakest of them, and
  // nothing downstream could tell: the tool layer only fences captions, and the
  // model has no independent view of Instagram to check against.
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }, { id: '3' }],
    paging: {},
  }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'recent',
    maxItems: 5,
  });

  assert.deepEqual(
    res.items.map((i) => i.id),
    ['1', '2', '3'],
  );
  assert.equal(res.truncated, false);
  assert.equal(res.after, undefined);
});

test('getHashtagMedia treats a page exactly at the cap as complete, not truncated', async () => {
  // The boundary case decides whether paging can continue at all. A page whose
  // length EQUALS the cap lost nothing, so it is complete and its cursor is
  // safe to hand back. Calling it truncated would also withhold that cursor —
  // and a caller that asked for exactly `maxItems` per page (the normal way to
  // page) would then stop after page one, silently losing every later page.
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }],
    paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'top',
    maxItems: 2,
  });

  assert.equal(res.items.length, 2);
  assert.equal(res.truncated, false);
  assert.equal(res.after, 'NEXT');
});

test('getHashtagMedia floors a fractional maxItems and clamps a negative one to zero', async () => {
  // `maxItems` is the resolved IG_MAX_ITEMS and reaches here as a plain number.
  // Rounding UP would return one item more than the operator's cap allows.
  // Failing to clamp a negative is worse than a bad count: `slice(0, -1)` drops
  // the LAST item and keeps the rest, so the caller gets a quietly incomplete
  // page rather than an obvious empty one.
  const page = () => ({
    data: [{ id: '1' }, { id: '2' }, { id: '3' }],
    paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' },
  });

  const fractional = await getHashtagMedia(fakeReq(page).req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'top',
    maxItems: 2.9,
  });
  assert.deepEqual(
    fractional.items.map((i) => i.id),
    ['1', '2'],
  );
  assert.equal(fractional.truncated, true);

  const negative = await getHashtagMedia(fakeReq(page).req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'top',
    maxItems: -1,
  });
  assert.deepEqual(negative.items, []);
  assert.equal(negative.truncated, true);
  assert.equal(negative.after, undefined);
});

test('getHashtagMedia forwards the after cursor so a returned page can be continued', async () => {
  const { req, calls } = fakeReq(() => ({ data: [{ id: 'm3' }], paging: { cursors: {} } }));

  await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'recent',
    maxItems: 200,
    after: 'CURSOR_FROM_PAGE_1',
  });

  assert.equal(calls[0]?.params?.after, 'CURSOR_FROM_PAGE_1');
});

test('getHashtagMedia hands back the cursor Graph just returned, not the one it was given', async () => {
  // Paging only terminates because each page yields a NEW position. Echoing the
  // caller's own `after` back out would make the next call re-read the same page,
  // which returns the same cursor, forever — an unbounded loop that looks like
  // healthy paging from the outside while it drains the app's rate-limit budget
  // and re-emits the same media into the model's context on every turn.
  const { req } = fakeReq(() => ({
    data: [{ id: 'm5' }],
    paging: { cursors: { after: 'CURSOR_FOR_PAGE_3' }, next: 'https://graph.facebook.com/next' },
  }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'recent',
    maxItems: 200,
    after: 'CURSOR_FOR_PAGE_2',
  });

  assert.equal(res.after, 'CURSOR_FOR_PAGE_3');
});

const UNUSABLE_CURSOR_NOTE =
  'the edge returned an unusable cursor (no way to continue) — the listing may be incomplete';

test('getHashtagMedia reports an unusable cursor as a truncated page with a note, never as end-of-results', async () => {
  // Withholding `after` used to be this function's ONLY end-of-stream signal, so
  // a present-but-unusable cursor had to be passed through as sent — dropping it
  // would have claimed "no next page", a statement Graph never made. The tool
  // layer then withheld it anyway and published `truncated: false`, so the model
  // was told the listing was complete. The page now says what `fetchPagedEdge`
  // says for the same stop (CC-DATA-11): truncated, with the reason, and no
  // cursor the tool's own `after` input would reject. A falsy-but-PRESENT value
  // is the load-bearing fixture (CC-PROC-46): a plain truthiness test on the
  // cursor would read '' as the end of the hashtag's media.
  for (const after of ['', null, 42]) {
    const { req } = fakeReq(() => ({
      data: [{ id: 'm1' }],
      paging: { cursors: { after }, next: 'https://graph.facebook.com/next' },
    }));

    const res = await getHashtagMedia(req, {
      hashtagId: 'H1',
      igId: '999',
      edge: 'recent',
      maxItems: 200,
    });

    assert.deepEqual(res, { items: [{ id: 'm1' }], truncated: true, note: UNUSABLE_CURSOR_NOTE });
  }
});

test('getHashtagMedia treats a body with no data key as an empty page (CC-DATA-2)', async () => {
  // Graph omits `data` entirely for an edge it has nothing to return — most
  // often a fresh hashtag whose 24-hour `recent_media` window is empty. Reading
  // `.length` off the missing array would throw a TypeError from inside the api
  // layer, turning "no posts yet" into an unknown-error tool failure.
  const { req } = fakeReq(() => ({}));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'recent',
    maxItems: 25,
  });

  assert.deepEqual(res, { items: [], truncated: false });
});

test('getHashtagMedia reports a present non-list data or a non-object body as an unreadable page, never invented (CC-DATA-80)', async () => {
  // Only a MISSING `data` key is an empty edge (the test above). A `data` that is
  // present but not a list — `null` included — or a body that is not an object
  // at all is a page this reader could not read. It used to flow on untouched: a
  // `null` became an empty page that read as "no posts under this tag", a string
  // longer than the cap was sliced into a substring and reported with
  // CAP_MID_PAGE_NOTE — a cap stop that never happened — and a non-object body
  // threw a raw TypeError on `.data`. Now nothing of it is handed on, the page is
  // marked incomplete with UNREADABLE_PAGE_NOTE (the same words and the same rule
  // as `fetchPagedEdge` in `api/media.ts`), and the cursor the page advertises is
  // withheld so resuming cannot skip the unread page without a trace — even a
  // perfectly usable one.
  //
  // Measured 2026-09-23: replacing `res.data ?? []` with a three-way that
  // fabricates `[{ id: 'injected-by-mutation' }]` for anything non-list passed
  // every test in this file and died only on the tool layer's `Array.isArray`
  // fence — the layer above judging this layer's output. The rule that a reader
  // hands back nothing of its own making is stated here, where the reader is
  // (CC-PROC-182, CC-PROC-192).
  const bodies: unknown[] = [
    { data: null, paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' } },
    {
      data: { unexpected: 'not a list' },
      paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' },
    },
    {
      data: 'x'.repeat(40),
      paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' },
    },
    { data: 7, paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' } },
    { data: true, paging: { cursors: { after: 'NEXT' }, next: 'https://graph.facebook.com/next' } },
    null,
    'not an object',
    [{ id: 'm1' }],
  ];
  for (const body of bodies) {
    const odd = fakeReq(() => body);
    const first = await getHashtagMedia(odd.req, {
      hashtagId: 'H1',
      igId: '999',
      edge: 'top',
      maxItems: 25,
    });

    assert.deepStrictEqual(
      first,
      { items: [], truncated: true, note: UNREADABLE_PAGE_NOTE },
      `body ${JSON.stringify(body)}`,
    );

    // On a later page, the cursor that REQUESTED the unreadable page is handed
    // back as `after`, so the caller can retry exactly that page.
    const later = await getHashtagMedia(odd.req, {
      hashtagId: 'H1',
      igId: '999',
      edge: 'recent',
      maxItems: 25,
      after: 'PREV',
    });

    assert.deepStrictEqual(
      later,
      { items: [], after: 'PREV', truncated: true, note: UNREADABLE_PAGE_NOTE },
      `body ${JSON.stringify(body)} from a cursor`,
    );
  }
});

test('searchHashtag answers null for any data that is not a list, never no match (CC-DATA-81)', async () => {
  // Only a missing `data` is "no match" (the omitted-data test above). A `null`
  // `data` used to be defaulted to `[]` by `??`, which the tool then reported as
  // an empty `ids` — "no such hashtag" — while the budget slot was spent. It now
  // reaches the tool as `null`, and so does any other `data` that is not a list
  // and a body that is not an object (which used to throw a raw TypeError on
  // `.data`), so the tool can say the search was unreadable.
  for (const body of [{ data: null }, null, 'not an object', [{ id: 'h1' }]]) {
    const { req } = fakeReq(() => body);
    const refs = await searchHashtag(req, { igId: '999', query: 'x' });
    assert.equal(refs, null, `body ${JSON.stringify(body)}`);
  }
  for (const data of [{ unexpected: 'not a list' }, 'h1', 0]) {
    const { req } = fakeReq(() => ({ data }));
    assert.equal(await searchHashtag(req, { igId: '999', query: 'x' }), null);
  }
});

test('getHashtagMedia omits after when no cursor is supplied', async () => {
  const { req, calls } = fakeReq(() => ({ data: [] }));

  await getHashtagMedia(req, { hashtagId: 'H1', igId: '999', edge: 'top', maxItems: 200 });

  assert.equal(calls[0]?.params?.after, undefined);
});

// --- discoverBusiness ------------------------------------------------------

test('discoverBusiness reads /{ig-id} on graph.facebook.com with the business_discovery field spec', async () => {
  const { req, calls } = fakeReq(() => ({
    id: '999',
    business_discovery: {
      id: '555',
      username: 'target',
      name: 'Target Co',
      biography: 'we make things',
      website: 'https://target.example',
      followers_count: 1000,
      follows_count: 12,
      media_count: 42,
      media: { data: [{ id: 'p1', caption: 'a post', media_type: 'IMAGE' }] },
    },
  }));

  const biz = await discoverBusiness(req, { igId: '999', username: 'target', mediaLimit: 10 });

  // The WHOLE mapped object, not a sample of it. The field expression asserted
  // below asks Graph for eight profile fields; a sampled check proves the ask
  // but not the mapping, so a field could be requested (and paid for in quota)
  // and then silently dropped on the way out — which is exactly what happened
  // to `follows_count` and `website` before this became an equality check.
  assert.deepStrictEqual(biz, {
    id: '555',
    username: 'target',
    name: 'Target Co',
    biography: 'we make things',
    website: 'https://target.example',
    followers_count: 1000,
    follows_count: 12,
    media_count: 42,
    media: [{ id: 'p1', caption: 'a post', media_type: 'IMAGE' }],
    mediaPaging: { truncated: false },
  });

  // The request is pinned as one whole record. `fields` is the ONLY query
  // parameter, and that exclusivity is the point: the whole ask lives inside
  // that one interpolated string, so a second key would open an unpinned channel
  // that changes what Graph returns — a top-level `limit` or `user_id` next to a
  // `business_discovery` field expression is at best ignored and at worst
  // reinterpreted. The string itself is pinned character-for-character because
  // every part of it is load bearing: the nested `media.limit(<cap>)` bounds the
  // quota this one call spends, and `biography`/`website` are the fields the
  // discovery tool is actually for; a sampled `includes()` check would let any
  // of them silently drop out.
  //
  // What the old per-field reads could NOT see was a key added to the options
  // object itself. `idempotent`, `body` and `signal` are optional on
  // `IgRequestOptions` and are asserted nowhere in this file: measured, adding
  // `idempotent: false` to this call in `api/discovery.ts` ran 479 tests with
  // 0 failures and exit 0. This is the most expensive read in the module — one
  // call fetches a profile plus `mediaLimit` media objects — so dropping its
  // 429/5xx retry converts an ordinary throttle into a failed discovery.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/999',
    params: { fields: EXPECTED_DISCOVERY_FIELD_SPEC },
    host: 'graph.facebook.com',
  });
});

test('discoverBusiness floors a fractional mediaLimit and clamps a negative one to zero', async () => {
  // `mediaLimit` reaches here from a tool argument, so it can be any number the
  // schema admits. It is interpolated into `media.limit(<cap>)`, and Graph reads
  // that literally: `limit(-5)` is a malformed request, `limit(10.5)` likewise.
  // Rounding UP would also spend more quota than the resolved IG_MAX_ITEMS
  // allows — the cap has to floor, not ceil.
  const { req: fractionalReq, calls: fractionalCalls } = fakeReq(() => ({ id: '999' }));
  await discoverBusiness(fractionalReq, { igId: '999', username: 'target', mediaLimit: 9.7 });
  assert.ok(String(fractionalCalls[0]?.params?.fields).includes('media.limit(9){'));

  const { req: negativeReq, calls: negativeCalls } = fakeReq(() => ({ id: '999' }));
  await discoverBusiness(negativeReq, { igId: '999', username: 'target', mediaLimit: -5 });
  assert.ok(String(negativeCalls[0]?.params?.fields).includes('media.limit(0){'));

  // ...and a large ask reaches Graph intact. The tool layer has already bounded
  // this by the resolved IG_MAX_ITEMS, so a second, hidden ceiling here would
  // fetch a fraction of what the operator's own cap permits — and unlike
  // getHashtagMedia, `discoverBusiness` returns no `truncated` flag, so the
  // shortfall would be indistinguishable from a competitor who simply posts
  // rarely. Competitive analysis built on that reads as fact.
  const { req: wideReq, calls: wideCalls } = fakeReq(() => ({ id: '999' }));
  await discoverBusiness(wideReq, { igId: '999', username: 'target', mediaLimit: 100 });
  assert.ok(String(wideCalls[0]?.params?.fields).includes('media.limit(100){'));
});

test('discoverBusiness says so when Graph answers without a business_discovery object (CC-DATA-79)', async () => {
  // A 200 with the block missing used to become a record of eight `undefined`
  // fields, which the all-optional output schema accepts and a caller reads as
  // "this account exists and discloses nothing". Meta answers an unknown,
  // private or personal handle with an error, so an answer with no profile in it
  // is malformed. `null`, an array and a scalar are the same absence spelled by
  // a cast body. The result is the note and NOTHING else — not even keys holding
  // `undefined` — and the note does not echo the untrusted handle.
  //
  // The envelope still carries `id: '999'` — the OPERATOR's own node id, which
  // Graph always echoes. It must not be laundered into a discovered profile: a
  // `bd.id ?? wire.id` fallback would report the operator's own account as the
  // handle that was looked up.
  for (const block of [undefined, null, [], 'ghost', 0]) {
    const { req } = fakeReq(() =>
      block === undefined ? { id: '999' } : { id: '999', business_discovery: block },
    );
    const biz = await discoverBusiness(req, { igId: '999', username: 'ghost', mediaLimit: 5 });
    assert.deepStrictEqual(biz, { note: NO_PROFILE_NOTE }, `block ${JSON.stringify(block)}`);
  }
  assert.equal(NO_PROFILE_NOTE.includes('ghost'), false);

  // CC-DATA-106: the same absence one level up. `core/http` hands back a JSON
  // `null` body as `null` (the cast does not validate it), and reading
  // `business_discovery` off it threw a raw TypeError that surfaced as an
  // internal error instead of the note. A whole body that is not an object is
  // no profile either.
  for (const body of [null, [], 'ghost', 0]) {
    const { req } = fakeReq(() => body);
    const biz = await discoverBusiness(req, { igId: '999', username: 'ghost', mediaLimit: 5 });
    assert.deepStrictEqual(biz, { note: NO_PROFILE_NOTE }, `body ${JSON.stringify(body)}`);
  }

  // An EMPTY block is still a profile object — Meta's to fill — and passes
  // through as one with no note: nothing is invented and `media` stays ABSENT,
  // not present-and-undefined (an own key in `structuredContent` claims the edge
  // was fetched and came back empty).
  const biz = await discoverBusiness(fakeReq(() => ({ id: '999', business_discovery: {} })).req, {
    igId: '999',
    username: 'ghost',
    mediaLimit: 5,
  });
  assert.deepStrictEqual(biz, {
    id: undefined,
    username: undefined,
    name: undefined,
    biography: undefined,
    website: undefined,
    followers_count: undefined,
    follows_count: undefined,
    media_count: undefined,
  });
  assert.equal(Object.hasOwn(biz, 'media'), false);
});

test('discoverBusiness passes the media edge through verbatim and keeps an undisclosed edge absent', async () => {
  // Two independent facts about the same edge.
  //
  // (a) The bound is expressed in the ASK — `media.limit(<cap>)` — so whatever
  // Graph sends back is handed on unchanged and in order. Re-cutting the array
  // here would silently discard posts, and `discoverBusiness` has no `truncated`
  // channel to report it; re-ordering it would destroy the recency ordering that
  // makes "their latest posts" mean anything. A payload that over-delivers is the
  // only way to see either: with `mediaLimit: 1` a client-side re-cap is
  // invisible whenever Graph happens to obey.
  const overDelivering = await discoverBusiness(
    fakeReq(() => ({
      business_discovery: {
        username: 'target',
        media: { data: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] },
      },
    })).req,
    { igId: '999', username: 'target', mediaLimit: 1 },
  );
  assert.deepStrictEqual(overDelivering.media, [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]);

  // (b) A `media` wrapper with no `data` is Meta declining to disclose the edge
  // (a private or non-business account), not an account with zero posts. The
  // result must then carry NO `media` key at all: this object leaves as MCP
  // `structuredContent`, where an own key — even one holding `undefined` — is a
  // positive claim that the edge was fetched and came back empty. Testing the
  // wrapper's truthiness instead of its `data` makes exactly that wrong claim.
  const undisclosed = await discoverBusiness(
    fakeReq(() => ({ business_discovery: { username: 'target', media: {} } })).req,
    { igId: '999', username: 'target', mediaLimit: 10 },
  );
  assert.equal(Object.hasOwn(undisclosed, 'media'), false);

  // (c) The same verdict for an EXPLICIT null edge, which is the other spelling
  // of the same refusal and the one the type declaration does not admit exists.
  // `media?: DiscoveredMedia[]` says the key is absent or an array; a wire
  // `data: null` is neither, and the only thing standing between it and a
  // `media: null` in `structuredContent` is that the guard tests truthiness
  // rather than `!== undefined`. Weakened to the latter it publishes the null,
  // and every consumer that reasonably wrote `biz.media?.length` — the type says
  // it may do exactly that — gets `undefined` instead of a crash, so the loss is
  // silent. Pinned because the wire shape is Meta's to change, not ours.
  const nulled = await discoverBusiness(
    fakeReq(() => ({ business_discovery: { username: 'target', media: { data: null } } })).req,
    { igId: '999', username: 'target', mediaLimit: 10 },
  );
  assert.equal(Object.hasOwn(nulled, 'media'), false);
});

test('discoverBusiness flags a media edge nothing can read instead of reading it as undisclosed (CC-DATA-87)', async () => {
  // Three verdicts, each pinned on the whole result so a stray `media` or flag
  // key fails too: a list under `data` is the edge; no edge, no `data` and the
  // explicit `null` for either are Meta declining to disclose it; everything
  // else — the falsy non-lists a truthiness test used to wave through included
  // — is flagged `mediaUnreadable` with no `media` key.
  const run = (media: unknown): Promise<unknown> =>
    discoverBusiness(fakeReq(() => ({ business_discovery: { id: 'B1', media } })).req, {
      igId: '999',
      username: 'target',
      mediaLimit: 10,
    });
  const base = {
    id: 'B1',
    username: undefined,
    name: undefined,
    biography: undefined,
    website: undefined,
    followers_count: undefined,
    follows_count: undefined,
    media_count: undefined,
  };
  for (const media of [undefined, null, {}, { data: null }]) {
    assert.deepStrictEqual(await run(media), base, JSON.stringify(media));
  }
  assert.deepStrictEqual(await run({ data: [{ id: 'p1' }] }), {
    ...base,
    media: [{ id: 'p1' }],
    mediaPaging: { truncated: false },
  });
  for (const media of [
    { data: '' },
    { data: 0 },
    { data: false },
    { data: 'p1' },
    { data: { id: 'p1' } },
    0,
    '',
    false,
    true,
    'p1',
    [],
    [{ id: 'p1' }],
  ]) {
    assert.deepStrictEqual(
      await run(media),
      { ...base, mediaUnreadable: true },
      JSON.stringify(media),
    );
  }
});

test('discoverBusiness passes falsy-but-present counts and an empty media edge through as themselves (CC-PROC-46)', async () => {
  // A brand-new business account is exactly this payload: zero followers, zero
  // follows, zero posts, an empty biography and website, and a `media` edge that
  // was disclosed and holds nothing. Every one of those is a positive fact about
  // the account, and each is falsy. A mapping that "tidies" them — `|| undefined`
  // on a count, `?.length` on the media array — turns "zero followers" into "not
  // disclosed" and "no posts yet" into "the edge was withheld", and the two are
  // opposite answers to the competitive question this tool exists to ask: an
  // account with 0 followers is a fresh account, one whose count is undisclosed
  // is one Graph would not describe. Whole-object equality, so a dropped key and
  // a key holding `undefined` both fail.
  const { req } = fakeReq(() => ({
    business_discovery: {
      id: '17841400000000000',
      username: 'brand_new',
      name: '',
      biography: '',
      website: '',
      followers_count: 0,
      follows_count: 0,
      media_count: 0,
      media: { data: [] },
    },
  }));

  const biz = await discoverBusiness(req, { igId: '999', username: 'brand_new', mediaLimit: 10 });

  assert.deepStrictEqual(biz, {
    id: '17841400000000000',
    username: 'brand_new',
    name: '',
    biography: '',
    website: '',
    followers_count: 0,
    follows_count: 0,
    media_count: 0,
    media: [],
    mediaPaging: { truncated: false },
  });
  assert.equal(Object.hasOwn(biz, 'media'), true, 'an empty media array is still a disclosed edge');
});

test('discoverBusiness reports the nested media edge truncated with a resume cursor instead of dropping its paging (CC-DATA-116)', async () => {
  // business_discovery's field-expanded `media` edge sends `paging.cursors`
  // and no `next` link. Before the fix the whole `paging` object was dropped,
  // so a capped media list read as the account's complete output.
  const run = (paging: unknown): Promise<{ mediaPaging?: unknown }> =>
    discoverBusiness(
      fakeReq(() => ({ business_discovery: { id: 'B1', media: { data: [{ id: 'p1' }], paging } } }))
        .req,
      { igId: '999', username: 'target', mediaLimit: 1 },
    );

  // No cursor at all: nothing says more exists.
  for (const paging of [undefined, null, {}, { cursors: {} }, { cursors: null }]) {
    assert.deepStrictEqual(
      (await run(paging)).mediaPaging,
      { truncated: false },
      JSON.stringify(paging),
    );
  }
  // A usable `cursors.after` is the resume point, whatever `next` says.
  assert.deepStrictEqual(
    (await run({ cursors: { before: 'QVFB', after: 'QVFIUm-_x+/=' } })).mediaPaging,
    { after: 'QVFIUm-_x+/=', truncated: true, note: MEDIA_MORE_NOTE },
  );
  assert.deepStrictEqual(
    (await run({ cursors: { after: 'CUR' }, next: 'https://graph.facebook.com/x?after=OTHER' }))
      .mediaPaging,
    { after: 'CUR', truncated: true, note: MEDIA_MORE_NOTE },
  );
  // No `cursors.after` but a `next` link: its `after` is the resume point.
  assert.deepStrictEqual(
    (await run({ next: 'https://graph.facebook.com/x?after=FROMNEXT' })).mediaPaging,
    { after: 'FROMNEXT', truncated: true, note: MEDIA_MORE_NOTE },
  );
  // A cursor that is present but cannot be sent back inside the field
  // expression: truncated, with no `after` to follow (CC-DATA-11).
  for (const after of [null, '', 7, 'a b', 'a)', 'a{b}', 'a,b', 'x'.repeat(2049)]) {
    assert.deepStrictEqual(
      (await run({ cursors: { after } })).mediaPaging,
      { truncated: true, note: UNUSABLE_CURSOR_NOTE },
      JSON.stringify(after).slice(0, 40),
    );
  }
  assert.equal(BUSINESS_MEDIA_CURSOR_PATTERN.test('x'.repeat(2048)), true);
  // Pinned verbatim: the note is the model-facing half of the contract.
  assert.equal(
    MEDIA_MORE_NOTE,
    'Instagram returned a media cursor, so more media may exist beyond this page ' +
      '(business_discovery sends no next link that would say it is the last one) — pass ' +
      'mediaPaging.after as mediaAfter to read further; an empty media list there means the end',
  );
});

test('discoverBusiness resumes the nested media edge with media.after(cursor) (CC-DATA-116)', async () => {
  const { req, calls } = fakeReq(() => ({ business_discovery: { id: 'B1', media: { data: [] } } }));

  const biz = await discoverBusiness(req, {
    igId: '999',
    username: 'target',
    mediaLimit: 5,
    mediaAfter: 'QVFI-_+/=',
  });

  assert.deepStrictEqual(biz.mediaPaging, { truncated: false });
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/999',
    params: {
      fields: EXPECTED_DISCOVERY_FIELD_SPEC.replace(
        'media.limit(10)',
        'media.after(QVFI-_+/=).limit(5)',
      ),
    },
    host: 'graph.facebook.com',
  });
});

test('discoverBusiness refuses a mediaAfter that would rewrite the field expression, without echoing it (CC-DATA-116)', async () => {
  for (const mediaAfter of ['', 'a)', 'a).limit(500', 'a{b}', 'a,b', 'a b', 'x'.repeat(2049)]) {
    const { req, calls } = fakeReq(() => ({}));
    await assert.rejects(
      discoverBusiness(req, { igId: '999', username: 'target', mediaLimit: 5, mediaAfter }),
      (err: unknown) => {
        assert.ok(err instanceof InstagramError);
        assert.equal(err.kind, 'validation');
        assert.equal(
          err.message,
          'Invalid mediaAfter cursor: pass back the mediaPaging.after a previous call returned.',
        );
        return true;
      },
      JSON.stringify(mediaAfter).slice(0, 40),
    );
    assert.equal(calls.length, 0);
  }
});

test('discoverBusiness refuses a username that would rewrite the Graph field expression', async () => {
  // Each payload closes the `username(` call and appends its own selection —
  // extra fields off the OPERATOR's node, or an inflated media.limit() burning
  // quota. Graph field expressions cannot be escaped, so these must be rejected.
  //
  // The list deliberately includes every character class the expression grammar
  // gives meaning to, not just the ones that appear in a finished exploit: `(`
  // and `{` OPEN a call and a selection set, `-` is the range operator inside a
  // metric spec, and leading/trailing whitespace is how a payload gets past a
  // pattern that was anchored loosely. Admitting any one of them turns the
  // allowlist into a filter that blocks only the exploit already seen; the next
  // one is assembled from whatever is still permitted. Whitespace is also the
  // reason the value is validated AS GIVEN rather than trimmed first: trimming
  // and then validating means the string checked is not the string interpolated.
  const payloads = [
    'x){id,username},followers_count.limit(0){',
    'target){id},media.limit(9999){id',
    'username(target',
    'media{id}',
    'a,b',
    'a)',
    'na-sa',
    '@target',
    'has space',
    ' target',
    'target ',
    ' target ',
    'ünïcode',
    '',
    'x'.repeat(31),
  ];

  for (const username of payloads) {
    const { req, calls } = fakeReq(() => ({ id: '999' }));
    await assert.rejects(
      () => discoverBusiness(req, { igId: '999', username, mediaLimit: 10 }),
      (err: unknown) => {
        assert.ok(err instanceof InstagramError, `expected an InstagramError for "${username}"`);
        assert.equal(err.kind, 'validation');
        // Pinned word for word, and identical for every payload. This string is
        // the entire repair instruction the model gets back: it has no other view
        // of Instagram's handle rules, so whatever the text says is what it will
        // retry with. Softening the stated bound ("up to 30", "1-40") or dropping
        // the "no leading @" / "no brackets" clauses sends it round the same
        // rejection again with a handle built to the wrong rule — a turn burned
        // per attempt. Asserting equality across the whole payload list also
        // proves the negative: no branch of the message varies with the input, so
        // there is no path by which the untrusted string reaches the log.
        assert.equal(
          err.message,
          'Invalid Instagram username: expected 1-30 characters, letters/digits/"."/"_" only ' +
            '(no leading "@", no spaces, no brackets or parentheses).',
        );
        // The rejection is actionable but never echoes the untrusted payload —
        // error text lands in logs and back in model context.
        if (username.length > 0) {
          assert.equal(
            err.message.includes(username),
            false,
            'the rejection must not echo the raw payload',
          );
        }
        return true;
      },
    );
    // Rejected before the request — no quota spent on a poisoned query.
    assert.equal(calls.length, 0);
  }
});

test('discoverBusiness accepts ordinary handles (letters, digits, dot, underscore)', async () => {
  for (const username of ['target', 'a', 'nasa.gov_2024', 'A_B.c9', 'x'.repeat(30)]) {
    const { req, calls } = fakeReq(() => ({ id: '999' }));
    await discoverBusiness(req, { igId: '999', username, mediaLimit: 10 });
    assert.ok(
      String(calls[0]?.params?.fields).includes(`business_discovery.username(${username})`),
    );
  }
});

test('INSTAGRAM_USERNAME_PATTERN is anchored so a payload cannot hide behind a valid prefix', () => {
  assert.equal(INSTAGRAM_USERNAME_PATTERN.test('target'), true);
  assert.equal(INSTAGRAM_USERNAME_PATTERN.test('target){id}'), false);
  assert.equal(INSTAGRAM_USERNAME_PATTERN.test('target\nevil'), false);
});

// --- end of listing: `paging.next`, not `paging.cursors.after` (CC-DATA-115) ---

test('getHashtagMedia publishes no cursor for the last page, whose cursors ride along without `next` (CC-DATA-115)', async () => {
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }],
    paging: { cursors: { before: 'B', after: 'SYNTHETIC_OPAQUE_LAST' } },
  }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'top',
    maxItems: 5,
  });

  assert.deepEqual(res, { items: [{ id: '1' }], truncated: false });
});

test('getHashtagMedia treats an unusable cursor on the last page as the end (CC-DATA-115)', async () => {
  const { req } = fakeReq(() => ({ data: [{ id: '1' }], paging: { cursors: { after: '' } } }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'top',
    maxItems: 5,
  });

  assert.deepEqual(res, { items: [{ id: '1' }], truncated: false });
});

test('getHashtagMedia resumes from the `after` inside a `next`-only paging block (CC-DATA-115)', async () => {
  // Hashtag edges may page by `next` URL alone; the cursor it carries is the
  // resume position the tool's `after` input accepts.
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }],
    paging: { next: 'https://graph.facebook.com/v25.0/H1/top_media?user_id=999&after=URL_CUR' },
  }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'top',
    maxItems: 5,
  });

  assert.deepEqual(res, { items: [{ id: '1' }], truncated: false, after: 'URL_CUR' });
});

test('getHashtagMedia reports a `next` with no resumable cursor as truncated, not complete (CC-DATA-115)', async () => {
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }],
    paging: { next: 'https://graph.facebook.com/v25.0/H1/top_media?user_id=999' },
  }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'top',
    maxItems: 5,
  });

  assert.deepEqual(res, { items: [{ id: '1' }], truncated: true, note: UNUSABLE_CURSOR_NOTE });
});
