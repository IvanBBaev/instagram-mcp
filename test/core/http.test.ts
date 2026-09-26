/**
 * Tests for the Graph HTTP client seam (`core/http.ts`) and the SSRF host guard
 * (`core/host.ts`). Fully hermetic: an injected `fetchImpl` mock (no real
 * network) and a recording clock (no real time — `sleep` resolves instantly and
 * records its requested duration so backoff/Retry-After math is assertable).
 */
import { getEventListeners } from 'node:events';
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
  /**
   * The headers the client set, or `undefined` when it set none. Recorded
   * because "no payload" is a statement about the header as much as about the
   * body: a `content-type` with nothing behind it is still a wire difference
   * (CC-DATA-15).
   */
  headers: RequestInit['headers'];
  /** The `redirect` mode the client asked the transport for. */
  redirect: RequestInit['redirect'];
  /**
   * Every key the client actually put on the `RequestInit`, sorted.
   *
   * The five fields above are a PROJECTION: this recorder copies the keys it
   * knows about and drops the rest, so a sixth key set by the seam cannot reach
   * any assertion in this file no matter how thoroughly the five are checked.
   * In production that object is handed verbatim to the global `fetch`, so a key
   * added here is a change to what leaves the machine for Meta. Recorded so the
   * key set itself can be pinned (CC-DATA-37).
   */
  initKeys: string[];
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
      headers: init?.headers,
      redirect: init?.redirect,
      initKeys: Object.keys(init ?? {}).sort(),
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

/**
 * A {@link Clock} whose `sleep` resolves immediately and records durations.
 *
 * `now` is anchored at the epoch by default, which keeps the HTTP-date fixtures
 * below readable. Pass `nowMs` when a test needs to prove that some piece of
 * arithmetic reads the injected clock rather than a hard-wired zero.
 */
function recordingClock(nowMs = 0): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => nowMs,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

interface LogRecord {
  msg: string;
  fields: Record<string, unknown> | undefined;
}

interface LeveledRecord extends LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * A {@link Logger} that captures every record whole — level, message AND fields.
 * `warns` keeps the bare messages for the tests that only count them;
 * `warnRecords` and `debugs` are for the ones that pin what an operator would
 * read at one level.
 *
 * `records` is every level in emission order. It exists because the per-level
 * views cannot see a record ADDED at a level nothing reads: `info` and `error`
 * were once no-op sinks here, and a new `log.info` on the request path was
 * therefore invisible to all 1877 tests.
 */
function testLogger(): Logger & {
  warns: string[];
  warnRecords: LogRecord[];
  debugs: LogRecord[];
  records: LeveledRecord[];
} {
  const warns: string[] = [];
  const warnRecords: LogRecord[] = [];
  const debugs: LogRecord[] = [];
  const records: LeveledRecord[] = [];
  const logger = {
    warns,
    warnRecords,
    debugs,
    records,
    debug(msg: string, fields?: Record<string, unknown>) {
      debugs.push({ msg, fields });
      records.push({ level: 'debug', msg, fields });
    },
    info(msg: string, fields?: Record<string, unknown>) {
      records.push({ level: 'info', msg, fields });
    },
    warn(msg: string, fields?: Record<string, unknown>) {
      warns.push(msg);
      warnRecords.push({ msg, fields });
      records.push({ level: 'warn', msg, fields });
    },
    error(msg: string, fields?: Record<string, unknown>) {
      records.push({ level: 'error', msg, fields });
    },
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
  // The whole init key set on a read, not just the absence of `body`. This
  // object is passed straight to the global `fetch`, so its key set is the wire
  // contract, and every read of it in this file names one field at a time —
  // which is blind to a key ADDED beside them, and so is the recorder above
  // unless it keeps this list. Measured 2026-09-22: `credentials: 'include'` on
  // that literal — which would send ambient cookie state to graph.instagram.com
  // on every Graph call — survived all 132 tests of the four files that drive
  // `createIgRequest` (test/core/http, test/api/path-injection, test/index,
  // test/harness) with exit 0 and not one `not ok` line. A read sets three keys
  // and no more: no `headers` without a body (CC-DATA-15), and nothing else.
  assert.deepEqual(calls[0]!.initKeys, ['method', 'redirect', 'signal']);
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

/*
 * CC-DATA-12 — the sibling of CC-DATA-10, same defect, different sink. The
 * query-string builder in `host.ts` skips a `null`; the form-body builder here
 * did not, so `String(null)` serialized the four characters `null` into the
 * `x-www-form-urlencoded` payload. Observed before the fix, verbatim:
 * `caption=ok&alt_text=null&share_to_feed=false`. On a write that is a post
 * whose alt text publicly reads "null" and a publishing-quota slot spent to fix
 * it; nothing that guards `buildUrl` runs on a request body, so the guard has to
 * exist twice.
 *
 * The cast below is the defect itself, written out: `IgRequestOptions.body`
 * declares `string | number | boolean | undefined`, that annotation is erased
 * before the loop runs, and nothing validates the object that arrives — a
 * JavaScript consumer of the shipped `.d.ts` is bound by nothing at all.
 *
 * The `null` sits in the MIDDLE deliberately: a guard that aborted the loop
 * instead of skipping the entry would silently drop every later field of the
 * write.
 */
test('a null body field is omitted, never sent as the literal string "null" (CC-DATA-12)', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: { id: 'created' } }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  const fromUntypedCaller = { caption: 'ok', alt_text: null, location_id: '42' } as unknown as {
    [k: string]: string | number | boolean | undefined;
  };
  await req({ method: 'POST', path: '/123/media', body: fromUntypedCaller });
  const payload = String(calls[0]!.body);
  assert.equal(/null/.test(payload), false, 'no spelling of null reaches the wire');
  assert.equal(
    payload,
    'caption=ok&location_id=42',
    'the null field must vanish from the payload, and the fields behind it must survive',
  );

  // Both nullish spellings are skipped by the same guard, so a body whose every
  // field is nullish contributes no fields at all — and therefore no payload.
  //
  // This assertion previously read `assert.equal(calls[1]!.body, '')`, which
  // pinned the wrong behaviour: it recorded that an all-nullish body still put
  // an empty form payload (and a `content-type` header) on the wire, which is
  // exactly the defect CC-DATA-15 names. It was written while CC-DATA-12 was
  // being closed and was only ever asserting "no phantom keys" — the empty
  // string was the incident, not the intent. The intent is asserted in full by
  // the CC-DATA-15 group below; here it is only tightened from `''` to "no body
  // at all", which is strictly stronger.
  await req({
    method: 'POST',
    path: '/123/media',
    body: { a: null, b: undefined } as unknown as { [k: string]: string | undefined },
  });
  assert.equal(calls[1]!.body, undefined);
});

/*
 * The boundary the fix above must not cross: the guard is nullish, never falsy.
 * `false`, `0` and `''` are values a caller deliberately chose — `share_to_feed:
 * false` is an explicit opt-out, `thumb_offset: 0` is the first frame, `''` is a
 * cleared caption — and each has a real spelling in a form body. Widening the
 * guard to `!value` would drop all three and perform a DIFFERENT write than the
 * one requested, with nothing in the payload to show for it.
 */
test('a POST body keeps falsy-but-meaningful values and drops only the nullish ones', async () => {
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
    body: {
      share_to_feed: false,
      thumb_offset: 0,
      caption: '',
      gone: undefined,
      also_gone: null,
    } as unknown as { [k: string]: string | number | boolean | undefined },
  });
  assert.equal(calls[0]!.body, 'share_to_feed=false&thumb_offset=0&caption=');
});

/*
 * CC-DATA-15 — two spellings of "no payload" were two different requests on the
 * wire. `init.body` and the `content-type` header are set together, gated on the
 * serialized body being defined, and the serialization was assigned
 * unconditionally: `form.toString()` on an empty form is `''`, which is defined.
 * Measured before the fix, through this same seam:
 *
 *   body: undefined      -> `body` absent from init, no headers
 *   body: {}             -> init.body === '', content-type: …x-www-form-urlencoded
 *   body: {a:null,b:und} -> init.body === '', content-type: …x-www-form-urlencoded
 *   DELETE body: {}      -> init.body === '', content-type: …x-www-form-urlencoded
 *
 * The all-nullish row is new since CC-DATA-12 closed: before that fix those
 * fields serialized to `a=null&b=undefined`, so a body that means nothing only
 * started reaching this point empty once the nullish guard began skipping them.
 *
 * The header is half the defect and the more durable half — it survives even
 * when the payload is empty, and it is what makes the two requests
 * distinguishable to every proxy on the path. A DELETE carrying a zero-length
 * form body is the sharp end: nothing in the caller asked for that.
 */

/** Assert the recorded request carried no payload at all — neither half. */
function assertNoPayload(call: FetchCall, label: string): void {
  assert.equal(call.body, undefined, `${label}: no request body`);
  assert.equal(call.headers, undefined, `${label}: and no content-type header`);
}

test('a body that contributes no fields leaves the wire exactly as no body does (CC-DATA-15)', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: { id: 'created' } }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });

  await req({ method: 'POST', path: '/123/media' }); // the reference shape
  await req({ method: 'POST', path: '/123/media', body: {} });
  await req({
    method: 'POST',
    path: '/123/media',
    body: { a: null, b: undefined } as unknown as { [k: string]: string | undefined },
  });
  await req({ method: 'DELETE', path: '/123', body: {} });

  assertNoPayload(calls[0]!, 'body: undefined');
  assertNoPayload(calls[1]!, 'body: {}');
  assertNoPayload(calls[2]!, 'a body whose every field is nullish');
  assertNoPayload(calls[3]!, 'DELETE with body: {}');
});

/*
 * The boundary CC-DATA-15 must not cross — and the reason the guard counts
 * FIELDS instead of testing the serialized string for emptiness. `{ caption: '' }`
 * is not an absent payload: clearing a caption is a real write, `''` is the
 * value the caller chose, and it has a real spelling on the wire (`caption=`).
 * A guard spelled "is the serialized body falsy?" would drop that write and
 * leave the caption untouched, with nothing in the request to show for it.
 */
test('a body whose only field is an empty string still sends a payload (CC-DATA-15)', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ body: { id: 'created' } }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await req({ method: 'POST', path: '/123/media', body: { caption: '' } });
  assert.equal(calls[0]!.body, 'caption=');
  assert.deepEqual(calls[0]!.headers, { 'content-type': 'application/x-www-form-urlencoded' });
  // The write path's whole init key set, for the reason the GET test above
  // spells out. `headers` pins the inner record; this pins the outer one, which
  // nothing else in this file bounds. A write sets exactly these five — the
  // three a read sets, plus the body and the content-type that must travel
  // together.
  assert.deepEqual(calls[0]!.initKeys, ['body', 'headers', 'method', 'redirect', 'signal']);
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
  // The record is pinned whole: method, host and path are the three things an
  // operator needs to match a log line to a call, and none of them is a secret.
  // A `some(msg === …)` alone would let any of the three silently drop out.
  assert.deepEqual(
    log.debugs.filter((rec) => rec.msg === 'graph request'),
    [
      {
        msg: 'graph request',
        fields: { method: 'GET', host: 'graph.instagram.com', path: '/123/media' },
      },
    ],
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

test('one graph request emits exactly one log record and nothing at info or error', async () => {
  // Every other logging test in this file reads ONE level: `debugs` or
  // `warnRecords`. Those views are blind in one direction — a record ADDED at a
  // level nothing reads is invisible to all of them. `info` and `error` were
  // no-op sinks in this double until now, and a `log.info('graph request
  // dispatched', …)` planted on the request path duly survived the entire
  // suite. The whole ordered stream is pinned instead, on the two paths that
  // carry a record at all: a plain request, and a throttled one below.
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

  assert.deepEqual(log.records, [
    {
      level: 'debug',
      msg: 'graph request',
      fields: { method: 'GET', host: 'graph.instagram.com', path: '/123/media' },
    },
  ]);
});

test('a throttled request emits exactly the debug line then the warn, in that order', async () => {
  const log = testLogger();
  const { fetchImpl } = mockFetch(() => ({
    body: { ok: 1 },
    headers: { 'x-app-usage': JSON.stringify({ call_count: 95 }) },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log,
    fetchImpl,
  });
  await req({ method: 'GET', path: '/me' });

  // Order is part of the contract: the request is logged before it goes out, the
  // throttle warning only after the response headers have been read.
  assert.deepEqual(log.records, [
    {
      level: 'debug',
      msg: 'graph request',
      fields: { method: 'GET', host: 'graph.instagram.com', path: '/me' },
    },
    {
      level: 'warn',
      msg: 'approaching Instagram rate limit; throttling before returning',
      fields: { host: 'graph.instagram.com', usagePct: 95 },
    },
  ]);
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

test('an empty host is refused rather than silently replaced by the default', async () => {
  // `opts.host ?? auth.defaultHost`, never `||`. An empty `host` is a caller or
  // config bug, and the two operators disagree about exactly that value: `??`
  // lets it through to the SSRF gate, which refuses it; `||` would swap in the
  // default host and send the request somewhere the caller never named. A
  // request silently redirected to a host nobody asked for is the failure this
  // whole gate exists to prevent, so the empty string must surface as an error.
  const { fetchImpl, calls } = mockFetch(() => ({ body: {} }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'GET', path: '/x', host: '' as unknown as GraphHost }),
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

test('a GET that meets an OAuthException with no recognised code is auth and is NOT retried (CC-AUTH-23)', async () => {
  // Measured before `deriveKind` read `error.type`: this exact response, on a
  // GET, produced FOUR fetches and three backoffs and surfaced as `upstream` —
  // three replays against a credential that will never work again, and an
  // operator told nothing about re-authenticating. The retry decision is what
  // this test pins, not the classification alone: `isRetryableKind` replays
  // `upstream` on every idempotent call, so `kind` and the request count are
  // two views of the same bug.
  const clock = recordingClock();
  const { fetchImpl, calls } = mockFetch(() => ({
    status: 400,
    body: {
      error: {
        type: 'OAuthException',
        message: 'Error validating access token: Session has expired',
      },
    },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'GET', path: '/me' }),
    (e: unknown) =>
      isInstagramError(e) &&
      e.kind === 'auth' &&
      e.status === 400 &&
      e.code === undefined &&
      e.message === 'Error validating access token: Session has expired',
  );
  assert.equal(calls.length, 1, 'a dead token is reported once, never replayed');
  assert.deepEqual(clock.sleeps, [], 'no backoff without a retry');
});

test('a blank x-fb-trace-id header leaves the field absent, not empty (CC-DATA-21)', async () => {
  // `mapGraphError` runs its non-empty filter over the trace id it finds in the
  // BODY only; the header argument is adopted verbatim. So `x-fb-trace-id: ` — a
  // present-but-empty header, which a proxy or a load balancer in front of Meta
  // can emit — arrived on the error as `fbtraceId: ''`: an id-shaped field with
  // no id in it. It reads to the operator as "we have a trace id", it is
  // worthless to anyone who quotes it at Meta support, and it passes every
  // `fbtraceId !== undefined` check between here and the sink, so nothing
  // downstream can tell it apart from a real one. Absent and present-but-blank
  // are the same fact; an id is the different one. All three are pinned in one
  // table so a later edit cannot "fix" one case by breaking another.
  const cases: Array<{ label: string; headers: Record<string, string>; expected?: string }> = [
    { label: 'header absent', headers: {} },
    { label: 'header present but empty', headers: { 'x-fb-trace-id': '' } },
    // A real `Headers` strips leading and trailing whitespace from a value on the
    // way in, so this row reaches the client already flattened to `''`. It is
    // here because it is the spelling an operator would actually see on the wire,
    // and it must land on the same answer; the case where the whitespace SURVIVES
    // the transport is pinned separately below.
    { label: 'header whitespace-only', headers: { 'x-fb-trace-id': '   ' } },
    {
      label: 'header carries a real id',
      headers: { 'x-fb-trace-id': 'AbC-123' },
      expected: 'AbC-123',
    },
  ];

  for (const { label, headers, expected } of cases) {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 400,
      headers,
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
      (e: unknown) => {
        assert.ok(isInstagramError(e));
        assert.equal(e.fbtraceId, expected, label);
        // The trace-id decision changes nothing else about the mapped error.
        assert.equal(e.kind, 'validation', label);
        assert.equal(e.status, 400, label);
        assert.equal(e.code, 100, label);
        return true;
      },
    );
    assert.equal(calls.length, 1, label); // still a validation error: never retried
  }
});

test('a whitespace-only trace id stays blank when the transport does not normalize', async () => {
  // The table above goes through a real `Headers`, which flattens `'   '` to `''`
  // before the client ever sees it — so that row cannot tell a blank test apart
  // from a zero-length one. `fetchImpl` is an injectable seam and nothing makes
  // every transport an `undici` one: a proxy agent, a stubbed `Response`, or a
  // future runtime may answer a header lookup verbatim. Driving that directly
  // pins the guard as "blank", not merely "empty" — and the second row pins the
  // other half of the same decision, that an id which passes the guard is handed
  // on EXACTLY as Meta wrote it. Reshaping a support reference is the same class
  // of harm as inventing one.
  for (const [rawHeader, expected] of [
    ['  \t ', undefined],
    [' AbC-123 ', ' AbC-123 '],
  ] as const) {
    const fetchImpl: typeof fetch = () => {
      const res = new Response(JSON.stringify({ error: { code: 100, message: 'nope' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
      // The normalization is the thing being stepped around, so it cannot be the
      // thing doing the answering: a bare `get` that returns what it was given.
      const verbatim = {
        get: (name: string): string | null => (name === 'x-fb-trace-id' ? rawHeader : null),
      };
      // `defineProperty`'s descriptor takes `any`, so no cast is needed — and adding
      // one would be flagged as unnecessary rather than documenting anything.
      Object.defineProperty(res, 'headers', { value: verbatim });
      return Promise.resolve(res);
    };
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock: recordingClock(),
      log: testLogger(),
      fetchImpl,
    });
    await assert.rejects(
      () => req({ method: 'GET', path: '/x' }),
      (e: unknown) => {
        assert.ok(isInstagramError(e));
        assert.equal(e.fbtraceId, expected, JSON.stringify(rawHeader));
        assert.equal(e.status, 400);
        return true;
      },
    );
  }
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

test('a rate limit that never clears exhausts the attempt budget instead of looping forever', async () => {
  // The HTTP-error arm's `lastAttempt` check is the ONLY exit from the retry
  // loop for an error that stays retryable — the loop itself is unbounded. Every
  // other 429 test here clears on a later attempt, so none of them can observe
  // that check: with it gone they all still pass, and only a rate limit that
  // never lifts distinguishes a bounded client from one that spins until the
  // caller's own signal (or the test runner) kills it.
  //
  // The clock carries a fuse. `sleep` here resolves instantly, so an unbounded
  // client would spin without ever yielding long enough for a test timeout to
  // land — and `npm test` passes no `--test-timeout` at all. Rejecting on the
  // fourth backoff is unreachable while the bound holds (the assertions below
  // pin it at three), and turns a regression into a millisecond-fast failure
  // instead of a hung CI job.
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => 0,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return sleeps.length > 3
        ? Promise.reject(new Error('the retry loop never terminated'))
        : Promise.resolve();
    },
  };
  const { fetchImpl, calls } = mockFetch(() => ({
    status: 429,
    body: { error: { code: 4, message: 'throttled' } },
  }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'GET', path: '/me' }),
    (e: unknown) => isInstagramError(e) && e.kind === 'rate_limit',
  );
  assert.equal(calls.length, 4, 'MAX_ATTEMPTS is 4 — the first try plus 3 retries');
  assert.equal(sleeps.length, 3, 'one backoff between each pair of attempts');
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

test('an HTTP-date Retry-After is measured from the injected clock, not from a fixed zero', async () => {
  // The test above anchors `now` at the epoch, which makes it blind to whether
  // the subtraction reads `clock.now()` at all — 0 is both the honest answer and
  // the constant a bug would hard-wire. Anchoring the clock in 2026 separates
  // them: read correctly the wait is 30s; read as 0 it becomes 56 years, which
  // the 60s cap flattens to a full minute.
  const anchor = Date.parse('2026-01-01T00:00:00Z');
  const clock = recordingClock(anchor);
  const { fetchImpl } = mockFetch((n) =>
    n === 0
      ? {
          status: 429,
          headers: { 'retry-after': new Date(anchor + 30_000).toUTCString() },
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
  // The digit-bearing rows are the near misses: delta-seconds is `^\d+$` and
  // nothing looser. A prefix match would feed `Number('2s')` (NaN) into the
  // sleep, and a NaN sleep is an immediate retry — the opposite of backing off.
  for (const header of ['soon', '   ', '2s', '5;foo', '5 seconds']) {
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

test('a Retry-After that is not delta-seconds or an IMF-fixdate falls back to backoff (CC-RATE-17)', async () => {
  // V8's `Date.parse` has a legacy fallback that reads almost anything as a
  // date: `'1.5'` is 2001-01-01, `'-1'` is 2001-01-01, `'+5'` and `'Thu 5'` are
  // 2001-05-01, `'60,'` is 1960, `'12/31'` is 2001-12-31. Against a 2026 clock
  // each becomes a past instant, so the retry fired with ZERO delay (the
  // hammering CC-RATE-10 exists to avoid). The clock is anchored in 2026
  // because an epoch anchor would turn every one of these into the 60 s cap
  // instead and hide the zero. (A bare `'2026'` is valid delta-seconds and is
  // not in this list.) Only the IMF-fixdate form RFC 9110
  // requires senders to use is read as a date; the obsolete forms and a
  // lower-cased fixdate (HTTP-date is case-sensitive) take the backoff too.
  const anchor = Date.parse('2026-09-26T00:00:00Z');
  for (const header of [
    '1.5',
    '-1',
    '+5',
    '60,',
    'Thu 5',
    '12/31',
    'Jan 1',
    'Sun Nov  6 08:49:37 1994',
    'Sunday, 06-Nov-94 08:49:37 GMT',
    'sat, 26 sep 2026 00:00:30 gmt',
    // Near misses V8 still reads as a date, each 30 s (or an hour before that)
    // after the clock: they pin the anchors, the comma and the zone of the form.
    'x Sat, 26 Sep 2026 00:00:30 GMT',
    'Sat, 26 Sep 2026 00:00:30 GMT+0100',
    'Sat 26 Sep 2026 00:00:30 GMT',
    'Sat, 26 Sep 2026 00:00:30 UTC',
    // IMF-fixdate in shape, but no instant: `Date.parse` answers NaN.
    'Sat, 26 Sep 2026 25:00:00 GMT',
    'Sat, 99 Sep 2026 00:00:30 GMT',
  ]) {
    const clock = recordingClock(anchor);
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
      `Retry-After ${JSON.stringify(header)} must not be read as a date; got ${clock.sleeps[0]}`,
    );
  }
});

test('a FUTURE-dated RFC 850 or asctime Retry-After still takes backoff, not its wait (CC-RATE-18)', async () => {
  // RFC 9110 §5.6.7 says a recipient MUST accept the two obsolete HTTP-date
  // forms; this client refuses them on purpose (owner decision, CC-RATE-18).
  // The CC-RATE-17 list above only has 1994 dates, where honoring would mean
  // a zero wait; this pins the refusal where honoring would mean a REAL wait
  // (30 s after the clock), so a change of policy has to change this test.
  const anchor = Date.parse('2026-09-26T00:00:00Z');
  for (const header of ['Saturday, 26-Sep-26 00:00:30 GMT', 'Sat Sep 26 00:00:30 2026']) {
    const clock = recordingClock(anchor);
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
      `obsolete-form Retry-After ${JSON.stringify(header)} must take backoff; got ${clock.sleeps[0]}`,
    );
  }
});

test('an IMF-fixdate Retry-After on every weekday and month is still honored (CC-RATE-17)', async () => {
  // The strict form must not lose a real date: the first of every month plus
  // seven consecutive days, so every month name and every day name the pattern
  // lists is exercised, each exactly 30 s after the clock.
  const anchors = [
    ...Array.from({ length: 12 }, (_, month) => Date.UTC(2026, month, 1)),
    ...Array.from({ length: 7 }, (_, day) => Date.UTC(2026, 8, 21 + day)),
  ];
  for (const anchor of anchors) {
    const clock = recordingClock(anchor);
    const header = new Date(anchor + 30_000).toUTCString();
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
    assert.deepEqual(clock.sleeps, [30_000], `Retry-After ${header} must be honored`);
  }
});

test('a padded delta-seconds Retry-After is trimmed when the transport does not normalize', async () => {
  // A real `Headers` strips the padding before the client sees it, so every
  // fixture that goes through `new Response` is a fixed point for the `trim()`
  // in `parseRetryAfter`. With the trim gone, `' 2 '` fails the delta-seconds
  // regex and falls to `Date.parse`, which V8 reads leniently as a date in 2001
  // — a 60s (capped) wait in place of a 2s one. The verbatim transport below is
  // the same seam the trace-id test uses: `fetchImpl` is injectable and nothing
  // makes every transport normalize.
  const clock = recordingClock();
  let n = 0;
  const fetchImpl: typeof fetch = () => {
    const first = n++ === 0;
    const res = new Response(
      JSON.stringify(first ? { error: { code: 4, message: 'throttled' } } : { ok: true }),
      { status: first ? 429 : 200, headers: { 'content-type': 'application/json' } },
    );
    const verbatim = {
      get: (name: string): string | null => (first && name === 'retry-after' ? ' 2 ' : null),
    };
    Object.defineProperty(res, 'headers', { value: verbatim });
    return Promise.resolve(res);
  };
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  await req({ method: 'GET', path: '/me' });
  assert.deepEqual(clock.sleeps, [2_000]);
});

test('idempotent:false on a GET switches retries OFF — the override is a value, not a default', async () => {
  // `opts.idempotent ?? method === 'GET'`: the option overrides the method-derived
  // default in BOTH directions (types.ts). `false` is falsy, so an `||` in that
  // seat would quietly re-enable retries for a GET the caller declared unsafe to
  // replay — the one case the override exists for. Both retryable outcomes
  // (a 429 and a transport error) are pinned to a single attempt.
  for (const [label, handler] of [
    [
      '429',
      (): MockResponseSpec => ({
        status: 429,
        headers: { 'retry-after': '1' },
        body: { error: { code: 4, message: 'throttled' } },
      }),
    ],
    [
      'transport error',
      (): MockResponseSpec => {
        throw new TypeError('fetch failed');
      },
    ],
  ] as const) {
    const clock = recordingClock();
    const { fetchImpl, calls } = mockFetch(handler);
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock,
      log: testLogger(),
      fetchImpl,
    });
    await assert.rejects(
      () => req({ method: 'GET', path: '/me', idempotent: false }),
      (e: unknown) => isInstagramError(e),
      label,
    );
    assert.equal(calls.length, 1, `${label}: a non-idempotent GET is never replayed`);
    assert.deepEqual(clock.sleeps, [], `${label}: no backoff without a retry`);
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

test('a caller abort during an idempotent fetch is final — no retry, and it reads as a cancel', async () => {
  // Since 2026-09-23 an already-aborted signal is refused before the slot, so the
  // test above no longer reaches the transport at all. This is the in-flight
  // half: the abort lands while `fetch` is pending, on a GET that WOULD be
  // retried after a timeout, and must end the call on its first attempt with
  // the cancel's own message rather than the timeout's.
  const clock = recordingClock();
  const controller = new AbortController();
  const { fetchImpl, calls } = mockFetch(() => {
    controller.abort();
    return new Promise<MockResponseSpec>(() => {});
  });
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  await assert.rejects(
    () => req({ method: 'GET', path: '/me', signal: controller.signal }),
    (e: unknown) => {
      assert.ok(isInstagramError(e));
      assert.equal(e.message, 'This operation was aborted');
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
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

test('a per-attempt timeout on an idempotent GET is retried — only the caller’s own abort is final', async () => {
  // The per-attempt deadline is `AbortSignal.timeout` folded into the same
  // combined signal the caller's abort goes through, so when the timer fires the
  // signal handed to fetch IS aborted. The retry decision must read the CALLER's
  // signal, not the combined one: a client that checks the combined signal sees
  // every timeout as a caller abort and gives up on the first slow attempt. The
  // two POST timeout tests above cannot tell the difference — a POST is never
  // retried whichever signal is consulted — so this one times out a GET.
  const clock = recordingClock();
  let slow: ReturnType<typeof setTimeout> | undefined;
  const { fetchImpl, calls } = mockFetch((n) =>
    n === 0
      ? new Promise<MockResponseSpec>((resolve) => {
          slow = setTimeout(() => resolve({ body: { late: true } }), 10_000);
        })
      : { body: { ok: true } },
  );
  const req = createIgRequest({
    auth: igAuth,
    settings: s({ timeoutMs: 20 }), // real 20ms per-attempt deadline
    clock,
    log: testLogger(),
    fetchImpl,
  });
  try {
    const out = await req<{ ok: boolean }>({ method: 'GET', path: '/me' });
    assert.deepEqual(out, { ok: true });
    assert.equal(calls.length, 2, 'the timed-out attempt is followed by exactly one retry');
    assert.equal(clock.sleeps.length, 1, 'one backoff between the two attempts');
  } finally {
    if (slow) clearTimeout(slow);
  }
});

test('the third backoff doubles again — 500, 1000, 2000 ms with the jitter pinned to zero', async (t) => {
  // Rule of the fixed point: `500 · 2^n` and `500 · (n + 1)` agree at n = 0 and
  // n = 1 (500 and 1000 ms), which is every backoff the two-retry tests above can
  // see. Only the third sleep (n = 2: 2000 vs 1500 ms) separates exponential from
  // linear, and the [base, 1.5·base) jitter bands of the two overlap there, so
  // the jitter is pinned to zero for a whole-sequence assertion that cannot pass
  // by luck.
  t.mock.method(Math, 'random', () => 0);
  const clock = recordingClock();
  const { fetchImpl, calls } = mockFetch((n) => {
    if (n < 3) throw new TypeError('fetch failed');
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
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 4);
  assert.deepEqual(clock.sleeps, [500, 1000, 2000]);
});

test('the request deadline is the configured timeout, not some multiple of it', async () => {
  // The test above proves only that a timeout fires eventually: its fetch never
  // answers, so any deadline at all — 20ms, 200ms, 20s — ends the same way. This
  // one pins the number. The fetch answers at 120ms, comfortably past the 20ms
  // deadline but well inside any plausible multiple of it, so a client reading
  // the setting correctly aborts while one inflating it returns a 200.
  const clock = recordingClock();
  let late: ReturnType<typeof setTimeout> | undefined;
  const { fetchImpl, calls } = mockFetch(
    () =>
      new Promise<MockResponseSpec>((resolve) => {
        late = setTimeout(() => resolve({ body: { ok: true } }), 120);
      }),
  );
  const req = createIgRequest({
    auth: igAuth,
    settings: s({ timeoutMs: 20 }),
    clock,
    log: testLogger(),
    fetchImpl,
  });
  try {
    await assert.rejects(
      () => req({ method: 'POST', path: '/x', body: { a: '1' } }), // POST → no retry
      (e: unknown) => isInstagramError(e),
    );
    assert.equal(calls.length, 1);
    assert.equal(clock.sleeps.length, 0);
  } finally {
    if (late) clearTimeout(late);
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
  // Pinned whole, not counted: the message is what an operator greps for and the
  // two fields (which host, how hot) are what makes the line actionable. A bare
  // `warns.length === 1` passes with the message rewritten or `usagePct` gone.
  assert.deepEqual(log.warnRecords, [
    {
      msg: 'approaching Instagram rate limit; throttling before returning',
      fields: { host: 'graph.instagram.com', usagePct: 95 },
    },
  ]);
});

// A `fetch` double whose RESPONSE BODY is observable. `mockFetch` above returns
// `new Response(payload)` - a fully buffered body whose read cannot fail and
// cannot be ordered against anything, which is precisely why the two tests below
// could not be written with it (CC-PROC-184). `onRead` runs when the client
// first pulls from the body STREAM, and its text (or rejection) is what the
// stream yields: the client reads the stream itself since the body cap
// (CC-PROC-203), so a double that only patches `text()` would observe nothing.
function bodyFetch(headers: Record<string, string>, onRead: () => Promise<string>): typeof fetch {
  return async () => {
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode(await onRead()));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
}

const HOT = { 'x-app-usage': JSON.stringify({ call_count: 95 }) };

test('a throttled response is DRAINED before the throttle sleep, not after', async () => {
  // The throttle sleeps on `opts.signal`, never on the per-attempt
  // `AbortSignal.timeout(settings.timeoutMs)` - so it burns its full second no
  // matter how little of the deadline is left, while the body it has not read
  // yet is still governed by that deadline. Reading after sleeping therefore
  // discarded responses that had already arrived in full.
  //
  // Measured end-to-end before this test existed, against the real undici and
  // the real system clock, one loopback request whose headers land at ~2 ms
  // carrying `x-app-usage` at 95%: at `timeoutMs: 30_000` it returned at 1009 ms,
  // and at `timeoutMs: 900` the byte-identical response failed at 1004 ms with
  // `DOMException` / `AbortError`. Only the throttle's share of the deadline
  // differed between those runs.
  //
  // Pinned here as ORDER rather than as elapsed time: the wall-clock version
  // needs a real sleep to be honest and still only fails when the numbers line
  // up, whereas the order is the actual invariant and holds at every timeout.
  const order: string[] = [];
  const clock: Clock = {
    now: () => 0,
    sleep: () => {
      order.push('sleep');
      return Promise.resolve();
    },
  };
  const fetchImpl = bodyFetch(HOT, () => {
    order.push('read');
    return Promise.resolve(JSON.stringify({ ok: 1 }));
  });
  const req = createIgRequest({ auth: igAuth, settings: s(), clock, log: testLogger(), fetchImpl });
  const out = await req<{ ok: number }>({ method: 'GET', path: '/me' });
  assert.deepEqual(out, { ok: 1 });
  assert.deepEqual(order, ['read', 'sleep']);
});

test('a body that aborts mid-read arrives as an InstagramError, not a raw DOMException', async () => {
  // Both `readBody` call sites sit outside the transport `try`/`catch`, so
  // whatever the body stream rejects with used to leave `createIgRequest`
  // untouched: `isInstagramError` answered false for it, it carried no `kind`
  // for the retry matrix, and the tool layer had no shape to render. A body read
  // is a network operation and fails like one (CC-PROC-184).
  const fetchImpl = bodyFetch(HOT, () =>
    Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
  );
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  const err = await req({ method: 'GET', path: '/me' }).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(isInstagramError(err), `expected an InstagramError, got ${String(err)}`);
  assert.equal(err.kind, 'upstream');
  assert.equal(err.message, 'The operation was aborted.');
});

/**
 * What this catches: the throttle warning is pinned whole in exactly one place
 * (the test above), and that one place drives the throttle from `x-app-usage`
 * alone, on one host. So the record is pinned for one of the two header
 * spellings that can make the client pause, and `usagePct` happens to equal
 * `appUsagePct` there — which lets the field silently stop being the number the
 * decision was actually made on.
 *
 * Why the wording is behaviour: this warn line is the only place the client ever
 * says out loud that it is deliberately slowing itself down. It is not a field
 * of a structured error somebody re-renders — it goes to the stderr JSON log,
 * and it is the line an operator greps for when tool calls suddenly take a
 * second longer than they used to. The message answers "why is this slow", and
 * `usagePct` answers "how close am I" — the number that decides whether they
 * wait it out or go stop a job. A line that says "approaching the rate limit"
 * with no number, or with the cool header's number while the hot one is at 97%,
 * sends them to the wrong conclusion, and nothing else in the process states
 * that fact.
 *
 * Mutant measured as SURVIVING the suite without this test (restored):
 *  - `usagePct: usage.maxPct` → `usagePct: usage.appUsagePct`. 122/122 passed.
 *    The existing pin sends only `x-app-usage`, so the two are the same number
 *    there; a business-use-case throttle (the one Instagram publishing actually
 *    hits) would then log `usagePct: undefined` while still pausing.
 *  The mirror-image mutant `usagePct: usage.bucUsagePct` IS killed by the
 *  existing test, so the gap is one-directional — which is exactly why only a
 *  table over both headers closes it.
 *
 * The table is every input spelling that reaches the line: app-usage alone,
 * business-use-case alone, both with each one in turn the hotter, and both
 * allowlisted hosts (so the `host` field is pinned as the resolved host rather
 * than a constant). The sentence is restated here rather than imported.
 */
test('the throttle warning names the reading it acted on, whichever header carried it', async () => {
  const cases: ReadonlyArray<{
    label: string;
    auth: AuthProvider;
    host: GraphHost;
    headers: Record<string, string>;
    usagePct: number;
  }> = [
    {
      label: 'x-app-usage alone',
      auth: igAuth,
      host: 'graph.instagram.com',
      headers: { 'x-app-usage': JSON.stringify({ call_count: 95 }) },
      usagePct: 95,
    },
    {
      label: 'x-business-use-case-usage alone',
      auth: igAuth,
      host: 'graph.instagram.com',
      headers: {
        'x-business-use-case-usage': JSON.stringify({ '17841400000000000': [{ call_count: 97 }] }),
      },
      usagePct: 97,
    },
    {
      label: 'both headers, the business-use-case bucket hotter',
      auth: igAuth,
      host: 'graph.instagram.com',
      headers: {
        'x-app-usage': JSON.stringify({ call_count: 12 }),
        'x-business-use-case-usage': JSON.stringify({ '17841400000000000': [{ total_time: 99 }] }),
      },
      usagePct: 99,
    },
    {
      label: 'both headers, the app-usage reading hotter',
      auth: igAuth,
      host: 'graph.instagram.com',
      headers: {
        'x-app-usage': JSON.stringify({ total_cputime: 93 }),
        'x-business-use-case-usage': JSON.stringify({ '17841400000000000': [{ call_count: 20 }] }),
      },
      usagePct: 93,
    },
    {
      label: 'the other allowlisted host, business-use-case hot',
      auth: fbAuth,
      host: 'graph.facebook.com',
      headers: {
        'x-business-use-case-usage': JSON.stringify({
          '17841400000000000': [{ call_count: 90.5 }],
        }),
      },
      usagePct: 90.5,
    },
  ];

  for (const { label, auth, host, headers, usagePct } of cases) {
    const clock = recordingClock();
    const log = testLogger();
    const { fetchImpl } = mockFetch(() => ({ body: { ok: 1 }, headers }));
    const req = createIgRequest({ auth, settings: s(), clock, log, fetchImpl });
    await req({ method: 'GET', path: '/me' });

    // The whole record, per spelling: the sentence, the host it is about and the
    // reading that triggered it. A fragment (or a `warns.length` count) passes
    // with the number gone or wrong, which is the half of the line that is
    // actionable.
    assert.deepEqual(
      log.warnRecords,
      [
        {
          msg: 'approaching Instagram rate limit; throttling before returning',
          fields: { host, usagePct },
        },
      ],
      label,
    );
    // The line claims a pause; the pause has to be real, or the sentence lies.
    assert.deepEqual(clock.sleeps, [1000], label);
  }
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

test('a usage reading of 0% is a reading, not a missing header — the snapshot carries the zeros', async () => {
  // A fresh app at the top of its window reports `call_count: 0`. That is a
  // measurement, not an absent header: the snapshot must carry the zeros and a
  // `maxPct` of 0, so a consumer can tell "quiet" from "no telemetry" (a mutant
  // that tests the percentage for truthiness folds the two together).
  const appHeader = JSON.stringify({ call_count: 0, total_cputime: 0, total_time: 0 });
  const bucHeader = JSON.stringify({ '123': [{ call_count: 0, total_cputime: 0, total_time: 0 }] });
  const events: UsageSnapshot[] = [];
  const { fetchImpl } = mockFetch(() => ({
    body: { ok: 1 },
    headers: { 'x-app-usage': appHeader, 'x-business-use-case-usage': bucHeader },
  }));
  const clock = recordingClock();
  const log = testLogger();
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock,
    log,
    fetchImpl,
    onUsage: (_host, usage) => events.push(usage),
  });
  await req({ method: 'GET', path: '/me' });
  assert.deepEqual(events, [
    {
      appUsagePct: 0,
      bucUsagePct: 0,
      maxPct: 0,
      raw: { 'x-app-usage': appHeader, 'x-business-use-case-usage': bucHeader },
    },
  ]);
  // Zero is far below the throttle line: no sleep, no warning.
  assert.deepEqual(clock.sleeps, []);
  assert.deepEqual(log.warns, []);
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

// --- http.ts: response-body size cap (CC-PROC-203) ------------------------

/** The cap `core/http.ts` enforces, restated rather than imported. */
const BODY_CAP = 16 * 1024 * 1024;
const MIB = 1024 * 1024;

/** What the stream double observed: how often it was pulled and whether it was cancelled. */
interface StreamProbe {
  pulls: number;
  cancelled: boolean;
}

/**
 * A `fetch` double serving `chunks()` as a real body stream — one chunk per
 * pull, so a test can see how far the client read and whether it let go. The
 * iterator may be endless: that is the upstream this cap exists for.
 */
function streamFetch(
  chunks: () => Iterator<Uint8Array>,
  init: { status?: number; headers?: Record<string, string> } = {},
): { fetchImpl: typeof fetch; probe: StreamProbe; calls: () => number } {
  const probe: StreamProbe = { pulls: 0, cancelled: false };
  let calls = 0;
  const fetchImpl: typeof fetch = () => {
    calls += 1;
    const it = chunks();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          probe.pulls += 1;
          const next = it.next();
          if (next.done === true) controller.close();
          else controller.enqueue(next.value);
        },
        cancel() {
          probe.cancelled = true;
        },
      },
      // No read-ahead: a pull happens only when the client asks for a chunk,
      // so `pulls` counts exactly what the client consumed.
      { highWaterMark: 0 },
    );
    return Promise.resolve(
      new Response(stream, {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      }),
    );
  };
  return { fetchImpl, probe, calls: () => calls };
}

/** `n` bytes of ASCII `a`. */
function filler(n: number): Uint8Array {
  return new Uint8Array(n).fill(0x61);
}

/** A JSON string literal of exactly `total` bytes, served in 1 MiB chunks. */
function* jsonStringOf(total: number): Iterator<Uint8Array> {
  const quote = new TextEncoder().encode('"');
  yield quote;
  let left = total - 2;
  while (left > 0) {
    const n = Math.min(MIB, left);
    yield filler(n);
    left -= n;
  }
  yield quote;
}

function* endless(): Iterator<Uint8Array> {
  for (;;) yield filler(MIB);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => assert.fail('expected the call to reject'),
    (e: unknown) => e,
  );
}

const CAP_REMEDY =
  'it was discarded unread. Request a smaller page (a lower `limit`) or fewer fields; ' +
  'if a proxy sits between this server and Meta, check what it is returning.';

test('an endless response body is refused at the cap, not buffered until memory runs out (CC-PROC-203)', async () => {
  // `readBody` used `res.text()`, which has no ceiling: an upstream (or a proxy
  // in front of it) that never stops sending held the call — and the process's
  // memory — until something else gave out. The client now counts bytes as they
  // arrive and lets go of the stream the moment the count passes the cap.
  const { fetchImpl, probe, calls } = streamFetch(endless);
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  const err = await rejection(req({ method: 'GET', path: '/me/media' }));
  assert.ok(isInstagramError(err), `expected an InstagramError, got ${String(err)}`);
  assert.equal(err.kind, 'upstream');
  assert.equal(err.status, 200);
  assert.equal(
    err.message,
    'Graph response body is larger than the 16 MiB this server buffers ' +
      `(more than ${BODY_CAP} bytes received); ${CAP_REMEDY}`,
  );
  // Seventeen 1 MiB chunks are the first to cross 16 MiB; the reader stops
  // there and cancels rather than draining the rest.
  assert.equal(probe.pulls, 17);
  assert.equal(probe.cancelled, true);
  // Not retried, although it is an idempotent GET and the kind is `upstream`:
  // a replay would be refused the same way, at the same cost.
  assert.equal(calls(), 1);
});

test('a body of exactly the cap is read; one byte more is refused (CC-PROC-203)', async () => {
  const at = streamFetch(() => jsonStringOf(BODY_CAP));
  const reqAt = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl: at.fetchImpl,
  });
  const out = await reqAt<string>({ method: 'GET', path: '/me/media' });
  assert.equal(out.length, BODY_CAP - 2);
  assert.equal(at.probe.cancelled, false);

  const over = streamFetch(() => jsonStringOf(BODY_CAP + 1));
  const reqOver = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl: over.fetchImpl,
  });
  const err = await rejection(reqOver({ method: 'GET', path: '/me/media' }));
  assert.ok(isInstagramError(err));
  assert.match(err.message, /more than 16777216 bytes received/);
  assert.equal(over.probe.cancelled, true);
});

test('a declared Content-Length over the cap is refused before any byte is read (CC-PROC-203)', async () => {
  const { fetchImpl, probe } = streamFetch(endless, {
    headers: { 'content-length': ` ${BODY_CAP + 1} ` },
  });
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  const err = await rejection(req({ method: 'GET', path: '/me' }));
  assert.ok(isInstagramError(err));
  assert.equal(err.kind, 'upstream');
  assert.equal(
    err.message,
    'Graph response body is larger than the 16 MiB this server buffers ' +
      `(Content-Length ${BODY_CAP + 1}); ${CAP_REMEDY}`,
  );
  assert.equal(probe.pulls, 0);
  assert.equal(probe.cancelled, true);
});

test('a Content-Length at the cap, unparseable, or under a content coding is not refused up front (CC-PROC-203)', async () => {
  // Only the stream count is authoritative. The header is an early exit, taken
  // when it can be trusted to count the same bytes: never under a real
  // `Content-Encoding` (it then counts the compressed size), and never when it
  // is not a plain decimal. A declared length AT the cap is within it.
  const small = new TextEncoder().encode('{"ok":1}');
  const cases: ReadonlyArray<Record<string, string>> = [
    { 'content-length': String(BODY_CAP) },
    { 'content-length': '1e9' },
    { 'content-length': `${BODY_CAP + 1}`, 'content-encoding': 'gzip' },
  ];
  for (const headers of cases) {
    const { fetchImpl } = streamFetch(() => [small][Symbol.iterator](), { headers });
    const req = createIgRequest({
      auth: igAuth,
      settings: s(),
      clock: recordingClock(),
      log: testLogger(),
      fetchImpl,
    });
    assert.deepEqual(await req({ method: 'GET', path: '/me' }), { ok: 1 }, JSON.stringify(headers));
  }
  // `identity` is no coding at all, however it is cased or padded (the padding
  // is stripped by `Headers` itself, before the client sees the value).
  const { fetchImpl, probe } = streamFetch(endless, {
    headers: { 'content-length': `${BODY_CAP + 1}`, 'content-encoding': ' Identity ' },
  });
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  const err = await rejection(req({ method: 'GET', path: '/me' }));
  assert.ok(isInstagramError(err));
  assert.match(err.message, /\(Content-Length 16777217\)/);
  assert.equal(probe.pulls, 0);
});

test('an oversized ERROR body is refused too, carries its status, and is not retried (CC-PROC-203)', async () => {
  // The error path reads the body before mapping it, so it needs the same cap;
  // a 5xx on a GET would otherwise be retried, and each replay would buffer
  // another oversized body.
  const { fetchImpl, calls } = streamFetch(endless, { status: 502 });
  const clock = recordingClock();
  const req = createIgRequest({ auth: igAuth, settings: s(), clock, log: testLogger(), fetchImpl });
  const err = await rejection(req({ method: 'GET', path: '/me' }));
  assert.ok(isInstagramError(err));
  assert.equal(err.kind, 'upstream');
  assert.equal(err.status, 502);
  assert.match(err.message, /^Graph response body is larger than the 16 MiB/);
  assert.equal(calls(), 1);
  assert.deepEqual(clock.sleeps, []);
});

test('the capped reader decodes exactly as Response.text() did — split characters, BOM, bad bytes (CC-PROC-203)', async () => {
  // Replacing `res.text()` must not change a single delivered character: a
  // multi-byte UTF-8 sequence split across two chunks stays one character, a
  // leading BOM is dropped, and a malformed byte becomes U+FFFD, not a throw.
  const enc = new TextEncoder();
  const bytes = enc.encode('{"caption":"café \u{1F600}"}');
  const cut = bytes.indexOf(0xc3) + 1; // inside the two-byte `é`
  const emoji = bytes.indexOf(0xf0) + 2; // inside the four-byte emoji
  const pieces = [
    new Uint8Array([0xef, 0xbb, 0xbf]),
    bytes.slice(0, cut),
    bytes.slice(cut, emoji),
    bytes.slice(emoji),
  ];
  const { fetchImpl } = streamFetch(() => pieces[Symbol.iterator]());
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  assert.deepEqual(await req({ method: 'GET', path: '/me' }), { caption: 'café \u{1F600}' });

  // A sequence cut off by the END of the body is flushed as U+FFFD too.
  const bad = streamFetch(() => [new Uint8Array([0x6f, 0xff, 0x6b, 0xc3])][Symbol.iterator]());
  const reqBad = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl: bad.fetchImpl,
  });
  assert.equal(await reqBad({ method: 'GET', path: '/me' }), 'o\uFFFDk\uFFFD');
});

test('a response with no body stream at all reads as an empty object (CC-PROC-203)', async () => {
  // `new Response(null)` — and a 204 from a real transport — has `body: null`;
  // the stream reader must treat it as the empty body `res.text()` returned.
  const fetchImpl: typeof fetch = () => Promise.resolve(new Response(null, { status: 200 }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
  });
  assert.deepEqual(await req({ method: 'GET', path: '/me' }), {});
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

// --- http.ts: the caller's signal and the slot queue ------------------------

/** Track a promise's outcome without awaiting it, so "still pending" is assertable. */
function track(p: Promise<unknown>): {
  state: () => 'pending' | 'fulfilled' | 'rejected';
  error: () => unknown;
} {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  let error: unknown;
  p.then(
    () => (state = 'fulfilled'),
    (e: unknown) => {
      state = 'rejected';
      error = e;
    },
  );
  return { state: () => state, error: () => error };
}

test('an already-aborted signal settles before any fetch, even with a slot free', async () => {
  // Measured 2026-09-23 before the fix: the pre-aborted call took a slot and
  // handed `fetch` a dead signal. The real `fetch` then rejects without opening
  // a socket, but an injected transport - or any future pre-flight work behind
  // the slot - still ran for a call the caller had already given up on.
  const { fetchImpl, calls } = mockFetch(() => ({ body: {} }));
  const req = createIgRequest({
    auth: igAuth,
    settings: s(),
    clock: recordingClock(),
    log: testLogger(),
    fetchImpl,
    semaphores: createSemaphoreRegistry(),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => req({ method: 'GET', path: '/me', signal: controller.signal }),
    (e: unknown) => {
      assert.ok(isInstagramError(e));
      // A cancel reads as a cancel, not as the timeout's "aborted due to timeout".
      assert.equal(e.message, 'This operation was aborted');
      assert.equal((e.cause as Error).name, 'AbortError');
      return true;
    },
  );
  assert.equal(calls.length, 0, 'no transport call for a cancelled request');
});

test('an already-aborted call does not queue behind a busy slot', async () => {
  // Measured 2026-09-23 before the fix: at `maxConcurrent: 1` with the slot
  // held, the pre-aborted call was still pending 200 ms later and settled only
  // once the holder finished - in production that is up to four timed-out
  // attempts plus their backoffs after the caller cancelled.
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
  const holder = req({ method: 'GET', path: '/holder' });
  await flush();
  const controller = new AbortController();
  controller.abort();
  const cancelled = track(req({ method: 'GET', path: '/cancelled', signal: controller.signal }));
  await flush();
  assert.equal(cancelled.state(), 'rejected', 'settles while the slot is still held');
  assert.ok(isInstagramError(cancelled.error()));
  gates[0]!();
  await holder;
  assert.equal(calls.length, 1);
});

test('aborting a queued call rejects it at once and gives its place to the next waiter', async () => {
  // The waiter must leave the queue, not merely have its promise rejected: a
  // dead entry left behind would be handed the next freed slot, which it would
  // never release - every later caller on the host then hangs. Aborting the
  // MIDDLE of three waiters pins which entry is removed, and the FIFO order of
  // the survivors.
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
  const controller = new AbortController();
  const first = req({ method: 'GET', path: '/first' });
  const second = req({ method: 'GET', path: '/second' });
  const middle = track(req({ method: 'GET', path: '/middle', signal: controller.signal }));
  const last = req({ method: 'GET', path: '/last' });
  await flush();
  assert.equal(calls.length, 1);

  controller.abort();
  await flush();
  assert.equal(middle.state(), 'rejected', 'the cancel settles without waiting for a slot');
  assert.ok(isInstagramError(middle.error()));
  assert.equal(calls.length, 1, 'and it did not take the slot');
  // `{ once: true }` is the detach on this path: the signal may be reused.
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);

  gates[0]!();
  await first;
  await flush();
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.url, /\/second\b/);
  gates[1]!();
  await second;
  await flush();
  assert.equal(calls.length, 3, 'the waiter behind the cancelled one is not stranded');
  assert.match(calls[2]!.url, /\/last\b/);
  gates[2]!();
  await last;
});

test('a queued call that is granted its slot leaves no listener on the caller signal', async () => {
  // The caller's signal spans every attempt of a request, and a caller may
  // reuse one signal across many requests; `{ once: true }` detaches only when
  // `abort` fires, so the grant path must detach explicitly or each queued wait
  // leaves one dead closure on the signal for as long as it lives.
  const gates: Array<() => void> = [];
  const { fetchImpl } = mockFetch(
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
  const controller = new AbortController();
  const holder = req({ method: 'GET', path: '/holder' });
  const queued = req({ method: 'GET', path: '/queued', signal: controller.signal });
  await flush();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1, 'waiting: one listener');
  gates[0]!();
  await holder;
  await flush();
  gates[1]!();
  await queued;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
