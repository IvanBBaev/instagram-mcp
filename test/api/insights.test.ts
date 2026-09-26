import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
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
  DEMOGRAPHIC_METRICS,
  DEMOGRAPHIC_TIMEFRAMES,
  MEDIA_METRICS,
  MEDIA_METRIC_MATRIX,
  METRIC_TYPES,
  TIME_SERIES_ACCOUNT_METRICS,
} from '../../src/api/insights.js';
import * as insightsModule from '../../src/api/insights.js';
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

// A row for EVERY default account metric, so the window and request tests below
// see no missing-metric note; the partial answer has tests of its own.
const accountWire = {
  data: [
    { name: 'views', period: 'day', title: 'Views', total_value: { value: 1000 } },
    { name: 'reach', period: 'day', total_value: { value: 800 } },
    ...ACCOUNT_METRICS.slice(2).map((name) => ({
      name,
      period: 'day',
      total_value: { value: 1 },
    })),
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

/** The missing-metric note, spelled out so a reworded note fails here. */
function missingNote(names: readonly string[]): string {
  return (
    `Instagram returned no data for the requested metric(s): ${names.join(', ')}. ` +
    'They are absent from metrics, not zero.'
  );
}

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY = 24 * 60 * 60;

/** The 90-day retention floor for `NOW_MS`, pinned to a literal 90 rather than the source constant. */
const RETENTION_FLOOR_SEC = NOW_SEC - 90 * DAY;
const CLAMP_NOTE =
  '`since` was clamped to the 90-day retention floor; data older than that is not retained by Meta.';
/** The out-of-retention refusal, both sentences, with `90` spelled out literally. */
const OUT_OF_WINDOW_MESSAGE =
  'Requested insights window is entirely outside the 90-day retention limit. Account metrics are only available for the last 90 days.';

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

test('the demographics metric vocabulary stays exactly the two Meta serves (CC-INS-7)', () => {
  // `DEMOGRAPHIC_METRICS` is the only member of this module's vocabulary set
  // that no other assertion in this file touches, because
  // `getAudienceDemographics` hard-codes its own default and never reads the
  // array — the array's only consumer is the zod enum in
  // `tools/insights.ts:get_audience_demographics`. That makes it the one
  // vocabulary that can rot in complete silence.
  //
  // Losing `engaged_audience_demographics` takes away the only cut of the
  // audience that describes the people who actually interacted, leaving nothing
  // but the follower list; the model cannot ask for it at all, and no error
  // explains the absence. A renamed or invented member is the mirror failure:
  // it is offered to the model as if it were real, Graph rejects the metric, and
  // the operator sees an opaque API error for a name this client advertised.
  assert.deepEqual(
    [...DEMOGRAPHIC_METRICS],
    ['follower_demographics', 'engaged_audience_demographics'],
  );
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
  // The options WHOLE, where three `assert.equal`s used to read method, path and
  // `params.metric`. Not because a mutant escapes today: `idempotent: false`
  // planted on the options literal in `api/insights.ts` — which strips the
  // 429/5xx retry off the account-reporting read — was measured, and it dies in
  // the clamp test at :457, whose own `deepEqual(clamped.calls[0], ...)` happens
  // to carry the whole record. That is the point. The test NAMED for this
  // request's shape could not see the key, so the module's request contract was
  // being held by a test about `since: 0`, and would have gone unheld the moment
  // that test was retargeted at the clamp it is actually about. `since`/`until`
  // are spelled out because the source sets them unconditionally: deepStrictEqual
  // compares key SETS, so writing them is what makes a dropped key fail rather
  // than pass.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/123/insights',
    params: {
      metric: ACCOUNT_METRICS.join(','),
      period: 'day',
      metric_type: 'total_value',
      since: undefined,
      until: undefined,
    },
  });
  // The result WHOLE, not four of its fields. This is the account-reporting
  // surface — every other insights reader in this module has its result pinned
  // whole somewhere (`res.structuredContent` at test/tools/insights.test.ts:589
  // and :616, `Object.keys(res)` at test/api/media.test.ts:200), and this one did
  // not: reading `metrics`, `paging`, `window.clamped` and `notes` one at a time
  // is blind to a fifth field ADDED to the return. A `debugQuery` planted on this
  // exact line survived all 78 tests across both insights files while the same
  // field on the other three readers was killed immediately — the difference was
  // entirely in how the test looked, not in how the code behaved.
  assert.deepEqual(res, {
    metrics: accountWire.data,
    window: { since: undefined, until: undefined, clamped: false },
    notes: [],
    paging: accountWire.paging,
  });
});

test('getAccountInsights forwards explicit metrics, period, metric_type and an in-window range', async () => {
  const { req, calls } = recordingReq(accountWire);
  const since = NOW_SEC - 10 * DAY;
  const until = NOW_SEC;
  await getAccountInsights(req, {
    accountId: '123',
    metrics: ['reach'],
    period: 'week',
    metricType: 'time_series',
    since,
    until,
    nowMs: NOW_MS,
  });

  const opts = calls[0]!;
  assert.equal(opts.params?.metric, 'reach');
  assert.equal(opts.params?.period, 'week');
  assert.equal(opts.params?.metric_type, 'time_series');
  assert.equal(opts.params?.since, since);
  assert.equal(opts.params?.until, until);
});

const TIME_SERIES_REFUSAL = (names: string): string =>
  `Metric(s) ${names} are not available with metric_type time_series. Instagram serves a time series only for: reach. Request the other metrics with metric_type total_value.`;

test('time_series is served for reach alone: the list is pinned (CC-INS-25)', () => {
  // Meta's metrics table gives `total_value` as the only metric type of every
  // account metric but `reach`. Adding a member here offers the model a
  // combination Graph rejects as a whole call.
  assert.deepEqual([...TIME_SERIES_ACCOUNT_METRICS], ['reach']);
});

test('time_series with no explicit metrics asks for reach, not all eleven (CC-INS-25)', async () => {
  // The default used to be ACCOUNT_METRICS whatever the metric_type, so the
  // most natural series call — "give me a time series" — went out as eleven
  // metrics of which ten Graph serves only as a total, and the whole request
  // came back as a Graph error for a combination this server had chosen.
  const { req, calls } = recordingReq({ data: [{ name: 'reach', values: [{ value: 3 }] }] });
  const res = await getAccountInsights(req, { accountId: '9', metricType: 'time_series' });
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/9/insights',
    params: {
      metric: 'reach',
      period: 'day',
      metric_type: 'time_series',
      since: undefined,
      until: undefined,
    },
  });
  assert.deepEqual(res.notes, []);
  assert.equal('missingMetrics' in res, false);
});

test('time_series with a total-only metric is refused before a call is spent (CC-INS-25)', async () => {
  for (const [metrics, named] of [
    [['views'], 'views'],
    [['reach', 'likes', 'saves'], 'likes, saves'],
    [[...ACCOUNT_METRICS], ACCOUNT_METRICS.filter((m) => m !== 'reach').join(', ')],
  ] as const) {
    const { req, calls } = recordingReq(accountWire);
    await assert.rejects(
      () => getAccountInsights(req, { accountId: '9', metrics, metricType: 'time_series' }),
      (err: unknown) =>
        isInstagramError(err) &&
        err.kind === 'validation' &&
        err.message === TIME_SERIES_REFUSAL(named),
      `metrics: ${metrics.join(',')}`,
    );
    assert.equal(calls.length, 0);
  }
});

test('total_value still takes every account metric, reach included (CC-INS-25)', async () => {
  const { req, calls } = recordingReq(accountWire);
  await getAccountInsights(req, { accountId: '9', metrics: ['reach'], metricType: 'total_value' });
  await getAccountInsights(req, { accountId: '9', metrics: ['views', 'likes'] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.params?.metric_type, 'total_value');
});

test('a window that ends before it starts is refused, with or without a clock (CC-INS-26)', async () => {
  // Graph documents no answer for since > until; spent, the call is at best an
  // empty result that reads like an idle account (the CC-INS-8 shape).
  for (const nowMs of [NOW_MS, undefined]) {
    const { req, calls } = recordingReq(accountWire);
    await assert.rejects(
      () =>
        getAccountInsights(req, {
          accountId: '9',
          since: NOW_SEC - DAY,
          until: NOW_SEC - DAY - 1,
          nowMs,
        }),
      (err: unknown) =>
        isInstagramError(err) &&
        err.kind === 'validation' &&
        err.message ===
          `\`since\` (${NOW_SEC - DAY}) is after \`until\` (${NOW_SEC - DAY - 1}); the insights window must start before it ends.`,
    );
    assert.equal(calls.length, 0);
  }
});

test('an inverted window is refused as inverted, not as out of retention (CC-INS-26)', async () => {
  const { req } = recordingReq(accountWire);
  await assert.rejects(
    () =>
      getAccountInsights(req, {
        accountId: '9',
        since: RETENTION_FLOOR_SEC - DAY,
        until: RETENTION_FLOOR_SEC - 2 * DAY,
        nowMs: NOW_MS,
      }),
    /is after `until`/,
  );
});

test('equal since and until are a valid one-instant window (CC-INS-26)', async () => {
  const { req, calls } = recordingReq(accountWire);
  await getAccountInsights(req, { accountId: '9', since: NOW_SEC, until: NOW_SEC, nowMs: NOW_MS });
  assert.equal(calls[0]?.params?.since, NOW_SEC);
  assert.equal(calls[0]?.params?.until, NOW_SEC);
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
  // The message is asserted whole, not just its `kind`. This refusal replaces an
  // answer the operator expected, so it has to say why nothing came back AND how
  // far back data does exist — "outside the retention limit" alone leaves them
  // re-trying dates blindly. Both sentences name the 90-day figure, so a message
  // that loses one of them stops carrying the number the caller needs to repair
  // the request.
  const { req, calls } = recordingReq(accountWire);
  const since = NOW_SEC - 200 * DAY;
  const until = NOW_SEC - 120 * DAY;
  await assert.rejects(
    () => getAccountInsights(req, { accountId: '123', since, until, nowMs: NOW_MS }),
    (e: unknown) =>
      isInstagramError(e) && e.kind === 'validation' && e.message === OUT_OF_WINDOW_MESSAGE,
  );
  assert.equal(calls.length, 0);
});

test('getAccountInsights refuses an until-only window that ends before the floor (CC-INS-3)', async () => {
  // `since` is optional, so "everything up to <date>" is a shape the tool's zod
  // schema accepts on its own. When that `until` is already older than the
  // retention floor the range holds no retained data at all — exactly the case
  // the refusal exists for — but the guard used to demand that BOTH bounds be
  // present before it would fire, so this shape sailed past it. The call went
  // out, Graph answered with an empty `data` array, and the model reported "no
  // insights" for an account that simply has none that old: a rate-limited call
  // spent to produce a result indistinguishable from a genuinely idle account,
  // and a direct contradiction of the tool's own documented promise that "a
  // fully-old range is rejected".
  const { req, calls } = recordingReq(accountWire);
  await assert.rejects(
    () => getAccountInsights(req, { accountId: '123', until: NOW_SEC - 120 * DAY, nowMs: NOW_MS }),
    (e: unknown) =>
      isInstagramError(e) && e.kind === 'validation' && e.message === OUT_OF_WINDOW_MESSAGE,
  );
  assert.equal(calls.length, 0);

  // The mirror direction: an until-only window that still reaches into
  // retention is ordinary and must go out untouched — nothing to clamp, because
  // there is no `since` to move.
  const ok = recordingReq(accountWire);
  const until = NOW_SEC - DAY;
  const res = await getAccountInsights(ok.req, { accountId: '123', until, nowMs: NOW_MS });
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0]!.params?.until, until);
  assert.equal(res.window.clamped, false);
  assert.deepEqual(res.notes, []);
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

test('getAccountInsights leaves a since sitting exactly on the floor unflagged (CC-INS-3)', async () => {
  // The floor is still inside retention, so a `since` equal to it is honoured
  // verbatim — nothing was moved, and the response must not claim otherwise.
  // Clamping at the boundary instead of strictly below it is invisible in the
  // outgoing request (the value is rewritten to itself) but very visible to the
  // caller: `clamped: true` plus a note telling the operator their range was
  // shortened, about a range that was answered exactly as asked. That is a false
  // warning, and a model reading it will narrow the next request for no reason.
  const { req, calls } = recordingReq(accountWire);
  const res = await getAccountInsights(req, {
    accountId: '123',
    since: RETENTION_FLOOR_SEC,
    until: NOW_SEC,
    nowMs: NOW_MS,
  });

  assert.equal(calls[0]!.params?.since, RETENTION_FLOOR_SEC);
  assert.equal(res.window.since, RETENTION_FLOOR_SEC);
  assert.equal(res.window.clamped, false);
  assert.deepEqual(res.notes, []);

  // One second older is genuinely past the floor and must clamp, so the
  // boundary is pinned from both sides rather than by a single sample.
  const older = recordingReq(accountWire);
  const olderRes = await getAccountInsights(older.req, {
    accountId: '123',
    since: RETENTION_FLOOR_SEC - 1,
    until: NOW_SEC,
    nowMs: NOW_MS,
  });
  assert.equal(olderRes.window.clamped, true);
  assert.equal(olderRes.window.since, RETENTION_FLOOR_SEC);
});

test('the retention floor is a whole second even when the clock is mid-millisecond', async () => {
  // `nowMs` comes from `ctx.clock.now()`, i.e. `Date.now()` — a wall-clock
  // reading that is almost never a round multiple of 1000. The other retention
  // tests all use a fixture that happens to be one, so they cannot see whether
  // the millisecond remainder is dropped. It has to be: the clamped value is
  // written straight into `window.since` and into the outgoing `since` query
  // parameter, and a fractional epoch reaches Graph as `1692224000.999` — not a
  // Unix timestamp, and rejected as a malformed range rather than answered.
  // Rounding the remainder UP instead of away is the subtler half: it moves the
  // floor a second newer than Meta's, so the oldest second that still has data
  // is refused as "entirely outside retention".
  //
  // The remainder is 999 rather than something smaller, and that is the whole of
  // the fixture. Measured 2026-09-23 against the `+ 137` it used to be:
  // `Math.round` in place of `Math.floor` rounds .137 DOWN to the same second,
  // so the mutant passed this test and every other one — the old fixture told
  // `Math.ceil` apart from `Math.floor` and nothing else, while the sentence
  // above claims to pin rounding up in general. A remainder over half a second
  // puts both `round` and `ceil` one second newer than `floor`, so all three are
  // now distinguishable here (CC-PROC-192).
  const oddMs = NOW_MS + 999;
  const floor = Math.floor(oddMs / 1000) - 90 * DAY;

  const { req, calls } = recordingReq(accountWire);
  const res = await getAccountInsights(req, {
    accountId: '123',
    since: floor - DAY,
    until: NOW_SEC,
    nowMs: oddMs,
  });
  assert.equal(res.window.since, floor);
  assert.equal(calls[0]!.params?.since, floor);
  assert.equal(Number.isInteger(res.window.since), true);

  // A window ending exactly on that floor is still inside retention. Rounding
  // the clock up would push the floor past `until` and refuse this outright.
  const edge = recordingReq(accountWire);
  await getAccountInsights(edge.req, {
    accountId: '123',
    since: floor - DAY,
    until: floor,
    nowMs: oddMs,
  });
  assert.equal(edge.calls.length, 1);
});

test('a clock-less call runs no retention logic at all, whatever the epochs say', async () => {
  // `nowMs` is optional on every reader here, and the CC-INS-3 block is gated on
  // it: with no clock there is no floor to compare against, so a window that
  // ends in 1970 is neither refused nor clamped and the epochs reach Graph
  // exactly as the caller wrote them. That is the rule the gate states, and this
  // is the only test that exercises it — every other retention test supplies a
  // clock, and every clock-less test supplies no window.
  //
  // Measured 2026-09-23: dropping the `params.nowMs !== undefined` arm together
  // with a `?? Date.now()` default survived the entire suite, 1979 pass and 0
  // fail. Under that mutant this exact call is refused outright, because the
  // window ends long before any floor derived from the machine's real wall
  // clock — so a caller that deliberately withheld a clock is told its range
  // sits outside a retention limit it never asked anyone to measure, before a
  // call is spent. The arm cannot be dropped on its own at all (the compiler
  // refuses it), which is why the pair is what gets pinned (CC-PROC-192).
  const ancientSince = 1;
  const ancientUntil = 2 * DAY;

  const { req, calls } = recordingReq(accountWire);
  const res = await getAccountInsights(req, {
    accountId: '123',
    since: ancientSince,
    until: ancientUntil,
  });

  assert.deepEqual(res.window, { since: ancientSince, until: ancientUntil, clamped: false });
  assert.deepEqual(res.notes, []);
  assert.equal(calls[0]?.params?.since, ancientSince);
  assert.equal(calls[0]?.params?.until, ancientUntil);
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

test('getAccountInsights treats since: 0 and until: 0 as present bounds, not as absent ones (CC-PROC-46)', async () => {
  // `since`/`until` are Unix seconds and the tool schema admits any integer, so
  // `0` — "from the epoch", the model's natural spelling of "everything you
  // have" — reaches this layer as a real bound. It is also falsy, and every
  // retention fixture above is a large positive timestamp, so a truthiness
  // guard on either bound (`if (until && …)`, `if (since || until)`) passes the
  // whole suite while treating the epoch as "no bound given". The consequences
  // are the two failures the retention guard exists to prevent: `until: 0` goes
  // out to Graph instead of being refused locally (a rate-limited call spent on
  // a window that cannot hold data, answered with a silent empty result), and
  // `since: 0` is forwarded verbatim with `clamped: false`, so Graph quietly
  // truncates to 90 days and the model is told it got the range it asked for.
  const refused = recordingReq(accountWire);
  await assert.rejects(
    () => getAccountInsights(refused.req, { accountId: '123', until: 0, nowMs: NOW_MS }),
    (e: unknown) =>
      isInstagramError(e) && e.kind === 'validation' && e.message === OUT_OF_WINDOW_MESSAGE,
  );
  assert.equal(refused.calls.length, 0);

  const clamped = recordingReq(accountWire);
  const res = await getAccountInsights(clamped.req, { accountId: '123', since: 0, nowMs: NOW_MS });

  assert.deepEqual(clamped.calls[0], {
    method: 'GET',
    path: '/123/insights',
    params: {
      metric:
        'views,reach,accounts_engaged,total_interactions,likes,comments,shares,saves,replies,follows_and_unfollows,profile_links_taps',
      period: 'day',
      metric_type: 'total_value',
      since: RETENTION_FLOOR_SEC,
      until: undefined,
    },
  });
  assert.deepEqual(res.window, { since: RETENTION_FLOOR_SEC, until: undefined, clamped: true });
  assert.deepEqual(res.notes, [CLAMP_NOTE]);

  // Both bounds at the epoch: the END decides, so this is a refusal, not a clamp.
  const both = recordingReq(accountWire);
  await assert.rejects(
    () => getAccountInsights(both.req, { accountId: '123', since: 0, until: 0, nowMs: NOW_MS }),
    (e: unknown) =>
      isInstagramError(e) && e.kind === 'validation' && e.message === OUT_OF_WINDOW_MESSAGE,
  );
  assert.equal(both.calls.length, 0);
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

  // Whole, on the same grounds as the account read above: an added `params` key
  // does die today, but in the `media_product_type` near-miss test named below,
  // which
  // pins the call record whole inside a loop about something else entirely. This
  // reader sends no `period` and no `metric_type` — media metrics are per-post
  // lifetime values — so any key appearing here is a change to what the server
  // asks Meta for, never a caller's doing, and the test named for that is this
  // one.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/m1/insights',
    params: { metric: DEFAULT_MEDIA_METRICS.join(',') },
  });

  // The RESULT is pinned whole for the added-field reason of CC-INS-13 and
  // CC-AUTH-34: `res.mediaId` and `res.metrics` read member by member cannot see
  // a THIRD key appear on the return. Measured 2026-09-23 — a typed local plus
  // `Object.assign(out, { mutationExtraKey: 1 })` on this reader passed all 38
  // tests in this file and went red only in `test/tools/insights.test.ts`, on a
  // whole-`structuredContent` pin written for another purpose entirely.
  // Protection on loan is not protection (CC-PROC-182), so the shape of the
  // return is stated where the return is made.
  // `mediaWire` answers `views` alone, so the six other default metrics are
  // named as missing rather than silently absent.
  const missing = ['reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'];
  assert.deepEqual(res, {
    mediaId: 'm1',
    metrics: mediaWire.data,
    missingMetrics: missing,
    note: missingNote(missing),
  });
});

test('a story with no explicit metrics asks for the story row, not the feed row (CC-INS-14)', async () => {
  // Measured 2026-09-23: `getMediaInsights({ mediaId, mediaProductType: 'STORY' })`
  // with no `metrics` threw `InstagramError kind=validation` every single time,
  // before spending a call. The default set carries `likes`, `comments` and
  // `saved`; the STORY row of the matrix carries none of the three, so the api
  // layer refused a request the caller had not made. The tool description sells
  // `media_product_type` as an early refusal of the combinations a CALLER got
  // wrong, and there was no spelling of "story insights, please" that worked
  // except naming all six story metrics by hand. Nothing saw it because every
  // story test above supplies explicit metrics and every default-metrics test
  // omits the product type.
  const { req, calls } = recordingReq(mediaWire);
  const res = await getMediaInsights(req, { mediaId: 'm1', mediaProductType: 'story' });

  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/m1/insights',
    params: { metric: 'views,reach,replies,shares,total_interactions,navigation' },
  });
  assert.deepEqual(res.metrics, mediaWire.data);

  // The other half of the claim, and the reason this test is not satisfied by
  // the STORY row alone: a recognised type whose row happens to equal the
  // default set, and an unrecognised one that has no row at all, must still put
  // the default set on the wire character for character. Without these a
  // "default" that had quietly become the story row for everything would read
  // here as a pass.
  for (const mediaProductType of ['FEED', 'REELS', 'NEW_META_TYPE']) {
    const other = recordingReq(mediaWire);
    await getMediaInsights(other.req, { mediaId: 'm1', mediaProductType });
    assert.equal(
      other.calls[0]?.params?.metric,
      DEFAULT_MEDIA_METRICS.join(','),
      `${mediaProductType} must still ask for the default set`,
    );
  }
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

test('a near-miss media_product_type is an unknown type, not the type it resembles (CC-DATA-6)', async () => {
  // The matrix lookup is an exact match on the upper-cased string. The existing
  // cases supply the exact names (`story`, `FEED`, `REELS`) and one totally
  // different one (`NEW_META_TYPE`), so a lookup rewritten as a prefix match, a
  // substring match, or one that trims first would pass all of them. Each of
  // those turns a value Meta never defined into a validation verdict: with a
  // prefix match `STORY_HIGHLIGHT` — or whatever Meta adds next that happens to
  // share a prefix — is refused the metrics of a plain story, and with a trim a
  // stray space silently changes which vocabulary the request is judged by. The
  // open-vocabulary rule is the only safe reading of an unrecognised string:
  // spend the call and let Graph answer.
  const nearMisses = [
    ' STORY',
    'STORY ',
    '\tSTORY\n',
    'STORY_HIGHLIGHT',
    'STORYX',
    'MY_STORY',
    'FEED_AD',
    'AD_FEED',
    'REELS2',
    'PROMOTED_REELS',
  ];
  for (const mediaProductType of nearMisses) {
    // `likes` is invalid for STORY, `navigation` for FEED/REELS: a lookup that
    // resolved any near miss to its look-alike would refuse at least one of them.
    assert.doesNotThrow(
      () => validateMediaMetrics(['likes', 'navigation'], mediaProductType),
      `near miss ${JSON.stringify(mediaProductType)} was treated as a known type`,
    );

    const { req, calls } = recordingReq(mediaWire);
    await getMediaInsights(req, {
      mediaId: 'm1',
      metrics: ['likes', 'navigation'],
      mediaProductType,
    });
    assert.deepEqual(calls, [
      { method: 'GET', path: '/m1/insights', params: { metric: 'likes,navigation' } },
    ]);
  }
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
  // The request is pinned as ONE record — the options object and its `params`
  // together — rather than key by key, because key-by-key reads cannot see a
  // query parameter that was ADDED. Measured before this equality existed:
  // adding `period: 'day'` to the `params` literal in `api/insights.ts` ran the
  // api, tools and registry suites with 479 tests passing, 0 failures and exit 0.
  // That extra key is a live wire change — `follower_demographics` is a lifetime
  // `total_value` metric, and a `period` other than `lifetime` makes Graph answer
  // a different question (or reject the call outright) while every assertion
  // here still reads the keys it knows about. The key the record DOES carry is
  // `period: 'lifetime'`: Meta's reference marks `period` required and lists
  // `lifetime` as the only period of both demographics metrics, and the request
  // used to leave it out altogether (CC-INS-27). The same run came
  // back green for `idempotent: false` on the options object, which would strip
  // the 429/5xx retry off a read. Spelling out the whole record fails on both.
  assert.deepEqual(opts, {
    method: 'GET',
    path: '/123/insights',
    params: {
      metric: 'follower_demographics',
      period: 'lifetime',
      metric_type: 'total_value',
      breakdown: 'country',
      timeframe: 'last_30_days',
    },
  });

  // The result goes whole for the reason the options record just did, one layer
  // out: three member reads cannot see a FOURTH key appear on the return.
  // Measured 2026-09-23 — a typed local plus `Object.assign(out, {
  // mutationExtraKey: 1 })` was clean across all 38 tests in this file and went
  // red only in `test/tools/insights.test.ts`, which pins the handler's
  // `structuredContent` whole for reasons of its own (CC-PROC-182).
  assert.deepEqual(res, {
    metrics: demoWire.data,
    breakdown: 'country',
    timeframe: 'last_30_days',
  });
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

  // Pinned whole, for the reason recorded on the demographics request above:
  // three `assert.equal`s over named keys are blind to a key that APPEARS. This
  // reader hard-codes both of its parameters, so an addition here is never a
  // caller's doing — it is a change to what the server asks Meta for. Measured:
  // adding `breakdown: 'country'` to this `params` literal in `api/insights.ts`
  // left 479 tests passing with 0 failures and exit 0, and so did adding
  // `idempotent: false` to the options object beside it. `online_followers` is a
  // `lifetime` metric with no breakdown dimension, so that parameter buys an
  // error from Graph at best and a silently different aggregation at worst.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/123/insights',
    params: { metric: 'online_followers', period: 'lifetime' },
  });

  // And the result whole, not just its one known member. `{ metrics }` has a
  // single key today, which makes a member read look identical to a whole-object
  // pin right up until the day a second key appears — measured 2026-09-23, the
  // added-field mutant survived this entire file and died only out of lane
  // (CC-PROC-182).
  assert.deepEqual(res, { metrics: onlineWire.data });
});

// --- missing metrics and paging credentials --------------------------------

test('getAccountInsights names every requested metric Graph returned no row for', async () => {
  // Graph leaves a metric it has no data for out of `data` entirely. A partial
  // answer read row by row is indistinguishable from a complete one, so the gap
  // is listed and noted — after the clamp note, which describes the request.
  const { req } = recordingReq({
    data: [
      { name: 'views', total_value: { value: 1 } },
      // Rows that cannot be published do not count as delivered.
      null,
      { name: 7 },
      'reach',
    ],
  });
  const res = await getAccountInsights(req, {
    accountId: '123',
    metrics: ['views', 'reach', 'likes'],
    since: RETENTION_FLOOR_SEC - 5 * DAY,
    nowMs: NOW_MS,
  });
  assert.deepEqual(res.missingMetrics, ['reach', 'likes']);
  assert.deepEqual(res.notes, [CLAMP_NOTE, missingNote(['reach', 'likes'])]);
});

test('every insights reader lists all requested metrics as missing on a data-less body', async () => {
  const account = await getAccountInsights(recordingReq({}).req, {
    accountId: '123',
    metrics: ['views'],
  });
  assert.deepEqual(account.missingMetrics, ['views']);
  assert.deepEqual(account.notes, [missingNote(['views'])]);

  const demographics = await getAudienceDemographics(recordingReq({}).req, {
    accountId: '123',
    breakdown: 'country',
    timeframe: 'this_month',
  });
  assert.deepEqual(demographics, {
    metrics: [],
    breakdown: 'country',
    timeframe: 'this_month',
    missingMetrics: ['follower_demographics'],
    note: missingNote(['follower_demographics']),
  });

  const online = await getOnlineFollowers(recordingReq({ data: [] }).req, { accountId: '123' });
  assert.deepEqual(online, {
    metrics: [],
    missingMetrics: ['online_followers'],
    note: missingNote(['online_followers']),
  });
});

test('getAccountInsights strips credentials from the paging URLs it hands back', async () => {
  // Graph's `paging.next`/`previous` are full request URLs rebuilt from the
  // request it received, token included. Only the credential parameters go;
  // the rest of the URL, the cursors and non-URL strings survive as sent.
  const { req } = recordingReq({
    data: accountWire.data,
    paging: {
      cursors: { before: 'B', after: 'A' },
      next:
        'https://graph.facebook.com/v23.0/123/insights?access_token=TEST_TOKEN&metric=views' +
        '&appsecret_proof=TEST_PROOF&since=1',
      previous: 'https://graph.facebook.com/v23.0/123/insights?metric=views&until=1',
    },
  });
  const res = await getAccountInsights(req, { accountId: '123' });
  assert.deepEqual(res.paging, {
    cursors: { before: 'B', after: 'A' },
    next: 'https://graph.facebook.com/v23.0/123/insights?metric=views&since=1',
    previous: 'https://graph.facebook.com/v23.0/123/insights?metric=views&until=1',
  });
  assert.equal(JSON.stringify(res).includes('TEST_TOKEN'), false);
  assert.equal(JSON.stringify(res).includes('TEST_PROOF'), false);

  // A non-object paging is handed back as it came; the tool layer drops it.
  const odd = await getAccountInsights(recordingReq({ data: accountWire.data, paging: 'x' }).req, {
    accountId: '123',
  });
  assert.equal(odd.paging, 'x');
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

test('every insights reader issues a GET, never a write verb', async () => {
  // `method` is what makes these four functions readers. It is also the field
  // the write surface keys on: `mcp/write-mode.ts` gates by tool intent, but
  // `core/http.ts` decides retry-on-idempotent and the rate-limit bucket from
  // the verb, and a POST to `/{ig-id}/insights` is a mutating call as far as
  // Meta's rate limiter and every audit log in between are concerned. The
  // account reader already pinned its verb; these three did not, so a `method`
  // flipped by a bad merge would have changed nothing visible in this file while
  // turning four read-only tools into requests the operator never consented to.
  const account = recordingReq(accountWire);
  const media = recordingReq(mediaWire);
  const demographics = recordingReq(demoWire);
  const online = recordingReq(onlineWire);

  await getAccountInsights(account.req, { accountId: '123' });
  await getMediaInsights(media.req, { mediaId: 'm1' });
  await getAudienceDemographics(demographics.req, {
    accountId: '123',
    breakdown: 'city',
    timeframe: 'last_90_days',
  });
  await getOnlineFollowers(online.req, { accountId: '123' });

  for (const { label, calls } of [
    { label: 'getAccountInsights', calls: account.calls },
    { label: 'getMediaInsights', calls: media.calls },
    { label: 'getAudienceDemographics', calls: demographics.calls },
    { label: 'getOnlineFollowers', calls: online.calls },
  ]) {
    assert.equal(calls.length, 1, `${label}: exactly one request`);
    assert.equal(calls[0]!.method, 'GET', `${label}: reads with GET`);
  }
});

test('no insights reader pins a host — the active auth path chooses it', async () => {
  // `host` is optional on `IgRequestOptions`, and `core/http.ts` resolves it as
  // `opts.host ?? auth.defaultHost`. So a host spelled out here is not a hint,
  // it OVERRIDES whatever the operator logged in with — and the two paths do not
  // share a graph: `ig-login` mints tokens for graph.instagram.com, `fb-login`
  // for graph.facebook.com, and neither host honours the other's token. The
  // account package pins graph.facebook.com twice on purpose (`/me/accounts` and
  // `/debug_token` exist only on the Facebook graph, and the tools that expose
  // them are declared Path-B-only), which is exactly why the absence of a pin
  // here has to be asserted rather than assumed: the same line reads as
  // idiomatic in either file. docs/tools.md marks none of these four tools
  // path-specific, so `ToolSpec.paths` is undefined on all of them and no
  // capability guard above would refuse the call first — a stray host would just
  // take one of the two supported installs and fail every insights read against
  // a host that account never authenticated with.
  const account = recordingReq(accountWire);
  const media = recordingReq(mediaWire);
  const demographics = recordingReq(demoWire);
  const online = recordingReq(onlineWire);

  await getAccountInsights(account.req, { accountId: '123' });
  await getMediaInsights(media.req, { mediaId: 'm1' });
  await getAudienceDemographics(demographics.req, {
    accountId: '123',
    breakdown: 'city',
    timeframe: 'last_90_days',
  });
  await getOnlineFollowers(online.req, { accountId: '123' });

  for (const { label, calls } of [
    { label: 'getAccountInsights', calls: account.calls },
    { label: 'getMediaInsights', calls: media.calls },
    { label: 'getAudienceDemographics', calls: demographics.calls },
    { label: 'getOnlineFollowers', calls: online.calls },
  ]) {
    assert.equal(calls.length, 1, `${label}: exactly one request`);
    assert.equal(calls[0]!.host, undefined, `${label}: leaves host to the auth path`);
  }
});

test('getOnlineFollowers throws validation without an account id', async () => {
  const { req } = recordingReq(onlineWire);
  await assert.rejects(
    () => getOnlineFollowers(req, {}),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );
});

// --- Freeze contract --------------------------------------------------------
//
// Until 2026-09-23 this file pinned the MEMBERS of every vocabulary below and
// not one of their defences. `assert.deepEqual(ACCOUNT_METRICS, […])` reads the
// array once and cannot see a `push` that lands afterwards; the `readonly` in
// the declared type is erased at emit (CC-CFG-32); and `Object.isFrozen` on its
// own is a claim about a flag rather than about what the value accepts — a
// frozen `Set` answers `true` and still deletes (CC-CFG-33). So each test below
// writes first and reads back.
//
// These are not decorative tables. Every one of them is the argument to a
// `z.enum(…)` in `src/tools/insights.ts`, evaluated once when that module loads,
// and zod v3 keeps the ARRAY itself rather than a copy of it (CC-CFG-35): a
// member pushed onto one of these widens a schema that has already been built
// and advertised to the MCP client. The measurement of exactly how far that
// reaches is in `z.enum keeps the live array …` below.

/** Every flat vocabulary the module freezes, with the name to report. */
const VOCABULARIES: readonly (readonly [string, readonly string[]])[] = [
  ['ACCOUNT_METRICS', ACCOUNT_METRICS],
  ['MEDIA_METRICS', MEDIA_METRICS],
  ['DEFAULT_MEDIA_METRICS', DEFAULT_MEDIA_METRICS],
  ['DEMOGRAPHIC_METRICS', DEMOGRAPHIC_METRICS],
  ['DEMOGRAPHIC_BREAKDOWNS', DEMOGRAPHIC_BREAKDOWNS],
  ['DEMOGRAPHIC_TIMEFRAMES', DEMOGRAPHIC_TIMEFRAMES],
  ['ACCOUNT_PERIODS', ACCOUNT_PERIODS],
  ['METRIC_TYPES', METRIC_TYPES],
  ['TIME_SERIES_ACCOUNT_METRICS', TIME_SERIES_ACCOUNT_METRICS],
];

test('the list above is every array this module exports', () => {
  // A hand-written list fails on the member its author did not name
  // (CC-PROC-114), so the list is checked against the module rather than
  // against a count: a vocabulary added to `src/api/insights.ts` without a
  // freeze test fails here, naming itself.
  const exported = Object.entries(insightsModule)
    .filter(([, value]) => Array.isArray(value))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(
    exported,
    VOCABULARIES.map(([name]) => name).sort(),
    'a vocabulary was added or renamed without a freeze test',
  );
});

test('every insights vocabulary refuses a runtime write, not just a compile-time one', () => {
  for (const [name, vocabulary] of VOCABULARIES) {
    assert.ok(Object.isFrozen(vocabulary), `${name} must be frozen, not merely typed readonly`);
    const mutable = vocabulary as string[];
    const before = [...mutable];
    assert.throws(() => mutable.push('smuggled'), TypeError, `${name} accepts a push`);
    assert.throws(() => mutable.pop(), TypeError, `${name} accepts a pop`);
    assert.throws(() => mutable.splice(0, 1), TypeError, `${name} accepts a splice`);
    assert.throws(
      () => {
        mutable[0] = 'smuggled';
      },
      TypeError,
      `${name} accepts an overwrite in place`,
    );
    assert.deepEqual(mutable, before, `${name}: a write got through`);
  }
});

test('z.enum keeps the live array, which is what makes these freezes load-bearing', () => {
  // The positive control for the paragraph above, measured here rather than
  // asserted elsewhere — and measured in both halves, because the reach of the
  // mutation is not what the short version of this claim says (zod 3.25.76).
  //
  // Half one: building the schema does not seal it. A push before the schema's
  // first parse widens VALIDATION, so a vocabulary edited any time between
  // module load and the first tool call changes what the server accepts.
  const live: [string, ...string[]] = ['views', 'reach'];
  const schema = z.enum(live);
  live.push('smuggled');
  assert.equal(
    schema.safeParse('smuggled').success,
    true,
    'zod copied the array — this control measures nothing, and the freezes below prove less',
  );

  // Half two: the first parse memoises the member set, so a LATER push no longer
  // widens validation. It does not make the schema immutable, though — the
  // option list stays a live read of the array, and that list is what
  // `zod-to-json-schema` renders into the `inputSchema` the client is shown and
  // what `${ACCOUNT_METRICS.join(', ')}` renders into the tool description. A
  // push after the first parse therefore advertises a metric the server will
  // then refuse: the two halves disagree, which is worse than either.
  const sealed: [string, ...string[]] = ['views', 'reach'];
  const sealedSchema = z.enum(sealed);
  assert.equal(sealedSchema.safeParse('smuggled').success, false, 'guard: not a member yet');
  sealed.push('smuggled');
  assert.equal(
    sealedSchema.safeParse('smuggled').success,
    false,
    'guard: the memoised member set is the point of this half',
  );
  assert.deepEqual(sealedSchema.options, ['views', 'reach', 'smuggled']);

  // The real vocabularies refuse the step both halves depend on, so neither the
  // enums nor the descriptions in `src/tools/insights.ts` can drift after load.
  // The legacy names are why it matters: `impressions`, `profile_views` and
  // `video_views` were retired from the API in 2025 and are rejected on purpose.
  const metrics: readonly string[] = ACCOUNT_METRICS;
  assert.throws(() => (metrics as string[]).push('impressions'), TypeError);
  assert.equal(metrics.includes('impressions'), false, 'a retired metric got back in');
});

test('MEDIA_METRIC_MATRIX is frozen at both levels', () => {
  // Both levels, because the value that decides a verdict is the member list and
  // not the table: `validateMediaMetrics` reads
  // `MEDIA_METRIC_MATRIX[type.toUpperCase()]` and then `allowed.includes(m)`, so
  // pushing `navigation` onto the FEED list is what makes a story-only metric
  // pass for a feed post. A one-level freeze answers `true` to
  // `Object.isFrozen(MEDIA_METRIC_MATRIX)` while allowing exactly that, which is
  // why the table is frozen key by key as well (CC-CFG-34).
  assert.ok(Object.isFrozen(MEDIA_METRIC_MATRIX), 'the matrix must stay frozen');
  assert.deepEqual(Object.keys(MEDIA_METRIC_MATRIX).sort(), ['FEED', 'REELS', 'STORY']);

  // No cast on this one: the table is declared `Record<string, …>`, so adding a
  // product type is an ordinary assignment TypeScript accepts, and an unknown
  // type is exactly what `validateMediaMetrics` waves through to Meta.
  assert.throws(() => {
    MEDIA_METRIC_MATRIX.CLIPS = [];
  }, TypeError);
  assert.throws(() => {
    MEDIA_METRIC_MATRIX.FEED = [];
  }, TypeError);
  assert.throws(() => {
    delete MEDIA_METRIC_MATRIX.STORY;
  }, TypeError);

  for (const [type, allowed] of Object.entries(MEDIA_METRIC_MATRIX)) {
    assert.ok(Object.isFrozen(allowed), `the ${type} metric list must stay frozen`);
    const mutable = allowed as string[];
    const before = [...mutable];
    assert.throws(() => mutable.push('navigation'), TypeError, `${type} accepts a widening`);
    assert.throws(() => mutable.pop(), TypeError, `${type} accepts a narrowing`);
    assert.deepEqual(mutable, before, `${type}: a write got through`);
  }
});

/** Every insights reader, driven with one canned body. */
const INSIGHTS_READERS: ReadonlyArray<{
  name: string;
  read: (req: IgRequestFn) => Promise<unknown>;
}> = [
  {
    name: 'getAccountInsights',
    read: (req) => getAccountInsights(req, { accountId: '123', metrics: ['views'] }),
  },
  {
    name: 'getMediaInsights',
    read: (req) => getMediaInsights(req, { mediaId: 'm1', metrics: ['views'] }),
  },
  {
    name: 'getAudienceDemographics',
    read: (req) =>
      getAudienceDemographics(req, {
        accountId: '123',
        breakdown: 'country',
        timeframe: 'this_month',
      }),
  },
  { name: 'getOnlineFollowers', read: (req) => getOnlineFollowers(req, { accountId: '123' }) },
];

test('every insights reader refuses a body that is not an object instead of throwing a TypeError (CC-DATA-86)', async () => {
  // `null` threw a raw TypeError on `.data` whose engine text reached the
  // caller, and a scalar or a list read as an answer with no rows — every metric
  // "absent, not zero", which is a claim about the account, not about the body.
  // The same `upstream` refusal `get_account` and `get_comment` give for a
  // non-object body (CC-DATA-83..85).
  for (const body of [null, 0, 'x', true, [], [{ name: 'views', total_value: { value: 1 } }]]) {
    for (const r of INSIGHTS_READERS) {
      await assert.rejects(
        r.read(recordingReq(body).req),
        (e: unknown) =>
          isInstagramError(e) &&
          e.kind === 'upstream' &&
          e.message === 'Instagram returned no insights object. Retry later.',
        `${r.name} on ${JSON.stringify(body)}`,
      );
    }
  }
});

test('an insights `data` that is present but not a list is said to be unreadable, not missing (CC-INS-22)', async () => {
  // A `data` of `null`, a string, a number, `false` or an object was handed up
  // as `metrics` untouched — the api result broke its own `InsightMetric[]` type
  // — and its metrics were reported with the "no data, absent, not zero" note:
  // an unreadable answer stated as a known one. The call still survives, with an
  // empty `metrics`, every requested metric listed, and a note saying why.
  const unreadable = (names: readonly string[]): string =>
    'Instagram returned the metric list in a shape that is not a list, so none of the ' +
    `requested metric(s) could be read: ${names.join(', ')}. They are unknown, not zero.`;
  for (const data of [null, '', 'views', 0, false, { name: 'views' }]) {
    const label = JSON.stringify(data);
    const account = await getAccountInsights(
      recordingReq({ data, paging: { cursors: { after: 'C1' } } }).req,
      { accountId: '123', metrics: ['views', 'reach'] },
    );
    assert.deepEqual(account.metrics, [], label);
    assert.deepEqual(account.missingMetrics, ['views', 'reach'], label);
    assert.deepEqual(account.notes, [unreadable(['views', 'reach'])], label);
    assert.deepEqual(account.paging, { cursors: { after: 'C1' } }, 'paging is still read');

    const media = await getMediaInsights(recordingReq({ data }).req, {
      mediaId: 'm1',
      metrics: ['views'],
    });
    assert.deepEqual(
      media,
      { mediaId: 'm1', metrics: [], missingMetrics: ['views'], note: unreadable(['views']) },
      label,
    );

    const demographics = await getAudienceDemographics(recordingReq({ data }).req, {
      accountId: '123',
      breakdown: 'country',
      timeframe: 'this_month',
    });
    assert.deepEqual(
      demographics,
      {
        metrics: [],
        breakdown: 'country',
        timeframe: 'this_month',
        missingMetrics: ['follower_demographics'],
        note: unreadable(['follower_demographics']),
      },
      label,
    );

    const online = await getOnlineFollowers(recordingReq({ data }).req, { accountId: '123' });
    assert.deepEqual(
      online,
      { metrics: [], missingMetrics: ['online_followers'], note: unreadable(['online_followers']) },
      label,
    );
  }

  // A readable list with every metric present says nothing, and an unreadable
  // list says the unreadable note only once, never beside the missing one.
  const full = await getOnlineFollowers(
    recordingReq({ data: [{ name: 'online_followers', values: [] }] }).req,
    { accountId: '123' },
  );
  assert.deepEqual(full, { metrics: [{ name: 'online_followers', values: [] }] });
});
