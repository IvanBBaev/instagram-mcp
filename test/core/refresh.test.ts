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
  needsRefresh,
  refreshToken,
  type TokenExchangeFn,
  type TokenExchangeRequest,
} from '../../src/core/refresh.js';
import { DEFAULT_SETTINGS } from '../../src/core/settings.js';
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
    (e: unknown) => e instanceof InstagramError && e.kind === 'auth' && e.status === 400,
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
        accessToken: 'FBold',
        appId: '55500',
        appSecret: 's3cr3t',
        nowMs: NOW_MS,
        exchange: createTokenExchange({ fetchImpl }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof InstagramError);
      assert.equal(e.message.includes('s3cr3t'), false, 'the app secret reached the message');
      assert.equal(e.message.includes('FBold'), false, 'the token reached the message');
      assert.equal(
        /graph\.facebook\.com|client_secret|fb_exchange_token/.test(e.message),
        false,
        `the exchange URL leaked into the message: ${e.message}`,
      );
      return true;
    },
  );
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
    (e: unknown) => e instanceof InstagramError,
  );
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

test('a non-numeric expires_in yields no expiry instead of string arithmetic', async () => {
  // Meta has shipped `expires_in` as a decimal string on some endpoints. Adding a
  // string to the epoch seconds concatenates instead of summing, producing an
  // expiry ~500 000 years out that `needsRefresh` would never act on.
  const { exchange } = fakeExchange({
    access_token: 'IGnew',
    expires_in: '5184000' as unknown as number,
  });

  const res = await refreshToken({
    authPath: 'ig-login',
    accessToken: 'IGold',
    nowMs: NOW_MS,
    exchange,
  });

  assert.equal(res.accessToken, 'IGnew');
  assert.equal(res.expiresAtSec, undefined);
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
  // `never` short-circuits on the state, not on the absence of `daysLeft`. A
  // summary that carries both would otherwise fall through to the comparison and
  // churn a token that has no expiry to refresh towards.
  assert.equal(needsRefresh({ state: 'never', daysLeft: 0 }, 10), false);
});

test('needsRefresh includes the threshold day itself and stops one day past it', () => {
  // The boundary is the whole contract: `IG_REFRESH_AFTER_DAYS=10` has to mean
  // "refresh at ten days left", not "at nine". Both sides are pinned because a
  // comparison with the wrong strictness satisfies either edge on its own.
  assert.equal(needsRefresh({ state: 'valid', daysLeft: 10 }, 10), true);
  assert.equal(needsRefresh({ state: 'valid', daysLeft: 11 }, 10), false);
});
