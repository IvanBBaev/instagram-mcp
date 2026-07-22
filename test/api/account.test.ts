/**
 * Unit tests for the `account` api layer. Each function is driven with a fake
 * {@link IgRequestFn} that records the outgoing {@link IgRequestOptions} and
 * returns canned Graph payloads — no network, no fetch stub needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError } from '../../src/core/types.js';
import type { IgRequestFn, IgRequestOptions } from '../../src/core/types.js';
import {
  debugToken,
  getAccount,
  listLinkedAccounts,
  summarizeTokenExpiry,
} from '../../src/api/account.js';

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
  const opts = calls[0]!;
  assert.equal(opts.method, 'GET');
  assert.equal(opts.path, '/178414');
  assert.equal(
    opts.params?.fields,
    'username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count',
  );
  // No explicit host — the active auth provider's default is used.
  assert.equal(opts.host, undefined);

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

test('getAccount encodes igId and tolerates omitted fields (CC-DATA-2)', async () => {
  const { req, calls } = stubReq(() => ({ id: '999' }));

  const profile = await getAccount(req, { igId: 'me' });

  assert.equal(calls[0]!.path, '/me');
  assert.equal(profile.id, '999');
  assert.equal(profile.username, undefined);
  assert.equal(profile.biography, undefined);
  assert.equal(profile.followersCount, undefined);
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

  const opts = calls[0]!;
  assert.equal(opts.method, 'GET');
  assert.equal(opts.path, '/me/accounts');
  assert.equal(opts.host, 'graph.facebook.com');
  assert.equal(opts.params?.fields, 'name,instagram_business_account{id,username}');

  assert.deepEqual(linked, [
    { pageId: 'page1', pageName: 'Acme Page', igId: 'ig1', igUsername: 'acme' },
    { pageId: 'page2', pageName: 'No-IG Page', igId: undefined, igUsername: undefined },
  ]);
});

test('listLinkedAccounts returns [] when the edge is empty', async () => {
  const { req } = stubReq(() => ({ data: [] }));
  assert.deepEqual(await listLinkedAccounts(req), []);
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

  const opts = calls[0]!;
  assert.equal(opts.method, 'GET');
  assert.equal(opts.path, '/debug_token');
  assert.equal(opts.host, 'graph.facebook.com');
  assert.equal(opts.params?.input_token, 'EAAsecret');

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

test('summarizeTokenExpiry: expired for a past expiry', () => {
  const now = 100 * DAY;
  const expiresAtSec = (now - 5 * DAY) / 1000;
  const s = summarizeTokenExpiry({ expiresAtSec, nowMs: now, refreshAfterDays: 45 });
  assert.equal(s.state, 'expired');
  assert.equal(s.daysLeft, -5);
  assert.ok(s.warning && s.warning.includes('expired'));
});

test('InstagramError from req propagates unchanged through the api layer', async () => {
  const boom = new InstagramError('token expired', { kind: 'auth', status: 401, code: 190 });
  const req: IgRequestFn = () => Promise.reject(boom);
  await assert.rejects(getAccount(req, { igId: 'me' }), (err) => {
    assert.equal(err, boom);
    return true;
  });
});
