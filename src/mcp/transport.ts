/**
 * Transports (Layer `mcp/`). Two ways to serve the same {@link McpServer}
 * instance, per docs/architecture.md §8:
 *
 *   - **stdio** (default): the MCP protocol channel is stdout, so nothing else
 *     may ever write there — all logging goes to stderr (enforced by the logger
 *     and the `no-console` lint rule). This is the transport the read-path
 *     milestone (Gate G2) demonstrates.
 *   - **Streamable HTTP** (opt-in, `IG_TRANSPORT=http`): binds loopback ONLY —
 *     `IG_HTTP_HOST` is validated in `core/settings.ts` before this module runs,
 *     and the guard here is a second, looser one that only a direct caller of
 *     {@link startHttp} can exercise (see {@link assertBindIsSafe}). It also
 *     checks a constant-time bearer when `IG_HTTP_TOKEN` is set, and enables the
 *     SDK's DNS-rebinding protection over both `Host` and `Origin`. Runs in
 *     stateless JSON mode (the 2026-07-28 spec drops the session handshake),
 *     which the SDK defines as **one server and one transport per request** —
 *     see {@link startHttp}.
 *
 * This module owns no business logic — it only wires a fully-built server to a
 * transport. It must not import `core/http`, `core/auth`, or `tools/*`.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants as osConstants } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InstagramError } from '../core/types.js';
import type { Logger } from '../core/types.js';
import { isLoopbackHost } from '../core/settings.js';
import { isSinkGone } from '../core/log.js';

/** The two process streams the stdio transport owns; a seam for tests. */
export interface StdioStreams {
  stdin: NodeJS.ReadableStream & { pause(): unknown };
  stdout: NodeJS.WritableStream;
}

/**
 * Connect `server` to a stdio transport and start serving. Resolves once the
 * transport is listening; the process then stays alive on stdin.
 *
 * **The client leaving must not kill work already in flight.** The SDK's
 * `StdioServerTransport` subscribes to `'error'` on stdin only. When the client
 * exits, the next response written to stdout — a pipe — fails with `EPIPE`,
 * which arrives a tick later as an `'error'` event on the stream; with no
 * listener that is an uncaught exception and the process dies on the spot.
 * Measured on the built entry: an applied write whose Graph POST was already on
 * the wire lost its journal line because a concurrent read answered first and
 * its response hit the dead pipe. So stdout gets a listener here, classified by
 * the logger's own rule ({@link isSinkGone}): a gone pipe closes the transport
 * — stdin stops being read, the SDK stops sending, and the process exits once
 * the handlers still running have finished (and journaled) — while any other
 * error is rethrown to Node exactly as if nothing had subscribed.
 *
 * **stdin EOF is the client leaving too, and it closes the transport the same
 * way (CC-PROC-206).** The SDK transport listens for `'data'` and `'error'`
 * only, never `'end'`, so EOF used to change nothing inside the protocol: every
 * request the server had sent the client stayed pending on its own timer. A
 * write parked at the confirmation prompt held the process for the whole
 * `CONFIRM_TIMEOUT_MS` (120 s, mcp/write-mode.ts) waiting for an answer no one
 * could send. Closing the transport rejects every pending server→client request
 * with `ConnectionClosed` and clears its timer, so the prompt resolves as a
 * refusal at once — the write gate fails closed on a rejection, the write is
 * not performed and nothing is journaled — and a call already past its gate is
 * left to finish exactly as it is on a dead stdout. A stdin that closes without
 * EOF counts as EOF. The two doors share one close, so a client that shuts both ends closes the transport once.
 */
export async function startStdio(
  server: McpServer,
  log: Logger,
  streams: StdioStreams = { stdin: process.stdin, stdout: process.stdout },
): Promise<void> {
  const transport = new StdioServerTransport(
    streams.stdin as typeof process.stdin,
    streams.stdout as typeof process.stdout,
  );
  let gone = false;
  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    void transport.close();
  };
  streams.stdout.on('error', (error: unknown) => {
    if (!isSinkGone(error)) throw error;
    // One line per departure, not one per response that follows it onto the
    // dead pipe.
    if (gone) return;
    gone = true;
    log.warn('mcp client closed stdout; finishing in-flight calls, then exiting', {
      transport: 'stdio',
    });
    closeOnce();
  });
  // `info`, not `warn`: EOF is the documented clean stop, not a failure. A
  // stdin torn down without EOF (a reset pipe, a destroyed stream) emits
  // `'close'` but never `'end'`; it is the same departure, and after a clean
  // EOF its `'close'` finds the transport already closed and says nothing.
  const stdinGone = (): void => {
    if (closed) return;
    log.info('mcp client closed stdin; finishing in-flight calls, then exiting', {
      transport: 'stdio',
    });
    closeOnce();
  };
  streams.stdin.once('end', stdinGone);
  streams.stdin.once('close', stdinGone);
  await server.connect(transport);
  log.info('mcp server ready', { transport: 'stdio' });
}

export interface HttpTransportOptions {
  /**
   * Loopback bind address (`IG_HTTP_HOST`, default `127.0.0.1`). A non-loopback
   * address is only accepted together with a `token` — see {@link startHttp}.
   */
  host: string;
  /**
   * Bind port (`IG_PORT`, default `3000`). `0` asks the OS for a free one; the
   * port that was actually bound is what the ready log and the DNS-rebinding
   * allowlist report, not the `0`.
   */
  port: number;
  /**
   * Bearer required on every request when set (`IG_HTTP_TOKEN`). Blank is not a
   * value: a whitespace-only token is refused at startup rather than treated as
   * either "no token" or "a token" — see {@link assertBindIsSafe}.
   */
  token?: string;
}

/** A started HTTP transport with a graceful shutdown handle. */
export interface RunningHttpTransport {
  close(): Promise<void>;
}

/**
 * Builds a fully-registered {@link McpServer} for ONE HTTP exchange.
 *
 * {@link startHttp} takes a factory rather than a server instance because the
 * SDK forbids both halves of the alternative:
 *
 *   - a stateless `StreamableHTTPServerTransport` may serve exactly one request
 *     (`webStandardStreamableHttp.js`: `if (!this.sessionIdGenerator &&
 *     this._hasHandledRequest) throw new Error('Stateless transport cannot be
 *     reused across requests. Create a new transport per request.')`), and
 *   - one server cannot be re-`connect`ed to the replacement transport
 *     (`shared/protocol.js`: `if (this._transport) throw new Error('Already
 *     connected to a transport. … use a separate Protocol instance per
 *     connection.')`) — a `Protocol` owns its transport for its lifetime.
 *
 * So a fresh transport implies a fresh server, and the factory is what makes
 * that possible without this module knowing how a server is built.
 */
export type McpServerFactory = () => McpServer;

/**
 * Constant-time bearer comparison that never short-circuits on length.
 *
 * Two separable properties live here, and only one of them is testable.
 *
 * The ENCODING half is: `provided === expected` is not the same predicate as
 * this function, and a test kills that mutant. For a non-ASCII token the two
 * sides arrive in different encodings (see below), so string equality refuses
 * the one client that sent exactly the right credential — measured, not
 * assumed, by `test/mcp/transport.test.ts`.
 *
 * Equivalent-mutant note: the CONSTANT-TIME half is not testable in process.
 * Replacing `timingSafeEqual` with a byte loop that returns on the first
 * difference returns the same verdict for every input; the difference is only in
 * how long the wrong answer takes to produce, which no in-process test can
 * observe reliably. It is kept because a timing oracle over a loopback socket is
 * a real (if narrow) way to recover a token byte by byte, and the property is
 * cheap to hold. Do not "fix" a surviving mutation there with a timing
 * assertion.
 */
function bearerMatches(provided: string, expected: string): boolean {
  // Encode each side the way it arrived, or a non-ASCII token can never match.
  // Node decodes header values as latin1, so `provided` is one char per wire
  // byte; `expected` comes from `process.env`, which Node decodes as UTF-8.
  // `Buffer.from(provided)` would re-encode every byte >= 0x80 as two UTF-8
  // bytes, so a token like `tökén` compares 6 bytes against 5 and 401s the one
  // client that sent exactly the right credential.
  const a = Buffer.from(provided, 'latin1');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual requires equal length; compare against a padded copy so a
  // length mismatch costs the same as a value mismatch and leaks nothing.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Pull a `Bearer <token>` value out of the Authorization header, if present.
 *
 * The scheme is matched case-insensitively and separated by `1*SP`, which is
 * what RFC 7235 §2.1 specifies ("the scheme name is case-insensitive"); only the
 * credential itself is compared byte for byte, by {@link bearerMatches}. Node
 * keeps the FIRST `Authorization` header when a request carries several and
 * discards the rest (it is a discard-duplicates field in `_http_incoming.js`),
 * so a smuggled second header cannot replace the one that gets checked — and
 * `authorization` is never an array here, unlike `set-cookie`.
 *
 * Equivalent-mutant note: relaxing the credential group from `(.+)` to `(.*)` is
 * not separable by any input. The only extra header it accepts is a bare
 * `Bearer ` with nothing after the space, which captures the empty string — and
 * {@link assertBindIsSafe} refuses to start at all when the configured token is
 * blank, so an empty credential has nothing it could ever equal. Bare `Bearer`
 * with no trailing space still fails both spellings, because the ` +` between
 * scheme and credential demands at least one space either way. The `+` stays
 * because it says what the grammar means; do not add a test for it.
 */
function readBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer +(.+)$/i.exec(header);
  return match?.[1];
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

/**
 * The address to hand `listen()`, from the spelling the operator wrote.
 *
 * `IG_HTTP_HOST=[::1]` is an accepted, documented value — `loadSettings` keeps it
 * verbatim on purpose, so that the startup log and `doctor` echo back the exact
 * string that was set. Brackets belong to the URL authority grammar, not to the
 * resolver: measured 2026-09-23, handing `[::1]` straight to `listen()` raises
 * `getaddrinfo ENOTFOUND [::1]` and the process never starts at all
 * (CC-PROC-171). Only the BIND is unwrapped — a `Host` header keeps its
 * brackets, which is why {@link allowedHostHeaders} puts them back.
 *
 * One anchored match, not a `startsWith`/`endsWith` pair: a half-bracketed
 * string is not a spelling {@link isLoopbackHost} accepts, so the pair would
 * leave a branch no reachable input can take.
 */
export function bindAddressFor(host: string): string {
  return /^\[.+\]$/.test(host) ? host.slice(1, -1) : host;
}

/**
 * `Host` values the DNS-rebinding protection accepts for this socket: for each
 * name, the bare form and the `host:port` form, plus the bracketed spellings an
 * IPv6 client actually writes (`[::1]:3000`).
 *
 * Two things every entry here answers for, both measured 2026-09-23 against a
 * live listener (CC-PROC-171).
 *
 * `hosts` is a LIST because the string the operator configured and the address
 * the socket got are not the same thing. `localhost` is resolved by the OS — to
 * `::1` on the machine this was measured on — and the ready log prints that
 * address, inviting the operator to use it; a request to `http://[::1]:<port>`,
 * addressed to the very socket that is listening, was answered 403. Naming the
 * bound address widens nothing: a rebinding attack turns on a browser resolving
 * an attacker's NAME to loopback, so the `Host` it sends is that name, and the
 * literal address of a loopback socket is reachable only from this machine.
 *
 * Each name is listed lowercased as well as verbatim. A `Host` header is not the
 * string that was configured: WHATWG URL parsing lowercases an authority, so
 * `IG_HTTP_HOST=LocalHost` — accepted and pinned as accepted in
 * `test/core/settings.test.ts` — arrives as `localhost:<port>`, and the SDK
 * compares the allowlist with `Array.prototype.includes`, which is
 * case-sensitive. Measured, that combination answered EVERY request
 * `403 Invalid Host header` behind a ready log that looked perfectly healthy.
 * The verbatim spelling stays listed too, for a client that writes the header by
 * hand rather than deriving it from a URL.
 *
 * `port` is the port the socket actually got, never the requested one: `port: 0`
 * means "any free port", and an allowlist naming `:0` matches no `Host` header
 * any client will ever send — every request would be answered 403 by a listener
 * that looked perfectly healthy.
 *
 * Exported because every defect above is a decision about STRINGS, and a
 * socket-free test can hold all of them at once. The integration tests can only
 * ever bind the machine they run on: the bracketed IPv6 spellings were covered
 * by a single test that skips itself where there is no IPv6 loopback, so on such
 * a machine deleting them cost nothing.
 */
export function allowedHostHeaders(hosts: readonly string[], port: number): string[] {
  const forms = new Set<string>();
  for (const host of hosts) {
    const bare = bindAddressFor(host);
    for (const spelling of new Set([bare, bare.toLowerCase()])) {
      const written = spelling.includes(':') ? [spelling, `[${spelling}]`] : [spelling];
      for (const form of written) {
        forms.add(form);
        forms.add(`${form}:${port}`);
      }
    }
  }
  return [...forms];
}

/**
 * `Origin` values the DNS-rebinding protection accepts for this socket: exactly
 * one per name, the serialized origin of `http://<name>:<port>`.
 *
 * Not derived by prefixing `http://` onto {@link allowedHostHeaders}. That list
 * carries the port-less `Host` forms, and as an ORIGIN a port-less value names
 * a different page: `http://127.0.0.1` is what a browser sends for a page served
 * on port 80, a site that is not this listener. Until 2026-09-23 it was
 * admitted while `http://127.0.0.1:<port + 1>` was refused — measured against a
 * live listener, both near misses of the same origin, answered 200 and 403.
 *
 * `URL#origin` does the serializing, so each entry is spelled the way a browser
 * writes it: lowercased, IPv6 bracketed and compressed (`[::1]`), and with the
 * port omitted when it is the scheme default — a port-80 listener's own pages
 * send `http://127.0.0.1`, and that is what it lists.
 */
export function allowedOrigins(hosts: readonly string[], port: number): string[] {
  const origins = new Set<string>();
  for (const host of hosts) {
    const bare = bindAddressFor(host);
    const authority = bare.includes(':') ? `[${bare}]` : bare;
    origins.add(new URL(`http://${authority}:${port}`).origin);
  }
  return [...origins];
}

/**
 * Guard the bind before a socket exists. The HTTP transport serves the FULL tool
 * surface — `instagram_post_image`, `instagram_delete_comment` and every other
 * write included — so a non-loopback bind without a bearer is an unauthenticated
 * remote tool surface. The SDK's DNS-rebinding protection does not cover this: it
 * only checks `Host`/`Origin` (which a non-browser client sets freely), and on a
 * `0.0.0.0` bind the allowed host IS the supplied wildcard.
 *
 * What actually reaches this in the shipped process is the loopback arm alone.
 * `parseHostEnv` in `core/settings.ts` refuses every non-loopback `IG_HTTP_HOST`
 * before the transport is built and never reads the token, and `src/index.ts`
 * trims a blank `IG_HTTP_TOKEN` to `undefined` before calling {@link startHttp}.
 * Three of the four arms below are therefore defence in depth for a direct
 * caller of this module, not policy an operator can exercise, and
 * `docs/security.md` §3 states the settings-layer rule rather than this
 * one. It stated this one until 2026-09-23 (CC-PROC-175).
 *
 * Loopback without a token is allowed but never silent: it is reachable by every
 * other process on the machine, so it is reported at `error` level (visible even
 * at `IG_LOG_LEVEL=error`) rather than refused, because a token-less loopback
 * bind is the documented local-developer default (README, docs/troubleshooting.md).
 *
 * Two things this guard is NOT. It checks the host STRING the operator
 * configured, not the address the socket ends up with: every accepted spelling
 * except `localhost` IS the literal address, but `localhost` is resolved by the
 * OS, so a machine whose hosts file maps it elsewhere binds elsewhere —
 * {@link startHttp} logs the address that was actually bound so that difference
 * is at least visible. And it is deliberately fail-closed on the spellings a
 * resolver would happily accept: `127.1`, `2130706433` and `0177.0.0.1` all
 * reach 127.0.0.1 through `getaddrinfo`, yet all three are refused here without
 * a token, because "not recognized" must never round to "assumed safe".
 *
 * A blank token is refused outright rather than resolved to either answer: it
 * authenticates nobody (no `Bearer` credential can be empty, so every request
 * would 401), while `token !== undefined` would still buy a non-loopback bind
 * from the branch below. That reasoning holds for this function only. The entry
 * point resolves the same blank the OTHER way — to "no token" — so the
 * server starts, serves anonymous requests, and says so at `error` level; this
 * throw is unreachable from any environment an operator can set (CC-PROC-175).
 */
function assertBindIsSafe(opts: HttpTransportOptions, log: Logger): void {
  if (opts.token !== undefined && opts.token.trim() === '') {
    throw new InstagramError(
      'Refusing to start the HTTP transport: the configured bearer token is blank. A blank ' +
        'token authenticates nobody — every request is refused — yet it would still count as ' +
        '"a token is set" for the non-loopback bind check. Unset IG_HTTP_TOKEN for an ' +
        'unauthenticated loopback bind, or set a real secret.',
      { kind: 'validation' },
    );
  }
  const loopback = isLoopbackHost(opts.host);
  if (!loopback && opts.token === undefined) {
    throw new InstagramError(
      `Refusing to start the HTTP transport: bind address "${opts.host}" is not one of the ` +
        'loopback spellings this transport accepts (127.0.0.0/8, localhost, ::1) and no ' +
        'bearer token is configured, which would expose every tool (including writes) ' +
        'unauthenticated to the network. Bind 127.0.0.1, or set IG_HTTP_TOKEN.',
      { kind: 'validation' },
    );
  }
  if (!loopback) {
    log.error('http transport is bound to a NON-LOOPBACK address', {
      host: opts.host,
      port: opts.port,
      note: 'reachable beyond this machine; the bearer token is the only thing protecting it',
    });
  } else if (opts.token === undefined) {
    log.error('http transport has NO authentication', {
      host: opts.host,
      port: opts.port,
      note: 'IG_HTTP_TOKEN is unset — any local process can call every tool, writes included',
    });
  }
}

/** Message of an unknown throwable, for logging (never the stack). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start an HTTP listener that serves MCP over a Streamable HTTP transport bound
 * to the loopback interface. Each request gets its OWN `McpServer` (from
 * `createMcpServer`) and its own stateless transport, both closed when the
 * response closes — the contract the SDK enforces, see {@link McpServerFactory}.
 *
 * Security: the bind is checked BEFORE any socket is created — a non-loopback
 * address without a bearer is refused outright (`InstagramError`, kind
 * `validation`), and a token-less loopback bind is logged at `error` level. A
 * bearer is required on every request when `opts.token` is set (constant-time
 * compare) and is verified BEFORE a server, a transport or the request body ever
 * exist, and the SDK's DNS-rebinding protection restricts both the accepted
 * `Host` and, for the browsers that send one, the accepted `Origin` to the
 * address that was bound. This is a local developer transport, not an
 * internet-facing server.
 *
 * What it does NOT do: route on the path. Every method and path the SDK
 * understands is served on the same listener, so `/mcp` is a convention of the
 * client, not a check here — there is nothing else on this port to confuse it
 * with.
 *
 * @throws InstagramError `kind: 'validation'` for a non-loopback bind with no
 * token, or for a blank token.
 */
export async function startHttp(
  createMcpServer: McpServerFactory,
  opts: HttpTransportOptions,
  log: Logger,
): Promise<RunningHttpTransport> {
  assertBindIsSafe(opts, log);

  // Transports still attached to an in-flight exchange. Shutdown closes them
  // first: an open SSE stream is a live connection, and `httpServer.close()`
  // waits for connections to end, so a stream nothing terminated would hang it.
  const inFlight = new Set<StreamableHTTPServerTransport>();

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res);
  });

  /**
   * The address the socket actually got. `address()` is only `null` before
   * `listen` resolves and only a `string` for a pipe/UDS bind, and this function
   * binds a TCP host+port and is called after the listen — so the assertion
   * narrows to the one shape that can occur rather than papering over a check.
   */
  function bound(): AddressInfo {
    return httpServer.address() as AddressInfo;
  }

  /** Release one exchange's server + transport. Both `close()`es are idempotent. */
  async function dispose(
    server: McpServer,
    transport: StreamableHTTPServerTransport,
  ): Promise<void> {
    inFlight.delete(transport);
    try {
      await transport.close();
      await server.close();
    } catch (err) {
      // The exchange is already over; a teardown failure must not become an
      // unhandled rejection, and there is no response left to report it on.
      log.debug('http request teardown failed', { err: errorMessage(err) });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Authenticate first: an unauthorized caller must not reach the MCP layer,
    // cost a server registration, or get its body parsed.
    if (opts.token !== undefined) {
      const provided = readBearer(req);
      if (provided === undefined || !bearerMatches(provided, opts.token)) {
        refuse(res, 401, 'Unauthorized');
        return;
      }
    }
    try {
      const server = createMcpServer();
      const names = [opts.host, bound().address];
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless JSON mode
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: allowedHostHeaders(names, bound().port),
        // The SDK checks `Origin` only when this list is non-empty AND the
        // request carries the header, so it costs a non-browser MCP client
        // (which sends none) nothing. A browser request from a web page the
        // operator visits carries a `Host` that IS the bound address, so only the
        // `Origin` gives the cross-site call away. (Such a POST also needs a CORS
        // preflight, and this listener never sends an `Access-Control-*` header;
        // this check is the layer that does not depend on the browser enforcing
        // that.)
        allowedOrigins: allowedOrigins(names, bound().port),
      });
      inFlight.add(transport);
      // Registered before the first `await`, so a failure to connect still tears
      // the pair down once the error response has been written.
      res.once('close', () => void dispose(server, transport));
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      // Reached when building or connecting this request's server fails — a
      // registration error, or an SDK contract violation. Errors raised INSIDE
      // `handleRequest` do not land here: the SDK routes it through
      // `@hono/node-server`, which turns a rejection into a bodyless 500 itself.
      log.error('http request failed', { err: errorMessage(err) });
      if (!res.headersSent) refuse(res, 500, 'Internal error');
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    // Bind the host explicitly — `assertBindIsSafe` above has already refused a
    // non-loopback address (0.0.0.0 included) unless a bearer token is set.
    httpServer.listen(opts.port, bindAddressFor(opts.host), () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  // `boundAddress`/`port` come off the socket, not off `opts`: the guard above
  // can only vet the host STRING, so what the OS resolved it to is the one thing
  // that tells an operator whether "loopback" really is loopback — and with
  // `port: 0` it is the only way to learn where the server is listening.
  log.info('mcp server ready', {
    transport: 'http',
    host: opts.host,
    boundAddress: bound().address,
    port: bound().port,
  });

  return {
    close: async () => {
      // Hand every live exchange back to the SDK before the socket under it is
      // taken away, so a stream ends the way its own protocol says it ends.
      //
      // Equivalent-mutant note: dropping this loop (keeping only the `clear()`)
      // passes the whole suite, because `closeAllConnections()` below is what
      // actually unblocks shutdown — it yanks the socket out from under any
      // exchange this loop would have closed politely. Dropping BOTH is killed by
      // `shutdown closes an exchange that is still in flight before it stops the
      // listener`, which fails in about five seconds on that test's own `waitFor`
      // bound ("timed out waiting for shutdown to close the in-flight transport")
      // — a named failure, not a hung run. So the guarantee IS measured; which of
      // the two provides it is not separable in process. The loop is kept because a
      // graceful teardown and a severed socket look identical to
      // `httpServer.close()` and nothing alike to the client reading the stream.
      for (const transport of [...inFlight]) await transport.close();
      inFlight.clear();
      const stopped = new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      // `close()` stops accepting and drops idle keep-alive sockets, but it
      // WAITS for any socket that is mid-request — including one that sent half
      // a request line and nothing more, which pins shutdown for the whole
      // `headersTimeout` (60s by default). Every MCP exchange was closed above,
      // so nothing still holding a socket has an answer coming.
      httpServer.closeAllConnections();
      await stopped;
    },
  };
}

/** The operator stop requests the HTTP transport honours (CC-PROC-204). */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * Upper bound on a signal-driven teardown. `close()` has no deadline of its own
 * — it awaits every in-flight transport and then the listener — so without one a
 * wedged teardown would keep a process the operator asked to stop alive forever.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** The two process capabilities {@link closeOnSignal} needs; a seam for tests. */
export interface SignalHooks {
  on(signal: ShutdownSignal, listener: () => void): void;
  exit(code: number): void;
}

const processHooks: SignalHooks = {
  on: (signal, listener) => void process.on(signal, listener),
  exit: (code) => process.exit(code),
};

/**
 * Route SIGTERM/SIGINT into `running.close()` so a stopped HTTP server actually
 * runs its graceful teardown (CC-PROC-204). Without a listener Node's default
 * action kills the process at the signal, and every guarantee `close()` carries
 * (CC-PROC-33) is reachable from tests only.
 *
 *   - The first signal closes the transport ONCE, then exits `0`: an
 *     operator-requested stop that tore down cleanly is a success.
 *   - A teardown that rejects, or outlasts `timeoutMs`, exits `1` — the stop
 *     happened, but not the way it was asked for, and a supervisor should see it.
 *   - A second signal while the close is still running exits AT ONCE with the
 *     shell convention `128 + signo` (143 for SIGTERM, 130 for SIGINT): the
 *     operator pressing Ctrl-C twice means "stop now", and waiting out the
 *     deadline would ignore them.
 *
 * Every line goes through `log` (stderr). What this does NOT do is wait for tool
 * handlers still running: `close()` ends each exchange's transport, and a handler
 * mid-flight is cut off at exit — see CC-PROC-3.
 */
export function closeOnSignal(
  running: RunningHttpTransport,
  log: Logger,
  hooks: SignalHooks = processHooks,
  timeoutMs: number = SHUTDOWN_TIMEOUT_MS,
): void {
  let closing = false;
  let exited = false;
  let deadline: NodeJS.Timeout | undefined;
  // One exit per process. With the real `process.exit` a second call is never
  // reached; the guard keeps an injected `exit` honest about the same fact, so a
  // close that settles after a forced exit cannot report a second outcome.
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    clearTimeout(deadline);
    hooks.exit(code);
  };
  const onSignal = (signal: ShutdownSignal): void => {
    if (closing) {
      log.warn('second shutdown signal; exiting without waiting for the http transport', {
        signal,
      });
      exit(128 + osConstants.signals[signal]);
      return;
    }
    closing = true;
    log.info('shutdown signal received; closing the http transport', { signal, timeoutMs });
    deadline = setTimeout(() => {
      log.error('http transport did not close in time; exiting anyway', { timeoutMs });
      exit(1);
    }, timeoutMs);
    running.close().then(
      () => {
        log.info('http transport closed; exiting', { signal });
        exit(0);
      },
      (err: unknown) => {
        log.error('http transport close failed; exiting', { err: errorMessage(err) });
        exit(1);
      },
    );
  };
  for (const signal of SHUTDOWN_SIGNALS) hooks.on(signal, () => onSignal(signal));
}
