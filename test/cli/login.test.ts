/**
 * Unit tests for the `login` CLI command (src/cli/login.ts).
 *
 * HONESTY: a live browser login cannot run here — it needs a registered Meta app
 * (app id/secret + a whitelisted redirect URI). These tests therefore exercise
 * the reusable, deterministic CORE and never a real browser: the pure helpers
 * (`buildAuthorizeUrl`, both token exchanges, `computeExpiresAtSec`) against an
 * injected `fetch`, and `runLogin` with the browser step (`captureCode`) and the
 * clock injected out. The loopback capture is intentionally NOT covered — it is
 * thin best-effort glue. The `fb_exchange_token` / `ig_exchange_token` step is
 * what a real login would perform after the redirect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

import {
  buildAuthorizeUrl,
  computeExpiresAtSec,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  runLogin,
  type LoginDeps,
} from '../../src/cli/login.js';
import { loadProfiles } from '../../src/core/config.js';
import { isInstagramError } from '../../src/core/types.js';
import type { Credentials, WriteCredentialsResult } from '../../src/core/config-write.js';

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
  const configHome = await mkdtemp(path.join(tmpdir(), 'igmcp-login-'));
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
  const { deps } = stderrSink();

  // No `persist` injected -> the default writeCredentials runs, resolving the
  // config home from env.XDG_CONFIG_HOME (POSIX). The token is written, chmod'd,
  // and must parse back through loadProfiles.
  const code = await runLogin(['--path', 'ig', '--app-id', '55500', '--app-secret', APP_SECRET], {
    ...deps,
    env: { XDG_CONFIG_HOME: configHome },
    fetchFn,
    captureCode: async () => 'auth-code',
  });

  assert.equal(code, 0);
  const filePath = path.join(configHome, 'instagram-mcp-ai', '.env');
  const env = dotenv.parse(await readFile(filePath, 'utf8'));
  const { profiles } = loadProfiles(env);
  assert.equal(profiles[0]?.accessToken, LONG_TOKEN);
  assert.equal(profiles[0]?.authPath, 'ig-login');
});
