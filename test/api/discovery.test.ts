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
  INSTAGRAM_USERNAME_PATTERN,
  discoverBusiness,
  getHashtagMedia,
  searchHashtag,
} from '../../src/api/discovery.js';

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

// --- searchHashtag ---------------------------------------------------------

test('searchHashtag hits /ig_hashtag_search on graph.facebook.com with user_id and q', async () => {
  const { req, calls } = fakeReq(() => ({ data: [{ id: '17843' }, { id: '17844' }] }));

  const refs = await searchHashtag(req, { igId: '999', query: 'nofilter' });

  assert.deepEqual(
    refs.map((r) => r.id),
    ['17843', '17844'],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.host, 'graph.facebook.com');
  assert.equal(calls[0]?.path, '/ig_hashtag_search');
  assert.equal(calls[0]?.params?.user_id, '999');
  assert.equal(calls[0]?.params?.q, 'nofilter');
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
    paging: { cursors: { after: 'CUR' } },
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
  assert.equal(calls[0]?.host, 'graph.facebook.com');
  assert.equal(calls[0]?.path, '/H1/top_media');
  assert.equal(calls[0]?.params?.user_id, '999');
  assert.equal(calls[0]?.params?.limit, 25);
  // The whole field set is pinned, not just a sample of it. `id` is the field
  // every follow-up depends on (fetch the media, read its comments, build a
  // permalink); dropping it yields a page of captions nothing can act on, and
  // nothing else in the suite would notice.
  assert.deepEqual(String(calls[0]?.params?.fields).split(','), [
    'id',
    'caption',
    'media_type',
    'media_url',
    'permalink',
    'timestamp',
    'like_count',
    'comments_count',
  ]);
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
    paging: { cursors: { after: 'NEXT' } },
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
});

test('getHashtagMedia withholds the cursor when the cap cut the page mid-way', async () => {
  const { req } = fakeReq(() => ({
    data: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }],
    paging: { cursors: { after: 'PAST_ITEM_4' } },
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
    paging: { cursors: { after: 'NEXT' } },
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
    paging: { cursors: { after: 'NEXT' } },
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
    paging: { cursors: { after: 'CURSOR_FOR_PAGE_3' } },
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
  });

  assert.equal(calls[0]?.host, 'graph.facebook.com');
  assert.equal(calls[0]?.path, '/999');
  assert.equal(calls[0]?.method, 'GET');
  // `fields` is the ONLY query parameter, and that exclusivity is the point: the
  // whole ask lives inside the one string pinned below, so pinning that string
  // pins the request. A second key would open an unpinned channel that can change
  // what Graph returns — a top-level `limit` or `user_id` next to a
  // `business_discovery` field expression is at best ignored and at worst
  // reinterpreted, and either way no assertion here would see it.
  assert.deepEqual(Object.keys(calls[0]?.params ?? {}), ['fields']);
  // The entire field expression is pinned character-for-character. It is a
  // single interpolated string sent to Graph, and every part of it is load
  // bearing: the nested `media.limit(<cap>)` bounds the quota this one call
  // spends, and `biography`/`website` are the fields the discovery tool is
  // actually for. A sampled `includes()` check would let any of them silently
  // drop out.
  assert.equal(
    calls[0]?.params?.fields,
    'business_discovery.username(target){' +
      'id,username,name,biography,website,followers_count,follows_count,media_count,' +
      'media.limit(10){id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count}}',
  );
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

test('discoverBusiness tolerates a missing business_discovery block (CC-DATA-2)', async () => {
  // The envelope still carries `id: '999'` — the OPERATOR's own node id, which
  // Graph always echoes. That id must not be laundered into the discovered
  // profile: a `bd.id ?? wire.id` fallback would report the operator's own
  // account as the handle that was looked up, and a caller chaining on
  // `biz.id` would then read insights for itself and label them `ghost`.
  const { req } = fakeReq(() => ({ id: '999' }));

  const biz = await discoverBusiness(req, { igId: '999', username: 'ghost', mediaLimit: 5 });

  // Equality, not field sampling: `media` must be ABSENT, not present-and-
  // undefined. The object goes out as MCP `structuredContent`, where an own key
  // is a claim that the edge was fetched and came back empty — a different fact
  // from "this account discloses no media".
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
