/**
 * Unit tests for the HTTP transport's bind guard (Layer `mcp/`). The MCP server
 * is a minimal stub (the transport only calls `connect`), and every accepted
 * bind uses port 0 on loopback, so these tests open an ephemeral local listener
 * and nothing else — no outbound traffic, no all-interfaces bind.
 *
 * The refusal case deliberately uses 203.0.113.1 (TEST-NET-3, RFC 5737), an
 * address this machine cannot own: if the guard ever regresses, `listen` fails
 * with EADDRNOTAVAIL instead of silently binding a real public interface — and
 * the assertions (InstagramError, kind `validation`) still fail, which is the
 * point of the test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { startHttp } from '../../src/mcp/transport.js';
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

/** The transport only needs `connect`; anything else would be unused here. */
function stubServer(): { server: McpServer; connects: number } {
  const state = { connects: 0 };
  const server = {
    connect: async () => {
      state.connects += 1;
    },
  };
  return {
    server: server as unknown as McpServer,
    get connects() {
      return state.connects;
    },
  };
}

test('startHttp refuses a non-loopback bind with no bearer token', async () => {
  const records: LogRecord[] = [];
  const { server } = stubServer();

  await assert.rejects(
    () => startHttp(server, { host: '203.0.113.1', port: 0 }, recordingLogger(records)),
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
  const { server, ...counter } = stubServer();

  await assert.rejects(
    () => startHttp(server, { host: '0.0.0.0', port: 0 }, recordingLogger(records)),
    (err: unknown) => err instanceof InstagramError && err.kind === 'validation',
  );
  // Refused before `server.connect` — no transport, no listener, nothing bound.
  assert.equal(counter.connects, 0);
});

test('startHttp warns at error level when a loopback bind has no authentication', async () => {
  const records: LogRecord[] = [];
  const running = await startHttp(
    stubServer().server,
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
    stubServer().server,
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
