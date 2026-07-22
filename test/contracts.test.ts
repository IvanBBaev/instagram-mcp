import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError, isInstagramError } from '../src/core/types.js';
import { systemClock } from '../src/core/clock.js';
import { fakeClock } from './helpers/fake-clock.js';
import { withFetch } from './helpers/with-fetch.js';

test('InstagramError carries kind + Graph metadata and is an Error', () => {
  const err = new InstagramError('token expired', { kind: 'auth', status: 401, code: 190 });
  assert.equal(err.kind, 'auth');
  assert.equal(err.status, 401);
  assert.equal(err.code, 190);
  assert.ok(err instanceof Error);
  assert.ok(isInstagramError(err));
  assert.equal(isInstagramError(new Error('x')), false);
});

test('systemClock.now returns a positive epoch', () => {
  assert.ok(systemClock.now() > 0);
});

test('fakeClock resolves a pending sleep only after advancing past its deadline', async () => {
  const clock = fakeClock(1000);
  let woke = false;
  const p = clock.sleep(500).then(() => {
    woke = true;
  });
  clock.advance(499);
  await Promise.resolve();
  assert.equal(woke, false);
  clock.advance(1);
  await p;
  assert.equal(woke, true);
  assert.equal(clock.now(), 1500);
});

test('withFetch records the outgoing request and returns stubbed JSON', async () => {
  const stub = withFetch((req) => ({ body: { path: req.url, ok: true } }));
  try {
    const res = await fetch('https://graph.instagram.com/v25.0/me', { method: 'GET' });
    const json = (await res.json()) as { ok: boolean };
    assert.equal(json.ok, true);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0]?.method, 'GET');
  } finally {
    stub.restore();
  }
});
