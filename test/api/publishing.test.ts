/**
 * Unit tests for the publishing api layer (src/api/publishing.ts). A fake
 * {@link IgRequestFn} records the Graph calls; a {@link fakeClock} drives the
 * composite poll budget. Focus: a feed image sends NO media_type, the carousel
 * two-step, status mapping, publish posting creation_id, the runtime quota_total
 * read, and the create→poll→publish flow's happy / already-published / timeout /
 * error branches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import { fakeClock } from '../helpers/fake-clock.js';
import {
  createCarouselContainer,
  createMediaContainer,
  getContainerStatus,
  getPublishingLimit,
  publishMedia,
  runPublishFlow,
} from '../../src/api/publishing.js';

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

// --- createMediaContainer ---------------------------------------------------

test('createMediaContainer for a feed image sends image_url and NO media_type', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));

  const r = await createMediaContainer(req, {
    igId: '999',
    imageUrl: 'https://cdn/x.jpg',
    caption: 'hi',
  });

  assert.equal(r.id, 'C1');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/999/media');
  assert.equal(calls[0]?.params?.image_url, 'https://cdn/x.jpg');
  assert.equal(calls[0]?.params?.caption, 'hi');
  assert.equal('media_type' in (calls[0]?.params ?? {}), false, 'no media_type for a feed image');
});

test('createMediaContainer sets media_type for a reel and passes reel fields', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C2' }));

  await createMediaContainer(req, {
    igId: '999',
    mediaType: 'REELS',
    videoUrl: 'https://cdn/v.mp4',
    coverUrl: 'https://cdn/c.jpg',
    thumbOffset: 1500,
    shareToFeed: true,
  });

  const p = calls[0]?.params ?? {};
  assert.equal(p.media_type, 'REELS');
  assert.equal(p.video_url, 'https://cdn/v.mp4');
  assert.equal(p.cover_url, 'https://cdn/c.jpg');
  assert.equal(p.thumb_offset, 1500);
  assert.equal(p.share_to_feed, true);
});

test('createMediaContainer serializes children as a comma list and user_tags as JSON', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'ALBUM' }));

  await createMediaContainer(req, {
    igId: '999',
    mediaType: 'CAROUSEL',
    children: ['a', 'b', 'c'],
    userTags: [{ username: 'alice', x: 0.1, y: 0.2 }],
  });

  const p = calls[0]?.params ?? {};
  assert.equal(p.children, 'a,b,c');
  assert.equal(p.user_tags, JSON.stringify([{ username: 'alice', x: 0.1, y: 0.2 }]));
});

test('createMediaContainer only marks is_carousel_item when true', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'K' }));

  await createMediaContainer(req, {
    igId: '999',
    imageUrl: 'https://cdn/k.jpg',
    isCarouselItem: true,
  });

  assert.equal(calls[0]?.params?.is_carousel_item, true);
});

// --- createCarouselContainer ------------------------------------------------

test('createCarouselContainer creates each child then a CAROUSEL album referencing them', async () => {
  let n = 0;
  const { req, calls } = fakeReq((opts) => {
    // The album call carries a `children` param; child calls do not.
    if (opts.params?.children !== undefined) return { id: 'ALBUM' };
    n += 1;
    return { id: `child-${n}` };
  });

  const r = await createCarouselContainer(req, {
    igId: '999',
    childImageUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg'],
    caption: 'trip',
  });

  assert.deepEqual(r.childIds, ['child-1', 'child-2']);
  assert.equal(r.id, 'ALBUM');
  assert.equal(calls.length, 3, 'two children + one album');
  // Children are feed images: no media_type, marked as carousel items.
  assert.equal(calls[0]?.params?.is_carousel_item, true);
  assert.equal('media_type' in (calls[0]?.params ?? {}), false);
  // The album references the freshly created child ids.
  assert.equal(calls[2]?.params?.media_type, 'CAROUSEL');
  assert.equal(calls[2]?.params?.children, 'child-1,child-2');
  assert.equal(calls[2]?.params?.caption, 'trip');
});

// --- getContainerStatus -----------------------------------------------------

test('getContainerStatus GETs status_code,status and maps them', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'C1', status_code: 'FINISHED', status: 'Finished' }));

  const st = await getContainerStatus(req, { containerId: 'C1' });

  assert.equal(st.id, 'C1');
  assert.equal(st.statusCode, 'FINISHED');
  assert.equal(st.status, 'Finished');
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.path, '/C1');
  assert.equal(calls[0]?.params?.fields, 'status_code,status');
});

// --- publishMedia -----------------------------------------------------------

test('publishMedia POSTs creation_id and returns the new media id', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'M1' }));

  const r = await publishMedia(req, { igId: '999', creationId: 'C1' });

  assert.equal(r.id, 'M1');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/999/media_publish');
  assert.equal(calls[0]?.params?.creation_id, 'C1');
});

// --- getPublishingLimit -----------------------------------------------------

test('getPublishingLimit reads quota_total from config at runtime and derives remaining', async () => {
  const { req, calls } = fakeReq(() => ({
    data: [{ quota_usage: 30, config: { quota_total: 50, quota_duration: 86400 } }],
  }));

  const limit = await getPublishingLimit(req, { igId: '999' });

  assert.equal(limit.quotaUsage, 30);
  assert.equal(limit.quotaTotal, 50);
  assert.equal(limit.quotaDuration, 86400);
  assert.equal(limit.remaining, 20);
  assert.equal(calls[0]?.path, '/999/content_publishing_limit');
  assert.equal(calls[0]?.params?.fields, 'quota_usage,config');
});

test('getPublishingLimit omits total/remaining when config has no quota_total', async () => {
  const { req } = fakeReq(() => ({ data: [{ quota_usage: 7 }] }));

  const limit = await getPublishingLimit(req, { igId: '999' });

  assert.equal(limit.quotaUsage, 7);
  assert.equal(limit.quotaTotal, undefined);
  assert.equal(limit.remaining, undefined);
});

test('getPublishingLimit defaults usage to 0 when the edge returns no rows', async () => {
  const { req } = fakeReq(() => ({ data: [] }));

  const limit = await getPublishingLimit(req, { igId: '999' });

  assert.equal(limit.quotaUsage, 0);
});

// --- runPublishFlow ---------------------------------------------------------

test('runPublishFlow (happy path): FINISHED on first poll → publishes, no sleep', async () => {
  const clock = fakeClock(1000);
  const { req, calls } = fakeReq((opts) => {
    if (opts.path === '/C1' && opts.method === 'GET') return { id: 'C1', status_code: 'FINISHED' };
    if (opts.path === '/999/media_publish') return { id: 'M1' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
  );

  assert.deepEqual(res, { status: 'published', containerId: 'C1', mediaId: 'M1' });
  // status GET + media_publish POST — exactly one poll, no waiting needed.
  assert.equal(calls.length, 2);
});

test('runPublishFlow polls through IN_PROGRESS then publishes once FINISHED', async () => {
  const clock = fakeClock(0);
  let polls = 0;
  const { req } = fakeReq((opts) => {
    if (opts.method === 'GET') {
      polls += 1;
      return { id: 'C1', status_code: polls < 2 ? 'IN_PROGRESS' : 'FINISHED' };
    }
    return { id: 'M9' };
  });

  // pollIntervalMs:0 lets the fake clock resolve each sleep immediately (no
  // manual advance to race), while maxPollMs stays generous so the loop runs
  // until the second poll reports FINISHED.
  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
    { pollIntervalMs: 0, maxPollMs: 60000 },
  );

  assert.equal(res.status, 'published');
  assert.equal(polls, 2);
});

test('runPublishFlow returns in_progress (not an error) when the poll budget elapses', async () => {
  const clock = fakeClock(0);
  const { req, calls } = fakeReq(() => ({ id: 'C1', status_code: 'IN_PROGRESS' }));

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
    { maxPollMs: 0 },
  );

  assert.deepEqual(res, { status: 'in_progress', containerId: 'C1' });
  // One status poll, and crucially NO media_publish call.
  assert.equal(calls.length, 1);
  assert.equal(
    calls.every((c) => c.path !== '/999/media_publish'),
    true,
  );
});

test('runPublishFlow resumes a container without re-creating it', async () => {
  const clock = fakeClock(0);
  let created = false;
  const { req } = fakeReq((opts) => {
    if (opts.method === 'GET') return { id: 'RESUME', status_code: 'FINISHED' };
    return { id: 'M2' };
  });

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    {
      resumeContainerId: 'RESUME',
      createContainer: async () => {
        created = true;
        return 'NEW';
      },
    },
  );

  assert.equal(created, false, 'a resumed container is never re-created');
  assert.equal(res.status, 'published');
  assert.equal(res.containerId, 'RESUME');
});

test('runPublishFlow reports already_published for a resumed PUBLISHED container and never re-publishes', async () => {
  const clock = fakeClock(0);
  const { req, calls } = fakeReq(() => ({ id: 'RESUME', status_code: 'PUBLISHED' }));

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { resumeContainerId: 'RESUME', createContainer: async () => 'NEW' },
  );

  assert.deepEqual(res, { status: 'already_published', containerId: 'RESUME' });
  assert.equal(
    calls.every((c) => c.path !== '/999/media_publish'),
    true,
    'no duplicate publish',
  );
});

test('runPublishFlow throws (upstream) when the container status is ERROR', async () => {
  const clock = fakeClock(0);
  const { req } = fakeReq(() => ({ id: 'C1', status_code: 'ERROR', status: 'bad media' }));

  await assert.rejects(
    () => runPublishFlow({ req, clock, igId: '999' }, { createContainer: async () => 'C1' }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'upstream',
  );
});

test('runPublishFlow throws (validation) when the container has EXPIRED', async () => {
  const clock = fakeClock(0);
  const { req } = fakeReq(() => ({ id: 'C1', status_code: 'EXPIRED' }));

  await assert.rejects(
    () => runPublishFlow({ req, clock, igId: '999' }, { createContainer: async () => 'C1' }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
});
