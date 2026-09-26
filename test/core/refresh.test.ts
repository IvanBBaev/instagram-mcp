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
import { InstagramError, type AuthPath } from '../../src/core/types.js';
import {
  createTokenExchange,
  refreshToken,
  type TokenExchangeFn,
  type TokenExchangeRequest,
} from '../../src/core/refresh.js';
import { DEFAULT_SETTINGS } from '../../src/core/settings.js';
import { summarizeTokenExpiry } from '../../src/api/account.js';
import { MAX_RECORDED_EXPIRY_SEC } from '../../src/core/time.js';

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

/**
 * Hard safety rail for this file: nothing here may open a socket. Both seams in
 * this module fall back to something ambient when their injection is missing —
 * `createTokenExchange` to the platform `fetch`, `refreshToken` to a default
 * exchange built on it — so a regression that drops an injected transport would
 * otherwise send a real long-lived token to Meta straight from the test suite.
 * Replacing the global turns that into a loud, offline failure instead.
 */
const NETWORK_FORBIDDEN = 'refresh tests must never reach the real network';
globalThis.fetch = () => {
  throw new Error(NETWORK_FORBIDDEN);
};

// Fixed, arbitrary clock. Chosen a whole number of seconds for clean expiry math.
const NOW_MS = 1_700_000_000_000;

/**
 * Obviously-fake credentials, shaped like the real ones. The SHAPES are
 * load-bearing in the leak tests and nowhere else:
 *
 *  - `createRedactor` drops an `extraSecrets` entry shorter than
 *    `MIN_REGISTERED_SECRET_LENGTH` (8), so a toy `'s3cr3t'` would satisfy a
 *    "did not leak" assertion for the wrong reason. A Meta app secret is 32 hex
 *    characters; this is 32 hex characters that spell nothing.
 *  - The token is deliberately NOT `EAA…`/`IG…`-shaped. If it were, `errors.ts`'s
 *    shape dictionary would mask it and the test would pass without the module's
 *    own redaction doing anything at all.
 *  - 32 hex, not 64: a 64-hex string is an `appsecret_proof` to that same
 *    dictionary, which would again mask it for us.
 */
const FAKE_APP_SECRET = 'facade00facade00facade00facade00';
const FAKE_APP_ID = '1234567890123456';
const FAKE_LONG_LIVED_TOKEN = 'longlived-token-not-meta-shaped-0001';

/**
 * The same two credentials, spelled with characters that URL encoding changes.
 * Everything above is URL-safe, so `buildUrl` writes it into the query byte for
 * byte and a redactor that only knows the raw value masks it by luck. These
 * spellings separate the two: `+`, `/`, `=`, ` ` and `#` all come back out of
 * `URLSearchParams` as something else. Nothing constrains a stored long-lived
 * token to the alphabet Meta currently mints in — it reaches this module as an
 * arbitrary string from the operator's env file.
 */
const FAKE_UNSAFE_APP_SECRET = 'facade00+facade00/facade00=facade00';
const FAKE_UNSAFE_TOKEN = 'longlived token/not+meta=shaped#0001';

/**
 * The same two credentials again, padded and NFKC-unstable (`Ｆ` → `F`,
 * `Ⅻ` → `XII`, `ﬁ` → `fi`) — the shape `ADVERSARIAL_TOKEN` has in
 * `test/core/auth.test.ts`, where it kills the identical repairs. Every fixture
 * above is already trimmed and plain ASCII, so none of them can separate
 * "forwarded byte for byte" from a silent `trim`, `normalize`, case fold or
 * slice. The whitespace cases this file does carry are all BLANK, which
 * `isNonBlank` rejects whether or not the value is repaired first.
 */
const PADDED_OLD_TOKEN = '  IGQ-Ｆake-Ⅻ-ﬁxture-OLD-NOT-A-REAL-TOKEN  ';
const PADDED_NEW_TOKEN = '  IGQ-Ｆake-Ⅻ-ﬁxture-NEW-NOT-A-REAL-TOKEN  ';
const PADDED_APP_SECRET = `  ${FAKE_APP_SECRET}  `;

/** The bytes `buildUrl` writes for `value` — its `URLSearchParams` spelling. */
function asWritten(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice('v='.length);
}

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
  // Both records are pinned WHOLE rather than field by field, and the reason was
  // MEASURED. Reading `call.host`/`call.path` (with a deepEqual on the nested
  // `params` only) and `res.accessToken`/`res.expiresAtSec` one slot at a time
  // cannot see a field ADDED to either shape: wrapping this module's exchange
  // request as `Object.assign({ host, path, params: query }, { debugX: 'x' })`,
  // and its return as `Object.assign({ accessToken, expiresAtSec }, { debugX:
  // 'x' })`, each survived the entire suite — 1880 tests, 0 new failures, exit 0.
  // Neither shape tolerates a passenger: the request is the COMPLETE query of an
  // un-authenticated OAuth call (nothing downstream filters it, so an extra key
  // is an extra parameter on the wire), and the result is the freshly minted
  // long-lived credential the composition root registers with the redactor and
  // writes to the credential file.
  assert.deepEqual(call, {
    host: 'graph.instagram.com',
    path: '/refresh_access_token',
    params: {
      grant_type: 'ig_refresh_token',
      access_token: 'IGold',
    },
  });

  assert.deepEqual(res, {
    accessToken: 'IGnew',
    expiresAtSec: Math.floor(NOW_MS / 1000) + 60 * 24 * 3600,
  });
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
  // Whole-object pins, for the measured reason recorded on the ig-login case
  // above. This is the path that puts the app SECRET in the query, so "exactly
  // these four params and nothing else" is the assertion that matters.
  assert.deepEqual(call, {
    host: 'graph.facebook.com',
    path: '/oauth/access_token',
    params: {
      grant_type: 'fb_exchange_token',
      client_id: '55500',
      client_secret: 's3cr3t',
      fb_exchange_token: 'FBold',
    },
  });

  assert.deepEqual(res, {
    accessToken: 'FBnew',
    expiresAtSec: Math.floor(NOW_MS / 1000) + 5_184_000,
  });
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

  // Whole pin again (see the ig-login case above for the measurement). Note the
  // explicit `expiresAtSec: undefined`: this module always WRITES the slot, and
  // `assert.deepEqual` is `deepStrictEqual` here, which counts an own key whose
  // value is `undefined` — omitting it would fail rather than pass loosely.
  assert.deepEqual(res, { accessToken: 'FBnever', expiresAtSec: undefined });
});

test('refreshToken fb-login without appId/appSecret throws InstagramError kind validation', async () => {
  const { exchange, calls } = fakeExchange({ access_token: 'unused' });

  await assert.rejects(
    () => refreshToken({ authPath: 'fb-login', accessToken: 'FBold', nowMs: NOW_MS, exchange }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'validation');
      // The message is the whole diagnostic: `refresh` prints it and exits, with
      // no report to read afterwards. It has to name BOTH settings, because the
      // operator's next move is to add IG_APP_ID and IG_APP_SECRET to the env
      // file — a generic "refresh failed" sends them re-running `login` instead.
      assert.match(e.message, /appId/);
      assert.match(e.message, /appSecret/);
      return true;
    },
  );
  // Validation happens before any network call.
  assert.equal(calls.length, 0);
});

test('refreshToken fb-login rejects when EITHER app credential is missing', async () => {
  // Supplying neither credential is the easy case; a half-filled config is the
  // real one. `!appId` alone would let an appSecret-less profile through and send
  // Meta an empty `client_secret`, which comes back as a bare OAuth rejection
  // with nothing pointing at the missing setting.
  for (const partial of [{ appId: '55500' }, { appSecret: 's3cr3t' }]) {
    const { exchange, calls } = fakeExchange({ access_token: 'unused' });

    await assert.rejects(
      () =>
        refreshToken({
          authPath: 'fb-login',
          accessToken: 'FBold',
          nowMs: NOW_MS,
          exchange,
          ...partial,
        }),
      (e: unknown) => e instanceof InstagramError && e.kind === 'validation',
      `a fb-login refresh with only ${Object.keys(partial).join('')} must be refused`,
    );
    assert.equal(calls.length, 0, 'an incomplete app credential pair must not leave the process');
  }
});

test('refreshToken rejects an empty accessToken before calling out', async () => {
  const { exchange, calls } = fakeExchange({ access_token: 'unused' });

  await assert.rejects(
    () => refreshToken({ authPath: 'ig-login', accessToken: '', nowMs: NOW_MS, exchange }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'validation');
      // An empty token means the profile resolved but IG_ACCESS_TOKEN did not.
      // Naming the parameter is what separates that from "Meta refused us": one
      // is a two-second env-file fix, the other is a full re-login.
      assert.match(e.message, /accessToken/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('a blank-but-present accessToken is refused before anything reaches the wire', async () => {
  // `!accessToken` is false for `'   '`, so the guard that stood here let a
  // present-but-empty credential through and the exchange sent Meta
  // `access_token=%20%20%20`. The operator then got an upstream auth error for
  // what is purely a local problem — a quoted-but-empty `IG_ACCESS_TOKEN=""` in
  // the env file is the ordinary way to arrive at this shape, and it is a
  // one-line fix once you are told which side is at fault.
  const { exchange, calls } = fakeExchange({ access_token: 'IGnew' });

  for (const blank of ['   ', '\t', '\n']) {
    await assert.rejects(
      () => refreshToken({ authPath: 'ig-login', accessToken: blank, nowMs: NOW_MS, exchange }),
      (e: unknown) => {
        assert.ok(e instanceof InstagramError);
        assert.equal(e.kind, 'validation');
        assert.match(e.message, /accessToken/);
        return true;
      },
    );
  }
  // The point of the guard is that the credential never leaves the process.
  assert.equal(calls.length, 0);
});

test('a non-string accessToken is refused rather than crashing on .trim()', async () => {
  // `refreshToken` is exported and its `accessToken` is typed `string`, but the
  // compiler is not the only caller — a JS consumer, or a profile loaded from a
  // hand-edited config, can hand it a number. The blank check has to narrow the
  // type before it trims, or the guard itself becomes the crash site.
  const { exchange, calls } = fakeExchange({ access_token: 'IGnew' });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 12345 as unknown as string,
        nowMs: NOW_MS,
        exchange,
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError, `expected InstagramError, got ${String(e)}`);
      assert.equal(e.kind, 'validation');
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('blank fb-login app credentials are refused instead of being sent as %20', async () => {
  // Same defect on the app-credential guard: `!appId || !appSecret` accepts a
  // blank string, and the fb-login exchange would post `client_secret=%20%20%20`
  // to Meta. The answer to that is an OAuthException, which reads as "your app
  // credentials were rejected" rather than "your app credentials are empty".
  const { exchange, calls } = fakeExchange({ access_token: 'FBnew' });

  for (const partial of [
    { appId: '  ', appSecret: FAKE_APP_SECRET },
    { appId: FAKE_APP_ID, appSecret: '   ' },
  ]) {
    await assert.rejects(
      () =>
        refreshToken({
          authPath: 'fb-login',
          accessToken: FAKE_LONG_LIVED_TOKEN,
          nowMs: NOW_MS,
          exchange,
          ...partial,
        }),
      (e: unknown) => {
        assert.ok(e instanceof InstagramError);
        assert.equal(e.kind, 'validation');
        assert.match(e.message, /appId and appSecret/);
        return true;
      },
    );
  }
  assert.equal(calls.length, 0);
});

test('refreshToken throws upstream when the response lacks an access_token', async () => {
  const { exchange } = fakeExchange({ token_type: 'bearer', expires_in: 100 });

  await assert.rejects(
    () => refreshToken({ authPath: 'ig-login', accessToken: 'IGold', nowMs: NOW_MS, exchange }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'upstream',
  );
});

/**
 * Pin every `refreshToken` refusal by its whole sentence, not by a fragment.
 *
 * `refreshToken` has exactly one caller — the `refresh` subcommand at
 * `src/index.ts` — and a rejection from it leaves through `main().catch`, which
 * prints ONE line (`instagram-mcp-ai failed to start: <message>`) and exits.
 * There is no report around it, no stack, no second line naming the parameter.
 * The wording IS the whole diagnostic the operator gets, so it is behaviour and
 * belongs under a test.
 *
 * The existing refusal tests match fragments (`/accessToken/`, `/appId and
 * appSecret/`, `/saml-login/`) or only the `kind`, which a rewrite can satisfy
 * while dropping the reason: "refreshToken: bad accessToken" passes
 * `/accessToken/`, and the no-token case passes on `kind` alone no matter what
 * it says. Whole-clause equality is what makes a reworded refusal a test
 * failure and a deliberate decision rather than a silent regression.
 */
test('every refreshToken refusal is pinned by its whole sentence', async () => {
  /** Run a refusal and hand back the `InstagramError` it threw. */
  async function refusalFor(params: Parameters<typeof refreshToken>[0]): Promise<InstagramError> {
    try {
      await refreshToken(params);
    } catch (e: unknown) {
      assert.ok(e instanceof InstagramError, 'refusals are typed, never bare Errors');
      return e;
    }
    assert.fail('expected refreshToken to refuse');
  }

  const { exchange, calls } = fakeExchange({ access_token: 'IGnew' });
  const base = { accessToken: FAKE_LONG_LIVED_TOKEN, nowMs: NOW_MS, exchange } as const;

  const blank = await refusalFor({ ...base, authPath: 'ig-login', accessToken: '   ' });
  assert.equal(blank.message, 'refreshToken requires a non-empty accessToken');
  assert.equal(blank.kind, 'validation');

  const noApp = await refusalFor({ ...base, authPath: 'fb-login' });
  assert.equal(
    noApp.message,
    'fb-login token refresh requires both appId and appSecret (the fb_exchange_token grant).',
  );
  assert.equal(noApp.kind, 'validation');

  const unknown = await refusalFor({ ...base, authPath: 'saml-login' as AuthPath });
  assert.equal(unknown.message, 'Unknown auth path for token refresh: saml-login');
  assert.equal(unknown.kind, 'validation');

  // All three above refuse before any transport call; only the fourth gets that
  // far, so the call log doubles as the "nothing left the process" assertion.
  assert.equal(calls.length, 0, 'a refused refresh must not reach the exchange');

  const { exchange: emptyExchange } = fakeExchange({ token_type: 'bearer', expires_in: 100 });
  const noToken = await refusalFor({ ...base, authPath: 'ig-login', exchange: emptyExchange });
  assert.equal(noToken.message, 'Token refresh response did not include a usable access_token.');
  assert.equal(noToken.kind, 'upstream');
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

  // Pinned WHOLE. Reading `method`, `redirect` and `signal` one at a time could
  // not see a field ADDED to the init record: `Object.assign({ method: 'GET' as
  // const, redirect: 'error' as const, signal: … }, { debugX: 'x' })` on this
  // `doFetch` call survived the entire suite (1880 tests, 0 new failures, exit
  // 0). This init is the whole description of an outgoing request that carries a
  // long-lived token in its URL, so "these three options and no fourth" is the
  // claim worth holding — an added `headers`, `body` or `credentials` would
  // change what Meta receives without touching any of the three reads. The
  // signal has no stable identity, so it is pinned by its type.
  assert.ok(seen, 'the injected transport must have been called');
  assert.deepEqual(
    { ...seen, signal: seen.signal instanceof AbortSignal },
    { method: 'GET', redirect: 'error', signal: true },
  );
});

test('the DEFAULT exchange timeout is the documented 30 s, matching IG_TIMEOUT_MS', async () => {
  // `timeoutMs` is injected only by tests — every real refresh takes the default,
  // and the exchange is deliberately NOT retried (module doc), so this constant is
  // the ONLY bound on a hung OAuth endpoint. Stretched, an unreachable
  // `graph.instagram.com` parks the `refresh` CLI (and the `token_status` path
  // behind it) for minutes with no output instead of failing in half a minute. The
  // signal itself exposes nothing about its deadline, so the argument handed to
  // `AbortSignal.timeout` is captured directly. It is pinned against
  // `DEFAULT_SETTINGS.timeoutMs` rather than a literal, because the module doc
  // promises the exchange MIRRORS the Graph seam's per-request budget — a drift
  // between the two is the actual defect.
  const holder = AbortSignal as unknown as { timeout: (ms: number) => AbortSignal };
  const realTimeout = holder.timeout.bind(AbortSignal);
  const seen: number[] = [];
  holder.timeout = (ms: number): AbortSignal => {
    seen.push(ms);
    return realTimeout(ms);
  };
  try {
    const { fetchImpl } = fakeFetch({ access_token: 'IGnew', expires_in: 100 });
    await refreshToken({
      authPath: 'ig-login',
      accessToken: 'IGold',
      nowMs: NOW_MS,
      exchange: createTokenExchange({ fetchImpl }),
    });
  } finally {
    holder.timeout = realTimeout;
  }

  assert.deepEqual(seen, [DEFAULT_SETTINGS.timeoutMs]);
  assert.equal(seen[0], 30_000, 'the shared per-request budget is 30 s');
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
    // The real status travels with the error: kind alone would still read "auth"
    // if the seam mapped every response as HTTP 200, and the operator would lose
    // the one field that says whether Meta refused the call or never saw it.
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'auth');
      assert.equal(e.status, 400);
      // This response carries neither an `x-fb-trace-id` header nor a body id,
      // so the field must stay ABSENT. An empty string is worse than nothing:
      // it prints as a plausible id in the line the operator forwards to Meta
      // support, and it satisfies every `if (fbtraceId)` check downstream.
      assert.equal(e.fbtraceId, undefined);
      return true;
    },
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
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'upstream');
      assert.equal(e.status, 500);
      // With no Graph envelope to read, the message is the status-only fallback —
      // and it must name the status that actually came back.
      assert.equal(e.message, 'Instagram Graph API error (HTTP 500)');
      // The unparseable text is preserved for the log, not discarded: it is the
      // only evidence of what the proxy in front of Meta actually said.
      assert.equal(e.cause, '<html>gateway</html>');
      return true;
    },
  );
});

test('the x-fb-trace-id of a failed exchange reaches the error, the body id winning', async () => {
  // Meta support asks for the trace id of the failing call. The header carries it
  // when the body does not; when both do, the body's is the authoritative one.
  const respondWith = (error: Record<string, unknown>): typeof fetch =>
    function fetchImpl() {
      return Promise.resolve(
        new Response(JSON.stringify({ error }), {
          status: 400,
          headers: { 'content-type': 'application/json', 'x-fb-trace-id': 'TRACE123' },
        }),
      );
    };
  const exchangeWith = (error: Record<string, unknown>) =>
    refreshToken({
      authPath: 'ig-login',
      accessToken: 'IGold',
      nowMs: NOW_MS,
      exchange: createTokenExchange({ fetchImpl: respondWith(error) }),
    });

  await assert.rejects(
    () => exchangeWith({ message: 'boom', code: 190 }),
    (e: unknown) => e instanceof InstagramError && e.fbtraceId === 'TRACE123',
  );
  await assert.rejects(
    () => exchangeWith({ message: 'boom', code: 190, fbtrace_id: 'BODY9' }),
    (e: unknown) => e instanceof InstagramError && e.fbtraceId === 'BODY9',
  );
});

test('the injected timeout bounds the exchange rather than the 30 s default', async () => {
  // `timeoutMs` is the only bound on a hung OAuth endpoint — the exchange has no
  // retry loop to fall back on (module doc). Asserting only that *a* signal was
  // passed cannot tell an honoured timeout from an ignored one, so this drives a
  // transport that answers late and honours the abort.
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(JSON.stringify({ access_token: 'IGnew' }), { status: 200 }));
      }, 200);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted by the exchange timeout'));
      });
    });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl, timeoutMs: 5 }),
      }),
    (e: unknown) =>
      e instanceof InstagramError && /aborted by the exchange timeout/.test(e.message),
  );
});

test('a timeoutMs of 0 is honoured instead of being replaced by the 30 s default', async () => {
  // Zero is a real instruction — "do not wait at all" — and it is the value a
  // falsy-check default silently discards. The composition root feeds this from
  // IG_TIMEOUT_MS, so the defect is an operator who set an aggressive budget,
  // watched `refresh` hang for thirty seconds on a black-holed OAuth endpoint,
  // and concluded the setting does nothing.
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(JSON.stringify({ access_token: 'IGnew' }), { status: 200 }));
      }, 50);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted by the exchange timeout'));
      });
    });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl, timeoutMs: 0 }),
      }),
    (e: unknown) =>
      e instanceof InstagramError && /aborted by the exchange timeout/.test(e.message),
  );
});

test('default transport maps a transport failure to an InstagramError, never a raw TypeError', async () => {
  // A dropped socket rejects out of `fetch`. The domain layer only ever handles
  // InstagramError, so the seam must not leak the platform error type.
  const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.match(e.message, /fetch failed/);
      // A dropped socket is `upstream` — the kind is what tells the operator
      // whether to look at their config or at the network. Classifying it as
      // `validation` sends them auditing IG_APP_ID over a transient outage.
      assert.equal(e.kind, 'upstream');
      // The exchange URL carries the token in its query string. A message built
      // from it would put the secret into every log sink the error reaches, and
      // `stripTokens` would not catch it — that guard only knows the EAA…/IGQ…
      // shapes, not an arbitrary stored token (docs/security.md §2).
      assert.equal(
        /IGold|graph\.instagram\.com|access_token/.test(e.message),
        false,
        `the exchange URL leaked into the message: ${e.message}`,
      );
      return true;
    },
  );
});

test('a failed fb-login exchange never leaks the app secret into the error message', async () => {
  // The fb-login exchange URL carries `client_secret` — the credential that lets
  // anyone mint tokens for the app. It is the single worst string to log.
  const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'fb-login',
        accessToken: FAKE_LONG_LIVED_TOKEN,
        appId: FAKE_APP_ID,
        appSecret: FAKE_APP_SECRET,
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      // Realistically-shaped fixtures on purpose (see their declaration): with a
      // six-character `'s3cr3t'` and an `EAA…` token this assertion held for
      // reasons that had nothing to do with this module — the redactor's length
      // floor and `errors.ts`'s shape dictionary respectively.
      assert.equal(
        e.message.includes(FAKE_APP_SECRET),
        false,
        'the app secret reached the message',
      );
      assert.equal(
        e.message.includes(FAKE_LONG_LIVED_TOKEN),
        false,
        'the token reached the message',
      );
      assert.equal(
        /graph\.facebook\.com|client_secret|fb_exchange_token/.test(e.message),
        false,
        `the exchange URL leaked into the message: ${e.message}`,
      );
      return true;
    },
  );
});

test('a Graph error echoing the client_secret back is masked before it is surfaced', async () => {
  // The highest-severity path in this module, and the one the previous leak test
  // above could not see: it only ever exercised a transport that says "fetch
  // failed". Meta quotes the offending parameter back in `error.message` on a
  // rejected exchange, and `mapGraphError` promotes exactly that field to the
  // operator-facing `message` — which `src/index.ts` writes to stderr verbatim on
  // the `refresh` command, with no redactor in that path.
  //
  // `errors.ts` strips the three shapes it knows (`EAA…`, `IG…`, and the 64-hex
  // `appsecret_proof`). A Meta app secret is 32 hex characters and matches none
  // of them, so before this module registered the values it had just put on the
  // wire, the app secret — the credential that lets anyone mint tokens for the
  // app — arrived in an operator-visible string intact.
  const body = {
    error: {
      message: `Invalid parameter client_secret=${FAKE_APP_SECRET} for grant_type=fb_exchange_token`,
      type: 'OAuthException',
      code: 100,
    },
  };
  const { fetchImpl } = fakeFetch(body, { status: 400 });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'fb-login',
        accessToken: FAKE_LONG_LIVED_TOKEN,
        appId: FAKE_APP_ID,
        appSecret: FAKE_APP_SECRET,
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(
        e.message.includes(FAKE_APP_SECRET),
        false,
        `the app secret reached the message: ${e.message}`,
      );
      assert.match(e.message, /\[REDACTED\]/);
      // Redacted, not blanked. The operator still learns WHICH parameter Meta
      // rejected and under which grant, which is the whole diagnosis; masking the
      // entire message would be safe and useless.
      assert.match(e.message, /client_secret/);
      assert.match(e.message, /fb_exchange_token/);
      // Classification survives the rebuild: masking must not cost the kind,
      // status or code the caller branches on.
      assert.equal(e.kind, 'validation');
      assert.equal(e.status, 400);
      assert.equal(e.code, 100);
      // `cause` deliberately keeps Meta's raw body. It is not operator-visible —
      // every sink that reaches a client (mcp/registry.ts, the logger, the write
      // journal) runs the redactor over it — and it is the only evidence left of
      // what Meta actually said.
      assert.deepEqual(e.cause, body);
      return true;
    },
  );
});

test('masking a Graph error preserves the subcode and trace id it was carrying', async () => {
  // The masking path above does not edit the error in place — a redacted message
  // forces a whole new `InstagramError`, so every field of the original has to be
  // copied across by hand. Two of them are the ones an operator actually acts on
  // after a rejected exchange: `error_subcode`, which is what distinguishes a
  // spam restriction from a quota from an expired container (docs/operations.md
  // §3), and the trace id Meta support asks for first. Losing either is silent —
  // the message still reads correctly, the kind is still right — and it only
  // costs the operator on the day the exchange fails, which is the day the
  // credential that needs masking is on the wire.
  //
  // The trace id here arrives in the HEADER and not in the body, deliberately:
  // that is the case where dropping the field destroys the value outright, since
  // `cause` (the raw body) has no copy of it to recover.
  const body = {
    error: {
      message: `The client_secret ${FAKE_APP_SECRET} is not valid for this app`,
      type: 'OAuthException',
      code: 100,
      error_subcode: 33,
    },
  };
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 400,
        headers: { 'content-type': 'application/json', 'x-fb-trace-id': 'TRACEsub33' },
      }),
    );

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'fb-login',
        accessToken: FAKE_LONG_LIVED_TOKEN,
        appId: FAKE_APP_ID,
        appSecret: FAKE_APP_SECRET,
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      // The rebuild really did happen — without it the assertions below would
      // pass on the untouched original and prove nothing about the copy.
      assert.equal(e.message.includes(FAKE_APP_SECRET), false);
      assert.match(e.message, /\[REDACTED\]/);
      // The two fields the rebuild has to carry over.
      assert.equal(e.subcode, 33);
      assert.equal(e.fbtraceId, 'TRACEsub33');
      return true;
    },
  );
});

test('a Graph error echoing the refresh token back is masked before it is surfaced', async () => {
  // The ig-login half of the same defect, with a token that is deliberately not
  // `EAA…`/`IG…`-shaped so the shape dictionary in `errors.ts` cannot mask it for
  // us. A stored long-lived token is an arbitrary string as far as this process
  // is concerned; only the value we just sent identifies it as a secret.
  const body = {
    error: {
      message: `Error validating access token: ${FAKE_LONG_LIVED_TOKEN} has expired`,
      type: 'OAuthException',
      code: 190,
    },
  };
  const { fetchImpl } = fakeFetch(body, { status: 401 });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: FAKE_LONG_LIVED_TOKEN,
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(
        e.message.includes(FAKE_LONG_LIVED_TOKEN),
        false,
        `the token reached the message: ${e.message}`,
      );
      assert.match(e.message, /Error validating access token: \[REDACTED\] has expired/);
      assert.equal(e.kind, 'auth');
      return true;
    },
  );
});

test('a transport error naming the request URL cannot carry the query out', async () => {
  // The module header asserted "the URL is never logged or surfaced". Nothing
  // enforced it. `undici` happens to reject with a bare "fetch failed", but a
  // proxy agent, a stubbed transport or a future runtime is free to name the
  // request — and that message went straight through `toInstagramError`. One
  // substituted `fetch` away from the app secret AND both tokens in one string,
  // on the exact code path an operator runs when something is already wrong.
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new TypeError(`request to ${url} failed, reason: ECONNRESET`));
  };

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'fb-login',
        accessToken: FAKE_LONG_LIVED_TOKEN,
        appId: FAKE_APP_ID,
        appSecret: FAKE_APP_SECRET,
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(
        e.message.includes(FAKE_APP_SECRET),
        false,
        `the app secret reached the message: ${e.message}`,
      );
      assert.equal(
        e.message.includes(FAKE_LONG_LIVED_TOKEN),
        false,
        `the token reached the message: ${e.message}`,
      );
      // What stays readable is as deliberate as what does not. The host, the
      // grant and the app id are not secrets — an app id is public — and they are
      // the first three things an operator needs to tell a misconfigured app from
      // a network fault. Masking by whole-URL would destroy that.
      assert.match(e.message, /graph\.facebook\.com/);
      assert.match(e.message, /ECONNRESET/);
      assert.ok(e.message.includes(FAKE_APP_ID), `the app id was masked too: ${e.message}`);
      return true;
    },
  );
});

test('a credential is masked in BOTH the spelling it has and the spelling the URL has', async () => {
  // `createRedactor` masks exact substrings — a registered secret gets no shape
  // matching, by design. `buildUrl` serialises the query with `URLSearchParams`,
  // so the credential in the URL is form-encoded: `+`→`%2B`, `/`→`%2F`,
  // `=`→`%3D`, ` `→`+`. Registering only the raw value therefore covered the
  // wrong half of the problem for any credential that is not already URL-safe:
  // the module's own guarantee ("no credential value in the query reaches an
  // operator-visible message") held for a hex app secret and an `EAA…`
  // token, and silently did not hold for an arbitrary stored token — which is
  // all this module is ever promised. Every other leak test here uses URL-safe
  // fixtures, so all of them passed either way.
  //
  // Both spellings are exercised because a fix that registers only the encoded
  // form is just the mirror defect: Meta quotes the DECODED parameter back in
  // `error.message`, which is the higher-severity path of the two.
  const onWireSecret = asWritten(FAKE_UNSAFE_APP_SECRET);
  const onWireToken = asWritten(FAKE_UNSAFE_TOKEN);
  assert.notEqual(onWireSecret, FAKE_UNSAFE_APP_SECRET, 'the fixture must exercise encoding');
  assert.notEqual(onWireToken, FAKE_UNSAFE_TOKEN, 'the fixture must exercise encoding');

  const refreshWith = (fetchImpl: typeof fetch) =>
    refreshToken({
      authPath: 'fb-login',
      accessToken: FAKE_UNSAFE_TOKEN,
      appId: FAKE_APP_ID,
      appSecret: FAKE_UNSAFE_APP_SECRET,
      nowMs: NOW_MS,
      exchange: createTokenExchange({ fetchImpl }),
    });

  // (a) A transport that names the failing request. The credentials appear in
  // its message ONLY in their encoded spelling.
  let requested = '';
  const namesTheUrl: typeof fetch = (input) => {
    requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.reject(new TypeError(`request to ${requested} failed, reason: ECONNRESET`));
  };

  await assert.rejects(
    () => refreshWith(namesTheUrl),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      // The fixture only proves something if `buildUrl` really did encode.
      assert.ok(requested.includes(onWireSecret), 'the encoded secret was never on the wire');
      assert.ok(requested.includes(onWireToken), 'the encoded token was never on the wire');
      assert.equal(
        e.message.includes(onWireSecret),
        false,
        `the encoded app secret reached the message: ${e.message}`,
      );
      assert.equal(
        e.message.includes(onWireToken),
        false,
        `the encoded token reached the message: ${e.message}`,
      );
      // Exactly the value is masked, and not one byte more: the `=` that
      // separates the parameter name from it is not part of the credential. A
      // registration that swallows the separator still hides the secret in THIS
      // string — the URL always writes a `=` in front of it — while quietly
      // covering nothing in scenario (b), where Meta quotes the value back with
      // no separator attached.
      assert.ok(
        e.message.includes('client_secret=[REDACTED]'),
        `the app secret was not masked as a bare value: ${e.message}`,
      );
      // Still diagnosable: host, grant and the public app id survive.
      assert.match(e.message, /graph\.facebook\.com/);
      assert.match(e.message, /ECONNRESET/);
      assert.ok(e.message.includes(FAKE_APP_ID), `the app id was masked too: ${e.message}`);
      return true;
    },
  );

  // (b) Meta rejecting the exchange and quoting the parameter back DECODED —
  // `mapGraphError` promotes that text to the operator-facing message, and
  // `src/index.ts` writes it to stderr verbatim on the `refresh` command.
  const { fetchImpl: quotesItBack } = fakeFetch(
    {
      error: {
        message: `Invalid parameter client_secret=${FAKE_UNSAFE_APP_SECRET} for grant_type=fb_exchange_token`,
        type: 'OAuthException',
        code: 100,
      },
    },
    { status: 400 },
  );

  await assert.rejects(
    () => refreshWith(quotesItBack),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(
        e.message.includes(FAKE_UNSAFE_APP_SECRET),
        false,
        `the raw app secret reached the message: ${e.message}`,
      );
      assert.match(e.message, /\[REDACTED\]/);
      // Masked, not blanked — the parameter name and the grant are the diagnosis.
      assert.match(e.message, /client_secret/);
      assert.match(e.message, /fb_exchange_token/);
      return true;
    },
  );
});

test('a parameter this grant does not send registers nothing at all', async () => {
  // `SECRET_PARAM_KEYS` is the union over both grants, so an ig-login query —
  // which carries `access_token` and nothing else — reads `client_secret` and
  // `fb_exchange_token` back as `undefined`. Those absences must be dropped
  // before registration, not registered: `String(undefined)` is nine characters,
  // past the redactor's eight-character floor, so registering it would mask the
  // literal word `undefined` wherever it appears — and "undefined" is the single
  // commonest word in the upstream diagnostics this message is built from.
  const namesTheDefect: typeof fetch = () =>
    Promise.reject(new TypeError('socket hang up after expires_in came back undefined'));

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: FAKE_LONG_LIVED_TOKEN,
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl: namesTheDefect }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.match(e.message, /expires_in came back undefined/);
      assert.equal(
        e.message.includes('[REDACTED]'),
        false,
        `a non-secret was masked out of the diagnosis: ${e.message}`,
      );
      return true;
    },
  );
});

test('an error with nothing to mask is surfaced untouched rather than rebuilt', async () => {
  // The redaction boundary rebuilds the error only when masking actually changed
  // the message. Rebuilding unconditionally reads as harmless — every field is
  // copied across — but the copy is a new `Error` constructed inside this module,
  // so its `stack` starts at the redaction helper instead of at the line that
  // failed, and the one artefact an operator uses to locate a transport fault is
  // replaced by a trace through the masking code. Identity is the cheapest way to
  // pin "not rebuilt"; nothing else distinguishes the two.
  const sentinel = new InstagramError('the upstream refused the connection', {
    kind: 'upstream',
    status: 503,
  });
  const fetchImpl: typeof fetch = () => Promise.reject(sentinel);

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: FAKE_LONG_LIVED_TOKEN,
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.equal(e, sentinel, 'a message with nothing to mask must not be rebuilt');
      return true;
    },
  );
});

test('a blank x-fb-trace-id header leaves the field absent, not empty', async () => {
  // `mapGraphError` runs its non-empty filter over the trace id in the BODY only;
  // the header argument is adopted verbatim. So a present-but-empty header — what
  // a proxy or load balancer in front of Meta emits — produced `fbtraceId: ''`:
  // an id-shaped field with no id in it. It prints as a plausible reference in
  // the line the operator forwards to Meta support, and it passes every
  // `fbtraceId !== undefined` check between here and the sink. "Absent" is the
  // answer this module already gives for a missing header, and it is the true one.
  for (const blank of ['', '   ']) {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'boom', code: 190 } }), {
          status: 400,
          headers: { 'content-type': 'application/json', 'x-fb-trace-id': blank },
        }),
      );

    await assert.rejects(
      () =>
        refreshToken({
          authPath: 'ig-login',
          accessToken: 'IGold',
          nowMs: NOW_MS,
          exchange: createTokenExchange({ fetchImpl }),
        }),
      (e: unknown) => {
        assert.ok(e instanceof InstagramError);
        assert.equal(e.fbtraceId, undefined, `a header of ${JSON.stringify(blank)} became an id`);
        // The rest of the classification is untouched by the trace-id decision.
        assert.equal(e.status, 400);
        assert.equal(e.kind, 'auth');
        return true;
      },
    );
  }
});

test('default transport maps a body-read failure to an InstagramError', async () => {
  // The status line can arrive and the body still die mid-stream (a proxy
  // dropping the connection); `res.text()` rejects after `fetch` resolved.
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('stream aborted mid-body'));
          },
        }),
        { status: 200 },
      ),
    );

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      // Same reasoning as the transport failure above: a body that dies in
      // flight is an upstream fault, not a bad parameter. `refresh` is the
      // command an operator runs when nothing else works — misfiling this as
      // `validation` has them rewriting a credential file that is fine.
      assert.equal(e.kind, 'upstream');
      return true;
    },
  );
});

/** The response-body cap `core/body.ts` enforces, restated rather than imported. */
const BODY_CAP = 16 * 1024 * 1024;

/**
 * A `fetch` double serving a VALID token reply padded to exactly `total` bytes,
 * one 1 MiB chunk per pull, recording whether the reader let go of the stream.
 * Valid on purpose: an uncapped reader parses it and hands the token back, so
 * the only thing that can refuse it is the size.
 */
function paddedTokenFetch(
  total: number,
  token: string,
  status = 200,
): { fetchImpl: typeof fetch; probe: { cancelled: boolean } } {
  const probe = { cancelled: false };
  const head = new TextEncoder().encode(`{"access_token":"${token}","pad":"`);
  const tail = new TextEncoder().encode('"}');
  const fetchImpl: typeof fetch = async () => {
    let left = total - head.byteLength - tail.byteLength;
    let sentHead = false;
    let sentTail = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!sentHead) {
            sentHead = true;
            controller.enqueue(head);
          } else if (left > 0) {
            const n = Math.min(1024 * 1024, left);
            left -= n;
            controller.enqueue(new Uint8Array(n).fill(0x61));
          } else if (!sentTail) {
            sentTail = true;
            controller.enqueue(tail);
          } else {
            controller.close();
          }
        },
        cancel() {
          probe.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, probe };
}

test('an oversized exchange reply is refused at the cap, upstream, quoting none of it (CC-PROC-203)', async () => {
  // `createTokenExchange` read the reply with `res.text()`, the one reader of a
  // Meta body the Graph seam's cap did not reach: a body one byte over 16 MiB
  // was buffered whole and its token handed back as a successful refresh. The
  // token sits in the FIRST chunk, so a refusal that quoted what it had read
  // would carry it out; the message must name the cap and nothing else.
  const token = 'TEST_TOKEN_OVERSIZE_REFRESH_0001';
  const { fetchImpl, probe } = paddedTokenFetch(BODY_CAP + 1, token);
  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'upstream');
      assert.equal(e.status, 200);
      assert.equal(
        e.message,
        'Token exchange response body is larger than the 16 MiB this server buffers ' +
          `(more than ${BODY_CAP} bytes received); it was discarded unread. A token reply is ` +
          'a few hundred bytes, so check what any proxy between this server and Meta is returning.',
      );
      assert.equal(e.cause, undefined, 'no part of the body rides along on cause');
      return true;
    },
  );
  assert.equal(probe.cancelled, true, 'the reader lets go of the stream at the cap');
});

test('an oversized exchange reply keeps its error status and is not read as a Graph verdict (CC-PROC-203)', async () => {
  // A 400 is where `mapGraphError` would read Meta's verdict out of the body and
  // may answer `auth`. A body too large to read carries no verdict, so the
  // refusal stays `upstream` and only the status survives. Declared up front,
  // it is refused before a byte is pulled.
  const { fetchImpl: inner, probe } = paddedTokenFetch(BODY_CAP + 1, 'TEST_TOKEN_UNUSED_0002', 400);
  const fetchImpl: typeof fetch = async (input, init) => {
    const res = await inner(input, init);
    return new Response(res.body, {
      status: 400,
      headers: { 'content-length': String(BODY_CAP + 1) },
    });
  };
  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'upstream');
      assert.equal(e.status, 400);
      assert.match(e.message, new RegExp(`\\(Content-Length ${BODY_CAP + 1}\\)`));
      return true;
    },
  );
  assert.equal(probe.cancelled, true);
});

test('an exchange reply of exactly the cap is still read (CC-PROC-203)', async () => {
  // The other side of the boundary: the cap refuses what is OVER it, and a reply
  // that lands on it is a (strange but) valid refresh.
  const token = 'TEST_TOKEN_AT_CAP_REFRESH_0003';
  const { fetchImpl, probe } = paddedTokenFetch(BODY_CAP, token);
  const out = await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
    exchange: createTokenExchange({ fetchImpl }),
  });
  assert.deepEqual(out, { accessToken: token, expiresAtSec: undefined });
  assert.equal(probe.cancelled, false);
});

test('an empty 200 body is rejected upstream rather than persisted as an empty token', async () => {
  // `parseBody('')` yields `{}`; without the access_token guard the caller would
  // store an empty string and the failure would resurface as "expired token".
  const { fetchImpl } = fakeFetch(null, { status: 200, text: '' });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'upstream');
      // An empty body normalises to `{}`, not to the raw `''`. The distinction is
      // what keeps every downstream reader (`cause` logging, the `wire` guard)
      // working on an object shape instead of a string that happens to have no
      // `access_token` property.
      assert.deepEqual(e.cause, {});
      return true;
    },
  );
});

test('a whitespace-only body is surfaced verbatim, not normalised to an empty object', async () => {
  // The exact bytes are the only evidence of WHO answered. An empty 200 is Meta
  // saying nothing; a body of blanks is something in between (a proxy, a captive
  // portal, a load balancer health page) answering instead of Meta. `cause` is
  // all the operator gets in the log, so normalising the two together erases the
  // difference between "retry the refresh" and "you are not talking to Meta".
  const { fetchImpl } = fakeFetch(null, { status: 200, text: '   ' });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'upstream');
      assert.equal(e.cause, '   ');
      return true;
    },
  );
});

test('an empty-string access_token in the response is refused rather than stored', async () => {
  // A falsy-but-present token is the shape a truncated upstream reply takes. Only
  // testing for `undefined` would persist `''` and turn the next tool call into a
  // confusing "invalid credentials" instead of a refresh failure here.
  const { exchange } = fakeExchange({ access_token: '', expires_in: 100 });

  await assert.rejects(
    () => refreshToken({ authPath: 'ig-login', accessToken: 'IGold', nowMs: NOW_MS, exchange }),
    (e: unknown) => e instanceof InstagramError && e.kind === 'upstream',
  );
});

test('a 200 whose body is JSON null is refused with a typed error, not a TypeError', async () => {
  // `exchange<TokenExchangeWire>` is a CAST. The generic states what we hope
  // arrived, and `null` is a perfectly valid JSON document, so reading
  // `wire.access_token` off it threw a raw `TypeError: Cannot read properties of
  // null` — breaking this function's own documented `@throws` contract at the one
  // moment the operator most needs a diagnosable error, and handing the CLI a
  // stack trace where it expected a message.
  const { fetchImpl } = fakeFetch(null, { status: 200, text: 'null' });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-login',
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError, `expected InstagramError, got ${String(e)}`);
      assert.equal(e.kind, 'upstream');
      // `null` is preserved on `cause` exactly as the whitespace body above is:
      // "Meta sent literal null" and "Meta sent nothing" are different incidents.
      assert.equal(e.cause, null);
      return true;
    },
  );
});

test('a non-string access_token is refused rather than returned typed as a string', async () => {
  // `!wire.access_token` is a truthiness test, so every truthy non-string passed
  // it and came back out as `RefreshResult.accessToken` — declared `string`,
  // holding a number, a boolean, an object or an array. Nothing downstream
  // re-checks: `writeCredentials` calls `.trim()` on it and dies with a raw
  // TypeError, or (for a blank string) refuses it with "an access token is
  // required", which blames the operator's local config for Meta's reply.
  //
  // The rule is refuse, never repair. Coercing or trimming a malformed token here
  // would write a value Meta never issued into the credential file, and the
  // failure would resurface one process later as an unexplained auth error.
  const cases: readonly [string, unknown][] = [
    ['a number', 12345],
    ['a boolean', true],
    ['an object', { access_token: 'IGnew' }],
    ['an array', ['IGnew']],
    ['a whitespace-only string', '   '],
  ];

  for (const [label, access_token] of cases) {
    const { exchange } = fakeExchange({ access_token, expires_in: 100 });
    await assert.rejects(
      () => refreshToken({ authPath: 'ig-login', accessToken: 'IGold', nowMs: NOW_MS, exchange }),
      (e: unknown) => {
        assert.ok(e instanceof InstagramError, `${label}: expected InstagramError`);
        assert.equal(e.kind, 'upstream', label);
        // The raw reply survives on `cause` so the operator can see what arrived.
        assert.deepEqual((e.cause as { access_token: unknown }).access_token, access_token, label);
        return true;
      },
    );
  }
});

test('a padded credential is forwarded and minted byte for byte, never repaired', async () => {
  // "Refuse, never repair" is stated three times in this module — above, at the
  // token guard in `core/refresh.ts`, and again for the sibling rule in
  // `core/auth.ts` — and until now nothing here enforced it. `isNonBlank` trims
  // only to DECIDE; the value itself must travel verbatim. Measured: inserting
  // `.trim()` on the ig `access_token`, on `client_secret`, on
  // `fb_exchange_token` or on the minted token each survived the whole 1978-test
  // suite, because every credential fixture in this file is already trimmed and
  // the only whitespace cases are blank (CC-PROC-188).
  //
  // What each survivor would have cost: a repaired `client_secret` signs the
  // exchange with a secret the operator never configured; a repaired token is one
  // Meta never issued, and Graph answers "invalid access token", which sends the
  // operator to re-run `login` instead of to the character that was eaten here; a
  // repaired MINTED token is persisted by `writeCredentials` under one spelling
  // while `registerSecret` was handed another, so the stored credential is no
  // longer the value the redactor masks.
  const ig = fakeExchange({ access_token: PADDED_NEW_TOKEN, expires_in: 100 });
  const igResult = await refreshToken({
    authPath: 'ig-login',
    accessToken: PADDED_OLD_TOKEN,
    nowMs: NOW_MS,
    exchange: ig.exchange,
  });
  assert.equal(ig.calls[0]?.params.access_token, PADDED_OLD_TOKEN);
  assert.equal(igResult.accessToken, PADDED_NEW_TOKEN);

  const fb = fakeExchange({ access_token: PADDED_NEW_TOKEN, expires_in: 100 });
  const fbResult = await refreshToken({
    authPath: 'fb-login',
    accessToken: PADDED_OLD_TOKEN,
    appId: FAKE_APP_ID,
    appSecret: PADDED_APP_SECRET,
    nowMs: NOW_MS,
    exchange: fb.exchange,
  });
  assert.equal(fb.calls[0]?.params.fb_exchange_token, PADDED_OLD_TOKEN);
  assert.equal(fb.calls[0]?.params.client_secret, PADDED_APP_SECRET);
  assert.equal(fbResult.accessToken, PADDED_NEW_TOKEN);

  // Named explicitly, so a repair that happens to be idempotent on the padding
  // still dies: the trimmed spelling is a DIFFERENT credential, not a tidier one.
  assert.notEqual(fbResult.accessToken, PADDED_NEW_TOKEN.trim());
  assert.notEqual(fb.calls[0]?.params.client_secret, FAKE_APP_SECRET);
});

test('a 200 that is not an object at all is refused, not read through', async () => {
  // `parseBody` yields the raw text when the body is not JSON, so a captive
  // portal or a proxy error page arrives here as a string. Reading a property off
  // a string does not throw — it yields `undefined` — but the narrowing that
  // stops `null` has to let this case reach the same upstream error rather than
  // silently taking a different route to it.
  const { exchange } = fakeExchange('<html>502 Bad Gateway</html>');

  await assert.rejects(
    () => refreshToken({ authPath: 'ig-login', accessToken: 'IGold', nowMs: NOW_MS, exchange }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'upstream');
      assert.equal(e.cause, '<html>502 Bad Gateway</html>');
      return true;
    },
  );
});

test('a transport that resolves with nothing is refused, not dereferenced', async () => {
  // The `typeof wire === 'object'` half of that narrowing is not decoration for
  // the `wire !== null` half. `typeof undefined` is `'undefined'`, so `undefined`
  // is the one value the two halves disagree about — the note above this line
  // used to enumerate "a string, a number or a boolean" and stop there, and all
  // three of those really are read through harmlessly. It cannot arrive from the
  // DEFAULT transport (`parseBody` answers `{}` for an empty body and `JSON.parse`
  // never yields `undefined`), but `exchange` is an injected seam: a fake, or an
  // embedder's transport that simply falls off the end, resolves with `undefined`.
  // With only the null check, `body.access_token` throws a raw `TypeError: Cannot
  // read properties of undefined` — precisely the failure the narrowing exists to
  // prevent, one value over.
  const { exchange } = fakeExchange(undefined);

  await assert.rejects(
    () => refreshToken({ authPath: 'ig-login', accessToken: 'IGold', nowMs: NOW_MS, exchange }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError, `expected InstagramError, got ${String(e)}`);
      assert.equal(e.kind, 'upstream');
      assert.equal(e.message, 'Token refresh response did not include a usable access_token.');
      assert.equal(e.cause, undefined, 'nothing arrived, and that is what the cause says');
      return true;
    },
  );
});

test('an expires_in that cannot be represented yields no expiry, not Infinity', async () => {
  // `1e999` is valid JSON and `JSON.parse` turns it into `Infinity`. That used to
  // become `expiresAtSec: Infinity`, which `writeCredentials` persists as the
  // string "Infinity" and the `refresh` CLI then feeds to
  // `new Date(expiresAtSec * 1000).toISOString()` — a `RangeError: Invalid time
  // value` thrown AFTER the credential file has already been rewritten. The
  // operator is left with a stack trace and a file they cannot tell the state of.
  const { fetchImpl } = fakeFetch(null, {
    status: 200,
    text: '{"access_token":"IGnew","expires_in":1e999}',
  });

  const res = await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
    exchange: createTokenExchange({ fetchImpl }),
  });

  // The token is still returned — the refresh itself succeeded. Only the expiry
  // is unknown, which is the same answer Meta's omitting the field produces.
  assert.equal(res.accessToken, 'IGnew');
  assert.equal(res.expiresAtSec, undefined);
});

test('a finite but absurd expires_in yields no expiry rather than a doomed timestamp', async () => {
  // `1e21` is finite, survives every arithmetic guard, and is still nonsense as a
  // unix second: `new Date(1e21 * 1000)` is outside the representable range, so
  // it fails in exactly the same place `Infinity` does. `summarizeTokenExpiry`
  // already bounds itself by `MAX_TIMESTAMP_MS`; this module now refuses to
  // produce a value that bound would reject.
  for (const expires_in of [1e21, -1e21]) {
    const { exchange } = fakeExchange({ access_token: 'IGnew', expires_in });
    const res = await refreshToken({
      authPath: 'ig-login',
      accessToken: 'IGold',
      nowMs: NOW_MS,
      exchange,
    });
    assert.equal(res.accessToken, 'IGnew');
    assert.equal(res.expiresAtSec, undefined, `expires_in ${expires_in}`);
  }
});

test('the latest recordable expiry is kept, not thrown away with the absurd ones', async () => {
  // The other side of the bound: a guard that rejects too much is a guard that
  // silently drops real expiry metadata, and "unknown expiry" silences the
  // `expiring_soon` warning forever. The ceiling is the last second of year 9999, and the
  // second exactly on it must survive and must still format (CC-AUTH-66).
  const { exchange } = fakeExchange({
    access_token: 'IGnew',
    expires_in: MAX_RECORDED_EXPIRY_SEC - Math.floor(NOW_MS / 1000),
  });

  const res = await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
    exchange,
  });

  assert.equal(res.expiresAtSec, MAX_RECORDED_EXPIRY_SEC);
  assert.equal(new Date(MAX_RECORDED_EXPIRY_SEC * 1000).toISOString(), '9999-12-31T23:59:59.000Z');
});

test('one second past the recordable ceiling is refused, not handed back', async () => {
  // The other edge of the same constant. Without a case exactly ONE second
  // outside it, the ceiling could drift upward by any amount short of the absurd
  // `1e21` above and every assertion in this file would still hold, while the
  // module quietly resumed handing back an instant the config reader then
  // refuses to read back (CC-AUTH-65).
  const { exchange } = fakeExchange({
    access_token: 'IGnew',
    expires_in: MAX_RECORDED_EXPIRY_SEC + 1 - Math.floor(NOW_MS / 1000),
  });

  const res = await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
    exchange,
  });

  assert.equal(res.accessToken, 'IGnew', 'the refresh itself still succeeded');
  assert.equal(res.expiresAtSec, undefined);
});

test('a lifetime that lands at or before the epoch yields no expiry, never "never"', async () => {
  // A negative `expires_in` large enough to cross the epoch sums to zero or
  // below. Zero is the "never expires" sentinel, so recording it would turn a
  // dead token into an immortal one; a negative record is one the reader drops.
  // Both are refused here, the same as login (CC-AUTH-65).
  const nowSec = Math.floor(NOW_MS / 1000);
  for (const expires_in of [-nowSec, -nowSec - 1]) {
    const { exchange } = fakeExchange({ access_token: 'IGnew', expires_in });
    const res = await refreshToken({
      authPath: 'ig-login',
      accessToken: 'IGold',
      nowMs: NOW_MS,
      exchange,
    });
    assert.equal(res.expiresAtSec, undefined, `expires_in ${expires_in}`);
  }
});

test('a fractional expires_in is floored to whole unix seconds', async () => {
  // `RefreshResult.expiresAtSec` promises a `debug_token`-compatible integer, and
  // Meta has shipped decimal values on this field. Flooring only `nowMs / 1000`
  // and then adding left the fraction in the result, which is a timestamp no
  // Graph response ever carries and which reads oddly in every log line built
  // from it.
  const { exchange } = fakeExchange({ access_token: 'IGnew', expires_in: 100.7 });

  const res = await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
    exchange,
  });

  assert.equal(res.expiresAtSec, Math.floor(NOW_MS / 1000) + 100);
  assert.equal(Number.isInteger(res.expiresAtSec), true);
});

test('a quoted expires_in is summed as a number when canonical and refused otherwise (CC-AUTH-69)', async () => {
  // Meta has shipped `expires_in` as a decimal string on some endpoints. Adding a
  // string to the epoch seconds would concatenate instead of summing; dropping it
  // left a freshly refreshed token with no recorded expiry, so no `expiring_soon`
  // warning would ever fire for it. A canonical non-negative integer string is
  // read as the number it spells, through the same `expiryFromLifetime` `login`
  // uses (CC-AUTH-64).
  const refreshWith = async (expires_in: unknown, nowMs: number) => {
    const { exchange } = fakeExchange({ access_token: 'IGnew', expires_in });
    return refreshToken({ authPath: 'ig-login', accessToken: 'IGold', nowMs, exchange });
  };

  const res = await refreshWith('5184000', NOW_MS);
  assert.equal(res.accessToken, 'IGnew');
  // Summed, not concatenated: `1700000000 + '5184000'` would be seventeen digits.
  assert.equal(res.expiresAtSec, Math.floor(NOW_MS / 1000) + 5_184_000);
  // At the epoch a concatenation (`'0' + '5184000'`) and the sum agree, so this
  // clock alone could not tell them apart; the one above does.
  assert.equal((await refreshWith('5184000', 0)).expiresAtSec, 5_184_000);
  assert.equal((await refreshWith('0', NOW_MS)).expiresAtSec, 0, '"0" is never-expires, like 0');

  // Every other spelling stays unknown rather than guessed at.
  for (const quoted of ['-60', '+60', '60.0', '6e1', ' 60', '060', '', 'soon']) {
    const r = await refreshWith(quoted, 0);
    assert.equal(r.accessToken, 'IGnew');
    assert.equal(r.expiresAtSec, undefined, JSON.stringify(quoted));
  }
});

test('two refreshes in flight at once cannot contaminate each other', async () => {
  // The honest answer to "what does this module do when it is called
  // concurrently with itself?" is "two independent exchanges" — it holds no
  // module-level state: no in-flight map, no cached token, no shared redactor
  // registration. That is a property worth pinning rather than assuming, because
  // the obvious future addition here is a single-flight cache, and a single
  // flight keyed on anything less than the full parameter set hands profile B the
  // token minted for profile A — the one failure in this module that swaps one
  // operator's credential for another's. The ig-login call is held open until the
  // fb-login call has been dispatched, so the two genuinely overlap rather than
  // running back to back.
  const dispatched: TokenExchangeRequest[] = [];
  let openIg = (): void => undefined;
  const igGate = new Promise<void>((resolve) => {
    openIg = resolve;
  });

  const exchange: TokenExchangeFn = async <T>(req: TokenExchangeRequest): Promise<T> => {
    dispatched.push(req);
    if (req.host === 'graph.instagram.com') {
      await igGate;
      return { access_token: 'IGnew', expires_in: 100 } as T;
    }
    openIg();
    return { access_token: 'FBnew', expires_in: 200 } as T;
  };

  const [ig, fb] = await Promise.all([
    refreshToken({ authPath: 'ig-login', accessToken: 'IGold', nowMs: NOW_MS, exchange }),
    refreshToken({
      authPath: 'fb-login',
      accessToken: FAKE_LONG_LIVED_TOKEN,
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
      nowMs: NOW_MS + 5_000,
      exchange,
    }),
  ]);

  assert.equal(dispatched.length, 2, 'both exchanges must be dispatched, neither deduplicated');
  assert.equal(ig.accessToken, 'IGnew');
  assert.equal(fb.accessToken, 'FBnew');
  // Each result carries the clock and the lifetime of ITS OWN call.
  assert.equal(ig.expiresAtSec, Math.floor(NOW_MS / 1000) + 100);
  assert.equal(fb.expiresAtSec, Math.floor((NOW_MS + 5_000) / 1000) + 200);
});

test('an expires_in of 0 records "never expires", the same as login', async () => {
  // Zero is the debug_token convention for a token with no expiry, and it is
  // the one numeric value a truthiness check drops. Refresh used to record it
  // as "now" (expired) while login recorded it as 0 (never), so the same
  // exchange answer gave two verdicts depending on which command wrote it. A
  // successful exchange does not mint a dead token, and a later 190 remains the
  // authority on revocation (CC-AUTH-64).
  const { exchange } = fakeExchange({ access_token: 'IGnew', expires_in: 0 });

  const res = await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
    exchange,
  });

  assert.equal(res.expiresAtSec, 0);
  assert.equal(
    summarizeTokenExpiry({
      expiresAtSec: res.expiresAtSec,
      nowMs: NOW_MS,
      refreshAfterDays: DEFAULT_SETTINGS.refreshAfterDays,
    }).state,
    'never',
  );
});

test('refreshToken rejects an unknown auth path instead of guessing a host', async () => {
  // `authPath` reaches here from persisted config, which a hand-edit can widen
  // past the union. Guessing would send the app secret to the wrong host.
  const { exchange, calls } = fakeExchange({ access_token: 'X' });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'saml-login' as AuthPath,
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange,
      }),
    (e: unknown) =>
      e instanceof InstagramError && e.kind === 'validation' && /saml-login/.test(e.message),
  );
  assert.equal(calls.length, 0, 'nothing may leave the process on an unknown path');
});

test('an ig-prefixed but unrecognised auth path is refused, not matched by prefix', async () => {
  // `ig-basic-display` was a real Instagram auth path, and configs written in
  // that era still carry the name. Matching on a prefix would quietly route such
  // a profile through the ig-login refresh: Meta rejects the grant, the operator
  // gets an OAuth error about a token they never touched, and the config keeps
  // its unsupported value because nothing ever said the path was unknown. The
  // union is closed on purpose — an unknown member fails loudly and offline.
  const { exchange, calls } = fakeExchange({ access_token: 'X' });

  await assert.rejects(
    () =>
      refreshToken({
        authPath: 'ig-basic-display' as AuthPath,
        accessToken: 'IGold',
        nowMs: NOW_MS,
        exchange,
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'validation');
      assert.match(e.message, /ig-basic-display/);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'an unsupported ig-* path must not reach the exchange');
});

test('refreshToken falls back to the wall clock when nowMs is omitted', async () => {
  const { exchange } = fakeExchange({ access_token: 'IGnew', expires_in: 5_184_000 });
  const before = Math.floor(Date.now() / 1000);

  const result = await refreshToken({ authPath: 'ig-login', accessToken: 'IGold', exchange });

  const after = Math.floor(Date.now() / 1000);
  assert.ok(result.expiresAtSec !== undefined);
  assert.ok(
    result.expiresAtSec >= before + 5_184_000 && result.expiresAtSec <= after + 5_184_000,
    `expiry ${result.expiresAtSec} is not anchored to the current wall clock`,
  );
});

test('a clock pinned at the unix epoch is honoured, not swapped for wall time', async () => {
  // `nowMs: 0` is a legitimate fixed clock — it is what a fixture replay or a
  // zeroed test clock hands over — and it is exactly the value a falsy-check
  // default throws away. The damage is silent: the expiry the caller persists
  // would be anchored to real time while every other field came from the
  // fixture, so the recorded credential could never be reproduced or replayed.
  const { exchange } = fakeExchange({ access_token: 'IGnew', expires_in: 5_184_000 });

  const res = await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: 0,
    exchange,
  });

  assert.equal(res.expiresAtSec, 5_184_000);
});

test('refresh exposes no automatic refresh-decision helper, because nothing refreshes automatically (CC-AUTH-67)', async () => {
  // docs/auth.md §3 and the README promise that refresh is operator-driven:
  // nothing calls `refresh_access_token` on its own, and `IG_REFRESH_AFTER_DAYS`
  // is only the `expiring_soon` warning threshold, which `summarizeTokenExpiry`
  // applies (pinned by the threshold-boundary tests in test/api/account.test.ts).
  // A `needsRefresh` export once answered "should this token be refreshed?" with
  // no caller in `src/`: its tests pinned a contract for dead code, and it was a
  // second, unenforced copy of the threshold rule that could drift from the one
  // the tools report. Re-adding such a helper is a design change that must come
  // with the caller the docs would then have to describe. `surfaceForms` is a
  // redaction helper shared with `cli/login.ts` (CC-AUTH-76), not a decision.
  const mod: Record<string, unknown> = await import('../../src/core/refresh.js');
  assert.equal('needsRefresh' in mod, false);
  assert.deepEqual(
    Object.keys(mod)
      .filter((k) => typeof mod[k] === 'function')
      .sort(),
    ['createTokenExchange', 'refreshToken', 'surfaceForms'],
  );
});

test('the default transport and the default exchange are both the real, un-stubbed ones', async () => {
  // Both seams in this module fall back to something ambient when their
  // injection is missing — `refreshToken` to `createTokenExchange()`, and that to
  // the platform `fetch`. Every other test here injects, so nothing exercised
  // either default, and a regression that quietly swapped the fallback (to the
  // auth-injecting Graph seam, say) would have gone unseen.
  //
  // This is also what makes the file's network rail an assertion rather than a
  // hope: omitting `exchange` here reaches `globalThis.fetch`, and the only
  // acceptable outcome is the rail's own error. If this test ever fails with a
  // real network error, the rail has been lost and the suite is one refactor away
  // from sending a live long-lived token to Meta.
  await assert.rejects(
    () => refreshToken({ authPath: 'ig-login', accessToken: 'IGold', nowMs: NOW_MS }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.kind, 'upstream');
      assert.match(e.message, new RegExp(NETWORK_FORBIDDEN));
      return true;
    },
  );
});

test('a non-function transport at the exchange seam fails closed, off the network', async () => {
  // `params.exchange` is a DECLARATION, not a validation — the same point this
  // module already makes two ways: `exchange<TokenExchangeWire>` below is called
  // a cast rather than a check, and `accessToken` above is validated at runtime
  // precisely because “this is exported, so the compiler is not the only
  // caller”. An untyped consumer of the shipped `.d.ts` can pass any falsy
  // non-function here, and `??` and `||` answer differently when one does.
  //
  // The DIRECTION is what this pins. `??` keeps the bad value and the call throws
  // a local `TypeError`, having opened nothing. `||` would discard it, build a
  // real `createTokenExchange()`, and send `client_secret` to graph.facebook.com
  // — the precise failure the file's network rail exists to catch. So the
  // load-bearing assertion is the FETCH COUNT, not the error type: reading only
  // the type would keep passing the day the rail is spelled differently.
  //
  // No `typeof exchange === 'function'` guard is added upstream of this. A garbage
  // transport is the caller's programming error, the current behaviour already
  // fails closed, and a guard would make `??` and `||` genuinely interchangeable
  // again — removing the only thing that makes the choice observable.
  const rail = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (...args: Parameters<typeof fetch>) => {
    fetches += 1;
    return rail(...args);
  };
  try {
    await assert.rejects(
      () =>
        refreshToken({
          authPath: 'fb-login',
          accessToken: FAKE_LONG_LIVED_TOKEN,
          appId: FAKE_APP_ID,
          appSecret: FAKE_APP_SECRET,
          nowMs: NOW_MS,
          exchange: 0 as unknown as TokenExchangeFn,
        }),
      (e: unknown) => {
        assert.ok(e instanceof TypeError, `expected a TypeError, got ${String(e)}`);
        assert.ok(!(e instanceof InstagramError), 'the default transport must not be built');
        return true;
      },
    );
  } finally {
    globalThis.fetch = rail;
  }
  assert.equal(fetches, 0, 'a refused transport must not fall back to the live network');
});
