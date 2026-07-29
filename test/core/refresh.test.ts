/**
 * Unit tests for the token-refresh core (Layer 1). Each `refreshToken` call is
 * driven with a fake {@link TokenExchangeFn} that records the outgoing request
 * and returns a canned token-exchange payload; the default transport is driven
 * with an injected `fetch`. No network. A fixed `nowMs` is injected everywhere
 * so the computed `expiresAtSec` is deterministic (CC-AUTH-13).
 *
 * The auth-injection tests below are the regression guard for the defect where
 * the exchange rode the `IgRequestFn` Graph seam: that seam merges the active
 * profile's `access_token` (and, on `graph.facebook.com`, an `appsecret_proof`)
 * into every call, which is wrong for endpoints that authenticate themselves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { InstagramError } from '../../src/core/types.js';
import {
  createTokenExchange,
  needsRefresh,
  refreshToken,
  type TokenExchangeFn,
  type TokenExchangeRequest,
} from '../../src/core/refresh.js';
import { summarizeTokenExpiry } from '../../src/api/account.js';

/** Build a fake exchange transport that records calls and returns `payload`. */
function fakeExchange(payload: unknown): {
  exchange: TokenExchangeFn;
  calls: TokenExchangeRequest[];
} {
  const calls: TokenExchangeRequest[] = [];
  const exchange: TokenExchangeFn = async <T>(req: TokenExchangeRequest): Promise<T> => {
    calls.push(req);
    return payload as T;
  };
  return { exchange, calls };
}

/** Collect an injected-fetch call log and reply with `body`. */
function fakeFetch(body: unknown, init: { status?: number; text?: string } = {}) {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const payload = init.text ?? JSON.stringify(body);
    return new Response(payload, {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, urls };
}

const DAY = 86_400_000;
// Fixed, arbitrary clock. Chosen a whole number of seconds for clean expiry math.
const NOW_MS = 1_700_000_000_000;

test('refreshToken ig-login refreshes on graph.instagram.com and computes expiresAtSec', async () => {
  const { exchange, calls } = fakeExchange({
    access_token: 'IGnew',
    token_type: 'bearer',
    expires_in: 60 * 24 * 3600, // 60 days
  });

  const res = await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
    exchange,
  });

  const call = calls[0]!;
  assert.equal(calls.length, 1);
  assert.equal(call.host, 'graph.instagram.com');
  assert.equal(call.path, '/refresh_access_token');
  assert.deepEqual(call.params, {
    grant_type: 'ig_refresh_token',
    access_token: 'IGold',
  });

  assert.equal(res.accessToken, 'IGnew');
  assert.equal(res.expiresAtSec, Math.floor(NOW_MS / 1000) + 60 * 24 * 3600);
});

test('refreshToken fb-login exchanges on graph.facebook.com with client_id/secret', async () => {
  const { exchange, calls } = fakeExchange({
    access_token: 'FBnew',
    token_type: 'bearer',
    expires_in: 5_184_000, // 60 days in seconds
  });

  const res = await refreshToken({
    authPath: 'fb-login',
    accessToken: 'FBold',
    appId: '55500',
    appSecret: 's3cr3t',
    nowMs: NOW_MS,
    exchange,
  });

  const call = calls[0]!;
  assert.equal(call.host, 'graph.facebook.com');
  assert.equal(call.path, '/oauth/access_token');
  assert.deepEqual(call.params, {
    grant_type: 'fb_exchange_token',
    client_id: '55500',
    client_secret: 's3cr3t',
    fb_exchange_token: 'FBold',
  });

  assert.equal(res.accessToken, 'FBnew');
  assert.equal(res.expiresAtSec, Math.floor(NOW_MS / 1000) + 5_184_000);
});

test('refreshToken omits expiresAtSec when the response has no expires_in', async () => {
  const { exchange } = fakeExchange({ access_token: 'FBnever' });

  const res = await refreshToken({
    authPath: 'fb-login',
    accessToken: 'FBold',
    appId: '55500',
    appSecret: 's3cr3t',
    nowMs: NOW_MS,
    exchange,
  });

  assert.equal(res.accessToken, 'FBnever');
  assert.equal(res.expiresAtSec, undefined);
});

test('refreshToken fb-login without appId/appSecret throws InstagramError kind validation', async () => {
  const { exchange, calls } = fakeExchange({ access_token: 'unused' });

  await assert.rejects(
    () => refreshToken({ authPath: 'fb-login', accessToken: 'FBold', nowMs: NOW_MS, exchange }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
  // Validation happens before any network call.
  assert.equal(calls.length, 0);
});

test('refreshToken rejects an empty accessToken before calling out', async () => {
  const { exchange, calls } = fakeExchange({ access_token: 'unused' });

  await assert.rejects(
    () => refreshToken({ authPath: 'ig-login', accessToken: '', nowMs: NOW_MS, exchange }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('refreshToken throws upstream when the response lacks an access_token', async () => {
  const { exchange } = fakeExchange({ token_type: 'bearer', expires_in: 100 });

  await assert.rejects(
    () => refreshToken({ authPath: 'ig-login', accessToken: 'IGold', nowMs: NOW_MS, exchange }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'upstream',
  );
});

// --- Regression: the exchange must never ride the auth-injecting Graph seam ---

test('refreshToken cannot be handed an IgRequestFn Graph seam at all', async () => {
  // Routing the exchange through the Graph seam is what appended an unwanted
  // access_token/appsecret_proof to endpoints that authenticate themselves. The
  // guarantee is now structural rather than behavioural: `refreshToken` takes a
  // single params object, so there is no argument a seam could arrive through
  // and no runtime branch that could route to one. The arity check is the cheap
  // regression guard — re-adding a `(req, params)` overload trips it here as
  // well as at the call sites.
  assert.equal(refreshToken.length, 1, 'refreshToken must take params only, never a request seam');

  const { exchange, calls: exchanged } = fakeExchange({ access_token: 'FBnew' });
  const res = await refreshToken({
    authPath: 'fb-login',
    accessToken: 'FBold',
    appId: '55500',
    appSecret: 's3cr3t',
    nowMs: NOW_MS,
    exchange,
  });

  // The injected exchange is the only transport that ran.
  assert.equal(exchanged.length, 1);
  assert.equal(res.accessToken, 'FBnew');
});

test('default transport sends the fb-login exchange with no access_token and no appsecret_proof', async () => {
  const { fetchImpl, urls } = fakeFetch({ access_token: 'FBnew', expires_in: 100 });

  await refreshToken({
    authPath: 'fb-login',
    accessToken: 'FBold',
    appId: '55500',
    appSecret: 's3cr3t',
    nowMs: NOW_MS,
    exchange: createTokenExchange({ fetchImpl }),
  });

  assert.equal(urls.length, 1);
  const url = new URL(urls[0]!);
  assert.equal(url.host, 'graph.facebook.com');
  assert.equal(url.pathname, '/v25.0/oauth/access_token');
  // Exactly the documented parameter set — nothing appended (docs/auth.md §1).
  assert.deepEqual([...url.searchParams.keys()].sort(), [
    'client_id',
    'client_secret',
    'fb_exchange_token',
    'grant_type',
  ]);
  assert.equal(url.searchParams.get('access_token'), null);
  assert.equal(url.searchParams.get('appsecret_proof'), null);
  // Belt and braces: the proof the Graph seam would have added is absent.
  const proof = createHmac('sha256', 's3cr3t').update('FBold').digest('hex');
  assert.equal(urls[0]!.includes(proof), false);
});

test('default transport sends the ig-login refresh with exactly one access_token', async () => {
  const { fetchImpl, urls } = fakeFetch({ access_token: 'IGnew', expires_in: 100 });

  await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
    exchange: createTokenExchange({ fetchImpl }),
  });

  const url = new URL(urls[0]!);
  assert.equal(url.host, 'graph.instagram.com');
  assert.equal(url.pathname, '/v25.0/refresh_access_token');
  assert.deepEqual(url.searchParams.getAll('access_token'), ['IGold']);
  assert.equal(url.searchParams.get('grant_type'), 'ig_refresh_token');
  // graph.instagram.com does not accept appsecret_proof at all (docs/auth.md §1).
  assert.equal(url.searchParams.get('appsecret_proof'), null);
});

test('default transport refuses redirects and bounds the request with a timeout', async () => {
  let seen: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen = init;
    return new Response(JSON.stringify({ access_token: 'IGnew' }), { status: 200 });
  };

  await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
    exchange: createTokenExchange({ fetchImpl, timeoutMs: 1234 }),
  });

  assert.equal(seen?.method, 'GET');
  assert.equal(seen?.redirect, 'error');
  assert.ok(seen?.signal instanceof AbortSignal);
});

test('default transport maps a Graph error body to the matching InstagramError kind', async () => {
  const { fetchImpl } = fakeFetch(
    { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } },
    { status: 400 },
  );

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'auth',
  );
});

test('default transport surfaces a non-JSON error body as an InstagramError', async () => {
  const { fetchImpl } = fakeFetch(null, { status: 500, text: '<html>gateway</html>' });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => e instanceof InstagramError,
  );
});

test('needsRefresh is true once the token is within the threshold', () => {
  const summary = summarizeTokenExpiry({
    expiresAtSec: (NOW_MS + 5 * DAY) / 1000,
    nowMs: NOW_MS,
    refreshAfterDays: 45,
  });
  assert.equal(summary.daysLeft, 5);
  assert.equal(needsRefresh(summary, 10), true);
});

test('needsRefresh is false comfortably inside the threshold', () => {
  const summary = summarizeTokenExpiry({
    expiresAtSec: (NOW_MS + 60 * DAY) / 1000,
    nowMs: NOW_MS,
    refreshAfterDays: 45,
  });
  assert.equal(summary.daysLeft, 60);
  assert.equal(needsRefresh(summary, 10), false);
});

test('needsRefresh is true for an already-expired token (negative daysLeft)', () => {
  const summary = summarizeTokenExpiry({
    expiresAtSec: (NOW_MS - 3 * DAY) / 1000,
    nowMs: NOW_MS,
    refreshAfterDays: 45,
  });
  assert.equal(summary.state, 'expired');
  assert.equal(needsRefresh(summary, 10), true);
});

test('needsRefresh is false for a never-expiring or unknown token', () => {
  assert.equal(needsRefresh({ state: 'never' }, 10), false);
  assert.equal(needsRefresh({ state: 'unknown' }, 10), false);
});
