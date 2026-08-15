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
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
  type CallbackRequest,
  type CallbackResponse,
  type CreateCallbackServer,
  type LoginDeps,
} from '../../src/cli/login.js';
import { loadProfiles } from '../../src/core/config.js';
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
  assert.equal(out.accessToken, SHORT_TOKEN);
  assert.equal(out.userId, '178414');
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
  assert.equal(out.accessToken, SHORT_TOKEN);
  assert.equal(out.expiresInSec, 3600);
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
  assert.equal(out.accessToken, LONG_TOKEN);
  assert.equal(out.expiresInSec, 5184000);
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
  assert.equal(out.accessToken, LONG_TOKEN);
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
    (err: unknown) => isInstagramError(err) && /HTTP 500/.test(err.message),
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
    (err: unknown) =>
      isInstagramError(err) && err.kind === 'auth' && /access_token/.test(err.message),
  );
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

test('computeExpiresAtSec: undefined stays undefined; <=0 is 0; else now+lifetime', () => {
  assert.equal(computeExpiresAtSec(undefined, 1_000_000), undefined);
  assert.equal(computeExpiresAtSec(0, 1_000_000), 0);
  assert.equal(computeExpiresAtSec(-5, 1_000_000), 0);
  // 2_000_000 ms => 2000 s epoch; + 3600 s lifetime.
  assert.equal(computeExpiresAtSec(3600, 2_000_000), 2000 + 3600);
  // Fractional lifetime is floored.
  assert.equal(computeExpiresAtSec(3600.9, 2_000_000), 2000 + 3600);
  // So is the clock. Rounding a mid-second `now` up stamps the credential one
  // second LATER than the token really dies, which is the one direction that
  // matters: a refresh scheduled off that expiry runs after the token is gone.
  assert.equal(computeExpiresAtSec(3600, 1_999_600), 1999 + 3600);
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
  denied.send('/callback?error=access_denied&error_description=User+said+no');
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

test('a listen failure surfaces as a validation error naming the address', async () => {
  const server = fakeCallbackServer();
  const pending = captureAuthorizationCode(
    { redirectUri: 'http://127.0.0.1:8723/callback', state: 's' },
    { createServerImpl: server.create, clock: fakeClock(0) },
  );
  const failure = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
  server.fail(failure);

  await assert.rejects(
    pending,
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      err.message.includes('127.0.0.1:8723') &&
      /EADDRINUSE/.test(err.message) &&
      // The wrapped message keeps only `err.message`; the errno, the syscall and
      // the family live on the original object. Without it on `cause`, an
      // EACCES on a privileged port and an EADDRINUSE from a second login are
      // indistinguishable in a structured log.
      err.cause === failure,
  );
});

test('classifyCallbackRequest routes by path, error, code and state', () => {
  const base = { expectedPath: '/callback', state: 'st' };
  assert.equal(classifyCallbackRequest({ ...base, requestUrl: undefined }).kind, 'ignore');
  assert.equal(classifyCallbackRequest({ ...base, requestUrl: '/other?code=c' }).kind, 'ignore');
  assert.equal(classifyCallbackRequest({ ...base, requestUrl: '/callback' }).kind, 'ignore');
  assert.equal(
    classifyCallbackRequest({ ...base, requestUrl: '/callback?error=denied' }).kind,
    'denied',
  );
  assert.equal(
    classifyCallbackRequest({ ...base, requestUrl: '/callback?code=c&state=nope' }).kind,
    'state-mismatch',
  );
  const ok = classifyCallbackRequest({ ...base, requestUrl: '/callback?code=c&state=st' });
  assert.equal(ok.kind, 'code');
  assert.equal(ok.kind === 'code' ? ok.code : undefined, 'c');

  // A denial arrives with `error` alone when the user simply closes the consent
  // screen; only the OAuth error CODE is available then, and it is what tells
  // the operator whether they cancelled, the app is in dev mode, or a scope was
  // withheld. Falling back to an empty string prints "Authorization was denied:"
  // with the diagnosis missing.
  const bare = classifyCallbackRequest({ ...base, requestUrl: '/callback?error=access_denied' });
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
  assert.equal(creds.accessToken, LONG_TOKEN, 'the LONG-lived token is persisted');
  assert.equal(creds.authPath, 'fb-login');
  assert.equal(creds.appId, 'app');
  assert.equal(creds.appSecret, APP_SECRET);
  assert.equal(creds.expiresAtSec, 2000 + 5184000);

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
    (err: unknown) =>
      isInstagramError(err) && err.kind === 'auth' && /access_token/.test(err.message),
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
      assert.match(
        err.message,
        /HTTP 502/,
        'the status carries the diagnosis when the body cannot',
      );
      assert.ok(
        !err.message.includes('helpdesk@corp.example'),
        'the upstream page must not be echoed into the error message',
      );
      return true;
    },
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
function bothPathRoutes(): { fetchFn: typeof fetch } {
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

test('a bare positional token names the auth path, but never overrides an explicit --path', async () => {
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
  const { fetchFn: fbFetch } = routingFetch([
    { match: 'fb_exchange_token', body: { access_token: LONG_TOKEN, expires_in: 5184000 } },
    {
      match: `graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
      body: { access_token: SHORT_TOKEN, expires_in: 3600 },
    },
  ]);
  const { persist: persist2, seen: seen2 } = fakePersist();
  const code2 = await runLogin(
    ['--path', 'fb', 'ig', '--app-id=app', `--app-secret=${APP_SECRET}`],
    {
      ...deps,
      env: {},
      fetchFn: fbFetch,
      persist: persist2,
      now: () => 0,
      captureCode: async () => 'auth-code',
    },
  );
  assert.equal(code2, 0);
  assert.equal(seen2[0]?.creds.authPath, 'fb-login', 'the explicit --path wins over a positional');
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

  // `-p` needs a sharper probe: on a plain `-p ig` the positional rule would
  // adopt the orphaned `ig` and produce the right path anyway, so a broken `-p`
  // would look healthy. Pairing it with a *different* bare positional separates
  // them — the flag is authoritative whichever side of it the positional sits
  // on, and a `-p` that no longer parses leaves `fb-login` behind instead.
  for (const argv of [
    ['fb', '-p', 'ig'],
    ['-p', 'ig', 'fb'],
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
  // lossy. Re-stringifying a number is safe; a string that arrives as a string
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
  // returning it as a string. Coercing either into a number would date-stamp the
  // credential file with `expiresAtSec = NaN` (or 1970), and `token_status`
  // would then report a healthy token as long expired.
  for (const expiresIn of [undefined, '5184000']) {
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
    assert.match(out(), /Token expiry: unknown/);
  }
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
  const expected: Record<string, string[]> = {
    ig: [
      'instagram_business_basic',
      'instagram_business_content_publish',
      'instagram_business_manage_comments',
      'instagram_business_manage_messages',
      'instagram_business_manage_insights',
    ],
    fb: [
      'instagram_basic',
      'instagram_content_publish',
      'instagram_manage_comments',
      'instagram_manage_insights',
      'instagram_manage_messages',
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
});
