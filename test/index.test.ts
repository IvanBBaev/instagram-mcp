/**
 * End-to-end tests for the composition root, `src/index.ts`.
 *
 * The entry point wires itself together and starts a transport when the module
 * is evaluated, so it cannot be imported and poked at — it is only honest to run
 * it as a PROCESS. Every test here therefore spawns `dist/src/index.js` with:
 *
 *   - a pruned environment (every `IG_*`, `XDG_CONFIG_HOME` and `APPDATA` from
 *     the developer's own shell removed) so a real `~/.config/instagram-mcp-ai/.env`
 *     can never leak in and make a test pass for the wrong reason;
 *   - a fresh temp config home and a fresh temp cwd, because `loadEnvFiles`
 *     consults BOTH `<config-home>/instagram-mcp-ai/.env` and `<cwd>/.env`;
 *   - `node --import test/helpers/entry-preload.js`, which stubs the child's
 *     `globalThis.fetch` and records every outbound URL (see that file for why a
 *     preload, and not the usual `withFetch` helper, is the way in).
 *
 * That combination is what makes these behavioural rather than decorative: the
 * assertions are about exit codes, which stream each byte went to, what the real
 * auth layer put on the wire, and what ended up on disk — not about which lines
 * ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { configHomeEnv, envFileIn } from './helpers/config-home.js';
import type { StubRoute } from './helpers/entry-preload.js';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));
const PRELOAD = new URL('./helpers/entry-preload.js', import.meta.url).href;

const TOKEN = 'IGQ-test-access-token-value';
const APP_SECRET = 'test-app-secret-value';

/** Temp directories one child run is confined to. */
interface Sandbox {
  /** `$XDG_CONFIG_HOME` / `%APPDATA%` for the child. */
  configHome: string;
  /** The child's working directory — deliberately NOT the repo (it has a `.env`). */
  cwd: string;
  /** File the fetch stub appends every request URL to. */
  requestLog: string;
  cleanup(): Promise<void>;
}

async function makeSandbox(): Promise<Sandbox> {
  const base = await mkdtemp(path.join(tmpdir(), 'ig-entry-'));
  const configHome = path.join(base, 'config');
  const cwd = path.join(base, 'cwd');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(configHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return {
    configHome,
    cwd,
    requestLog: path.join(base, 'requests.log'),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

/**
 * The developer's shell minus everything that could reach the entry's config
 * resolution. Without this prune a machine with real credentials exported would
 * turn the "no profile configured" test green for the wrong reason.
 */
function baseEnv(sandbox: Sandbox, routes: StubRoute[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('IG_')) delete env[key];
  }
  delete env.XDG_CONFIG_HOME;
  delete env.APPDATA;
  return {
    ...env,
    ...configHomeEnv(sandbox.configHome),
    IG_TEST_ROUTES: JSON.stringify(routes),
    IG_TEST_REQUEST_LOG: sandbox.requestLog,
  };
}

interface RunOptions {
  routes?: StubRoute[];
  env?: Record<string, string | undefined>;
  stdin?: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the entry to completion. Only for subcommands that exit by themselves. */
function runEntry(sandbox: Sandbox, args: string[], opts: RunOptions = {}): RunResult {
  const result = spawnSync(process.execPath, ['--import', PRELOAD, ENTRY, ...args], {
    cwd: sandbox.cwd,
    env: { ...baseEnv(sandbox, opts.routes ?? []), ...opts.env },
    encoding: 'utf8',
    input: opts.stdin ?? '',
    timeout: 20_000,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Every URL the child's fetch stub saw, in order. */
async function recordedRequests(sandbox: Sandbox): Promise<string[]> {
  try {
    const text = await readFile(sandbox.requestLog, 'utf8');
    return text.split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

// --- Runtime guard ----------------------------------------------------------

test('an unsupported Node runtime is refused before any other work happens', async () => {
  // The guard exists because the runtime uses Node 22 APIs (`AbortSignal.any`),
  // which fail late and cryptically. Everything below is set up so the run would
  // otherwise SUCCEED — valid credentials and a working stub route — so a
  // regression shows up as a healthy report on stdout, not just a different code.
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_TEST_FAKE_NODE_VERSION: '20.11.0',
        IG_ACCESS_TOKEN: TOKEN,
        IG_ACCOUNT_ID: '17841400000000000',
      },
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 1);
    assert.equal(run.stderr, 'instagram-mcp-ai requires Node >= 22 (running 20.11.0).\n');
    assert.equal(run.stdout, '', 'the guard must exit before doctor writes its report');
    assert.deepEqual(await recordedRequests(sandbox), [], 'nothing downstream may run');
  } finally {
    await sandbox.cleanup();
  }
});

// --- Subcommand routing -----------------------------------------------------

test('login runs before profile resolution, so it works with no credentials at all', async () => {
  // The ordering in `main()` is load-bearing: `login` is what an operator runs
  // when there is NO usable profile yet. If it were routed after `loadProfiles`,
  // the one command that fixes a broken config would be the one that cannot run.
  const sandbox = await makeSandbox();
  try {
    const help = runEntry(sandbox, ['login', '--help']);
    assert.equal(help.status, 0, `login --help must exit 0, stderr: ${help.stderr}`);
    assert.match(help.stderr, /login/);
    assert.equal(help.stdout, '', 'stdout is the stdio protocol channel and must stay empty');
    assert.doesNotMatch(help.stderr, /failed to start/);

    // A usage error propagates its own exit code (2), not the generic 1.
    const missing = runEntry(sandbox, ['login']);
    assert.equal(missing.status, 2, `stderr: ${missing.stderr}`);
    assert.match(missing.stderr, /--path <ig\|fb> is required/);
  } finally {
    await sandbox.cleanup();
  }
});

test('the entry exits 1 with a clean, stack-free message when no profile is configured', async () => {
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, []);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^instagram-mcp-ai failed to start: No default profile configured/);
    assert.match(run.stderr, /IG_ACCESS_TOKEN/);
    // The redactor is not wired yet at this point, so the handler must print the
    // message only — a stack trace here would be the first place a token leaks.
    assert.doesNotMatch(run.stderr, /at .*index\.js/);
    assert.equal(run.stdout, '');
  } finally {
    await sandbox.cleanup();
  }
});

test('an unknown IG_ACTIVE_PROFILE fails loudly on every path, not just on tool calls', async () => {
  // A typo in `IG_ACTIVE_PROFILE` used to be silently swallowed by the entry
  // (which fell back to the first profile) while the tool path rejected it — so
  // `doctor` reported a healthy `default` account and every tool call failed.
  // Both paths must now refuse the same value with the same message.
  const sandbox = await makeSandbox();
  const env = {
    IG_ACCESS_TOKEN: TOKEN,
    IG_ACCOUNT_ID: '17841400000000000',
    IG_PROFILE_BRAND_ACCESS_TOKEN: 'IGQ-brand-token',
    IG_ACTIVE_PROFILE: 'brnad', // typo for the configured 'brand'
  };
  const routes = [{ match: '/17841400000000000', body: { id: '17841400000000000' } }];
  try {
    for (const args of [['doctor'], ['refresh'], []]) {
      const label = args[0] ?? '<server>';
      const run = runEntry(sandbox, args, { env, routes });
      assert.equal(run.status, 1, `${label} must fail, stdout: ${run.stdout}`);
      assert.match(run.stderr, /failed to start: Unknown account profile 'brnad'/, label);
      assert.match(run.stderr, /configured profiles: default, brand\./, label);
      assert.equal(run.stdout, '', `${label} must not report on a profile it did not resolve`);
    }
    assert.deepEqual(await recordedRequests(sandbox), [], 'a bad profile must reach no network');
  } finally {
    await sandbox.cleanup();
  }
});

// --- Config-home round trip -------------------------------------------------

test('the entry reads back the env file the write path produced in the config home', async () => {
  // `loadEnvFiles` resolves the config home through the SAME resolver
  // `writeCredentials` uses. This test writes credentials with the real write
  // path and then starts the entry with no `IG_*` in the environment at all, so
  // the ONLY way `doctor` can authenticate is by reading that file back. If the
  // read and write sides ever drift apart (the failure the resolver comment
  // warns about), this fails instead of silently looking in the wrong directory.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    const written = await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: sandbox.configHome },
    );
    assert.equal(written.path, envFileIn(sandbox.configHome));

    const run = runEntry(sandbox, ['doctor'], {
      routes: [
        { match: '/17841400000000000', body: { id: '17841400000000000', username: 'acme' } },
      ],
    });

    assert.equal(run.status, 0, `doctor should be healthy, stderr: ${run.stderr}`);
    assert.match(run.stdout, /Active profile: default \(ig-login/);
    assert.match(run.stdout, /Reachability OK/);
    assert.match(run.stdout, /@acme/);
    // Path A honestly reports that it cannot introspect the token.
    assert.match(run.stdout, /introspection via `debug_token` is unavailable/);

    // The composition root injected the per-profile auth seam, so the token the
    // file carried actually reached the wire.
    const requests = await recordedRequests(sandbox);
    assert.equal(
      requests.length,
      1,
      `expected exactly one Graph call, got ${requests.join(' | ')}`,
    );
    assert.match(requests[0] ?? '', /^GET https:\/\/graph\.instagram\.com\//);
    assert.ok(
      (requests[0] ?? '').includes(`access_token=${encodeURIComponent(TOKEN)}`),
      'the auth provider must append the profile token',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('doctor on fb-login introspects the token, exits 1 when invalid, and never prints it', async () => {
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_AUTH_PATH: 'fb-login',
        IG_APP_ID: '1234567890',
        IG_APP_SECRET: APP_SECRET,
      },
      routes: [
        { match: '/debug_token', body: { data: { is_valid: false, app_id: '1234567890' } } },
        { match: '/me', body: { id: '17841400000000000' } },
      ],
    });

    assert.equal(run.status, 1, 'an invalid token must fail the health check');
    assert.match(run.stdout, /FAIL.*is_valid=false/);
    assert.match(run.stdout, /Health check FAILED/);
    // The report is the operator-facing artifact — it must never carry secrets,
    // whichever path produced it.
    assert.doesNotMatch(run.stdout, new RegExp(TOKEN));
    assert.doesNotMatch(run.stdout, new RegExp(APP_SECRET));

    const requests = await recordedRequests(sandbox);
    assert.equal(requests.length, 2, requests.join(' | '));
    // Path B routes introspection at graph.facebook.com and signs every call.
    assert.match(requests[0] ?? '', /^GET https:\/\/graph\.facebook\.com\/[^/]+\/debug_token\?/);
    for (const req of requests) {
      assert.match(req, /appsecret_proof=[0-9a-f]{64}/, `unsigned Path B call: ${req}`);
      assert.ok(!req.includes(APP_SECRET), 'the app secret itself must never be sent');
    }
  } finally {
    await sandbox.cleanup();
  }
});

// --- refresh ----------------------------------------------------------------

test('refresh exchanges the token and persists it back into the config-home env file', async () => {
  const sandbox = await makeSandbox();
  try {
    const refreshed = 'IGQ-refreshed-token-value';
    const run = runEntry(sandbox, ['refresh'], {
      env: { IG_ACCESS_TOKEN: TOKEN, IG_AUTH_PATH: 'ig-login', IG_ACCOUNT_ID: '17841400000000000' },
      routes: [
        {
          match: '/refresh_access_token',
          body: { access_token: refreshed, token_type: 'bearer', expires_in: 5_184_000 },
        },
      ],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.equal(run.stdout, '', 'refresh reports on stderr; stdout stays protocol-only');
    assert.match(run.stderr, /^Refreshed ig-login token for profile 'default' -> /);
    // A human-readable absolute expiry, and no token anywhere in the notice.
    assert.match(run.stderr, /\(expires: \d{4}-\d{2}-\d{2}T[\d:.]+Z\)\./);
    assert.ok(!run.stderr.includes(refreshed), 'the refresh notice must not echo the new token');

    // The token exchange authenticates itself — the Graph seam (which would add
    // `access_token`/`appsecret_proof` on top) must NOT be in this path.
    const requests = await recordedRequests(sandbox);
    assert.equal(requests.length, 1, requests.join(' | '));
    assert.match(requests[0] ?? '', /^GET https:\/\/graph\.instagram\.com\//);
    assert.match(requests[0] ?? '', /grant_type=ig_refresh_token/);
    assert.ok(!(requests[0] ?? '').includes('appsecret_proof'), requests[0]);

    // The new token is on disk where the next start will read it from.
    const saved = await readFile(envFileIn(sandbox.configHome), 'utf8');
    assert.match(saved, new RegExp(`^IG_ACCESS_TOKEN=${refreshed}$`, 'm'));
    assert.match(saved, /^IG_AUTH_PATH=ig-login$/m);
    assert.match(saved, /^IG_TOKEN_EXPIRES_AT=\d+$/m);
    assert.ok(!saved.includes(TOKEN), 'the stale token must be replaced, not appended');
  } finally {
    await sandbox.cleanup();
  }
});

test('refresh reports an unknown expiry when the upstream omits expires_in', async () => {
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['refresh'], {
      env: { IG_ACCESS_TOKEN: TOKEN, IG_AUTH_PATH: 'ig-login' },
      routes: [{ match: '/refresh_access_token', body: { access_token: 'IGQ-no-expiry' } }],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.match(run.stderr, /\(expires: unknown\)\./);
    const saved = await readFile(envFileIn(sandbox.configHome), 'utf8');
    assert.doesNotMatch(saved, /^IG_TOKEN_EXPIRES_AT=/m);
  } finally {
    await sandbox.cleanup();
  }
});

// --- Transports -------------------------------------------------------------

/** A child kept alive on a transport, with everything needed to talk to it. */
interface RunningEntry {
  child: ChildProcessWithoutNullStreams;
  stderr(): string;
  /** Resolves once `stderr` matches `re`, rejects on child exit or timeout. */
  waitForStderr(re: RegExp): Promise<void>;
  stop(): Promise<void>;
}

function startEntry(sandbox: Sandbox, args: string[], opts: RunOptions = {}): RunningEntry {
  const child = spawn(process.execPath, ['--import', PRELOAD, ENTRY, ...args], {
    cwd: sandbox.cwd,
    env: { ...baseEnv(sandbox, opts.routes ?? []), ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrText = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderrText += chunk));
  child.on('exit', (code, signal) => (exited = { code, signal }));

  return {
    child,
    stderr: () => stderrText,
    waitForStderr: async (re) => {
      const deadline = Date.now() + 15_000;
      while (!re.test(stderrText)) {
        if (exited !== undefined) {
          throw new Error(
            `child exited (${String(exited.code)}) before ${re.source}: ${stderrText}`,
          );
        }
        if (Date.now() > deadline)
          throw new Error(`timed out waiting for ${re.source}: ${stderrText}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    stop: async () => {
      if (exited !== undefined) return;
      // SIGTERM, which the preload turns into `process.exit(0)`: SIGKILL would
      // skip Node's exit hooks, and this child is doing real work worth
      // measuring. SIGKILL stays as the backstop so a wedged child can never
      // hang the test run.
      child.kill('SIGTERM');
      const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const backstop = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        await exit;
      } finally {
        clearTimeout(backstop);
      }
    },
  };
}

test('the stdio transport speaks MCP on stdout and keeps every diagnostic on stderr', async () => {
  const sandbox = await makeSandbox();
  const running = startEntry(sandbox, [], {
    env: { IG_ACCESS_TOKEN: TOKEN, IG_LOG_LEVEL: 'info' },
  });
  try {
    const lines: string[] = [];
    let buffer = '';
    running.child.stdout.setEncoding('utf8');
    running.child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) if (part.trim() !== '') lines.push(part);
    });

    const awaitResponse = async (id: number): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const hit = lines
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((m) => m.id === id);
        if (hit !== undefined) return hit;
        if (Date.now() > deadline) throw new Error(`no response for id ${id}: ${lines.join('|')}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const send = (msg: unknown): void => void running.child.stdin.write(`${JSON.stringify(msg)}\n`);

    await running.waitForStderr(/mcp server ready/);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'entry-test', version: '0.0.0' },
      },
    });
    const init = (await awaitResponse(1)).result as { serverInfo?: { name?: string } };
    assert.equal(init.serverInfo?.name, 'instagram-mcp-ai');

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = (await awaitResponse(2)).result as { tools?: { name: string }[] };
    const names = (listed.tools ?? []).map((t) => t.name);
    assert.ok(names.length > 0, 'the entry must register the tool surface before serving');
    assert.ok(
      names.includes('instagram_get_account'),
      `no account tool registered: ${names.join()}`,
    );

    // Every line on stdout parsed as JSON-RPC above; the logs went elsewhere.
    const stderr = running.stderr();
    assert.match(stderr, /tools registered/);
    assert.match(stderr, /"transport":"stdio"/);
    assert.ok(!stderr.includes(TOKEN), 'the redactor must mask the token in the startup logs');
  } finally {
    await running.stop();
    await sandbox.cleanup();
  }
});

/** Bind an ephemeral loopback port and hand it back, closed and free. */
async function freePort(): Promise<number> {
  const probe = createServer();
  return await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

test('a start failure from the transport is reported as one clean line, not a crash', async () => {
  // An occupied port is the failure an operator actually hits (a second server,
  // or a stale one). It arrives as a plain Node `Error`, not an `InstagramError`,
  // so it exercises the other arm of the top-level handler: still one message,
  // still no stack, still exit 1.
  const sandbox = await makeSandbox();
  const blocker = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as AddressInfo).port));
  });
  try {
    const run = runEntry(sandbox, [], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_TRANSPORT: 'http',
        IG_HTTP_HOST: '127.0.0.1',
        IG_PORT: String(port),
        IG_HTTP_TOKEN: 'entry-test-bearer-token',
      },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /instagram-mcp-ai failed to start: listen EADDRINUSE/);
    assert.doesNotMatch(run.stderr, /^\s+at /m, 'the handler prints the message, never a stack');
    assert.equal(run.stdout, '');
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await sandbox.cleanup();
  }
});

test('IG_TRANSPORT=http serves MCP over loopback and enforces IG_HTTP_TOKEN', async () => {
  const sandbox = await makeSandbox();
  const bearer = 'entry-test-bearer-token';
  const port = await freePort();

  const running = startEntry(sandbox, [], {
    env: {
      IG_ACCESS_TOKEN: TOKEN,
      IG_TRANSPORT: 'http',
      IG_HTTP_HOST: '127.0.0.1',
      IG_PORT: String(port),
      IG_HTTP_TOKEN: bearer,
    },
  });
  try {
    await running.waitForStderr(/mcp server ready/);
    assert.match(running.stderr(), /"transport":"http"/);
    assert.ok(!running.stderr().includes(bearer), 'IG_HTTP_TOKEN must be redacted in logs too');

    const url = `http://127.0.0.1:${port}/mcp`;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'entry-test', version: '0.0.0' },
      },
    });
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    const anonymous = await fetch(url, { method: 'POST', headers, body });
    assert.equal(anonymous.status, 401, 'the HTTP transport must require the configured bearer');
    await anonymous.text();

    /** POST an authorized JSON-RPC call and return the parsed envelope. */
    const call = async (rpc: unknown): Promise<Record<string, unknown>> => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${bearer}` },
        body: JSON.stringify(rpc),
      });
      const text = await res.text();
      assert.equal(res.status, 200, `authorized request failed (${res.status}): ${text}`);
      return JSON.parse(text) as Record<string, unknown>;
    };

    // Three sequential calls through ONE process. The composition root hands the
    // transport a server FACTORY precisely so this works: a stateless transport
    // serves a single request, so request #2 onwards used to come back as an
    // empty 500 from a server that was still "ready".
    const init = (await call(JSON.parse(body))).result as { serverInfo?: { name?: string } };
    assert.equal(init.serverInfo?.name, 'instagram-mcp-ai');

    const listed = (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
      .result as { tools?: { name: string }[] };
    const names = (listed.tools ?? []).map((t) => t.name);
    assert.ok(
      names.includes('instagram_get_account'),
      `the per-request server must carry the full tool surface: ${names.join()}`,
    );

    const again = (await call(JSON.parse(body))).result as { serverInfo?: { name?: string } };
    assert.equal(again.serverInfo?.name, 'instagram-mcp-ai');

    // A per-request server that leaked would have to log its registration again;
    // the startup line must still be the only one.
    assert.equal(
      running.stderr().match(/tools registered/g)?.length,
      1,
      'the tool surface is registered (and logged) once at startup',
    );
  } finally {
    await running.stop();
    await sandbox.cleanup();
  }
});
