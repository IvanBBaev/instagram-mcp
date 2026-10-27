/**
 * The loopback capture of the OAuth redirect for the `login` CLI subcommand,
 * shared by both auth paths: the default redirect URI, the accept-list of
 * addresses the listener binds ({@link listenHostFor}), the scheme check run
 * before the authorize URL is printed ({@link redirectUriProblem}), the pure
 * routing of one inbound request ({@link classifyCallbackRequest}) and the
 * bounded wait for the `code` ({@link captureAuthorizationCode}).
 *
 * Everything that touches a socket or a timer is injected (server factory,
 * clock), so the unit tests exercise the routing, the `state` check and the
 * timeout without a real port. The flow that awaits the code is
 * {@link import('./login.js').runLogin}. Moved unchanged from `cli/login.ts` on
 * 2026-10-28.
 */
import { createServer } from 'node:http';

import { systemClock } from '../core/clock.js';
import type { Clock } from '../core/clock.js';
import { MAX_GRAPH_MESSAGE_LENGTH } from '../core/errors.js';
import { InstagramError } from '../core/types.js';
import { quoteUntrusted, visibleText } from '../core/untrusted.js';

/**
 * Loopback redirect used to capture the authorization `code`.
 *
 * The host is the literal `127.0.0.1`, NOT `localhost`, and it must stay that
 * way: {@link captureAuthorizationCode} binds a single loopback address, while
 * `localhost` resolves to `::1` before `127.0.0.1` on most macOS and Windows
 * boxes. With the two spellings disagreeing the browser hits a closed IPv6
 * socket, the `code` never arrives, and `login` waits forever.
 *
 * OPERATOR NOTE: this exact string is what Meta redirects to, so it must be
 * registered verbatim in the Meta app (App settings → Instagram/Facebook Login →
 * Valid OAuth Redirect URIs). An app whitelisted with the old
 * `http://localhost:8723/callback` must have `http://127.0.0.1:8723/callback`
 * added (or `--redirect-uri` passed) — Meta matches redirect URIs literally.
 */
const DEFAULT_REDIRECT_PORT = 8723;
/** The port a browser follows an `http:` URI to when the URI names none. */
const HTTP_DEFAULT_PORT = 80;
/** The only loopback addresses this CLI will bind (see {@link listenHostFor}). */
const LOOPBACK_IPV4 = '127.0.0.1';
const LOOPBACK_IPV6 = '::1';
export const DEFAULT_REDIRECT_URI = `http://${LOOPBACK_IPV4}:${DEFAULT_REDIRECT_PORT}/callback`;

/**
 * Absolute budget for the browser round-trip. Without it a redirect that never
 * arrives (wrong/unregistered redirect URI, closed browser tab, loopback
 * mismatch) leaves `login` hanging with no diagnostic — defect: the listener had
 * no timeout at all.
 */
export const CAPTURE_TIMEOUT_MS = 5 * 60_000;

// --- Loopback capture of the authorization code -----------------------------

/** The subset of a `node:http` request this module reads. */
export interface CallbackRequest {
  url?: string | undefined;
}

/** The subset of a `node:http` response this module drives. */
export interface CallbackResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** The subset of a `node:http` server this module drives. */
export interface CallbackServer {
  listen(port: number, host: string): void;
  close(): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

/** Server factory seam — `node:http` in production, a fake (no socket) in tests. */
export type CreateCallbackServer = (
  handler: (req: CallbackRequest, res: CallbackResponse) => void,
) => CallbackServer;

const defaultCreateServer: CreateCallbackServer = (handler) =>
  createServer((req, res) => {
    handler(req, res);
  });

/** What the listener should do with one inbound request. */
export type CallbackOutcome =
  | { kind: 'ignore'; status: number; body: string }
  | { kind: 'code'; code: string; status: number; body: string }
  | { kind: 'denied'; status: number; body: string; reason: string }
  | { kind: 'state-mismatch'; status: number; body: string };

/**
 * The reason a denied authorization gives, as the `Authorization was denied:`
 * line may print it (CC-DATA-100).
 *
 * Both parameters arrive in the redirect's query string, which anything able to
 * reach the loopback port can write — and the line goes to the operator's
 * terminal. Until 2026-09-24 the value was printed as received: a `%0A` in
 * `error_description` forged a second line under the refusal, an ANSI escape
 * repainted the terminal, and the length was bounded only by the URL. It is now
 * cut and escaped by the rule Graph error text follows, word-safe
 * because the `runLogin` catch redacts the finished message downstream
 * (see `QuoteOptions.wordSafe`). A description with nothing visible in it falls back to the
 * `error` code, and a blank code to a fixed phrase, so the line never ends in
 * nothing.
 */
function deniedReason(query: URLSearchParams): string {
  const reason =
    visibleText(query.get('error_description')) ??
    visibleText(query.get('error')) ??
    'no reason given';
  return quoteUntrusted(reason, MAX_GRAPH_MESSAGE_LENGTH, undefined, { wordSafe: true });
}

/**
 * Decide what an inbound loopback request means. Pure, so the routing rules are
 * testable without a socket.
 *
 * The **path check** is load-bearing: anything on this port that is not the
 * redirect path (a stray `GET /`, a probe, a favicon fetch that inherited the
 * query string) is answered 404 and ignored, so it can neither resolve the
 * capture with a bogus `code` nor abort a login that is still in flight.
 */
export function classifyCallbackRequest(params: {
  requestUrl: string | undefined;
  expectedPath: string;
  state: string;
}): CallbackOutcome {
  // The base is only a parsing anchor — a loopback listener has no other origin.
  //
  // Equivalent-mutant note: spelling the fallback `''` instead of `'/'` survives,
  // because `new URL('', base)` resolves to the base and its path normalises to
  // `/` for a special scheme. `'/'` stays because it says what an absent
  // `req.url` should be treated as; `''` says only "resolve the base again".
  const url = new URL(params.requestUrl ?? '/', `http://${LOOPBACK_IPV4}`);
  if (url.pathname !== params.expectedPath) {
    return { kind: 'ignore', status: 404, body: 'Not found.' };
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  // What the request CLAIMS to be, decided before deciding whether to believe
  // it. Splitting the two halves is the whole point: the denial used to be
  // ANSWERED here, above the state comparison, so a forged `?error=` ended the
  // capture without ever being asked for the secret (CC-PROC-174).
  const claim: CallbackOutcome | null =
    error !== null
      ? {
          kind: 'denied',
          status: 400,
          body: 'Authorization failed. You may close this window.',
          reason: deniedReason(url.searchParams),
        }
      : code !== null
        ? {
            kind: 'code',
            code,
            status: 200,
            body: 'Login complete. You may close this window and return to the terminal.',
          }
        : null;

  // Carrying neither parameter makes this no authorization response at all — a
  // reloaded tab, a prefetch, a probe. Those keep the listener waiting, which
  // also keeps the gate below from seeing anything but a request claiming to BE
  // the redirect: an operator refreshing the page must not abort their own login.
  if (claim === null) {
    return { kind: 'ignore', status: 400, body: 'Missing authorization code.' };
  }
  // `get` returns the FIRST occurrence, which is what makes a repeated
  // `&state=`/`&code=` appended by a third party unable to decide the comparison.
  //
  // NOT an equivalence, measured 2026-09-23: `!=` here is KILLED, and by the one
  // test this note used to cite as merely pinning its premise. The note claimed
  // the two spellings cannot be told apart, and that claim was an argument about
  // the signature rather than about the suite. By the declared type it holds:
  // the left side is `string | null`, `params.state` is a `string`, and `==`
  // differs from `===` across that pair only when both sides are nullish, which
  // a `string` right side excludes. But "classifyCallbackRequest rejects a
  // callback when the expected state is itself absent" deliberately steps
  // outside the signature — it passes `state: undefined`, which is what a
  // JavaScript caller, or a future optional `state`, actually produces. There
  // `get('state')` is `null`, `null != undefined` is `false`, and the `!=`
  // spelling ANSWERS `code`: it hands the authorization code to a forged
  // callback. This is the CSRF check, the strict comparison is load-bearing,
  // and the suite proves it rather than the type merely implying it.
  //
  // The gate stands in front of BOTH answers, the denial included. RFC 6749
  // §4.1.2.1 requires the authorization server to echo `state` on the ERROR
  // redirect too whenever the request carried one, and this client always sends
  // one — so a denial that arrives without it did not come from Meta, and
  // reporting it to the operator as their own refusal sends them to look at the
  // one place that cannot explain it (CC-PROC-174).
  if (url.searchParams.get('state') !== params.state) {
    return { kind: 'state-mismatch', status: 400, body: 'State mismatch — request rejected.' };
  }
  return claim;
}

/**
 * The address to bind for a redirect URI. This is an accept-list of the two
 * addresses the capture server actually binds — {@link LOOPBACK_IPV4} and
 * {@link LOOPBACK_IPV6} — plus `localhost` as a spelling of the first; binding a
 * routable interface would expose the authorization-code catcher to the network.
 *
 * It is deliberately NARROWER than “loopback”, and the refusal message says so.
 * `127.0.0.2` (all of 127/8 is loopback), the rooted `localhost.` and
 * `[::ffff:127.0.0.1]` are loopback addresses that this function refuses, so a
 * message phrased as “not loopback” would be false for them — and false in the
 * one direction that matters, telling an operator who did the right thing that
 * they did the wrong thing.
 *
 * `localhost` is normalized to {@link LOOPBACK_IPV4} — Node would resolve it and
 * bind whichever family DNS returns first, which is precisely the mismatch this
 * CLI must avoid (see {@link DEFAULT_REDIRECT_URI}).
 */
export function listenHostFor(redirectUri: string): string {
  // NOT redundant, though it was recorded as such until 2026-09-23. The WHATWG
  // parser ASCII-lowercases the host of every SPECIAL scheme, so
  // `new URL('http://LOCALHOST/').hostname` is indeed `'localhost'` — but nothing
  // confines this function to a special scheme, and the parser leaves the host of
  // `foo://LOCALHOST:8723/callback` exactly as typed. Drop the call and that URI
  // stops being loopback, so `login` refuses to bind. Pinned by "listenHostFor
  // lowercases the host itself, for the schemes the parser will not". The
  // case-insensitivity of a host is a property of DNS, not of this parser, and the
  // comparisons below are the security boundary — they must not depend on which
  // scheme the input happened to use.
  const hostname = new URL(redirectUri).hostname.toLowerCase();
  if (hostname === LOOPBACK_IPV4 || hostname === 'localhost') return LOOPBACK_IPV4;
  // The WHATWG URL parser keeps IPv6 hosts bracketed; `listen` wants them bare.
  //
  // Equivalent-mutant note: the second half — the BARE `::1` — is unreachable
  // through this function, so dropping it survives. A bare IPv6 host does not
  // parse at all (`new URL('http://::1:8723/')` throws), and every spelling that
  // does parse comes back bracketed and compressed (`[::0:1]` and
  // `[0:0:0:0:0:0:0:1]` both normalise to `[::1]`). It stays because
  // `listenHostFor` is exported and its contract is "an address this CLI binds",
  // not "the output of `URL.hostname`" — a caller handing it an address from
  // `listen` itself, where bare is the spelling, must not be refused the very
  // value this function returns.
  if (hostname === `[${LOOPBACK_IPV6}]` || hostname === LOOPBACK_IPV6) return LOOPBACK_IPV6;
  throw new InstagramError(
    `login can only capture the OAuth redirect on ${LOOPBACK_IPV4} or [${LOOPBACK_IPV6}], ` +
      `but --redirect-uri points at "${hostname}". ` +
      `Use ${DEFAULT_REDIRECT_URI} (and register it in your Meta app), or capture the code yourself.`,
    { kind: 'validation' },
  );
}

/**
 * Why `redirectUri` cannot be the URI `login` captures the redirect on, or
 * `undefined` when it can. The listener is a plain HTTP server, so the browser
 * can only come back to an `http:` URI: an `https:` one fails the TLS handshake
 * against it, and a custom scheme (`myapp://…`) is handed to whatever app
 * claims it, never to this process. Either way the login used to print the
 * authorize URL, send the operator through Meta's consent screen, and then
 * wait out the five-minute timeout for a redirect that could not arrive.
 * `runLogin` asks this before the authorize URL is printed; the capture asks
 * it again for a direct caller.
 */
export function redirectUriProblem(redirectUri: string): string | undefined {
  const remedy = `use ${DEFAULT_REDIRECT_URI} (and register it in your Meta app).`;
  if (!URL.canParse(redirectUri)) {
    return `--redirect-uri is not an absolute URL; ${remedy}`;
  }
  const { protocol } = new URL(redirectUri);
  if (protocol === 'http:') return undefined;
  return (
    `--redirect-uri must be an http:// URI, but it uses "${protocol}". login captures the ` +
    `redirect with a plain HTTP listener on ${LOOPBACK_IPV4} or [${LOOPBACK_IPV6}], so the ` +
    `browser never comes back to any other scheme; ${remedy}`
  );
}

/** Injectable collaborators for {@link captureAuthorizationCode}. */
export interface CaptureDeps {
  /** Server factory. Defaults to `node:http`; tests inject a socket-free fake. */
  createServerImpl?: CreateCallbackServer;
  /** Clock the timeout runs on. Defaults to the system clock. */
  clock?: Clock;
  /** Absolute wait budget. Defaults to {@link CAPTURE_TIMEOUT_MS} (5 minutes). */
  timeoutMs?: number;
}

/**
 * Bind a loopback HTTP server on the redirect URI's port and resolve with the
 * `code` once the browser is redirected back.
 *
 * Guarantees: it binds the address the redirect URI names (loopback only), only
 * requests on the redirect **path** are considered, the OAuth `state` must match
 * before ANY answer is honoured — a denial included, because the authorization
 * server echoes `state` on the error redirect too — and the wait is bounded by
 * `timeoutMs` — after which the listener is
 * closed and the promise rejects with a message naming the likely causes. The
 * server is closed on every exit path.
 */
export function captureAuthorizationCode(
  params: { redirectUri: string; state: string },
  deps: CaptureDeps = {},
): Promise<string> {
  const problem = redirectUriProblem(params.redirectUri);
  if (problem !== undefined) {
    return Promise.reject(new InstagramError(problem, { kind: 'validation' }));
  }
  const url = new URL(params.redirectUri);
  // An empty `url.port` means the URI names no port OR names the scheme's own
  // default (the WHATWG parser drops `:80` from an `http:` URI). Either way the
  // browser follows the redirect to port 80, so that is where to listen; 8723
  // there left the listener where the redirect never arrives (CC-CFG-82).
  // Pinned by "captureAuthorizationCode binds the scheme default port when the
  // redirect URI names none". The URI is `http:` here, a special scheme, so its
  // `pathname` is never empty: the parser normalises an empty path to `/`.
  const port = url.port !== '' ? Number(url.port) : HTTP_DEFAULT_PORT;
  const expectedPath = url.pathname;
  const clock = deps.clock ?? systemClock;
  const timeoutMs = deps.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const createServerImpl = deps.createServerImpl ?? defaultCreateServer;

  let listenHost: string;
  try {
    listenHost = listenHostFor(params.redirectUri);
  } catch (err) {
    // The `new Error(String(err))` arm is unreachable, and until 2026-09-23 this
    // comment named the wrong reason for it. `listenHostFor` does not only raise
    // `InstagramError`: it re-parses the URI with `new URL`, which raises a
    // `TypeError` for a string that does not parse. What rules that out here is
    // the `new URL(params.redirectUri)` above — it parsed the same string before
    // this try block was entered, so the re-parse cannot fail. Either thrower is
    // an `Error` in any case. The arm exists because `catch` is typed `unknown`,
    // and rejecting with a bare value would give `runLogin`'s handler nothing to
    // print. The ignore covers the arm, not the `return` (CC-PROC-128).
    return Promise.reject(
      /* c8 ignore next */
      err instanceof Error ? err : new Error(String(err)),
    );
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    // Aborting cancels the pending timeout sleep (and clears its timer, so a
    // successful login does not hold the event loop open for five minutes).
    const finished = new AbortController();

    // Equivalent-mutant note: moving `action()` above `server.close()` survives
    // the suite, and genuinely cannot be observed — `action` only settles this
    // promise, whose continuations run in a later microtask, so the close still
    // happens first in real time either way. The order stays as written because
    // it is the one that is true under a future `action` that does more than
    // settle: release the socket, then hand control away.
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      finished.abort();
      server.close();
      action();
    };

    const server = createServerImpl((req, res) => {
      const outcome = classifyCallbackRequest({
        requestUrl: req.url,
        expectedPath,
        state: params.state,
      });
      res.writeHead(outcome.status, { 'content-type': 'text/plain' });
      res.end(outcome.body);

      switch (outcome.kind) {
        case 'ignore':
          return; // Not the redirect — keep waiting.
        case 'code':
          settle(() => resolve(outcome.code));
          return;
        case 'denied':
          settle(() =>
            reject(
              new InstagramError(`Authorization was denied: ${outcome.reason}`, {
                kind: 'auth',
              }),
            ),
          );
          return;
        case 'state-mismatch':
          settle(() =>
            reject(new InstagramError('OAuth state mismatch — aborting.', { kind: 'auth' })),
          );
          return;
      }
    });

    server.on('error', (err) => {
      settle(() =>
        reject(
          new InstagramError(
            `Could not listen on ${listenHost}:${port} for the OAuth redirect (${err.message}). ` +
              'Another login may be running, or the port is taken — pass --redirect-uri with a free ' +
              'port that is also registered in your Meta app.',
            { kind: 'validation', cause: err },
          ),
        ),
      );
    });

    server.listen(port, listenHost);

    void clock.sleep(timeoutMs, finished.signal).then(
      () => {
        settle(() =>
          reject(
            new InstagramError(
              `Timed out after ${Math.round(timeoutMs / 60_000)} minute(s) waiting for the OAuth ` +
                `redirect to ${params.redirectUri}. Check that this EXACT URI is registered in your ` +
                'Meta app (App settings -> Instagram/Facebook Login -> Valid OAuth Redirect URIs), ' +
                'that you completed the browser prompt, and that the redirect URI host matches the ' +
                `address this listener bound (${listenHost}) — a URI spelled "localhost" can resolve ` +
                'to ::1 and never reach it.',
              { kind: 'upstream' },
            ),
          ),
        );
      },
      () => {
        // Aborted because the capture already settled — nothing to do.
      },
    );
  });
}
