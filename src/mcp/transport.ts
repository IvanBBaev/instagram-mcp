/**
 * Transports (Layer `mcp/`). Two ways to serve the same {@link McpServer}
 * instance, per docs/architecture.md §8:
 *
 *   - **stdio** (default): the MCP protocol channel is stdout, so nothing else
 *     may ever write there — all logging goes to stderr (enforced by the logger
 *     and the `no-console` lint rule). This is the transport the read-path
 *     milestone (Gate G2) demonstrates.
 *   - **Streamable HTTP** (opt-in, `IG_TRANSPORT=http`): binds the loopback
 *     interface only (enforced here, not merely documented), checks a
 *     constant-time bearer when `IG_HTTP_TOKEN` is set, and enables the SDK's
 *     DNS-rebinding protection. Runs in stateless JSON mode (the 2026-07-28 spec
 *     drops the session handshake).
 *
 * This module owns no business logic — it only wires a fully-built server to a
 * transport. It must not import `core/http`, `core/auth`, or `tools/*`.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InstagramError } from '../core/types.js';
import type { Logger } from '../core/types.js';
import { isLoopbackHost } from '../core/settings.js';

/**
 * Connect `server` to a stdio transport and start serving. Resolves once the
 * transport is listening; the process then stays alive on stdin.
 */
export async function startStdio(server: McpServer, log: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('mcp server ready', { transport: 'stdio' });
}

export interface HttpTransportOptions {
  /**
   * Loopback bind address (`IG_HTTP_HOST`, default `127.0.0.1`). A non-loopback
   * address is only accepted together with a `token` — see {@link startHttp}.
   */
  host: string;
  /** Bind port (`IG_PORT`, default `3000`). */
  port: number;
  /** Bearer required on every request when set (`IG_HTTP_TOKEN`). */
  token?: string;
}

/** A started HTTP transport with a graceful shutdown handle. */
export interface RunningHttpTransport {
  close(): Promise<void>;
}

/** Constant-time bearer comparison that never short-circuits on length. */
function bearerMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal length; compare against a padded copy so a
  // length mismatch costs the same as a value mismatch and leaks nothing.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Pull a `Bearer <token>` value out of the Authorization header, if present. */
function readBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1];
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

/**
 * `Host`/`Origin` values the DNS-rebinding protection accepts for a bind: the
 * bare address and the `host:port` form. A bracketless IPv6 literal (`::1`) is
 * also listed in its bracketed spellings, which is how a client actually writes
 * it in a `Host` header (`[::1]:3000`).
 */
function allowedHostHeaders(host: string, port: number): string[] {
  const forms = new Set([host, `${host}:${port}`]);
  if (host.includes(':') && !host.startsWith('[')) {
    forms.add(`[${host}]`);
    forms.add(`[${host}]:${port}`);
  }
  return [...forms];
}

/**
 * Guard the bind before a socket exists. The HTTP transport serves the FULL tool
 * surface — `instagram_post_image`, `instagram_delete_comment` and every other
 * write included — so a non-loopback bind without a bearer is an unauthenticated
 * remote tool surface. The SDK's DNS-rebinding protection does not cover this: it
 * only checks `Host`/`Origin` (which a non-browser client sets freely), and on a
 * `0.0.0.0` bind the allowed host IS the supplied wildcard.
 *
 * Loopback without a token is allowed but never silent: it is reachable by every
 * other process on the machine, so it is reported at `error` level (visible even
 * at `IG_LOG_LEVEL=error`) rather than refused, because a token-less loopback
 * bind is the documented local-developer default (README, docs/troubleshooting.md).
 */
function assertBindIsSafe(opts: HttpTransportOptions, log: Logger): void {
  const loopback = isLoopbackHost(opts.host);
  if (!loopback && opts.token === undefined) {
    throw new InstagramError(
      `Refusing to start the HTTP transport: bind address "${opts.host}" is not loopback and no ` +
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

/**
 * Connect `server` to a Streamable HTTP transport bound to the loopback
 * interface and start an HTTP listener. The transport is stateless (no session
 * handshake); one transport instance is reused for the process lifetime.
 *
 * Security: the bind is checked BEFORE any socket is created — a non-loopback
 * address without a bearer is refused outright (`InstagramError`, kind
 * `validation`), and a token-less loopback bind is logged at `error` level. A
 * bearer is required on every request when `opts.token` is set (constant-time
 * compare), and the SDK's DNS-rebinding protection restricts the accepted
 * `Host`/`Origin` to the bound address. This is a local developer transport, not
 * an internet-facing server.
 *
 * @throws InstagramError `kind: 'validation'` for a non-loopback bind with no token.
 */
export async function startHttp(
  server: McpServer,
  opts: HttpTransportOptions,
  log: Logger,
): Promise<RunningHttpTransport> {
  assertBindIsSafe(opts, log);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless JSON mode
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: allowedHostHeaders(opts.host, opts.port),
  });
  await server.connect(transport);

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (opts.token !== undefined) {
      const provided = readBearer(req);
      if (provided === undefined || !bearerMatches(provided, opts.token)) {
        refuse(res, 401, 'Unauthorized');
        return;
      }
    }
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      log.error('http request failed', { err: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) refuse(res, 500, 'Internal error');
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    // Bind the host explicitly — `assertBindIsSafe` above has already refused a
    // non-loopback address (0.0.0.0 included) unless a bearer token is set.
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  log.info('mcp server ready', { transport: 'http', host: opts.host, port: opts.port });

  return {
    close: async () => {
      await transport.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
