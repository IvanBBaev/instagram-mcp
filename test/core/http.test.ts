/**
 * Tests for the Graph HTTP client seam (`core/http.ts`) and the SSRF host guard
 * (`core/host.ts`). Fully hermetic: an injected `fetchImpl` mock (no real
 * network) and a recording clock (no real time — `sleep` resolves instantly and
 * records its requested duration so backoff/Retry-After math is assertable).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInstagramError } from '../../src/core/types.js';
import type {
  AuthProvider,
  GraphHost,
  Logger,
  Settings,
  UsageSnapshot,
} from '../../src/core/types.js';
import type { Clock } from '../../src/core/clock.js';
import { DEFAULT_SETTINGS } from '../../src/core/settings.js';
import { ALLOWED_HOSTS, GRAPH_VERSION, assertAllowedHost, buildUrl } from '../../src/core/host.js';
import { createIgRequest } from '../../src/core/http.js';

// --- Test doubles -----------------------------------------------------------

interface MockResponseSpec {
  status?: number;
  /** JSON-serialized unless a string is given. */
  body?: unknown;
  headers?: Record<string, string>;
}

interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
}

type FetchHandler = (n: number, call: FetchCall) => MockResponseSpec | Promise<MockResponseSpec>;

/** A `fetch`-shaped mock that records calls and honors the AbortSignal. */
function mockFetch(handler: FetchHandler): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = async (input: unknown, init: RequestInit | undefined): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    const signal = init?.signal ?? undefined;
    const call: FetchCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const abortP = new Promise<never>((_, reject) => {
      signal?.addEventListener(
        'abort',
        () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
        {
          once: true,
        },
      );
    });
    const spec = await Promise.race([Promise.resolve(handler(calls.length - 1, call)), abortP]);
    const payload = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body ?? {});
    return new Response(payload, {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json', ...(spec.headers ?? {}) },
    });
  };
  return { fetchImpl: impl, calls };
}

/** A {@link Clock} whose `sleep` resolves immediately and records durations. */
function recordingClock(): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => 0,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

/** A {@link Logger} that captures `warn` messages; everything else is a no-op. */
function testLogger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  const logger = {
    warns,
    debug() {},
    info() {},
    warn(msg: string) {
      warns.push(msg);
    },
    error() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function s(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

const igAuth: AuthProvider = {
  path: 'ig-login',
  defaultHost: 'graph.instagram.com',
  authParams: () => Promise.resolve({ access_token: 'IG_TOKEN' }),
};

const fbAuth: AuthProvider = {
  path: 'fb-login',
  defaultHost: 'graph.facebook.com',
  authParams: (host: GraphHost) => {
    const params: Record<string, string> = { access_token: 'FB_TOKEN' };
    if (host === 'graph.facebook.com') params.appsecret_proof = 'PROOF';
    return Promise.resolve(params);
  },
};

/** Flush pending microtasks/timers so in-flight requests reach `fetch`. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// --- host.ts: allowlist, version pin, URL builder ---------------------------

test('GRAPH_VERSION is pinned to v25.0', () => {
  assert.equal(GRAPH_VERSION, 'v25.0');
});

test('buildUrl pins the version, encodes params, and skips undefined', () => {
  const url = buildUrl('graph.instagram.com', '/123/media', {
    fields: 'id,caption',
    limit: 5,
    flag: true,
    skip: undefined,
  });
  assert.ok(url.startsWith('https://graph.instagram.com/v25.0/123/media?'));
  assert.match(url, /fields=id%2Ccaption/);
  assert.match(url, /limit=5/);
  assert.match(url, /flag=true/);
  assert.equal(/skip=/.test(url), false);
});

test('assertAllowedHost accepts the two Graph hosts, rejects everything else', () => {
  for (const host of ALLOWED_HOSTS) assert.doesNotThrow(() => assertAllowedHost(host));

  const denied = [
    'evil.example.com',
    'localhost',
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    '169.254.169.254', // cloud metadata endpoint
    '::1',
    '[::1]:443',
    'rupload.facebook.com', // intentionally NOT on the v1 allowlist
  ];
  for (const host of denied) {
    assert.throws(
      () => assertAllowedHost(host),
      (e: unknown) => isInstagramError(e) && e.kind === 'validation',
      host,
    );
  }
});

// --- http.ts: URL construction + auth merge ---------------------------------

test('the outgoing URL carries the pinned /v25.0/ segment', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: { id: '1' } }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await req({ method: 'GET', path: '/123/media' });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /^https:\/\/graph\.instagram\.com\/v25\.0\/123\/media\?/);
});

test('appsecret_proof is present on graph.facebook.com and absent on graph.instagram.com', async () => {
  const fb = mockFetch(() => ({ body: {} }));
  const reqFb = createIgRequest({
    auth: fbAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl: fb.fetchImpl,
  });
  await reqFb({ method: 'GET', path: '/me' });
  assert.match(fb.calls[0]!.url, /appsecret_proof=PROOF/);
  assert.match(fb.calls[0]!.url, /access_token=FB_TOKEN/);

  const ig = mockFetch(() => ({ body: {} }));
  const reqIg = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl: ig.fetchImpl,
  });
  await reqIg({ method: 'GET', path: '/me' });
  assert.equal(/appsecret_proof/.test(ig.calls[0]!.url), false);
  assert.match(ig.calls[0]!.url, /access_token=IG_TOKEN/);
});

test('POST sends opts.body form-encoded while auth params stay on the query string', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: { id: 'created' } }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await req({ method: 'POST', path: '/123/media', body: { caption: 'hi there', image_url: 'u' } });
  assert.match(calls[0]!.url, /access_token=IG_TOKEN/); // auth on the query
  assert.equal(typeof calls[0]!.body, 'string');
  assert.match(calls[0]!.body!, /caption=hi\+there/); // body is form-encoded
  assert.match(calls[0]!.body!, /image_url=u/);
});

// --- http.ts: SSRF gate short-circuits before any fetch ---------------------

test('a disallowed host rejects with kind=validation and makes NO fetch call', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: {} }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'GET', path: '/x', host: 'evil.example.com' as unknown as GraphHost }),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('a loopback host (127.0.0.1) rejects with kind=validation and makes NO fetch call', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: {} }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'GET', path: '/x', host: '127.0.0.1' as unknown as GraphHost }),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

// --- http.ts: retry matrix --------------------------------------------------

test('429 retries then succeeds; Retry-After is honored and capped at 60s', async () => {
  const clock = recordingClock();
  const { fetchImpl, calls } = mockFetch((n) => {
    if (n === 0)
      return {
        status: 429,
        headers: { 'retry-after': '120' }, // capped to 60s
        body: { error: { code: 4, message: 'throttled' } },
      };
    if (n === 1)
      return {
        status: 429,
        headers: { 'retry-after': '2' },
        body: { error: { code: 4, message: 'throttled' } },
      };
    return { body: { ok: true } };
  });
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  const out = await req<{ ok: boolean }>({ method: 'GET', path: '/me' });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.sleeps, [60_000, 2_000]);
});

test('429 is retried even on POST (rate-limit retries on any method)', async () => {
  const clock = recordingClock();
  const { fetchImpl, calls } = mockFetch((n) =>
    n === 0
      ? { status: 429, headers: { 'retry-after': '1' }, body: { error: { code: 80002 } } }
      : { body: { ok: true } },
  );
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  await req({ method: 'POST', path: '/x', body: { a: '1' } });
  assert.equal(calls.length, 2);
  assert.deepEqual(clock.sleeps, [1_000]);
});

test('5xx retries on GET but NOT on POST (non-idempotent)', async () => {
  // GET: 500 then success.
  const getClock = recordingClock();
  const g = mockFetch((n) =>
    n === 0 ? { status: 500, body: { error: { message: 'server error' } } } : { body: { ok: 1 } },
  );
  const reqGet = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: getClock,
    log: testLogger(),
    fetchImpl: g.fetchImpl,
  });
  await reqGet({ method: 'GET', path: '/me' });
  assert.equal(g.calls.length, 2);
  assert.equal(getClock.sleeps.length, 1); // one backoff before the retry

  // POST: 503 throws immediately, no retry, no sleep.
  const postClock = recordingClock();
  const p = mockFetch(() => ({ status: 503, body: { error: { message: 'server error' } } }));
  const reqPost = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: postClock,
    log: testLogger(),
    fetchImpl: p.fetchImpl,
  });
  await assert.rejects(
    () => reqPost({ method: 'POST', path: '/x', body: { a: '1' } }),
    (e: unknown) => isInstagramError(e) && e.kind === 'upstream',
  );
  assert.equal(p.calls.length, 1);
  assert.equal(postClock.sleeps.length, 0);
});

test('a mapped Graph error surfaces as an InstagramError with the right kind (never retried)', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({
    status: 400,
    headers: { 'x-fb-trace-id': 'trace-1' },
    body: { error: { code: 100, message: 'Invalid parameter' } },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'GET', path: '/x' }),
    (e: unknown) =>
      isInstagramError(e) &&
      e.kind === 'validation' &&
      e.code === 100 &&
      e.status === 400 &&
      e.fbtraceId === 'trace-1',
  );
  assert.equal(calls.length, 1); // validation is never retried
});

// --- http.ts: timeout / abort ----------------------------------------------

test('a caller-aborted signal produces an InstagramError and does not retry', async () => {
  const controller = new AbortController();
  controller.abort();
  const clock = recordingClock();
  const { fetchImpl } = mockFetch(() => ({ body: {} }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'GET', path: '/me', signal: controller.signal }),
    (e: unknown) => isInstagramError(e),
  );
  assert.equal(clock.sleeps.length, 0);
});

test('a timeout on a never-resolving fetch rejects without hanging', async () => {
  const clock = recordingClock();
  // The mock never resolves on its own; a far-future ref'd timer keeps the event
  // loop alive so `AbortSignal.timeout` (which uses an unref'd timer) can fire.
  let keepAlive: ReturnType<typeof setTimeout> | undefined;
  const { fetchImpl } = mockFetch(
    () =>
      new Promise<MockResponseSpec>((resolve) => {
        keepAlive = setTimeout(() => resolve({ body: {} }), 10_000);
      }),
  );
  const req = createIgRequest({
    auth: igAuth,
    settings: s({ timeoutMs: 20 }), // real 20ms timeout via AbortSignal.timeout
    clock,
    log: testLogger(),
    fetchImpl,
  });
  try {
    await assert.rejects(
      () => req({ method: 'POST', path: '/x', body: { a: '1' } }), // POST → not retried on timeout
      (e: unknown) => isInstagramError(e),
    );
    assert.equal(clock.sleeps.length, 0);
  } finally {
    if (keepAlive) clearTimeout(keepAlive);
  }
});

// --- http.ts: usage headers + proactive throttle ----------------------------

test('usage headers parse into a UsageSnapshot and onUsage fires', async () => {
  const events: Array<{ host: GraphHost; usage: UsageSnapshot }> = [];
  const { fetchImpl } = mockFetch(() => ({
    body: { ok: 1 },
    headers: {
      'x-app-usage': JSON.stringify({ call_count: 25, total_cputime: 10, total_time: 12 }),
      'x-business-use-case-usage': JSON.stringify({
        '123': [{ call_count: 40, total_cputime: 5, total_time: 7 }],
      }),
    },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
    onUsage: (host, usage) => events.push({ host, usage }),
  });
  await req({ method: 'GET', path: '/me' });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.host, 'graph.instagram.com');
  assert.equal(events[0]!.usage.appUsagePct, 25);
  assert.equal(events[0]!.usage.bucUsagePct, 40);
  assert.equal(events[0]!.usage.maxPct, 40);
});

test('usage above 90% triggers a proactive throttle sleep and a warn log', async () => {
  const clock = recordingClock();
  const log = testLogger();
  const { fetchImpl } = mockFetch(() => ({
    body: { ok: 1 },
    headers: { 'x-app-usage': JSON.stringify({ call_count: 95 }) },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log,
    fetchImpl,
  });
  await req({ method: 'GET', path: '/me' });
  assert.equal(clock.sleeps.length, 1);
  assert.ok(clock.sleeps[0]! > 0);
  assert.equal(log.warns.length, 1);
});

// --- http.ts: per-host concurrency semaphore --------------------------------

test('the per-host semaphore serializes calls beyond maxConcurrent', async () => {
  let active = 0;
  let maxActive = 0;
  const gates: Array<() => void> = [];
  const { fetchImpl, calls } = mockFetch(
    () =>
      new Promise<MockResponseSpec>((resolve) => {
        active++;
        maxActive = Math.max(maxActive, active);
        gates.push(() => {
          active--;
          resolve({ body: {} });
        });
      }),
  );
  const req = createIgRequest({
    auth: igAuth,
    settings: s({ maxConcurrent: 1 }),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });

  const p1 = req({ method: 'GET', path: '/a' });
  const p2 = req({ method: 'GET', path: '/b' });
  await flush();
  assert.equal(calls.length, 1); // limit 1 → only the first is in flight

  gates[0]!();
  await p1;
  await flush();
  assert.equal(calls.length, 2); // the second proceeds once the slot frees

  gates[1]!();
  await p2;
  assert.equal(maxActive, 1);
});
