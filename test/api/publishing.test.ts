/**
 * Unit tests for the publishing api layer (src/api/publishing.ts). A fake
 * {@link IgRequestFn} records the Graph calls; a {@link fakeClock} drives the
 * composite poll budget. Focus: a feed image sends NO media_type, the carousel
 * two-step, status mapping, publish posting creation_id, the runtime quota_total
 * read, the default poll cadence/budget, and the create→poll→publish flow's
 * happy / already-published / timeout / error branches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import type { Clock } from '../../src/core/clock.js';
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

/**
 * A {@link Clock} that records every requested sleep AND lets that much virtual
 * time actually pass. `fakeClock` deliberately does neither (it resolves a
 * zero-length sleep eagerly and only moves on an explicit `advance`), which is
 * what the poll-loop tests below want — but it also makes the loop's own cadence
 * invisible. Both the interval and the budget are default arguments that
 * production never overrides (the tool layer calls with `{}`), so the sequence of
 * sleep lengths and the elapsed virtual time are the only public evidence of what
 * those defaults are.
 */
function recordingClock(startMs = 0): Clock & { sleeps: number[] } {
  let current = startMs;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => current,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      current += ms;
    },
  };
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

test('createMediaContainer omits is_carousel_item entirely when it is explicitly false', async () => {
  // Graph reads the flag by presence, and it is one-way: a container marked as a
  // carousel child can only be published as part of an album, never on its own.
  // A caller passing `false` is asking for a standalone post, so a presence test
  // (`!== undefined`) instead of an equality test would strand that post inside
  // an album that is never created — and the failure surfaces later, at
  // media_publish, far from the mistake.
  const { req, calls } = fakeReq(() => ({ id: 'SOLO' }));

  await createMediaContainer(req, {
    igId: '999',
    imageUrl: 'https://cdn/solo.jpg',
    isCarouselItem: false,
  });

  assert.equal(
    'is_carousel_item' in (calls[0]?.params ?? {}),
    false,
    'an explicit false must send no carousel flag at all',
  );
});

test('createMediaContainer passes a locationId through as location_id', async () => {
  // The Graph field is snake_case and differs from the param name; a caller
  // tagging a post with a place gets it silently dropped if this arm is missed.
  const { req, calls } = fakeReq(() => ({ id: 'C-LOC' }));

  await createMediaContainer(req, {
    igId: '999',
    imageUrl: 'https://cdn/x.jpg',
    locationId: '7770001',
  });

  assert.equal(calls[0]?.params?.location_id, '7770001');
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

test('getPublishingLimit clamps remaining at zero when usage has overrun the total', async () => {
  // `quota_usage` and `config.quota_total` are two independent numbers Meta
  // reports; the total is whatever the account's tier says *right now* (the docs'
  // own 100-vs-50 conflict is exactly this moving target), so a tier downgrade or
  // a burst posted before the rolling window rolled can leave usage above it.
  // `remaining` is what an operator/agent reads as "posts you may still make":
  // an unclamped -5 is not merely cosmetic, it reads as a bug in this server and
  // flips a plain `remaining > 0` gate into nonsense arithmetic.
  const { req } = fakeReq(() => ({ data: [{ quota_usage: 55, config: { quota_total: 50 } }] }));

  const limit = await getPublishingLimit(req, { igId: '999' });

  assert.equal(limit.remaining, 0, 'an overrun quota has zero remaining, never a negative count');
  // Only the derived field is clamped — the two raw numbers stay exactly as Meta
  // reported them, so the overrun itself is still visible to the caller.
  assert.equal(limit.quotaUsage, 55);
  assert.equal(limit.quotaTotal, 50);
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

test('runPublishFlow waits the default 3000ms between polls when no interval is given', async () => {
  // Nothing in production passes `pollIntervalMs` — the three composite post
  // tools hand `runPublishFlow` whatever they were given, which is `{}` — so this
  // default IS the live cadence against Meta's status edge for every video
  // upload. Shortening it multiplies our request rate against a rate-limited
  // edge; dropping the wait to zero turns the budget into a spin loop that burns
  // a poll per event-loop turn. Neither shows up in the returned status, so the
  // recorded sleep lengths are the only place it can be asserted.
  const clock = recordingClock(0);
  let polls = 0;
  const { req } = fakeReq((opts) => {
    if (opts.method === 'GET') {
      polls += 1;
      return { id: 'C1', status_code: polls < 2 ? 'IN_PROGRESS' : 'FINISHED' };
    }
    return { id: 'M-CADENCE' };
  });

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
  );

  assert.equal(res.status, 'published');
  assert.deepEqual(clock.sleeps, [3000], 'exactly one gap, of exactly the 3000ms default');
});

test('runPublishFlow spends the whole 60s default budget before reporting in_progress', async () => {
  // The budget default is likewise never overridden outside tests, and it is the
  // difference between "we waited a minute for the video to transcode" and "we
  // gave up on the first poll". Both outcomes are the same `in_progress` shape,
  // so the elapsed virtual time is what separates them. With the 3000ms cadence
  // above, a 60s budget is 21 polls and 20 gaps: the deadline check runs BEFORE
  // each sleep, so the loop polls at t=0,3000,…,60000 and stops on the 21st.
  const clock = recordingClock(0);
  let polls = 0;
  const { req } = fakeReq((opts) => {
    if (opts.method === 'GET') {
      polls += 1;
      // Safety valve, never reached by the real defaults (21 < 50): it exists so
      // a regression that stops advancing time fails these assertions instead of
      // hanging the suite until the runner's timeout.
      return { id: 'C1', status_code: polls >= 50 ? 'FINISHED' : 'IN_PROGRESS' };
    }
    return { id: 'M-CAPPED' };
  });

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
  );

  assert.deepEqual(res, { status: 'in_progress', containerId: 'C1' });
  assert.equal(clock.now(), 60_000, 'the loop polled right up to the one-minute default deadline');
  assert.equal(clock.sleeps.length, 20, '21 polls, 20 gaps between them');
  assert.equal(polls, 21);
});

test('runPublishFlow matches the status code case-insensitively', async () => {
  // `status_code` is an open enum carried as free text, and the flow normalises
  // it before comparing. A case-sensitive compare fails silently in the worst
  // direction: a container that IS finished falls through to the "keep polling"
  // arm, so the caller burns the budget and is then handed a resume id for a
  // container that was ready all along — and `media_publish`, the one call that
  // must not be repeated, is never issued.
  const clock = recordingClock(0);
  const { req } = fakeReq((opts) => {
    if (opts.method === 'GET') return { id: 'C1', status_code: 'finished' };
    return { id: 'M-LOWER' };
  });

  // A zero budget makes the miss observable immediately: an unnormalised code is
  // not terminal, so the very first deadline check returns in_progress.
  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
    { pollIntervalMs: 0, maxPollMs: 0 },
  );

  assert.deepEqual(res, { status: 'published', containerId: 'C1', mediaId: 'M-LOWER' });
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

test('runPublishFlow keeps polling a status response that carries no status_code', async () => {
  // Graph occasionally answers the status edge with the container id alone. An
  // absent code is not a terminal state: coercing it to `undefined.toUpperCase()`
  // would crash the flow, and treating it as terminal would abandon a container
  // that goes on to finish a poll later.
  const clock = fakeClock(0);
  let poll = 0;
  const { req } = fakeReq((opts) => {
    if (opts.path === '/C1' && opts.method === 'GET') {
      poll += 1;
      return poll === 1 ? { id: 'C1' } : { id: 'C1', status_code: 'FINISHED' };
    }
    if (opts.path === '/999/media_publish') return { id: 'M-LATE' };
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });

  // pollIntervalMs:0 lets the fake clock resolve the sleep without a manual advance.
  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
    { pollIntervalMs: 0, maxPollMs: 60000 },
  );

  assert.equal(res.status, 'published');
  assert.equal(res.mediaId, 'M-LATE');
  assert.equal(poll, 2, 'the codeless first answer did not end the poll');
});

test('runPublishFlow names the ERROR state without a stray colon when Graph sends no detail', async () => {
  // The free-text `status` is optional. Appending it unconditionally would leave
  // the operator reading "(status ERROR: undefined)" — a message that looks like
  // a bug in this server rather than a rejected upload.
  const clock = fakeClock(0);
  const { req } = fakeReq(() => ({ id: 'C1', status_code: 'ERROR' }));

  await assert.rejects(
    () => runPublishFlow({ req, clock, igId: '999' }, { createContainer: async () => 'C1' }),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'upstream' &&
      /\(status ERROR\); re-create it\.$/.test(e.message),
  );
});

test("runPublishFlow quotes Meta's own ERROR explanation in the refusal", async () => {
  // The mirror image of the test above: when Graph DOES send a detail, it is the
  // only thing that distinguishes one dead container from another. The container
  // is unrecoverable either way, so the sole remaining job of this message is to
  // say why — "Media download failed" (fix the URL) reads nothing like a rejected
  // aspect ratio, and losing it leaves every failed upload with one opaque
  // sentence and forces a manual status GET on a container that may already have
  // expired.
  const clock = fakeClock(0);
  const { req } = fakeReq(() => ({
    id: 'C1',
    status_code: 'ERROR',
    status: 'Media download failed',
  }));

  await assert.rejects(
    () => runPublishFlow({ req, clock, igId: '999' }, { createContainer: async () => 'C1' }),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'upstream' &&
      e.message ===
        'Container C1 failed processing (status ERROR: Media download failed); re-create it.',
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
