/**
 * Test harness preloaded into a CHILD process (`node --import`) by
 * `test/index.test.ts`, which runs the real composition root `src/index.ts` as a
 * process. Production code knows nothing about this file.
 *
 * Why a preload rather than the usual `withFetch` helper: `src/index.ts` is an
 * entry point — it wires itself together and starts a transport when the module
 * is evaluated, so the only honest way to test it is to run it. Both network
 * seams (`core/http.ts` and `core/refresh.ts`) resolve
 * `deps.fetchImpl ?? globalThis.fetch` at CALL time, so replacing the global
 * before the entry is imported intercepts every outbound request without any
 * production seam having to exist for the tests' benefit. The SSRF allowlist in
 * `core/host.ts` refuses loopback hosts outright, so pointing the Graph client at
 * a local server is impossible by design — this is the only way in.
 *
 * It provides three things, all driven by the environment (all a preload gets):
 *
 *   IG_TEST_ROUTES             JSON `StubRoute[]`; first URL-substring match wins.
 *                              An unmatched request gets a non-retryable client
 *                              error, so an unexpected call fails the test fast
 *                              instead of quietly burning the retry budget.
 *   IG_TEST_REQUEST_LOG        File each request is appended to as `<METHOD> <url>`,
 *                              so a test can assert what the real auth layer put
 *                              on the wire (`access_token`, `appsecret_proof`).
 *   IG_TEST_FAKE_NODE_VERSION  Reported as `process.versions.node`, to exercise
 *                              the entry's minimum-runtime guard on a supported
 *                              runtime.
 *   IG_TEST_FAKE_NOW_MS        Fixed unix-ms value returned by `Date.now()`. The
 *                              entry builds its `systemClock` from it, so this
 *                              pins anything the child derives from the wall
 *                              clock (token expiry arithmetic, above all).
 *
 * It also turns SIGTERM into an ordinary `process.exit(0)`. A transport child is
 * otherwise only stoppable by SIGKILL, which skips Node's exit hooks — including
 * the one that writes the `NODE_V8_COVERAGE` profile, so the child's work would
 * not be measured. This only changes how the child shuts down; nothing any test
 * asserts happens during shutdown.
 */
import { appendFileSync } from 'node:fs';

/** One canned response, selected by a substring of the request URL. */
export interface StubRoute {
  /** Substring matched against the full request URL. */
  match: string;
  /** HTTP status to answer with (default 200). */
  status?: number;
  /** JSON body to answer with (default `{}`). */
  body?: unknown;
}

type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const routes: StubRoute[] =
  process.env.IG_TEST_ROUTES === undefined
    ? []
    : (JSON.parse(process.env.IG_TEST_ROUTES) as StubRoute[]);
const requestLog = process.env.IG_TEST_REQUEST_LOG;

globalThis.fetch = (input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
  // Both production seams pass a plain string URL; a `URL` stringifies to its
  // href and a `Request` carries its own, so the stub never has to guess.
  /* c8 ignore start -- the non-string arms and the `'GET'` fallback are
     unreachable from a child: `core/http.ts` and `core/refresh.ts` are the only
     callers and both build a string URL and set `method` explicitly. They stay
     because this function is typed `typeof fetch` and must honour that
     signature — narrowing it to `(url: string, init: RequestInit)` would make
     the stub compile only for today's call sites and silently mis-record the
     day one of them switches to a `URL`. The equivalent arms of the in-process
     stub ARE exercised, in `test/harness.test.ts`. */
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (requestLog !== undefined) {
    // Synchronous on purpose: a subcommand may `process.exit` immediately after
    // its last request, and a queued async write would be lost.
    appendFileSync(requestLog, `${init?.method ?? 'GET'} ${url}\n`);
  }
  /* c8 ignore stop */
  const route = routes.find((r) => url.includes(r.match));
  if (route === undefined) {
    // Graph code 100 with a 4xx status classifies as a non-retryable client
    // error, so an unstubbed call surfaces at once instead of being retried.
    return Promise.resolve(
      jsonResponse(400, {
        error: { message: `test stub: no route for ${url}`, type: 'TestStub', code: 100 },
      }),
    );
  }
  return Promise.resolve(jsonResponse(route.status ?? 200, route.body ?? {}));
};

const fakeNodeVersion = process.env.IG_TEST_FAKE_NODE_VERSION;
if (fakeNodeVersion !== undefined) {
  Object.defineProperty(process.versions, 'node', {
    value: fakeNodeVersion,
    configurable: true,
  });
}

const fakeNowMs = process.env.IG_TEST_FAKE_NOW_MS;
if (fakeNowMs !== undefined) {
  const fixed = Number(fakeNowMs);
  Date.now = () => fixed;
}

process.on('SIGTERM', () => {
  process.exit(0);
});
