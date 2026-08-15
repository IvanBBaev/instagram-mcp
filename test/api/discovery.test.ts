/**
 * Unit tests for the discovery api layer (Layer 1). These use a **fake**
 * {@link IgRequestFn} returning canned Graph payloads — no network, no
 * `mcp`/result dependency — so they run standalone. They assert the Path-B host
 * pin (graph.facebook.com), the exact paths/params (user_id present; the `edge`
 * selecting top vs recent; the business_discovery field spec), the maxItems cap,
 * and CC-DATA-2/6 tolerance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import { InstagramError } from '../../src/core/types.js';
import {
  INSTAGRAM_USERNAME_PATTERN,
  discoverBusiness,
  getHashtagMedia,
  searchHashtag,
} from '../../src/api/discovery.js';

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

test('getHashtagMedia within the cap is not truncated', async () => {
  const { req } = fakeReq(() => ({ data: [{ id: '1' }, { id: '2' }], paging: {} }));

  const res = await getHashtagMedia(req, {
    hashtagId: 'H1',
    igId: '999',
    edge: 'recent',
    maxItems: 5,
  });

  assert.equal(res.items.length, 2);
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

test('discoverBusiness refuses a username that would rewrite the Graph field expression', async () => {
  // Each payload closes the `username(` call and appends its own selection —
  // extra fields off the OPERATOR's node, or an inflated media.limit() burning
  // quota. Graph field expressions cannot be escaped, so these must be rejected.
  const payloads = [
    'x){id,username},followers_count.limit(0){',
    'target){id},media.limit(9999){id',
    'a,b',
    'a)',
    '@target',
    'has space',
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
        assert.match(err.message, /username/i);
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
