import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAccountInsights,
  getAudienceDemographics,
  getMediaInsights,
  getOnlineFollowers,
  validateMediaMetrics,
  ACCOUNT_METRICS,
  ACCOUNT_PERIODS,
  DEFAULT_MEDIA_METRICS,
  DEMOGRAPHIC_BREAKDOWNS,
  DEMOGRAPHIC_TIMEFRAMES,
  MEDIA_METRICS,
  MEDIA_METRIC_MATRIX,
  METRIC_TYPES,
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

/** The 90-day retention floor for `NOW_MS`, pinned to a literal 90 rather than the source constant. */
const RETENTION_FLOOR_SEC = NOW_SEC - 90 * DAY;
const CLAMP_NOTE =
  '`since` was clamped to the 90-day retention floor; data older than that is not retained by Meta.';

/**
 * The whole unresolved-account-id refusal, remediation sentence included. Pinned
 * as a literal (not imported) so a rewrite of the source string has to be a
 * deliberate edit here too.
 */
const NO_ACCOUNT_ID_MESSAGE =
  'No Instagram account ID resolved for this profile. Set IG_ACCOUNT_ID (or a profile-scoped account ID) so account-level insights can target /{ig-id}/insights.';

// --- metric vocabularies (CC-INS-7) -----------------------------------------

test('ACCOUNT_METRICS is exactly the post-2025 account set (CC-INS-7)', () => {
  // This array is not decoration: `get_account_insights` builds its zod enum
  // from it and prints it verbatim in the tool description, so it is both the
  // gate that rejects retired names and the menu the model reads. Re-admitting
  // a metric Meta deleted (`profile_views`) makes Graph reject the whole
  // request — the operator loses all eleven metrics, not just the bad one —
  // and a dropped name silently vanishes from every default report.
  assert.deepEqual(
    [...ACCOUNT_METRICS],
    [
      'views',
      'reach',
      'accounts_engaged',
      'total_interactions',
      'likes',
      'comments',
      'shares',
      'saves',
      'replies',
      'follows_and_unfollows',
      'profile_links_taps',
    ],
  );
});

test('the media metric vocabularies match the per-product-type matrix (CC-INS-2)', () => {
  // `MEDIA_METRICS` backs the `get_media_insights` zod enum, and the matrix is
  // the only client-side guard that stops a doomed call from being spent
  // against the rate limit. A row that loses a metric turns a legal request
  // into a refusal the operator cannot override; a default set that loses
  // `total_interactions` quietly drops the headline engagement number from
  // every media report that names no metrics.
  assert.deepEqual(
    [...MEDIA_METRICS],
    [
      'views',
      'reach',
      'likes',
      'comments',
      'saved',
      'shares',
      'total_interactions',
      'navigation',
      'replies',
    ],
  );
  assert.deepEqual(
    [...DEFAULT_MEDIA_METRICS],
    ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
  );
  assert.deepEqual(
    { ...MEDIA_METRIC_MATRIX },
    {
      FEED: ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
      REELS: ['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
      STORY: ['views', 'reach', 'replies', 'shares', 'total_interactions', 'navigation'],
    },
  );
});

test('the period and metric_type vocabularies stay exactly the sets Graph accepts (CC-INS-7)', () => {
  // These two arrays back two *different* query parameters on the same call, and
  // `get_account_insights` turns each into a zod enum, so each is simultaneously
  // the gate and the menu the model reads.
  //
  // `ACCOUNT_PERIODS` losing `days_28` deletes the monthly rollup from the
  // vocabulary outright: nothing rejects it upstream at Graph, the model simply
  // can no longer ask for it, and an operator who wants a four-week aggregate
  // silently gets a daily series instead — wrong numbers, no error.
  //
  // `METRIC_TYPES` gaining a period name such as `lifetime` is the mirror
  // failure. It reads plausibly next to `total_value`, but `lifetime` belongs to
  // `period`, so the model can build `metric_type=lifetime`; Graph then rejects
  // the entire request and the operator sees an opaque API error for a
  // combination the client offered and should have refused itself.
  assert.deepEqual([...ACCOUNT_PERIODS], ['day', 'week', 'days_28']);
  assert.deepEqual([...METRIC_TYPES], ['total_value', 'time_series']);
});

test('the demographics breakdown and timeframe vocabularies stay complete (CC-INS-7)', () => {
  // Same failure mode as the two above, one call further out: `breakdown` and
  // `timeframe` are both required query parameters on
  // `/{ig-id}/insights?metric=follower_demographics`, and
  // `get_audience_demographics` turns each array into a zod enum — so a member
  // dropped here is a question the model can no longer ask at all.
  //
  // Dropping `country` costs the only country-level cut of the audience, and
  // `city` does not substitute for it: the city breakdown returns a top-N slice
  // of city names, so a market that is spread across many small cities vanishes
  // from the answer entirely rather than being reported at a coarser grain.
  //
  // Dropping `this_week` costs the only in-flight window in the list. Every
  // remaining timeframe is either a closed period (`prev_month`, `this_month`)
  // or a trailing multi-week aggregate, so an operator asking "what has this
  // week done so far" gets silently answered about a different span.
  //
  // Both arrays are pinned by value rather than by length: a swapped or renamed
  // member is exactly as wrong as a missing one, and the enum would still be the
  // same size.
  assert.deepEqual([...DEMOGRAPHIC_BREAKDOWNS], ['age', 'gender', 'city', 'country']);
  assert.deepEqual(
    [...DEMOGRAPHIC_TIMEFRAMES],
    ['last_14_days', 'last_30_days', 'last_90_days', 'prev_month', 'this_month', 'this_week'],
  );
});

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

test('getAccountInsights clamps a since-only window and says so (CC-INS-3)', async () => {
  // `until` is optional — asking only "since <date>" is the ordinary way to
  // pull "everything you still have". The retention guard has to run on that
  // shape too, or a 200-day-old `since` is forwarded verbatim, Graph silently
  // answers with the last 90 days, and `window.clamped: false` tells the model
  // the range it asked for is the range it got. The note is the operator's only
  // signal that the numbers cover a shorter period than requested.
  const { req, calls } = recordingReq(accountWire);
  const since = NOW_SEC - 200 * DAY;
  const res = await getAccountInsights(req, { accountId: '123', since, nowMs: NOW_MS });

  assert.equal(res.window.clamped, true);
  assert.equal(res.window.since, RETENTION_FLOOR_SEC);
  assert.equal(res.window.until, undefined);
  assert.equal(calls[0]!.params?.since, RETENTION_FLOOR_SEC);
  assert.equal(calls[0]!.params?.until, undefined);
  assert.deepEqual(res.notes, [CLAMP_NOTE]);
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

test('getAccountInsights accepts a window ending exactly on the retention floor (CC-INS-3)', async () => {
  // The floor is the oldest second Meta still retains, so a window that ends on
  // it is the last one that still has data. Refusing it would tell an operator
  // "entirely outside retention" about a range that is not, and leave them no
  // way to ask for that day at all. Only a window ending strictly before the
  // floor is genuinely empty.
  const { req, calls } = recordingReq(accountWire);
  const since = RETENTION_FLOOR_SEC - 10 * DAY;
  const until = RETENTION_FLOOR_SEC;
  const res = await getAccountInsights(req, { accountId: '123', since, until, nowMs: NOW_MS });

  assert.equal(calls.length, 1);
  assert.equal(res.window.since, RETENTION_FLOOR_SEC);
  assert.equal(res.window.until, RETENTION_FLOOR_SEC);
  assert.equal(res.window.clamped, true);
  assert.deepEqual(res.notes, [CLAMP_NOTE]);
});

test('getAccountInsights throws validation when no account id is resolved', async () => {
  // The refusal text is the whole product here: this error is thrown before any
  // network call, so nothing else will ever tell the operator what went wrong.
  // "No Instagram account ID resolved for this profile." alone states a fact and
  // stops — the reader has no idea whether they are missing a setting, a
  // permission, or a Business-account upgrade. The second sentence names the
  // exact variable to set and the edge it unblocks, which turns a dead end into
  // a one-line fix, so it is asserted verbatim rather than by `kind` alone.
  const { req, calls } = recordingReq(accountWire);
  await assert.rejects(
    () => getAccountInsights(req, {}),
    (e: unknown) =>
      isInstagramError(e) && e.kind === 'validation' && e.message === NO_ACCOUNT_ID_MESSAGE,
  );
  assert.equal(calls.length, 0);
});

test('getAccountInsights rejects an empty account id instead of requesting //insights', async () => {
  // An unset `IG_ACCOUNT_ID` reaches this layer as `''`, not `undefined`. If the
  // empty string slips through, the path builds as `//insights`, Graph answers
  // with an opaque "Unsupported get request", and the operator is sent hunting
  // for a permissions problem when the real fix is one environment variable.
  // Refuse locally and spend no call.
  const { req, calls } = recordingReq(accountWire);
  await assert.rejects(
    () => getAccountInsights(req, { accountId: '' }),
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

test('getMediaInsights matches media_product_type case-insensitively when refusing a metric', async () => {
  // `media_product_type` arrives from Graph and from operators in whatever case
  // they happen to have it (`story`, `Story`, `STORY`). With a case-sensitive
  // lookup a lowercase type falls straight through the unknown-type escape
  // hatch (CC-DATA-6) and CC-INS-2 stops guarding anything: the bad combination
  // ships, Graph rejects it, and a rate-limited call is burned for an error the
  // client already knew how to name.
  const { req, calls } = recordingReq(mediaWire);
  await assert.rejects(
    () => getMediaInsights(req, { mediaId: 'm1', metrics: ['likes'], mediaProductType: 'story' }),
    (e: unknown) =>
      isInstagramError(e) &&
      e.kind === 'validation' &&
      e.message ===
        'Metric(s) likes are not valid for media_product_type STORY. Valid metrics for this type: views, reach, replies, shares, total_interactions, navigation.',
  );
  assert.equal(calls.length, 0);
});

test('the refusal names only the offending metrics, not the whole request (CC-INS-2)', async () => {
  // The message is what the model reads to repair its own call, so it has to
  // separate the one bad metric from the six good ones. Listing everything that
  // was requested makes a request that was wrong in one place read as wrong in
  // all of them: the model drops `views` and `reach` too, or abandons the media
  // entirely, although both are perfectly valid for a FEED post. It is also
  // self-contradictory — `views` would appear as "not valid" and again in the
  // "Valid metrics for this type" sentence of the same string. The existing
  // single-metric case cannot see this (with one metric, the offenders and the
  // request are the same list), so a mixed request is the only witness.
  const { req, calls } = recordingReq(mediaWire);
  await assert.rejects(
    () =>
      getMediaInsights(req, {
        mediaId: 'm1',
        metrics: ['views', 'navigation', 'reach'],
        mediaProductType: 'FEED',
      }),
    (e: unknown) =>
      isInstagramError(e) &&
      e.kind === 'validation' &&
      e.message ===
        'Metric(s) navigation are not valid for media_product_type FEED. Valid metrics for this type: views, reach, likes, comments, saved, shares, total_interactions.',
  );
  assert.equal(calls.length, 0);

  // Several offenders are joined into one refusal so the model can fix them in a
  // single retry instead of discovering them one wasted call at a time.
  assert.throws(
    () => validateMediaMetrics(['views', 'navigation', 'replies'], 'FEED'),
    (e: unknown) =>
      isInstagramError(e) &&
      e.message.startsWith('Metric(s) navigation, replies are not valid for media_product_type '),
  );
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
  // A blank `media_product_type` is a missing hint, not a product type: media
  // rows reach us with `''` when the field was never populated, and the caller
  // meant "I don't know", not "validate me against a type called empty string".
  // It has to behave exactly like `undefined` — no refusal, Meta stays the
  // authority — or a story's `navigation` becomes unaskable whenever the type
  // hint happens to be blank.
  assert.doesNotThrow(() => validateMediaMetrics(['navigation'], ''));
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

test('getAudienceDemographics refuses an unresolved account id before spending a call', async () => {
  // Demographics address the same `/{ig-id}/insights` edge as the account
  // reader, so they need the same guard — and it is easy to leave out, because
  // the id is optional in the params type and TypeScript is perfectly happy to
  // interpolate `undefined` into a path. Without the guard this call goes out as
  // `/undefined/insights` (or `//insights` for the `''` an unset IG_ACCOUNT_ID
  // actually produces), Graph answers with an opaque "Unsupported get request",
  // and the operator hunts a permissions bug — having burned a rate-limited call
  // to learn nothing the client could not have told them for free. Asserting the
  // full message pins that the refusal also carries its remediation sentence.
  const missing = recordingReq(demoWire);
  await assert.rejects(
    () => getAudienceDemographics(missing.req, { breakdown: 'country', timeframe: 'this_week' }),
    (e: unknown) =>
      isInstagramError(e) && e.kind === 'validation' && e.message === NO_ACCOUNT_ID_MESSAGE,
  );
  assert.equal(missing.calls.length, 0);

  const blank = recordingReq(demoWire);
  await assert.rejects(
    () =>
      getAudienceDemographics(blank.req, {
        accountId: '',
        breakdown: 'age',
        timeframe: 'last_14_days',
      }),
    (e: unknown) =>
      isInstagramError(e) && e.kind === 'validation' && e.message === NO_ACCOUNT_ID_MESSAGE,
  );
  assert.equal(blank.calls.length, 0);
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

test('every insights reader reports no metrics rather than crashing on a data-less body', async () => {
  // An account with too little activity gets `{}` back from the insights edge
  // instead of `{ data: [] }`. Each reader must degrade to an empty metric list:
  // a TypeError here surfaces to the caller as "insights are broken" when the
  // truthful answer is "this account has nothing to report yet".
  const account = recordingReq({});
  const media = recordingReq({});
  const demographics = recordingReq({});
  const online = recordingReq({});

  assert.deepEqual((await getAccountInsights(account.req, { accountId: '123' })).metrics, []);
  assert.deepEqual((await getMediaInsights(media.req, { mediaId: '9' })).metrics, []);
  assert.deepEqual(
    (
      await getAudienceDemographics(demographics.req, {
        accountId: '123',
        breakdown: 'country',
        timeframe: 'this_month',
      })
    ).metrics,
    [],
  );
  assert.deepEqual((await getOnlineFollowers(online.req, { accountId: '123' })).metrics, []);
});

test('getOnlineFollowers throws validation without an account id', async () => {
  const { req } = recordingReq(onlineWire);
  await assert.rejects(
    () => getOnlineFollowers(req, {}),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );
});
