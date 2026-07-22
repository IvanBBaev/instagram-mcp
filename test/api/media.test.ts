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
  assert.ok(String(calls[0]?.params?.fields).includes('caption'));
  assert.ok(String(calls[0]?.params?.fields).includes('like_count'));
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
  assert.ok(String(calls[0]?.params?.fields).includes('children{'));
});

test('getMedia tolerates fields Meta omits rather than nulls (CC-DATA-2)', async () => {
  const { req } = fakeReq(() => ({ id: 'M2', media_type: 'IMAGE' }));

  const detail = await getMedia(req, { mediaId: 'M2' });

  assert.equal(detail.id, 'M2');
  assert.equal(detail.like_count, undefined);
  assert.equal(detail.media_url, undefined);
  assert.equal(detail.children, undefined);
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
  assert.equal(
    String(calls[0]?.params?.fields),
    'id,media_type,media_url,thumbnail_url,permalink,timestamp',
  );
});

test('getMediaChildren returns an empty array when the edge has no data', async () => {
  const { req } = fakeReq(() => ({}));

  const children = await getMediaChildren(req, { mediaId: 'x' });

  assert.deepEqual(children, []);
});
