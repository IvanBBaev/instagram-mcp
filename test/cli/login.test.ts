/**
 * Unit tests for the `login` CLI command (src/cli/login.ts).
 *
 * HONESTY: a live browser login cannot run here — it needs a registered Meta app
 * (app id/secret + a whitelisted redirect URI). These tests therefore exercise
 * the reusable, deterministic CORE and never a real browser: the pure helpers
 * (`buildAuthorizeUrl`, both token exchanges, `computeExpiresAtSec`) against an
 * injected `fetch`, and `runLogin` with the browser step (`captureCode`) and the
 * clock injected out. The `fb_exchange_token` / `ig_exchange_token` step is what
 * a real login would perform after the redirect.
 *
 * The loopback capture IS covered, through injected fakes only: a server factory
 * that never opens a socket and the deterministic {@link fakeClock}, so the
 * routing rules, the bind address and the five-minute timeout are asserted
 * without a browser, a port or a real timer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';

import {
  DEFAULT_REDIRECT_URI,
  buildAuthorizeUrl,
  captureAuthorizationCode,
  classifyCallbackRequest,
  computeExpiresAtSec,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  listenHostFor,
  runLogin,
  type CallbackOutcome,
  type CallbackRequest,
  type CallbackResponse,
  type CreateCallbackServer,
  type LoginDeps,
} from '../../src/cli/login.js';
import { loadProfiles } from '../../src/core/config.js';
import { ALLOWED_HOSTS, assertAllowedHost } from '../../src/core/host.js';
import { isInstagramError } from '../../src/core/types.js';
import type { Credentials, WriteCredentialsResult } from '../../src/core/config-write.js';
import { configHomeEnv, envFileIn, makeTempConfigHome } from '../helpers/config-home.js';
import { fakeClock } from '../helpers/fake-clock.js';

const GRAPH_VERSION = 'v25.0';
const LONG_TOKEN = 'EAAlongLIVEDtokenVALUE0123456789abcXYZsecretZZ';
const SHORT_TOKEN = 'SHORTlivedTOKEN0123456789';
const APP_SECRET = 'app-secret-value-0123456789abcdef';

/** The init bag `fetch` is called with, taken from the platform signature. */
type FetchInit = Parameters<typeof fetch>[1];

/** A `fetch` stub that routes by URL substring and records every request. */
function routingFetch(routes: Array<{ match: string; body: unknown; status?: number }>): {
  fetchFn: typeof fetch;
  urls: string[];
  calls: Array<{ url: string; init: FetchInit }>;
} {
  const urls: string[] = [];
  const calls: Array<{ url: string; init: FetchInit }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: FetchInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    calls.push({ url, init });
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) throw new Error(`unexpected fetch to ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, urls, calls };
}

// --- buildAuthorizeUrl ------------------------------------------------------

test('buildAuthorizeUrl (ig-login) targets the Instagram window with comma scopes', () => {
  const url = new URL(
    buildAuthorizeUrl('ig-login', {
      appId: '55500',
      redirectUri: 'http://localhost:8723/callback',
      scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
      state: 'xyz',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), '55500');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8723/callback');
  assert.equal(url.searchParams.get('state'), 'xyz');
  assert.equal(
    url.searchParams.get('scope'),
    'instagram_business_basic,instagram_business_content_publish',
  );
});

test('buildAuthorizeUrl (fb-login) targets the versioned Facebook dialog', () => {
  const url = new URL(
    buildAuthorizeUrl('fb-login', {
      appId: 'app',
      redirectUri: 'http://localhost:8723/callback',
      scopes: ['instagram_basic'],
      state: 's',
    }),
  );
  assert.equal(url.origin + url.pathname, `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  assert.equal(url.searchParams.get('client_id'), 'app');
});

// --- The endpoints this CLI addresses by hand -------------------------------

/*
 * `core/host.ts` owns the SSRF allowlist that every server-issued Graph request
 * passes through, and this module is its ONE deliberate exception: it assembles
 * six URLs from module-level literals and never calls `assertAllowedHost`. That
 * is a defensible exception only while the hosts really are constants — the
 * moment one of them is repointed, the operator's app secret and both tokens
 * (they all ride the query string of these exchanges) go somewhere else, and no
 * allowlist is watching. Since there is no runtime gate here, this assertion is
 * the gate: it pins all six endpoints at once, in order, so a repoint cannot
 * pass review silently. The authorize URLs are checked as returned strings; the
 * four exchange URLs are captured off the injected `fetch`, which is the only
 * place they become observable.
 */
test('every URL login builds is pinned to its exact OAuth / Graph endpoint', async () => {
  const requested: string[] = [];
  const captureFetch = (async (input: string | URL | Request): Promise<Response> => {
    requested.push(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    return new Response(JSON.stringify({ access_token: SHORT_TOKEN }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  /** Origin + path only — the query carries the credentials, not the target. */
  const endpointOf = (url: string): string => {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  };

  const authorize = { appId: 'app', redirectUri: DEFAULT_REDIRECT_URI, scopes: ['x'], state: 's' };
  const code = { code: 'abc', appId: 'app', appSecret: APP_SECRET, redirectUri: 'http://x/y' };
  const long = { shortToken: SHORT_TOKEN, appId: 'app', appSecret: APP_SECRET };

  const built = [
    endpointOf(buildAuthorizeUrl('ig-login', authorize)),
    endpointOf(buildAuthorizeUrl('fb-login', authorize)),
  ];
  await exchangeCodeForToken('ig-login', code, captureFetch);
  await exchangeCodeForToken('fb-login', code, captureFetch);
  await exchangeForLongLivedToken('ig-login', long, captureFetch);
  await exchangeForLongLivedToken('fb-login', long, captureFetch);

  assert.deepEqual(
    [...built, ...requested.map(endpointOf)],
    [
      'https://www.instagram.com/oauth/authorize',
      `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
      'https://api.instagram.com/oauth/access_token',
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
      // The IG long-lived exchange is the one unversioned endpoint Meta
      // documents — it takes no version segment, unlike every other Graph call.
      'https://graph.instagram.com/access_token',
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
    ],
  );
});

/*
 * The counterpart to the pin above, and the reason `core/host.ts` says "every
 * server-issued GRAPH request" rather than "every request": these three hosts
 * are OAuth endpoints, not Graph endpoints, and their absence from the allowlist
 * is a decision, not an oversight. Adding them would widen where a
 * model-supplied host may send the access token in order to accommodate four
 * constants — so the absence is asserted here, next to the code that depends on
 * it, instead of being re-argued whenever someone notices the gap.
 */
test('the OAuth hosts login uses are deliberately absent from the Graph SSRF allowlist', () => {
  const allowlist = ALLOWED_HOSTS as readonly string[];
  for (const host of ['www.instagram.com', 'api.instagram.com', 'www.facebook.com']) {
    assert.ok(!allowlist.includes(host), `${host} must not be on the Graph allowlist`);
    assert.throws(() => assertAllowedHost(host), /non-allowlisted host/);
  }
  // The two token exchanges do address real Graph hosts; those stay allowlisted.
  assert.ok(allowlist.includes('graph.instagram.com'));
  assert.ok(allowlist.includes('graph.facebook.com'));
});

// --- exchangeCodeForToken ---------------------------------------------------

test('exchangeCodeForToken (ig-login) POSTs to api.instagram.com and returns token + user id', async () => {
  const { fetchFn, urls } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
  ]);
  const out = await exchangeCodeForToken(
    'ig-login',
    {
      code: 'abc',
      appId: '55500',
      appSecret: APP_SECRET,
      redirectUri: 'http://localhost:8723/callback',
    },
    fetchFn,
  );
  // Pinned WHOLE, not field by field. Reading `accessToken` and `userId`
  // separately could not see a field ADDED to the returned token record, and
  // `ShortLivedToken` declares `expiresInSec?` — which this branch does not
  // set — so an extra key compiles with no cast at all. Measured: adding
  // `expiresInSec: numOrUndef(json.expires_in)` here survived the whole suite
  // (268 ok, 0 not ok, exit 0). The value travels: `short.userId` becomes
  // `creds.accountId`, a line in the operator's config file.
  assert.deepEqual(out, { accessToken: SHORT_TOKEN, userId: '178414' });
  assert.ok(urls[0]?.startsWith('https://api.instagram.com/oauth/access_token'));
});

test('the ig code exchange posts a form body and keeps the app secret out of the URL', async () => {
  // Two separate stakes. (1) Exposure: the app secret is bearer-equivalent —
  // moved into a query string it is copied verbatim into every proxy access log
  // and Meta-side request log, where it outlives the token it minted. Only the
  // POST body keeps it off that trail. (2) Correctness: Meta re-validates
  // `grant_type` and `redirect_uri` against the authorize step and rejects a
  // byte-level difference, so a body that is empty, JSON-encoded, or carries the
  // DEFAULT redirect URI instead of the one the browser was actually sent to
  // fails an otherwise perfect login with a generic "invalid request".
  const redirectUri = 'http://127.0.0.1:8123/oauth/callback';
  const { fetchFn, calls } = routingFetch([
    { match: 'api.instagram.com/oauth/access_token', body: { access_token: SHORT_TOKEN } },
  ]);
  await exchangeCodeForToken(
    'ig-login',
    { code: 'abc', appId: '55500', appSecret: APP_SECRET, redirectUri },
    fetchFn,
  );

  const call = calls[0]!;
  assert.equal(call.init?.method, 'POST');
  assert.deepEqual(call.init?.headers, {
    'content-type': 'application/x-www-form-urlencoded',
  });
  assert.ok(!call.url.includes(APP_SECRET), 'the app secret must never travel in the URL');
  const rawBody = call.init?.body;
  const form = new URLSearchParams(typeof rawBody === 'string' ? rawBody : '');
  assert.equal(form.get('client_id'), '55500');
  assert.equal(form.get('client_secret'), APP_SECRET);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'abc');
  assert.equal(
    form.get('redirect_uri'),
    redirectUri,
    'the exchange must echo the URI the browser was redirected to, not the default',
  );
});

test('exchangeCodeForToken (fb-login) GETs the versioned Graph endpoint with expires_in', async () => {
  const { fetchFn, urls } = routingFetch([
    {
      match: `graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
      body: { access_token: SHORT_TOKEN, expires_in: 3600 },
    },
  ]);
  const out = await exchangeCodeForToken(
    'fb-login',
    {
      code: 'abc',
      appId: 'app',
      appSecret: APP_SECRET,
      redirectUri: 'http://localhost:8723/callback',
    },
    fetchFn,
  );
  // Whole-record pin: the two field reads it replaces were blind to an added
  // key, and Path B's short-lived record carries NO `userId` — a `userId` added
  // here would flow into `creds.accountId` and be written to the operator's
  // config as an account they never named. Measured: adding
  // `userId: strOrUndef(json.user_id)` survived the whole suite (268 ok, 0 not
  // ok, exit 0).
  assert.deepEqual(out, { accessToken: SHORT_TOKEN, expiresInSec: 3600 });
  const url = new URL(urls[0]!);
  assert.equal(url.searchParams.get('code'), 'abc');
  assert.equal(url.searchParams.get('client_id'), 'app');
});

test('the fb code exchange is a GET carrying the whole credential set', async () => {
  // Path B mints the short-lived token from Graph, which requires BOTH halves of
  // the app credential plus the same `redirect_uri` it saw at the dialog step.
  // Drop either and Graph answers 400 with a message that names neither, so the
  // operator reads it as "the code expired" and re-runs the login — the one
  // thing that cannot help. The verb matters too: this endpoint takes its
  // parameters in the query, and a POST arrives with an empty body.
  const redirectUri = 'http://127.0.0.1:8123/oauth/callback';
  const { fetchFn, calls } = routingFetch([
    {
      match: `graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
      body: { access_token: SHORT_TOKEN, expires_in: 3600 },
    },
  ]);
  await exchangeCodeForToken(
    'fb-login',
    { code: 'abc', appId: 'app', appSecret: APP_SECRET, redirectUri },
    fetchFn,
  );

  const call = calls[0]!;
  assert.equal(call.init?.method, 'GET');
  const query = new URL(call.url).searchParams;
  assert.equal(query.get('client_id'), 'app');
  assert.equal(query.get('client_secret'), APP_SECRET);
  assert.equal(query.get('redirect_uri'), redirectUri);
  assert.equal(query.get('code'), 'abc');
});

test('a fb code exchange whose expires_in is not a number stores no lifetime', async () => {
  // Path B is the only exchange where `expires_in` comes back from the DIALOG
  // step rather than from a token swap, and it is the value that later becomes
  // the credential's stored expiry. Graph has been seen answering there with
  // `null` (consent granted, lifetime withheld) and with the number quoted.
  // Neither survives the arithmetic downstream: `null` reaches
  // `computeExpiresAtSec`, compares `<= 0` and stamps the credential "never
  // expires", so nothing ever warns and the token dies mid-publish sixty days
  // later; a quoted number concatenates instead of adding. "No lifetime given"
  // is the only honest reading of any of them.
  for (const raw of ['null', '"3600.0"', '"-3600"', '" 3600"', '1e999']) {
    const fetchFn = rawFetch(
      200,
      `{"access_token":"${SHORT_TOKEN}","expires_in":${raw}}`,
      'application/json',
    );
    const out = await exchangeCodeForToken(
      'fb-login',
      { code: 'abc', appId: 'app', appSecret: APP_SECRET, redirectUri: DEFAULT_REDIRECT_URI },
      fetchFn,
    );
    assert.equal(out.accessToken, SHORT_TOKEN);
    assert.equal(out.expiresInSec, undefined, `expires_in ${raw} is not a usable lifetime`);
  }
});

test('a fb code exchange whose expires_in is a canonical quoted integer keeps the lifetime (CC-AUTH-69)', async () => {
  // Graph has been seen quoting the number. A plain decimal string of whole
  // seconds is the same lifetime and is read as a number, never concatenated.
  for (const [raw, want] of [
    ['"3600"', 3600],
    ['"0"', 0],
  ] as const) {
    const fetchFn = rawFetch(
      200,
      `{"access_token":"${SHORT_TOKEN}","expires_in":${raw}}`,
      'application/json',
    );
    const out = await exchangeCodeForToken(
      'fb-login',
      { code: 'abc', appId: 'app', appSecret: APP_SECRET, redirectUri: DEFAULT_REDIRECT_URI },
      fetchFn,
    );
    assert.equal(out.expiresInSec, want, `expires_in ${raw}`);
  }
});

// --- exchangeForLongLivedToken ---------------------------------------------

test('exchangeForLongLivedToken (ig-login) uses ig_exchange_token on graph.instagram.com', async () => {
  const { fetchFn, urls } = routingFetch([
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: 5184000 },
    },
  ]);
  const out = await exchangeForLongLivedToken(
    'ig-login',
    { shortToken: SHORT_TOKEN, appId: '55500', appSecret: APP_SECRET },
    fetchFn,
  );
  // Whole-record pin. `LongLivedToken` is closed, so an added field needs
  // `Object.assign({ ...the literal... }, { debugX: 'x' })` to get past the
  // excess-property check — and measured that way it survived the whole suite
  // (268 ok, 0 not ok, exit 0), because nothing read the record as a record.
  assert.deepEqual(out, { accessToken: LONG_TOKEN, expiresInSec: 5184000 });
  const url = new URL(urls[0]!);
  assert.equal(url.searchParams.get('grant_type'), 'ig_exchange_token');
});

test('exchangeForLongLivedToken (fb-login) uses fb_exchange_token on graph.facebook.com', async () => {
  const { fetchFn, urls } = routingFetch([
    {
      match: `graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
      body: { access_token: LONG_TOKEN, expires_in: 5184000 },
    },
  ]);
  const out = await exchangeForLongLivedToken(
    'fb-login',
    { shortToken: SHORT_TOKEN, appId: 'app', appSecret: APP_SECRET },
    fetchFn,
  );
  // Whole-record pin; the single `accessToken` read could not see the lifetime
  // this branch reports NOR any field added beside it. Measured: the same
  // `Object.assign(..., { debugX: 'x' })` wrapper on this return survived the
  // whole suite (268 ok, 0 not ok, exit 0).
  assert.deepEqual(out, { accessToken: LONG_TOKEN, expiresInSec: 5184000 });
  const url = new URL(urls[0]!);
  assert.equal(url.searchParams.get('grant_type'), 'fb_exchange_token');
  assert.equal(url.searchParams.get('fb_exchange_token'), SHORT_TOKEN);
});

test('both long-lived exchanges present the SHORT token together with the app secret', async () => {
  // This is the step that turns a one-hour token into a sixty-day one, and it is
  // the last chance to do so: the authorization code is already spent, so a
  // failure here cannot be retried without a second browser round-trip. Sending
  // the app id where the short token belongs, or omitting the secret, produces
  // exactly that dead end — and the 400 that comes back says only "invalid
  // request", which reads like a bad code rather than a malformed upgrade.
  const ig = routingFetch([
    { match: 'graph.instagram.com/access_token', body: { access_token: LONG_TOKEN } },
  ]);
  await exchangeForLongLivedToken(
    'ig-login',
    { shortToken: SHORT_TOKEN, appId: '55500', appSecret: APP_SECRET },
    ig.fetchFn,
  );
  const igQuery = new URL(ig.urls[0]!).searchParams;
  assert.equal(igQuery.get('grant_type'), 'ig_exchange_token');
  assert.equal(igQuery.get('client_secret'), APP_SECRET);
  assert.equal(igQuery.get('access_token'), SHORT_TOKEN, 'the SHORT token is what gets upgraded');

  const fb = routingFetch([
    {
      match: `graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
      body: { access_token: LONG_TOKEN },
    },
  ]);
  await exchangeForLongLivedToken(
    'fb-login',
    { shortToken: SHORT_TOKEN, appId: 'app', appSecret: APP_SECRET },
    fb.fetchFn,
  );
  const fbQuery = new URL(fb.urls[0]!).searchParams;
  assert.equal(fbQuery.get('client_id'), 'app');
  assert.equal(fbQuery.get('client_secret'), APP_SECRET);
});

test('a non-2xx exchange maps to an auth InstagramError without leaking the URL/secret', async () => {
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      status: 400,
      body: { error: { message: 'Invalid authorization code' } },
    },
  ]);
  await assert.rejects(
    () =>
      exchangeCodeForToken(
        'ig-login',
        {
          code: 'bad',
          appId: '55500',
          appSecret: APP_SECRET,
          redirectUri: 'http://localhost:8723/callback',
        },
        fetchFn,
      ),
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'auth' &&
      err.status === 400 &&
      /Invalid authorization code/.test(err.message) &&
      !err.message.includes(APP_SECRET),
  );
});

test('a 5xx exchange maps to an upstream InstagramError', async () => {
  const { fetchFn } = routingFetch([
    {
      match: 'graph.facebook.com',
      status: 503,
      body: { error: { message: 'temporarily unavailable' } },
    },
  ]);
  await assert.rejects(
    () =>
      exchangeForLongLivedToken(
        'fb-login',
        { shortToken: SHORT_TOKEN, appId: 'a', appSecret: APP_SECRET },
        fetchFn,
      ),
    (err: unknown) => isInstagramError(err) && err.kind === 'upstream' && err.status === 503,
  );
});

test('the exchange failure kind follows the status: 400/401/403 are credentials', async () => {
  // `kind` is the only machine-readable part of the failure, and it decides what
  // the operator is told to do. 403 is what an app in Development mode returns
  // for a user who is not a listed tester — reporting that as `upstream` sends
  // them into a retry loop that can never succeed, while a 500 reported as
  // `auth` makes them re-run a login that was never the problem.
  const cases: Array<[number, 'auth' | 'upstream']> = [
    [400, 'auth'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'upstream'],
    [500, 'upstream'],
  ];
  for (const [status, kind] of cases) {
    const fetchFn = rawFetch(
      status,
      JSON.stringify({ error: { message: 'nope' } }),
      'application/json',
    );
    await assert.rejects(
      () =>
        exchangeForLongLivedToken(
          'ig-login',
          { shortToken: SHORT_TOKEN, appId: '55500', appSecret: APP_SECRET },
          fetchFn,
        ),
      (err: unknown) => isInstagramError(err) && err.status === status && err.kind === kind,
      `HTTP ${status} must be reported as ${kind}`,
    );
  }
});

test('a blank Graph error message falls back to the HTTP status', async () => {
  // Graph does answer with the error envelope present but its `message` empty
  // (throttling and some app-state rejections). Preferring it because it is a
  // string leaves the operator with `login failed: ` and nothing after the
  // colon — not even a status code to search for.
  const fetchFn = rawFetch(500, JSON.stringify({ error: { message: '' } }), 'application/json');
  await assert.rejects(
    () =>
      exchangeForLongLivedToken(
        'fb-login',
        { shortToken: SHORT_TOKEN, appId: 'a', appSecret: APP_SECRET },
        fetchFn,
      ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      // The fallback sentence is the whole deliverable here: the empty `message`
      // was preferred-and-rejected, so what is left has to say both that the
      // exchange failed and what the status was. `/HTTP 500/` alone would also
      // accept the empty-string message with the status appended to it — the
      // very outcome the comment above says this case exists to prevent
      // (CC-PROC-74).
      assert.equal(err.message, 'OAuth token exchange failed (HTTP 500).');
      // 500 is outside the 400/401/403 set, so it is upstream, not auth: the
      // operator is told to retry rather than to re-authenticate.
      assert.equal(err.kind, 'upstream');
      assert.equal(err.status, 500);
      return true;
    },
  );
});

test('an access_token that arrives empty is refused like a missing one', async () => {
  // `{"access_token": ""}` with a 200 is what a blocked or rate-limited app has
  // been seen returning. An empty string is falsy everywhere downstream, so it
  // would be written to the env file and then read back as "no token
  // configured": a login that reports success and leaves the profile unusable.
  const fetchFn = rawFetch(200, JSON.stringify({ access_token: '' }), 'application/json');
  await assert.rejects(
    () =>
      exchangeForLongLivedToken(
        'ig-login',
        { shortToken: SHORT_TOKEN, appId: '55500', appSecret: APP_SECRET },
        fetchFn,
      ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.kind, 'auth');
      // Character for character the message a missing key produces. That is
      // this test's title, and a `/access_token/` match would hold just as
      // well if one of the two paths drifted into naming a different cause
      // (CC-PROC-74).
      assert.equal(err.message, 'Token exchange response did not include an access_token.');
      return true;
    },
  );
});

// --- the `{data: [...]}` wrapper on the Instagram code exchange (CC-AUTH-62)

const IG_CODE_PARAMS = {
  code: 'c',
  appId: '55500',
  appSecret: APP_SECRET,
  redirectUri: DEFAULT_REDIRECT_URI,
};

test('an Instagram code exchange wrapped as {data: [one entry]} is unwrapped', async () => {
  // api.instagram.com has been documented answering the code exchange as
  // `{"data": [{"access_token": …, "user_id": …, "permissions": …}]}`. Read flat,
  // that body has no top-level token and failed a login the operator had just
  // authorized with "did not include an access_token".
  const fetchFn = rawFetch(
    200,
    JSON.stringify({
      data: [{ access_token: SHORT_TOKEN, user_id: '17841400000000001', permissions: 'x' }],
    }),
    'application/json',
  );
  const out = await exchangeCodeForToken('ig-login', IG_CODE_PARAMS, fetchFn);
  assert.deepEqual(out, { accessToken: SHORT_TOKEN, userId: '17841400000000001' });
});

test('a flat code exchange beside an empty data list is read flat, not refused', async () => {
  // An empty `data` holds nothing that could compete with the top-level token,
  // so it is no ambiguity: the flat body is what was sent.
  const fetchFn = rawFetch(
    200,
    JSON.stringify({ access_token: SHORT_TOKEN, user_id: 178414, data: [] }),
    'application/json',
  );
  const out = await exchangeCodeForToken('ig-login', IG_CODE_PARAMS, fetchFn);
  assert.deepEqual(out, { accessToken: SHORT_TOKEN, userId: '178414' });
});

test('an ambiguous {data: [...]} code exchange is refused, never guessed', async () => {
  const cases: Array<[string, unknown, string]> = [
    [
      'two entries',
      { data: [{ access_token: SHORT_TOKEN }, { access_token: LONG_TOKEN }] },
      'data holds 2 entries',
    ],
    [
      'a top-level token beside a data entry',
      { access_token: SHORT_TOKEN, data: [{ access_token: LONG_TOKEN }] },
      'it carries an access_token both at the top level and inside data',
    ],
  ];
  for (const [name, body, why] of cases) {
    await assert.rejects(
      () =>
        exchangeCodeForToken(
          'ig-login',
          IG_CODE_PARAMS,
          rawFetch(200, JSON.stringify(body), 'application/json'),
        ),
      (err: unknown) => {
        assert.ok(isInstagramError(err), name);
        assert.equal(err.kind, 'upstream', name);
        assert.equal(
          err.message,
          `Instagram code exchange response is ambiguous: ${why}; expected exactly one. ` +
            'Nothing was stored; run login again.',
          name,
        );
        assert.ok(!err.message.includes(SHORT_TOKEN) && !err.message.includes(LONG_TOKEN));
        return true;
      },
    );
  }
});

test('a degenerate {data: ...} code exchange still fails as a missing access_token', async () => {
  // An empty list, a non-list `data`, and a single entry that is not an object
  // carry no token at all: the existing auth error stands, not the ambiguity one.
  for (const body of [{ data: [] }, { data: {} }, { data: ['x'] }, { data: [null] }]) {
    await assert.rejects(
      () =>
        exchangeCodeForToken(
          'ig-login',
          IG_CODE_PARAMS,
          rawFetch(200, JSON.stringify(body), 'application/json'),
        ),
      (err: unknown) => {
        assert.ok(isInstagramError(err));
        assert.equal(err.kind, 'auth', JSON.stringify(body));
        assert.equal(err.message, 'Token exchange response did not include an access_token.');
        return true;
      },
    );
  }
});

test('only the Instagram code exchange unwraps data: the Facebook one reads the body flat', async () => {
  const fetchFn = rawFetch(
    200,
    JSON.stringify({ data: [{ access_token: SHORT_TOKEN }] }),
    'application/json',
  );
  await assert.rejects(
    () => exchangeCodeForToken('fb-login', IG_CODE_PARAMS, fetchFn),
    (err: unknown) => isInstagramError(err) && err.kind === 'auth',
  );
});

test('runLogin stores nothing when the code exchange is ambiguous', async () => {
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { data: [{ access_token: SHORT_TOKEN }, { access_token: 'another-fake' }] },
    },
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: 5184000 },
    },
  ]);
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    captureCode: async () => 'auth-code',
  });
  assert.equal(code, 1);
  assert.equal(seen.length, 0, 'nothing was persisted');
  assert.match(out(), /ambiguous: data holds 2 entries/);
});

// --- IG_ENV_FILE is the write target when set (CC-CFG-63) -----------------

test('runLogin writes the IG_ENV_FILE file, the only one the server then reads', async () => {
  // With IG_ENV_FILE set the server loads that file ALONE (src/index.ts). A
  // login that wrote the config-home store instead reported success while the
  // server kept serving the old token from the named file.
  const configHome = await makeTempConfigHome('igmcp-login-envfile-');
  const named = path.join(configHome, 'named.env');
  const { fetchFn } = igRoutes();
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    // The config-home variable is injected too, so a writer that ignored
    // IG_ENV_FILE lands in the temp home, never the real one.
    env: { ...configHomeEnv(configHome), IG_ENV_FILE: named },
    fetchFn,
    captureCode: async () => 'auth-code',
  });
  assert.equal(code, 0, out());
  assert.ok(out().includes(`at ${named}.`), out());
  const env = dotenv.parse(await readFile(named, 'utf8'));
  assert.equal(loadProfiles(env).profiles[0]?.accessToken, LONG_TOKEN);
  assert.equal(existsSync(envFileIn(configHome)), false, 'the config-home store is untouched');
  if (process.platform !== 'win32') assert.equal((await stat(named)).mode & 0o777, 0o600);
});

test('runLogin refuses a relative IG_ENV_FILE and writes nothing', async () => {
  const configHome = await makeTempConfigHome('igmcp-login-envfile-rel-');
  const { fetchFn } = igRoutes();
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: { ...configHomeEnv(configHome), IG_ENV_FILE: 'relative.env' },
    fetchFn,
    captureCode: async () => 'auth-code',
  });
  assert.equal(code, 1);
  assert.match(out(), /IG_ENV_FILE is set to "relative\.env", which is not an absolute file name/);
  assert.equal(existsSync(envFileIn(configHome)), false);
  assert.equal(existsSync(path.resolve('relative.env')), false);
});

test('an out-of-range expires_in is not a lifetime', async () => {
  // JSON numbers are unbounded: `1e999` parses to Infinity, and a token stamped
  // with an infinite expiry is one that no "expires soon" check will ever warn
  // about — the credential goes stale silently and the failure lands mid-publish.
  const fetchFn = rawFetch(
    200,
    `{"access_token":"${LONG_TOKEN}","expires_in":1e999}`,
    'application/json',
  );
  const out = await exchangeForLongLivedToken(
    'ig-login',
    { shortToken: SHORT_TOKEN, appId: '55500', appSecret: APP_SECRET },
    fetchFn,
  );
  assert.equal(out.expiresInSec, undefined, 'a non-finite lifetime reads as "no lifetime given"');
});

// --- computeExpiresAtSec ----------------------------------------------------

test('computeExpiresAtSec: undefined stays undefined; exactly 0 is 0; else now+lifetime', () => {
  assert.equal(computeExpiresAtSec(undefined, 1_000_000), undefined);
  assert.equal(computeExpiresAtSec(0, 1_000_000), 0);
  // A negative lifetime is a past instant (as `refresh` reads it), never the
  // "never expires" sentinel: that stored a token the upstream had just called
  // expired as immortal, and every later expiry warning stayed silent.
  assert.equal(computeExpiresAtSec(-5, 1_000_000), 1000 - 5);
  assert.equal(computeExpiresAtSec(-0.5, 1_000_000), 1000 - 1, 'floored, so never later');
  // 2_000_000 ms => 2000 s epoch; + 3600 s lifetime.
  assert.equal(computeExpiresAtSec(3600, 2_000_000), 2000 + 3600);
  // Fractional lifetime is floored.
  assert.equal(computeExpiresAtSec(3600.9, 2_000_000), 2000 + 3600);
  // So is the clock. Rounding a mid-second `now` up stamps the credential one
  // second LATER than the token really dies, which is the one direction that
  // matters: a refresh scheduled off that expiry runs after the token is gone.
  assert.equal(computeExpiresAtSec(3600, 1_999_600), 1999 + 3600);
});

test('computeExpiresAtSec: a lifetime that names no recordable instant is unknown', () => {
  // The store's reader (`parseExpiresAt`) accepts 0 or a whole second from 1 to
  // the last second of year 9999. A sum outside that used to be returned — and
  // persisted as `1e+300:<fp>` or a signed record, both of which the reader
  // drops — so it is now `undefined`, like no lifetime (CC-AUTH-65).
  assert.equal(computeExpiresAtSec(1e300, 0), undefined);
  assert.equal(computeExpiresAtSec(-1e300, 0), undefined);
  assert.equal(computeExpiresAtSec(Number.NaN, 0), undefined);
  assert.equal(computeExpiresAtSec(Number.POSITIVE_INFINITY, 0), undefined);
  assert.equal(computeExpiresAtSec(Number.NEGATIVE_INFINITY, 0), undefined);
  // The ceiling is inclusive and exact.
  assert.equal(computeExpiresAtSec(253_402_300_799, 0), 253_402_300_799);
  assert.equal(computeExpiresAtSec(253_402_300_800, 0), undefined);
  // The floor is the first second after the epoch: a sum of exactly 0 is not
  // "never" (only a lifetime of 0 is), and a sum below it is not a record.
  assert.equal(computeExpiresAtSec(-999, 1_000_000), 1);
  assert.equal(computeExpiresAtSec(-1000, 1_000_000), undefined);
  assert.equal(computeExpiresAtSec(-1001, 1_000_000), undefined);
  // A lifetime of exactly 0 (either sign) is the "never expires" sentinel.
  assert.equal(computeExpiresAtSec(0, 1_000_000), 0);
  assert.equal(computeExpiresAtSec(-0, 1_000_000), 0);
});

// --- Loopback capture of the authorization code -----------------------------

/**
 * A {@link CreateCallbackServer} that opens no socket. `send` drives one inbound
 * request through the handler and returns what was written back; `listens` and
 * `closes` record the lifecycle the capture is supposed to manage.
 */
function fakeCallbackServer(): {
  create: CreateCallbackServer;
  listens: Array<{ port: number; host: string }>;
  closes: () => number;
  send: (url: string) => { status: number; body: string };
  fail: (err: Error) => void;
} {
  let handler: ((req: CallbackRequest, res: CallbackResponse) => void) | undefined;
  let onError: ((err: Error) => void) | undefined;
  const listens: Array<{ port: number; host: string }> = [];
  let closeCount = 0;

  const create: CreateCallbackServer = (h) => {
    handler = h;
    return {
      listen: (port, host) => void listens.push({ port, host }),
      close: () => void (closeCount += 1),
      on: (_event, listener) => void (onError = listener),
    };
  };

  return {
    create,
    listens,
    closes: () => closeCount,
    send: (url) => {
      let status = 0;
      let body = '';
      handler?.(
        { url },
        {
          writeHead: (s) => void (status = s),
          end: (b) => void (body = b ?? ''),
        },
      );
      return { status, body };
    },
    fail: (err) => onError?.(err),
  };
}

/** True while `promise` has not settled (checked across a macrotask turn). */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const settled = await Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise((resolve) => setTimeout(() => resolve(marker), 0)),
  ]);
  return settled === marker;
}

test('the default redirect URI is loopback-literal and matches the address the capture binds', async () => {
  // Regression: with the URI spelled "localhost" and the listener bound to
  // 127.0.0.1, macOS/Windows resolve localhost to ::1 first, the browser hits a
  // closed socket and `login` waits forever.
  const url = new URL(DEFAULT_REDIRECT_URI);
  assert.equal(url.hostname, '127.0.0.1', 'the default must not be spelled "localhost"');

  const server = fakeCallbackServer();
  const clock = fakeClock(0);
  const pending = captureAuthorizationCode(
    { redirectUri: DEFAULT_REDIRECT_URI, state: 's' },
    { createServerImpl: server.create, clock },
  );

  assert.deepEqual(server.listens, [{ port: 8723, host: url.hostname }]);
  server.send('/callback?code=ok&state=s');
  assert.equal(await pending, 'ok');
});

test('runLogin --help advertises the loopback default redirect URI', async () => {
  const { deps, out } = stderrSink();
  await runLogin(['--help'], deps);
  assert.ok(out().includes(DEFAULT_REDIRECT_URI));
  assert.ok(/verbatim/i.test(out()), 'help warns the URI must be registered verbatim');
});

test('listenHostFor normalizes localhost to IPv4 and refuses non-loopback hosts', () => {
  assert.equal(listenHostFor('http://localhost:8723/callback'), '127.0.0.1');
  assert.equal(listenHostFor('http://127.0.0.1:8723/callback'), '127.0.0.1');
  assert.equal(listenHostFor('http://[::1]:8723/callback'), '::1');
  assert.throws(
    () => listenHostFor('http://0.0.0.0:8723/callback'),
    (err: unknown) => isInstagramError(err) && err.kind === 'validation',
  );
  assert.throws(
    () => listenHostFor('https://example.com/callback'),
    (err: unknown) => isInstagramError(err) && err.kind === 'validation',
  );

  // The refusal must quote the host it rejected. A redirect URI can arrive from
  // `--redirect-uri`, from a shell variable, or from a copy-paste out of the
  // Meta app settings, and the three are indistinguishable to the operator once
  // the command has exited. A message that only restates the rule ("loopback
  // only") sends them to re-read the flag they typed correctly; naming the host
  // points at the value that actually got through, which is the only way to
  // find the wrong one of the three.
  assert.throws(
    () => listenHostFor('http://0.0.0.0:8723/callback'),
    (err: unknown) => isInstagramError(err) && err.message.includes('"0.0.0.0"'),
  );
  assert.throws(
    () => listenHostFor('https://EXAMPLE.com/callback'),
    (err: unknown) => isInstagramError(err) && err.message.includes('"example.com"'),
  );
});

test('listenHostFor lowercases the host itself, for the schemes the parser will not', () => {
  // The `.toLowerCase()` on the host carried a note calling it redundant: the
  // WHATWG parser ASCII-lowercases the host of every SPECIAL scheme, so
  // `new URL('http://LOCALHOST/').hostname` really is `'localhost'` and the test
  // above cannot tell the call apart from its absence. Nothing, however, confines
  // this function to a special scheme. A custom-scheme redirect URI is the
  // mainstream native-OAuth idiom, `--redirect-uri` is only trimmed at parse time,
  // and `captureAuthorizationCode` runs `new URL(...)` and then this function with
  // no scheme check in between — so a non-special scheme reaches here, and the
  // parser leaves ITS host exactly as typed. Measured 2026-09-23: with the call
  // dropped, `foo://LOCALHOST:8723/callback` stops being loopback and the login
  // refuses to bind at all.
  assert.equal(new URL('foo://LOCALHOST:8723/callback').hostname, 'LOCALHOST');
  assert.equal(listenHostFor('foo://LOCALHOST:8723/callback'), '127.0.0.1');
  assert.equal(listenHostFor('com.example.app://LocalHost/cb'), '127.0.0.1');

  // The same case-folding must not manufacture loopback out of a routable host.
  assert.throws(
    () => listenHostFor('foo://EXAMPLE.com/cb'),
    (err: unknown) => isInstagramError(err) && err.message.includes('"example.com"'),
  );
});

test('the capture refusal names the two addresses it binds, not the class they belong to', () => {
  // `listenHostFor` is an accept-list of the two addresses this CLI actually
  // binds, not a loopback test — and the three hosts below are the proof that the
  // difference is visible to an operator. All three ARE loopback: every address
  // in 127/8 is, `localhost.` is the rooted spelling of the name that resolves
  // there, and `[::ffff:127.0.0.1]` is the v4-mapped form (the parser normalises
  // it to `[::ffff:7f00:1]`, which is why it never reaches either comparison).
  // Refusing them is deliberate. Telling their author the URI “is not loopback”
  // was not: it is a false statement about the input, and the one kind of false
  // statement an error message must never make — the kind that sends someone who
  // typed a correct-looking address hunting for a typo that is not there, instead
  // of reading the two spellings that would work.
  //
  // The whole-message pin below uses `0.0.0.0`, which genuinely is not loopback,
  // so it agreed with the old sentence and could not see this. Nothing else in
  // the file passes a loopback address that this function rejects.
  for (const uri of [
    'http://127.0.0.2:8723/callback',
    'http://localhost.:8723/callback',
    'http://[::ffff:127.0.0.1]:8723/callback',
  ]) {
    assert.throws(
      () => listenHostFor(uri),
      (err: unknown) => {
        assert.ok(isInstagramError(err), `expected an InstagramError for ${uri}`);
        assert.ok(
          !err.message.includes('on loopback'),
          `${uri} IS loopback, so refusing it "on loopback" is false: ${err.message}`,
        );
        assert.ok(
          err.message.includes('on 127.0.0.1 or [::1]'),
          `the refusal for ${uri} must name the two accepted addresses: ${err.message}`,
        );
        return true;
      },
    );
  }

  // And the two it names must be exactly the two it takes, or the message is
  // merely a different falsehood.
  assert.equal(listenHostFor('http://127.0.0.1:8723/callback'), '127.0.0.1');
  assert.equal(listenHostFor('http://[::1]:8723/callback'), '::1');
});

test('captureAuthorizationCode refuses a non-loopback redirect URI without binding anything', async () => {
  const server = fakeCallbackServer();
  await assert.rejects(
    () =>
      captureAuthorizationCode(
        { redirectUri: 'http://192.168.1.10:8723/callback', state: 's' },
        { createServerImpl: server.create, clock: fakeClock(0) },
      ),
    (err: unknown) => isInstagramError(err) && err.kind === 'validation',
  );
  assert.equal(server.listens.length, 0, 'nothing may listen on a routable interface');
});

test('captureAuthorizationCode ignores requests off the redirect path and keeps waiting', async () => {
  // Regression: before the path check, ANY request carrying a `code` (a probe, a
  // favicon fetch that inherited the query) could settle the capture.
  const server = fakeCallbackServer();
  const pending = captureAuthorizationCode(
    { redirectUri: 'http://127.0.0.1:8723/callback', state: 'st8' },
    { createServerImpl: server.create, clock: fakeClock(0) },
  );

  assert.equal(server.send('/').status, 404);
  assert.equal(server.send('/favicon.ico?code=bogus&state=st8').status, 404);
  assert.equal(await isPending(pending), true, 'off-path requests must not settle the capture');
  assert.equal(server.closes(), 0, 'the listener stays open for the real redirect');

  server.send('/callback?code=real&state=st8');
  assert.equal(await pending, 'real');
  assert.equal(server.closes(), 1, 'the listener is closed exactly once');
});

test('captureAuthorizationCode routes a pathless redirect URI to the root path', async () => {
  // The empty-path arm was marked unreachable and excluded from coverage, on the
  // ground that the WHATWG parser normalises an empty path to `/`. It does — for
  // SPECIAL schemes. A custom-scheme redirect URI (the native-OAuth idiom) is not
  // one, nothing between `--redirect-uri` and here checks the scheme, and
  // `listenHostFor` only checks the HOST, so `foo://127.0.0.1:8723` arrives with a
  // `pathname` of `''`. Without the arm the route would match nothing at all and
  // the capture would hang until the deadline.
  assert.equal(new URL('foo://127.0.0.1:8723').pathname, '');

  const server = fakeCallbackServer();
  const pending = captureAuthorizationCode(
    { redirectUri: 'foo://127.0.0.1:8723', state: 'st' },
    { createServerImpl: server.create, clock: fakeClock(0) },
  );
  assert.deepEqual(server.listens, [{ port: 8723, host: '127.0.0.1' }]);
  assert.equal(server.send('/callback?code=wrong&state=st').status, 404);
  assert.equal(await isPending(pending), true, 'the root is the only route that settles');

  assert.equal(server.send('/?code=real&state=st').status, 200);
  assert.equal(await pending, 'real');
});

test('captureAuthorizationCode rejects a state mismatch and an explicit denial', async () => {
  const mismatch = fakeCallbackServer();
  const p1 = captureAuthorizationCode(
    { redirectUri: 'http://127.0.0.1:8723/callback', state: 'expected' },
    { createServerImpl: mismatch.create, clock: fakeClock(0) },
  );
  assert.equal(mismatch.send('/callback?code=c&state=forged').status, 400);
  await assert.rejects(p1, (err: unknown) => isInstagramError(err) && err.kind === 'auth');
  assert.equal(mismatch.closes(), 1);

  const denied = fakeCallbackServer();
  const p2 = captureAuthorizationCode(
    { redirectUri: 'http://127.0.0.1:8723/callback', state: 's' },
    { createServerImpl: denied.create, clock: fakeClock(0) },
  );
  denied.send('/callback?error=access_denied&error_description=User+said+no&state=s');
  await assert.rejects(
    p2,
    (err: unknown) =>
      isInstagramError(err) && err.kind === 'auth' && /User said no/.test(err.message),
  );
});

test('captureAuthorizationCode times out on the injected clock with an actionable error', async () => {
  // Regression: the capture had no deadline at all, so a redirect that never
  // arrives (unregistered URI, wrong loopback family) hung `login` forever.
  const server = fakeCallbackServer();
  const clock = fakeClock(0);
  // Spelled "localhost" on purpose: it is the one case where the URI text and
  // the address actually bound differ, so the message can be held to naming
  // BOTH. That pair is the whole diagnosis for the commonest field failure — a
  // browser that resolved localhost to ::1 and never reached this listener.
  const pending = captureAuthorizationCode(
    { redirectUri: 'http://localhost:8723/callback', state: 's' },
    { createServerImpl: server.create, clock, timeoutMs: 300_000 },
  );

  clock.advance(299_999);
  assert.equal(await isPending(pending), true, 'the capture waits out its full budget');
  assert.equal(server.closes(), 0);

  clock.advance(1);
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(isInstagramError(err));
    assert.match(err.message, /timed out/i);
    // A wait that ends on its own deadline is not the operator's argument
    // error: `validation` would tell them to fix a flag, when what they must
    // fix is the app registration or the browser.
    assert.equal(err.kind, 'upstream');
    assert.match(err.message, /after 5 minute/, 'the budget is reported in minutes, as spent');
    assert.ok(
      err.message.includes('http://localhost:8723/callback'),
      'the URI as the browser received it must be quoted for comparison with the Meta app',
    );
    assert.ok(
      err.message.includes('127.0.0.1'),
      'the address that was actually bound must be named, or the ::1 mismatch is invisible',
    );
    assert.match(err.message, /Valid OAuth Redirect URIs/i);
    return true;
  });
  assert.equal(server.closes(), 1, 'the listener is released on timeout');
});

test('a sub-minute capture budget still reports at least one minute, never zero', async () => {
  // Corner case: the timeout line renders `timeoutMs / 60_000`. Truncating
  // instead of rounding prints "Timed out after 0 minute(s)" for any budget
  // shorter than a minute, which reads as though no wait happened at all and
  // sends the operator looking for a crash. Only a budget that is not a whole
  // number of minutes can tell the two spellings apart.
  const server = fakeCallbackServer();
  const clock = fakeClock(0);
  const pending = captureAuthorizationCode(
    { redirectUri: 'http://127.0.0.1:8723/callback', state: 's' },
    { createServerImpl: server.create, clock, timeoutMs: 30_000 },
  );

  clock.advance(30_000);
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(isInstagramError(err));
    assert.match(err.message, /after 1 minute/, 'a 30s budget rounds up rather than flooring to 0');
    return true;
  });
});

test('an explicit zero capture budget is honoured, not read as "use the default"', async () => {
  // `deps.timeoutMs ?? CAPTURE_TIMEOUT_MS` and `deps.timeoutMs || CAPTURE_TIMEOUT_MS`
  // are indistinguishable on every value but one, and it is the value a caller
  // uses to say "do not wait at all": zero. Under `||` that budget silently
  // becomes five minutes, so a caller that asked to fail fast blocks instead —
  // and the regression never surfaces as a wrong answer, only as a command that
  // appears to have hung.
  const server = fakeCallbackServer();
  const clock = fakeClock(0);
  const pending = captureAuthorizationCode(
    { redirectUri: 'http://127.0.0.1:8723/callback', state: 's' },
    { createServerImpl: server.create, clock, timeoutMs: 0 },
  );

  // Fuse. A regression leaves this promise pending forever on a clock that
  // never moves again, and `npm test` passes no --test-timeout: awaiting the
  // rejection directly would hang CI instead of failing it. Settling is checked
  // across one macrotask first, so the regression fails in milliseconds.
  assert.equal(await isPending(pending), false, 'a zero budget must expire immediately');
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(isInstagramError(err));
    assert.match(err.message, /timed out after 0 minute/i, 'the budget is reported as spent');
    return true;
  });
  assert.equal(server.closes(), 1, 'the listener is released');
});

test('a captured code settles before the deadline and later time travel is inert', async () => {
  const server = fakeCallbackServer();
  const clock = fakeClock(0);
  const pending = captureAuthorizationCode(
    { redirectUri: 'http://127.0.0.1:8723/callback', state: 's' },
    { createServerImpl: server.create, clock, timeoutMs: 300_000 },
  );

  const answer = server.send('/callback?code=good&state=s');
  assert.equal(answer.status, 200);
  // The redirect lands in the operator's BROWSER, not in the terminal they are
  // watching. An empty 200 leaves them on a blank tab with no sign the CLI
  // received anything, and the natural reaction — reload, or run login again —
  // replays a code that has already been spent.
  assert.match(answer.body, /close this window/i, 'the browser is told the login is complete');
  assert.equal(await pending, 'good');

  clock.advance(10 * 300_000); // The elapsed timeout must not re-settle or re-close.
  assert.equal(await pending, 'good');
  assert.equal(server.closes(), 1);
});

test('a listen failure surfaces as a validation error naming the address and the way out', async () => {
  const server = fakeCallbackServer();
  const pending = captureAuthorizationCode(
    { redirectUri: 'http://127.0.0.1:8723/callback', state: 's' },
    { createServerImpl: server.create, clock: fakeClock(0) },
  );
  const failure = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
  server.fail(failure);

  await assert.rejects(pending, (err: unknown) => {
    assert.ok(isInstagramError(err));
    assert.equal(err.kind, 'validation');
    // The whole sentence, not just the address and the errno inside it. The
    // second half is the only actionable part — it names both causes an
    // operator can do something about and the one flag that settles either —
    // and `EADDRINUSE` on its own is a line they cannot act on. A substring
    // check over the first half cannot tell a message that lost the remedy
    // from one that still carries it (CC-PROC-74).
    assert.equal(
      err.message,
      'Could not listen on 127.0.0.1:8723 for the OAuth redirect (listen EADDRINUSE). ' +
        'Another login may be running, or the port is taken — pass --redirect-uri with a free ' +
        'port that is also registered in your Meta app.',
    );
    // The wrapped message keeps only `err.message`; the errno, the syscall and
    // the family live on the original object. Without it on `cause`, an
    // EACCES on a privileged port and an EADDRINUSE from a second login are
    // indistinguishable in a structured log.
    assert.equal(err.cause, failure);
    return true;
  });
});

// The capture ends in one of four refusals, and an operator sees exactly one
// line for whichever one fired: `login` exits, the browser tab is the only
// other artefact, and there is no log to correlate against. Every one of the
// four is built from two halves — what happened, and what to do about it — and
// only the first half was load-bearing for the assertions above. `/User said
// no/`, `includes('"0.0.0.0"')`, `/after 5 minute/` and a bare `kind === 'auth'`
// all keep passing after the second half has been deleted, reworded into a
// restatement of the rule the operator already broke, or had its interpolated
// value left in a sentence that no longer says what the value IS — and the
// interpolated value is the entire diagnosis in three of the four: the host
// that got through, the reason Meta gave, the address this process actually
// bound. That is the exact shape of a careless refactor of a string nobody can
// rehearse: a live login needs a registered Meta app, so none of these four
// sentences is ever read by the author of the change that breaks them
// (CC-PROC-74).
//
// One table, whole messages. The fragment assertions above stay as they are:
// they are about the KIND of each refusal (`validation` for an argument the
// operator can fix, `auth` for a rejected authorization, `upstream` for a wait
// that ended on its own deadline), about the listener being released, and about
// nothing being bound on a routable interface — properties of the error object
// and of the server, not of the wording, and none of them is weakened by a
// second assertion on the text.
test('every capture refusal is pinned whole: the cause and the way out, in one message', async () => {
  const refusals: { what: string; produce: () => Promise<unknown>; message: string }[] = [
    {
      what: 'a redirect URI that is not loopback',
      // The only refusal of the four that is raised before anything binds, and
      // the only one whose remedy is a concrete URI the operator can paste into
      // both the flag and the Meta app. "Loopback only" without it is a rule
      // restated at someone who has just discovered they broke it.
      produce: async () => listenHostFor('http://0.0.0.0:8723/callback'),
      message:
        'login can only capture the OAuth redirect on 127.0.0.1 or [::1], but --redirect-uri ' +
        `points at "0.0.0.0". Use ${DEFAULT_REDIRECT_URI} (and register it in your Meta app), ` +
        'or capture the code yourself.',
    },
    {
      what: 'an authorization the user declined',
      // `error_description` is Meta's own words for why the grant did not
      // happen ("User said no", but also a disabled app, a missing role, a
      // business-verification block). Kept verbatim after a prefix that says
      // whose decision this was, because the prefix is what tells the operator
      // the CLI is not the thing that failed.
      produce: async () => {
        const server = fakeCallbackServer();
        const pending = captureAuthorizationCode(
          { redirectUri: 'http://127.0.0.1:8723/callback', state: 's' },
          { createServerImpl: server.create, clock: fakeClock(0) },
        );
        server.send('/callback?error=access_denied&error_description=User+said+no&state=s');
        return pending;
      },
      message: 'Authorization was denied: User said no',
    },
    {
      what: 'a callback whose state does not match',
      // The one message of the four with no interpolation and nothing to fix:
      // it is a CSRF refusal, and the neighbouring assertions only check
      // `kind === 'auth'`, which a denial carries too. Reworded to anything
      // that reads like a local failure ("Login failed", "Invalid response")
      // this becomes indistinguishable from a broken install, and the operator
      // retries the exact flow that was just rejected instead of asking why a
      // forged callback reached their loopback port.
      produce: async () => {
        const server = fakeCallbackServer();
        const pending = captureAuthorizationCode(
          { redirectUri: 'http://127.0.0.1:8723/callback', state: 'expected' },
          { createServerImpl: server.create, clock: fakeClock(0) },
        );
        server.send('/callback?code=c&state=forged');
        return pending;
      },
      message: 'OAuth state mismatch — aborting.',
    },
    {
      what: 'a redirect that never arrived',
      // Spelled "localhost" so the two addresses in the message differ, which
      // is what makes its last clause checkable at all. The clause is the
      // diagnosis for the commonest field failure there is: the browser
      // resolved `localhost` to ::1, this listener is on 127.0.0.1, and the two
      // never meet. Nothing else in the run says so — and the sentence carries
      // the three facts an operator needs to see it (the URI as sent, the
      // address bound, and the resolution that separates them) in the one place
      // they are side by side.
      produce: async () => {
        const server = fakeCallbackServer();
        const clock = fakeClock(0);
        const pending = captureAuthorizationCode(
          { redirectUri: 'http://localhost:8723/callback', state: 's' },
          { createServerImpl: server.create, clock, timeoutMs: 300_000 },
        );
        clock.advance(300_000);
        return pending;
      },
      message:
        'Timed out after 5 minute(s) waiting for the OAuth redirect to ' +
        'http://localhost:8723/callback. Check that this EXACT URI is registered in your Meta ' +
        'app (App settings -> Instagram/Facebook Login -> Valid OAuth Redirect URIs), that you ' +
        'completed the browser prompt, and that the redirect URI host matches the address this ' +
        'listener bound (127.0.0.1) — a URI spelled "localhost" can resolve to ::1 and never ' +
        'reach it.',
    },
  ];

  for (const { what, produce, message } of refusals) {
    const err: unknown = await produce().then(
      (value): never => assert.fail(`${what} must be refused, but resolved with ${String(value)}`),
      (reason: unknown) => reason,
    );
    assert.ok(isInstagramError(err), `${what} is refused with an InstagramError`);
    assert.equal(err.message, message, what);
  }
});

test('classifyCallbackRequest routes by path, error, code and state', () => {
  const base = { expectedPath: '/callback', state: 'st' };
  assert.equal(classifyCallbackRequest({ ...base, requestUrl: undefined }).kind, 'ignore');
  assert.equal(classifyCallbackRequest({ ...base, requestUrl: '/other?code=c' }).kind, 'ignore');
  assert.equal(classifyCallbackRequest({ ...base, requestUrl: '/callback' }).kind, 'ignore');
  assert.equal(
    classifyCallbackRequest({ ...base, requestUrl: '/callback?error=denied&state=st' }).kind,
    'denied',
  );
  assert.equal(
    classifyCallbackRequest({ ...base, requestUrl: '/callback?code=c&state=nope' }).kind,
    'state-mismatch',
  );
  const ok = classifyCallbackRequest({ ...base, requestUrl: '/callback?code=c&state=st' });
  assert.equal(ok.kind, 'code');
  assert.equal(ok.kind === 'code' ? ok.code : undefined, 'c');

  // A denial arrives with no `error_description` when the user simply closes the
  // consent screen; only the OAuth error CODE is available then, and it is what
  // tells the operator whether they cancelled, the app is in dev mode, or a scope
  // was withheld. Falling back to an empty string prints "Authorization was
  // denied:" with the diagnosis missing. The echoed `state` is what makes this a
  // denial at all rather than a CSRF refusal — see the gate test below.
  const bare = classifyCallbackRequest({
    ...base,
    requestUrl: '/callback?error=access_denied&state=st',
  });
  assert.equal(bare.kind === 'denied' ? bare.reason : undefined, 'access_denied');
});

test('a callback that carries NO state at all is rejected, not accepted as a match', () => {
  // The state check is the only thing standing between this listener and a
  // forged authorization code. An absent parameter must count as a mismatch: any
  // page the operator's browser visits during the login can issue
  // `GET http://127.0.0.1:8723/callback?code=<attacker's code>` with no state at
  // all, and if that is treated as a match, the CLI exchanges the ATTACKER's
  // code and writes a token for the ATTACKER's Instagram account into the
  // operator's config — every later publish and every comment reply goes there.
  const outcome = classifyCallbackRequest({
    expectedPath: '/callback',
    state: 'st',
    requestUrl: '/callback?code=forged',
  });
  assert.equal(outcome.kind, 'state-mismatch');
  assert.equal(outcome.status, 400, 'the sender must not be told the request was accepted');
});

test('a denial is honoured only when it echoes the state, so a forged one cannot fake a refusal', () => {
  // RFC 6749 §4.1.2.1 requires the authorization server to echo `state` on the
  // ERROR redirect too whenever the request carried one — and this client always
  // sends one. A denial that arrives without it therefore did not come from Meta.
  // The check used to sit AFTER the `error` branch, so any page the operator's
  // browser had open during the login could issue
  // `GET http://127.0.0.1:8723/callback?error=access_denied&error_description=<text>`
  // and end the capture with the CLI telling the operator, in Meta's own voice,
  // that THEY declined consent — while the real consent screen was still open and
  // the genuine redirect, arriving second, found the listener already closed. The
  // operator's diagnosis is then the one thing that cannot help them: they go
  // looking at their own click instead of at the page that forged it.
  const base = { expectedPath: '/callback', state: 'st' };
  const answer = (requestUrl: string) => classifyCallbackRequest({ ...base, requestUrl });

  for (const forged of [
    '/callback?error=access_denied',
    '/callback?error=access_denied&error_description=User+said+no',
    '/callback?error=access_denied&state=',
    '/callback?error=access_denied&state=forged',
  ]) {
    assert.equal(
      answer(forged).kind,
      'state-mismatch',
      `${forged} must be refused as CSRF, not reported to the operator as their own denial`,
    );
  }

  // The genuine denial still is one, and still carries the reason that tells the
  // operator whether they cancelled, the app is in dev mode, or a scope was
  // withheld — the state check is a gate in front of that branch, not a
  // replacement for it.
  const real = answer('/callback?error=access_denied&state=st');
  assert.equal(real.kind, 'denied');
  assert.equal(real.kind === 'denied' ? real.reason : undefined, 'access_denied');

  // ...and the gate must not swallow requests that are not an authorization
  // response at all. Neither `code` nor `error` is present on a plain browser hit
  // of the path, and `state` is absent from it too; treating THAT as a mismatch
  // would let the operator abort their own login by reloading the tab, which is
  // exactly the outcome the 'ignore' arm exists to prevent.
  assert.equal(answer('/callback').kind, 'ignore');
  assert.equal(answer('/callback?state=st').kind, 'ignore');
  assert.equal(answer('/callback?state=forged').kind, 'ignore');

  // An empty `?error=` IS an authorization response — the parameter is present —
  // so it passes through the gate rather than around it.
  assert.equal(answer('/callback?error=').kind, 'state-mismatch');
  assert.equal(answer('/callback?error=&state=st').kind, 'denied');
});

test('the state comparison is exact, and a REPEATED parameter cannot smuggle a second value', () => {
  // Corner case: parameter smuggling and a loosened comparison. The listener
  // answers whatever the operator's browser is pointed at, so a page open in a
  // tab during the login can issue `GET /callback?...` with any query it likes.
  // Everything below is a comparison that still looks like a state check while
  // widening the set of accepted callbacks; each is a real spelling someone
  // reaches for (`toLowerCase()` "to be lenient", `startsWith` "to ignore a
  // suffix", reading the LAST value "because the browser appended ours").
  const base = { expectedPath: '/callback', state: 'ab12cd' };
  const kind = (requestUrl: string): string =>
    classifyCallbackRequest({ ...base, requestUrl }).kind;

  // `URLSearchParams.get` returns the FIRST occurrence. Pinning that in both
  // orders is what makes the choice visible: reading the last value instead
  // would let an appended `&state=<expected>` validate a callback whose own
  // state was wrong, and an appended `&code=` swap the code that gets exchanged.
  assert.equal(kind('/callback?code=c&state=ab12cd&state=wrong'), 'code');
  assert.equal(kind('/callback?code=c&state=wrong&state=ab12cd'), 'state-mismatch');
  const repeated = classifyCallbackRequest({
    ...base,
    requestUrl: '/callback?code=real&code=forged&state=ab12cd',
  });
  assert.equal(repeated.kind === 'code' ? repeated.code : undefined, 'real');

  // Case, a longer value that merely starts with the expected one, and a
  // truncation are all mismatches. The state is lowercase hex, so a
  // case-insensitive compare is not exploitable on its own — it is pinned
  // because "exact" is the property, and the next person to widen it will not
  // stop at case.
  assert.equal(kind('/callback?code=c&state=AB12CD'), 'state-mismatch');
  assert.equal(kind('/callback?code=c&state=ab12cd0'), 'state-mismatch');
  assert.equal(kind('/callback?code=c&state=ab12'), 'state-mismatch');
});

test('an OAuth error with an EMPTY value is still a denial, not a callback to act on', () => {
  // Corner case: a present-but-empty parameter. `?error=` parses to `''`, which
  // is falsy — a guard written `if (error)` instead of `if (error !== null)`
  // would fall through to the code branch and let `?error=&code=<forged>` be
  // exchanged. The empty value carries no diagnosis, so the reason is a fixed
  // phrase rather than nothing (CC-DATA-100); what matters most is that the
  // request is refused.
  const denied = classifyCallbackRequest({
    expectedPath: '/callback',
    state: 'st',
    requestUrl: '/callback?error=&code=forged&state=st',
  });
  assert.equal(denied.kind, 'denied');
  assert.equal(denied.status, 400);
  assert.equal(denied.kind === 'denied' ? denied.reason : 'unset', 'no reason given');
});

test('every callback answer carries the status and the sentence its case calls for', () => {
  // The `status`/`body` pair is not decoration: it is the ONLY thing a human
  // ever sees from this listener, because the redirect lands in the operator's
  // browser while the terminal is still waiting. A blank page says nothing
  // about whether the CLI took the code, and the natural reaction to a blank
  // page — reload, or run login again — replays an authorization code that has
  // already been spent, which fails with a message about the code rather than
  // about the reload. The status is read by the other audience: anything 2xx
  // tells a forged or malformed callback it was accepted, while a 404 on the
  // redirect path itself sends the operator hunting for a listener that is in
  // fact bound and answering. Both halves are pinned per case, exactly.
  const base = { expectedPath: '/callback', state: 'st' };
  // The helper returns the OUTCOME, it does not project two fields out of it.
  // A projection is a fresh object, so the old `{ status, body }` copy pinned
  // nothing about the outcome's own shape, and every other assertion in this
  // file reads `.kind` / `.code` / `.reason` one at a time. Measured: wrapping
  // all five returns of `classifyCallbackRequest` in
  // `Object.assign({ kind: '...' as const, ... }, { debugX: 'x' })` survived the
  // whole suite (268 ok, 0 not ok, exit 0) — five outcomes, none of them pinned
  // as a whole. This is the object that decides what the browser is told and
  // whether a code is exchanged, so every key it carries is pinned here.
  const answer = (requestUrl: string): CallbackOutcome =>
    classifyCallbackRequest({ ...base, requestUrl });

  assert.deepEqual(answer('/elsewhere?code=c&state=st'), {
    kind: 'ignore',
    status: 404,
    body: 'Not found.',
  });
  // Right path, nothing usable on it — 400, deliberately NOT the 404 that says
  // "no listener here".
  assert.deepEqual(answer('/callback'), {
    kind: 'ignore',
    status: 400,
    body: 'Missing authorization code.',
  });
  assert.deepEqual(answer('/callback?error=access_denied&state=st'), {
    kind: 'denied',
    status: 400,
    body: 'Authorization failed. You may close this window.',
    reason: 'access_denied',
  });
  assert.deepEqual(answer('/callback?code=c&state=forged'), {
    kind: 'state-mismatch',
    status: 400,
    body: 'State mismatch — request rejected.',
  });
  assert.deepEqual(answer('/callback?code=c&state=st'), {
    kind: 'code',
    code: 'c',
    status: 200,
    body: 'Login complete. You may close this window and return to the terminal.',
  });
});

test('classifyCallbackRequest rejects a callback when the expected state is itself absent', () => {
  // The CSRF check below the code lookup carried an equivalent-mutant note
  // blessing `!=` in place of `!==`: the left side is `string | null`, the right
  // side is a `string`, and the two operators only part company when BOTH sides
  // are nullish — which the declared type forecloses. The premise is the type,
  // not the code: nothing in `classifyCallbackRequest` looks at `params.state`,
  // so the day `state` turns optional — or a JavaScript caller reaches the
  // exported function with it missing — `get('state')` is `null`,
  // `null != undefined` is `false`, and the mutant ANSWERS `code`, handing the
  // authorization code to a forged callback. That is a CSRF bypass, not a
  // refactor. Measured 2026-09-23: this is the only assertion in the suite that
  // tells the two spellings apart.
  assert.deepEqual(
    classifyCallbackRequest({
      expectedPath: '/callback',
      state: undefined as unknown as string,
      requestUrl: '/callback?code=ABC',
    }),
    { kind: 'state-mismatch', status: 400, body: 'State mismatch — request rejected.' },
  );
});

// --- runLogin: argument handling --------------------------------------------

/** Collect stderr output for a runLogin invocation. */
function stderrSink(): { deps: Pick<LoginDeps, 'stderr'>; out: () => string } {
  const chunks: string[] = [];
  return { deps: { stderr: (m) => chunks.push(m) }, out: () => chunks.join('') };
}

test('runLogin --help prints usage (naming the registered Meta app) and exits 0', async () => {
  const { deps, out } = stderrSink();
  const code = await runLogin(['--help'], deps);
  assert.equal(code, 0);
  assert.ok(/registered meta app/i.test(out()), 'help states a registered Meta app is required');
  // The mode is the whole reason a sixty-day token may sit in a dotfile at all.
  // Stating it here is what lets an operator decide BEFORE running the command;
  // help that only says "written to a file" invites the reasonable-looking
  // reaction of copying that file somewhere friendlier to share.
  assert.match(out(), /chmod 0600/, 'help names the mode the token file is written with');
});

test('runLogin without --path exits 2', async () => {
  const { deps, out } = stderrSink();
  const code = await runLogin(['--app-id', 'a', '--app-secret', APP_SECRET], { ...deps, env: {} });
  assert.equal(code, 2);
  assert.ok(/--path/.test(out()));
});

test('runLogin without app credentials exits 2', async () => {
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig'], { ...deps, env: {} });
  assert.equal(code, 2);
  assert.ok(/app id and app secret/i.test(out()));
});

test('the --path refusal is exactly one line, a blank line, and the full usage text', async () => {
  // The refusal is what an operator reads after typing the command wrong, and
  // the usage text under it is the fix. A fragment match on `--path` would pass
  // with the help text gone, with the sentence rewritten around the flag, or
  // with the two run together on one line. The help text is taken from `--help`
  // itself so this pins the RELATION (refusal + blank line + the same usage),
  // not a second copy of the usage that could drift from the first.
  const help = stderrSink();
  assert.equal(await runLogin(['--help'], help.deps), 0);

  const { deps, out } = stderrSink();
  const code = await runLogin(['--app-id', 'a', '--app-secret', APP_SECRET], { ...deps, env: {} });
  assert.equal(code, 2);
  assert.equal(out(), `login: --path <ig|fb> is required.\n\n${help.out()}`);
});

test('the missing-credentials refusal names both the flags and the env vars, on one line', async () => {
  // Every clause of this line is a remediation: the flags, the env vars, and
  // the reason (a registered Meta app). A fragment match on "app id and app
  // secret" survives the loss of any of them, and an operator who is told only
  // WHAT is missing has to find HOW to supply it somewhere else.
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig'], { ...deps, env: {} });
  assert.equal(code, 2);
  assert.equal(
    out(),
    'login: an app id and app secret are required — pass --app-id/--app-secret ' +
      'or set IG_APP_ID/IG_APP_SECRET. A live login needs a registered Meta app.\n',
  );
});

test('half a credential pair is refused: an app id without its secret exits 2', async () => {
  // The guard is an OR, and the half-set case is the likely one: an app id is
  // safe to paste into a config file while the secret lives in a shell variable
  // that was never exported. Requiring only that BOTH are missing would let the
  // flow open a browser and then post `client_secret=undefined`, converting a
  // configuration mistake the command can name into an opaque OAuth rejection
  // from Meta after the operator has already authorized.
  const refusesNetwork = (async () => {
    throw new Error('no exchange may be attempted without a complete credential pair');
  }) as typeof fetch;

  for (const argv of [
    ['--path', 'ig', '--app-id', '55500'],
    ['--path', 'ig', '--app-secret', APP_SECRET],
  ]) {
    const { deps, out } = stderrSink();
    const code = await runLogin(argv, {
      ...deps,
      env: {},
      fetchFn: refusesNetwork,
      // Injected so a guard that stops guarding fails as a wrong exit code
      // rather than binding a real listener and waiting five minutes.
      captureCode: async () => 'auth-code',
    });
    assert.equal(code, 2, `[${argv.join(' ')}] is incomplete and must be refused`);
    assert.ok(/app id and app secret/i.test(out()), `[${argv.join(' ')}] named the wrong problem`);
  }
});

// --- runLogin: full flow with injected browser + persist --------------------

/** A recording fake persist that captures the credentials it was asked to store. */
function fakePersist(): {
  persist: LoginDeps['persist'];
  seen: Array<{ profile: string; creds: Credentials }>;
} {
  const seen: Array<{ profile: string; creds: Credentials }> = [];
  const persist = async (profile: string, creds: Credentials): Promise<WriteCredentialsResult> => {
    seen.push({ profile, creds });
    return { path: `/tmp/fake/${profile}.env`, keys: ['IG_ACCESS_TOKEN'] };
  };
  return { persist, seen };
}

/**
 * The usage text as `--help` prints it, for refusals pinned as "one line, a
 * blank line, the whole usage": taken from the command itself so the pin is
 * the RELATION between the two, not a second copy of the usage that could
 * drift from the first.
 */
async function helpText(): Promise<string> {
  const { deps, out } = stderrSink();
  assert.equal(await runLogin(['--help'], { ...deps, env: {} }), 0);
  return out();
}

/**
 * Deps for a command line that must stop at argument parsing. Every step past
 * the parser — opening the browser, capturing the code, the exchanges, the
 * persist — records itself in `steps`, and the fetch throws as well, so a
 * refusal that leaks through shows up twice: as the wrong exit code and as a
 * step that ran. A refusal test asserts `steps` is empty, whole.
 */
function mustStopAtParsing(env: NodeJS.ProcessEnv = {}): {
  deps: LoginDeps;
  out: () => string;
  steps: string[];
} {
  const steps: string[] = [];
  const { deps: sink, out } = stderrSink();
  const fetchFn = (async (): Promise<Response> => {
    steps.push('fetch');
    throw new Error('a refused command line must not reach a token exchange');
  }) as typeof fetch;
  const persist = async (profile: string): Promise<WriteCredentialsResult> => {
    steps.push('persist');
    return { path: `/tmp/fake/${profile}.env`, keys: [] };
  };
  return {
    steps,
    out,
    deps: {
      ...sink,
      env,
      fetchFn,
      persist,
      now: () => 0,
      openUrl: () => {
        steps.push('open');
      },
      captureCode: async () => {
        steps.push('capture');
        return 'auth-code';
      },
    },
  };
}

test('runLogin (fb-login) exchanges code -> short -> long, persists, exits 0, prints no token', async () => {
  const { fetchFn } = routingFetch([
    // Long-lived exchange is distinguished by the fb_exchange_token grant.
    { match: 'fb_exchange_token', body: { access_token: LONG_TOKEN, expires_in: 5184000 } },
    // The code exchange (no grant param) matches the plain endpoint.
    {
      match: `graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
      body: { access_token: SHORT_TOKEN, expires_in: 3600 },
    },
  ]);
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();

  let capturedState: string | undefined;
  const code = await runLogin(['--path', 'fb', '--app-id', 'app', '--app-secret', APP_SECRET], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    now: () => 2_000_000,
    makeState: () => 'fixed-state',
    captureCode: async (p) => {
      capturedState = p.state;
      return 'auth-code-123';
    },
  });

  assert.equal(code, 0);
  assert.equal(capturedState, 'fixed-state', 'the OAuth state is threaded to the capture step');
  assert.equal(seen.length, 1);
  const { profile, creds } = seen[0]!;
  assert.equal(profile, 'default');
  // The WHOLE record, in one assertion — this is the object `writeCredentials`
  // turns into lines of the operator's config file, so a field added to it is a
  // value written to disk under their name. The five field reads this replaces
  // could not see that: measured, wrapping the literal in
  // `Object.assign({ ...the record... }, { debugX: 'x' })` survived the whole
  // suite (268 ok, 0 not ok, exit 0). `accessToken` is still the LONG-lived
  // token, and `accountId` is listed explicitly because Path B's code exchange
  // returns no `user_id` — the key is present and undefined, and deepEqual
  // counts a key whose value is undefined.
  assert.deepEqual(creds, {
    accessToken: LONG_TOKEN,
    authPath: 'fb-login',
    accountId: undefined,
    appId: 'app',
    appSecret: APP_SECRET,
    expiresAtSec: 2000 + 5184000,
  });

  const printed = out();
  // The stored expiry is epoch SECONDS; rendering it needs the ×1000. Feeding
  // seconds straight to `new Date` dates a sixty-day token to 1970, and that
  // line is the only place the operator can see when they must log in again.
  assert.match(
    printed,
    /Token expires at 1970-03-02T00:33:20\.000Z\./,
    'the expiry is printed from epoch seconds (now 2_000_000 ms + 60 days)',
  );
  assert.ok(!printed.includes(LONG_TOKEN), 'the long-lived token is never printed');
  assert.ok(!printed.includes(SHORT_TOKEN), 'the short-lived token is never printed');
  assert.ok(!printed.includes(APP_SECRET), 'the app secret is never printed');
});

test('runLogin (ig-login) adopts the returned user id as the account id', async () => {
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: 5184000 },
    },
  ]);
  const { persist, seen } = fakePersist();
  const { deps } = stderrSink();

  const code = await runLogin(['--path', 'ig', '--app-id', '55500', '--app-secret', APP_SECRET], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    now: () => 0,
    captureCode: async () => 'auth-code',
  });

  assert.equal(code, 0);
  assert.equal(seen[0]?.creds.accountId, '178414', 'user_id becomes the accountId when none given');
  assert.equal(seen[0]?.creds.authPath, 'ig-login');
});

test('runLogin reads app credentials and account id from the environment', async () => {
  const { fetchFn } = routingFetch([
    { match: 'api.instagram.com/oauth/access_token', body: { access_token: SHORT_TOKEN } },
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: 0 },
    },
  ]);
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();

  const code = await runLogin(['--path', 'ig'], {
    ...deps,
    env: { IG_APP_ID: 'env-app', IG_APP_SECRET: APP_SECRET, IG_ACCOUNT_ID: 'env-account' },
    fetchFn,
    persist,
    captureCode: async () => 'auth-code',
  });

  assert.equal(code, 0);
  assert.equal(seen[0]?.creds.appId, 'env-app');
  assert.equal(seen[0]?.creds.accountId, 'env-account', 'explicit account id wins over user_id');
  assert.equal(seen[0]?.creds.expiresAtSec, 0, 'expires_in=0 => never expires');
  // 0 is the sentinel for "never", not a real instant. Falling through to the
  // timestamp branch would print `Token expires at 1970-01-01T00:00:00.000Z` and
  // send the operator hunting for a re-login they do not need.
  assert.match(out(), /Token expiry: never\./);
});

test('the app credentials are trimmed on their way out of the environment', async () => {
  // These usually arrive from a `.env` file or `IG_APP_ID=$(cat id.txt)`, both of
  // which keep the trailing newline. Meta answers a padded `client_id` with a
  // generic "Invalid platform app" page in the BROWSER — nothing reaches the
  // terminal — and a padded account id would be written into the config and
  // never match the account it names.
  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps } = stderrSink();

  const code = await runLogin(['--path', 'ig'], {
    ...deps,
    env: {
      IG_APP_ID: ' 55500\n',
      IG_APP_SECRET: `\t${APP_SECRET} `,
      IG_ACCOUNT_ID: ' 17841400000000000 ',
    },
    fetchFn,
    persist,
    now: () => 0,
    captureCode: async () => 'auth-code',
  });

  assert.equal(code, 0);
  assert.equal(seen[0]?.creds.appId, '55500');
  assert.equal(seen[0]?.creds.appSecret, APP_SECRET);
  assert.equal(seen[0]?.creds.accountId, '17841400000000000');
});

test('the auth path may come from the environment, and an explicit --path outranks it', async () => {
  // An MCP client config hands this command its environment, not its argv, so
  // the path has to be settable there; `IG_AUTH_MODE` is the older spelling that
  // still sits in installed configs. When both are present `IG_AUTH_PATH` wins,
  // and a flag wins over either — otherwise an operator debugging a Path-B
  // account with `--path fb` would keep silently running Path A and blame the
  // endpoints for credentials that "stopped working".
  const cases: Array<{ argv: string[]; env: NodeJS.ProcessEnv; expected: string }> = [
    { argv: [], env: { IG_AUTH_PATH: 'fb' }, expected: 'fb-login' },
    { argv: [], env: { IG_AUTH_MODE: 'ig' }, expected: 'ig-login' },
    { argv: [], env: { IG_AUTH_PATH: 'ig', IG_AUTH_MODE: 'fb' }, expected: 'ig-login' },
    { argv: ['--path', 'fb'], env: { IG_AUTH_PATH: 'ig' }, expected: 'fb-login' },
    // Shells and manifests are not careful about case; `FB` is the same request.
    { argv: ['--path', 'FB'], env: {}, expected: 'fb-login' },
    // The long form is not a courtesy alias: `ig-login`/`fb-login` is the exact
    // spelling this command WRITES into the env file as IG_AUTH_PATH, so it is
    // what a second login re-reads from the environment and what an operator
    // copies back onto the command line. Dropping either alias would make the
    // command reject its own output with "--path is required".
    { argv: [], env: { IG_AUTH_PATH: 'ig-login' }, expected: 'ig-login' },
    { argv: ['--path', 'fb-login'], env: {}, expected: 'fb-login' },
  ];

  for (const { argv, env, expected } of cases) {
    const { fetchFn } = bothPathRoutes();
    const { persist, seen } = fakePersist();
    const { deps } = stderrSink();
    const code = await runLogin([...argv, '--app-id=55500', `--app-secret=${APP_SECRET}`], {
      ...deps,
      env,
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async () => 'auth-code',
    });
    const label = `argv [${argv.join(' ')}] env ${JSON.stringify(env)}`;
    assert.equal(code, 0, `${label} did not complete`);
    assert.equal(seen[0]?.creds.authPath, expected, `${label} chose the wrong path`);
  }
});

test('runLogin returns 1 when an exchange fails', async () => {
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      status: 400,
      body: { error: { message: 'bad code' } },
    },
  ]);
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();

  const code = await runLogin(['--path', 'ig', '--app-id', 'a', '--app-secret', APP_SECRET], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    captureCode: async () => 'bad',
  });

  assert.equal(code, 1);
  assert.equal(seen.length, 0, 'nothing is persisted on failure');
  // The whole line, anchored. `String(err)` on an Error prepends its class name,
  // so the operator would read `login failed: InstagramError: bad code` — the
  // implementation detail placed exactly where Meta's own wording belongs, and
  // the first thing they would paste into a search box.
  assert.match(out(), /^login failed: bad code$/m);
});

test('runLogin redacts the app secret, the code and the short token out of a failure line', async () => {
  // An upstream message can quote what it was sent. None of these three values
  // has the `EAA…`/`IG…` token shape, so only exact-value redaction masks them.
  const CODE = 'AUTHcode-0123456789';
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    {
      match: 'graph.instagram.com/access_token',
      status: 400,
      body: {
        error: { message: `bad exchange: token=${SHORT_TOKEN} secret=${APP_SECRET} code=${CODE}` },
      },
    },
  ]);
  const { persist } = fakePersist();
  const { deps, out } = stderrSink();

  const code = await runLogin(['--path', 'ig', '--app-id', 'a', '--app-secret', APP_SECRET], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    captureCode: async () => CODE,
  });

  assert.equal(code, 1);
  assert.match(
    out(),
    /^login failed: bad exchange: token=\[REDACTED\] secret=\[REDACTED\] code=\[REDACTED\]$/m,
  );
  for (const secret of [SHORT_TOKEN, APP_SECRET, CODE]) assert.ok(!out().includes(secret));
});

test('runLogin bounds and escapes the Graph message of a refused exchange (CC-DATA-93)', async () => {
  // Before the fix a newline in Meta's text printed a forged second line under
  // `login failed:`, and nothing bounded its length.
  const forged = `denied\nOK  logged in as someone\u001b[2J ${'word '.repeat(190)}${APP_SECRET} end`;
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    {
      match: 'graph.instagram.com/access_token',
      status: 400,
      body: { error: { message: forged } },
    },
  ]);
  const { persist } = fakePersist();
  const { deps, out } = stderrSink();

  const code = await runLogin(['--path', 'ig', '--app-id', 'a', '--app-secret', APP_SECRET], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    captureCode: async () => 'auth-code',
  });

  assert.equal(code, 1);
  const total = Array.from(forged).length;
  assert.ok(total > 1000);
  // The app secret straddles the cap: the word-safe cut drops it whole, so no
  // prefix of it escapes the exact-value redactor in the catch.
  const expected =
    `login failed: denied\\u{a}OK  logged in as someone\\u{1b}[2J ${'word '.repeat(190)}` +
    `… (${total} characters in all)`;
  const lines = out().split('\n');
  assert.deepEqual(
    lines.filter((line) => line.startsWith('login failed:')),
    [expected],
  );
  // No forged line: nothing Meta sent starts a line of its own.
  assert.ok(!lines.some((line) => line.startsWith('OK')));
  assert.ok(!out().includes('app-secret'));
});

test('runLogin redacts the freshly minted long-lived token out of a persist failure', async () => {
  // Not token-shaped on purpose: the long token is masked by its exact value.
  const MINTED = 'MINTEDlongLIVEDvalue0123456789';
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    { match: 'graph.instagram.com/access_token', body: { access_token: MINTED, expires_in: 60 } },
  ]);
  const { deps, out } = stderrSink();

  const code = await runLogin(['--path', 'ig', '--app-id', 'a', '--app-secret', APP_SECRET], {
    ...deps,
    env: {},
    fetchFn,
    persist: async (_profile, creds) => {
      throw new Error(`EACCES writing IG_ACCESS_TOKEN=${creds.accessToken}`);
    },
    captureCode: async () => 'auth-code',
  });

  assert.equal(code, 1);
  assert.match(out(), /^login failed: EACCES writing IG_ACCESS_TOKEN=\[REDACTED\]$/m);
  assert.ok(!out().includes(MINTED));
});

// --- runLogin end-to-end through the REAL writeCredentials -----------------

test('runLogin wires the real writeCredentials: the token round-trips from the env file', async () => {
  const configHome = await makeTempConfigHome('igmcp-login-');
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: 5184000 },
    },
  ]);
  const { deps, out } = stderrSink();

  // No `persist` injected -> the real writeCredentials runs and resolves the
  // config home from the env map below. That map MUST carry the variable the
  // RUNNING platform reads (`%APPDATA%` on win32, `$XDG_CONFIG_HOME` elsewhere)
  // — with neither present the resolver falls back to the developer's real
  // config home and this write would replace a live IG_ACCESS_TOKEN there.
  // `configHomeEnv` picks the right one; see test/helpers/config-home.ts.
  const code = await runLogin(['--path', 'ig', '--app-id', '55500', '--app-secret', APP_SECRET], {
    ...deps,
    env: configHomeEnv(configHome),
    fetchFn,
    captureCode: async () => 'auth-code',
  });

  assert.equal(code, 0);
  const filePath = envFileIn(configHome);
  // The success line names the file that was written: assert it is the temp one,
  // so a write that escaped to the real config home fails loudly and precisely
  // instead of surfacing as a bare ENOENT on the read below.
  assert.ok(
    out().includes(filePath),
    `credentials were written outside the temp config home: ${out()}`,
  );
  const env = dotenv.parse(await readFile(filePath, 'utf8'));
  const { profiles } = loadProfiles(env);
  assert.equal(profiles[0]?.accessToken, LONG_TOKEN);
  assert.equal(profiles[0]?.authPath, 'ig-login');
});

// --- exchange failures that are not a Graph JSON error ----------------------

/** A `fetch` stub returning one raw body verbatim — JSON or otherwise. */
function rawFetch(status: number, body: string, contentType: string): typeof fetch {
  return async () => new Response(body, { status, headers: { 'content-type': contentType } });
}

test('a 200 exchange without an access_token is an auth error, not a silent empty token', async () => {
  // Graph answers 200 with `{"data": []}`-shaped bodies in several degenerate
  // cases. Treating that as success would persist an empty token and defer the
  // failure to the first tool call, where it reads as "your token expired".
  const fetchFn = rawFetch(200, JSON.stringify({ user_id: 178414 }), 'application/json');
  await assert.rejects(
    () =>
      exchangeCodeForToken(
        'ig-login',
        { code: 'c', appId: '55500', appSecret: APP_SECRET, redirectUri: DEFAULT_REDIRECT_URI },
        fetchFn,
      ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.kind, 'auth');
      // The whole sentence, not the word inside it: `access_token` is the name
      // of the field, of the query parameter and of half the vocabulary in
      // this file, so a fragment match survives almost any rewrite of the line
      // the operator actually reads (CC-PROC-74).
      assert.equal(err.message, 'Token exchange response did not include an access_token.');
      return true;
    },
  );
});

/** The response-body cap `core/body.ts` enforces, restated rather than imported. */
const BODY_CAP = 16 * 1024 * 1024;

/**
 * A `fetch` double serving a VALID token reply padded to exactly `total` bytes,
 * one 1 MiB chunk per pull, recording whether the reader let go of the stream.
 * Valid on purpose: an uncapped reader parses it and hands the token back, so
 * the only thing that can refuse it is the size.
 */
function paddedTokenFetch(
  total: number,
  token: string,
  status = 200,
): { fetchFn: typeof fetch; probe: { cancelled: boolean } } {
  const probe = { cancelled: false };
  const head = new TextEncoder().encode(`{"access_token":"${token}","pad":"`);
  const tail = new TextEncoder().encode('"}');
  const fetchFn = (async () => {
    let left = total - head.byteLength - tail.byteLength;
    let sentHead = false;
    let sentTail = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!sentHead) {
            sentHead = true;
            controller.enqueue(head);
          } else if (left > 0) {
            const n = Math.min(1024 * 1024, left);
            left -= n;
            controller.enqueue(new Uint8Array(n).fill(0x61));
          } else if (!sentTail) {
            sentTail = true;
            controller.enqueue(tail);
          } else {
            controller.close();
          }
        },
        cancel() {
          probe.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchFn, probe };
}

test('an oversized exchange reply is refused at the cap, upstream, quoting none of it (CC-PROC-203)', async () => {
  // `readJsonOrThrow` read the reply with `res.text()`: a body one byte over
  // 16 MiB was buffered whole and its token accepted. The token sits in the
  // FIRST chunk, so a refusal that quoted what it had read would print it; the
  // message must name the cap and nothing else. Driven through `runLogin` so the
  // line the operator reads is the one asserted.
  const token = 'TEST_TOKEN_OVERSIZE_LOGIN_0001';
  const { fetchFn, probe } = paddedTokenFetch(BODY_CAP + 1, token);
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    now: () => 0,
    captureCode: async () => 'auth-code',
  });
  assert.equal(code, 1);
  assert.equal(seen.length, 0, 'nothing is persisted');
  assert.equal(probe.cancelled, true, 'the reader lets go of the stream at the cap');
  assert.ok(!out().includes(token), 'no byte of the body reaches stderr');
  assert.ok(
    out().endsWith(
      'login failed: OAuth token exchange response body is larger than the 16 MiB this server ' +
        `buffers (more than ${BODY_CAP} bytes received); it was discarded unread. A token reply ` +
        'is a few hundred bytes, so check what any proxy between this machine and Meta is ' +
        'returning.\n',
    ),
    out(),
  );
});

test('an oversized exchange reply is upstream even on a 400, where the body would have said auth (CC-PROC-203)', async () => {
  // `exchangeError` answers `auth` for 400/401/403 because Meta's verdict is in
  // the body. A body too large to read carries no verdict, so the refusal keeps
  // the status and stays `upstream`. Declared up front, it is refused before a
  // byte is pulled.
  const { fetchFn: inner, probe } = paddedTokenFetch(BODY_CAP + 1, 'TEST_TOKEN_UNUSED_0002', 400);
  const fetchFn = (async (input: string | URL | Request, init?: FetchInit) => {
    const res = await inner(input, init);
    return new Response(res.body, {
      status: 400,
      headers: { 'content-length': String(BODY_CAP + 1) },
    });
  }) as typeof fetch;
  await assert.rejects(
    () =>
      exchangeForLongLivedToken(
        'fb-login',
        { shortToken: SHORT_TOKEN, appId: 'a', appSecret: APP_SECRET },
        fetchFn,
      ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.kind, 'upstream');
      assert.equal(err.status, 400);
      assert.match(err.message, new RegExp(`\\(Content-Length ${BODY_CAP + 1}\\)`));
      return true;
    },
  );
  assert.equal(probe.cancelled, true);
});

test('an exchange reply of exactly the cap is still read (CC-PROC-203)', async () => {
  const token = 'TEST_TOKEN_AT_CAP_LOGIN_0003';
  const { fetchFn, probe } = paddedTokenFetch(BODY_CAP, token);
  const out = await exchangeForLongLivedToken(
    'ig-login',
    { shortToken: SHORT_TOKEN, appId: 'a', appSecret: APP_SECRET },
    fetchFn,
  );
  assert.deepEqual(out, { accessToken: token, expiresInSec: undefined });
  assert.equal(probe.cancelled, false);
});

test('a numeric user_id past 2^53 is dropped, not stored as a neighbouring account (CC-AUTH-60)', async () => {
  // Written as raw text on purpose: `JSON.stringify` of the number would have
  // rounded it before the fetch double ever saw it. `JSON.parse` rounds the odd
  // 17-digit literal to the even double beside it, and `String()` of that is a
  // different account id — which `runLogin` then persisted as the profile's
  // account. Absent is the honest answer; a safe integer still passes through.
  const params = {
    code: 'c',
    appId: '55500',
    appSecret: APP_SECRET,
    redirectUri: DEFAULT_REDIRECT_URI,
  };
  const unsafe = rawFetch(
    200,
    `{"access_token":"${SHORT_TOKEN}","user_id":17841400008765431}`,
    'application/json',
  );
  assert.deepEqual(await exchangeCodeForToken('ig-login', params, unsafe), {
    accessToken: SHORT_TOKEN,
    userId: undefined,
  });
  const fractional = rawFetch(
    200,
    `{"access_token":"${SHORT_TOKEN}","user_id":178414.5}`,
    'application/json',
  );
  assert.equal((await exchangeCodeForToken('ig-login', params, fractional)).userId, undefined);
  const safe = rawFetch(
    200,
    `{"access_token":"${SHORT_TOKEN}","user_id":${Number.MAX_SAFE_INTEGER}}`,
    'application/json',
  );
  assert.equal(
    (await exchangeCodeForToken('ig-login', params, safe)).userId,
    String(Number.MAX_SAFE_INTEGER),
  );
});

test('a non-JSON error body degrades to an HTTP-status message and never surfaces the page', async () => {
  // A corporate proxy or captive portal answers the exchange with HTML, not
  // Graph JSON. The parse falls back to the raw string, which has no
  // `error.message`, so the message must come from the status — and the page
  // itself must not be echoed: it is attacker-influenced text that ends up in
  // the operator's terminal and, via `login failed: …`, in their logs.
  const page = '<html><body>Authentication required. Contact helpdesk@corp.example</body></html>';
  const fetchFn = rawFetch(502, page, 'text/html');
  await assert.rejects(
    () =>
      exchangeForLongLivedToken(
        'fb-login',
        { shortToken: SHORT_TOKEN, appId: 'a', appSecret: APP_SECRET },
        fetchFn,
      ),
    (err: unknown) => {
      assert.ok(isInstagramError(err), 'a non-JSON body must still map to an InstagramError');
      assert.equal(err.kind, 'upstream', '502 is not the operator’s credentials');
      assert.equal(err.status, 502);
      // Equality, not a fragment plus a blocklist of one string: the point of
      // this case is that NOTHING of the page reaches the message, and only an
      // exact match makes that claim total. `/HTTP 502/` with a
      // `!includes('helpdesk@corp.example')` beside it passes a message that
      // quotes any other part of the same page, and the address is not the only
      // attacker-influenced text on it.
      assert.equal(err.message, 'OAuth token exchange failed (HTTP 502).');
      return true;
    },
  );
});

test('a body that parses to JSON null is handled as an empty object, not dereferenced', async () => {
  // Corner case: `typeof null === 'object'`. A body of the literal `null`, and a
  // Graph envelope whose `error` member is `null`, both parse to a value that
  // passes a bare `typeof x === 'object'` test and then throws on the first
  // property read. Meta answers `null` on some malformed requests, and a proxy
  // that rewrites bodies can produce it on any status — so this reaches the
  // operator as `login failed: Cannot read properties of null (…)`, a message
  // that names neither the request that failed nor anything they can act on,
  // instead of the mapped auth/upstream error every other failure produces.
  await assert.rejects(
    () =>
      exchangeCodeForToken(
        'ig-login',
        { code: 'c', appId: '55500', appSecret: APP_SECRET, redirectUri: DEFAULT_REDIRECT_URI },
        rawFetch(200, 'null', 'application/json'),
      ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.kind, 'auth');
      // The whole sentence, not the `access_token` token inside it. A body of
      // `null` must arrive at the SAME message a 200 with no token produces —
      // that is the claim this case makes — and a fragment match cannot tell
      // the shared sentence from a second, differently worded one written for
      // this branch alone (CC-PROC-74).
      assert.equal(err.message, 'Token exchange response did not include an access_token.');
      return true;
    },
    'a 200 body of `null` is a missing token, not a TypeError',
  );

  await assert.rejects(
    () =>
      exchangeForLongLivedToken(
        'ig-login',
        { shortToken: SHORT_TOKEN, appId: 'a', appSecret: APP_SECRET },
        rawFetch(400, 'null', 'application/json'),
      ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.kind, 'auth');
      // `/HTTP 400/` also matches "HTTP 400" dropped into any sentence at all,
      // including one that went on to quote the request URL — the one thing
      // `exchangeError` exists to keep out, because that URL carries the app
      // secret. The fallback sentence is pinned whole, and the status is
      // pinned separately because it is the structured half a handler reads.
      assert.equal(err.message, 'OAuth token exchange failed (HTTP 400).');
      assert.equal(err.status, 400);
      return true;
    },
    'a non-2xx body of `null` still maps to the status',
  );

  await assert.rejects(
    () =>
      exchangeForLongLivedToken(
        'fb-login',
        { shortToken: SHORT_TOKEN, appId: 'a', appSecret: APP_SECRET },
        rawFetch(503, JSON.stringify({ error: null }), 'application/json'),
      ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      // 503 is outside the 400/401/403 set, so it is `upstream` and retryable
      // — the kind is what decides whether the operator is told to re-login or
      // to try again, and it is asserted here rather than left to the message.
      assert.equal(err.kind, 'upstream');
      assert.equal(err.message, 'OAuth token exchange failed (HTTP 503).');
      assert.equal(err.status, 503);
      return true;
    },
    'a null `error` member is an absent message, not a crash',
  );
});

// --- runLogin: argv parsing -------------------------------------------------

/** Pull the authorize URL out of the login transcript on stderr. */
function authorizeUrlFrom(transcript: string): URL {
  const match = /https:\/\/\S+/.exec(transcript);
  assert.ok(match, `no authorize URL in the login transcript: ${transcript}`);
  return new URL(match[0]);
}

/**
 * Every exchange route of BOTH paths at once, for cases whose subject is which
 * path gets chosen rather than what the exchange sends. Order matters: the
 * grant-specific matches must come before the endpoint they share.
 */
function bothPathRoutes(): { fetchFn: typeof fetch; urls: string[] } {
  return routingFetch([
    { match: 'fb_exchange_token', body: { access_token: LONG_TOKEN, expires_in: 5184000 } },
    {
      match: `graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
      body: { access_token: SHORT_TOKEN, expires_in: 3600 },
    },
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: 5184000 },
    },
  ]);
}

/** The two ig-login exchange routes, returning a `user_id` the caller can override. */
function igRoutes(): { fetchFn: typeof fetch } {
  return routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: 5184000 },
    },
  ]);
}

/**
 * `--path`, `--app-id` and `--app-secret` are enough to run a login, so every
 * flow above passes exactly those three and leaves the remaining four flags
 * parsed by nothing. They are precisely the ones an operator reaches for when a
 * default does not fit — a second account, a port that is already free, a
 * narrowed scope set — and a flag that is silently dropped looks identical to a
 * flag that worked until the wrong credentials land in the wrong profile.
 */
test('runLogin parses every value-taking flag in the space-separated form', async () => {
  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();
  let capturedRedirect: string | undefined;

  const code = await runLogin(
    [
      '--path',
      'ig',
      '--app-id',
      '55500',
      '--app-secret',
      APP_SECRET,
      '--profile',
      'SecondAccount',
      '--redirect-uri',
      'http://127.0.0.1:8123/oauth/callback',
      '--account-id',
      '17841400000000000',
      '--scopes',
      'instagram_business_basic',
    ],
    {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      makeState: () => 'fixed-state',
      captureCode: async (p) => {
        capturedRedirect = p.redirectUri;
        return 'auth-code';
      },
    },
  );

  assert.equal(code, 0);
  const { profile, creds } = seen[0]!;
  assert.equal(
    profile,
    'secondaccount',
    '--profile is lowercased to match the config-key convention',
  );
  assert.equal(
    creds.accountId,
    '17841400000000000',
    'an explicit --account-id must win over the user_id the exchange returned (178414)',
  );

  const authorize = authorizeUrlFrom(out());
  assert.equal(
    authorize.searchParams.get('redirect_uri'),
    'http://127.0.0.1:8123/oauth/callback',
    '--redirect-uri must reach the authorize URL; Meta rejects any URI not registered verbatim',
  );
  assert.equal(
    capturedRedirect,
    'http://127.0.0.1:8123/oauth/callback',
    'the listener must bind the same URI the browser was sent to, or the redirect lands nowhere',
  );
  assert.equal(
    authorize.searchParams.get('scope'),
    'instagram_business_basic',
    '--scopes replaces the default set rather than adding to it',
  );
});

/**
 * The `--flag=value` form is what shell wrappers, MCP client configs and the
 * plugin manifest all emit, because it survives argument arrays without the
 * pairing being split. Nothing exercised the split until now, so a launcher
 * passing `--profile=work` would have silently logged into `default`.
 */
test('runLogin parses the --flag=value form, splitting on the first = only', async () => {
  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();

  const code = await runLogin(
    [
      '--path=ig',
      '--app-id=55500',
      `--app-secret=${APP_SECRET}`,
      '--profile=work',
      // A query string in the value: only the FIRST `=` may split the token, or
      // the redirect URI arrives truncated at `?state`.
      '--redirect-uri=http://127.0.0.1:8123/cb?src=plugin&mode=auto',
      '--scopes= instagram_business_basic , ,instagram_business_content_publish ,',
    ],
    {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async () => 'auth-code',
    },
  );

  assert.equal(code, 0);
  assert.equal(seen[0]?.profile, 'work');
  assert.equal(seen[0]?.creds.appSecret, APP_SECRET);
  assert.equal(seen[0]?.creds.authPath, 'ig-login');

  const authorize = authorizeUrlFrom(out());
  assert.equal(
    authorize.searchParams.get('redirect_uri'),
    'http://127.0.0.1:8123/cb?src=plugin&mode=auto',
    'the value keeps every = after the first',
  );
  assert.equal(
    authorize.searchParams.get('scope'),
    'instagram_business_basic,instagram_business_content_publish',
    'scopes are trimmed and empty entries dropped, so a trailing comma is not a blank scope',
  );
});

test('the transcript names the auth path and the profile on whole lines', async () => {
  // `--path` and `--profile` are the two flags a launcher command line gets
  // wrong silently: the flow is green either way, and the only trace of the
  // mistake is the transcript. The "open this URL" line is where the operator
  // sees WHICH consent screen they are about to grant, and the "stored" line is
  // the receipt naming the profile the credential landed in. Pinned whole:
  // `/Stored long-lived ig-login token/` still matches a receipt with the
  // profile clause cut out.
  for (const [flag, path] of [
    ['ig', 'ig-login'],
    ['fb', 'fb-login'],
  ] as const) {
    const { fetchFn } = bothPathRoutes();
    const { persist } = fakePersist();
    const { deps, out } = stderrSink();

    const code = await runLogin(
      ['--path', flag, '--app-id=55500', `--app-secret=${APP_SECRET}`, '--profile=work'],
      {
        ...deps,
        env: {},
        fetchFn,
        persist,
        now: () => 0,
        captureCode: async () => 'auth-code',
      },
    );

    assert.equal(code, 0, out());
    const lines = out().split('\n');
    assert.ok(
      lines.includes(`Open this URL in a browser to authorize (${path}):`),
      `${path}: the authorize prompt names the path on its own line`,
    );
    assert.ok(
      lines.includes(`Stored long-lived ${path} token for profile 'work' at /tmp/fake/work.env.`),
      `${path}: the receipt names the path, the profile and the file`,
    );
  }
});

test('the long-lived swap is fed the SHORT token, not the authorization code', async () => {
  // The two exchanges sit on adjacent lines and both take a
  // credential-shaped string, so handing the upgrade the authorization code —
  // already spent by the line above it — is a one-identifier slip that
  // type-checks. Meta answers it with the same generic 400 an expired code
  // produces, so the operator reads "the code expired", re-runs the whole
  // browser round-trip, and gets the identical failure every time. The only
  // place the two are distinguishable is the request the swap actually sent.
  for (const path of ['ig', 'fb'] as const) {
    const { fetchFn, urls } = bothPathRoutes();
    const { persist, seen } = fakePersist();
    const { deps } = stderrSink();
    const code = await runLogin(['--path', path, '--app-id=55500', `--app-secret=${APP_SECRET}`], {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async () => 'auth-code',
    });

    assert.equal(code, 0, `${path}: the login did not complete`);
    assert.equal(urls.length, 2, `${path}: expected a code exchange and a swap`);
    const swap = new URL(urls[1]!).searchParams;
    const carried = swap.get('access_token') ?? swap.get('fb_exchange_token');
    assert.equal(carried, SHORT_TOKEN, `${path}: the swap must present the short-lived token`);
    assert.notEqual(carried, 'auth-code', `${path}: the spent code is not a token`);
    assert.equal(seen[0]?.creds.accessToken, LONG_TOKEN);
  }
});

test('the code exchange echoes the --redirect-uri, on both paths, not the default', async () => {
  // `exchangeCodeForToken` is already pinned to echo whatever URI it is handed;
  // this pins the WIRING that hands it one. Meta re-validates `redirect_uri` at
  // the exchange against the value from the authorize step, byte for byte, so a
  // runLogin that authorized with `--redirect-uri` but exchanged with the
  // built-in default would fail every custom-port login with a generic
  // "invalid request" — after the browser round-trip had visibly succeeded.
  const redirectUri = 'http://127.0.0.1:8123/oauth/callback';

  for (const path of ['ig', 'fb'] as const) {
    // Ordered so the code exchange never matches a long-lived route: the
    // fb_exchange_token URL also contains the versioned oauth/access_token path.
    const { fetchFn, calls } = routingFetch([
      { match: 'fb_exchange_token', body: { access_token: LONG_TOKEN, expires_in: 5184000 } },
      {
        match: `graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
        body: { access_token: SHORT_TOKEN, expires_in: 3600 },
      },
      {
        match: 'api.instagram.com/oauth/access_token',
        body: { access_token: SHORT_TOKEN, user_id: 178414 },
      },
      {
        match: 'graph.instagram.com/access_token',
        body: { access_token: LONG_TOKEN, expires_in: 5184000 },
      },
    ]);
    const { persist } = fakePersist();
    const { deps } = stderrSink();

    const code = await runLogin(
      [
        `--path=${path}`,
        '--app-id=55500',
        `--app-secret=${APP_SECRET}`,
        `--redirect-uri=${redirectUri}`,
      ],
      { ...deps, env: {}, fetchFn, persist, now: () => 0, captureCode: async () => 'auth-code' },
    );

    assert.equal(code, 0, `${path}-login did not complete`);
    const exchange = calls[0]!;
    // ig-login posts the pair in a form body; fb-login carries it in the query.
    const rawBody = exchange.init?.body;
    const sent =
      path === 'ig'
        ? new URLSearchParams(typeof rawBody === 'string' ? rawBody : '').get('redirect_uri')
        : new URL(exchange.url).searchParams.get('redirect_uri');
    assert.equal(sent, redirectUri, `${path}-login exchanged with the wrong redirect_uri`);
  }
});

test('the browser is opened, and the open is awaited, before the capture starts', async () => {
  // `openUrl` is injected by the caller and may be genuinely slow — spawning a
  // browser, or an operator-supplied hook that copies the URL somewhere first.
  // Dropping the await would not break the happy path, but it detaches that
  // promise: a rejection from it becomes an unhandled rejection instead of the
  // `login failed:` line, and the "waiting for the redirect" notice can print
  // before the browser was ever asked to open, which reads as a hung command.
  const { fetchFn } = igRoutes();
  const { persist } = fakePersist();
  const { deps } = stderrSink();
  const order: string[] = [];
  let releaseOpen = (): void => {};
  const opened = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });

  const run = runLogin(['--path=ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    now: () => 0,
    openUrl: async () => {
      order.push('open:start');
      await opened;
      order.push('open:end');
    },
    captureCode: async () => {
      order.push('capture');
      return 'auth-code';
    },
  });

  assert.equal(await isPending(run), true, 'the flow must not finish while the open is in flight');
  assert.deepEqual(order, ['open:start'], 'the capture ran before the browser was open');

  releaseOpen();
  assert.equal(await run, 0);
  assert.deepEqual(order, ['open:start', 'open:end', 'capture']);
});

test('a bare positional token names the auth path, and a positional after an explicit --path is refused', async () => {
  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps } = stderrSink();

  // `login ig` — the shorthand the parser's default case exists for.
  const code = await runLogin(['ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    now: () => 0,
    captureCode: async () => 'auth-code',
  });
  assert.equal(code, 0);
  assert.equal(seen[0]?.creds.authPath, 'ig-login');

  // With `--path` already given, a stray positional must not silently switch
  // paths: the two use different hosts and different credentials, so a switch
  // here would fail deep inside the exchange with a confusing Graph error.
  // Nor may it be silently DROPPED, which is what the parser did until
  // 2026-09-19 — the operator who typed two paths gets told which token was
  // one too many and why, and no exchange is attempted on either path.
  const help = await helpText();
  const { deps: deps2, out: out2, steps } = mustStopAtParsing();
  const code2 = await runLogin(
    ['--path', 'fb', 'ig', '--app-id=app', `--app-secret=${APP_SECRET}`],
    deps2,
  );
  assert.equal(code2, 2, 'a positional after --path is a usage error');
  assert.equal(out2(), `login: unknown argument 'ig' (the auth path is already given).\n\n${help}`);
  assert.deepEqual(steps, [], 'the refusal must happen before any exchange or persist');
});

test('a bare positional outranks the environment default, exactly as --path does', async () => {
  // `IG_AUTH_PATH` is how an MCP client's config hands the path over, and it
  // is a DEFAULT: the operator who then types `login ig` has named the path
  // once, explicitly. Counting the env value as "already given" would refuse
  // that line as a second path — an "unknown argument 'ig'" against a config
  // the operator may not even remember setting — while letting the env win
  // over the positional (the pre-2026-09-19 behaviour) ran Path B for an
  // operator who asked, on the command line, for Path A.
  const { fetchFn } = bothPathRoutes();
  const { persist, seen } = fakePersist();
  const { deps } = stderrSink();
  const code = await runLogin(['ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: { IG_AUTH_PATH: 'fb' },
    fetchFn,
    persist,
    now: () => 0,
    captureCode: async () => 'auth-code',
  });
  assert.equal(code, 0, 'a positional against an env default must complete');
  assert.equal(seen[0]?.creds.authPath, 'ig-login', 'the command line outranks the environment');
});

test('an unrecognised --path value leaves the path unset rather than guessing', async () => {
  // `--path instagram` is a plausible typo. Guessing `ig-login` from it would
  // send a Path-B operator through the Path-A endpoints; refusing is the safe
  // reading, and exit 2 (usage) tells them it was their argument, not the network.
  //
  // The values that merely BEGIN with an alias are the sharp ones: matched by
  // prefix, `iglogin`, `ig-log` and `fb-legacy` would each start a full browser
  // login on a path the operator never named — and the token that comes back is
  // written to their config before they see which path produced it.
  for (const value of ['instagram', 'ig-log', 'iglogin', 'ig login', 'fb-legacy', 'facebook']) {
    const { fetchFn } = bothPathRoutes();
    const { persist, seen } = fakePersist();
    const { deps, out } = stderrSink();
    const code = await runLogin(['--path', value, '--app-id=a', `--app-secret=${APP_SECRET}`], {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async () => 'auth-code',
    });
    assert.equal(code, 2, `--path ${value} was accepted as an alias`);
    assert.equal(seen.length, 0, `--path ${value} completed a login on a guessed path`);
    assert.match(out(), /--path/, 'the usage error must name the flag that was not understood');
  }
});

// --- runLogin: short flags, holes, and blank values --------------------------

test('the short flags -h and -p are honoured, not swallowed by the positional default', async () => {
  // Both are documented in HELP_TEXT. Falling through to the `default` case
  // would treat `-h` as an unknown token — help never printed, exit 2 for a
  // missing --path.
  const help = stderrSink();
  assert.equal(await runLogin(['-h'], help.deps), 0);
  assert.match(help.out(), /--redirect-uri/);
  // The parser accepting a short flag and the help advertising it are separate
  // facts, and the help is the only one an operator can discover. A short flag
  // that works but is undocumented is a flag nobody uses; one that is
  // documented but dropped from the parser is worse. Pin them together.
  assert.match(help.out(), /--help, -h/, 'the help documents the short spelling of --help');
  assert.match(help.out(), /--path, -p/, 'and the short spelling of the one required flag');

  // `-p ig` on its own is a sharp probe now that an unknown token is refused:
  // a `-p` that fell through to the default case would exit 2 as an unknown
  // argument, not adopt the orphaned `ig`. The second line pins the flag's
  // rank against the one positional the parser accepts: a positional that
  // comes FIRST is the shorthand for `--path`, and the flag after it is the
  // authoritative spelling, so `fb -p ig` runs Path A (the mirror image —
  // a positional AFTER the flag — is a refusal, pinned further down).
  for (const argv of [
    ['-p', 'ig'],
    ['fb', '-p', 'ig'],
  ]) {
    const { fetchFn } = igRoutes();
    const { persist, seen } = fakePersist();
    const { deps } = stderrSink();
    const code = await runLogin([...argv, '--app-id=55500', `--app-secret=${APP_SECRET}`], {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async () => 'auth-code',
    });
    assert.equal(code, 0, `argv ${argv.join(' ')} did not complete`);
    assert.equal(
      seen[0]?.creds.authPath,
      'ig-login',
      `argv ${argv.join(' ')} chose the wrong path`,
    );
  }
});

test('the inline =value form belongs to the long flags: -p=ig is refused as an unknown argument', async () => {
  // The `=` split is deliberately gated on the DOUBLE dash. A short flag with an
  // inline value is not a form this parser accepts, and the boundary matters in
  // both directions: widening the split to a single dash would make `-p=ig`
  // consume its own value and run Path A, while the whole token is unknown and
  // refused. Refused is the safe half of the choice — the command stops with a
  // usage error naming the token that was not understood, instead of guessing
  // a path and logging in against the wrong Meta product. Until 2026-09-19 the
  // token was dropped instead and the refusal blamed a missing `--path`, which
  // sent the operator looking for a flag they had typed. The whole token is
  // echoed, `=` included: a single-dash token is never split, so `-p=ig` is
  // the spelling that failed, not `-p` (which the help lists as valid).
  const help = await helpText();
  const { deps, out, steps } = mustStopAtParsing();
  const code = await runLogin(['-p=ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], deps);

  assert.equal(code, 2, '-p=ig must not be read as a path');
  assert.equal(out(), `login: unknown argument '-p=ig'.\n\n${help}`);
  assert.deepEqual(steps, []);
});

// --- runLogin: unknown arguments are refused --------------------------------

test('an unknown long flag is refused with exit 2, the token named whole, and nothing past the parser runs', async () => {
  // Until 2026-09-19 an unknown token was skipped in silence and the command
  // carried on with whatever the rest of the line said — the shape that let
  // `--scope` request the wrong scopes (CC-CFG-17). A usage error is the only
  // answer that cannot mint a token the operator did not ask for. The whole
  // stderr is pinned — the line, a blank line, the usage — because a fragment
  // match on `unknown` would survive the loss of the token, the help, or both.
  const help = await helpText();
  const { deps, out, steps } = mustStopAtParsing();
  const code = await runLogin(
    ['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`, '--bogus'],
    deps,
  );
  assert.equal(code, 2);
  assert.equal(out(), `login: unknown argument '--bogus'.\n\n${help}`);
  assert.deepEqual(steps, []);
});

test('an unknown short flag is refused the same way, wherever it sits on the line', async () => {
  // The refusal does not depend on the rest of the line: `-x` first, in the
  // middle, or last is the same answer, and the credentials around it are
  // never acted on (`steps` stays empty in every position).
  const help = await helpText();
  for (const argv of [
    ['-x', '--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`],
    ['--path', 'ig', '-x', '--app-id=55500', `--app-secret=${APP_SECRET}`],
    ['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`, '-x'],
  ]) {
    const { deps, out, steps } = mustStopAtParsing();
    const code = await runLogin(argv, deps);
    assert.equal(code, 2, `[${argv.join(' ')}] was not refused`);
    assert.equal(out(), `login: unknown argument '-x'.\n\n${help}`, `[${argv.join(' ')}]`);
    assert.deepEqual(steps, [], `[${argv.join(' ')}] ran past the parser`);
  }
});

test('an unknown positional is refused: a near miss of a path name, a stray word, a blank token', async () => {
  // The one bare word the parser accepts is an auth-path name. Everything else
  // is echoed verbatim and refused: `instagram` and the prefix-shaped near
  // misses (a plausible spelling of a path that is not one), the subcommand's
  // own name (what `process.argv.slice(2)` instead of `slice(3)` in the entry
  // would hand over), and a blank token (`login "$UNSET"`). The blank ones are
  // echoed as they are — an empty pair of quotes is the clearest report of an
  // empty token, and the usage text under it says what belongs there.
  const help = await helpText();
  for (const token of ['instagram', 'iglogin', 'ig-log', 'login', '', '   ']) {
    const { deps, out, steps } = mustStopAtParsing();
    const code = await runLogin([token, '--app-id=55500', `--app-secret=${APP_SECRET}`], deps);
    assert.equal(code, 2, `'${token}' was accepted`);
    assert.equal(out(), `login: unknown argument '${token}'.\n\n${help}`, `'${token}'`);
    assert.deepEqual(steps, [], `'${token}' ran past the parser`);
  }
});

test('a second positional path is refused whichever spelling gave the first: login ig fb stops', async () => {
  // Neither reading of `login ig fb` is safe — the two paths use different
  // hosts and different credentials — and "first wins, drop the rest" (the
  // rule until 2026-09-19) was the reading that hid the extra token. The word
  // itself is a known one, so the line says why it is refused instead of
  // calling `fb` unknown. A badly spelled `--path` still counts as "given":
  // the stray is reported, not silently promoted to the path the flag failed
  // to name.
  const help = await helpText();
  for (const [argv, stray] of [
    [['ig', 'fb'], 'fb'],
    [['ig', 'ig'], 'ig'],
    [['-p', 'ig', 'fb'], 'fb'],
    [['--path=ig', 'fb-login'], 'fb-login'],
    [['--path', 'instagram', 'ig'], 'ig'],
  ] as const) {
    const { deps, out, steps } = mustStopAtParsing();
    const line = [...argv, '--app-id=55500', `--app-secret=${APP_SECRET}`];
    assert.equal(await runLogin(line, deps), 2, `[${argv.join(' ')}] was not refused`);
    assert.equal(
      out(),
      `login: unknown argument '${stray}' (the auth path is already given).\n\n${help}`,
      `[${argv.join(' ')}]`,
    );
    assert.deepEqual(steps, [], `[${argv.join(' ')}] ran past the parser`);
  }

  // The control: the FLAG may repeat, and the last one wins, as before. It is
  // the positional after an explicit path that is the stray, not repetition.
  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps } = stderrSink();
  const code = await runLogin(
    ['--path', 'fb', '--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`],
    { ...deps, env: {}, fetchFn, persist, now: () => 0, captureCode: async () => 'auth-code' },
  );
  assert.equal(code, 0, 'a repeated --path must complete');
  assert.equal(seen[0]?.creds.authPath, 'ig-login', 'the last --path wins');
});

test('an unknown --flag=value echoes only the flag name, never the inline value', async () => {
  // The inline value of an unknown long flag is exactly what would have
  // followed `--app-secret`: `--app-secrett=<secret>` is the typo that carries
  // the secret. The refusal names the part the parser tried to match and stops
  // there. The near-miss hint keys on that same part, so `--scope=x` gets it.
  const help = await helpText();
  const secretCase = mustStopAtParsing();
  const code = await runLogin(
    ['--path', 'ig', '--app-id=55500', `--app-secrett=${APP_SECRET}`],
    secretCase.deps,
  );
  assert.equal(code, 2);
  assert.equal(secretCase.out(), `login: unknown argument '--app-secrett'.\n\n${help}`);
  assert.equal(secretCase.out().includes(APP_SECRET), false, 'the inline value is never echoed');
  assert.deepEqual(secretCase.steps, []);

  const hintCase = mustStopAtParsing();
  const code2 = await runLogin(
    ['--path', 'ig', '--scope=instagram_business_manage_messages'],
    hintCase.deps,
  );
  assert.equal(code2, 2);
  assert.equal(
    hintCase.out(),
    `login: unknown argument '--scope' (did you mean --scopes?).\n\n${help}`,
  );
  assert.deepEqual(hintCase.steps, []);
});

test('the near-miss hints are a fixed map, each keyed on a slip with a known origin', async () => {
  // `--scope` is one keystroke short of `--scopes` (CC-CFG-17); `--auth-path`
  // and `--auth-mode` are `IG_AUTH_PATH` / `IG_AUTH_MODE` without the prefix,
  // the spelling an operator who configured the path in the environment
  // reaches for. Not a fuzzy matcher: a slip off the map (`--scopez`,
  // `--paths`, a case variant) is refused with no hint, pinned as the control
  // so that adding a matcher — or a fourth entry — is a deliberate change to
  // this list.
  const help = await helpText();
  for (const [slip, meant] of [
    ['--scope', '--scopes'],
    ['--auth-path', '--path'],
    ['--auth-mode', '--path'],
  ] as const) {
    const { deps, out, steps } = mustStopAtParsing();
    assert.equal(await runLogin([slip, 'ig'], deps), 2, `${slip} was accepted`);
    assert.equal(out(), `login: unknown argument '${slip}' (did you mean ${meant}?).\n\n${help}`);
    assert.deepEqual(steps, []);
  }
  for (const slip of ['--scopez', '--paths', '--Scope', '--auth_path']) {
    const { deps, out, steps } = mustStopAtParsing();
    assert.equal(await runLogin([slip, 'ig'], deps), 2, `${slip} was accepted`);
    assert.equal(out(), `login: unknown argument '${slip}'.\n\n${help}`, `${slip} got a hint`);
    assert.deepEqual(steps, []);
  }
});

test('an unknown argument outranks --help on either side of it, and only the first one is named', async () => {
  // Deterministic, like `git --bogus --help`: the parser stops at the first
  // unknown token (so `--bogus --help` never sees the help flag) and `--help`
  // sets a bit without stopping the parser (so `--help --bogus` still reaches
  // the stray). A line the command cannot act on is named now rather than
  // after the operator has read the help and pasted the same line again.
  // `--help` alone still exits 0 — that is `helpText()` itself, asserted on
  // every call.
  const help = await helpText();
  for (const argv of [
    ['--help', '--bogus'],
    ['--bogus', '--help'],
    ['-h', '--bogus', '--also-bogus'],
    ['--bogus', '--also-bogus', '-h'],
  ]) {
    const { deps, out, steps } = mustStopAtParsing();
    assert.equal(await runLogin(argv, deps), 2, `[${argv.join(' ')}] did not refuse`);
    assert.equal(out(), `login: unknown argument '--bogus'.\n\n${help}`, `[${argv.join(' ')}]`);
    assert.deepEqual(steps, []);
  }
});

test('a value-taking flag consumes the next token whatever it looks like, so it is never the unknown one', async () => {
  // The rule from before the refusal, kept: `--account-id --bogus` hands
  // `--bogus` to the flag as its value. Refusing it instead would need a rule
  // for which values may start with a dash, and the parser stays a one-token
  // lookahead with a single deterministic answer — the token after a value
  // flag is its value, full stop. The mirror case is pinned above: a token
  // the parser did not consume as a value is the one it reports.
  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps } = stderrSink();
  const code = await runLogin(
    ['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`, '--account-id', '--bogus'],
    { ...deps, env: {}, fetchFn, persist, now: () => 0, captureCode: async () => 'auth-code' },
  );
  assert.equal(code, 0, 'a dash-led value is a value, not a refusal');
  assert.equal(seen[0]?.creds.accountId, '--bogus');
});

test('a hole in argv is skipped instead of being read as a flag', async () => {
  // `process.argv.slice(2)` is dense, but `runLogin` is exported and an embedder
  // building argv by index (or splicing one out) leaves holes. Reading a hole as
  // a token would send `undefined` into `arg.startsWith`, turning a caller's
  // sloppy array into a TypeError escaping the parser before the try block.
  const argv = ['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`];
  argv[6] = '--profile';
  argv[7] = 'SecondAccount';

  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps } = stderrSink();
  const code = await runLogin(argv, {
    ...deps,
    env: {},
    fetchFn,
    persist,
    now: () => 0,
    captureCode: async () => 'auth-code',
  });
  assert.equal(code, 0);
  assert.equal(seen[0]?.profile, 'secondaccount', 'the flags past the hole are still parsed');
});

test('a flag handed a blank value falls back rather than storing whitespace', async () => {
  // `--account-id ''` is what a shell expansion of an unset variable produces.
  // Storing the blank would write `IG_ACCOUNT_ID=` into the operator's env file
  // and shadow the id the exchange just returned, so every later call would look
  // up an account named "". Blank means "not given".
  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps } = stderrSink();
  const code = await runLogin(
    ['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`, '--account-id', '   '],
    { ...deps, env: {}, fetchFn, persist, now: () => 0, captureCode: async () => 'auth-code' },
  );
  assert.equal(code, 0);
  assert.equal(seen[0]?.creds.accountId, '178414', 'the id from the exchange is adopted');
});

test('blank --profile and --redirect-uri fall back to the defaults, not to a literal value', async () => {
  // Same shell expansion as above, on the two flags whose defaults actually
  // carry the login. A blank `--profile` that overwrites the default leaves the
  // token under a profile no reader looks up, so every tool call reports "no
  // credentials" while the file plainly contains a token. A blank
  // `--redirect-uri` is worse: the URI is what the browser is sent to AND what
  // the listener binds, so losing the loopback default breaks the round-trip
  // outright — and whatever the fallback yields is then sent to Meta as the
  // registered URI.
  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();
  let capturedRedirect: string | undefined;

  const code = await runLogin(
    [
      '--path',
      'ig',
      '--app-id=55500',
      `--app-secret=${APP_SECRET}`,
      '--profile',
      '  ',
      '--redirect-uri',
      '',
    ],
    {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async (p) => {
        capturedRedirect = p.redirectUri;
        return 'auth-code';
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(
    seen[0]?.profile,
    'default',
    'a blank --profile leaves the default profile in place',
  );
  assert.equal(capturedRedirect, DEFAULT_REDIRECT_URI);
  assert.equal(
    authorizeUrlFrom(out()).searchParams.get('redirect_uri'),
    DEFAULT_REDIRECT_URI,
    'a blank --redirect-uri leaves the loopback default in the authorize URL',
  );
});

// --- Token metadata edge cases ----------------------------------------------

test('a string user_id passes through verbatim; a blank one reads as absent', async () => {
  // Graph documents `user_id` as a number, but the body is untyped JSON and IDs
  // in this family are 17 digits — past 2^53, where a number literal is already
  // lossy. Re-stringifying a number is safe only while it is a safe integer (the
  // unsafe case is refused — CC-AUTH-60); a string that arrives as a string
  // must not be routed through `Number()`, and `""` is not an account id.
  //
  // The id below is deliberately ODD: doubles are spaced 2 apart in this range,
  // so an even 17-digit id survives `String(Number(x))` unchanged and would let
  // a coercing implementation pass this test. An odd one cannot.
  const asString = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: '17841400008765431' },
    },
  ]);
  const params = {
    code: 'abc',
    appId: '55500',
    appSecret: APP_SECRET,
    redirectUri: DEFAULT_REDIRECT_URI,
  };
  assert.equal(
    (await exchangeCodeForToken('ig-login', params, asString.fetchFn)).userId,
    '17841400008765431',
  );

  const blank = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: '' },
    },
  ]);
  assert.equal((await exchangeCodeForToken('ig-login', params, blank.fetchFn)).userId, undefined);
});

test('a long-lived exchange with no usable expires_in stores no expiry and says so', async () => {
  // Graph omits `expires_in` for a token that never expires and has been seen
  // returning it as a string. A canonical digit string is read (the test below);
  // any other spelling — a fraction, a sign — is not guessed at. Coercing one
  // into a number would date-stamp the credential file with a value nobody
  // sent, and `token_status` would then report it as fact.
  for (const expiresIn of [undefined, '5184000.0', '-5184000']) {
    const { fetchFn } = routingFetch([
      {
        match: 'api.instagram.com/oauth/access_token',
        body: { access_token: SHORT_TOKEN, user_id: 178414 },
      },
      {
        match: 'graph.instagram.com/access_token',
        body: { access_token: LONG_TOKEN, expires_in: expiresIn },
      },
    ]);
    const { persist, seen } = fakePersist();
    const { deps, out } = stderrSink();
    const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async () => 'auth-code',
    });
    assert.equal(code, 0, `expires_in ${String(expiresIn)}`);
    assert.equal(seen[0]?.creds.expiresAtSec, undefined);
    // The full line, not just its `unknown` stem. There are two ways to reach an
    // unknown expiry here and they call for different remedies: the upstream
    // returned no lifetime (this one — nothing is wrong, the token simply has no
    // recorded expiry), or it returned a number that names no instant (the test
    // below — something IS wrong with what was just written to disk). A stem-only
    // match reads both as a pass, so deleting the `expiresAtSec === undefined`
    // branch would go unnoticed while every operator was told their absent
    // lifetime "resolves to undefined".
    assert.match(out(), /Token expiry: unknown \(no lifetime returned\)\.\n/);
    assert.doesNotMatch(out(), /resolves to/);
  }
});

test('a long-lived exchange with a quoted canonical expires_in records the expiry (CC-AUTH-69)', async () => {
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: '5184000' },
    },
  ]);
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    now: () => 1_760_000_000_000,
    captureCode: async () => 'auth-code',
  });
  assert.equal(code, 0);
  assert.equal(seen[0]?.creds.expiresAtSec, 1_760_000_000 + 5_184_000);
  assert.match(out(), /Token expires at 2025-12-08T08:53:20\.000Z\.\n/);
});

test('a pre-1970 clock stores no expiry and says so, never "never"', async () => {
  // `computeExpiresAtSec` is `floor(now / 1000 + expires_in)`, and `now` is the
  // host clock. A machine whose clock has not been set — a container with no RTC
  // reads back 1970 or earlier — makes that sum NEGATIVE for a perfectly ordinary
  // sixty-day lifetime. The store's reader drops a signed record, so writing it
  // bought nothing but a record that reads as unknown; it is now not written,
  // and the notice says why (CC-AUTH-65). What must never happen is widening
  // the `=== 0` sentinel to `<= 0`: "Token expiry: never" is the one answer that
  // silences every later expiry warning the operator would otherwise get.
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: 5184000 },
    },
  ]);
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();

  const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    now: () => -2_000_000_000_000,
    captureCode: async () => 'auth-code',
  });

  assert.equal(code, 0);
  assert.equal(seen[0]?.creds.expiresAtSec, undefined);
  assert.equal(
    out().includes(
      'Token expiry: unknown (upstream returned an expires_in of 5184000, which resolves ' +
        'to no recordable timestamp; no expiry was stored).',
    ),
    true,
    out(),
  );
  assert.doesNotMatch(out(), /Token expiry: never/);
});

test('a finite but absurd expires_in still reports SUCCESS, stores no expiry, and names the value', async () => {
  // The gap `numOrUndef` cannot close: it drops `Infinity`/`NaN`, but `1e300` is
  // finite, so `now + 1e300` is a perfectly ordinary number that names no instant
  // a `Date` can hold. `new Date(1e303).toISOString()` throws a bare `RangeError:
  // Invalid time value`, and it threw from INSIDE `runLogin`'s try/catch —
  // AFTER the credential had been persisted. The operator saw
  // `login failed: Invalid time value` and exit 1 for a login that had fully
  // succeeded, and went back through a browser authorization they did not need
  // (the previous flow's authorization code is single-use, so the retry starts
  // from scratch). Exit 0 is therefore the assertion that matters most here.
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: 1e300 },
    },
  ]);
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();

  const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    now: () => 0,
    captureCode: async () => 'auth-code',
  });

  assert.equal(code, 0, out());
  assert.equal(seen.length, 1, 'the credential is still persisted');
  // ...but WITHOUT the absurd expiry: `1e+300:<fp>` is a record the store's own
  // reader rejects, so the next start would refuse the profile (CC-AUTH-61).
  assert.equal(seen[0]?.creds.expiresAtSec, undefined, 'no unreadable expiry is stored');
  const printed = out();
  assert.match(printed, /Stored long-lived ig-login token/);
  assert.equal(
    printed.includes(
      'Token expiry: unknown (upstream returned an expires_in of 1e+300, which resolves ' +
        'to no recordable timestamp; no expiry was stored).',
    ),
    true,
    printed,
  );
  // Never a bare `Invalid Date`, never `~NaN day(s)`, and never a failure notice
  // for a login that worked.
  assert.doesNotMatch(printed, /login failed|Invalid Date|Invalid time value|NaN/);
  assert.ok(!printed.includes(LONG_TOKEN), 'the long-lived token is never printed');
});

test('a negative expires_in is stored as the past instant it names, never as "never"', async () => {
  // Refresh reads a negative lifetime as already expired; login used to store it
  // as `0`, the "never expires" sentinel, so `token_status`/`doctor` called a
  // token the upstream had just declared dead immortal (CC-AUTH-61).
  const { fetchFn } = routingFetch([
    {
      match: 'api.instagram.com/oauth/access_token',
      body: { access_token: SHORT_TOKEN, user_id: 178414 },
    },
    {
      match: 'graph.instagram.com/access_token',
      body: { access_token: LONG_TOKEN, expires_in: -60 },
    },
  ]);
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    now: () => 1_700_000_000_000,
    captureCode: async () => 'auth-code',
  });
  assert.equal(code, 0, out());
  assert.equal(seen[0]?.creds.expiresAtSec, 1_700_000_000 - 60);
  assert.match(out(), /Token expires at 2023-11-14T22:12:20\.000Z\.\n/);
  assert.doesNotMatch(out(), /Token expiry: never/);
});

// --- runLogin: the production defaults ---------------------------------------

test('the generated OAuth state is 128 bits of fresh randomness on every login', async () => {
  // `makeState` is deliberately NOT injected here: the production generator is
  // the subject. State is the only thing that binds the code arriving on the
  // loopback listener to the authorize request this process actually made. A
  // fixed string, or a value short enough to enumerate, hands any page open in
  // the operator's browser during the login a working forgery — it replays the
  // known state with an authorization code minted for the ATTACKER's account,
  // and the CLI stores that token as the operator's own. 32 hex characters is
  // the `randomBytes(16)` contract; one byte would leave 256 candidates, which
  // a page can walk through in hidden requests faster than a human consents.
  const states: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { fetchFn } = igRoutes();
    const { persist } = fakePersist();
    const { deps } = stderrSink();
    const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async (p) => {
        states.push(p.state);
        return 'auth-code';
      },
    });
    assert.equal(code, 0);
  }

  assert.match(states[0]!, /^[0-9a-f]{32}$/, 'the state is 16 random bytes in hex');
  assert.match(states[1]!, /^[0-9a-f]{32}$/);
  assert.notEqual(
    states[0],
    states[1],
    'a state reused across logins is a state an attacker knows',
  );
});

test('each auth path asks for its own default scopes, exactly', async () => {
  // The consent screen is shown once and the token is minted with exactly the
  // scopes named on it. A scope missing from the default set cannot be added
  // afterwards — it takes another full browser login, and for a Business app
  // another App Review — while the failure shows up much later as a single tool
  // (comments, insights) returning a permission error against a token that
  // otherwise works. Over-asking is the mirror failure: `pages_manage_posts`
  // grants writing to the Page feed and drags the whole app into a review it
  // does not need, while `pages_show_list` — the scope that actually lets the
  // login find the Instagram account behind the Page — goes missing.
  //
  // The lists below are pinned whole rather than by fragments, because the
  // failure being guarded is a set that is one member too long or too short:
  // an `includes` check for each expected scope passes on both. The messaging
  // scope each path supports is deliberately not in either list — see the
  // absence guard below and the docstring on `DEFAULT_SCOPES`.
  const expected: Record<string, string[]> = {
    ig: [
      'instagram_business_basic',
      'instagram_business_content_publish',
      'instagram_business_manage_comments',
      'instagram_business_manage_insights',
    ],
    fb: [
      'instagram_basic',
      'instagram_content_publish',
      'instagram_manage_comments',
      'instagram_manage_insights',
      'pages_show_list',
      'pages_read_engagement',
      'business_management',
    ],
  };

  for (const [path, scopes] of Object.entries(expected)) {
    const { fetchFn } = bothPathRoutes();
    const { persist } = fakePersist();
    const { deps, out } = stderrSink();
    const code = await runLogin(['--path', path, '--app-id=55500', `--app-secret=${APP_SECRET}`], {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async () => 'auth-code',
    });
    assert.equal(code, 0, `--path ${path} did not complete`);
    assert.deepEqual(
      authorizeUrlFrom(out()).searchParams.get('scope')?.split(','),
      scopes,
      `--path ${path} requested the wrong scope set`,
    );
  }
});

test('a blank --scopes value keeps the per-path defaults instead of requesting no scope', async () => {
  // `--scopes=` (or a value that is only whitespace) is the shape a shell
  // produces from an unset variable: `--scopes=$EXTRA_SCOPES`. Read literally
  // it would be a request for ZERO scopes — an authorize URL with `scope=` —
  // and Meta answers that with a consent screen that grants nothing usable.
  // The blank is treated as "not given", exactly like the other value flags.
  const creds = ['--app-id=55500', `--app-secret=${APP_SECRET}`];
  for (const argv of [
    ['--path', 'ig', ...creds, '--scopes='],
    ['--path', 'ig', ...creds, '--scopes', '   '],
    // An inline blank is a value, not a missing one: it must not swallow the
    // next token, or `--path` would vanish into the scope list.
    ['--scopes=', '--path', 'ig', ...creds],
    // A list with separators but no names is the same absence: `--scopes=,`
    // is `--scopes=$A,$B` with both unset.
    ['--path', 'ig', ...creds, '--scopes=,'],
    ['--path', 'ig', ...creds, '--scopes', ' , ,'],
  ]) {
    const { fetchFn } = igRoutes();
    const { persist } = fakePersist();
    const { deps, out } = stderrSink();
    const code = await runLogin(argv, {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async () => 'auth-code',
    });
    assert.equal(code, 0, `${argv.join(' ')} did not complete`);
    assert.deepEqual(
      authorizeUrlFrom(out()).searchParams.get('scope')?.split(','),
      [
        'instagram_business_basic',
        'instagram_business_content_publish',
        'instagram_business_manage_comments',
        'instagram_business_manage_insights',
      ],
      `${argv.join(' ')} must fall back to the ig defaults`,
    );
  }
});

test('the singular --scope is not an alias: it is refused, naming --scopes, before any scope is requested', async () => {
  // The flag is `--scopes`. A one-letter slip is the likeliest way to type it
  // wrong, and until 2026-09-19 the parser ignored unknown flags rather than
  // failing on them, so the DEFAULTS went out: the operator sat through the
  // consent screen and came back with a token missing the one permission they
  // had typed (CC-CFG-17). Now the slip is a usage error with the spelling
  // they meant in the line, and no authorize URL is built — so the day an
  // alias is added it is added on purpose, with its own help line, and this
  // pin is what has to change.
  const help = await helpText();
  const { deps, out, steps } = mustStopAtParsing();
  const code = await runLogin(
    [
      '--path',
      'ig',
      '--app-id=55500',
      `--app-secret=${APP_SECRET}`,
      '--scope',
      'instagram_business_manage_messages',
    ],
    deps,
  );
  assert.equal(code, 2);
  assert.equal(out(), `login: unknown argument '--scope' (did you mean --scopes?).\n\n${help}`);
  assert.deepEqual(steps, [], 'no authorize URL, exchange or persist may follow the slip');
  assert.doesNotMatch(out(), /https:\/\//, 'the transcript carries no authorize URL');
});

test('no default scope asks for DM access, but `--scopes` still can', async () => {
  // Guarding the pinned lists above only in the positive direction would let a
  // messaging scope creep back in the day someone extends either array: the
  // deepEqual would be updated to match, and the review question — "does any
  // tool use this?" — would never be asked. This states the rule instead of the
  // list. It is paired with the permissive control, because an over-eager filter
  // that stripped `/messages/` from every request would satisfy the absence
  // assertion perfectly while silently breaking the one supported way to ask for
  // the scope: a suppression with no control is indistinguishable from a ban.
  for (const path of ['ig', 'fb']) {
    const { fetchFn } = bothPathRoutes();
    const { persist } = fakePersist();
    const { deps, out } = stderrSink();
    const code = await runLogin(['--path', path, '--app-id=55500', `--app-secret=${APP_SECRET}`], {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      captureCode: async () => 'auth-code',
    });
    assert.equal(code, 0, `--path ${path} did not complete`);
    const requested = authorizeUrlFrom(out()).searchParams.get('scope')?.split(',') ?? [];
    assert.deepEqual(
      requested.filter((scope) => scope.includes('messages')),
      [],
      `--path ${path} asks the operator to grant DM access that no tool can use`,
    );
  }

  // The control: the scope is not blocked, only unrequested by default.
  const { fetchFn } = bothPathRoutes();
  const { persist } = fakePersist();
  const { deps, out } = stderrSink();
  const code = await runLogin(
    [
      '--path',
      'ig',
      '--app-id=55500',
      `--app-secret=${APP_SECRET}`,
      '--scopes=instagram_business_basic,instagram_business_manage_messages',
    ],
    { ...deps, env: {}, fetchFn, persist, now: () => 0, captureCode: async () => 'auth-code' },
  );
  assert.equal(code, 0, '--scopes with a messaging scope did not complete');
  assert.deepEqual(
    authorizeUrlFrom(out()).searchParams.get('scope')?.split(','),
    ['instagram_business_basic', 'instagram_business_manage_messages'],
    'an explicitly requested messaging scope must still reach the consent screen verbatim',
  );
});

test('with no stderr injected the transcript goes to stderr, never to stdout', async () => {
  // `deps.stderr` exists for tests; production passes nothing. The default has
  // to be stderr because this command ships inside an MCP server whose stdout is
  // the JSON-RPC frame channel — a single help or progress line written there is
  // read by the client as a malformed frame and takes the session down. It is
  // also why `login` can be piped: stdout stays empty and machine-usable.
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  };

  let code: number;
  try {
    code = await runLogin(['--help'], { env: {} });
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
  }

  assert.equal(code, 0);
  assert.match(stderrChunks.join(''), /--redirect-uri/, 'the help text is written to stderr');
  assert.ok(
    !stdoutChunks.join('').includes('--redirect-uri'),
    'nothing from this command may reach the protocol channel',
  );
});

test('a non-Error thrown inside the flow still yields a readable failure line', async () => {
  // The catch is typed `unknown` and `captureCode` is an injection point an
  // embedder fills. `String(err)` is what keeps `login failed: [object Object]`
  // from becoming `login failed: undefined` — a message with no cause at all.
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
    ...deps,
    env: {},
    captureCode: () => {
      throw 'the browser helper exploded' as unknown as Error;
    },
  });
  assert.equal(code, 1);
  assert.match(out(), /login failed: the browser helper exploded/);
});

test('with no fetch injected the exchanges go through the global fetch', async () => {
  // `deps.fetchFn` exists for tests; production passes nothing and the default
  // must resolve to the platform `fetch`. Binding it at module load instead
  // would silently ignore an `undici` agent an embedder installs later.
  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps } = stderrSink();
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    const code = await runLogin(['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`], {
      ...deps,
      env: {},
      persist,
      now: () => 0,
      captureCode: async () => 'auth-code',
    });
    assert.equal(code, 0);
    assert.equal(seen[0]?.creds.accessToken, LONG_TOKEN);
  } finally {
    globalThis.fetch = original;
  }
});

test('captureAuthorizationCode binds the default port when the redirect URI names none', async () => {
  // `http://127.0.0.1/callback` is a legal redirect URI and Meta accepts it, but
  // `url.port` is then `''`. `Number('')` is 0, which `listen` reads as "any free
  // port" — the listener would come up somewhere the browser never redirects to
  // and the login would sit there until the five-minute timeout.
  const server = fakeCallbackServer();
  const clock = fakeClock(0);
  const pending = captureAuthorizationCode(
    { redirectUri: 'http://127.0.0.1/callback', state: 's' },
    { createServerImpl: server.create, clock, timeoutMs: 1000 },
  );
  assert.deepEqual(server.listens[0], {
    port: Number(new URL(DEFAULT_REDIRECT_URI).port),
    host: '127.0.0.1',
  });
  server.send('/callback?code=abc&state=s');
  assert.equal(await pending, 'abc');
});

/** An ephemeral loopback port that is free right now (bound, then released). */
async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address !== null && typeof address === 'object', 'the probe bound no address');
  const { port } = address;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** GET `url`, retrying until the listener under test has actually bound. */
async function deliverRedirect(url: string): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(url);
      await res.text();
      return res.status;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`the OAuth listener never accepted a redirect at ${url}: ${String(lastError)}`);
}

test('with no capture injected, login binds a real listener and takes the browser redirect', async () => {
  // Every other flow here injects `captureCode`, so the production path — the
  // `node:http` factory, the system clock, the waiting notice — is exercised by
  // nothing. That path is the whole point of the command: it is what turns the
  // browser's redirect into a stored token, and it can only be proven over a
  // real socket. Ports are ephemeral and the redirect retries until the
  // listener is up, so no fixed port is claimed and no sleep is guessed at.
  const port = await freeLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { fetchFn } = igRoutes();
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();

  let delivered: Promise<number> | undefined;
  const code = await runLogin(
    ['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`, '--redirect-uri', redirectUri],
    {
      ...deps,
      env: {},
      fetchFn,
      persist,
      now: () => 0,
      // The browser stand-in. It must not await the redirect: the listener is
      // bound only after `openUrl` returns, so the GET is started here and
      // joined once the login has settled.
      openUrl: (url) => {
        const state = new URL(url).searchParams.get('state') ?? '';
        delivered = deliverRedirect(`${redirectUri}?code=live-code&state=${state}`);
        return Promise.resolve();
      },
    },
  );

  assert.equal(await delivered, 200, 'the listener answered the redirect');
  assert.equal(code, 0);
  assert.equal(seen[0]?.creds.accessToken, LONG_TOKEN);
  assert.match(out(), /Waiting up to 5 minutes/, 'the wait is announced only for a real listener');
  assert.match(out(), new RegExp(redirectUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // The whole notice, not its fragments: the second sentence is the one an
  // operator staring at a browser that "never comes back" needs, and it names
  // the exact dashboard field. A rewrite that kept "Waiting up to 5 minutes"
  // and the URI but lost that sentence would pass both matches above.
  assert.ok(
    out()
      .split('\n')
      .includes(
        `Waiting up to 5 minutes for the redirect to ${redirectUri}. That EXACT URI must be ` +
          "listed under the Meta app's Valid OAuth Redirect URIs, or the browser never comes back here.",
      ),
    `the waiting notice is one exact line: ${out()}`,
  );
});

test('the loopback listener answers as plain text, so the browser renders the sentence', async () => {
  // The reply to the redirect is rendered by the operator's BROWSER, and the
  // content type decides what happens to it. Left unset, browsers sniff — and a
  // short unmarked body can be offered as a download instead of shown, leaving
  // the operator with a save dialog and no confirmation that the code landed.
  // Marked `text/html` it becomes markup, which is a live concern rather than a
  // theoretical one: the page that issued the redirect controls the query
  // string, so the moment any of this body quotes a query value it would be
  // injecting into a document served from the operator's own loopback origin.
  // Only a real socket can show the header, so this test uses one.
  const port = await freeLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const pending = captureAuthorizationCode(
    { redirectUri, state: 'st' },
    { clock: fakeClock(0), timeoutMs: 300_000 },
  );

  let res: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 100 && res === undefined; attempt++) {
    try {
      res = await fetch(`${redirectUri}?code=live-code&state=st`);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(res, `the OAuth listener never accepted a redirect: ${String(lastError)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain');
  assert.match(await res.text(), /close this window/i);
  assert.equal(await pending, 'live-code');
});

// --- operator-facing help text ----------------------------------------------
// `HELP_TEXT` is the only instruction an operator gets before a live login, and
// a live login cannot be rehearsed: it needs a registered Meta app, and the
// error Meta returns for a redirect URI that was not registered verbatim says
// nothing about which of the two spellings it expected. Coverage cannot see any
// of this — the string is printed, the process exits 0, and every line runs the
// same whether the sentence is there or not (CC-PROC-74). The tests above pin
// three clauses (`registered meta app`, `chmod 0600`, the default URI itself);
// what follows pins the rest of what the operator has to act on.

/** Assert a printed operator-facing text still carries an exact clause. */
function assertHelpStates(help: string, fragment: string): void {
  assert.ok(help.includes(fragment), `missing from the help text: ${fragment}`);
}

test('the help lists every flag with the environment variable or default behind it', async () => {
  const help = await helpText();
  // `--path` is the one required flag and the one with no env fallback, so its
  // line has to name both choices: an operator who picks the wrong path gets a
  // token that works until the first call that needs the other path's scopes.
  assertHelpStates(
    help,
    '--path, -p <ig|fb>     Auth path: ig (Instagram Login) or fb (Facebook Login). Required.',
  );
  // The env spellings are the difference between passing a secret on a command
  // line — where it lands in shell history and in `ps` — and exporting it.
  assertHelpStates(help, '--app-id <id>          Meta app id       (or env IG_APP_ID).');
  assertHelpStates(help, '--app-secret <secret>  Meta app secret   (or env IG_APP_SECRET).');
  // Each default states what happens when the flag is OMITTED, which is the
  // case the operator is actually in while reading this.
  assertHelpStates(help, '--profile <name>       Account profile to write (default: "default").');
  assertHelpStates(
    help,
    '--scopes <csv>         Comma-separated scope override (default: per path).',
  );
  assertHelpStates(help, '--account-id <id>      IG professional-account id (optional).');
  assertHelpStates(help, '--help, -h             Show this help.');
});

test('the help states both accepted argument forms and the fate of anything else', async () => {
  const help = await helpText();
  // Both forms are real and neither is guessable from the other: `--path=ig`
  // works, and so does the bare `login ig`. Unstated, an operator who tried the
  // wrong one first reads exit 2 as "this command is broken".
  assertHelpStates(
    help,
    'The long flags also take the --flag=value form, and the path may be given as',
  );
  assertHelpStates(help, 'a bare word (login ig).');
  // And the parser's actual policy: nothing is ignored. A stray token is a
  // refusal with a code a script can branch on, not a silently dropped word.
  assertHelpStates(help, 'Any other argument is refused with exit code 2.');
});

test('the help spells out the redirect-URI rule Meta enforces literally', async () => {
  const help = await helpText();
  // The prerequisite, in capitals because it is the one thing that cannot be
  // worked around locally.
  assertHelpStates(help, 'A live login requires a REGISTERED META APP');
  // What "registered" has to mean, concretely. The capitalised prerequisite
  // above names the requirement without saying what satisfies it, and this
  // clause is the only place the help does: the two secrets the operator has
  // already been told to pass, plus a redirect URI that exists in the app's own
  // settings. Dropped, an operator holding an app id and secret has every
  // reason to read the prerequisite as already met, and learns otherwise only
  // from Meta's error, which does not say which half was missing. Pinned in two
  // halves that both stop SHORT of the line wrap, leaving the `and a redirect`
  // between them unpinned on purpose: `assertHelpStates` is a plain `includes`,
  // so a fragment ending on the last word before the break is broken by a
  // re-wrap that changes no word at all. Measured 2026-09-23: dropping the
  // clause fails this test, and re-wrapping it one word earlier no longer does.
  assertHelpStates(help, 'REGISTERED META APP: the app id/secret above');
  assertHelpStates(help, "URI whitelisted in the app's OAuth settings.");
  // The sentence that prevents the single most common failed login: Meta does
  // not resolve the URI, it compares the string, so the two spellings of the
  // loopback address are two different entries and only one of them is bound.
  assertHelpStates(help, 'Meta matches redirect URIs');
  assertHelpStates(help, 'literally, so the value above must be registered VERBATIM under');
  assertHelpStates(help, '"Valid OAuth Redirect URIs"');
  assertHelpStates(help, '"127.0.0.1" and "localhost" are different entries');
  assertHelpStates(help, 'only the loopback address is bound here');
  // Said plainly so nobody goes looking for an offline mode that does not exist.
  // The clause is pinned in the two halves the line wrap splits it into, rather
  // than as one sentence a reflow would break without changing a word of it.
  assertHelpStates(help, 'Without those it cannot run');
  assertHelpStates(help, 'is no offline login.');
});

test('the help says where the token lands and that it is never echoed', async () => {
  const help = await helpText();
  // Where to look for it, and where to look when the machine is a different OS
  // than the one the operator is used to. `chmod 0600` is pinned above; this is
  // the half that says which file carries that mode.
  assertHelpStates(help, 'The token is written to the XDG/APPDATA env file');
  // And the reason the command prints nothing useful on success: that is the
  // design, not a failure to report the token.
  assertHelpStates(help, 'is never printed');
});

test('the help lines that nothing else holds are pinned whole, character for character', async () => {
  const help = await helpText();
  const lines = help.split('\n');

  // Four lines the assertions above reach only by a fragment, or not at all.
  // Each is pinned as a WHOLE line — `includes` on a fragment cannot tell a
  // line that still carries its qualifier from one that has lost it, and this
  // text is printed by a command whose success path prints nothing else.
  for (const [why, line] of [
    // The first line is the whole description of what the command does, and
    // "persist" is the load-bearing word in it: an operator who reads only
    // "obtain a token" has no reason to expect a file to appear, and reads the
    // silent success as the command having done nothing.
    ['the summary line', 'instagram-mcp-ai login — obtain and persist a long-lived token.'],
    // The synopsis is the only place the required flag and the optional
    // remainder are shown in the shape they must be typed in. The option list
    // below it names `--path` again, but a list of flags is not an invocation:
    // without this line nothing says `login` is a subcommand, or that `--path`
    // comes before the options rather than after them.
    ['the usage synopsis', '  instagram-mcp-ai login --path <ig|fb> [options]'],
    // The one option line whose default is a value rather than a behaviour, and
    // the value is the string Meta will compare literally against the app's
    // registration. It is the only place in the help where the default URI
    // appears in full, so a line that keeps the flag and drops the default —
    // the natural casualty of a re-indent, since it is also the longest line —
    // leaves the VERBATIM paragraph three lines below pointing at "the value
    // above" with no value above it.
    [
      'the redirect-URI option line',
      `  --redirect-uri <uri>   OAuth redirect URI (default: ${DEFAULT_REDIRECT_URI}).`,
    ],
    // `chmod 0600` is matched elsewhere by a regex that a line reading only
    // "chmod 0600 is not applied" would also satisfy. Both halves of this line
    // are promises about a file holding a sixty-day credential: the mode it is
    // created with, and that the token never reaches the terminal — which is
    // what makes a scrollback, a CI log or a screen share safe after a login.
    ['the file-mode line', '(chmod 0600 on POSIX) and is never printed.'],
  ] as const) {
    assert.ok(lines.includes(line), `${why} is printed exactly: ${JSON.stringify(line)}`);
  }
});
test('the option list is one indented block under its own heading, in the order it is printed', async () => {
  const help = await helpText();
  const lines = help.split('\n');

  // The heading is pinned as a whole line because it SCOPES everything under
  // it. "Options:" above a line ending "Required." reads as a list with one
  // mandatory entry; a heading that called the block optional -- the natural
  // edit for someone tidying a flag list -- contradicts the only flag `login`
  // cannot start without, and the operator who believes it gets exit 2 with no
  // idea which of the eight flags they were supposed to pass.
  const heading = lines.indexOf('Options:');
  assert.notEqual(heading, -1, 'the option list is introduced by a heading of its own');

  // The block whole, in order, WITH its indentation. The fragment assertions
  // above match a line that has drifted out of the list exactly as well as one
  // still in it, and an unindented option line reads as prose ABOUT a flag
  // rather than as the flag's entry in the list.
  //
  // The redirect-URI default is restated here as a literal rather than
  // interpolated from `DEFAULT_REDIRECT_URI`: this line is the one place the
  // operator is told which URI to register verbatim in the Meta app, and an
  // expectation built from the same constant the help prints would agree with
  // whatever value that constant took -- including one no Meta app has.
  assert.deepEqual(lines.slice(heading + 1, heading + 9), [
    '  --path, -p <ig|fb>     Auth path: ig (Instagram Login) or fb (Facebook Login). Required.',
    '  --profile <name>       Account profile to write (default: "default").',
    '  --app-id <id>          Meta app id       (or env IG_APP_ID).',
    '  --app-secret <secret>  Meta app secret   (or env IG_APP_SECRET).',
    '  --redirect-uri <uri>   OAuth redirect URI (default: http://127.0.0.1:8723/callback).',
    '  --account-id <id>      IG professional-account id (optional).',
    '  --scopes <csv>         Comma-separated scope override (default: per path).',
    '  --help, -h             Show this help.',
  ]);
  assert.equal(lines[heading + 9], '', 'the list ends where the prose below it begins');
});

// --- a detached value is never echoed by a refusal --------------------------

test('a refusal never echoes a token that follows a value-taking flag', async () => {
  // `--app-id --app-secret <secret>` (a forgotten app id) hands `--app-secret`
  // to `--app-id` as its value, and `--app-secret= <secret>` gives the flag an
  // empty inline value; either way the secret is the next, unclaimed token.
  // The refusal names the flag it belonged to and never prints the token.
  const lines = [
    ['--path', 'ig', '--app-id', '--app-secret', APP_SECRET],
    ['--path', 'ig', '--app-id=55500', '--app-secret=', APP_SECRET],
  ];
  const help = await helpText();
  for (const argv of lines) {
    const { deps, out, steps } = mustStopAtParsing();
    const code = await runLogin(argv, deps);
    assert.equal(code, 2, argv.join(' '));
    assert.ok(!out().includes(APP_SECRET), `the secret was echoed: ${out()}`);
    assert.equal(
      out(),
      "login: unexpected argument after '--app-secret' (not shown — it may be the value " +
        'meant for that flag; pass it as --app-secret=<value>).\n\n' +
        help,
    );
    assert.deepEqual(steps, []);
  }
});

test('no value-taking spelling lets the token after it be echoed, and the advice names a form the parser takes', async () => {
  // Every spelling that takes a value, swallowed bare by the flag before it and,
  // for a long spelling, given an empty inline value. `-p` has no inline form
  // (`-p=ig` is refused), so its advice spells it `--path`.
  const spellings = [
    '-p',
    '--path',
    '--profile',
    '--app-id',
    '--app-secret',
    '--redirect-uri',
    '--account-id',
    '--scopes',
  ];
  for (const spelling of spellings) {
    const swallower = spelling === '--account-id' ? '--app-id' : '--account-id';
    const shapes = [[swallower, spelling, APP_SECRET]];
    if (spelling.startsWith('--')) shapes.push([`${spelling}=`, APP_SECRET]);
    const advice = spelling === '-p' ? '--path' : spelling;
    for (const argv of shapes) {
      const { deps, out, steps } = mustStopAtParsing();
      const code = await runLogin(['--path', 'ig', ...argv], deps);
      assert.equal(code, 2, argv.join(' '));
      assert.ok(!out().includes(APP_SECRET), `the secret was echoed: ${out()}`);
      assert.ok(
        out().startsWith(
          `login: unexpected argument after '${spelling}' (not shown — it may be the value ` +
            `meant for that flag; pass it as ${advice}=<value>).\n`,
        ),
        out(),
      );
      assert.deepEqual(steps, []);
    }
  }
});

test('an unknown word that does not follow a value-taking flag is still echoed whole', async () => {
  const { deps, out, steps } = mustStopAtParsing();
  const code = await runLogin(['--path', 'ig', '--scopes', 'a,b', 'igg'], deps);
  assert.equal(code, 2);
  assert.ok(out().startsWith("login: unknown argument 'igg'.\n"), out());
  assert.deepEqual(steps, []);
});

// --- profile names the credentials file can be read back under --------------

test('a profile name the env file cannot hold is refused before any network call', async () => {
  for (const name of ['my shop', 'shop=2', 'café', 'a#b']) {
    const { deps, out, steps } = mustStopAtParsing();
    const code = await runLogin(
      ['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`, '--profile', name],
      deps,
    );
    assert.equal(code, 2, name);
    assert.equal(
      out(),
      "login: --profile takes only letters, digits, '_', '.' and '-' — a profile stored " +
        'under any other name could never be loaded back from the credentials file.\n',
    );
    assert.deepEqual(steps, [], name);
  }
});

test('a profile name of accepted characters is stored and loads back under that name', async () => {
  const configHome = await makeTempConfigHome('igmcp-login-profile-');
  const { fetchFn } = igRoutes();
  const { deps } = stderrSink();
  const code = await runLogin(
    ['--path', 'ig', '--app-id=55500', `--app-secret=${APP_SECRET}`, '--profile', 'Shop.Two-3_x'],
    { ...deps, env: configHomeEnv(configHome), fetchFn, captureCode: async () => 'auth-code' },
  );
  assert.equal(code, 0);
  const env = dotenv.parse(await readFile(envFileIn(configHome), 'utf8'));
  // The default profile is required by the loader; a placeholder stands in.
  const names = loadProfiles({ ...env, IG_ACCESS_TOKEN: 'fake-default-token' }).profiles.map(
    (p) => p.name,
  );
  assert.ok(names.includes('shop.two-3_x'), names.join(','));
});

// --- the denied reason and the exchange message are untrusted (CC-DATA-96/CC-DATA-100)

test('a denied reason with a newline or an ANSI escape is escaped, not printed raw (CC-DATA-100)', () => {
  // Anything able to reach the loopback port writes this query string, and the
  // reason lands on the operator's terminal after `Authorization was denied:`.
  const denied = classifyCallbackRequest({
    expectedPath: '/callback',
    state: 'st',
    requestUrl:
      '/callback?error=access_denied&error_description=no%0AOK%20%20Logged%20in%1B%5B2J%E2%80%AE&state=st',
  });
  assert.equal(
    denied.kind === 'denied' ? denied.reason : 'unset',
    'no\\u{a}OK  Logged in\\u{1b}[2J\\u{202e}',
  );
});

test('a denied reason past the Graph message cap is cut with its length stated (CC-DATA-100)', () => {
  const words = 'word+'.repeat(400); // `+` decodes to a space: 2000 code points
  const denied = classifyCallbackRequest({
    expectedPath: '/callback',
    state: 'st',
    requestUrl: `/callback?error=access_denied&error_description=${words}&state=st`,
  });
  assert.equal(
    denied.kind === 'denied' ? denied.reason : 'unset',
    `${'word '.repeat(200)}… (2000 characters in all)`,
  );
});

test('an invisible error_description falls back to the error code (CC-DATA-100)', () => {
  const denied = classifyCallbackRequest({
    expectedPath: '/callback',
    state: 'st',
    requestUrl: '/callback?error=access_denied&error_description=%E2%80%8B%20&state=st',
  });
  assert.equal(denied.kind === 'denied' ? denied.reason : 'unset', 'access_denied');
});

test('an exchange error whose message is only invisible characters falls back to the status line (CC-DATA-96)', async () => {
  await assert.rejects(
    () =>
      exchangeCodeForToken(
        'ig-login',
        IG_CODE_PARAMS,
        rawFetch(400, JSON.stringify({ error: { message: '​‎ ' } }), 'application/json'),
      ),
    (err: unknown) => {
      assert.ok(isInstagramError(err));
      assert.equal(err.message, 'OAuth token exchange failed (HTTP 400).');
      return true;
    },
  );
});

// --- Exchange transport: redirects and the timeout (CC-AUTH-72, CC-AUTH-73)

/** Run all four token exchanges through one fake fetch and return the inits. */
async function runAllFourExchanges(fetchFn: typeof fetch): Promise<void> {
  const code = { code: 'abc', appId: '55500', appSecret: APP_SECRET };
  await exchangeCodeForToken('ig-login', { ...code, redirectUri: DEFAULT_REDIRECT_URI }, fetchFn);
  await exchangeCodeForToken('fb-login', { ...code, redirectUri: DEFAULT_REDIRECT_URI }, fetchFn);
  const long = { shortToken: SHORT_TOKEN, appId: '55500', appSecret: APP_SECRET };
  await exchangeForLongLivedToken('ig-login', long, fetchFn);
  await exchangeForLongLivedToken('fb-login', long, fetchFn);
}

test('every login token exchange refuses redirects and carries a timeout signal (CC-AUTH-72, CC-AUTH-73)', async () => {
  // A 3xx from a token endpoint has no legitimate meaning. Followed, a 307/308
  // on the ig-login POST replays the form body (client_secret and the one-time
  // code) to whatever host `Location` names, and a GET redirect carries the
  // secret in the query. `refresh` already refuses redirects for the same
  // reason. The signal is the only bound on an endpoint that accepts the
  // connection and never answers: without it `login` hangs forever after the
  // browser step, with the code already spent.
  const { fetchFn, calls } = routingFetch([
    { match: 'oauth/access_token', body: { access_token: SHORT_TOKEN } },
    { match: 'graph.instagram.com/access_token', body: { access_token: LONG_TOKEN } },
  ]);
  await runAllFourExchanges(fetchFn);

  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.init?.redirect, 'error', `${call.url} must refuse redirects`);
    assert.ok(call.init?.signal instanceof AbortSignal, `${call.url} must carry a signal`);
    assert.equal(call.init.signal.aborted, false, 'the default budget is not already spent');
  }
});

test('the default login exchange timeout is 30 s, the same budget refresh uses (CC-AUTH-72)', async () => {
  // The signal exposes nothing about its deadline, so the argument handed to
  // `AbortSignal.timeout` is captured directly.
  const holder = AbortSignal as unknown as { timeout: (ms: number) => AbortSignal };
  const realTimeout = holder.timeout.bind(AbortSignal);
  const seen: number[] = [];
  holder.timeout = (ms: number): AbortSignal => {
    seen.push(ms);
    return realTimeout(ms);
  };
  try {
    const { fetchFn } = routingFetch([
      { match: 'oauth/access_token', body: { access_token: SHORT_TOKEN } },
      { match: 'graph.instagram.com/access_token', body: { access_token: LONG_TOKEN } },
    ]);
    await runAllFourExchanges(fetchFn);
  } finally {
    holder.timeout = realTimeout;
  }
  assert.deepEqual(seen, [30_000, 30_000, 30_000, 30_000]);
});

test('a login exchange that never answers fails on its timeout instead of hanging (CC-AUTH-72)', async () => {
  // A fetch that accepts the request and answers only when its signal fires,
  // which is what undici does against a socket that never responds.
  const hanging = ((_input: string | URL | Request, init?: FetchInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) return; // no signal: hang forever
      signal.addEventListener('abort', () => {
        reject(signal.reason as Error);
      });
    })) as typeof fetch;

  const code = { code: 'abc', appId: '55500', appSecret: APP_SECRET };
  const long = { shortToken: SHORT_TOKEN, appId: '55500', appSecret: APP_SECRET };
  const attempts: Array<() => Promise<unknown>> = [
    () =>
      exchangeCodeForToken('ig-login', { ...code, redirectUri: DEFAULT_REDIRECT_URI }, hanging, 5),
    () =>
      exchangeCodeForToken('fb-login', { ...code, redirectUri: DEFAULT_REDIRECT_URI }, hanging, 5),
    () => exchangeForLongLivedToken('ig-login', long, hanging, 5),
    () => exchangeForLongLivedToken('fb-login', long, hanging, 5),
  ];
  for (const attempt of attempts) {
    let timer: NodeJS.Timeout | undefined;
    const watchdog = new Promise<'hung'>((resolve) => {
      timer = setTimeout(() => resolve('hung'), 2_000);
    });
    const outcome = await Promise.race([
      attempt().then(
        () => 'resolved',
        (err: unknown) => err,
      ),
      watchdog,
    ]);
    clearTimeout(timer);
    assert.notEqual(outcome, 'hung', 'the exchange must not outlive its budget');
    // Typed since CC-AUTH-74: the raw `TimeoutError` rides on `cause`.
    assert.ok(isInstagramError(outcome), 'a timed-out exchange rejects with an InstagramError');
    assert.equal(outcome.kind, 'upstream');
    assert.equal((outcome.cause as Error).name, 'TimeoutError');
  }
});

// --- Typed transport failures, blank tokens, encoded secrets (audit wave 18) --

/** The four exchanges as thunks, each driven through `fetchFn`. */
function fourExchanges(
  fetchFn: typeof fetch,
  timeoutMs?: number,
): Array<[string, () => Promise<unknown>]> {
  const code = { code: 'abc', appId: '55500', appSecret: APP_SECRET };
  const long = { shortToken: SHORT_TOKEN, appId: '55500', appSecret: APP_SECRET };
  const redirectUri = DEFAULT_REDIRECT_URI;
  return [
    [
      'ig code',
      () => exchangeCodeForToken('ig-login', { ...code, redirectUri }, fetchFn, timeoutMs),
    ],
    [
      'fb code',
      () => exchangeCodeForToken('fb-login', { ...code, redirectUri }, fetchFn, timeoutMs),
    ],
    ['ig long', () => exchangeForLongLivedToken('ig-login', long, fetchFn, timeoutMs)],
    ['fb long', () => exchangeForLongLivedToken('fb-login', long, fetchFn, timeoutMs)],
  ];
}

test('a login exchange timeout rejects with a typed upstream InstagramError, cause kept (CC-AUTH-74)', async () => {
  // The fetch resolves at once; the body never finishes and errors only when the
  // signal fires, so the TimeoutError comes out of the BODY read.
  const stalledBody = ((_input: string | URL | Request, init?: FetchInit): Promise<Response> => {
    const signal = init?.signal as AbortSignal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  }) as typeof fetch;
  for (const [name, attempt] of fourExchanges(stalledBody, 5)) {
    await assert.rejects(attempt(), (err: unknown) => {
      assert.ok(isInstagramError(err), `${name}: typed, not a raw DOMException`);
      assert.equal(err.kind, 'upstream');
      assert.equal(err.message, 'The operation was aborted due to timeout');
      assert.equal((err.cause as Error).name, 'TimeoutError');
      return true;
    });
  }
});

test('a login transport failure or a refused redirect is typed as upstream (CC-AUTH-74)', async () => {
  const cause = new TypeError('fetch failed');
  const failing = (async () => {
    throw cause;
  }) as typeof fetch;
  for (const [name, attempt] of fourExchanges(failing)) {
    await assert.rejects(attempt(), (err: unknown) => {
      assert.ok(isInstagramError(err), `${name}: typed`);
      assert.equal(err.kind, 'upstream');
      assert.equal(err.message, 'fetch failed');
      assert.equal(err.cause, cause);
      return true;
    });
  }
});

test('a mapped exchange refusal passes the transport wrapper unchanged (CC-AUTH-74)', async () => {
  const { fetchFn } = routingFetch([
    { match: 'oauth/access_token', status: 401, body: { error: { message: 'bad secret' } } },
    { match: 'graph.instagram.com/access_token', status: 401, body: { error: { message: 'x' } } },
  ]);
  for (const [name, attempt] of fourExchanges(fetchFn)) {
    await assert.rejects(attempt(), (err: unknown) => {
      assert.ok(isInstagramError(err), name);
      assert.equal(err.kind, 'auth', `${name}: not re-kinded as upstream`);
      assert.equal(err.status, 401);
      return true;
    });
  }
});

test('runLogin prints a timed-out exchange as one login failed line and exits 1 (CC-AUTH-74)', async () => {
  const failing = (async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  }) as typeof fetch;
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'fb', '--app-id', 'a', '--app-secret', APP_SECRET], {
    ...deps,
    env: {},
    fetchFn: failing,
    persist,
    captureCode: async () => 'auth-code-0123',
  });
  assert.equal(code, 1);
  assert.equal(seen.length, 0);
  assert.match(out(), /^login failed: The operation was aborted due to timeout$/m);
});

test('a whitespace-only access_token is refused by every exchange (CC-AUTH-75)', async () => {
  for (const blank of [' ', '   ', '\t\n', '\u00a0']) {
    const { fetchFn } = routingFetch([
      { match: 'oauth/access_token', body: { access_token: blank } },
      { match: 'graph.instagram.com/access_token', body: { access_token: blank } },
    ]);
    for (const [name, attempt] of fourExchanges(fetchFn)) {
      await assert.rejects(attempt(), (err: unknown) => {
        assert.ok(isInstagramError(err), `${name} ${JSON.stringify(blank)}`);
        assert.equal(err.kind, 'auth');
        assert.equal(err.message, 'Token exchange response did not include an access_token.');
        return true;
      });
    }
  }
});

test('a padded access_token that has a value is kept verbatim, not trimmed (CC-AUTH-75)', async () => {
  const padded = ` ${SHORT_TOKEN} `;
  const { fetchFn } = routingFetch([
    { match: 'oauth/access_token', body: { access_token: padded } },
    { match: 'graph.instagram.com/access_token', body: { access_token: padded } },
  ]);
  for (const [name, attempt] of fourExchanges(fetchFn)) {
    const got = (await attempt()) as { accessToken: string };
    assert.equal(got.accessToken, padded, name);
  }
});

test('runLogin stops at a blank short-lived token: the secret is not sent on (CC-AUTH-75)', async () => {
  const { fetchFn, urls } = routingFetch([
    { match: 'api.instagram.com/oauth/access_token', body: { access_token: '   ', user_id: 1 } },
    { match: 'graph.instagram.com/access_token', body: { access_token: LONG_TOKEN } },
  ]);
  const { persist, seen } = fakePersist();
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig', '--app-id', 'a', '--app-secret', APP_SECRET], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    captureCode: async () => 'auth-code-0123',
  });
  assert.equal(code, 1);
  assert.equal(urls.length, 1, 'no long-lived exchange carrying the app secret');
  assert.equal(seen.length, 0);
  assert.match(out(), /^login failed: Token exchange response did not include an access_token\.$/m);
});

/** The form-encoded spelling `URLSearchParams` gives a value. */
function formEncoded(value: string): string {
  return new URLSearchParams([['v', value]]).toString().slice(2);
}

// Values outside the URL-safe alphabet, so the encoded spelling differs.
const ODD_SECRET = 'app+secret/value=0123456789 abc';
const ODD_CODE = 'code+with/slash=0123456789';
const ODD_SHORT = 'short+tok/en=0123456789 xyz';
const ODD_LONG = 'long+tok/en=0123456789 xyzw';

test('runLogin masks the app secret and the code in their form-encoded spelling (CC-AUTH-76)', async () => {
  // A transport (a proxy agent, a stubbed fetch, a future runtime) that names the
  // request quotes the POST body exactly as it went out: form-encoded.
  for (const variant of ['body', 'url'] as const) {
    const naming = (async (input: string | URL | Request, init?: FetchInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      throw new Error(
        `proxy refused ${variant === 'url' ? url : typeof init?.body === 'string' ? init.body : ''}`,
      );
    }) as typeof fetch;
    const { persist } = fakePersist();
    const { deps, out } = stderrSink();
    const path = variant === 'body' ? 'ig' : 'fb';
    const code = await runLogin(['--path', path, '--app-id', 'a', '--app-secret', ODD_SECRET], {
      ...deps,
      env: {},
      fetchFn: naming,
      persist,
      captureCode: async () => ODD_CODE,
    });
    assert.equal(code, 1);
    const line = out()
      .split('\n')
      .find((l) => l.startsWith('login failed:'));
    assert.ok(line !== undefined);
    assert.ok(line.includes('proxy refused'), line);
    for (const v of [ODD_SECRET, ODD_CODE]) {
      assert.notEqual(formEncoded(v), v, 'the fixture must encode differently');
      assert.ok(!line.includes(formEncoded(v)), `${variant}: encoded ${v} leaked: ${line}`);
      assert.ok(!line.includes(v), `${variant}: raw ${v} leaked`);
    }
    assert.match(line, /client_secret=\[REDACTED\]/);
    assert.match(line, /code=\[REDACTED\]/);
  }
});

test('runLogin masks the short-lived token in its form-encoded spelling (CC-AUTH-76)', async () => {
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.instagram.com/')) {
      return new Response(JSON.stringify({ access_token: ODD_SHORT, user_id: 1 }), { status: 200 });
    }
    throw new Error(`proxy refused ${url}`);
  }) as typeof fetch;
  const { persist } = fakePersist();
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig', '--app-id', 'a', '--app-secret', APP_SECRET], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    captureCode: async () => 'auth-code-0123',
  });
  assert.equal(code, 1);
  assert.ok(out().includes('proxy refused https://graph.instagram.com/'), out());
  assert.ok(!out().includes(formEncoded(ODD_SHORT)), out());
  assert.match(out(), /access_token=\[REDACTED\]/);
});

test('runLogin masks the long-lived token in its form-encoded spelling (CC-AUTH-76)', async () => {
  const { fetchFn } = routingFetch([
    { match: 'api.instagram.com/oauth/access_token', body: { access_token: SHORT_TOKEN } },
    { match: 'graph.instagram.com/access_token', body: { access_token: ODD_LONG } },
  ]);
  const persist = async (_p: string, creds: Credentials): Promise<WriteCredentialsResult> => {
    throw new Error(`store refused ${new URLSearchParams({ t: creds.accessToken }).toString()}`);
  };
  const { deps, out } = stderrSink();
  const code = await runLogin(['--path', 'ig', '--app-id', 'a', '--app-secret', APP_SECRET], {
    ...deps,
    env: {},
    fetchFn,
    persist,
    captureCode: async () => 'auth-code-0123',
  });
  assert.equal(code, 1);
  assert.match(out(), /^login failed: store refused t=\[REDACTED\]$/m);
});
