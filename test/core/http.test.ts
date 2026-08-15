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
import { createIgRequest, createSemaphoreRegistry } from '../../src/core/http.js';

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
  /** The `redirect` mode the client asked the transport for. */
  redirect: RequestInit['redirect'];
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
      redirect: init?.redirect,
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

interface DebugRecord {
  msg: string;
  fields: Record<string, unknown> | undefined;
}

/** A {@link Logger} that captures `warn` messages and `debug` records. */
function testLogger(): Logger & { warns: string[]; debugs: DebugRecord[] } {
  const warns: string[] = [];
  const debugs: DebugRecord[] = [];
  const logger = {
    warns,
    debugs,
    debug(msg: string, fields?: Record<string, unknown>) {
      debugs.push({ msg, fields });
    },
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

test('the private-range check sees through ports and malformed IPv6 brackets', () => {
  // The range checks run on the bare address, so a port suffix or a missing
  // closing bracket must not be a way to smuggle a loopback/private target past
  // them. (The allowlist would refuse these anyway — this is the second layer.)
  const smuggled = [
    '127.0.0.1:8080', // port suffix on IPv4
    '10.0.0.5:3128',
    '[::1', // unterminated bracket
    '[169.254.169.254', // unterminated bracket around the metadata endpoint
    '[fd00::1]', // IPv6 unique-local  fc00::/7
    '[fc00::1]:443',
    '[fe80::1]', // IPv6 link-local    fe80::/10
    'sub.localhost',
    '0.0.0.0',
    // Each form below reaches the range check only if the bare address is
    // extracted exactly right, and every one of them is refused by the
    // allowlist regardless — so the message is the only evidence of which of
    // the two layers actually caught it.
    '[::1]:443', // bracket AND port: unwrapping must stop at the `]`
    '::1', // bracketless IPv6 — its colons are not a port separator
    '::', // the unspecified address, one character from `::1`
    'localhost:3000', // the archetypal smuggle: a name with a port, not an address
    'LocalHost:8080', // ...and the same thing shouted, since DNS is case-blind
    '192.168.1.1', // 192.168.0.0/16
    '172.20.10.1', // the middle of 172.16.0.0/12
    '172.31.255.254', // ...and its top end — `172.16.` alone would let this through
  ];
  for (const host of smuggled) {
    assert.throws(
      () => assertAllowedHost(host),
      // The message pins WHICH layer refused: the range check, not the allowlist.
      (e: unknown) =>
        isInstagramError(e) && e.kind === 'validation' && /loopback\/private/.test(e.message),
      host,
    );
  }
});

test('the allowlist is an exact match, not a prefix or a suffix of the host', () => {
  // The two Graph hosts are also the two most useful affixes an attacker-owned
  // name can carry: `graph.instagram.com.evil.com` resolves wherever evil.com's
  // nameserver says, and `evilgraph.instagram.com` is a string a suffix check
  // waves through. Neither is loopback or private, so the range check above
  // never sees them — exact membership is the only thing refusing them.
  const confusable = [
    'graph.instagram.com.evil.com',
    'graph.facebook.com.attacker.net',
    'evilgraph.instagram.com',
    'notgraph.facebook.com',
    'graph.instagram.com:8443', // a port is part of the host string, not a Graph host
  ];
  for (const host of confusable) {
    assert.throws(
      () => assertAllowedHost(host),
      (e: unknown) =>
        // The allowlist refused it, not the range check: asserting the message
        // is what proves membership was tested rather than the address ranges.
        isInstagramError(e) && e.kind === 'validation' && !/loopback\/private/.test(e.message),
      host,
    );
  }

  // DNS is case-insensitive, so the host is normalized before it is matched...
  assert.doesNotThrow(() => assertAllowedHost('GRAPH.INSTAGRAM.COM'));
  // ...which is exactly why a shouted loopback must not slip past the range check.
  assert.throws(
    () => assertAllowedHost('LOCALHOST'),
    (e: unknown) => isInstagramError(e) && /loopback\/private/.test(e.message),
  );
});

test('buildUrl refuses an off-allowlist host even though its type says that cannot happen', () => {
  // `buildUrl` takes a `GraphHost`, so this is reachable only through a cast or
  // from JavaScript — which is the case its redundant internal assertion exists
  // for. It is the last gate before a URL string leaves this module, and
  // `core/refresh.ts` builds its token-exchange URL through it without
  // asserting separately, so dropping the check there opens a second door.
  const offAllowlist: string = 'evil.example.com';
  assert.throws(
    () => buildUrl(offAllowlist as GraphHost, '/me'),
    (e: unknown) => isInstagramError(e) && e.kind === 'validation',
  );

  const metadata: string = '169.254.169.254';
  assert.throws(
    () => buildUrl(metadata as GraphHost, '/latest/meta-data/', { recursive: true }),
    (e: unknown) => isInstagramError(e) && /loopback\/private/.test(e.message),
  );
});

test('buildUrl returns the bare base when there are no effective params', () => {
  const base = 'https://graph.instagram.com/v25.0/me';
  assert.equal(buildUrl('graph.instagram.com', '/me'), base, 'no params object at all');
  assert.equal(buildUrl('graph.instagram.com', '/me', {}), base, 'an empty params object');
  assert.equal(
    buildUrl('graph.instagram.com', '/me', { a: undefined, b: undefined }),
    base,
    'every param undefined must not leave a dangling "?"',
  );
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

test('a caller param can never override an auth param', async () => {
  // `params` reaches this seam from tool arguments, i.e. ultimately from the
  // model. If a caller-supplied `access_token` won the merge, a hallucinated (or
  // injected) argument would swap the operator's credential for one the caller
  // chose — and a caller-supplied `appsecret_proof` would forge the very HMAC
  // that proves the call came from this app. Auth is merged last for that reason.
  const { fetchImpl, calls } = mockFetch(() => ({ body: {} }));
  const req = createIgRequest({
    auth: fbAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await req({
    method: 'GET',
    path: '/me',
    params: { access_token: 'ATTACKER_TOKEN', appsecret_proof: 'FORGED', fields: 'id' },
  });
  const url = calls[0]!.url;
  assert.match(url, /access_token=FB_TOKEN/);
  assert.match(url, /appsecret_proof=PROOF/);
  assert.equal(/ATTACKER_TOKEN/.test(url), false, 'the caller must not replace the token');
  assert.equal(/FORGED/.test(url), false, 'the caller must not replace the appsecret_proof');
  assert.match(url, /fields=id/, 'ordinary caller params still ride along');
});

test('a GET never carries a request body, even when the caller passes one', async () => {
  // `body` is optional on every request, so a read path can be handed one by
  // mistake. undici rejects `GET` + body with a TypeError before the socket
  // opens, and a GET is idempotent — so the seam would burn all four attempts
  // and surface a transport error for a request Meta never saw. Dropping the
  // body on a read keeps the call correct instead.
  const { fetchImpl, calls } = mockFetch(() => ({ body: { ok: 1 } }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await req({ method: 'GET', path: '/me', body: { caption: 'stray' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body, undefined);
});

test('an undefined body field is omitted, never sent as the string "undefined"', async () => {
  // Optional tool arguments arrive as `undefined` keys. Stringifying one would
  // publish a post whose caption (or alt text) literally reads "undefined" —
  // publicly visible, and it costs a publishing-quota slot to fix.
  const { fetchImpl, calls } = mockFetch(() => ({ body: { id: 'created' } }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await req({
    method: 'POST',
    path: '/123/media',
    body: { caption: 'ok', alt_text: undefined, location_id: undefined },
  });
  assert.equal(calls[0]!.body, 'caption=ok');
});

test('the request debug log carries no URL and no token', async () => {
  // Graph puts `access_token` in the query string, so the signed URL is a
  // credential. Logs are structured JSON on stderr and are the artifact an
  // operator pastes into a bug report — the URL is logged with its query
  // stripped, never whole (docs/security.md §2).
  const log = testLogger();
  const { fetchImpl } = mockFetch(() => ({ body: {} }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log,
    fetchImpl,
  });
  await req({ method: 'GET', path: '/123/media' });

  assert.ok(
    log.debugs.some((rec) => rec.msg === 'graph request'),
    'the request itself is still logged',
  );
  for (const rec of log.debugs) {
    const serialized = JSON.stringify(rec.fields ?? {});
    assert.equal(serialized.includes('IG_TOKEN'), false, `token leaked into "${rec.msg}"`);
    assert.equal(
      /https?:\/\//.test(serialized),
      false,
      `a full URL leaked into "${rec.msg}": ${serialized}`,
    );
  }
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

test('a disallowed host is refused before the auth provider ever sees it', async () => {
  // `buildUrl` asserts the host again, so a missing gate here would still end in
  // a validation error — but only AFTER the untrusted host string has been
  // handed to the auth layer. On Path B `authParams` computes `appsecret_proof`,
  // an HMAC of the token keyed with the app secret, per host; on a keychain-backed
  // provider it unseals the token. Neither may happen for a host an attacker (or
  // a hallucinated `host` argument) chose, so the gate is ordered first.
  const seen: string[] = [];
  const spyAuth: AuthProvider = {
    path: 'fb-login',
    defaultHost: 'graph.facebook.com',
    authParams: (host: GraphHost) => {
      seen.push(host);
      return Promise.resolve({ access_token: 'FB_TOKEN', appsecret_proof: 'PROOF' });
    },
  };
  const { fetchImpl, calls } = mockFetch(() => ({ body: {} }));
  const req = createIgRequest({
    auth: spyAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  for (const host of ['evil.example.com', '169.254.169.254', 'rupload.facebook.com']) {
    await assert.rejects(
      () => req({ method: 'GET', path: '/x', host: host as unknown as GraphHost }),
      (e: unknown) => isInstagramError(e) && e.kind === 'validation',
      host,
    );
  }
  assert.deepEqual(seen, [], 'no credential work may run for a non-allowlisted host');
  assert.equal(calls.length, 0);

  // ...and the allowlisted host still reaches auth, so the gate is not simply
  // refusing everything.
  await req({ method: 'GET', path: '/me' });
  assert.deepEqual(seen, ['graph.facebook.com']);
});

test('the transport is told to refuse redirects, not follow them', async () => {
  // The allowlist is enforced on the URL this module builds. A 3xx hands the
  // choice of the NEXT host to whoever answered — following it would open a
  // socket to an address no gate ever saw, which is exactly the cross-host
  // redirect docs/security.md §3 refuses. `redirect: 'error'` on the fetch init
  // is the only place that policy can be enforced at the transport.
  const { fetchImpl, calls } = mockFetch(() => ({ body: {} }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await req({ method: 'GET', path: '/me' });
  await req({ method: 'POST', path: '/123/media', body: { caption: 'hi' } });
  for (const call of calls) assert.equal(call.redirect, 'error', call.url);
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

test('429 is NOT retried on a non-idempotent write (POST/DELETE) — a replay may duplicate it', async () => {
  // A throttled write may already have been accepted by Meta before the 429
  // reached us; replaying `media_publish` costs quota and leaves a duplicate,
  // publicly visible post (api/publishing.ts, docs/operations.md §2).
  for (const method of ['POST', 'DELETE'] as const) {
    const clock = recordingClock();
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 429,
      headers: { 'retry-after': '1' },
      body: { error: { code: 80002 } },
    }));
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock,
      log: testLogger(),
      fetchImpl,
    });
    await assert.rejects(
      () => req({ method, path: '/123/media_publish', body: { creation_id: 'C1' } }),
      (e: unknown) => isInstagramError(e) && e.kind === 'rate_limit',
      method,
    );
    assert.equal(calls.length, 1, `${method} must reach Meta exactly once`);
    assert.deepEqual(clock.sleeps, [], `${method} must not back off for a retry`);
  }
});

test('429 IS retried on a write explicitly marked idempotent', async () => {
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
  await req({ method: 'POST', path: '/x', body: { a: '1' }, idempotent: true });
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

test('a transport error retries on an idempotent GET and then succeeds', async () => {
  // A dropped socket / DNS blip never reaches the response branch — it rejects
  // out of `fetch`. Retrying it is the client's core resilience guarantee.
  const clock = recordingClock();
  const { fetchImpl, calls } = mockFetch((n) => {
    if (n < 2) throw new TypeError('fetch failed');
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
  assert.equal(clock.sleeps.length, 2);
  // Exponential backoff with jitter: min(500·2^n, 8000) + [0, base/2).
  assert.ok(clock.sleeps[0]! >= 500 && clock.sleeps[0]! < 750, `got ${clock.sleeps[0]}`);
  assert.ok(clock.sleeps[1]! >= 1000 && clock.sleeps[1]! < 1500, `got ${clock.sleeps[1]}`);
});

test('the backoff carries real jitter, so retries never stampede in lockstep', async () => {
  // Every client that got throttled in the same second retries in the same
  // second if the delay is a pure function of the attempt number — the thundering
  // herd re-creates the 429 it is backing off from, and a `maxConcurrent`-wide
  // burst of parallel tool calls does it to itself. The jitter term is what
  // spreads them (docs/operations.md §2: `min(500·2^n, 8000) ms + jitter`).
  const firstBackoffs: number[] = [];
  for (let i = 0; i < 12; i++) {
    const clock = recordingClock();
    const { fetchImpl } = mockFetch((n) => {
      if (n === 0) throw new TypeError('fetch failed');
      return { body: { ok: true } };
    });
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock,
      log: testLogger(),
      fetchImpl,
    });
    await req({ method: 'GET', path: '/me' });
    assert.equal(clock.sleeps.length, 1);
    const ms = clock.sleeps[0]!;
    assert.ok(ms >= 500 && ms < 750, `first backoff out of the [500, 750) band: ${ms}`);
    firstBackoffs.push(ms);
  }
  assert.ok(
    new Set(firstBackoffs).size > 1,
    `the first backoff is a constant ${firstBackoffs[0]} ms — every client would retry in unison`,
  );
});

test('a transport error is NOT retried on a non-idempotent write', async () => {
  // The socket may have died after Meta accepted the write; a replay would
  // publish twice (same reasoning as the 429-on-POST rule above).
  const clock = recordingClock();
  const { fetchImpl, calls } = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'POST', path: '/x', body: { a: '1' } }),
    (e: unknown) => isInstagramError(e) && e.kind === 'upstream' && /fetch failed/.test(e.message),
  );
  assert.equal(calls.length, 1);
  assert.equal(clock.sleeps.length, 0);
});

test('a transport error that never clears exhausts the attempt budget', async () => {
  const clock = recordingClock();
  const { fetchImpl, calls } = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'GET', path: '/me' }),
    (e: unknown) => isInstagramError(e) && /fetch failed/.test(e.message),
  );
  assert.equal(calls.length, 4, 'MAX_ATTEMPTS is 4 — the first try plus 3 retries');
  assert.equal(clock.sleeps.length, 3, 'one backoff between each pair of attempts');
});

test('Retry-After in the HTTP-date form is honored relative to the clock', async () => {
  // Meta may answer with an HTTP-date instead of delta-seconds; the recording
  // clock anchors `now` at 0, so this date is exactly 30s out.
  const clock = recordingClock();
  const { fetchImpl } = mockFetch((n) =>
    n === 0
      ? {
          status: 429,
          headers: { 'retry-after': 'Thu, 01 Jan 1970 00:00:30 GMT' },
          body: { error: { code: 4, message: 'throttled' } },
        }
      : { body: { ok: true } },
  );
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  await req({ method: 'GET', path: '/me' });
  assert.deepEqual(clock.sleeps, [30_000]);
});

test('an HTTP-date Retry-After already in the past clamps to zero, never negative', async () => {
  const clock = recordingClock();
  const { fetchImpl } = mockFetch((n) =>
    n === 0
      ? {
          status: 429,
          headers: { 'retry-after': 'Wed, 31 Dec 1969 23:59:30 GMT' }, // 30s before `now`
          body: { error: { code: 4, message: 'throttled' } },
        }
      : { body: { ok: true } },
  );
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  await req({ method: 'GET', path: '/me' });
  assert.deepEqual(clock.sleeps, [0]);
});

test('an unparseable or blank Retry-After falls back to exponential backoff', async () => {
  for (const header of ['soon', '   ']) {
    const clock = recordingClock();
    const { fetchImpl } = mockFetch((n) =>
      n === 0
        ? {
            status: 429,
            headers: { 'retry-after': header },
            body: { error: { code: 4, message: 'throttled' } },
          }
        : { body: { ok: true } },
    );
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock,
      log: testLogger(),
      fetchImpl,
    });
    await req({ method: 'GET', path: '/me' });
    assert.equal(clock.sleeps.length, 1);
    assert.ok(
      clock.sleeps[0]! >= 500 && clock.sleeps[0]! < 750,
      `Retry-After ${JSON.stringify(header)} must not be read as a duration; got ${clock.sleeps[0]}`,
    );
  }
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

test('an abort raised while waiting out a backoff surfaces as an InstagramError', async () => {
  // The caller can cancel between attempts, i.e. inside `clock.sleep`. That
  // rejection is a DOMException/Error from the timer, not a mapped Graph error,
  // so the seam must still hand the domain layer an InstagramError.
  const abortingClock: Clock = {
    now: () => 0,
    sleep: () => Promise.reject(new DOMException('The operation was aborted', 'AbortError')),
  };
  const { fetchImpl, calls } = mockFetch(() => ({
    status: 429,
    body: { error: { code: 4, message: 'throttled' } },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: abortingClock,
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'GET', path: '/me' }),
    (e: unknown) => isInstagramError(e) && /operation was aborted/.test(e.message),
  );
  assert.equal(calls.length, 1, 'the backoff never completed, so no second attempt was made');
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

test('malformed usage headers are ignored, never fatal to the call', async () => {
  // Usage headers are advisory telemetry. A truncated or non-JSON value (a
  // proxy rewriting headers, a Meta-side change) must not fail the request.
  const events: UsageSnapshot[] = [];
  const { fetchImpl } = mockFetch(() => ({
    body: { ok: 1 },
    headers: {
      'x-app-usage': 'not-json',
      'x-business-use-case-usage': '{"123": [',
    },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
    onUsage: (_host, usage) => events.push(usage),
  });
  const out = await req<{ ok: number }>({ method: 'GET', path: '/me' });
  assert.equal(out.ok, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.appUsagePct, undefined);
  assert.equal(events[0]!.bucUsagePct, undefined);
  assert.equal(events[0]!.maxPct, undefined);
});

test('a business-use-case header that is valid JSON but not an object yields no percentage', async () => {
  // `null` is the sharp one: it is `typeof 'object'`, so only the explicit null
  // guard keeps `Object.values(null)` from throwing inside the parser.
  for (const header of ['"nope"', 'null', '5']) {
    const events: UsageSnapshot[] = [];
    const { fetchImpl } = mockFetch(() => ({
      body: { ok: 1 },
      headers: { 'x-business-use-case-usage': header },
    }));
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock: recordingClock(),
      log: testLogger(),
      fetchImpl,
      onUsage: (_host, usage) => events.push(usage),
    });
    await req({ method: 'GET', path: '/me' });
    assert.equal(events[0]!.bucUsagePct, undefined, `header ${header}`);
  }
});

test('a business-use-case entry given bare (not wrapped in an array) still reports', async () => {
  const events: UsageSnapshot[] = [];
  const { fetchImpl } = mockFetch(() => ({
    body: { ok: 1 },
    headers: {
      'x-business-use-case-usage': JSON.stringify({ '123': { call_count: 42, total_time: 7 } }),
    },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
    onUsage: (_host, usage) => events.push(usage),
  });
  await req({ method: 'GET', path: '/me' });
  assert.equal(events[0]!.bucUsagePct, 42);
});

test('an app-usage header that is valid JSON but not an object yields no percentage', async () => {
  // `x-app-usage` is fed straight into the field scan, without the extra object
  // guard its business-use-case sibling gets from its own parser. A scalar (a
  // proxy rewriting the header, a Meta-side shape change) must read as "no
  // telemetry" rather than a property read on a number.
  for (const header of ['5', '"nope"', 'null', '[1,2]']) {
    const events: UsageSnapshot[] = [];
    const { fetchImpl } = mockFetch(() => ({
      body: { ok: 1 },
      headers: { 'x-app-usage': header },
    }));
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock: recordingClock(),
      log: testLogger(),
      fetchImpl,
      onUsage: (_host, usage) => events.push(usage),
    });
    await req({ method: 'GET', path: '/me' });
    assert.equal(events[0]!.appUsagePct, undefined, `header ${header}`);
  }
});

test('the worst business-use-case bucket wins, across entries and across ids', async () => {
  // Meta reports one array per business ID and several buckets inside it. Only
  // the hottest bucket decides whether to throttle, so the parser has to fold
  // over both dimensions — reporting whichever it read last would let a call at
  // 70% hide behind a sibling at 10% and skip the proactive slowdown.
  const events: UsageSnapshot[] = [];
  const { fetchImpl } = mockFetch(() => ({
    body: { ok: 1 },
    headers: {
      'x-business-use-case-usage': JSON.stringify({
        '123': [{ call_count: 10 }, { call_count: 70 }],
        '456': [{ call_count: 30 }],
      }),
    },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
    onUsage: (_host, usage) => events.push(usage),
  });
  await req({ method: 'GET', path: '/me' });
  assert.equal(events[0]!.bucUsagePct, 70);
});

test('each usage field can be the hot one — every one of the three is read', async () => {
  // Meta reports call volume, CPU time and wall time separately, and any single
  // one of them hitting 100% throttles the app. A field that stops being read is
  // invisible until the account is already blocked: the snapshot would report a
  // comfortable 1% while `total_time` sat at 97%, so no proactive slowdown fires.
  for (const hot of ['call_count', 'total_cputime', 'total_time'] as const) {
    const events: UsageSnapshot[] = [];
    const clock = recordingClock();
    const log = testLogger();
    const { fetchImpl } = mockFetch(() => ({
      body: { ok: 1 },
      headers: {
        'x-app-usage': JSON.stringify({
          call_count: 1,
          total_cputime: 1,
          total_time: 1,
          [hot]: 97,
        }),
      },
    }));
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock,
      log,
      fetchImpl,
      onUsage: (_host, usage) => events.push(usage),
    });
    await req({ method: 'GET', path: '/me' });
    assert.equal(events[0]!.appUsagePct, 97, hot);
    assert.equal(events[0]!.maxPct, 97, hot);
    assert.deepEqual(clock.sleeps, [1000], `${hot} at 97% must trigger the proactive throttle`);
    assert.equal(log.warns.length, 1, hot);
  }
});

test('a non-finite usage number is not a percentage (CC-RATE-2)', async () => {
  // JSON has no NaN/Infinity literal, but `1e999` parses to Infinity — a
  // truncated or rewritten header is one keystroke away from it. Infinity is
  // `typeof 'number'`, so only the finiteness check keeps it out: as a
  // percentage it would pin `maxPct` above the threshold and make every single
  // response sleep the courtesy pause forever, and it JSON-serializes to `null`
  // in the very status output meant to explain the slowdown.
  for (const value of ['1e999', '-1e999']) {
    const events: UsageSnapshot[] = [];
    const clock = recordingClock();
    const log = testLogger();
    const { fetchImpl } = mockFetch(() => ({
      body: { ok: 1 },
      headers: { 'x-app-usage': `{"call_count": ${value}}` },
    }));
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock,
      log,
      fetchImpl,
      onUsage: (_host, usage) => events.push(usage),
    });
    await req({ method: 'GET', path: '/me' });
    assert.equal(events[0]!.appUsagePct, undefined, value);
    assert.equal(events[0]!.maxPct, undefined, value);
    assert.deepEqual(clock.sleeps, [], `${value} must not be read as a usage percentage`);
    assert.equal(log.warns.length, 0, value);
  }
});

test('a null bucket inside an otherwise valid usage header is skipped, never fatal', async () => {
  // Usage headers are advisory telemetry (CC-RATE-2), but this one arrives as
  // well-formed JSON, so the parser's outer try/catch never sees it — the null
  // reaches the field scan directly. Without the null guard the property read
  // throws a raw TypeError out of the seam, i.e. NOT an InstagramError, and it
  // does so on the success path: the call Meta already answered 200 to would be
  // reported to the operator as a crash.
  const cases: Array<[string, number | undefined]> = [
    ['{"123": [null]}', undefined],
    ['{"123": null}', undefined],
    ['{"123": [null, {"call_count": 55}]}', 55],
  ];
  for (const [header, expected] of cases) {
    const events: UsageSnapshot[] = [];
    const { fetchImpl } = mockFetch(() => ({
      body: { ok: 1 },
      headers: { 'x-business-use-case-usage': header },
    }));
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock: recordingClock(),
      log: testLogger(),
      fetchImpl,
      onUsage: (_host, usage) => events.push(usage),
    });
    const out = await req<{ ok: number }>({ method: 'GET', path: '/me' });
    assert.equal(out.ok, 1, header);
    assert.equal(events[0]!.bucUsagePct, expected, header);
  }
});

test('a response without usage headers reports an empty snapshot, not phantom keys (CC-RATE-1)', async () => {
  // Meta sends the usage headers inconsistently, so "absent" is a normal
  // reading and the budget view keeps the last real one. A snapshot that
  // carries the keys anyway — a `raw` entry whose value is null, or an
  // `appUsagePct` key holding undefined — claims a header arrived when none
  // did, which is what overwrites the last good budget with nothing.
  const events: UsageSnapshot[] = [];
  const { fetchImpl } = mockFetch(() => ({ body: { ok: 1 } }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
    onUsage: (_host, usage) => events.push(usage),
  });
  await req({ method: 'GET', path: '/me' });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {}, 'no headers means no fields at all');
  assert.deepEqual(Object.keys(events[0] ?? { placeholder: true }), []);
});

test('a snapshot omits what it could not read instead of carrying undefined', async () => {
  // Same rule with one header present: `raw` must echo only headers that were
  // actually received, and a percentage that could not be parsed must be an
  // absent key, not a present-but-undefined one — `'appUsagePct' in snapshot`
  // is the difference between "Meta did not report it" and "we read it as
  // nothing".
  const events: UsageSnapshot[] = [];
  const { fetchImpl } = mockFetch(() => ({
    body: { ok: 1 },
    headers: { 'x-business-use-case-usage': JSON.stringify({ '123': [{ call_count: 12 }] }) },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
    onUsage: (_host, usage) => events.push(usage),
  });
  await req({ method: 'GET', path: '/me' });
  const snapshot = events[0]!;
  assert.equal('appUsagePct' in snapshot, false, 'the app-usage header never arrived');
  assert.equal(snapshot.bucUsagePct, 12);
  assert.deepEqual(Object.keys(snapshot.raw ?? {}), ['x-business-use-case-usage']);
});

test('usage headers on an ERROR response are reported too', async () => {
  // The response that matters most for the budget is the 429 — that is when
  // usage is at its peak. Parsing usage only on 2xx blinds the operator exactly
  // when the numbers are worth reading, and this write is not retried, so the
  // error response is the only chance to record them.
  const events: UsageSnapshot[] = [];
  const { fetchImpl, calls } = mockFetch(() => ({
    status: 429,
    headers: { 'x-app-usage': JSON.stringify({ call_count: 97 }) },
    body: { error: { code: 80002, message: 'throttled' } },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
    onUsage: (_host, usage) => events.push(usage),
  });
  await assert.rejects(
    () => req({ method: 'POST', path: '/123/media_publish', body: { creation_id: 'C1' } }),
    (e: unknown) => isInstagramError(e) && e.kind === 'rate_limit',
  );
  assert.equal(calls.length, 1);
  assert.equal(events.length, 1, 'the 429 carried usage headers and they must be reported');
  assert.equal(events[0]!.appUsagePct, 97);
});

test('the proactive throttle fires strictly ABOVE 90%, not at it', async () => {
  // The documented rule is "slow down > 90 %" (docs/operations.md §1). The
  // boundary is not cosmetic: a steady-state 90.0 reading is common on a busy
  // account, and throttling at it adds the courtesy pause to EVERY response —
  // a full extra second on every tool call, for a budget that is still inside
  // its limit.
  const run = async (pct: number): Promise<{ sleeps: number[]; warns: number }> => {
    const clock = recordingClock();
    const log = testLogger();
    const { fetchImpl } = mockFetch(() => ({
      body: { ok: 1 },
      headers: { 'x-app-usage': JSON.stringify({ call_count: pct }) },
    }));
    const req = createIgRequest({ auth: igAuth, settings: s(), clock, log, fetchImpl });
    await req({ method: 'GET', path: '/me' });
    return { sleeps: clock.sleeps, warns: log.warns.length };
  };

  const at = await run(90);
  assert.deepEqual(at.sleeps, [], 'exactly 90% is inside the budget — no pause');
  assert.equal(at.warns, 0);

  const above = await run(90.5);
  assert.deepEqual(above.sleeps, [1000], 'the first reading above 90% pauses');
  assert.equal(above.warns, 1);
});

// --- http.ts: response-body reading -----------------------------------------

test('a non-JSON success body is returned as raw text instead of throwing', async () => {
  // Meta occasionally answers 200 with a plain-text or HTML payload (a proxy or
  // an edge error page). Returning the text lets the caller report something
  // useful; a `JSON.parse` throw here would read as a client bug.
  const { fetchImpl } = mockFetch(() => ({ body: 'Service temporarily unavailable' }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  const out = await req<unknown>({ method: 'GET', path: '/me' });
  assert.equal(out, 'Service temporarily unavailable');
});

test('an empty success body parses to an empty object, not undefined', async () => {
  const { fetchImpl } = mockFetch(() => ({ body: '' }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  assert.deepEqual(await req<unknown>({ method: 'GET', path: '/me' }), {});
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
    // Own counters: this test uses a non-default limit and must not disturb (or
    // be disturbed by) the process-wide registry the other tests exercise.
    semaphores: createSemaphoreRegistry(),
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

test('a freed slot is handed over, not duplicated: a later arrival still queues', async () => {
  // Releasing transfers the permit to the first waiter, so the counter must stay
  // at the handover instead of dropping to zero. If it drops, the slot exists
  // twice: the woken waiter holds one and the next arrival helps itself to
  // another. The breach is silent and cumulative — IG_MAX_CONCURRENT stops
  // bounding anything under sustained load, which is how an account walks into
  // the BUC limit the semaphore exists to avoid.
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
    semaphores: createSemaphoreRegistry(),
  });

  const p1 = req({ method: 'GET', path: '/first' });
  const p2 = req({ method: 'GET', path: '/second' });
  await flush();
  assert.equal(calls.length, 1);

  gates[0]!(); // the first finishes and hands its slot to the queued second
  await p1;
  await flush();
  assert.equal(calls.length, 2);

  // A brand-new caller now arrives while the handed-over slot is still busy.
  const p3 = req({ method: 'GET', path: '/third' });
  await flush();
  assert.equal(calls.length, 2, 'the handed-over slot is occupied — the newcomer waits');
  assert.equal(maxActive, 1);

  gates[1]!();
  await p2;
  await flush();
  assert.equal(calls.length, 3);
  gates[2]!();
  await p3;
  assert.equal(maxActive, 1);
});

test('the wait queue is FIFO — the longest waiter gets the freed slot (CC-RATE-6)', async () => {
  // Queued fairly (FIFO) is the documented contract. Under LIFO the newest tool
  // call jumps the line, so on a saturated host the first request can wait
  // arbitrarily long while later ones stream past it — the MCP client sees one
  // call hang for no reason it can observe.
  const gates: Array<() => void> = [];
  const { fetchImpl, calls } = mockFetch(
    () => new Promise<MockResponseSpec>((resolve) => gates.push(() => resolve({ body: {} }))),
  );
  const req = createIgRequest({
    auth: igAuth,
    settings: s({ maxConcurrent: 1 }),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
    semaphores: createSemaphoreRegistry(),
  });

  const pending = [
    req({ method: 'GET', path: '/first' }),
    req({ method: 'GET', path: '/second' }),
    req({ method: 'GET', path: '/third' }),
  ];
  await flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/first\b/);

  gates[0]!();
  await pending[0];
  await flush();
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.url, /\/second\b/, 'the oldest waiter is served first, not the newest');

  gates[1]!();
  await pending[1];
  await flush();
  assert.match(calls[2]!.url, /\/third\b/);
  gates[2]!();
  await pending[2];
});

test('maxConcurrent bounds the process, not one seam: separately built seams share the limit', async () => {
  // The composition root builds a fresh seam per tool call
  // (`makeRequest(profile)` in src/index.ts, called from mcp/registry.ts), so
  // counters owned by the factory would multiply the operator's IG_MAX_CONCURRENT
  // by the number of in-flight tool calls. Neither seam injects a registry here —
  // that is the production wiring.
  const max = DEFAULT_SETTINGS.maxConcurrent;
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
  const build = () =>
    createIgRequest({
      auth: igAuth,
      settings: s(),
      clock: recordingClock(),
      log: testLogger(),
      fetchImpl,
    });

  const seamA = build();
  const seamB = build();
  const pending = [
    ...Array.from({ length: max }, (_, i) => seamA({ method: 'GET', path: `/a${i}` })),
    ...Array.from({ length: max }, (_, i) => seamB({ method: 'GET', path: `/b${i}` })),
  ];

  await flush();
  assert.equal(calls.length, max, 'both seams must draw from the same per-host budget');

  // Drain: every freed slot admits the next waiter until all 2*max complete.
  for (let guard = 0; gates.length > 0 && guard < pending.length * 2; guard++) {
    gates.shift()!();
    await flush();
  }
  await Promise.all(pending);
  assert.equal(calls.length, pending.length);
  assert.equal(maxActive, max);
});

test('a rejected request releases its concurrency slot', async () => {
  // The release lives in a `finally`, so the abrupt-completion path is a second
  // copy of it that only a throwing request exercises. Skipping it would leak
  // one permit per failure: after `maxConcurrent` errors the host budget is
  // exhausted and every later call hangs forever instead of failing.
  const { fetchImpl, calls } = mockFetch((n) =>
    n === 0
      ? { status: 400, body: { error: { message: 'nope', type: 'OAuthException', code: 100 } } }
      : { body: { ok: 1 } },
  );
  const req = createIgRequest({
    auth: igAuth,
    settings: s({ maxConcurrent: 1 }),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
    // Own counters, so a leak here cannot be masked (or caused) by the
    // process-wide registry the other tests share.
    semaphores: createSemaphoreRegistry(),
  });

  await assert.rejects(() => req({ method: 'GET', path: '/a' }));
  assert.deepEqual(await req<{ ok: number }>({ method: 'GET', path: '/b' }), { ok: 1 });
  assert.equal(calls.length, 2);
});
