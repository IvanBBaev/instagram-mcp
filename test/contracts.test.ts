import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstagramError, isInstagramError } from '../src/core/types.js';
import { systemClock } from '../src/core/clock.js';
import { fakeClock } from './helpers/fake-clock.js';
import { withFetch } from './helpers/with-fetch.js';
import { createSemaphoreRegistry } from '../src/core/http.js';
import type {
  QueueWait as HttpQueueWait,
  SemaphoreRegistry as HttpSemaphores,
} from '../src/core/http.js';
import { toProfileSummary } from '../src/core/types.js';
import type {
  Logger,
  QueueWait as CoreQueueWait,
  ResolvedProfile,
  SemaphoreRegistry as CoreSemaphores,
} from '../src/core/types.js';
import type { ToolContext } from '../src/mcp/define.js';
import * as ports from './helpers/ports.js';
import { testSettings } from './helpers/settings.js';

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

// --- 3.0 ports (contract bump V3-01) ----------------------------------------

const TOKEN_A = 'EAAtokenAAAAAAAA';
const TOKEN_B = 'EAAtokenBBBBBBBB';
const APP_FIXTURE = 'app-fixture-123456';

function profileSet(): { profiles: ResolvedProfile[]; defaultName: string } {
  return {
    profiles: [
      {
        name: 'default',
        authPath: 'fb-login',
        accessToken: TOKEN_A,
        accountId: '17841',
        appId: '42',
        appSecret: APP_FIXTURE,
        tokenExpiresAtSec: 100,
        tokenExpiryUnverified: true,
      },
      { name: 'brand', authPath: 'ig-login', accessToken: TOKEN_B },
    ],
    defaultName: 'default',
  };
}

test('core SemaphoreRegistry/QueueWait are assignable both ways with core/http', () => {
  // `mcp/` and `tools/` may not import core/http, so types.ts restates the two
  // shapes; this pins that the restatement never drifts from the real one.
  const toCore: CoreSemaphores = createSemaphoreRegistry();
  const toHttp: HttpSemaphores = toCore;
  const wait: CoreQueueWait = { clock: fakeClock(), ms: 1 };
  const waitBack: HttpQueueWait = wait;
  assert.equal(typeof toHttp.acquire, 'function');
  assert.equal(waitBack.ms, 1);
});

test('toProfileSummary copies only non-secret fields and omits absent ones', () => {
  const [full, bare] = profileSet().profiles as [ResolvedProfile, ResolvedProfile];
  assert.deepEqual(toProfileSummary(full), {
    name: 'default',
    authPath: 'fb-login',
    accountId: '17841',
    tokenExpiresAtSec: 100,
    tokenExpiryUnverified: true,
  });
  assert.deepEqual(Object.keys(toProfileSummary(bare)), ['name', 'authPath']);
  const json = JSON.stringify(toProfileSummary(full));
  assert.ok(!json.includes(TOKEN_A) && !json.includes(APP_FIXTURE) && !json.includes('"42"'));
});

test('memorySecretRegistry ignores short secrets and redacts live plus extras', () => {
  const reg = ports.memorySecretRegistry();
  const redact = reg.redactor({ extraSecrets: ['extra-fixture-1'] });
  reg.register('short');
  reg.register('long-fixture-value');
  assert.deepEqual([...reg.secrets], ['long-fixture-value']);
  assert.equal(redact('a long-fixture-value b extra-fixture-1'), 'a [REDACTED] b [REDACTED]');
  assert.equal(reg.redactor()('long-fixture-value'), '[REDACTED]');
});

test('memoryCredentialProvider loads, resolves case-insensitively and registers secrets', async () => {
  const secrets = ports.memorySecretRegistry();
  const provider = ports.memoryCredentialProvider(profileSet(), secrets);
  assert.equal(provider.kind, 'memory');
  const loaded = await provider.load();
  assert.equal(loaded.defaultName, 'default');
  assert.deepEqual(
    loaded.profiles.map((p) => p.name),
    ['default', 'brand'],
  );
  assert.ok(secrets.secrets.has(TOKEN_A) && secrets.secrets.has(APP_FIXTURE));
  assert.equal((await provider.resolve()).name, 'default');
  assert.equal((await provider.resolve('BRAND')).accessToken, TOKEN_B);
  await assert.rejects(provider.resolve('nope'), (err: unknown) => {
    assert.ok(isInstagramError(err));
    assert.equal(err.kind, 'validation');
    assert.ok(!err.message.includes(TOKEN_A));
    return true;
  });
});

test('memoryCredentialProvider.store rotates without restart and clears stale expiry', async () => {
  const provider = ports.memoryCredentialProvider(profileSet());
  const rotated = 'EAAtokenROTATED1';
  const receipt = await provider.store('Default', { accessToken: rotated });
  assert.deepEqual(receipt, { location: 'memory:default', keys: ['accessToken'] });
  const now = await provider.resolve();
  assert.equal(now.accessToken, rotated);
  assert.equal(now.tokenExpiresAtSec, undefined);
  assert.equal(now.tokenExpiryUnverified, undefined);
  assert.equal(now.appSecret, APP_FIXTURE);
  assert.equal(now.accountId, '17841');

  await provider.store('brand', {
    accessToken: 'EAAtokenBRAND222',
    expiresAtSec: 0,
    authPath: 'fb-login',
    accountId: '9',
    appId: '7',
    appSecret: 'fixture-app-value-9',
  });
  const brand = await provider.resolve('brand');
  assert.equal(brand.tokenExpiresAtSec, 0);
  assert.equal(brand.authPath, 'fb-login');
  assert.equal(brand.appSecret, 'fixture-app-value-9');

  await provider.store('fresh', { accessToken: 'EAAtokenFRESH333', authPath: 'ig-login' });
  assert.deepEqual(Object.keys(await provider.resolve('fresh')), [
    'name',
    'authPath',
    'accessToken',
  ]);
  assert.equal(provider.stores.length, 3);

  await assert.rejects(provider.store('other', { accessToken: 'EAAtokenOTHER444' }), /auth path/);
  await assert.rejects(provider.store('brand', { accessToken: '  ' }), /non-blank/);
  assert.equal(provider.stores.length, 3);
});

test('memoryCredentialProvider defaults to its own secret registry', async () => {
  const provider = ports.memoryCredentialProvider({
    profiles: [{ name: 'default', authPath: 'ig-login', accessToken: TOKEN_A }],
    defaultName: 'default',
  });
  assert.equal((await provider.resolve('')).accessToken, TOKEN_A);
});

test('memoryJournal records entries and can be made to fail', async () => {
  const journal = ports.memoryJournal();
  const entry = {
    ts: '1970-01-01T00:00:00.000Z',
    action: 'publish_media',
    account: 'default',
    authPath: 'ig-login' as const,
    summary: 'publish',
    destructive: false,
    identity: 'tenant-1',
  };
  await journal.append(entry);
  assert.deepEqual(journal.entries, [entry]);
  journal.failWith = new Error('disk full');
  await assert.rejects(Promise.resolve(journal.append(entry)), /disk full/);
  assert.equal(journal.entries.length, 1);
});

test('memoryHashtagLedger keeps first-seen times and evicts at the window edge', () => {
  const ledger = ports.memoryHashtagLedger();
  assert.equal(ledger.record('a', 'cats', 0, 10), 1);
  assert.equal(ledger.record('a', 'dogs', 5, 10), 2);
  assert.equal(ledger.record('a', 'cats', 9, 10), 2); // repeat: first-seen stays 0
  assert.equal(ledger.record('b', 'cats', 9, 10), 1); // per account
  assert.equal(ledger.record('a', 'birds', 10, 10), 2); // cats (0) evicted at exactly 10
});

test('fakeProfileDirectory lists summaries and builds a context per profile', async () => {
  const set = profileSet();
  const log: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => log,
  };
  const build = (profile: ResolvedProfile): ToolContext => ({
    req: () => Promise.reject(new Error('offline')),
    settings: testSettings(),
    profile,
    clock: fakeClock(),
    log,
  });
  const dir = ports.fakeProfileDirectory(set, build);
  assert.equal(dir.defaultName, 'default');
  assert.ok(!JSON.stringify(dir.list()).includes(TOKEN_A));
  assert.deepEqual(
    dir.list().map((p) => p.name),
    ['default', 'brand'],
  );
  assert.equal((await dir.contextFor('Brand')).profile.accessToken, TOKEN_B);
  await assert.rejects(dir.contextFor('ghost'), /Unknown account profile 'ghost'/);
});
