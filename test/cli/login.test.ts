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

/** A `fetch` stub that routes by URL substring and records every request URL. */
function routingFetch(routes: Array<{ match: string; body: unknown; status?: number }>): {
  fetchFn: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) throw new Error(`unexpected fetch to ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchFn, urls };
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

// --- computeExpiresAtSec ----------------------------------------------------

test('computeExpiresAtSec: undefined stays undefined; <=0 is 0; else now+lifetime', () => {
  assert.equal(computeExpiresAtSec(undefined, 1_000_000), undefined);
  assert.equal(computeExpiresAtSec(0, 1_000_000), 0);
  assert.equal(computeExpiresAtSec(-5, 1_000_000), 0);
  // 2_000_000 ms => 2000 s epoch; + 3600 s lifetime.
  assert.equal(computeExpiresAtSec(3600, 2_000_000), 2000 + 3600);
  // Fractional lifetime is floored.
  assert.equal(computeExpiresAtSec(3600.9, 2_000_000), 2000 + 3600);
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
  const pending = captureAuthorizationCode(
    { redirectUri: 'http://127.0.0.1:8723/callback', state: 's' },
    { createServerImpl: server.create, clock, timeoutMs: 300_000 },
  );

  clock.advance(299_999);
  assert.equal(await isPending(pending), true, 'the capture waits out its full budget');
  assert.equal(server.closes(), 0);

  clock.advance(1);
  await assert.rejects(
    pending,
    (err: unknown) =>
      isInstagramError(err) &&
      /timed out/i.test(err.message) &&
      err.message.includes('http://127.0.0.1:8723/callback') &&
      /Valid OAuth Redirect URIs/i.test(err.message),
  );
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
  server.fail(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));

  await assert.rejects(
    pending,
    (err: unknown) =>
      isInstagramError(err) &&
      err.kind === 'validation' &&
      err.message.includes('127.0.0.1:8723') &&
      /EADDRINUSE/.test(err.message),
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
  const { deps } = stderrSink();

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
  assert.ok(/login failed/i.test(out()));
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
