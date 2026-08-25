/**
 * Unit tests for the publishing api layer (src/api/publishing.ts). A fake
 * {@link IgRequestFn} records the Graph calls; a recording clock drives the
 * composite poll budget. Focus: a feed image sends NO media_type, the carousel
 * two-step, status mapping, publish posting creation_id, the runtime quota_total
 * read, the default poll cadence/budget, and the create→poll→publish flow's
 * happy / already-published / timeout / error branches.
 *
 * This is the write path to a public account, so most assertions compare the
 * WHOLE recorded request (`method` + `path` + `params`) and the WHOLE returned
 * object rather than picking single fields: an extra param, a stray `host`
 * override, a `body` instead of a query param, or an `idempotent: true` on a
 * publish is exactly the kind of change that never shows up in a spot check and
 * costs a duplicate public post.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import type { Clock } from '../../src/core/clock.js';
import {
  createCarouselContainer,
  createMediaContainer,
  getContainerStatus,
  getPublishingLimit,
  publishMedia,
  runPublishFlow,
} from '../../src/api/publishing.js';

// --- Hermetic guards --------------------------------------------------------

/**
 * Every function here takes the network as an injected seam, so nothing in this
 * file may open a socket. A module-level trap makes that structural instead of
 * conventional: if a change ever reaches past `IgRequestFn` to `globalThis.fetch`
 * — publishing to the real account of whoever runs the suite — it dies offline
 * with a named error instead of posting.
 */
const realFetch = globalThis.fetch;
const offlineFetch: typeof fetch = () => {
  throw new Error('offline: the publishing api layer must never open a socket in tests');
};
globalThis.fetch = offlineFetch;
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
 * A {@link Clock} that records every requested sleep AND lets that much virtual
 * time actually pass.
 *
 * Time advancing on its own is what makes the poll loop provably terminate: the
 * frozen `fakeClock` helper only moves on an explicit `advance`, so a defect that
 * stops the loop from recognising a terminal status would spin on already-resolved
 * promises, starve the event loop, and hang the whole suite instead of failing one
 * test. Recording the sleeps is the second job: both the poll interval and the
 * budget are default arguments that production never overrides (the tool layer
 * calls `runPublishFlow` with `{}`), so the sequence of sleep lengths and the
 * elapsed virtual time are the only public evidence of what those defaults are.
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

/**
 * Upper bound on status polls in one flow. The real defaults poll 21 times
 * (60s budget / 3s cadence), so anything past this is a loop that no longer
 * terminates — with a zero-length sleep that is a pure-microtask spin which no
 * test timeout can interrupt, so the valve throws and turns a hung suite into a
 * failed assertion.
 */
const POLL_CAP = 40;

/**
 * A request fake for {@link runPublishFlow}: `script` answers the Nth status
 * poll, everything else is a `media_publish` and gets `publishResponse`.
 */
function pollingReq(
  script: (poll: number) => Record<string, unknown>,
  publishResponse: Record<string, unknown> = { id: 'M1' },
): { req: IgRequestFn; calls: IgRequestOptions[]; polls: () => number } {
  let polls = 0;
  const { req, calls } = fakeReq((opts) => {
    if (opts.method !== 'GET') return publishResponse;
    polls += 1;
    if (polls > POLL_CAP) throw new Error(`poll runaway: more than ${POLL_CAP} status polls`);
    return script(polls);
  });
  return { req, calls, polls: () => polls };
}

// --- createMediaContainer ---------------------------------------------------

test('createMediaContainer for a feed image POSTs image_url and nothing else', async () => {
  // A feed image must send NO media_type at all — `IMAGE`/`VIDEO` are not valid
  // values for this edge, so a "helpfully" added one is rejected by Graph and the
  // post never happens. The whole request is compared because the neighbouring
  // mistakes are just as expensive: a GET here silently creates nothing, a `body`
  // instead of query params drops every field, and `idempotent: true` would let
  // the HTTP layer replay a container creation it must never replay.
  const { req, calls } = fakeReq(() => ({ id: 'C1' }));

  const r = await createMediaContainer(req, {
    igId: '999',
    imageUrl: 'https://cdn/x.jpg',
    caption: 'hi',
  });

  assert.equal(r.id, 'C1');
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/999/media',
      params: { image_url: 'https://cdn/x.jpg', caption: 'hi' },
    },
  ]);
});

test('createMediaContainer sets media_type for a reel and passes the reel fields verbatim', async () => {
  // The four reel fields are near-interchangeable in type (two URLs, a number, a
  // boolean) and are the easiest place in the module to cross a wire: a cover URL
  // sent as the video, or the video sent as the image, publishes the wrong media
  // to a live audience. Comparing the whole param bag pins each value to its own
  // Graph field name.
  const { req, calls } = fakeReq(() => ({ id: 'C2' }));

  await createMediaContainer(req, {
    igId: '999',
    mediaType: 'REELS',
    videoUrl: 'https://cdn/v.mp4',
    coverUrl: 'https://cdn/c.jpg',
    thumbOffset: 1500,
    shareToFeed: true,
  });

  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/999/media',
      params: {
        media_type: 'REELS',
        video_url: 'https://cdn/v.mp4',
        cover_url: 'https://cdn/c.jpg',
        thumb_offset: 1500,
        share_to_feed: true,
      },
    },
  ]);
});

test('createMediaContainer forwards a false share_to_feed and a zero thumb_offset', async () => {
  // Both fields have a meaningful falsy value: `share_to_feed: false` is an
  // explicit "do NOT cross-post this reel to the feed" — the difference between a
  // Reels-only post and one that also lands on the profile grid — and
  // `thumbOffset: 0` picks the very first frame as the cover. A truthiness guard
  // silently drops both and Meta's own defaults take over, so the operator gets a
  // post they explicitly asked not to make.
  const { req, calls } = fakeReq(() => ({ id: 'C-FALSY' }));

  await createMediaContainer(req, {
    igId: '999',
    mediaType: 'REELS',
    videoUrl: 'https://cdn/v.mp4',
    thumbOffset: 0,
    shareToFeed: false,
  });

  assert.deepEqual(calls[0]?.params, {
    media_type: 'REELS',
    video_url: 'https://cdn/v.mp4',
    thumb_offset: 0,
    share_to_feed: false,
  });
});

test('createMediaContainer serializes children as a comma list and user_tags as JSON', async () => {
  // Graph wants two different array encodings on the same request. `children` is
  // an ordered comma list — the order IS the slide order of the album, and it is
  // the caller's order, never a sorted or reversed one — and `user_tags` is a JSON
  // document. Getting either encoding or the order wrong is accepted by the client
  // and rejected (or mis-rendered) by Instagram. The ids below are deliberately
  // out of alphabetical order so a re-ordering is visible.
  const { req, calls } = fakeReq(() => ({ id: 'ALBUM' }));
  const tags = [
    { username: 'alice', x: 0.1, y: 0.2 },
    { username: 'bob', x: 0.3, y: 0.4 },
  ];

  await createMediaContainer(req, {
    igId: '999',
    mediaType: 'CAROUSEL',
    children: ['child-c', 'child-a', 'child-b'],
    userTags: tags,
  });

  assert.deepEqual(calls[0]?.params, {
    media_type: 'CAROUSEL',
    children: 'child-c,child-a,child-b',
    user_tags: JSON.stringify(tags),
  });
});

test('createMediaContainer only marks is_carousel_item when true', async () => {
  const { req, calls } = fakeReq(() => ({ id: 'K' }));

  await createMediaContainer(req, {
    igId: '999',
    imageUrl: 'https://cdn/k.jpg',
    isCarouselItem: true,
  });

  assert.deepEqual(calls[0]?.params, { image_url: 'https://cdn/k.jpg', is_carousel_item: true });
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

  assert.deepEqual(
    calls[0]?.params,
    { image_url: 'https://cdn/solo.jpg' },
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

  assert.deepEqual(calls[0]?.params, {
    image_url: 'https://cdn/x.jpg',
    location_id: '7770001',
  });
});

test('createMediaContainer sends a caption byte-for-byte, however long', async () => {
  // The caption is the only free-text field the operator authored, and it is
  // published verbatim under their name. Nothing in this layer may normalise it:
  // truncating a long caption or case-folding it would silently publish something
  // the operator never wrote and never previewed (the length rule lives in
  // media-spec.ts and has already run by the time we get here).
  const caption = `Sunset over the Old Town — ${'A'.repeat(300)} #Travel @Alice`;
  const { req, calls } = fakeReq(() => ({ id: 'C-CAP' }));

  await createMediaContainer(req, { igId: '999', imageUrl: 'https://cdn/x.jpg', caption });

  assert.equal(calls[0]?.params?.caption, caption);
});

test('createMediaContainer sends every supported field on one request', async () => {
  // The full bag in one call: each Graph field must carry its own source value.
  // A swap between two same-typed params (both URLs, both ids) survives every
  // single-field test because each value is individually present and plausible —
  // only comparing the complete bag pins them to the right keys.
  const { req, calls } = fakeReq(() => ({ id: 'C-ALL' }));
  const tags = [{ username: 'alice', x: 0.5, y: 0.5 }];

  await createMediaContainer(req, {
    igId: '4242',
    mediaType: 'CAROUSEL',
    imageUrl: 'https://cdn/i.jpg',
    videoUrl: 'https://cdn/v.mp4',
    caption: 'everything',
    locationId: 'LOC-1',
    userTags: tags,
    children: ['c1', 'c2'],
    coverUrl: 'https://cdn/cover.jpg',
    thumbOffset: 250,
    shareToFeed: true,
    isCarouselItem: true,
  });

  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/4242/media',
      params: {
        media_type: 'CAROUSEL',
        image_url: 'https://cdn/i.jpg',
        video_url: 'https://cdn/v.mp4',
        caption: 'everything',
        location_id: 'LOC-1',
        cover_url: 'https://cdn/cover.jpg',
        thumb_offset: 250,
        share_to_feed: true,
        is_carousel_item: true,
        children: 'c1,c2',
        user_tags: JSON.stringify(tags),
      },
    },
  ]);
});

test('createMediaContainer returns only the container id, not the raw Graph row', async () => {
  // Graph answers this edge with whatever fields it feels like; the container id
  // is the one thing the caller may act on. Handing the raw row back would leak
  // whatever else Meta returned into the tool output the model reads.
  const { req } = fakeReq(() => ({ id: 'C-NARROW', uri: 'https://graph/x', extra: 1 }));

  const r = await createMediaContainer(req, { igId: '999', imageUrl: 'https://cdn/x.jpg' });

  assert.deepEqual(r, { id: 'C-NARROW' });
});

// --- createCarouselContainer ------------------------------------------------

test('createCarouselContainer creates each child then a CAROUSEL album referencing them', async () => {
  // The whole two-step is asserted call by call because every part of it is a way
  // to publish the wrong thing: a child that loses `is_carousel_item` becomes a
  // standalone post on the profile, a child created from the wrong URL puts a
  // stranger's image in the album, and an album whose `children` are the source
  // URLs instead of the returned ids is rejected after the children have already
  // cost quota. The order of the ids is the order of the slides.
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
    locationId: '7770001',
  });

  assert.deepEqual(r, { id: 'ALBUM', childIds: ['child-1', 'child-2'] });
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/999/media',
      params: { image_url: 'https://cdn/1.jpg', is_carousel_item: true },
    },
    {
      method: 'POST',
      path: '/999/media',
      params: { image_url: 'https://cdn/2.jpg', is_carousel_item: true },
    },
    {
      method: 'POST',
      path: '/999/media',
      params: {
        media_type: 'CAROUSEL',
        children: 'child-1,child-2',
        caption: 'trip',
        location_id: '7770001',
      },
    },
  ]);
});

// --- getContainerStatus -----------------------------------------------------

test('getContainerStatus GETs status_code,status and maps them verbatim', async () => {
  // Both fields are requested explicitly: a dropped `fields` entry does not fail,
  // it returns a row without that key, and the flow above reads a missing
  // status_code as "still processing" — so the caller waits out the whole budget
  // on a container that was ready. The code is passed through unchanged (the flow
  // normalises it, this layer does not) and the id is Meta's, not the one we
  // asked about.
  const { req, calls } = fakeReq(() => ({
    id: 'GRAPH-ID',
    status_code: 'in_progress',
    status: 'Ingesting',
  }));

  const st = await getContainerStatus(req, { containerId: 'C1' });

  assert.deepEqual(st, { id: 'GRAPH-ID', statusCode: 'in_progress', status: 'Ingesting' });
  assert.deepEqual(calls, [
    { method: 'GET', path: '/C1', params: { fields: 'status_code,status' } },
  ]);
});

test('getContainerStatus reports an absent code and detail as undefined', async () => {
  // Graph answers this edge with the id alone while a container is queued. Both
  // fields must stay `undefined` rather than being defaulted: inventing a
  // `FINISHED` here would publish an unprocessed container, and inventing an
  // empty-string detail would put "(status ERROR: )" in front of the operator.
  const { req } = fakeReq(() => ({ id: 'C1' }));

  const st = await getContainerStatus(req, { containerId: 'C1' });

  assert.deepEqual(st, { id: 'C1', statusCode: undefined, status: undefined });
});

// --- publishMedia -----------------------------------------------------------

test('publishMedia POSTs creation_id and returns the new media id', async () => {
  // The single most dangerous request in the server. `creation_id` must carry the
  // container id and the path must carry the account id — swapped, this publishes
  // something the operator never previewed. It must stay a POST (a GET fails open
  // and reports success without publishing) and must NOT be marked idempotent:
  // the HTTP layer replays idempotent calls on a 429/5xx, and Meta may have
  // accepted the first one, which costs quota and leaves a duplicate public post.
  const { req, calls } = fakeReq(() => ({ id: 'M1', permalink: 'https://instagram.com/p/x' }));

  const r = await publishMedia(req, { igId: '999', creationId: 'C1' });

  assert.deepEqual(r, { id: 'M1' }, 'only the new media id is handed back');
  assert.deepEqual(calls, [
    { method: 'POST', path: '/999/media_publish', params: { creation_id: 'C1' } },
  ]);
});

// --- getPublishingLimit -----------------------------------------------------

test('getPublishingLimit reads quota_total from config at runtime and derives remaining', async () => {
  // Four numbers that all look alike, so the whole result is compared: usage and
  // total are Meta's, duration is the window they apply to, and `remaining` is the
  // only derived one. A total swapped with a duration would tell the operator they
  // have 86 400 posts left.
  const { req, calls } = fakeReq(() => ({
    data: [{ quota_usage: 30, config: { quota_total: 50, quota_duration: 86400 } }],
  }));

  const limit = await getPublishingLimit(req, { igId: '999' });

  assert.deepEqual(limit, {
    quotaUsage: 30,
    quotaTotal: 50,
    quotaDuration: 86400,
    remaining: 20,
  });
  assert.deepEqual(calls, [
    {
      method: 'GET',
      path: '/999/content_publishing_limit',
      params: { fields: 'quota_usage,config' },
    },
  ]);
});

test('getPublishingLimit omits total/remaining when config has no quota_total', async () => {
  // The documented total conflicts with itself (100 vs 50), so it is only ever
  // reported when Meta actually sends it. Falling back to a constant would hand
  // the model a fictional allowance and a `remaining` derived from it — the next
  // publish then fails at Meta after the operator already approved it. Absent
  // means absent: not zero, not a guess, and not a key holding `undefined`.
  const { req } = fakeReq(() => ({ data: [{ quota_usage: 7 }] }));

  const limit = await getPublishingLimit(req, { igId: '999' });

  assert.deepEqual(limit, { quotaUsage: 7 });
});

test('getPublishingLimit reports a known window even when the total is missing', async () => {
  // The two config fields are independent: Meta can send the rolling-window
  // length without the allowance. The window is what tells the operator when the
  // quota frees up again, so it must survive on its own.
  const { req } = fakeReq(() => ({ data: [{ quota_usage: 3, config: { quota_duration: 3600 } }] }));

  const limit = await getPublishingLimit(req, { igId: '999' });

  assert.deepEqual(limit, { quotaUsage: 3, quotaDuration: 3600 });
});

test('getPublishingLimit reports a zeroed quota as a real total of zero', async () => {
  // An account whose tier reports `quota_total: 0` may not publish at all. Zero
  // is a legitimate answer, not a missing one: a guard that only reports the total
  // when it is positive (or when usage is non-zero) turns "you may post nothing"
  // into "we do not know", and an agent reading a missing total tries anyway.
  const { req } = fakeReq(() => ({ data: [{ quota_usage: 0, config: { quota_total: 0 } }] }));

  const limit = await getPublishingLimit(req, { igId: '999' });

  assert.deepEqual(limit, { quotaUsage: 0, quotaTotal: 0, remaining: 0 });
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

  // Only the derived field is clamped — the two raw numbers stay exactly as Meta
  // reported them, so the overrun itself is still visible to the caller.
  assert.deepEqual(
    limit,
    { quotaUsage: 55, quotaTotal: 50, remaining: 0 },
    'an overrun quota has zero remaining, never a negative count',
  );
});

test('getPublishingLimit defaults usage to 0 when the edge returns no rows', async () => {
  // An empty `data` array means Meta has nothing on record for this window, i.e.
  // nothing has been published. Defaulting to anything else would either invent
  // usage the account never spent or, worse, report headroom it does not have.
  const { req } = fakeReq(() => ({ data: [] }));

  const limit = await getPublishingLimit(req, { igId: '999' });

  assert.deepEqual(limit, { quotaUsage: 0 });
});

test('getPublishingLimit reads the first row when Graph returns several', async () => {
  // This edge is a list response with a single meaningful row. Reading a later
  // row (or ignoring the payload) reports another window's numbers as if they
  // were this account's current quota.
  const { req } = fakeReq(() => ({
    data: [
      { quota_usage: 1, config: { quota_total: 10 } },
      { quota_usage: 2, config: { quota_total: 20 } },
    ],
  }));

  const limit = await getPublishingLimit(req, { igId: '999' });

  assert.deepEqual(limit, { quotaUsage: 1, quotaTotal: 10, remaining: 9 });
});

// --- runPublishFlow ---------------------------------------------------------

test('runPublishFlow (happy path): FINISHED on first poll → publishes, no sleep', async () => {
  // The typical image post. Both Graph calls are asserted whole: the status poll
  // must name the container (not the account), and the publish must carry that
  // same container id as `creation_id` — the flow is the only place those two ids
  // are wired together, and it is holding them one line apart.
  const clock = recordingClock(1000);
  const { req, calls, polls } = pollingReq(() => ({ id: 'C1', status_code: 'FINISHED' }));

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
  );

  assert.deepEqual(res, { status: 'published', containerId: 'C1', mediaId: 'M1' });
  assert.equal(polls(), 1);
  assert.deepEqual(calls, [
    { method: 'GET', path: '/C1', params: { fields: 'status_code,status' } },
    { method: 'POST', path: '/999/media_publish', params: { creation_id: 'C1' } },
  ]);
  assert.deepEqual(clock.sleeps, [], 'a container that is already FINISHED is never waited on');
});

test('runPublishFlow polls through IN_PROGRESS then publishes once FINISHED', async () => {
  const clock = recordingClock(0);
  const { req, polls } = pollingReq((poll) => ({
    id: 'C1',
    status_code: poll < 2 ? 'IN_PROGRESS' : 'FINISHED',
  }));

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
    { pollIntervalMs: 1000, maxPollMs: 60000 },
  );

  assert.equal(res.status, 'published');
  assert.equal(polls(), 2);
  assert.deepEqual(clock.sleeps, [1000], 'the caller-supplied cadence is the one that is used');
});

test('runPublishFlow honours an explicit zero poll interval', async () => {
  // `pollIntervalMs: 0` is how a caller (and this suite) asks for "no wait between
  // polls". A truthiness default would quietly replace it with the 3s production
  // cadence, so a caller that asked for an immediate re-check gets a three-second
  // stall instead — and the tests that rely on it would be measuring the default,
  // not the option.
  const clock = recordingClock(0);
  const { req } = pollingReq((poll) => ({
    id: 'C1',
    status_code: poll < 2 ? 'IN_PROGRESS' : 'FINISHED',
  }));

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
    { pollIntervalMs: 0, maxPollMs: 60000 },
  );

  assert.equal(res.status, 'published');
  assert.deepEqual(clock.sleeps, [0]);
});

test('runPublishFlow returns in_progress (not an error) when the poll budget elapses', async () => {
  // A zero budget checks the container once and hands the caller a resume id. The
  // exact call count matters: `media_publish` must NOT be issued, and the deadline
  // must fire on the boundary (`now >= deadline`, not `>`) or an exhausted budget
  // buys itself one more poll and one more sleep on every single call.
  const clock = recordingClock(0);
  const { req, calls } = pollingReq(() => ({ id: 'C1', status_code: 'IN_PROGRESS' }));

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
    { maxPollMs: 0 },
  );

  assert.deepEqual(res, { status: 'in_progress', containerId: 'C1' });
  assert.equal(calls.length, 1, 'one status poll, and crucially no media_publish');
  assert.deepEqual(clock.sleeps, []);
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
  const { req } = pollingReq(
    (poll) => ({ id: 'C1', status_code: poll < 2 ? 'IN_PROGRESS' : 'FINISHED' }),
    { id: 'M-CADENCE' },
  );

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
  // each sleep, so the loop polls at t=start,+3000,…,+60000 and stops on the 21st.
  // The clock deliberately does not start at zero — a deadline computed as the
  // bare budget instead of `now + budget` is indistinguishable from the real one
  // until it is.
  const clock = recordingClock(5000);
  const { req, polls } = pollingReq(() => ({ id: 'C1', status_code: 'IN_PROGRESS' }), {
    id: 'M-CAPPED',
  });

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
  );

  assert.deepEqual(res, { status: 'in_progress', containerId: 'C1' });
  assert.equal(clock.now(), 65_000, 'the loop polled right up to the one-minute default deadline');
  assert.equal(clock.sleeps.length, 20, '21 polls, 20 gaps between them');
  assert.equal(polls(), 21);
});

test('runPublishFlow starts the poll budget only once the container exists', async () => {
  // Container creation is itself slow for video: Graph holds `POST /media` open
  // while it downloads the file, which for a large reel can outlast the entire
  // one-minute poll budget. The deadline is therefore anchored after the create
  // resolves — anchored before it, every slow upload would be declared
  // in_progress on its very first poll and handed back as a resume id, turning
  // the normal case for big videos into a two-call publish.
  const clock = recordingClock(0);
  const { req, polls } = pollingReq(
    (poll) => ({ id: 'C1', status_code: poll < 2 ? 'IN_PROGRESS' : 'FINISHED' }),
    { id: 'M-SLOW' },
  );

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    {
      createContainer: async () => {
        await clock.sleep(120_000);
        return 'C1';
      },
    },
  );

  assert.equal(res.status, 'published');
  assert.equal(polls(), 2, 'the two minutes spent creating the container did not eat the budget');
});

test('runPublishFlow matches the status code case-insensitively', async () => {
  // `status_code` is an open enum carried as free text, and the flow normalises
  // it before comparing. A case-sensitive compare fails silently in the worst
  // direction: a container that IS finished falls through to the "keep polling"
  // arm, so the caller burns the budget and is then handed a resume id for a
  // container that was ready all along — and `media_publish`, the one call that
  // must not be repeated, is never issued.
  const clock = recordingClock(0);
  const { req } = pollingReq(() => ({ id: 'C1', status_code: 'finished' }), { id: 'M-LOWER' });

  // A zero budget makes the miss observable immediately: an unnormalised code is
  // not terminal, so the very first deadline check returns in_progress.
  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
    { pollIntervalMs: 0, maxPollMs: 0 },
  );

  assert.deepEqual(res, { status: 'published', containerId: 'C1', mediaId: 'M-LOWER' });
});

test('runPublishFlow treats an unrecognised status code as "keep polling", never as terminal', async () => {
  // The vocabulary is documented as an OPEN enum, so Meta may answer with a code
  // this build has never seen. The only safe reading of an unknown code is "still
  // working": matching it loosely (a prefix or a substring of a known state) would
  // either publish a container that never finished or refuse a post that was fine,
  // and both decisions are irreversible from here.
  for (const code of ['ERR_TRANSIENT', 'FINISHING', 'PUBLISHING', 'EXPIRING']) {
    const clock = recordingClock(0);
    const { req, calls } = pollingReq(() => ({ id: 'C1', status_code: code }));

    const res = await runPublishFlow(
      { req, clock, igId: '999' },
      { createContainer: async () => 'C1' },
      { pollIntervalMs: 0, maxPollMs: 0 },
    );

    assert.deepEqual(res, { status: 'in_progress', containerId: 'C1' }, `code ${code}`);
    assert.equal(calls.length, 1, `code ${code} must not trigger a publish`);
  }
});

test('runPublishFlow resumes a container without re-creating it', async () => {
  // Resuming exists because the first attempt may have timed out with a container
  // already ingested and paid for. Creating a second one here is the duplicate-post
  // bug the whole resume path was written to avoid — and the create callback is
  // not merely unused, it must never be invoked at all.
  const clock = recordingClock(0);
  let created = false;
  const { req, calls } = pollingReq(() => ({ id: 'RESUME', status_code: 'FINISHED' }), {
    id: 'M2',
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
  assert.deepEqual(res, { status: 'published', containerId: 'RESUME', mediaId: 'M2' });
  assert.deepEqual(calls[1], {
    method: 'POST',
    path: '/999/media_publish',
    params: { creation_id: 'RESUME' },
  });
});

test('runPublishFlow never creates a container when a resume id was supplied at all', async () => {
  // The resume id is used exactly as given, including a degenerate empty string.
  // A truthiness check here would take the caller's "resume this one" and quietly
  // turn it into "create another one" — the single most expensive mistake in this
  // module, because the extra container costs quota and, once published, is a
  // visible duplicate post that cannot be undone from here.
  const clock = recordingClock(0);
  let created = false;
  const { req } = pollingReq(() => ({ id: '', status_code: 'FINISHED' }), { id: 'M-EMPTY' });

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    {
      resumeContainerId: '',
      createContainer: async () => {
        created = true;
        return 'NEW';
      },
    },
  );

  assert.equal(created, false, 'no container is created while resuming');
  assert.equal(res.containerId, '');
});

test('runPublishFlow reports already_published for a resumed PUBLISHED container and never re-publishes', async () => {
  // A resumed container that Meta already published is the exact state where a
  // second `media_publish` produces a duplicate post. It is reported as its own
  // outcome — not as in_progress, which would invite the caller to resume again.
  const clock = recordingClock(0);
  const { req, calls } = pollingReq(() => ({ id: 'RESUME', status_code: 'PUBLISHED' }));

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { resumeContainerId: 'RESUME', createContainer: async () => 'NEW' },
  );

  assert.deepEqual(res, { status: 'already_published', containerId: 'RESUME' });
  assert.equal(calls.length, 1, 'no duplicate publish');
});

test("runPublishFlow throws (upstream) and quotes Meta's own ERROR explanation", async () => {
  // ERROR is upstream, not validation: the request was well-formed and Meta
  // rejected the media, and the kind is what decides whether anything above
  // retries. The free-text detail is the only thing that distinguishes one dead
  // container from another — "Media download failed" (fix the URL) reads nothing
  // like a rejected aspect ratio — and the container id is what the operator needs
  // to correlate it with the post they were making.
  const clock = recordingClock(0);
  const { req } = pollingReq(() => ({
    id: 'C1',
    status_code: 'ERROR',
    status: 'Media download failed',
  }));

  await assert.rejects(
    () =>
      runPublishFlow(
        { req, clock, igId: '999' },
        { createContainer: async () => 'C1' },
        {
          maxPollMs: 0,
        },
      ),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'upstream' &&
      e.message ===
        'Container C1 failed processing (status ERROR: Media download failed); re-create it.',
  );
});

test('runPublishFlow names the ERROR state without a stray colon when Graph sends no detail', async () => {
  // The free-text `status` is optional, and an ERROR without one is still fatal —
  // a guard that only treats a *detailed* ERROR as terminal would poll a dead
  // container for the whole budget. Appending the absent detail unconditionally
  // would leave the operator reading "(status ERROR: undefined)", a message that
  // looks like a bug in this server rather than a rejected upload.
  const clock = recordingClock(0);
  const { req } = pollingReq(() => ({ id: 'C1', status_code: 'ERROR' }));

  await assert.rejects(
    () =>
      runPublishFlow(
        { req, clock, igId: '999' },
        { createContainer: async () => 'C1' },
        {
          maxPollMs: 0,
        },
      ),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'upstream' &&
      e.message === 'Container C1 failed processing (status ERROR); re-create it.',
  );
});

test('runPublishFlow throws (validation) with a re-create instruction when the container has EXPIRED', async () => {
  // An expired container is gone: Meta drops unpublished containers after 24h.
  // That is a `validation` failure — nothing upstream is broken and no retry can
  // help — and mis-classifying it as `upstream` invites the caller to retry a
  // container that will never exist again. The message has to say re-create,
  // because "expired" alone reads like something that will resolve itself.
  const clock = recordingClock(0);
  const { req } = pollingReq(() => ({ id: 'C1', status_code: 'EXPIRED' }));

  await assert.rejects(
    () =>
      runPublishFlow(
        { req, clock, igId: '999' },
        { createContainer: async () => 'C1' },
        {
          maxPollMs: 0,
        },
      ),
    (e: unknown) =>
      e instanceof InstagramError &&
      e.kind === 'validation' &&
      e.message === 'Container C1 expired before it was published; re-create it.',
  );
});

test('runPublishFlow keeps polling a status response that carries no status_code', async () => {
  // Graph occasionally answers the status edge with the container id alone. An
  // absent code is not a terminal state: coercing it to `undefined.toUpperCase()`
  // would crash the flow, defaulting it to FINISHED would publish an unprocessed
  // container, and defaulting it to ERROR would abandon one that goes on to finish
  // a poll later.
  const clock = recordingClock(0);
  const { req, polls } = pollingReq(
    (poll) => (poll === 1 ? { id: 'C1' } : { id: 'C1', status_code: 'FINISHED' }),
    { id: 'M-LATE' },
  );

  const res = await runPublishFlow(
    { req, clock, igId: '999' },
    { createContainer: async () => 'C1' },
    { pollIntervalMs: 1, maxPollMs: 60000 },
  );

  assert.equal(res.status, 'published');
  assert.equal(polls(), 2, 'the codeless first answer did not end the poll');
});
