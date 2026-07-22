import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAccountInsights,
  getAudienceDemographics,
  getMediaInsights,
  getOnlineFollowers,
  validateMediaMetrics,
  ACCOUNT_METRICS,
  DEFAULT_MEDIA_METRICS,
} from '../../src/api/insights.js';
import { isInstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';

/** A fake IgRequestFn that records outgoing options and returns a canned body. */
function recordingReq(response: unknown): { req: IgRequestFn; calls: IgRequestOptions[] } {
  const calls: IgRequestOptions[] = [];
  const req: IgRequestFn = async <T>(opts: IgRequestOptions): Promise<T> => {
    calls.push(opts);
    return response as T;
  };
  return { req, calls };
}

const accountWire = {
  data: [
    { name: 'views', period: 'day', title: 'Views', total_value: { value: 1000 } },
    { name: 'reach', period: 'day', total_value: { value: 800 } },
  ],
  paging: { previous: 'p', next: 'n' },
};
const mediaWire = {
  data: [{ name: 'views', period: 'lifetime', total_value: { value: 42 } }],
};
const demoWire = {
  data: [
    {
      name: 'follower_demographics',
      total_value: { breakdowns: [{ dimension_keys: ['country'] }] },
    },
  ],
};
const onlineWire = { data: [{ name: 'online_followers', period: 'lifetime' }] };

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY = 24 * 60 * 60;

// --- account insights -------------------------------------------------------

test('getAccountInsights targets /{ig-id}/insights with the default metric set + total_value', async () => {
  const { req, calls } = recordingReq(accountWire);
  const res = await getAccountInsights(req, { accountId: '123' });

  assert.equal(calls.length, 1);
  const opts = calls[0]!;
  assert.equal(opts.method, 'GET');
  assert.equal(opts.path, '/123/insights');
  assert.equal(opts.params?.metric, ACCOUNT_METRICS.join(','));
  assert.equal(opts.params?.period, 'day');
  assert.equal(opts.params?.metric_type, 'total_value');
  assert.deepEqual(res.metrics, accountWire.data);
  assert.deepEqual(res.paging, accountWire.paging);
  assert.equal(res.window.clamped, false);
  assert.deepEqual(res.notes, []);
});

test('getAccountInsights forwards explicit metrics, period, metric_type and an in-window range', async () => {
  const { req, calls } = recordingReq(accountWire);
  const since = NOW_SEC - 10 * DAY;
  const until = NOW_SEC;
  await getAccountInsights(req, {
    accountId: '123',
    metrics: ['views', 'reach'],
    period: 'week',
    metricType: 'time_series',
    since,
    until,
    nowMs: NOW_MS,
  });

  const opts = calls[0]!;
  assert.equal(opts.params?.metric, 'views,reach');
  assert.equal(opts.params?.period, 'week');
  assert.equal(opts.params?.metric_type, 'time_series');
  assert.equal(opts.params?.since, since);
  assert.equal(opts.params?.until, until);
});

test('getAccountInsights clamps a since older than 90 days and flags it (CC-INS-3)', async () => {
  const { req, calls } = recordingReq(accountWire);
  const since = NOW_SEC - 200 * DAY;
  const until = NOW_SEC - DAY;
  const res = await getAccountInsights(req, { accountId: '123', since, until, nowMs: NOW_MS });

  const floor = NOW_SEC - 90 * DAY;
  assert.equal(res.window.clamped, true);
  assert.equal(res.window.since, floor);
  assert.equal(calls[0]!.params?.since, floor);
  assert.equal(calls[0]!.params?.until, until);
  assert.ok(res.notes.length > 0);
});

test('getAccountInsights refuses a window entirely outside retention (CC-INS-3)', async () => {
  const { req, calls } = recordingReq(accountWire);
  const since = NOW_SEC - 200 * DAY;
  const until = NOW_SEC - 120 * DAY;
  await assert.rejects(
    () => getAccountInsights(req, { accountId: '123', since, until, nowMs: NOW_MS }),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('getAccountInsights throws validation when no account id is resolved', async () => {
  const { req, calls } = recordingReq(accountWire);
  await assert.rejects(
    () => getAccountInsights(req, {}),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

// --- media insights ---------------------------------------------------------

test('getMediaInsights targets /{media-id}/insights with the default media metrics', async () => {
  const { req, calls } = recordingReq(mediaWire);
  const res = await getMediaInsights(req, { mediaId: 'm1' });

  assert.equal(calls[0]!.path, '/m1/insights');
  assert.equal(calls[0]!.params?.metric, DEFAULT_MEDIA_METRICS.join(','));
  assert.equal(res.mediaId, 'm1');
  assert.deepEqual(res.metrics, mediaWire.data);
});

test('getMediaInsights refuses navigation on a reel before spending a call (CC-INS-2)', async () => {
  const { req, calls } = recordingReq(mediaWire);
  await assert.rejects(
    () =>
      getMediaInsights(req, { mediaId: 'm1', metrics: ['navigation'], mediaProductType: 'REELS' }),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('getMediaInsights allows story-only metrics for a story (case-insensitive type)', async () => {
  const { req, calls } = recordingReq(mediaWire);
  await getMediaInsights(req, {
    mediaId: 'm1',
    metrics: ['navigation', 'replies'],
    mediaProductType: 'story',
  });
  assert.equal(calls[0]!.params?.metric, 'navigation,replies');
});

test('getMediaInsights passes an unknown media_product_type through (open vocabulary)', async () => {
  const { req, calls } = recordingReq(mediaWire);
  await getMediaInsights(req, {
    mediaId: 'm1',
    metrics: ['navigation'],
    mediaProductType: 'NEW_META_TYPE',
  });
  assert.equal(calls.length, 1);
});

test('validateMediaMetrics names the valid set for a known type and no-ops otherwise', () => {
  assert.throws(
    () => validateMediaMetrics(['navigation'], 'FEED'),
    (e: unknown) =>
      isInstagramError(e) && e.kind === 'validation' && /total_interactions/.test(e.message),
  );
  assert.doesNotThrow(() => validateMediaMetrics(['views', 'reach'], 'FEED'));
  assert.doesNotThrow(() => validateMediaMetrics(['navigation'], undefined));
});

// --- audience demographics --------------------------------------------------

test('getAudienceDemographics builds metric_type=total_value with breakdown + timeframe', async () => {
  const { req, calls } = recordingReq(demoWire);
  const res = await getAudienceDemographics(req, {
    accountId: '123',
    breakdown: 'country',
    timeframe: 'last_30_days',
  });

  const opts = calls[0]!;
  assert.equal(opts.path, '/123/insights');
  assert.equal(opts.params?.metric, 'follower_demographics');
  assert.equal(opts.params?.metric_type, 'total_value');
  assert.equal(opts.params?.breakdown, 'country');
  assert.equal(opts.params?.timeframe, 'last_30_days');
  assert.equal(res.breakdown, 'country');
  assert.equal(res.timeframe, 'last_30_days');
  assert.deepEqual(res.metrics, demoWire.data);
});

test('getAudienceDemographics honors explicit metrics', async () => {
  const { req, calls } = recordingReq(demoWire);
  await getAudienceDemographics(req, {
    accountId: '123',
    metrics: ['follower_demographics', 'engaged_audience_demographics'],
    breakdown: 'age',
    timeframe: 'this_week',
  });
  assert.equal(calls[0]!.params?.metric, 'follower_demographics,engaged_audience_demographics');
});

// --- online followers -------------------------------------------------------

test('getOnlineFollowers requests metric=online_followers period=lifetime', async () => {
  const { req, calls } = recordingReq(onlineWire);
  const res = await getOnlineFollowers(req, { accountId: '123' });

  assert.equal(calls[0]!.path, '/123/insights');
  assert.equal(calls[0]!.params?.metric, 'online_followers');
  assert.equal(calls[0]!.params?.period, 'lifetime');
  assert.deepEqual(res.metrics, onlineWire.data);
});

test('getOnlineFollowers throws validation without an account id', async () => {
  const { req } = recordingReq(onlineWire);
  await assert.rejects(
    () => getOnlineFollowers(req, {}),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );
});
