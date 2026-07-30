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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { startHttp } from '../../src/mcp/transport.js';
import type { McpServerFactory, RunningHttpTransport } from '../../src/mcp/transport.js';
import { InstagramError } from '../../src/core/types.js';
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
 * Reserve an ephemeral port and hand it back. The transport needs a CONCRETE
 * port up front: its DNS-rebinding allowlist is built from `opts.port`, so a
 * `port: 0` bind would only accept a `Host: 127.0.0.1:0` header that no client
 * ever sends. Binding then immediately closing is the standard way to learn a
 * free port; the tiny reuse window is acceptable in a test.
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
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

test('startHttp refuses a non-loopback bind with no bearer token', async () => {
  const records: LogRecord[] = [];
  const { create } = stubFactory();

  await assert.rejects(
    () => startHttp(create, { host: '203.0.113.1', port: 0 }, recordingLogger(records)),
    (err: unknown) => {
      assert.ok(err instanceof InstagramError, 'expected an InstagramError, got ' + String(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /not loopback/);
      assert.match(err.message, /IG_HTTP_TOKEN/);
      return true;
    },
  );
});

test('startHttp refuses 0.0.0.0 without a token before any socket is opened', async () => {
  const records: LogRecord[] = [];
  const factory = stubFactory();

  await assert.rejects(
    () => startHttp(factory.create, { host: '0.0.0.0', port: 0 }, recordingLogger(records)),
    (err: unknown) => err instanceof InstagramError && err.kind === 'validation',
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
    const warning = records.find((r) => r.level === 'error');
    assert.ok(warning, 'an unauthenticated bind must be reported at error level');
    assert.match(warning.msg, /NO authentication/);
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
  } finally {
    await running.close();
  }
});

test('startHttp allows a non-loopback bind once a token is set, but says so at error level', async () => {
  // The guard must not refuse this combination — a bearer is the documented way
  // to expose the transport beyond loopback — yet it must never be silent about
  // it. 203.0.113.1 (TEST-NET-3) cannot be owned by this machine, so if the OS
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
    const warning = records.find((r) => r.level === 'error');
    assert.ok(warning, 'a non-loopback bind must be reported at error level');
    assert.match(warning.msg, /NON-LOOPBACK/);
    assert.deepEqual(warning.fields?.host, '203.0.113.1');
  } finally {
    await running?.close();
  }
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
    assert.equal(logged.fields?.err, 'tool registration exploded: secret-ish detail');

    // One bad request does not poison the listener.
    const after = await post(url, initializeBody(3));
    assert.equal(after.status, 200, `the transport must recover: ${after.text}`);
  } finally {
    await running.close();
  }
});
