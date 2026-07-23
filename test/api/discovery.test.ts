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
import { discoverBusiness, getHashtagMedia, searchHashtag } from '../../src/api/discovery.js';

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
  assert.ok(String(calls[0]?.params?.fields).includes('caption'));
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
  assert.equal(res.after, 'NEXT');
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

// --- discoverBusiness ------------------------------------------------------

test('discoverBusiness reads /{ig-id} on graph.facebook.com with the business_discovery field spec', async () => {
  const { req, calls } = fakeReq(() => ({
    id: '999',
    business_discovery: {
      id: '555',
      username: 'target',
      name: 'Target Co',
      biography: 'we make things',
      followers_count: 1000,
      media_count: 42,
      media: { data: [{ id: 'p1', caption: 'a post', media_type: 'IMAGE' }] },
    },
  }));

  const biz = await discoverBusiness(req, { igId: '999', username: 'target', mediaLimit: 10 });

  assert.equal(biz.username, 'target');
  assert.equal(biz.followers_count, 1000);
  assert.equal(biz.media_count, 42);
  assert.equal(biz.media?.length, 1);
  assert.equal(biz.media?.[0]?.caption, 'a post');

  assert.equal(calls[0]?.host, 'graph.facebook.com');
  assert.equal(calls[0]?.path, '/999');
  const fields = String(calls[0]?.params?.fields);
  assert.ok(fields.includes('business_discovery.username(target)'));
  assert.ok(fields.includes('followers_count'));
  assert.ok(fields.includes('media.limit(10){'));
});

test('discoverBusiness tolerates a missing business_discovery block (CC-DATA-2)', async () => {
  const { req } = fakeReq(() => ({ id: '999' }));

  const biz = await discoverBusiness(req, { igId: '999', username: 'ghost', mediaLimit: 5 });

  assert.equal(biz.username, undefined);
  assert.equal(biz.media, undefined);
});
