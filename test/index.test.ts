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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { configHomeEnv, envFileIn } from './helpers/config-home.js';
import type { StubRoute } from './helpers/entry-preload.js';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));
const PRELOAD = new URL('./helpers/entry-preload.js', import.meta.url).href;

const TOKEN = 'IGQ-test-access-token-value';
const APP_SECRET = 'test-app-secret-value';

/** A credential that only a `<cwd>/.env` can supply, distinct from {@link TOKEN}. */
const PROJECT_TOKEN = 'IGQ-project-dot-env-token-value';
/** A credential that only the MCP client's environment can supply. */
const CLIENT_TOKEN = 'IGQ-client-supplied-token-value';

/**
 * Secrets deliberately shaped like NOTHING the redactor recognises on sight: no
 * `EAA…`/`IG…` prefix, not a 64-hex proof. The only thing that can mask one of
 * these is an exact registration — which is precisely what
 * `registerProfileSecrets` exists to do, and what a test using {@link TOKEN}
 * (which the `IG…` shape backstop catches unaided) can never prove.
 */
const PLAIN_TOKEN = 'plain-access-token-value-0001';
const PLAIN_APP_SECRET = 'plain-app-secret-value-0002';
const PLAIN_BEARER = 'plain-http-bearer-value-0003';

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

test('the runtime floor is read from the MAJOR version, never from a later segment', async () => {
  // `24.11.0` is the shape that catches an off-by-one segment index: the major
  // clears the floor, the MINOR does not. Read the wrong segment and a perfectly
  // supported runtime is refused at startup — the server never runs on it at all,
  // and the message blames the very version that is fine. The test above cannot
  // see this: `20.11.0` refuses either way.
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_TEST_FAKE_NODE_VERSION: '24.11.0',
        IG_ACCESS_TOKEN: TOKEN,
        IG_ACCOUNT_ID: '17841400000000000',
      },
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 0, `a supported runtime must start, stderr: ${run.stderr}`);
    assert.doesNotMatch(run.stderr, /requires Node >=/);
    assert.ok(
      (await recordedRequests(sandbox)).length > 0,
      'the run must have reached the network, not stopped at the guard',
    );
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

// --- Harness contract -------------------------------------------------------

test('an unrouted call fails fast and loud instead of quietly burning the retry budget', async () => {
  // The preload's defaults decide what a *forgotten* stub looks like. If an
  // unmatched request answered 200 `{}` the run would look healthy; if it
  // answered a retryable 5xx the child would sit through the whole backoff
  // ladder and the test would die on a timeout rather than an assertion. So the
  // default is Graph code 100 at 400 — a non-retryable client error.
  //
  // Dropping IG_TEST_ROUTES entirely also exercises the "no routes configured"
  // default: an absent variable must mean an empty table, not a parse crash in
  // the preload (which would surface as an unrelated child failure everywhere).
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_TEST_ROUTES: undefined,
        IG_ACCESS_TOKEN: TOKEN,
        IG_ACCOUNT_ID: '17841400000000000',
      },
    });

    assert.equal(run.status, 1, `an unroutable doctor must fail, stdout: ${run.stdout}`);
    assert.match(run.stdout, /Reachability FAILED/);
    assert.match(run.stdout, /test stub: no route for/, 'the stub must name what went unstubbed');
    assert.doesNotMatch(run.stdout, new RegExp(TOKEN), 'the echoed URL must stay redacted');

    // Both halves of "non-retryable client error", read back off the wire the
    // way `doctor` renders them. The Graph code is what `deriveKind` actually
    // consults, so the status alone would not prove the classification — but a
    // 5xx here would be a stub that *looks* transient, and the day someone drops
    // the error envelope from the default it is the status that decides. Assert
    // the pair, so neither half can drift into something retryable unnoticed.
    assert.match(run.stdout, /code=100/, 'the canned error must stay a Graph client error');
    assert.match(
      run.stdout,
      /status=400/,
      'the canned status must stay 4xx, never a retryable 5xx',
    );

    // One attempt, not four: proof the canned error classified as non-retryable.
    const requests = await recordedRequests(sandbox);
    assert.equal(requests.length, 1, `expected a single attempt, got ${requests.join(' | ')}`);
  } finally {
    await sandbox.cleanup();
  }
});

test('a route with neither status nor body answers 200 with an empty JSON object', async () => {
  // The terse route form `{ match }` is what a test writes when it only cares
  // that a call happened. It must still produce parseable JSON: a stub body of
  // `undefined` would serialize to the string "undefined" and every caller would
  // fail on a JSON parse error that has nothing to do with what is under test.
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['doctor'], {
      env: { IG_ACCESS_TOKEN: TOKEN, IG_ACCOUNT_ID: '17841400000000000' },
      routes: [{ match: '/17841400000000000' }],
    });

    assert.equal(run.status, 0, `doctor should be healthy, stderr: ${run.stderr}`);
    assert.match(run.stdout, /Reachability OK/);
    // The empty object carries no username, and doctor says nothing rather than
    // inventing one.
    assert.doesNotMatch(run.stdout, /\(@/);
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

test('the project .env is the documented fallback, and the config home outranks it', async () => {
  // Resolution is a LIST, in order: `<config-home>/instagram-mcp-ai/.env` then
  // `<cwd>/.env`, loaded with `override: false` so the FIRST file to set a key
  // wins. Two distinct failures hide behind any single-file test — dropping the
  // project candidate (a developer's checked-out `.env` quietly stops working)
  // and swapping the pair (a stale project file outranks the credential `login`
  // or `refresh` just wrote, so a token rotation appears to do nothing and the
  // server keeps presenting the old token). Both need a run where the two files
  // disagree, so the order shows up on the wire.
  const projectOnly = await makeSandbox();
  try {
    await writeFile(
      path.join(projectOnly.cwd, '.env'),
      `IG_ACCESS_TOKEN=${PROJECT_TOKEN}\nIG_ACCOUNT_ID=17841400000000000\n`,
      'utf8',
    );

    const run = runEntry(projectOnly, ['doctor'], {
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 0, `the project .env must be loaded, stderr: ${run.stderr}`);
    const requests = await recordedRequests(projectOnly);
    assert.ok(
      (requests[0] ?? '').includes(`access_token=${encodeURIComponent(PROJECT_TOKEN)}`),
      `the project token never reached the wire: ${requests.join(' | ')}`,
    );
  } finally {
    await projectOnly.cleanup();
  }

  const both = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: both.configHome },
    );
    await writeFile(
      path.join(both.cwd, '.env'),
      `IG_ACCESS_TOKEN=${PROJECT_TOKEN}\nIG_ACCOUNT_ID=17841400000000000\n`,
      'utf8',
    );

    const run = runEntry(both, ['doctor'], {
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const requests = await recordedRequests(both);
    assert.ok(
      (requests[0] ?? '').includes(`access_token=${encodeURIComponent(TOKEN)}`),
      `the config-home token must win over the project .env: ${requests.join(' | ')}`,
    );
    assert.ok(
      !(requests[0] ?? '').includes(PROJECT_TOKEN),
      'the project .env must never override what the write path stored',
    );
  } finally {
    await both.cleanup();
  }
});

test('an env file never overrides a value the MCP client passed in', async () => {
  // `override: false` is the documented contract: the client's environment (what
  // the operator configured in their MCP client) always beats a file on disk.
  // Flip it and a forgotten `~/.config/instagram-mcp-ai/.env` silently takes
  // over — the operator switches accounts in their client config, the server
  // keeps talking to the old one, and on a write tool that means publishing to
  // the wrong Instagram account.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: sandbox.configHome },
    );

    const run = runEntry(sandbox, ['doctor'], {
      env: { IG_ACCESS_TOKEN: CLIENT_TOKEN },
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const requests = await recordedRequests(sandbox);
    // The account id proves the file WAS loaded; the token proves it did not win.
    assert.match(requests[0] ?? '', /\/17841400000000000\?/);
    assert.ok(
      (requests[0] ?? '').includes(`access_token=${encodeURIComponent(CLIENT_TOKEN)}`),
      `the client-supplied token must win: ${requests.join(' | ')}`,
    );
    assert.ok(
      !(requests[0] ?? '').includes(TOKEN),
      'a file on disk must not override the environment',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('a blank IG_ENV_FILE falls back to the standard candidates instead of resolving to ""', async () => {
  // An unset shell variable expanded into a wrapper script (`IG_ENV_FILE="$X"`)
  // arrives as an empty or all-whitespace string. Treated as an explicit path it
  // REPLACES the candidate list with one entry that can never exist, so the
  // config home stops being consulted and a fully configured server reports "No
  // default profile configured" — with nothing on stderr naming the empty
  // variable as the cause.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: sandbox.configHome },
    );

    const run = runEntry(sandbox, ['doctor'], {
      env: { IG_ENV_FILE: '   ' },
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(
      run.status,
      0,
      `a blank IG_ENV_FILE must not hide the config home, stderr: ${run.stderr}`,
    );
    assert.match(run.stdout, /Reachability OK/);
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
    // The clock is pinned so the rendered expiry is an EXACT instant:
    // 1755000000 + 5184000 = 1760184000 = 2025-10-11T12:00:00.000Z.
    const nowMs = 1_755_000_000_000;
    const run = runEntry(sandbox, ['refresh'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_AUTH_PATH: 'ig-login',
        IG_ACCOUNT_ID: '17841400000000000',
        IG_TEST_FAKE_NOW_MS: String(nowMs),
      },
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
    // A human-readable absolute expiry, and no token anywhere in the notice. The
    // exact instant is the assertion, not the shape: `expiresAtSec` is SECONDS
    // and `Date` takes milliseconds, so a missing `* 1000` still renders a
    // perfectly well-formed ISO timestamp — in January 1970. A shape-only regex
    // reads that as a pass while the operator is told the token they just minted
    // expired 56 years ago.
    assert.match(run.stderr, /\(expires: 2025-10-11T12:00:00\.000Z\)\./);
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
    assert.match(saved, /^IG_TOKEN_EXPIRES_AT=1760184000$/m);
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

test('refresh renders the never-expires sentinel as "never", not as the 1970 epoch', async () => {
  // Zero is Graph's "this token does not expire" sentinel (`debug_token` reports
  // `expires_at: 0` for one), and `tokenHealth` already reads it that way. Run
  // it through `new Date(0 * 1000).toISOString()` instead and the operator is
  // told their fresh token expired in 1970 — a report that reads as an expiry
  // emergency. The clock is pinned so the arithmetic lands exactly on the
  // sentinel; nothing else in this run depends on the wall clock.
  const nowMs = 1_755_000_000_000;
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['refresh'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_AUTH_PATH: 'ig-login',
        IG_TEST_FAKE_NOW_MS: String(nowMs),
      },
      routes: [
        {
          match: '/refresh_access_token',
          body: { access_token: 'IGQ-never-expires', expires_in: -(nowMs / 1000) },
        },
      ],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.match(run.stderr, /\(expires: never\)\./);
    assert.doesNotMatch(run.stderr, /1970/);
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
    const init = (await awaitResponse(1)).result as {
      serverInfo?: { name?: string; version?: string };
    };
    assert.equal(init.serverInfo?.name, 'instagram-mcp-ai');
    // The advertised version is what clients log, what a bug report quotes, and
    // what a client gates behaviour on. It is a hand-maintained constant in
    // `src/index.ts`, so the only thing keeping it honest is this comparison
    // against the version actually shipped — the release checks compare
    // package.json to the other three manifests, but none of them can see what
    // the running server tells a client over the wire.
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    assert.equal(
      init.serverInfo?.version,
      pkg.version,
      'SERVER_VERSION drifted from package.json.version',
    );

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

    // The startup count must describe the surface that was actually REGISTERED,
    // not the manifest it was filtered down from. This run is the default `core`
    // package profile on an ig-login credential, so the two genuinely differ —
    // and this line is exactly what an operator reads to answer "did my
    // IG_TOOL_PACKAGES / IG_PACKAGES_DENY take effect?". A count taken from the
    // full catalogue answers "yes" no matter what they configured.
    const { allTools } = await import('../src/tools/index.js');
    assert.ok(
      names.length < allTools.length,
      `this run must exercise a FILTERED surface, got ${names.length} of ${allTools.length}`,
    );
    const counted = /"msg":"tools registered"[^\n]*?"count":(\d+)/.exec(stderr);
    assert.equal(
      Number(counted?.[1]),
      names.length,
      `the logged count must match the served surface: ${String(counted?.[0])}`,
    );
  } finally {
    await running.stop();
    await sandbox.cleanup();
  }
});

test('every configured secret is registered with the redactor, so no log can echo one back', async () => {
  // The three registrations in `registerProfileSecrets` are the ONLY thing that
  // masks a secret whose TEXT the redactor cannot recognise on sight — and real
  // credentials routinely look like nothing in particular (a Page token, a
  // rotated app secret, an operator-chosen `IG_HTTP_TOKEN`). A test built on the
  // `IGQ…` fixture token proves nothing here: `/IG[A-Za-z0-9_-]{20,}/` masks that
  // one whether or not it was ever registered, which is why the startup-log
  // assertion in the sibling test above stayed green with the registry empty.
  //
  // So the drive is: hand each secret back to the server as ordinary tool INPUT
  // (`instagram_get_media`'s `mediaId` is free-form and its `logFields` echoes it
  // verbatim), and require the emitted line to read `[REDACTED]`. That is the
  // real leak path — a value that is a secret elsewhere in the configuration must
  // never surface in the operator's log just because it arrived as an argument.
  const sandbox = await makeSandbox();
  const running = startEntry(sandbox, [], {
    env: {
      IG_ACCESS_TOKEN: PLAIN_TOKEN,
      IG_AUTH_PATH: 'fb-login',
      IG_APP_ID: '1234567890',
      IG_APP_SECRET: PLAIN_APP_SECRET,
      IG_HTTP_TOKEN: PLAIN_BEARER,
      IG_LOG_LEVEL: 'debug',
    },
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
    const send = (msg: unknown): void => void running.child.stdin.write(`${JSON.stringify(msg)}\n`);
    const awaitResponse = async (id: number): Promise<void> => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (lines.some((l) => (JSON.parse(l) as { id?: number }).id === id)) return;
        if (Date.now() > deadline) throw new Error(`no response for id ${id}: ${lines.join('|')}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };

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
    await awaitResponse(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // One call per secret: the profile token, the app secret, the HTTP bearer.
    const secrets = [PLAIN_TOKEN, PLAIN_APP_SECRET, PLAIN_BEARER];
    secrets.forEach((secret, i) => {
      send({
        jsonrpc: '2.0',
        id: 10 + i,
        method: 'tools/call',
        params: { name: 'instagram_get_media', arguments: { mediaId: secret } },
      });
    });
    for (let i = 0; i < secrets.length; i += 1) await awaitResponse(10 + i);

    const stderr = running.stderr();
    assert.equal(
      stderr.match(/"msg":"tool invoked"/g)?.length,
      secrets.length,
      `expected one invocation log per call: ${stderr}`,
    );
    assert.equal(
      stderr.match(/"mediaId":"\[REDACTED\]"/g)?.length,
      secrets.length,
      `every echoed secret must come back masked: ${stderr}`,
    );
    for (const secret of secrets) {
      assert.ok(!stderr.includes(secret), `an unregistered secret reached the log: ${secret}`);
    }
  } finally {
    await running.stop();
    await sandbox.cleanup();
  }
});

test('loading an env file puts nothing on stdout, so the JSON-RPC framing survives it', async () => {
  // The sibling test above hands the token in through the ENVIRONMENT, so
  // `loadEnvFiles` finds no file and dotenv never runs its load path. That is a
  // blind spot: dotenv 17 prints "injected env (N) from <path>" plus a product
  // tip to STDOUT on a successful load, which on the stdio transport is a
  // JSON-RPC framing error AND a disclosure of the config-home path. The whole
  // suite stayed green through that bump. This test closes the gap by making the
  // env FILE the only source of the credential, so the load path must run, and
  // then asserting that every byte on stdout is still parseable JSON-RPC.
  //
  // It guards the stream, not one dependency: anything that starts printing to
  // stdout during startup fails here, whichever package decided to do it.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: sandbox.configHome },
    );

    const running = startEntry(sandbox, [], { env: { IG_LOG_LEVEL: 'info' } });
    try {
      let stdout = '';
      running.child.stdout.setEncoding('utf8');
      running.child.stdout.on('data', (chunk: string) => (stdout += chunk));

      await running.waitForStderr(/mcp server ready/);
      running.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'entry-test', version: '0.0.0' },
          },
        })}\n`,
      );

      const deadline = Date.now() + 15_000;
      while (!stdout.includes('"id":1')) {
        if (Date.now() > deadline) {
          throw new Error(`no initialize response; stdout was ${JSON.stringify(stdout)}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      // The assertion that matters: EVERY line, not just the ones we expected.
      // A banner printed before the handshake would be line 0 here.
      for (const line of stdout.split('\n')) {
        if (line.trim() === '') continue;
        assert.doesNotThrow(
          () => JSON.parse(line),
          `non-JSON-RPC line on stdout: ${JSON.stringify(line)} — something printed to the ` +
            'stream the transport owns. If this is dotenv, `loadEnvFiles` lost its ' +
            '`quiet: true`.',
        );
      }
      // The credential really did come from the file, so the load path ran and
      // the test is not green merely because dotenv was never invoked.
      assert.match(running.stderr(), /tools registered/);
      assert.ok(!stdout.includes(TOKEN), 'no credential may reach stdout');
      assert.ok(
        !stdout.includes(sandbox.configHome),
        'no filesystem path from the config home may reach stdout',
      );
    } finally {
      await running.stop();
    }
  } finally {
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

/**
 * POST every body on its OWN socket, with the HEADERS of all N requests sent
 * first and the bodies only after the server has had time to pick them up. That
 * split is what makes the overlap real rather than nominal:
 *
 *   - `fetch` cannot overlap at all — undici hands the next call a pooled
 *     connection the moment the previous response lands, so eight
 *     `Promise.all`'d calls against a fast local listener still arrive strictly
 *     one after another.
 *   - Even on eight separate sockets, a complete request (headers AND body in
 *     one write) is served start-to-finish inside a single event-loop turn:
 *     nothing in the handler yields to I/O, so microtasks drain and the exchange
 *     is over before the next socket's data callback runs.
 *
 * Withholding the body forces the handler to park in `handleRequest` waiting for
 * bytes that have not arrived, so request #2's `request` event fires while #1 is
 * still mid-exchange — N servers genuinely alive at once.
 *
 * Returns each response verbatim, status line included, so the caller can assert
 * on the status a failed exchange actually produced.
 */
async function concurrentPosts(port: number, bearer: string, bodies: string[]): Promise<string[]> {
  const sockets = await Promise.all(
    bodies.map(
      () =>
        new Promise<Socket>((resolve, reject) => {
          const socket = connect(port, '127.0.0.1', () => resolve(socket));
          socket.once('error', reject);
        }),
    ),
  );
  const responses = sockets.map(
    (socket) =>
      new Promise<string>((resolve, reject) => {
        let raw = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => (raw += chunk));
        socket.on('end', () => resolve(raw));
        socket.once('error', reject);
      }),
  );
  try {
    bodies.forEach((body, i) => {
      // `connection: close` so each response is delimited by the socket ending —
      // no keep-alive framing to parse, and no connection left for a later test.
      sockets[i]?.write(
        `POST /mcp HTTP/1.1\r\n` +
          `host: 127.0.0.1:${port}\r\n` +
          `authorization: Bearer ${bearer}\r\n` +
          `content-type: application/json\r\n` +
          `accept: application/json, text/event-stream\r\n` +
          `connection: close\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\n\r\n`,
      );
    });
    // Loopback: every `request` event has fired long before this resolves.
    await delay(100);
    bodies.forEach((body, i) => sockets[i]?.write(body));
    return await Promise.all(responses);
  } finally {
    for (const socket of sockets) socket.destroy();
  }
}

/** The JSON-RPC envelope out of a raw HTTP response, whatever framed the body. */
function envelopeOf(raw: string): { id?: number; result?: { tools?: { name: string }[] } } {
  const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as {
    id?: number;
    result?: { tools?: { name: string }[] };
  };
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

test('a blank IG_HTTP_TOKEN is treated as no authentication, and said so out loud', async () => {
  // `IG_HTTP_TOKEN=""` (or a stray space) is what an operator ends up with from
  // an unset shell variable or an empty line in `.env`. Passing that string on
  // as the bearer would build a transport whose every request must carry a blank
  // Authorization header — nothing can authenticate, and the operator believes
  // the listener is protected. It must degrade to "no token" AND log the alarm.
  const sandbox = await makeSandbox();
  const port = await freePort();

  const running = startEntry(sandbox, [], {
    env: {
      IG_ACCESS_TOKEN: TOKEN,
      IG_TRANSPORT: 'http',
      IG_HTTP_HOST: '127.0.0.1',
      IG_PORT: String(port),
      IG_HTTP_TOKEN: '   ',
    },
  });
  try {
    await running.waitForStderr(/mcp server ready/);
    assert.match(running.stderr(), /http transport has NO authentication/);

    // And the listener really is open: an anonymous request is served, not 401'd.
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'entry-test', version: '0.0.0' },
        },
      }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, `a blank token must not become a required bearer: ${text}`);
  } finally {
    await running.stop();
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

    // ...and now genuinely CONCURRENTLY, which the sequential calls above are
    // blind to: each exchange closes its transport before the next begins, so a
    // single shared server survives them — its `Protocol` is free again by the
    // time request #2 arrives. Overlap them at the SOCKET level and the
    // difference is decisive: a `Protocol` owns its transport for its lifetime,
    // so the second in-flight `connect()` on a shared instance throws "Already
    // connected to a transport" and the handler answers 500 to whichever requests
    // lost the race. Two MCP clients pointed at one listener is the ordinary
    // deployment, not an edge case.
    const overlapped = await concurrentPosts(
      port,
      bearer,
      Array.from({ length: 8 }, (_, i) =>
        JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/list', params: {} }),
      ),
    );
    overlapped.forEach((raw, i) => {
      assert.match(raw, /^HTTP\/1\.1 200 /, `concurrent request ${i} was not served: ${raw}`);
      const envelope = envelopeOf(raw);
      assert.equal(envelope.id, 100 + i, `concurrent response ${i} came back mismatched`);
      assert.equal(
        envelope.result?.tools?.length,
        names.length,
        `concurrent response ${i} served a partial surface`,
      );
    });

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
