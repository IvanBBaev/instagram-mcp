/**
 * Self-tests for the shared test harness (`test/helpers/`).
 *
 * These modules are not shipped, but every assertion in the suite is only as
 * trustworthy as they are: a `withFetch` that silently dropped headers would
 * make the `appsecret_proof` assertions vacuous, and a `fakeClock` whose `set`
 * left pending sleeps hanging would turn a refresh test into a timeout instead
 * of a failure. A broken seam does not fail loudly — it makes other tests pass
 * for the wrong reason, which is the one failure mode a suite cannot catch by
 * running itself.
 *
 * Scope: the seams' own contracts and their edge arms. What the seams are used
 * *for* is asserted where it belongs — `test/core/http.test.ts`,
 * `test/core/refresh.test.ts`, `test/release/fixtures.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFetch, type RecordedRequest } from './helpers/with-fetch.js';
import { fakeClock } from './helpers/fake-clock.js';
import { fixturesDirFor, hasFixture, listFixtures, listFixturesIn } from './helpers/fixtures.js';
import { SERVER_DIR, configHomeEnv, envFileIn } from './helpers/config-home.js';

// --- withFetch ---------------------------------------------------------------

/** Drive the installed stub once and hand back what it recorded plus the response. */
async function callStub(
  responder: Parameters<typeof withFetch>[0],
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ rec: RecordedRequest; res: Response }> {
  const stub = withFetch(responder);
  try {
    const res = await fetch(input, init);
    const rec = stub.requests[0];
    assert.ok(rec, 'the stub must record every call');
    return { rec, res };
  } finally {
    stub.restore();
  }
}

test('withFetch records the URL whatever shape the caller passes it in', async () => {
  // The production seams pass strings today. They are typed `typeof fetch`, so
  // a future refactor to `new URL(...)` or a `Request` would compile — and if
  // the stub read `.url` off a URL (undefined) every URL assertion in the suite
  // would start comparing against "undefined" instead of failing.
  const url = 'https://graph.instagram.com/v25.0/me';
  const ok = () => ({ body: {} });

  const asString = await callStub(ok, url);
  assert.equal(asString.rec.url, url);

  const asUrl = await callStub(ok, new URL(url));
  assert.equal(asUrl.rec.url, `${url}`, 'a URL must be recorded by its href');

  const asRequest = await callStub(ok, new Request(url));
  assert.equal(asRequest.rec.url, url, 'a Request must be recorded by its own url');
});

test('withFetch normalizes every header shape RequestInit allows', async () => {
  const url = 'https://graph.instagram.com/v25.0/me';
  const ok = () => ({ body: {} });

  // `Headers` lower-cases its keys; that is the shape `fetch` itself would see.
  const headers = new Headers({ 'Content-Type': 'application/json', 'X-Trace': 'abc' });
  const fromHeaders = await callStub(ok, url, { headers });
  assert.equal(fromHeaders.rec.headers['content-type'], 'application/json');
  assert.equal(fromHeaders.rec.headers['x-trace'], 'abc');

  // A pair array is the shape that survives `Object.entries`; a pair whose value
  // was dropped must read as empty rather than crash the whole recording.
  const fromPairs = await callStub(ok, url, {
    headers: [['x-a', '1'], ['x-b', '2'], ['x-c']] as unknown as RequestInit['headers'],
  });
  assert.deepEqual(fromPairs.rec.headers, { 'x-a': '1', 'x-b': '2', 'x-c': '' });

  const fromObject = await callStub(ok, url, { headers: { 'x-plain': 'yes' } });
  assert.deepEqual(fromObject.rec.headers, { 'x-plain': 'yes' });

  const none = await callStub(ok, url, {});
  assert.deepEqual(none.rec.headers, {}, 'no headers must record as an empty map, not undefined');
});

test('withFetch defaults the method to GET and records only string bodies', async () => {
  const url = 'https://graph.instagram.com/v25.0/me';
  const ok = () => ({ body: {} });

  const implicit = await callStub(ok, url);
  assert.equal(implicit.rec.method, 'GET', 'an omitted method is a GET, as it is for real fetch');
  assert.equal(implicit.rec.body, undefined);

  const post = await callStub(ok, url, { method: 'post', body: 'caption=hi' });
  assert.equal(post.rec.method, 'POST', 'the method is upper-cased so assertions can compare it');
  assert.equal(post.rec.body, 'caption=hi');

  // The Graph client only ever sends form-encoded strings. Anything else is
  // recorded as absent rather than stringified into a misleading "[object …]".
  const blob = await callStub(ok, url, { method: 'POST', body: new URLSearchParams({ a: '1' }) });
  assert.equal(blob.rec.body, undefined);
});

test('withFetch serializes canned bodies and passes strings through untouched', async () => {
  const url = 'https://graph.instagram.com/v25.0/me';

  const json = await callStub(() => ({ body: { id: '178' } }), url);
  assert.equal(json.res.status, 200, 'the status defaults to 200');
  assert.equal(json.res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await json.res.json(), { id: '178' });

  // A string body is handed over verbatim — the only way to stub malformed JSON,
  // which is how the client's parse-failure path is exercised.
  const raw = await callStub(() => ({ status: 502, body: 'not json at all' }), url);
  assert.equal(raw.res.status, 502);
  assert.equal(await raw.res.text(), 'not json at all');

  // No body at all means `{}`, not the string "undefined" — the client parses
  // every response as JSON, so a bodyless stub must still be valid JSON.
  const empty = await callStub(() => ({ status: 500 }), url);
  assert.equal(empty.res.status, 500);
  assert.equal(await empty.res.text(), '{}');

  // Caller-supplied headers win over the default content-type.
  const custom = await callStub(() => ({ headers: { 'content-type': 'text/plain' } }), url);
  assert.equal(custom.res.headers.get('content-type'), 'text/plain');
});

test('withFetch.restore puts the original global back', async () => {
  const original = globalThis.fetch;
  const stub = withFetch(() => ({ body: {} }));
  assert.notEqual(globalThis.fetch, original, 'the stub must actually be installed');
  await fetch('https://graph.instagram.com/v25.0/me');
  stub.restore();
  assert.equal(globalThis.fetch, original, 'a leaked stub would poison every later test file');
});

// --- fakeClock ---------------------------------------------------------------

test('fakeClock.set jumps to an absolute time and releases the sleeps it passes', async () => {
  // `advance` is relative; `set` exists for tests that pin a wall-clock instant
  // (token expiry arithmetic reads `now()` as unix ms, so the value matters, not
  // just the delta). Both must run the same release pass — a `set` that moved
  // time without flushing would leave a `sleep` pending forever and the test
  // would die on the runner's timeout instead of an assertion.
  const clock = fakeClock(1_000);
  assert.equal(clock.now(), 1_000);

  let woke = false;
  const sleeping = clock.sleep(500).then(() => {
    woke = true;
  });

  clock.set(1_400);
  await Promise.resolve();
  assert.equal(woke, false, 'a deadline that has not been reached must stay pending');

  clock.set(1_500);
  await sleeping;
  assert.equal(clock.now(), 1_500, 'set is absolute, not additive');
  assert.equal(woke, true);
});

test('fakeClock.set can move time backwards without waking a later sleeper', async () => {
  // Nothing in the suite rewinds today, but `set` takes any epoch value; if it
  // flushed unconditionally instead of comparing deadlines, a rewind would fire
  // every pending sleep at once and a "nothing happened yet" assertion would
  // quietly start passing for the wrong reason.
  const clock = fakeClock(10_000);
  let woke = false;
  void clock.sleep(1_000).then(() => {
    woke = true;
  });

  clock.set(0);
  await Promise.resolve();
  assert.equal(clock.now(), 0);
  assert.equal(woke, false);

  clock.advance(11_000);
  await Promise.resolve();
  assert.equal(woke, true, 'the sleeper is still due at its original absolute deadline');
});

test('fakeClock starts at zero and resolves a zero-length sleep without being advanced', async () => {
  // `sleep(0)` is what every poll-loop test passes (`pollIntervalMs: 0`) so the
  // loop runs at full speed. It only resolves because `sleep` flushes eagerly
  // for a non-positive delay — nothing ever advances the clock in those tests.
  // If that eager flush regressed, the poll tests would not fail: they would
  // hang until the runner's timeout, which reads as infrastructure flake.
  const clock = fakeClock();
  assert.equal(clock.now(), 0, 'the default start is the epoch, not an arbitrary instant');

  await clock.sleep(0);
  assert.equal(clock.now(), 0, 'a zero-length sleep must not move time either');

  // Negative is the same case: a deadline already in the past is already due.
  await clock.sleep(-5);
  assert.equal(clock.now(), 0);
});

// --- fixtures ----------------------------------------------------------------

test('hasFixture answers for the committed fixtures directory without throwing', () => {
  // The gate the fixture-backed tests use before they read: `loadFixture` throws
  // on a missing file, so every such test asks first. A `hasFixture` that always
  // answered `false` would silently skip the whole fixture suite on a checkout
  // that does have captures.
  assert.equal(hasFixture('this-fixture-does-not-exist.json'), false);

  const present = listFixtures();
  for (const name of present) {
    assert.equal(hasFixture(name), true, `${name} is listed but hasFixture denies it`);
  }
  // And the two views agree: nothing is listed that cannot be loaded.
  assert.deepEqual(
    present.filter((name) => !hasFixture(name)),
    [],
  );
});

test('listFixturesIn returns [] for a missing directory and sorted *.json for a real one', async () => {
  // A fresh clone has no captures — real ones need live credentials the
  // repository must never contain. That has to read as "nothing to run", not as
  // an ENOENT that fails the suite on every machine but the one that captured.
  assert.deepEqual(listFixturesIn(join(tmpdir(), 'instagram-mcp-no-such-dir-4c1f9')), []);

  const dir = await mkdtemp(join(tmpdir(), 'instagram-mcp-fixtures-'));
  try {
    await writeFile(join(dir, 'b-media.json'), '{}', 'utf8');
    await writeFile(join(dir, 'a-account.json'), '{}', 'utf8');
    await writeFile(join(dir, 'README.md'), 'not a fixture', 'utf8');
    // Sorted, and non-JSON filtered out: the order is what a drift test compares.
    assert.deepEqual(listFixturesIn(dir), ['a-account.json', 'b-media.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listFixtures reads the repo fixtures directory, not some other path', () => {
  // Asserted against the literal layout, not just against `fixturesDirFor`'s own
  // output: `capture-fixtures.mjs` writes through the same helper, so comparing
  // the two views alone would agree happily on any wrong directory.
  const base = join(tmpdir(), 'instagram-mcp-repo-root');
  assert.equal(fixturesDirFor(base), join(base, 'test', 'fixtures'));

  const dir = fixturesDirFor(process.cwd());
  assert.deepEqual(listFixtures(), listFixturesIn(dir));
});

// --- configHomeEnv -----------------------------------------------------------

test('configHomeEnv sets exactly the variable its platform reads', () => {
  // `config-write.ts` reads `%APPDATA%` on win32 and `$XDG_CONFIG_HOME`
  // elsewhere. Setting the wrong one is not a test failure — the resolver falls
  // back to the REAL config home and `writeCredentials` merges a fake token over
  // a developer's live `IG_ACCESS_TOKEN`. The win32 arm is therefore asserted
  // here explicitly, from whatever platform the suite happens to run on.
  const dir = join(tmpdir(), 'instagram-mcp-config-home');

  assert.deepEqual(configHomeEnv(dir, 'win32'), { APPDATA: dir });
  assert.deepEqual(configHomeEnv(dir, 'linux'), { XDG_CONFIG_HOME: dir });
  assert.deepEqual(configHomeEnv(dir, 'darwin'), { XDG_CONFIG_HOME: dir });

  // Only one variable, ever: a map carrying both would hide the resolver reading
  // the wrong one.
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    assert.equal(Object.keys(configHomeEnv(dir, platform)).length, 1);
  }

  const current = configHomeEnv(dir);
  assert.deepEqual(current, configHomeEnv(dir, process.platform), 'the default is this platform');
});

test('envFileIn puts the env file under the server directory', () => {
  const base = join(tmpdir(), 'instagram-mcp-config-home');
  assert.equal(envFileIn(base), join(base, SERVER_DIR, '.env'));
});
