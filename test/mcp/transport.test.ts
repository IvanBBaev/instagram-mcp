/**
 * Unit tests for the HTTP transport (Layer `mcp/`): the bind guard, the bearer
 * check, and the per-request server/transport lifecycle. Bind-guard cases pass a
 * minimal stub factory (nothing is ever requested from those servers); the cases
 * that actually speak MCP build a real `McpServer` with one tool. Every accepted
 * bind uses loopback, so these tests open an ephemeral local listener and nothing
 * else — no outbound traffic, no all-interfaces bind.
 *
 * The refusal case deliberately uses 203.0.113.1 (TEST-NET-3, RFC 5737), an
 * address this machine cannot own: if the guard ever regresses, `listen` fails
 * with EADDRNOTAVAIL instead of silently binding a real public interface — and
 * the assertions (InstagramError, kind `validation`) still fail, which is the
 * point of the test.
 *
 * The header-level cases go through {@link send} or a raw socket rather than
 * `fetch`, because the shapes worth testing here — a forged `Host`, a duplicated
 * `Authorization`, a body with no `Content-Type`, half a request line — are
 * exactly the ones a conforming client library refuses to produce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { connect } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import type { AddressInfo, Socket } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  SHUTDOWN_SIGNALS,
  SHUTDOWN_TIMEOUT_MS,
  allowedHostHeaders,
  allowedOrigins,
  bindAddressFor,
  closeOnSignal,
  startHttp,
  startStdio,
} from '../../src/mcp/transport.js';
import type {
  McpServerFactory,
  RunningHttpTransport,
  ShutdownSignal,
  SignalHooks,
} from '../../src/mcp/transport.js';
import { CONFIRM_TIMEOUT_MS } from '../../src/mcp/write-mode.js';
import { InstagramError } from '../../src/core/types.js';
import { isLoopbackHost, loadSettings } from '../../src/core/settings.js';
import type { Logger } from '../../src/core/types.js';

interface LogRecord {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

/** A logger that records instead of writing, so tests can assert on records. */
function recordingLogger(records: LogRecord[]): Logger {
  const push =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      records.push(fields === undefined ? { level, msg } : { level, msg, fields });
    };
  const log: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => log,
  };
  return log;
}

/**
 * A factory of servers that only implement `connect`/`close` — all the transport
 * touches on a request it never answers. Bind-guard tests use this because they
 * never issue a request: a stub never wires `transport.onmessage`, so a real POST
 * to one would hang forever waiting for a JSON-RPC response.
 */
function stubFactory(): { create: McpServerFactory; builds: number; connects: number } {
  const state = { builds: 0, connects: 0 };
  const create = (): McpServer => {
    state.builds += 1;
    const server = {
      connect: async () => {
        state.connects += 1;
      },
      close: async () => undefined,
    };
    return server as unknown as McpServer;
  };
  return {
    create,
    get builds() {
      return state.builds;
    },
    get connects() {
      return state.connects;
    },
  };
}

/**
 * A real, fully-functional server with one trivial tool, so a test can drive the
 * whole MCP surface (`initialize` -> `tools/list` -> `tools/call`) through the
 * transport rather than only the handshake.
 */
function realServer(): McpServer {
  const server = new McpServer({ name: 'transport-test', version: '0.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echo the input back.', inputSchema: { value: z.string() } },
    ({ value }) => ({ content: [{ type: 'text' as const, text: value }] }),
  );
  return server;
}

/**
 * Reserve an ephemeral port and hand it back. Binding then immediately closing
 * is the standard way to learn a free port; the tiny reuse window is acceptable
 * in a test.
 *
 * Most tests here do NOT need it. The DNS-rebinding allowlist is built from the
 * port the socket actually got, so `port: 0` binds and serves; measured
 * 2026-09-23, an `initialize` against a `port: 0` listener is answered 200
 * (CC-PROC-171). This is for the cases that must know the port BEFORE the
 * transport starts — the raw-socket helper, and {@link hasIpv6Loopback}, which
 * asks only whether a bind is possible at all.
 */
async function freePort(host: string): Promise<number> {
  const probe = createServer();
  return await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** True when this machine can bind IPv6 loopback (CI containers often cannot). */
async function hasIpv6Loopback(): Promise<boolean> {
  try {
    await freePort('::1');
    return true;
  } catch {
    return false;
  }
}

/** A minimal, valid `initialize` call — the one request every MCP client makes. */
function initializeBody(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'transport-test', version: '0.0.0' },
    },
  });
}

/** Any other JSON-RPC call. Stateless mode needs no session id on follow-ups. */
function rpcBody(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/** Poll until `ready()` holds, or fail the test with `what` after ~5s. */
async function waitFor(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** POST to a running transport the way an MCP client does. */
async function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
    ...(signal !== undefined ? { signal } : {}),
  });
  return { status: res.status, text: await res.text() };
}

/** Everything {@link send} may override on a hand-built request. */
interface RawRequest {
  method?: string;
  path?: string;
  /** Header lines, overriding the defaults. An array value is sent TWICE. */
  headers?: Record<string, string | string[]>;
  body?: string;
  /** Send a body with NO `Content-Type` at all — something `fetch` cannot do. */
  omitContentType?: boolean;
}

/**
 * A request written header by header. `fetch` derives `Host` from the URL and
 * refuses to override it, normalizes the odd `Authorization` spelling, will not
 * send a header twice and always supplies a `Content-Type` — and every one of
 * those is a shape the checks in this module have to survive, so they go through
 * the raw client. Which is also what an attacker's request looks like on the
 * wire: nothing there is obliged to be well-formed either.
 *
 * Defaults to the honest `Host` for `port`, so a test only spells out the header
 * it is actually about.
 */
async function send(
  port: number,
  init: RawRequest = {},
): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  const { body } = init;
  const headers: Record<string, string | string[] | number> = {
    host: `127.0.0.1:${port}`,
    accept: 'application/json, text/event-stream',
  };
  if (body !== undefined) {
    headers['content-length'] = Buffer.byteLength(body);
    if (init.omitContentType !== true) headers['content-type'] = 'application/json';
  }
  Object.assign(headers, init.headers ?? {});

  return await new Promise<{ status: number; text: string; headers: IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: init.path ?? '/mcp',
          method: init.method ?? 'POST',
          headers,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
        },
      );
      req.once('error', reject);
      req.end(body);
    },
  );
}

/** Open a raw socket to `port`, resolved once it is actually connected. */
async function rawSocket(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

test('startHttp refuses a non-loopback bind with no bearer token', async () => {
  const records: LogRecord[] = [];
  const { create } = stubFactory();

  await assert.rejects(
    () => startHttp(create, { host: '203.0.113.1', port: 0 }, recordingLogger(records)),
    (err: unknown) => {
      assert.ok(err instanceof InstagramError, 'expected an InstagramError, got ' + String(err));
      assert.equal(err.kind, 'validation');
      // The whole line, not two fragments: this is the text an operator acts on,
      // so the host it names must be THEIR host and the advice must be the safe
      // bind — a refusal that printed the port, or told them to bind 0.0.0.0,
      // would still contain both fragments.
      assert.equal(
        err.message,
        'Refusing to start the HTTP transport: bind address "203.0.113.1" is not one of the ' +
          'loopback spellings this transport accepts (127.0.0.0/8, localhost, ::1) and no ' +
          'bearer token is configured, which would expose every tool (including writes) ' +
          'unauthenticated to the network. Bind 127.0.0.1, or set IG_HTTP_TOKEN.',
      );
      return true;
    },
  );
});

test('startHttp refuses 0.0.0.0 without a token before any socket is opened', async () => {
  const records: LogRecord[] = [];
  const factory = stubFactory();

  await assert.rejects(
    () => startHttp(factory.create, { host: '0.0.0.0', port: 0 }, recordingLogger(records)),
    (err: unknown) => {
      assert.ok(err instanceof InstagramError, 'expected an InstagramError, got ' + String(err));
      assert.equal(err.kind, 'validation');
      assert.equal(
        err.message,
        'Refusing to start the HTTP transport: bind address "0.0.0.0" is not one of the ' +
          'loopback spellings this transport accepts (127.0.0.0/8, localhost, ::1) and no ' +
          'bearer token is configured, which would expose every tool (including writes) ' +
          'unauthenticated to the network. Bind 127.0.0.1, or set IG_HTTP_TOKEN.',
      );
      return true;
    },
  );
  // Refused before a server was even built — no transport, no listener, nothing
  // bound.
  assert.equal(factory.builds, 0);
  assert.equal(factory.connects, 0);
});

test('startHttp warns at error level when a loopback bind has no authentication', async () => {
  const records: LogRecord[] = [];
  const running = await startHttp(
    stubFactory().create,
    { host: '127.0.0.1', port: 0 },
    recordingLogger(records),
  );
  try {
    // Exactly one error-level record, pinned whole: the note is the operator's
    // only explanation of what "NO authentication" costs them, so a note that
    // said the opposite (or an extra record) must fail here. `port` is the
    // REQUESTED port (0 here) — the bound one is on the ready line.
    assert.deepEqual(
      records.filter((r) => r.level === 'error'),
      [
        {
          level: 'error',
          msg: 'http transport has NO authentication',
          fields: {
            host: '127.0.0.1',
            port: 0,
            note: 'IG_HTTP_TOKEN is unset — any local process can call every tool, writes included',
          },
        },
      ],
    );
    assert.equal(
      records.some((r) => r.level === 'info' && r.msg === 'mcp server ready'),
      true,
    );
  } finally {
    await running.close();
  }
});

test('startHttp on loopback with a token starts clean and logs no security warning', async () => {
  const records: LogRecord[] = [];
  const running = await startHttp(
    stubFactory().create,
    { host: '127.0.0.1', port: 0, token: 'a-long-enough-bearer' },
    recordingLogger(records),
  );
  try {
    assert.deepEqual(
      records.filter((r) => r.level === 'error'),
      [],
    );
    // ...and the whole stream with it. The filter above bounds the ERROR level
    // alone, so a record added at info, warn or debug is invisible to it — a
    // startup line echoing the bearer back would pass this test unchanged. A
    // clean start is exactly one record. The two dynamic slots are read back
    // off the record itself; both are pinned by value in the `localhost` test
    // further down, which is what makes reading them here safe rather than
    // tautological.
    assert.deepEqual(records, [
      {
        level: 'info',
        msg: 'mcp server ready',
        fields: {
          transport: 'http',
          host: '127.0.0.1',
          boundAddress: records[0]?.fields?.boundAddress,
          port: records[0]?.fields?.port,
        },
      },
    ]);
  } finally {
    await running.close();
  }
});

test('startHttp allows a non-loopback bind once a token is set, but says so at error level', async () => {
  // The guard must not refuse this combination, and must never be silent about
  // it. This is NOT a deployment option: `loadSettings` refuses the host string
  // first, so only a direct caller of `startHttp` reaches this arm — see the
  // containment test below (CC-PROC-175). 203.0.113.1 (TEST-NET-3) cannot be
  // owned by this machine, so if the OS
  // gets as far as `listen` it fails with EADDRNOTAVAIL rather than actually
  // publishing the tool surface on a real interface.
  const records: LogRecord[] = [];
  let running: RunningHttpTransport | undefined;
  let failure: unknown;
  try {
    running = await startHttp(
      stubFactory().create,
      { host: '203.0.113.1', port: 0, token: 'a-long-enough-bearer' },
      recordingLogger(records),
    );
  } catch (err) {
    failure = err;
  }

  try {
    assert.equal(
      failure instanceof InstagramError,
      false,
      `the bind guard must accept a non-loopback host when a token is set, got ${String(failure)}`,
    );
    // Pinned whole (see the loopback twin above): the note must say "beyond this
    // machine", never "only from this machine".
    assert.deepEqual(
      records.filter((r) => r.level === 'error'),
      [
        {
          level: 'error',
          msg: 'http transport is bound to a NON-LOOPBACK address',
          fields: {
            host: '203.0.113.1',
            port: 0,
            note: 'reachable beyond this machine; the bearer token is the only thing protecting it',
          },
        },
      ],
    );
  } finally {
    await running?.close();
  }
});

test('no IG_HTTP_HOST an operator can set reaches that non-loopback arm', () => {
  // The test above exercises a policy that is real in this module and dead in
  // the product. `parseHostEnv` in `core/settings.ts` refuses every non-loopback
  // host string before the transport is built, and it never reads the token, so
  // a bearer cannot buy the bind the arm above grants — the only caller who can
  // reach it is a direct caller of `startHttp`: a test, or an embedder. The
  // blank-token arm is dead the same way, from the other side: `src/index.ts`
  // trims a blank `IG_HTTP_TOKEN` to `undefined`, which is pinned by `a blank
  // IG_HTTP_TOKEN is treated as no authentication, and said so out loud` in
  // test/index.test.ts. Without this pin, both arms read as operator-facing
  // policy — which is exactly what `docs/security.md` §3 claimed until
  // 2026-09-23 (CC-PROC-175).
  assert.equal(isLoopbackHost('203.0.113.1'), false);
  assert.throws(
    () => loadSettings({ IG_HTTP_HOST: '203.0.113.1', IG_HTTP_TOKEN: 'a-long-enough-bearer' }),
    /IG_HTTP_HOST must be one of the loopback spellings/,
    'a bearer must not buy a non-loopback bind through the layer an operator configures',
  );
});

test('startHttp answers 401 for a missing, malformed or wrong bearer and 200 for the exact one', async () => {
  const token = 'correct-horse-battery-staple';
  const port = await freePort('127.0.0.1');
  const records: LogRecord[] = [];
  let builds = 0;
  const running = await startHttp(
    () => {
      builds += 1;
      return realServer();
    },
    { host: '127.0.0.1', port, token },
    recordingLogger(records),
  );
  const url = `http://127.0.0.1:${port}/mcp`;

  try {
    const refused: { name: string; headers: Record<string, string> }[] = [
      { name: 'no Authorization header', headers: {} },
      { name: 'non-Bearer scheme', headers: { authorization: `Basic ${token}` } },
      {
        name: 'wrong token, same length',
        headers: { authorization: `Bearer ${'x'.repeat(token.length)}` },
      },
      { name: 'wrong token, different length', headers: { authorization: 'Bearer short' } },
    ];
    for (const attempt of refused) {
      const res = await post(url, initializeBody(1), attempt.headers);
      assert.equal(res.status, 401, `${attempt.name} must be refused`);
      assert.deepEqual(JSON.parse(res.text), { error: { message: 'Unauthorized' } });
    }

    // A rejected request must cost nothing above the bearer check: no server was
    // built for any of the four attempts above.
    assert.equal(builds, 0, 'a 401 must be answered before any MCP server is built');

    const ok = await post(url, initializeBody(1), { authorization: `Bearer ${token}` });
    assert.equal(ok.status, 200, `the exact bearer must be accepted, body: ${ok.text}`);
    const payload = JSON.parse(ok.text) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(payload.result?.serverInfo?.name, 'transport-test');
    assert.equal(builds, 1);
  } finally {
    await running.close();
  }
});

test('startHttp accepts the bracketed Host header an IPv6 client actually sends', async (t) => {
  if (!(await hasIpv6Loopback())) {
    t.skip('no IPv6 loopback on this machine');
    return;
  }
  // A client talking to `::1` sends `Host: [::1]:<port>`. The DNS-rebinding
  // allowlist is built from the bare bind address, so without the bracketed
  // spellings this request would be rejected as a rebinding attempt.
  const port = await freePort('::1');
  const records: LogRecord[] = [];
  const running = await startHttp(realServer, { host: '::1', port }, recordingLogger(records));

  try {
    const res = await post(`http://[::1]:${port}/mcp`, initializeBody(1));
    assert.equal(res.status, 200, `bracketed IPv6 Host must be allowed, body: ${res.text}`);
    const payload = JSON.parse(res.text) as { result?: { protocolVersion?: string } };
    assert.ok(payload.result?.protocolVersion, 'expected a JSON-RPC initialize result');
  } finally {
    await running.close();
  }
});

/**
 * Every host spelling `loadSettings` accepts, against the two strings the
 * transport derives from it: the address handed to `listen()`, and the `Host`
 * values the DNS-rebinding allowlist will match.
 *
 * Socket-free on purpose, because binding is exactly how these defects hid. An
 * integration test can only ever bind the machine it runs on, and measured
 * 2026-09-23 against a live listener (CC-PROC-171): `IG_HTTP_HOST=LocalHost`
 * answered EVERY request `403 Invalid Host header` (a URL authority is
 * lowercased before it reaches a `Host` header, and the SDK matches the
 * allowlist with `Array.prototype.includes`), and `IG_HTTP_HOST=[::1]` never
 * started at all (`getaddrinfo ENOTFOUND [::1]`) — both spellings pinned as
 * accepted in `test/core/settings.test.ts`, neither reachable from any test
 * here. The bracketed forms had one cover, and it skips itself wherever there
 * is no IPv6 loopback.
 */
const BIND_SPELLINGS: readonly {
  configured: string;
  bind: string;
  hostHeaders: readonly string[];
}[] = [
  { configured: '127.0.0.1', bind: '127.0.0.1', hostHeaders: ['127.0.0.1', '127.0.0.1:4242'] },
  { configured: 'localhost', bind: 'localhost', hostHeaders: ['localhost', 'localhost:4242'] },
  // Kept verbatim by `loadSettings` so the startup log echoes back what was set,
  // which leaves the transport to notice that no client echoes it back.
  {
    configured: 'LocalHost',
    bind: 'LocalHost',
    hostHeaders: ['LocalHost', 'LocalHost:4242', 'localhost', 'localhost:4242'],
  },
  { configured: '::1', bind: '::1', hostHeaders: ['::1', '::1:4242', '[::1]', '[::1]:4242'] },
  // Brackets are URL-authority grammar, not resolver input: they must reach the
  // `Host` allowlist and must not reach `listen()`.
  { configured: '[::1]', bind: '::1', hostHeaders: ['::1', '::1:4242', '[::1]', '[::1]:4242'] },
];

test('every accepted host spelling binds bare and is allowed back in the spellings a client sends', () => {
  for (const { configured, bind, hostHeaders } of BIND_SPELLINGS) {
    assert.equal(
      isLoopbackHost(configured),
      true,
      `${configured} is not a spelling the settings layer accepts, so this row pins nothing`,
    );
    assert.equal(
      bindAddressFor(configured),
      bind,
      `listen() would be handed the wrong address for IG_HTTP_HOST=${configured}`,
    );
    assert.deepEqual(
      allowedHostHeaders([configured], 4242).sort(),
      [...hostHeaders].sort(),
      `the Host allowlist for IG_HTTP_HOST=${configured} is not the set of spellings a client ` +
        'may send; every entry missing here is a 403 on an honest request',
    );
  }
});

test('the Host allowlist names the address the socket got as well as the string configured', () => {
  // The two are not the same thing. `localhost` is resolved by the OS and the
  // ready log prints where it landed — an operator who reads that line and uses
  // the address is not attacking their own machine, but until this was measured
  // they were answered 403 (CC-PROC-171). It widens nothing: a rebinding attack
  // turns on a browser resolving an attacker's NAME to loopback, so the `Host`
  // it sends is that name, never the literal address of a loopback socket.
  assert.deepEqual(
    allowedHostHeaders(['localhost', '::1'], 4242).sort(),
    ['::1', '::1:4242', '[::1]', '[::1]:4242', 'localhost', 'localhost:4242'].sort(),
  );
});

test('the Origin allowlist names each bound name at the bound port and nothing port-less', () => {
  // A port-less `Host` is the same listener; a port-less ORIGIN is not. As an
  // origin `http://127.0.0.1` means a page served on port 80, a different site
  // from this listener exactly as `:<port + 1>` is. Measured before the repair,
  // a live listener answered the first 200 and the second 403.
  assert.deepEqual(allowedOrigins(['127.0.0.1', '127.0.0.1'], 4242), ['http://127.0.0.1:4242']);
  // Spelled the way a browser serializes an origin: lowercased, and IPv6
  // bracketed and compressed, whichever loopback spelling was configured.
  assert.deepEqual(allowedOrigins(['LocalHost', '::1'], 4242), [
    'http://localhost:4242',
    'http://[::1]:4242',
  ]);
  assert.deepEqual(allowedOrigins(['[0:0:0:0:0:0:0:1]'], 4242), ['http://[::1]:4242']);
  // On the scheme's default port a browser omits the port, so the port-less
  // origin is the listener's own there, and the only spelling listed.
  assert.deepEqual(allowedOrigins(['127.0.0.1'], 80), ['http://127.0.0.1']);
});

test('a bind configured in mixed case still answers the Host header a client sends', async () => {
  // Portable: `localhost` resolves everywhere, IPv6 or not. Measured before the
  // repair, this listener came up, logged itself ready, and 403'd every request.
  const records: LogRecord[] = [];
  const running = await startHttp(
    realServer,
    { host: 'LocalHost', port: 0 },
    recordingLogger(records),
  );

  try {
    const ready = records.find((r) => r.msg === 'mcp server ready');
    assert.ok(ready, `expected a readiness line, got ${JSON.stringify(records)}`);
    const port = String(ready.fields?.port);
    const res = await post(`http://localhost:${port}/mcp`, initializeBody(1));
    assert.equal(res.status, 200, `a mixed-case bind must serve a lowercase Host: ${res.text}`);
  } finally {
    await running.close();
  }
});

test('the address the ready log advertises is one a client may actually use', async () => {
  const records: LogRecord[] = [];
  const running = await startHttp(
    realServer,
    { host: 'localhost', port: 0 },
    recordingLogger(records),
  );

  try {
    const ready = records.find((r) => r.msg === 'mcp server ready');
    assert.ok(ready, `expected a readiness line, got ${JSON.stringify(records)}`);
    const address = String(ready.fields?.boundAddress);
    const port = String(ready.fields?.port);
    // `localhost` lands on ::1 or 127.0.0.1 depending on the machine; either way
    // the authority is spelled the way a client would write it.
    const authority = address.includes(':') ? `[${address}]` : address;
    const res = await post(`http://${authority}:${port}/mcp`, initializeBody(1));
    assert.equal(
      res.status,
      200,
      `the ready log advertised ${address} and a request to it was refused: ${res.text}`,
    );
  } finally {
    await running.close();
  }
});

test('a bracketed IPv6 bind address starts the listener at all', async (t) => {
  if (!(await hasIpv6Loopback())) {
    t.skip('no IPv6 loopback on this machine');
    return;
  }
  // `[::1]` is an accepted, documented IG_HTTP_HOST. Measured before the repair,
  // `listen()` raised `getaddrinfo ENOTFOUND [::1]` and the process never came
  // up. This half needs a socket and therefore needs IPv6; BIND_SPELLINGS above
  // holds the same repair on every machine, which is why it is split in two.
  const records: LogRecord[] = [];
  const running = await startHttp(realServer, { host: '[::1]', port: 0 }, recordingLogger(records));

  try {
    const ready = records.find((r) => r.msg === 'mcp server ready');
    assert.ok(ready, `expected a readiness line, got ${JSON.stringify(records)}`);
    const port = String(ready.fields?.port);
    const res = await post(`http://[::1]:${port}/mcp`, initializeBody(1));
    assert.equal(res.status, 200, `a bracketed bind must serve [::1]: ${res.text}`);
  } finally {
    await running.close();
  }
});

test('a Host header with no port is still the bound address, and is allowed', async () => {
  // The allowlist carries the bare address as well as `host:port`, and both
  // forms earn their place. A client omits the port whenever the bound port is
  // the scheme's default (`IG_PORT=80`), which no test can bind unprivileged —
  // but any client may send the portless spelling on any port, and Node hands
  // it through untouched. Dropping the bare form 403s those requests, which
  // reads to the operator as a rebinding attack that never happened.
  const port = await freePort('127.0.0.1');
  const running = await startHttp(realServer, { host: '127.0.0.1', port }, recordingLogger([]));

  try {
    const res = await send(port, {
      headers: { host: '127.0.0.1' },
      body: initializeBody(1),
    });
    assert.equal(res.status, 200, `a portless Host must be allowed: ${res.text}`);

    // It is still an allowlist, not a waved check: a different address with no
    // port is refused exactly like the `host:port` spelling of it would be.
    const forged = await send(port, {
      headers: { host: 'attacker.example' },
      body: initializeBody(2),
    });
    assert.equal(forged.status, 403, `a forged portless Host must be refused: ${forged.text}`);
  } finally {
    await running.close();
  }
});

test('startHttp serves many sequential requests over one running process', async () => {
  // The defect this pins down: a stateless `StreamableHTTPServerTransport` may
  // handle exactly ONE request (SDK: "Stateless transport cannot be reused
  // across requests"), and an `McpServer` cannot be re-connected to a
  // replacement ("Already connected to a transport"). So the transport must
  // build a fresh pair per request — which is what the counters below assert,
  // and what an empty 500 on request #2 used to disprove.
  //
  // Four requests, and deliberately not four of the same: a real client
  // initializes, lists and then calls, so the follow-ups also prove that a
  // brand-new server per request still answers non-`initialize` methods.
  const port = await freePort('127.0.0.1');
  const url = `http://127.0.0.1:${port}/mcp`;
  const records: LogRecord[] = [];
  let builds = 0;
  let closed = 0;
  const running = await startHttp(
    () => {
      builds += 1;
      const server = realServer();
      const close = server.close.bind(server);
      server.close = async () => {
        closed += 1;
        await close();
      };
      return server;
    },
    { host: '127.0.0.1', port },
    recordingLogger(records),
  );

  try {
    const first = await post(url, initializeBody(1));
    assert.equal(first.status, 200, `request #1 failed: ${first.text}`);

    const second = await post(url, initializeBody(2));
    assert.equal(second.status, 200, `request #2 failed with ${second.status}: ${second.text}`);
    const init = JSON.parse(second.text) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(init.result?.serverInfo?.name, 'transport-test');

    const third = await post(url, rpcBody(3, 'tools/list', {}));
    assert.equal(third.status, 200, `request #3 failed with ${third.status}: ${third.text}`);
    const listed = JSON.parse(third.text) as { result?: { tools?: { name: string }[] } };
    assert.deepEqual(
      (listed.result?.tools ?? []).map((t) => t.name),
      ['echo'],
    );

    const fourth = await post(
      url,
      rpcBody(4, 'tools/call', { name: 'echo', arguments: { value: 'still alive' } }),
    );
    assert.equal(fourth.status, 200, `request #4 failed with ${fourth.status}: ${fourth.text}`);
    const called = JSON.parse(fourth.text) as { result?: { content?: { text?: string }[] } };
    assert.equal(called.result?.content?.[0]?.text, 'still alive');

    // One server per request, and every one of them released again — a leak here
    // is a process that accumulates a server per request until it dies.
    assert.equal(builds, 4);
    await waitFor('every per-request server to be closed', () => closed === 4);

    // Nothing above is an error path: the 500 branch must not have been touched.
    assert.deepEqual(
      records.filter((r) => r.msg === 'http request failed'),
      [],
    );
  } finally {
    await running.close();
  }
});

test('a server that fails to build is logged and answered with a stack-free 500', async () => {
  // The only failure mode that reaches `handle`'s catch: building or connecting
  // this request's server. (An error raised inside `handleRequest` is turned
  // into a bodyless 500 by `@hono/node-server` before it can propagate.) The
  // client must get the generic message, the operator must get the real one, and
  // the listener must survive to serve the next request.
  const port = await freePort('127.0.0.1');
  const url = `http://127.0.0.1:${port}/mcp`;
  const records: LogRecord[] = [];
  let builds = 0;
  const running = await startHttp(
    () => {
      builds += 1;
      if (builds === 2) throw new Error('tool registration exploded: secret-ish detail');
      return realServer();
    },
    { host: '127.0.0.1', port },
    recordingLogger(records),
  );

  try {
    assert.equal((await post(url, initializeBody(1))).status, 200);

    const failed = await post(url, initializeBody(2));
    assert.equal(failed.status, 500, `expected a 500, got ${failed.status}: ${failed.text}`);
    assert.deepEqual(JSON.parse(failed.text), { error: { message: 'Internal error' } });
    assert.doesNotMatch(failed.text, /exploded/, 'the client must not see the internal detail');

    const logged = records.find((r) => r.level === 'error' && r.msg === 'http request failed');
    assert.ok(logged, `the failure must be logged, got ${JSON.stringify(records)}`);
    // The field set whole, not `err` alone. This test's subject is a
    // stack-free 500, and `errorMessage` is documented to carry the message and
    // never the stack — a `stack` field added beside `err` is precisely what
    // would undo that, and an equality on one key cannot see a second one
    // appear.
    assert.deepEqual(logged.fields, { err: 'tool registration exploded: secret-ish detail' });

    // One bad request does not poison the listener.
    const after = await post(url, initializeBody(3));
    assert.equal(after.status, 200, `the transport must recover: ${after.text}`);
  } finally {
    await running.close();
  }
});

test('a teardown that throws a bare string still names the value in the log', async () => {
  // Nothing guarantees a rejection is an `Error`: `close()` here belongs to the
  // SDK and to whatever a future embedder swaps in. Reading `.message` off a
  // string yields `undefined`, which would turn a real teardown failure into a
  // log line that says nothing at all.
  const port = await freePort('127.0.0.1');
  const url = `http://127.0.0.1:${port}/mcp`;
  const records: LogRecord[] = [];
  const running = await startHttp(
    () => {
      const server = realServer();
      const close = server.close.bind(server);
      server.close = async () => {
        await close();
        throw 'close threw a string' as unknown as Error;
      };
      return server;
    },
    { host: '127.0.0.1', port },
    recordingLogger(records),
  );

  try {
    assert.equal((await post(url, initializeBody(1))).status, 200);
    await waitFor('the teardown failure to be logged', () =>
      records.some((r) => r.msg === 'http request teardown failed'),
    );
    const logged = records.find((r) => r.msg === 'http request teardown failed');
    // Pinned as a field SET: a record that also carried the stack would still
    // satisfy an equality on `err` alone.
    assert.deepEqual(logged?.fields, { err: 'close threw a string' });
  } finally {
    await running.close();
  }
});

test('shutdown closes an exchange that is still in flight before it stops the listener', async () => {
  // `httpServer.close()` waits for open connections, and a transport still
  // attached to a live exchange is exactly that. If shutdown skipped it, a
  // server with one hung request would never finish closing — the process would
  // sit there on SIGINT instead of exiting.
  const port = await freePort('127.0.0.1');
  const url = `http://127.0.0.1:${port}/mcp`;
  const records: LogRecord[] = [];

  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let wired = false;
  let transportClosed = false;

  const running = await startHttp(
    () => {
      const server = realServer();
      const connect = server.connect.bind(server);
      server.connect = async (transport) => {
        await connect(transport);
        // `Protocol.connect` routes the transport's close through here, so this
        // fires exactly when shutdown closes the in-flight transport.
        server.server.onclose = () => {
          transportClosed = true;
        };
        wired = true;
        // Pin the exchange open: the transport is registered and connected, but
        // the request is never answered.
        await held;
      };
      return server;
    },
    { host: '127.0.0.1', port },
    recordingLogger(records),
  );

  const controller = new AbortController();
  const pending = post(url, initializeBody(1), {}, controller.signal).catch(() => undefined);

  try {
    await waitFor('the exchange to register its transport', () => wired);

    const closing = running.close();
    await waitFor('shutdown to close the in-flight transport', () => transportClosed);

    // Only now let the client's socket go, so the listener had a live connection
    // for the whole of the assertion above.
    controller.abort();
    await closing;
  } finally {
    release();
    await pending;
  }
});

test('a shutdown that cannot close the listener rejects rather than resolving silently', async () => {
  // Closing twice is the cheap way to reach it, but the real case is a listener
  // that is already down. Swallowing the error would report a clean shutdown
  // for a server whose socket may still be held by something else.
  const port = await freePort('127.0.0.1');
  const running = await startHttp(
    stubFactory().create,
    { host: '127.0.0.1', port },
    recordingLogger([]),
  );

  await running.close();

  await assert.rejects(
    () => running.close(),
    (err: unknown) => err instanceof Error && /not running/i.test(err.message),
  );
});

test('a teardown that throws after the response is logged, not left as an unhandled rejection', async () => {
  // `dispose` runs when the response is already on the wire, so a throwing
  // `close()` has nowhere to be reported: unguarded it becomes an unhandled
  // rejection, which under Node's default policy takes the whole server process
  // down on a request that in fact succeeded.
  const port = await freePort('127.0.0.1');
  const url = `http://127.0.0.1:${port}/mcp`;
  const records: LogRecord[] = [];
  const running = await startHttp(
    () => {
      const server = realServer();
      const close = server.close.bind(server);
      server.close = async () => {
        await close();
        throw new Error('close raced the socket');
      };
      return server;
    },
    { host: '127.0.0.1', port },
    recordingLogger(records),
  );

  try {
    const res = await post(url, initializeBody(1));
    assert.equal(res.status, 200, `the exchange itself succeeded: ${res.text}`);

    // Disposal happens on response close, so it lands after the POST resolves.
    await waitFor('the teardown failure to be logged', () =>
      records.some((r) => r.msg === 'http request teardown failed'),
    );
    const logged = records.find((r) => r.msg === 'http request teardown failed');
    assert.equal(
      logged?.level,
      'debug',
      'a post-response teardown is noise, not an operator alarm',
    );
    // The field set, not just `err` — see the bare-string twin above.
    assert.deepEqual(logged?.fields, { err: 'close raced the socket' });

    // And the listener still serves the next client.
    assert.equal((await post(url, initializeBody(2))).status, 200);
  } finally {
    await running.close();
  }
});

test('a forged Host header is refused: DNS-rebinding protection is ON, not merely available', async () => {
  // Without it, any web page the operator visits can have the browser POST to
  // http://127.0.0.1:<port>/mcp — the loopback bind is no boundary at all against
  // a rebound name, and the full write surface is one fetch() away.
  const port = await freePort('127.0.0.1');
  const running = await startHttp(realServer, { host: '127.0.0.1', port }, recordingLogger([]));

  try {
    const forged = await send(port, {
      headers: { host: 'attacker.example' },
      body: initializeBody(1),
    });
    assert.notEqual(forged.status, 200, `a forged Host must not be served: ${forged.text}`);
    assert.equal(forged.status, 403);
    // Known, and left alone: the SDK quotes the offending value back in its 403
    // body. It is JSON-encoded into an `application/json` response by the SDK
    // itself — a reflection with no sink, and nothing this module can sanitize
    // without parsing and rewriting someone else's error format. Pinned so a
    // change in what that body carries is noticed here.
    assert.match(forged.text, /attacker\.example/);

    // ...and the honest Host an MCP client sends is still served.
    const honest = await send(port, { body: initializeBody(2) });
    assert.equal(honest.status, 200, honest.text);
  } finally {
    await running.close();
  }
});

test('startStdio announces readiness only after the connection actually succeeded', async () => {
  // `connect` is what starts serving. Reporting "ready" without awaiting it
  // would log a healthy line over a server that never came up, and turn the
  // failure into an unhandled rejection instead of an error the caller sees.
  const records: LogRecord[] = [];
  const failing = {
    connect: async (): Promise<void> => {
      throw new Error('stdio refused');
    },
    close: async (): Promise<void> => undefined,
  } as unknown as McpServer;

  await assert.rejects(() => startStdio(failing, recordingLogger(records)), /stdio refused/);
  assert.equal(
    records.some((r) => r.msg === 'mcp server ready'),
    false,
    'a failed connect must never be announced as ready',
  );
});

test('a finished exchange leaves the in-flight set instead of accumulating until shutdown', async () => {
  // The set exists so shutdown can end streams nothing else will end. If
  // completed exchanges are never removed it becomes an unbounded leak for the
  // lifetime of the process, and shutdown re-closes every transport it ever
  // served. Counting `close()` calls is how that is visible from outside.
  const port = await freePort('127.0.0.1');
  const url = `http://127.0.0.1:${port}/mcp`;
  const running = await startHttp(realServer, { host: '127.0.0.1', port }, recordingLogger([]));

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalClose = StreamableHTTPServerTransport.prototype.close;
  let closes = 0;
  StreamableHTTPServerTransport.prototype.close = async function (
    this: StreamableHTTPServerTransport,
  ): Promise<void> {
    closes += 1;
    await originalClose.call(this);
  };

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await running.close();
  };

  try {
    for (const id of [1, 2, 3]) {
      assert.equal((await post(url, initializeBody(id))).status, 200);
    }
    await waitFor('all three exchanges to be disposed', () => closes >= 3);
    const afterRequests = closes;

    await shutdown();
    assert.equal(
      closes,
      afterRequests,
      'shutdown re-closed a transport whose exchange had already ended',
    );
  } finally {
    StreamableHTTPServerTransport.prototype.close = originalClose;
    await shutdown();
  }
});

test('the bind guard reads the host as text, so every alias of loopback is refused', async () => {
  // `getaddrinfo` resolves `127.1`, `2130706433` and `127.0.0.1.` to 127.0.0.1,
  // and binds `''` to every interface — the guard sees none of that, only the
  // string the operator wrote. That is the trade this module makes: the aliases
  // are refused (fail-closed, a false alarm at worst) and so, for the same
  // reason, are the spellings that would actually publish the tool surface.
  //
  // `0177.0.0.1` is in the list for the opposite reason, and it is worth the
  // line: measured with `dns.lookup` it is 177.0.0.1, a ROUTABLE address, while
  // `new URL('http://0177.0.0.1/').hostname` reads the octal and answers
  // 127.0.0.1. Two resolvers in the same runtime disagree about whether this
  // string is loopback, so refusing it is not a false alarm at all — it is the
  // only verdict that is safe whichever one ends up doing the binding.
  const aliases = ['0.0.0.0', '::', '', '   ', '127.1', '2130706433', '0177.0.0.1', '127.0.0.1.'];
  for (const host of aliases) {
    const factory = stubFactory();
    await assert.rejects(
      () => startHttp(factory.create, { host, port: 0 }, recordingLogger([])),
      (err: unknown) =>
        err instanceof InstagramError &&
        err.kind === 'validation' &&
        // The wording of the refusal is pinned whole, per spelling, by the test
        // below; what this one needs from the message is only that it IS the
        // bind refusal and not some other validation error raised on the way.
        err.message.startsWith('Refusing to start the HTTP transport: bind address'),
      `"${host}" must be refused without a token`,
    );
    // Refused before a socket could be opened on it, not after.
    assert.equal(factory.builds, 0, `"${host}" reached a server build`);
  }
});

test('the bind refusal names the host spelling the operator actually wrote', async () => {
  // Catches: the interpolated host "tidied" on its way into the refusal, and the
  // refusal reworded for the alias spellings alone. This sentence is not one
  // field of a structured error a caller re-renders — `main().catch` in
  // src/index.ts writes it to stderr as `instagram-mcp-ai failed to start:
  // <message>`, with no stack and no second line, so it is the ONLY thing the
  // operator sees before the process exits 1. The whole clause is therefore
  // behaviour: the host it names has to be the string they configured, and the
  // remedy it gives has to be the safe bind.
  //
  // The two whole-message pins above cover `203.0.113.1` and `0.0.0.0` — both
  // well-formed addresses that survive any amount of cleanup untouched. Every
  // other refused spelling reaches only `/not loopback/`: twelve characters that
  // "the host is not loopback; bind 0.0.0.0 to reach it" would also satisfy. The
  // spellings listed here are precisely the ones an operator is staring at when
  // they read this line, because they are the ones the guard fails closed on
  // even though a resolver would have accepted them.
  //
  // Which is also why the sentence itself changed on 2026-09-23. It used to say
  // the address “is not loopback”, and for four of the spellings below that was
  // simply false: measured with `dns.lookup`, `127.1`, `2130706433` and
  // `127.0.0.1.` all resolve to 127.0.0.1. Telling the operator their loopback
  // address is not loopback sends them to fix an address that is already right;
  // naming the spellings this transport accepts tells them the one thing that
  // ends the problem. (`0177.0.0.1` is the exception that argues for the guard
  // rather than against it — `dns.lookup` gives it 177.0.0.1, a ROUTABLE address,
  // while `new URL` reads the octal and calls it 127.0.0.1. The two disagree, so
  // refusing the spelling outright is the only answer that is safe under both.)
  //
  // Two mutants measured as surviving the whole suite before this test existed,
  // and both are the kind of touch a refactor adds to be helpful:
  // `"${opts.host.trim()}"` prints `IG_HTTP_HOST="   "` as `""`, and
  // `"${opts.host || '(unset)'}"` prints it as `(unset)` — either way the
  // operator is told about a variable they did not set and goes looking in the
  // wrong place for a value they can see in their own config.
  //
  // The sentence is restated here rather than imported from the module, so the
  // comparison is against an independent statement of it and not against itself;
  // `host` goes in with no normalizing, trimming or defaulting of any kind,
  // which is exactly the property under test. Pinning it per spelling also says
  // that every one of them gets the SAME remedy — no alias grows a special case
  // that drops "Bind 127.0.0.1, or set IG_HTTP_TOKEN." on the way past.
  const refusal = (host: string): string =>
    `Refusing to start the HTTP transport: bind address "${host}" is not one of the ` +
    'loopback spellings this transport accepts (127.0.0.0/8, localhost, ::1) and no ' +
    'bearer token is configured, which would expose every tool (including writes) ' +
    'unauthenticated to the network. Bind 127.0.0.1, or set IG_HTTP_TOKEN.';

  // The same spellings as the guard test above, so the two stay in step.
  const spellings = ['0.0.0.0', '::', '', '   ', '127.1', '2130706433', '0177.0.0.1', '127.0.0.1.'];
  for (const host of spellings) {
    await assert.rejects(
      () => startHttp(stubFactory().create, { host, port: 0 }, recordingLogger([])),
      (err: unknown) => {
        assert.ok(
          err instanceof InstagramError,
          `"${host}": expected an InstagramError, got ` + String(err),
        );
        assert.equal(
          err.message,
          refusal(host),
          `the refusal for ${JSON.stringify(host)} is not the sentence the operator acts on`,
        );
        return true;
      },
    );
  }
});

test('the ready log names the address the socket got, not the string that was configured', async () => {
  // `localhost` is the one accepted spelling whose address the resolver decides
  // — ::1 on this machine, 127.0.0.1 on the next, and whatever a doctored hosts
  // file says on a third — and `port: 0` lets the OS pick the port. An operator
  // reading this line needs what is actually listening, not the two placeholders
  // that were asked for.
  const records: LogRecord[] = [];
  const running = await startHttp(
    stubFactory().create,
    { host: 'localhost', port: 0 },
    recordingLogger(records),
  );

  try {
    const ready = records.find((r) => r.msg === 'mcp server ready');
    assert.ok(ready, `expected a readiness line, got ${JSON.stringify(records)}`);
    // The record as a whole: `transport` must say which transport is up (the
    // stdio twin logs the same message), and no field may go missing or be
    // added unnoticed — the two dynamic values are pinned by the checks below.
    assert.deepEqual(ready, {
      level: 'info',
      msg: 'mcp server ready',
      fields: {
        transport: 'http',
        host: 'localhost',
        boundAddress: ready.fields?.boundAddress,
        port: ready.fields?.port,
      },
    });
    const address = String(ready.fields?.boundAddress);
    assert.equal(isLoopbackHost(address), true, `"localhost" resolved off loopback: ${address}`);
    // `address()` reports a numeric address, never a name — so echoing `host`
    // back into this field is exactly the regression this line catches, and it
    // is invisible to the loopback check above because `localhost` passes that
    // too. An operator diagnosing "which interface is this really on?" would be
    // reading their own input back.
    assert.notEqual(
      address,
      'localhost',
      'the ready log echoed the configured host instead of the address that was bound',
    );
    assert.equal(typeof ready.fields?.port, 'number');
    assert.notEqual(
      ready.fields?.port,
      0,
      'the ready log reported the requested port, not the bound one',
    );
  } finally {
    await running.close();
  }
});

test('a blank bearer token is refused at startup instead of counting as authentication', async () => {
  // A blank token is the worst of both answers: `token !== undefined` buys a
  // non-loopback bind, while no request can ever satisfy it (`readBearer` only
  // matches a credential of at least one character, so `bearerMatches` is never
  // even reached with an empty expected value). Left unresolved it is an
  // exposed listener that answers 401 to everybody, including its owner.
  for (const token of ['', '   ', '\t\n']) {
    for (const host of ['127.0.0.1', '203.0.113.1']) {
      const factory = stubFactory();
      await assert.rejects(
        () => startHttp(factory.create, { host, port: 0, token }, recordingLogger([])),
        (err: unknown) => {
          assert.ok(
            err instanceof InstagramError,
            'expected an InstagramError, got ' + String(err),
          );
          assert.equal(err.kind, 'validation');
          // Whole line: the advice ("unset it, or set a real secret") is the part
          // an operator follows, and a rewrite that kept the word "blank" but
          // told them to set the token blank would pass a fragment match.
          assert.equal(
            err.message,
            'Refusing to start the HTTP transport: the configured bearer token is blank. A blank ' +
              'token authenticates nobody — every request is refused — yet it would still count as ' +
              '"a token is set" for the non-loopback bind check. Unset IG_HTTP_TOKEN for an ' +
              'unauthenticated loopback bind, or set a real secret.',
          );
          return true;
        },
        `token ${JSON.stringify(token)} on ${host} must be refused`,
      );
      assert.equal(factory.builds, 0);
    }
  }
});

test('the bearer check follows RFC 7235 on the scheme and stays strict about everything else', async () => {
  const token = 'correct-horse-battery-staple';
  const port = await freePort('127.0.0.1');
  let builds = 0;
  const running = await startHttp(
    () => {
      builds += 1;
      return realServer();
    },
    { host: '127.0.0.1', port, token },
    recordingLogger([]),
  );

  try {
    // RFC 7235 §2.1: the scheme name is case-insensitive and `1*SP` separates it
    // from the credential. A client that writes `bearer` is sending the right
    // secret; 401ing it is our bug, not theirs.
    const accepted: { name: string; value: string | string[] }[] = [
      { name: 'lower-case scheme', value: `bearer ${token}` },
      { name: 'mixed-case scheme', value: `BeArEr ${token}` },
      { name: 'more than one separating space', value: `Bearer   ${token}` },
      // Node keeps the FIRST `Authorization` line and discards the rest (it is a
      // discard-duplicates field, not a comma-joined one), so a smuggled second
      // header cannot displace an honest first one.
      {
        name: 'duplicated header, correct one first',
        value: [`Bearer ${token}`, 'Bearer nonsense'],
      },
      // Measured, and it belongs on this side: the anchor in `readBearer` never
      // sees this leading space, because Node's parser strips the optional
      // whitespace around a field value (RFC 7230 §3.2.4) before the header ever
      // reaches us. The anchor still earns its place — see the buried-scheme
      // case below, which no parser strips.
      { name: 'a leading space the HTTP parser strips', value: ` Bearer ${token}` },
      // Same rule at the other end: trailing OWS never reaches `bearerMatches`
      // either, so `Bearer <token> ` is the exact credential on the wire. The
      // whitespace the server DOES see — inside the value — is in the refused
      // list below.
      { name: 'a trailing space the HTTP parser strips', value: `Bearer ${token} ` },
    ];
    for (const { name, value } of accepted) {
      const res = await send(port, { headers: { authorization: value }, body: initializeBody(1) });
      assert.equal(res.status, 200, `${name} must be accepted, got ${res.status}: ${res.text}`);
    }

    const refused: { name: string; value: string | string[] }[] = [
      // ...and by the same rule a correct second header cannot rescue a wrong first.
      {
        name: 'duplicated header, correct one second',
        value: ['Bearer nonsense', `Bearer ${token}`],
      },
      // A tab is not `SP`: RFC 7235 allows spaces only between scheme and credential.
      { name: 'tab between scheme and credential', value: `Bearer\t${token}` },
      { name: 'scheme with no credential', value: 'Bearer' },
      { name: 'credential with no scheme', value: token },
      { name: 'another scheme entirely', value: `Basic ${token}` },
      // `1*SP`, not `*SP`: the scheme run together with the credential is not a
      // credential this server has ever issued, and `Bearer` is a prefix of
      // nothing it would accept either.
      { name: 'scheme run together with the credential', value: `Bearer${token}` },
      // The scheme has to be at the START of the value. Without the anchor,
      // `Bearer <token>` buried inside any other credential authenticates: a
      // header the server would otherwise refuse outright becomes a way in.
      { name: 'the scheme buried inside another credential', value: `Basic Bearer ${token}` },
      { name: 'the token as a prefix of the credential', value: `Bearer ${token}-extra` },
      // The SCHEME is case-insensitive; the credential is not. An ASCII secret
      // with its case changed is a different secret — and this is the only
      // fixture that says so with plain ASCII (the non-ASCII test below happens
      // to catch a case-folding compare too, but only through mojibake).
      { name: 'the credential with its case changed', value: `Bearer ${token.toUpperCase()}` },
      { name: 'whitespace inside the credential', value: `Bearer ${token} x` },
    ];
    for (const { name, value } of refused) {
      const res = await send(port, { headers: { authorization: value }, body: initializeBody(2) });
      assert.equal(res.status, 401, `${name} must be refused, got ${res.status}: ${res.text}`);
    }

    // Only the four accepted requests ever reached the MCP layer.
    assert.equal(builds, accepted.length);
  } finally {
    await running.close();
  }
});

test('a bearer that is not ASCII matches on the bytes the client actually sent', async () => {
  // Node decodes an incoming header value as latin1 — one character per wire
  // byte — while `process.env` arrives already decoded as UTF-8. Comparing the
  // two as UTF-8 buffers measures the same secret as 18 bytes on one side and
  // 15 on the other, so a token like this one could never authenticate anybody:
  // the client sending exactly the right credential got a 401 and no way to
  // find out why. `bearerMatches` therefore encodes each side the way it
  // arrived, and this test pins down what "the way it arrived" actually is.
  const token = 'pärola-tökén-42';

  // The fixture has to be non-ASCII in a way that makes the two encodings
  // differ, or the test proves nothing. Three characters are two bytes each.
  assert.equal(token.length, 15, 'the token must be 15 characters');
  assert.equal(Buffer.byteLength(token, 'utf8'), 18, 'and 18 bytes as UTF-8');

  const port = await freePort('127.0.0.1');
  const running = await startHttp(
    realServer,
    { host: '127.0.0.1', port, token },
    recordingLogger([]),
  );

  try {
    // Measured, not assumed: `send` passes the header as a JS string and then
    // calls `req.end(body)` with a string body, and `OutgoingMessage` writes the
    // header block and that body to the socket in a single write using the
    // body's encoding. A utf8 body therefore re-encodes the header block as
    // UTF-8, which is exactly what every real client puts on the wire. The
    // server latin1-decodes those 18 bytes back into 18 characters, and
    // `Buffer.from(provided, 'latin1')` recovers the original UTF-8 bytes.
    const ok = await send(port, {
      headers: { authorization: `Bearer ${token}` },
      body: initializeBody(1),
    });
    assert.equal(ok.status, 200, `the real credential must be accepted: ${ok.text}`);

    // And the byte-for-byte comparison is still a comparison. Pre-encoding the
    // token into the latin1 spelling of its own UTF-8 bytes is a different
    // secret: those 18 characters get re-encoded as UTF-8 in turn, so 24 bytes
    // reach the server. No client sends that, and it must not authenticate.
    const doubled = Buffer.from(token, 'utf8').toString('latin1');
    assert.equal(Buffer.byteLength(doubled, 'utf8'), 24, 'the mangled form is 24 bytes');
    const mangled = await send(port, {
      headers: { authorization: `Bearer ${doubled}` },
      body: initializeBody(2),
    });
    assert.equal(mangled.status, 401, `different bytes must not authenticate: ${mangled.text}`);
  } finally {
    await running.close();
  }
});

test('a cross-origin browser POST is refused even though its Host is the bound address', async () => {
  // The `Host` check is no defence against the browser of an operator who
  // visits a hostile page: that request's Host IS `127.0.0.1:<port>`, because the
  // browser really is talking to this listener. `Origin` is the only header that
  // gives the cross-site call away, and the SDK looks at it only when
  // `allowedOrigins` is non-empty — an empty list is not "allow none", it is
  // "do not check".
  const port = await freePort('127.0.0.1');
  const running = await startHttp(realServer, { host: '127.0.0.1', port }, recordingLogger([]));

  try {
    const evil = await send(port, {
      headers: { origin: 'https://evil.example' },
      body: initializeBody(1),
    });
    assert.equal(evil.status, 403, `a cross-origin POST must be refused: ${evil.text}`);

    // Near misses of the allowed origin are still cross-origin: the allowlist is
    // `http://<host>:<port>` — exact strings. A different scheme, the same
    // loopback under another name, a suffixed host, a different port or no port
    // at all (a page on port 80) each names a different origin in the browser's
    // eyes, and a prefix/`startsWith`/`https`-tolerant match would let the first
    // two in.
    const nearMisses = [
      'http://127.0.0.1',
      `https://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}.evil.example`,
      `http://127.0.0.1:${port + 1}`,
      `HTTP://127.0.0.1:${port}`,
    ];
    for (const origin of nearMisses) {
      const res = await send(port, { headers: { origin }, body: initializeBody(1) });
      assert.equal(res.status, 403, `origin ${origin} must be refused, got ${res.status}`);
    }

    // The same-origin value a page served by this listener would send is allowed...
    const same = await send(port, {
      headers: { origin: `http://127.0.0.1:${port}` },
      body: initializeBody(2),
    });
    assert.equal(same.status, 200, same.text);

    // ...and so is a request with no `Origin` at all, which is every non-browser
    // MCP client there is. Turning the check on must cost them nothing.
    const none = await send(port, { body: initializeBody(3) });
    assert.equal(none.status, 200, none.text);
  } finally {
    await running.close();
  }
});

test('an ephemeral bind serves the port it actually got, not the 0 it asked for', async () => {
  // The rebinding allowlist is built from the bound port. Built from the
  // requested one, a `port: 0` listener would accept only `Host: 127.0.0.1:0` —
  // a header no client can send — and 403 every honest request while looking
  // perfectly healthy in the log.
  const records: LogRecord[] = [];
  const running = await startHttp(
    realServer,
    { host: '127.0.0.1', port: 0 },
    recordingLogger(records),
  );

  try {
    const ready = records.find((r) => r.msg === 'mcp server ready');
    const port = ready?.fields?.port;
    assert.equal(typeof port, 'number');
    assert.notEqual(port, 0);
    const res = await post(`http://127.0.0.1:${String(port)}/mcp`, initializeBody(1));
    assert.equal(res.status, 200, `an ephemeral bind must serve its real port: ${res.text}`);
  } finally {
    await running.close();
  }
});

test('shutdown does not wait out a socket that sent half a request and stopped', async () => {
  // `httpServer.close()` stops accepting and drops idle keep-alive sockets, but
  // it waits for any socket that is mid-request — and "mid-request" includes one
  // that wrote a request line and then nothing at all. Opening one needs no
  // credential, so a single such socket pins shutdown for the whole
  // `headersTimeout`: SIGINT, then a minute of a process that will not die.
  const port = await freePort('127.0.0.1');
  const running = await startHttp(
    stubFactory().create,
    { host: '127.0.0.1', port },
    recordingLogger([]),
  );

  const socket = await rawSocket(port);
  try {
    // Half a request: headers begun, never terminated.
    socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    await new Promise((r) => setTimeout(r, 50));

    const started = Date.now();
    await running.close();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `shutdown waited ${elapsed}ms on a half-sent request`);
  } finally {
    socket.destroy();
  }
});

test('an exchange the client abandons mid-stream is disposed, not held until shutdown', async () => {
  // A GET opens an event stream the SDK holds open for as long as the client
  // wants it, and nothing else in the process ever ends it. If disposal only ran
  // on a completed response, every client that walked away would leave a server
  // and a transport behind for the lifetime of the process.
  const port = await freePort('127.0.0.1');
  let closed = 0;
  const running = await startHttp(
    () => {
      const server = realServer();
      const close = server.close.bind(server);
      server.close = async () => {
        closed += 1;
        await close();
      };
      return server;
    },
    { host: '127.0.0.1', port },
    recordingLogger([]),
  );

  const socket = await rawSocket(port);
  let received = '';
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });

  try {
    socket.write(
      `GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`,
    );
    await waitFor('the event stream to open', () => received.includes('200'));

    // The client goes away without ending the stream politely.
    socket.destroy();
    await waitFor('the abandoned exchange to be disposed', () => closed === 1);
  } finally {
    socket.destroy();
    await running.close();
  }
});

test('the request surface: nothing routes on the path, and the SDK answers the odd verbs', async () => {
  // Pinned, not endorsed: every check in this module runs before any of this, so
  // the shapes below are the SDK's, and a version bump that changes one should
  // fail here rather than in someone's client. The first case is the one that
  // matters — no path is special, so the bearer check is the only thing between
  // a request and the tool surface whatever URL it names.
  const port = await freePort('127.0.0.1');
  const running = await startHttp(realServer, { host: '127.0.0.1', port }, recordingLogger([]));

  try {
    const anyPath = await send(port, { path: '/anything/at/all?x=1', body: initializeBody(1) });
    assert.equal(anyPath.status, 200, `every path is the MCP endpoint: ${anyPath.text}`);

    const cases: { name: string; init: RawRequest; expected: number }[] = [
      { name: 'OPTIONS', init: { method: 'OPTIONS' }, expected: 405 },
      { name: 'PUT', init: { method: 'PUT', body: initializeBody(2) }, expected: 405 },
      // Stateless mode has no session to end, and the SDK says so with a 200.
      { name: 'DELETE', init: { method: 'DELETE' }, expected: 200 },
      {
        name: 'GET that will not take an event stream',
        init: { method: 'GET', headers: { accept: 'application/json' } },
        expected: 406,
      },
      {
        name: 'POST with no Content-Type',
        init: { body: initializeBody(3), omitContentType: true },
        expected: 415,
      },
      {
        name: 'POST with the wrong Content-Type',
        init: { body: initializeBody(4), headers: { 'content-type': 'text/plain' } },
        expected: 415,
      },
      {
        name: 'POST with a body that is not JSON',
        init: { body: 'not json at all' },
        expected: 400,
      },
    ];
    for (const { name, init, expected } of cases) {
      const res = await send(port, init);
      assert.equal(res.status, expected, `${name}: got ${res.status} — ${res.text}`);
    }
  } finally {
    await running.close();
  }
});

test('the bearer check runs before the SDK does, on every verb and every path', async () => {
  // The test above pins what the SDK answers for these shapes on a token-less
  // listener, and the claim that the bearer is "the only thing between a request
  // and the tool surface" sat next to it as prose. This measures it: with a
  // token configured, every one of those shapes must be answered 401 by this
  // module instead of 200/405/406/415/400 by the SDK. Each case is sent twice,
  // so a 401 that came from something other than the missing credential would
  // show up as the authorized half failing too.
  const token = 'correct-horse-battery-staple';
  const port = await freePort('127.0.0.1');
  const running = await startHttp(
    realServer,
    { host: '127.0.0.1', port, token },
    recordingLogger([]),
  );

  try {
    // `expected` is what the SDK answers once the credential is right. Not one
    // of them is a 401, so no case here can pass by accident.
    const cases: { name: string; init: RawRequest; expected: number }[] = [
      {
        name: 'POST to a path that is not /mcp',
        init: { path: '/anything/at/all?x=1', body: initializeBody(1) },
        expected: 200,
      },
      { name: 'OPTIONS', init: { method: 'OPTIONS' }, expected: 405 },
      { name: 'PUT', init: { method: 'PUT', body: initializeBody(2) }, expected: 405 },
      // DELETE is the case that matters most: stateless mode has no session to
      // end and answers 200, so a check that only covered POST would serve it
      // to anybody who found the port.
      { name: 'DELETE', init: { method: 'DELETE' }, expected: 200 },
      {
        name: 'GET that will not take an event stream',
        init: { method: 'GET', headers: { accept: 'application/json' } },
        expected: 406,
      },
      {
        name: 'POST with no Content-Type',
        init: { body: initializeBody(3), omitContentType: true },
        expected: 415,
      },
      {
        name: 'POST with a body that is not JSON',
        init: { body: 'not json at all' },
        expected: 400,
      },
    ];

    for (const { name, init, expected } of cases) {
      const anonymous = await send(port, init);
      assert.equal(anonymous.status, 401, `${name} must be refused: got ${anonymous.status}`);
      assert.equal(anonymous.text, JSON.stringify({ error: { message: 'Unauthorized' } }));

      const authorized = await send(port, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
      });
      assert.equal(
        authorized.status,
        expected,
        `${name} with the credential must reach the SDK: ${authorized.status} — ${authorized.text}`,
      );
    }
  } finally {
    await running.close();
  }
});

test('a refusal from this module says the same thing no matter what the client sent', async () => {
  // The 401 body is a constant, and it has to stay one: it is written before the
  // request is understood, so anything it quoted would be attacker-controlled
  // text in an operator's log viewer or an error banner. The only reflection on
  // this port is the SDK's own rebinding 403, pinned in the forged-Host test.
  const port = await freePort('127.0.0.1');
  const running = await startHttp(
    realServer,
    { host: '127.0.0.1', port, token: 'correct-horse-battery-staple' },
    recordingLogger([]),
  );

  try {
    const res = await send(port, {
      headers: { authorization: 'Bearer "><script>alert(1)</script>' },
      body: initializeBody(1),
    });
    assert.equal(res.status, 401);
    assert.equal(res.text, JSON.stringify({ error: { message: 'Unauthorized' } }));
    assert.doesNotMatch(res.text, /script/);
    // The body is JSON, so the header has to say so. An MCP client parses the
    // refusal to learn WHY it was refused; labelled `text/plain` the JSON-RPC
    // client either skips parsing it or hands the operator a raw brace-string,
    // and a browser that reached this port would render the attacker's quoted
    // text as a document instead of downloading it as data.
    assert.equal(res.headers['content-type'], 'application/json');
  } finally {
    await running.close();
  }
});

test('the stdio readiness line names the transport that is actually serving', async () => {
  // The two transports are mutually exclusive and one of them owns stdout: on
  // stdio nothing but the protocol may be written there, on HTTP a port is
  // listening. This line is the only record of which one a session came up on,
  // and it is what an operator greps when a client sees no server at all — a
  // line that names the wrong one sends them to look for a port that was never
  // opened. The stub server never starts the transport, so nothing here reads
  // the real stdin.
  const records: LogRecord[] = [];
  const server = {
    connect: async (): Promise<void> => undefined,
    close: async (): Promise<void> => undefined,
  } as unknown as McpServer;

  await startStdio(server, recordingLogger(records));

  const ready = records.filter((r) => r.msg === 'mcp server ready');
  assert.equal(ready.length, 1, 'exactly one readiness line');
  assert.deepEqual(ready[0]?.fields, { transport: 'stdio' });
  // And the WHOLE stream with it, not only the lines carrying this message. A
  // `.filter()` in front of the pin narrows what the assertion can see to one
  // `msg`, so a record ADDED under any other message passes it untouched — the
  // same blind spot the write gate's info stream had. Stdio is where an extra
  // line costs the most: stdout is reserved for the protocol, so stderr is the
  // operator's only channel and every record lands in the one place they watch.
  assert.deepEqual(records, [
    { level: 'info', msg: 'mcp server ready', fields: { transport: 'stdio' } },
  ]);
});

test('the stdio readiness line is emitted at info, so a default run still prints it', async () => {
  // `IG_LOG_LEVEL` defaults to `info` and core/log.ts drops every record below
  // the threshold, so the level chosen here decides whether this line exists at
  // all for the operator who never set the variable. Demoted to `debug` it
  // disappears from a default run while every other signal stays identical:
  // stdout is reserved for the protocol, no port is listening, and the process
  // just sits there. An operator grepping stderr for "mcp server ready" then
  // reads the silence as a server that never came up and goes hunting for a
  // crash that never happened. The whole record is pinned — level, message and
  // fields — because the test above asserts `fields` alone, which a debug-level
  // line satisfies unchanged. The HTTP twin is pinned this way already.
  const records: LogRecord[] = [];
  const server = {
    connect: async (): Promise<void> => undefined,
    close: async (): Promise<void> => undefined,
  } as unknown as McpServer;

  await startStdio(server, recordingLogger(records));

  const ready = records.filter((r) => r.msg === 'mcp server ready');
  assert.equal(ready.length, 1, 'exactly one readiness line');
  assert.deepEqual(ready[0], {
    level: 'info',
    msg: 'mcp server ready',
    fields: { transport: 'stdio' },
  });
});

/** A stdout whose peer has gone: every write fails the way a closed pipe does. */
function deadPipe(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback): void {
      callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    },
  });
}

/** One newline-delimited JSON-RPC frame, as a stdio client writes it. */
function frame(message: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;
}

test('a client that closes stdout does not kill the calls still in flight', async () => {
  // The SDK's stdio transport listens for `'error'` on stdin only. A client that
  // exits leaves stdout a dead pipe, and the next response written there fails
  // with EPIPE as an `'error'` EVENT; unheard, that is an uncaught exception and
  // the process dies mid-call. Measured on the built entry: an applied write
  // whose Graph POST was already sent lost its journal line that way, because a
  // concurrent read answered first. Here the slow tool stands for that write: it
  // must be allowed to finish after the pipe is gone.
  const records: LogRecord[] = [];
  const server = new McpServer({ name: 'transport-test', version: '0.0.0' });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let finished = false;
  server.registerTool('slow', { description: 'Finish when released.' }, async () => {
    await gate;
    finished = true;
    return { content: [{ type: 'text' as const, text: 'done' }] };
  });
  const stdin = new PassThrough();
  const stdout = deadPipe();

  await startStdio(server, recordingLogger(records), { stdin, stdout });
  stdin.write(
    frame({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    }) + frame({ id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } }),
  );
  // Let the failed initialize response surface as the stream's `'error'` event.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // The transport let go of stdin, so the process can exit once work drains...
  assert.equal(stdin.listenerCount('data'), 0, 'stdin is no longer read');
  // ...but the call that was already running is not cut short.
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, true, 'the in-flight call ran to completion');
  // One line for the departure, however many responses follow it onto the pipe.
  stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.deepEqual(
    records.filter((r) => r.level === 'warn'),
    [
      {
        level: 'warn',
        msg: 'mcp client closed stdout; finishing in-flight calls, then exiting',
        fields: { transport: 'stdio' },
      },
    ],
  );
  await server.close();
});

test('a stdout failure that is not a closed pipe still reaches Node untouched', async () => {
  // Only the stream-lifecycle codes are survivable. Anything else — a full disk
  // on a redirected stdout — must fail exactly as it would with no listener.
  const records: LogRecord[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const server = realServer();
  await startStdio(server, recordingLogger(records), { stdin, stdout });

  const full = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  assert.throws(() => stdout.emit('error', full), /no space left/);
  assert.equal(stdin.listenerCount('data'), 1, 'the session keeps reading stdin');
  assert.equal(
    records.some((r) => r.level === 'warn'),
    false,
  );
  await server.close();
});

/** Collects what the server writes to stdout, one parsed JSON-RPC frame per line. */
function frameSink(): { stdout: PassThrough; frames: Record<string, unknown>[] } {
  const stdout = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  let buffer = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts)
      if (part !== '') frames.push(JSON.parse(part) as Record<string, unknown>);
  });
  return { stdout, frames };
}

test('stdin EOF closes the transport, so a pending confirmation prompt fails at once', async () => {
  // CC-PROC-206. The SDK transport never listens for `'end'`, so EOF used to
  // leave every server→client request pending on its own timer: a write parked
  // at the confirmation prompt held the process for the whole 120 s budget,
  // waiting for an answer from a client that had already gone. The tool below
  // asks exactly the way `serverConfirmer` does, with that budget; after EOF
  // the ask must reject with ConnectionClosed (which the write gate reads as a
  // refusal) on the next turn of the loop, not two minutes later.
  const records: LogRecord[] = [];
  const server = new McpServer({ name: 'transport-test', version: '0.0.0' });
  let outcome: Promise<string> | undefined;
  server.registerTool('ask', { description: 'Ask the client to confirm.' }, () => {
    outcome = server.server
      .elicitInput(
        {
          mode: 'form',
          message: 'confirm?',
          requestedSchema: {
            type: 'object',
            properties: { confirm: { type: 'boolean' } },
            required: ['confirm'],
          },
        },
        { timeout: CONFIRM_TIMEOUT_MS, maxTotalTimeout: CONFIRM_TIMEOUT_MS },
      )
      .then(
        () => 'answered',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    return outcome.then((text) => ({ content: [{ type: 'text' as const, text }] }));
  });
  let closes = 0;
  server.server.onclose = () => void closes++;
  const stdin = new PassThrough();
  const { stdout, frames } = frameSink();

  await startStdio(server, recordingLogger(records), { stdin, stdout });
  stdin.write(
    frame({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: { elicitation: {} },
        clientInfo: { name: 't', version: '0' },
      },
    }) +
      frame({ method: 'notifications/initialized' }) +
      frame({ id: 2, method: 'tools/call', params: { name: 'ask', arguments: {} } }),
  );
  await waitFor('the confirmation request to reach the client', () =>
    frames.some((f) => f.method === 'elicitation/create'),
  );

  stdin.end();
  // No clock is advanced and nothing waits on a timer: if the ask settles at
  // all here, it settled because the transport closed, not because it timed out.
  try {
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      outcome,
      new Promise<string>((resolve) => (timer = setTimeout(() => resolve('still pending'), 1_000))),
    ]).finally(() => clearTimeout(timer));
    assert.match(settled ?? '', /Connection closed/);
    assert.equal(stdin.listenerCount('data'), 0, 'stdin is no longer read');
    // The call it interrupted gets no response: the client that sent it is gone.
    assert.equal(
      frames.some((f) => f.id === 2),
      false,
    );
    assert.deepEqual(records.slice(-1), [
      {
        level: 'info',
        msg: 'mcp client closed stdin; finishing in-flight calls, then exiting',
        fields: { transport: 'stdio' },
      },
    ]);

    // A client that shuts both ends closes the transport once, not twice.
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.equal(closes, 1, 'the second door must not close the transport again');
    assert.equal(records.filter((r) => r.level === 'warn').length, 1);
  } finally {
    // A regression must fail this test, not hold the file open for the 120 s
    // the prompt would otherwise wait.
    await server.close();
  }
});

test('a stdin closed without EOF closes the transport too, and logs once', async () => {
  // A reset pipe or a destroyed stream emits `'close'` and never `'end'`; left
  // unhandled, it would leave the same pending prompts as the EOF above.
  const records: LogRecord[] = [];
  const server = new McpServer({ name: 'transport-test', version: '0.0.0' });
  let closes = 0;
  server.server.onclose = () => void closes++;
  const stdin = new PassThrough();
  const { stdout } = frameSink();
  await startStdio(server, recordingLogger(records), { stdin, stdout });
  try {
    stdin.destroy();
    await waitFor('the transport to close', () => closes === 1);
    const gone = records.filter((r) => r.msg.startsWith('mcp client closed stdin'));
    assert.equal(gone.length, 1);
    assert.equal(stdin.listenerCount('data'), 0, 'stdin is no longer read');
    // A later stdout failure finds the transport already closed.
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.equal(closes, 1);
  } finally {
    await server.close();
  }
});

test('the close that follows a clean EOF does not log the departure a second time', async () => {
  const records: LogRecord[] = [];
  const server = new McpServer({ name: 'transport-test', version: '0.0.0' });
  const stdin = new PassThrough();
  const { stdout } = frameSink();
  await startStdio(server, recordingLogger(records), { stdin, stdout });
  try {
    const closed = new Promise<void>((resolve) => stdin.once('close', () => resolve()));
    stdin.end();
    stdin.resume();
    await closed;
    const gone = records.filter((r) => r.msg.startsWith('mcp client closed stdin'));
    assert.equal(gone.length, 1);
  } finally {
    await server.close();
  }
});

test('a failure raised after the exchange answered does not write a second response', async () => {
  // The handler's catch-all writes a 500, and `res.headersSent` is what stops it
  // from doing that to a response that is already out the door. Node throws
  // `ERR_HTTP_HEADERS_SENT` from `writeHead` in that case — inside the catch
  // block, where nothing is left to catch it — so the guard is the difference
  // between one logged failure and an unhandled rejection that takes the whole
  // server process down with it (Node 22 exits on one by default). The SDK
  // normally absorbs errors raised inside `handleRequest`, so the only way to
  // reach the guard is to make that call itself throw after answering.
  const port = await freePort('127.0.0.1');
  const records: LogRecord[] = [];
  const running = await startHttp(
    realServer,
    { host: '127.0.0.1', port },
    recordingLogger(records),
  );

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
  StreamableHTTPServerTransport.prototype.handleRequest = async (
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answered: 'by the exchange' }));
    throw new Error('the exchange failed after it had answered');
  };

  const rejections: string[] = [];
  const onRejection = (err: unknown): void => {
    rejections.push(err instanceof Error ? err.message : String(err));
  };
  process.on('unhandledRejection', onRejection);

  try {
    const res = await post(`http://127.0.0.1:${port}/mcp`, initializeBody(1));
    assert.equal(res.status, 200);
    assert.equal(res.text, JSON.stringify({ answered: 'by the exchange' }));
    await waitFor('the failure to be logged', () =>
      records.some((r) => r.msg === 'http request failed'),
    );
    // A rejection surfaces at the end of the tick that produced it; two turns of
    // the loop is more than enough for one that never has to cross a socket.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      rejections,
      [],
      'answering a response that was already sent escaped the handler as an unhandled rejection',
    );
  } finally {
    process.off('unhandledRejection', onRejection);
    StreamableHTTPServerTransport.prototype.handleRequest = originalHandleRequest;
    await running.close();
  }
});

// --- Signal-driven shutdown (CC-PROC-204) ----------------------------------

/**
 * {@link SignalHooks} that record instead of acting: `fire` delivers a signal
 * to whatever `closeOnSignal` registered, and `exits` is every code it asked the
 * process to exit with. No real signal ever reaches the test runner.
 */
function fakeSignals(): SignalHooks & {
  fire(signal: ShutdownSignal): void;
  exits: number[];
  registered: ShutdownSignal[];
} {
  const listeners = new Map<ShutdownSignal, () => void>();
  const exits: number[] = [];
  return {
    on: (signal, listener) => void listeners.set(signal, listener),
    exit: (code) => void exits.push(code),
    fire: (signal) => listeners.get(signal)?.(),
    exits,
    get registered() {
      return [...listeners.keys()];
    },
  };
}

/** A transport handle whose `close()` settles only when the test says so. */
function heldClose(): RunningHttpTransport & {
  calls: number;
  resolve(): void;
  reject(err: unknown): void;
} {
  let settle: { resolve(): void; reject(err: unknown): void } = {
    resolve: () => {},
    reject: () => {},
  };
  const pending = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  const handle = {
    calls: 0,
    close: () => {
      handle.calls += 1;
      return pending;
    },
    resolve: () => settle.resolve(),
    reject: (err: unknown) => settle.reject(err),
  };
  return handle;
}

test('SIGTERM and SIGINT each run the graceful close once and exit 0', async () => {
  // The defect this pins: `src/index.ts` used to drop the handle `startHttp`
  // returns, so a stopped HTTP server died at the signal and none of the
  // teardown `close()` carries (CC-PROC-33) ever ran outside a test.
  assert.deepEqual([...SHUTDOWN_SIGNALS], ['SIGTERM', 'SIGINT']);
  // CC-PROC-3 and CC-PROC-204 promise operators a 10 s bound on the teardown.
  assert.equal(SHUTDOWN_TIMEOUT_MS, 10_000);
  for (const signal of SHUTDOWN_SIGNALS) {
    const records: LogRecord[] = [];
    const running = await startHttp(
      stubFactory().create,
      { host: '127.0.0.1', port: 0, token: 'signal-test-bearer' },
      recordingLogger(records),
    );
    let closes = 0;
    const counted: RunningHttpTransport = {
      close: () => {
        closes += 1;
        return running.close();
      },
    };
    const hooks = fakeSignals();
    closeOnSignal(counted, recordingLogger(records), hooks);
    assert.deepEqual(hooks.registered, ['SIGTERM', 'SIGINT']);
    assert.equal(closes, 0, 'registering must not close anything');

    hooks.fire(signal);
    await waitFor(`${signal} to reach exit`, () => hooks.exits.length > 0);

    assert.deepEqual(hooks.exits, [0], `${signal}: a clean operator stop exits 0`);
    assert.equal(closes, 1);
    assert.deepEqual(
      records.filter((r) => /shutdown|transport closed/.test(r.msg)),
      [
        {
          level: 'info',
          msg: 'shutdown signal received; closing the http transport',
          fields: { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS },
        },
        { level: 'info', msg: 'http transport closed; exiting', fields: { signal } },
      ],
    );
    // The close was the real one: the listener is gone.
    await assert.rejects(() => running.close(), /not running/i);
  }
});

test('a second signal while the close runs exits at once with 128 + signo', async () => {
  for (const [first, second, code] of [
    ['SIGTERM', 'SIGTERM', 143],
    ['SIGTERM', 'SIGINT', 130],
    ['SIGINT', 'SIGTERM', 143],
  ] as const) {
    const records: LogRecord[] = [];
    const running = heldClose();
    const hooks = fakeSignals();
    closeOnSignal(running, recordingLogger(records), hooks, 60_000);

    hooks.fire(first);
    assert.deepEqual(hooks.exits, [], 'the first signal waits for the close');
    hooks.fire(second);
    assert.deepEqual(hooks.exits, [code], `${first} then ${second}`);
    assert.equal(running.calls, 1, 'the second signal must not start a second close');
    assert.deepEqual(records.at(-1), {
      level: 'warn',
      msg: 'second shutdown signal; exiting without waiting for the http transport',
      fields: { signal: second },
    });

    // The close settling afterwards reports nothing further: the process is gone.
    // This also proves the forced exit cleared the deadline — a 60s timer left
    // running would hold this test file open for a minute.
    running.resolve();
    await new Promise((r) => setImmediate(r));
    hooks.fire(second);
    assert.deepEqual(hooks.exits, [code]);
  }
});

test('a teardown that never finishes is abandoned at the deadline with exit 1', async () => {
  const records: LogRecord[] = [];
  const running = heldClose();
  const hooks = fakeSignals();
  closeOnSignal(running, recordingLogger(records), hooks, 20);

  hooks.fire('SIGTERM');
  await waitFor('the shutdown deadline', () => hooks.exits.length > 0);
  assert.deepEqual(hooks.exits, [1]);
  assert.deepEqual(records.at(-1), {
    level: 'error',
    msg: 'http transport did not close in time; exiting anyway',
    fields: { timeoutMs: 20 },
  });

  running.resolve();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(hooks.exits, [1], 'a late close does not report a second outcome');
});

test('a teardown that finishes in time cancels the deadline, so no timeout is reported', async () => {
  // The exit guard alone keeps the outcome single; without the cleared timer the
  // deadline still fires after a clean close and logs a timeout that never happened.
  const records: LogRecord[] = [];
  const running = heldClose();
  const hooks = fakeSignals();
  closeOnSignal(running, recordingLogger(records), hooks, 20);

  hooks.fire('SIGTERM');
  running.resolve();
  await waitFor('the clean close to exit', () => hooks.exits.length > 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(hooks.exits, [0]);
  assert.equal(
    records.some((r) => r.level === 'error'),
    false,
    `no error after a clean close: ${JSON.stringify(records)}`,
  );
});

test('a teardown that fails exits 1 and names the failure', async () => {
  const records: LogRecord[] = [];
  const running = heldClose();
  const hooks = fakeSignals();
  closeOnSignal(running, recordingLogger(records), hooks, 60_000);

  hooks.fire('SIGINT');
  running.reject(new Error('Server is not running.'));
  await waitFor('the failed close to exit', () => hooks.exits.length > 0);
  assert.deepEqual(hooks.exits, [1]);
  assert.deepEqual(records.at(-1), {
    level: 'error',
    msg: 'http transport close failed; exiting',
    fields: { err: 'Server is not running.' },
  });
});
