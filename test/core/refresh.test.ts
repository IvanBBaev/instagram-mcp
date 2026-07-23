/**
 * Unit tests for the token-refresh core (Layer 1). Each `refreshToken` call is
 * driven with a fake {@link IgRequestFn} that records the outgoing
 * {@link IgRequestOptions} and returns a canned token-exchange payload — no
 * network. A fixed `nowMs` is injected everywhere so the computed `expiresAtSec`
 * is deterministic (CC-AUTH-13).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import { needsRefresh, refreshToken } from '../../src/core/refresh.js';
import { summarizeTokenExpiry } from '../../src/api/account.js';

/** Build a fake request seam that records calls and returns `responder(opts)`. */
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

const DAY = 86_400_000;
// Fixed, arbitrary clock. Chosen a whole number of seconds for clean expiry math.
const NOW_MS = 1_700_000_000_000;

test('refreshToken ig-login refreshes on graph.instagram.com and computes expiresAtSec', async () => {
  const { req, calls } = fakeReq(() => ({
    access_token: 'IGnew',
    token_type: 'bearer',
    expires_in: 60 * 24 * 3600, // 60 days
  }));

  const res = await refreshToken(req, {
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
  });

  const opts = calls[0]!;
  assert.equal(calls.length, 1);
  assert.equal(opts.method, 'GET');
  assert.equal(opts.host, 'graph.instagram.com');
  assert.equal(opts.path, '/refresh_access_token');
  assert.equal(opts.params?.grant_type, 'ig_refresh_token');
  assert.equal(opts.params?.access_token, 'IGold');

  assert.equal(res.accessToken, 'IGnew');
  assert.equal(res.expiresAtSec, Math.floor(NOW_MS / 1000) + 60 * 24 * 3600);
});

test('refreshToken fb-login exchanges on graph.facebook.com with client_id/secret', async () => {
  const { req, calls } = fakeReq(() => ({
    access_token: 'FBnew',
    token_type: 'bearer',
    expires_in: 5_184_000, // 60 days in seconds
  }));

  const res = await refreshToken(req, {
    authPath: 'fb-login',
    accessToken: 'FBold',
    appId: '55500',
    appSecret: 's3cr3t',
    nowMs: NOW_MS,
  });

  const opts = calls[0]!;
  assert.equal(opts.method, 'GET');
  assert.equal(opts.host, 'graph.facebook.com');
  assert.equal(opts.path, '/oauth/access_token');
  assert.equal(opts.params?.grant_type, 'fb_exchange_token');
  assert.equal(opts.params?.client_id, '55500');
  assert.equal(opts.params?.client_secret, 's3cr3t');
  assert.equal(opts.params?.fb_exchange_token, 'FBold');

  assert.equal(res.accessToken, 'FBnew');
  assert.equal(res.expiresAtSec, Math.floor(NOW_MS / 1000) + 5_184_000);
});

test('refreshToken omits expiresAtSec when the response has no expires_in', async () => {
  const { req } = fakeReq(() => ({ access_token: 'FBnever' }));

  const res = await refreshToken(req, {
    authPath: 'fb-login',
    accessToken: 'FBold',
    appId: '55500',
    appSecret: 's3cr3t',
    nowMs: NOW_MS,
  });

  assert.equal(res.accessToken, 'FBnever');
  assert.equal(res.expiresAtSec, undefined);
});

test('refreshToken fb-login without appId/appSecret throws InstagramError kind validation', async () => {
  const { req, calls } = fakeReq(() => ({ access_token: 'unused' }));

  await assert.rejects(
    () => refreshToken(req, { authPath: 'fb-login', accessToken: 'FBold', nowMs: NOW_MS }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
  );
  // Validation happens before any network call.
  assert.equal(calls.length, 0);
});

test('refreshToken throws upstream when the response lacks an access_token', async () => {
  const { req } = fakeReq(() => ({ token_type: 'bearer', expires_in: 100 }));

  await assert.rejects(
    () => refreshToken(req, { authPath: 'ig-login', accessToken: 'IGold', nowMs: NOW_MS }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'upstream',
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
