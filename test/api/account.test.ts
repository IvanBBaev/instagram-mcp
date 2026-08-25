/**
 * Unit tests for the `account` api layer. Each function is driven with a fake
 * {@link IgRequestFn} that records the outgoing {@link IgRequestOptions} and
 * returns canned Graph payloads — no network, no fetch stub needed.
 */
import { after as afterAll, test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import {
  debugToken,
  getAccount,
  listLinkedAccounts,
  summarizeTokenExpiry,
} from '../../src/api/account.js';

/**
 * The only seam this layer may use is the injected {@link IgRequestFn}, and
 * every test below hands it a fake. Poisoning the global transport makes that
 * structural rather than conventional: this package reads the operated account
 * and introspects the access token, so code that reached for `fetch` directly —
 * or a helper that quietly fell back to it — would ship the operator's live
 * credential to Meta from a test run. It dies offline here instead. Restored in
 * `after()` so nothing leaks into another test file.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('api/account unit tests must never touch the network');
};
afterAll(() => {
  globalThis.fetch = realFetch;
});

/**
 * The exact profile field set this layer must ask Graph for, pinned
 * character-for-character and deliberately duplicated from the source rather
 * than imported. Graph answers with exactly the fields it was asked for, so a
 * field that quietly falls out of the selection is not an error anywhere: the
 * call succeeds, `get_account` renders, and the operator simply sees a blank
 * follower count or a missing bio and concludes the account has none.
 */
const ACCOUNT_FIELDS =
  'username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count';

/** Build a fake request seam that records calls and returns `responder(opts)`. */
function stubReq(responder: (opts: IgRequestOptions) => unknown): {
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

const DAY = 86_400_000;

test('getAccount requests the documented field set and maps snake_case → camelCase', async () => {
  const { req, calls } = stubReq(() => ({
    id: '178414',
    username: 'acme',
    name: 'ACME Co',
    biography: 'We make anvils',
    website: 'https://acme.example',
    profile_picture_url: 'https://cdn.example/pic.jpg',
    followers_count: 1200,
    follows_count: 42,
    media_count: 87,
  }));

  const profile = await getAccount(req, { igId: '178414' });

  assert.equal(calls.length, 1);
  // The WHOLE options object is pinned, not method/path/params one field at a
  // time. `host`, `idempotent` and `body` are optional, so adding one is
  // invisible to the compiler and to every per-field assertion — yet each is a
  // real incident: an explicit `host` would send the access token (and, on
  // Path B, the `appsecret_proof` derived from the app secret) to a host the
  // operator never configured, `idempotent: false` would silently switch off
  // retry on 429/5xx for a plain read, and a `body` on a GET would make the
  // client attach a form payload to a read.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/178414',
    params: { fields: ACCOUNT_FIELDS },
  });

  assert.deepEqual(profile, {
    id: '178414',
    username: 'acme',
    name: 'ACME Co',
    biography: 'We make anvils',
    website: 'https://acme.example',
    profilePictureUrl: 'https://cdn.example/pic.jpg',
    followersCount: 1200,
    followsCount: 42,
    mediaCount: 87,
  });
});

test('getAccount tolerates omitted fields (CC-DATA-2)', async () => {
  // Every absent field stays absent — none of them may acquire a fabricated
  // default. A `?? 0` on a count is the worst of these: Meta omits
  // `followers_count` / `media_count` when the metric is unavailable, and a
  // reported 0 is indistinguishable from a real zero. The operator reads "0
  // followers" or "0 posts" for a healthy account and concludes the account was
  // wiped, or the model reports a collapse in reach that never happened.
  const { req, calls } = stubReq(() => ({ id: '999' }));

  const profile = await getAccount(req, { igId: 'me' });

  assert.equal(calls[0]!.path, '/me');
  assert.deepEqual(profile, {
    id: '999',
    username: undefined,
    name: undefined,
    biography: undefined,
    website: undefined,
    profilePictureUrl: undefined,
    followersCount: undefined,
    followsCount: undefined,
    mediaCount: undefined,
  });
});

test('getAccount sends an empty igId as-is instead of falling back to `me`', async () => {
  // `igId` comes from `IG_ACCOUNT_ID` (via the tool layer's `accountId ?? 'me'`),
  // and an empty value there means the operator's config is broken. Substituting
  // `me` for it turns that broken config into a successful read of whichever
  // account owns the token — the operator sees plausible numbers, never learns
  // the configured id was ignored, and cannot tell the two accounts apart from
  // the response. A request for `/` fails loudly at Graph, which is the point.
  const { req, calls } = stubReq(() => ({ id: '178414' }));

  await getAccount(req, { igId: '' });

  assert.equal(calls[0]!.path, '/');
});

test('getAccount percent-encodes igId so a crafted id cannot forge a second path segment', async () => {
  // `igId` arrives from tool input and from the config file, so it has to stay a
  // single path segment. Unencoded, an id like `me/media?fields=id` retargets the
  // call at a different edge with caller-chosen fields, and `get_account` answers
  // with someone else's media list while the operator believes they read a profile.
  const { req, calls } = stubReq(() => ({ id: '178414' }));

  const profile = await getAccount(req, { igId: 'me/media?fields=id' });

  assert.equal(calls[0]!.path, '/me%2Fmedia%3Ffields%3Did');
  assert.equal(profile.id, '178414');
});

test('listLinkedAccounts hits /me/accounts on graph.facebook.com and maps rows', async () => {
  const { req, calls } = stubReq(() => ({
    data: [
      {
        id: 'page1',
        name: 'Acme Page',
        instagram_business_account: { id: 'ig1', username: 'acme' },
      },
      { id: 'page2', name: 'No-IG Page' },
    ],
  }));

  const linked = await listLinkedAccounts(req);

  // Whole-shape pin again. Two things here are load-bearing beyond method/path:
  // the host MUST stay graph.facebook.com — the Page graph only exists there, and
  // the tool's `paths: ['fb-login']` capability guard is written on the assumption
  // that this call agrees with it; and no `idempotent: false` may creep in, or a
  // 429 during the login flow stops being retried and the operator is told they
  // have no linked Pages. A `body` on this GET would be equally silent.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/me/accounts',
    params: { fields: 'name,instagram_business_account{id,username}' },
    host: 'graph.facebook.com',
  });

  assert.deepEqual(linked, [
    { pageId: 'page1', pageName: 'Acme Page', igId: 'ig1', igUsername: 'acme' },
    { pageId: 'page2', pageName: 'No-IG Page', igId: undefined, igUsername: undefined },
  ]);
});

test('listLinkedAccounts returns [] when the edge is empty', async () => {
  const { req } = stubReq(() => ({ data: [] }));
  assert.deepEqual(await listLinkedAccounts(req), []);
});

test('listLinkedAccounts treats a response with no data key as no pages', async () => {
  // Graph omits `data` entirely on some empty edges rather than sending `[]`.
  // Mapping over the missing key would be a TypeError, so an account with no
  // linked Pages would fail the login flow instead of reporting "none found".
  const { req } = stubReq(() => ({}));
  assert.deepEqual(await listLinkedAccounts(req), []);
});

test('debugToken reports every field unknown when the envelope has no data', async () => {
  // `/debug_token` answers `{}` for a token the app cannot inspect. Reading the
  // fields off the missing wrapper would throw inside `doctor`, turning a
  // "cannot introspect this token" diagnosis into a crashed diagnostic.
  const { req } = stubReq(() => ({}));

  assert.deepEqual(await debugToken(req, { inputToken: 'EAAsecret' }), {
    isValid: undefined,
    appId: undefined,
    type: undefined,
    userId: undefined,
    scopes: undefined,
    expiresAtSec: undefined,
    dataAccessExpiresAtSec: undefined,
  });
});

test('debugToken parses the { data } envelope on graph.facebook.com', async () => {
  const { req, calls } = stubReq(() => ({
    data: {
      is_valid: true,
      app_id: '55500',
      type: 'USER',
      user_id: '178414',
      scopes: ['instagram_basic', 'pages_show_list'],
      expires_at: 1_800_000_000,
      data_access_expires_at: 1_790_000_000,
    },
  }));

  const info = await debugToken(req, { inputToken: 'EAAsecret' });

  // This is the one call in the package that carries a credential in the query
  // string, so its shape is pinned whole. The token must travel as `input_token`
  // and nowhere else: an extra `access_token` key here would put the inspected
  // token in the slot the auth provider owns, and a `body` would move a secret
  // into a request body that the client only builds for writes. The host must
  // stay graph.facebook.com — `debug_token` exists nowhere else, and dropping the
  // pin would ship the token to graph.instagram.com on Path A. `idempotent` stays
  // unset so this read keeps its default retry behaviour.
  assert.deepEqual(calls[0], {
    method: 'GET',
    path: '/debug_token',
    params: { input_token: 'EAAsecret' },
    host: 'graph.facebook.com',
  });

  assert.deepEqual(info, {
    isValid: true,
    appId: '55500',
    type: 'USER',
    userId: '178414',
    scopes: ['instagram_basic', 'pages_show_list'],
    expiresAtSec: 1_800_000_000,
    dataAccessExpiresAtSec: 1_790_000_000,
  });
});

test('summarizeTokenExpiry: unknown when expiresAtSec is undefined (CC-AUTH-7)', () => {
  const s = summarizeTokenExpiry({ expiresAtSec: undefined, nowMs: 0, refreshAfterDays: 45 });
  assert.equal(s.state, 'unknown');
  assert.equal(s.expiresAt, undefined);
  assert.ok(s.warning && s.warning.includes('login'));
});

test('summarizeTokenExpiry: never when expiresAtSec is 0', () => {
  const s = summarizeTokenExpiry({ expiresAtSec: 0, nowMs: 10 * DAY, refreshAfterDays: 45 });
  assert.deepEqual(s, { state: 'never' });
});

test('summarizeTokenExpiry: valid when comfortably beyond the refresh threshold', () => {
  const now = 100 * DAY;
  const expiresAtSec = (now + 60 * DAY) / 1000;
  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });
  assert.equal(s.state, 'valid');
  assert.equal(s.daysLeft, 60);
  assert.equal(s.expiresAt, new Date(now + 60 * DAY).toISOString());
  assert.equal(s.warning, undefined);
});

test('summarizeTokenExpiry: expiring_soon within the refresh threshold, with absolute expiry (CC-AUTH-13)', () => {
  const now = 100 * DAY;
  const expiresAtSec = (now + 10 * DAY) / 1000;
  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });
  assert.equal(s.state, 'expiring_soon');
  assert.equal(s.daysLeft, 10);
  assert.ok(s.warning && s.warning.includes(new Date(now + 10 * DAY).toISOString()));
});

test('summarizeTokenExpiry: daysLeft exactly at refreshAfterDays still warns', () => {
  // `refreshAfterDays` is the operator's last scheduled chance to rotate the token,
  // so the day the boundary is reached must already carry the warning: `doctor` runs
  // on a cadence, and the next run lands after the threshold has been crossed. An
  // exclusive comparison stays silent on exactly that day and the token lapses
  // mid-campaign with no prior notice.
  const now = 100 * DAY;
  const expiresAtSec = (now + 45 * DAY) / 1000;
  const expiresAt = new Date(now + 45 * DAY).toISOString();

  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });

  assert.deepEqual(s, {
    state: 'expiring_soon',
    expiresAt,
    daysLeft: 45,
    warning: `Token expires at ${expiresAt} (~45 day(s) left); run the \`refresh\` or \`login\` CLI.`,
  });
});

test('summarizeTokenExpiry: daysLeft rounds down, never up, on a partial day', () => {
  // `daysLeft` is a promise about remaining runway, so it must round down: with
  // half a day left, "~11 day(s)" tells the operator they can wait until next week.
  // Rounding up inflates every partial day by one and pushes the rotation past the
  // real deadline — publishing then fails on a token the last report called healthy.
  const now = 100 * DAY;
  const expiresAtMs = now + 10 * DAY + DAY / 2;
  const expiresAtSec = expiresAtMs / 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });

  assert.deepEqual(s, {
    state: 'expiring_soon',
    expiresAt,
    daysLeft: 10,
    warning: `Token expires at ${expiresAt} (~10 day(s) left); run the \`refresh\` or \`login\` CLI.`,
  });
});

test('summarizeTokenExpiry: expired for a past expiry', () => {
  const now = 100 * DAY;
  const expiresAtSec = (now - 5 * DAY) / 1000;
  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });
  assert.equal(s.state, 'expired');
  assert.equal(s.daysLeft, -5);
  assert.ok(s.warning && s.warning.includes('expired'));
});

test('summarizeTokenExpiry: a token expiring exactly now is expired and still reports expiresAt', () => {
  // The instant of expiry belongs to the expired side: Meta rejects a token at its
  // `expires_at`, so reporting `expiring_soon` there tells the operator to schedule
  // a refresh for a credential that is already dead. The absolute `expiresAt` has to
  // survive into that summary too (CC-AUTH-13) — without it a skewed local clock
  // looks identical to a genuinely lapsed token, and nobody can tell which it was.
  const now = 100 * DAY;
  const expiresAtSec = now / 1000;
  const expiresAt = new Date(now).toISOString();

  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });

  assert.deepEqual(s, {
    state: 'expired',
    expiresAt,
    daysLeft: 0,
    warning: `Token expired at ${expiresAt}; run the \`login\` CLI to obtain a new one.`,
  });
});

test('summarizeTokenExpiry: an expired token reports whole days elapsed, rounded down', () => {
  // `daysLeft` goes negative once the token is dead, and it must keep rounding
  // DOWN there rather than toward zero: the number is how long the credential has
  // been unusable, and truncation under-reports every partial day by one. An
  // operator reconciling "publishing broke on the 6th" against a report that says
  // the token has been dead for 5 days concludes the outage has another cause and
  // keeps looking, instead of rotating the credential.
  const now = 100 * DAY;
  const expiresAtMs = now - 5 * DAY - DAY / 2;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const s = summarizeTokenExpiry({
    expiresAtSec: expiresAtMs / 1000,
    nowMs: now,
    refreshAfterDays: 45,
  });

  assert.deepEqual(s, {
    state: 'expired',
    expiresAt,
    daysLeft: -6,
    warning: `Token expired at ${expiresAt}; run the \`login\` CLI to obtain a new one.`,
  });
});

test('summarizeTokenExpiry: a negative expiry is expired, never "never expires"', () => {
  // Only the exact value `0` carries `debug_token`'s "never expires" meaning. A
  // negative `expires_at` is corrupt input — a clock-skewed or hand-edited
  // credential record — and folding it into the never-expires branch is the most
  // dangerous possible misreading: `doctor` would report a permanent token,
  // suppress every refresh warning for good, and the operator would find out only
  // when publishing starts failing with no prior signal.
  const expiresAt = new Date(-DAY).toISOString();

  const s = summarizeTokenExpiry({ expiresAtSec: -86_400, nowMs: 0, refreshAfterDays: 45 });

  assert.deepEqual(s, {
    state: 'expired',
    expiresAt,
    daysLeft: -1,
    warning: `Token expired at ${expiresAt}; run the \`login\` CLI to obtain a new one.`,
  });
});

test('summarizeTokenExpiry: a token with hours left is expiring_soon, not expired', () => {
  // Expiry is decided on the instant, not on the day count. A token valid for
  // another twelve hours rounds to `daysLeft: 0`, and treating that 0 as "already
  // expired" declares a working credential dead: `doctor` fails, the operator
  // burns a rotation, and — worse — a still-publishable account looks broken
  // during exactly the window when the last posts before expiry matter most.
  const now = 100 * DAY;
  const expiresAtMs = now + DAY / 2;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const s = summarizeTokenExpiry({
    expiresAtSec: expiresAtMs / 1000,
    nowMs: now,
    refreshAfterDays: 45,
  });

  assert.deepEqual(s, {
    state: 'expiring_soon',
    expiresAt,
    daysLeft: 0,
    warning: `Token expires at ${expiresAt} (~0 day(s) left); run the \`refresh\` or \`login\` CLI.`,
  });
});

test('summarizeTokenExpiry: one day past the threshold is still plain valid', () => {
  // The warning boundary is inclusive but must not creep outward. A threshold
  // that fires a day early is not harmless: `token_status` is what the model
  // reads before deciding what to do next, and a standing "expires soon, run the
  // refresh CLI" on a token with a month and a half of runway trains both the
  // operator and the model to ignore the warning — so the one that matters, 45
  // days later, is ignored too.
  const now = 100 * DAY;
  const expiresAtMs = now + 46 * DAY;

  const s = summarizeTokenExpiry({
    expiresAtSec: expiresAtMs / 1000,
    nowMs: now,
    refreshAfterDays: 45,
  });

  assert.deepEqual(s, {
    state: 'valid',
    expiresAt: new Date(expiresAtMs).toISOString(),
    daysLeft: 46,
  });
});

test('summarizeTokenExpiry: the warning threshold is the caller-supplied one, not a fixed 45', () => {
  // `refreshAfterDays` is operator policy (`IG_REFRESH_AFTER_DAYS`) and the whole
  // point of it is that rotation cadence differs per deployment. Pinning the
  // comparison to the default value silently ignores that setting in BOTH
  // directions: a team that rotates weekly gets no warning until day 45 — long
  // after their own window closed — and a team that asked for 90 days of notice
  // gets none until it is far too late to schedule the change.
  const now = 100 * DAY;

  const tight = summarizeTokenExpiry({
    expiresAtSec: (now + 10 * DAY) / 1000,
    nowMs: now,
    refreshAfterDays: 7,
  });
  assert.equal(tight.state, 'valid');
  assert.equal(tight.warning, undefined);

  const generous = summarizeTokenExpiry({
    expiresAtSec: (now + 60 * DAY) / 1000,
    nowMs: now,
    refreshAfterDays: 90,
  });
  assert.equal(generous.state, 'expiring_soon');
  assert.ok(generous.warning?.includes('~60 day(s) left'));
});

test('InstagramError from req propagates unchanged through the api layer', async () => {
  const boom = new InstagramError('token expired', { kind: 'auth', status: 401, code: 190 });
  const req: IgRequestFn = () => Promise.reject(boom);
  await assert.rejects(getAccount(req, { igId: 'me' }), (err) => {
    assert.equal(err, boom);
    return true;
  });
});
