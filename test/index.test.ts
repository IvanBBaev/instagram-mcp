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
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { tokenFingerprint } from '../src/core/config.js';
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
/** A credential that only an explicitly-pointed-at `IG_ENV_FILE` can supply. */
const EXPLICIT_TOKEN = 'IGQ-explicit-env-file-token-value';

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
/**
 * The credential the stubbed exchange MINTS during `refresh` — equally invisible
 * to every shape pattern, so the only thing that can ever mask it is the
 * registration the mint path is supposed to perform (F-4).
 */
const PLAIN_REFRESHED_TOKEN = 'plain-refreshed-token-value-0004';
/** A SECOND profile's credential — only the loop over `profiles` can register it. */
const PLAIN_ALT_TOKEN = 'plain-alt-profile-token-0005';

/** Temp directories one child run is confined to. */
interface Sandbox {
  /** `$XDG_CONFIG_HOME` / `%APPDATA%` for the child. */
  configHome: string;
  /** The child's working directory — deliberately NOT the repo (it has a `.env`). */
  cwd: string;
  /** File the fetch stub appends every request URL to. */
  requestLog: string;
  /**
   * `IG_WRITE_JOURNAL` for the child — without it `doctor` and every write path
   * would resolve (and stat) the developer's REAL `~/.local/state/...` journal.
   */
  writeJournal: string;
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
    writeJournal: path.join(base, 'state', 'writes.jsonl'),
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
  delete env.XDG_STATE_HOME;
  delete env.APPDATA;
  return {
    ...env,
    ...configHomeEnv(sandbox.configHome),
    IG_WRITE_JOURNAL: sandbox.writeJournal,
    IG_TEST_ROUTES: JSON.stringify(routes),
    IG_TEST_REQUEST_LOG: sandbox.requestLog,
  };
}

interface RunOptions {
  routes?: StubRoute[];
  env?: Record<string, string | undefined>;
  stdin?: string;
  /** Extra `--import` modules, loaded after the fetch preload — see {@link redactionProbe}. */
  imports?: string[];
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the entry to completion. Only for subcommands that exit by themselves. */
function runEntry(sandbox: Sandbox, args: string[], opts: RunOptions = {}): RunResult {
  const extra = (opts.imports ?? []).flatMap((module) => ['--import', module]);
  const result = spawnSync(process.execPath, ['--import', PRELOAD, ...extra, ENTRY, ...args], {
    cwd: sandbox.cwd,
    env: { ...baseEnv(sandbox, opts.routes ?? []), ...opts.env },
    encoding: 'utf8',
    input: opts.stdin ?? '',
    timeout: 20_000,
  });
  assert.equal(result.error, undefined, `spawn failed: ${String(result.error)}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A `--import` module that records what the CHILD's redactor makes of `text`,
 * appending the redacted string to `outFile` as the child exits.
 *
 * This is the seam that separates "a secret was registered" from "a function was
 * called": the probe imports the very same compiled `core/redact.js` the entry
 * imports — one absolute URL, therefore one module instance and one registry —
 * and then runs the redactor the server itself would have run. `process.exit`
 * still fires `exit` handlers, so this reports the registry as it stood at the
 * end of the run, on the success path and on the throwing one alike.
 *
 * A `data:` module rather than a file on disk: nothing is added to the sandbox
 * whose contents the test is asserting on, and nothing outside the repo is
 * loaded that a coverage run would then have to account for.
 */
function redactionProbe(text: string, outFile: string): string {
  const redactUrl = new URL('../src/core/redact.js', import.meta.url).href;
  const call = `String(createRedactor()(${JSON.stringify(text)}))`;
  const source =
    `import { appendFileSync } from 'node:fs';\n` +
    `import { createRedactor } from ${JSON.stringify(redactUrl)};\n` +
    `process.on('exit', () => appendFileSync(${JSON.stringify(outFile)}, ${call}));\n`;
  return `data:text/javascript,${encodeURIComponent(source)}`;
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

/**
 * Every structured log record the child emitted, in order.
 *
 * The logger's sink is `process.stderr` and every record is one JSON line, so
 * the child's log is readable from the outside with no seam. Non-JSON lines are
 * skipped rather than failing: a subcommand's own human-readable diagnostics
 * share the stream, and a test that asserts on records should not break because
 * one was added.
 */
function logRecords(stderr: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stderr.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      out.push(parsed as Record<string, unknown>);
    }
  }
  return out;
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

test('a Node version that parses to no finite number is tolerated, never refused', async () => {
  // `Number.isFinite(major)` reads as removable: `NaN < 22` is already false, so
  // an unparseable version is let through either way. Exactly one string
  // separates the two forms — `-Infinity` fails the finite test and satisfies
  // the comparison, so the bare form REFUSES it — and production never supplies
  // it, since only Node writes `process.versions.node`. That is precisely why
  // nothing was holding the rule the guard exists to state: tolerate what we
  // cannot parse. Take the finite test away and the server stops on a string it
  // does not understand, blaming a runtime that may be perfectly fine.
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_TEST_FAKE_NODE_VERSION: '-Infinity',
        IG_ACCESS_TOKEN: TOKEN,
        IG_ACCOUNT_ID: '17841400000000000',
      },
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(
      run.status,
      0,
      `an unreadable version must not stop the run, stderr: ${run.stderr}`,
    );
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

const USAGE_TEXT = `Usage:
  instagram-mcp-ai                        Start the MCP server (transport from IG_TRANSPORT).
  instagram-mcp-ai login --path <ig|fb>   Obtain and persist a long-lived token (login --help).
  instagram-mcp-ai doctor                 Health-check the active profile (exit 0 when healthy).
  instagram-mcp-ai refresh                Refresh the active profile's long-lived token.
`;

test('an unknown subcommand is refused with exit 2 and the usage, before any profile is read', async () => {
  // `instagram-mcp-ai docter` used to fall through to "no subcommand" and start
  // the stdio server: a process parked on stdin waiting for JSON-RPC, which from
  // a terminal is a hang with no message. The refusal runs before the env file
  // and the profiles are read — the sandbox here has NO credentials at all, and
  // the answer must still be the usage error, never "No default profile
  // configured": a usage mistake is reported as one.
  const sandbox = await makeSandbox();
  try {
    for (const typo of ['docter', 'serve', 'Login', 'refresh-token', '--path', '']) {
      const run = runEntry(sandbox, [typo]);
      assert.equal(run.status, 2, `'${typo}' must be refused, stderr: ${run.stderr}`);
      assert.equal(run.stderr, `instagram-mcp-ai: unknown subcommand '${typo}'.\n\n${USAGE_TEXT}`);
      assert.equal(run.stdout, '', 'stdout is the stdio protocol channel and must stay empty');
    }
    for (const flag of ['--help', '-h']) {
      const help = runEntry(sandbox, [flag]);
      assert.equal(help.status, 0, `${flag} must exit 0, stderr: ${help.stderr}`);
      assert.equal(help.stderr, USAGE_TEXT);
      assert.equal(help.stdout, '');
    }
  } finally {
    await sandbox.cleanup();
  }
});

test('doctor and refresh refuse any argument: the first stray token is named, a value after = is not', async () => {
  // Neither command takes a flag, so a token on the line is a mistake — and
  // before this, `doctor --bogus` ran the doctor with the token dropped, which
  // made a mistyped flag indistinguishable from a clean run. As with the
  // `login` parser, a `--flag=value` is named by its flag only: the value is the
  // one part of the line that could be a secret.
  const sandbox = await makeSandbox();
  try {
    const cases: Array<[string, string[], string]> = [
      ['doctor', ['--bogus'], '--bogus'],
      ['doctor', ['--help'], '--help'],
      ['doctor', ['extra', 'more'], 'extra'],
      ['refresh', ['now'], 'now'],
      ['refresh', [`--app-secret=${APP_SECRET}`], '--app-secret'],
    ];
    for (const [command, args, named] of cases) {
      const run = runEntry(sandbox, [command, ...args]);
      assert.equal(run.status, 2, `[${command} ${args.join(' ')}] stderr: ${run.stderr}`);
      assert.equal(
        run.stderr,
        `${command}: unknown argument '${named}'; ${command} takes no arguments.\n\n${USAGE_TEXT}`,
      );
      assert.equal(run.stdout, '');
      assert.equal(run.stderr.includes(APP_SECRET), false, 'the inline value is never echoed');
    }
    // Nothing reached the network: the refusal is decided from argv alone.
    assert.deepEqual(await recordedRequests(sandbox), []);
  } finally {
    await sandbox.cleanup();
  }
});

test('a refused argv token never echoes an inline value or a token-shaped value (CC-PROC-208)', async () => {
  // A launcher's stderr lands in the MCP host's own log file. The unknown-
  // subcommand refusal echoed its token whole, so a client config carrying
  // `"args": ["--access-token=<token>"]` copied the token into that log; the
  // stray-argument refusal cut at `=` but echoed a bare token-shaped value.
  const shaped = `EAA${'b'.repeat(30)}`;
  const sandbox = await makeSandbox();
  try {
    const cases: Array<[string[], string]> = [
      [[`--access-token=${APP_SECRET}`], `instagram-mcp-ai: unknown subcommand '--access-token'.`],
      [[`=${APP_SECRET}`], `instagram-mcp-ai: unknown subcommand ''.`],
      [[`--a=${APP_SECRET}=x`], `instagram-mcp-ai: unknown subcommand '--a'.`],
      [[shaped], `instagram-mcp-ai: unknown subcommand '[REDACTED]'.`],
      [[`x${shaped}=v`], `instagram-mcp-ai: unknown subcommand 'x[REDACTED]'.`],
      [['doctor', shaped], `doctor: unknown argument '[REDACTED]'; doctor takes no arguments.`],
    ];
    for (const [args, line] of cases) {
      const run = runEntry(sandbox, args);
      assert.equal(run.status, 2, `[${args.join(' ')}] stderr: ${run.stderr}`);
      assert.equal(run.stderr, `${line}\n\n${USAGE_TEXT}`);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr.includes(APP_SECRET), false, 'the inline value is never echoed');
      assert.equal(run.stderr.includes(shaped), false, 'a token-shaped value is never echoed');
    }
  } finally {
    await sandbox.cleanup();
  }
});

test('the entry exits 1 with a clean, stack-free message when no profile is configured', async () => {
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, []);
    assert.equal(run.status, 1);
    // The ENTIRE stderr, byte for byte: one line, the prefix, the config
    // module's own sentence, a newline, and nothing else. The redactor is not
    // wired yet at this point, so the handler must print the message only — a
    // stack trace, a "see docs" suffix or a second line would be the first
    // place a token could leak, and a fragment match would let any of them by.
    assert.equal(
      run.stderr,
      'instagram-mcp-ai failed to start: No default profile configured; set IG_ACCESS_TOKEN ' +
        '(the default account token).\n',
    );
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

test('an IG_* name nothing reads is warned about by name at startup, values withheld', async () => {
  // A misspelt knob used to be silent: `IG_WRITEMODE=apply` left the server in
  // its default `preview` and nothing said so (CC-CFG-13). The warning names
  // every unrecognised `IG_*` key, sorted, and never its value — a mistyped
  // profile key carries a live token. `IG_TOKEN_EXPIRES_AT` is what `login`
  // and `refresh` write into the operator's `.env`; the server must recognise
  // its own handwriting or every refreshed install would warn forever.
  const sandbox = await makeSandbox();
  const strayValue = 'stray-value-never-echoed-0006';
  try {
    // The recognised set is assembled from four owner lists, and until now this
    // test planted typos only — so nothing distinguished "the filter consults
    // the list" from "the list exists". Measured 2026-09-23: emptying the
    // `ENTRY_ENV_NAMES` clause, and separately the `PACKAGE_ENV_NAMES` clause,
    // each survived the whole suite. Either one turns a correctly configured
    // knob into a startup warning that calls it a typo — the exact failure the
    // split-catalogue docstring says the four lists exist to prevent. One
    // correctly spelt name from each list is therefore planted here alongside
    // the typos, and the assertion below is that they do NOT appear
    // (CC-PROC-190).
    //
    // `IGNOREEOF` is a real variable an operator's shell exports. It starts
    // `IG` and not `IG_`, which is the namespace boundary the docstring names;
    // relaxing `startsWith('IG_')` to `startsWith('IG')` also survived, because
    // no fixture had ever stood on the far side of that underscore.
    const explicitEnvFile = path.join(sandbox.configHome, 'consulted-lists.env');
    await writeFile(
      explicitEnvFile,
      '# an explicit env file that exists and sets nothing\n',
      'utf8',
    );
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_ACCOUNT_ID: '17841400000000000',
        IG_TOKEN_EXPIRES_AT: '2026-12-31T00:00:00.000Z',
        IG_WRITEMODE: 'apply',
        IG_PROFILE_DEFAULT_ACCESS_TOKEN: strayValue,
        IG_PROFILE_ACCESS_TOKEN: strayValue,
        IG_ENV_FILE: explicitEnvFile,
        IG_HTTP_TOKEN: 'http-bearer-not-a-real-secret-0007',
        IG_TOOL_PACKAGES: 'core',
        IGNOREEOF: '1',
      },
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 0, `doctor must still pass, stderr: ${run.stderr}`);
    const warnings = logRecords(run.stderr).filter(
      (r) => r.msg === 'ignoring unrecognised IG_* environment variables',
    );
    assert.equal(warnings.length, 1, `exactly one warning, stderr: ${run.stderr}`);
    assert.equal(warnings[0]?.level, 'warn');
    assert.deepEqual(warnings[0]?.names, [
      'IG_PROFILE_ACCESS_TOKEN',
      'IG_PROFILE_DEFAULT_ACCESS_TOKEN',
      'IG_WRITEMODE',
    ]);
    assert.equal(warnings[0]?.hint, 'nothing reads these; check the spelling against .env.example');
    // The same three keys pinned as ONE value, `time` aside. Read a field at a
    // time, this warning cannot tell that a fourth key appeared beside them —
    // and the whole point of the line is that it names the offending variables
    // and withholds everything else, so what it does NOT carry is as much of
    // the contract as what it does. The stray values are checked below; this
    // pins the shape that keeps them out in the first place.
    const warning = { ...warnings[0] };
    assert.equal(typeof warning.time, 'number', `no usable timestamp: ${JSON.stringify(warning)}`);
    delete warning.time;
    assert.deepEqual(warning, {
      level: 'warn',
      msg: 'ignoring unrecognised IG_* environment variables',
      names: ['IG_PROFILE_ACCESS_TOKEN', 'IG_PROFILE_DEFAULT_ACCESS_TOKEN', 'IG_WRITEMODE'],
      hint: 'nothing reads these; check the spelling against .env.example',
    });
    assert.equal(run.stderr.includes(strayValue), false, 'values are never echoed');
    assert.equal(run.stderr.includes('IG_TOKEN_EXPIRES_AT'), false, 'the server owns this name');
    assert.equal(run.stderr.includes('IG_TEST_'), false, 'the harness knobs are not the entry’s');
  } finally {
    await sandbox.cleanup();
  }
});

test('the unrecognised-name warning reaches the operator whose typo stops the start', async () => {
  // The very operator the warning exists for is the one who typed
  // `IG_ACCESS_TOKN=`: with no readable token the entry refuses to start, and a
  // warning logged AFTER profile loading would never be printed. So it is the
  // first line, and the refusal is still the clean one-line message.
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, [], { env: { IG_ACCESS_TOKN: TOKEN } });
    assert.equal(run.status, 1);
    const lines = run.stderr.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 2, `stderr: ${run.stderr}`);
    const warning = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    assert.equal(warning.level, 'warn');
    assert.deepEqual(warning.names, ['IG_ACCESS_TOKN']);
    assert.equal(
      lines[1],
      'instagram-mcp-ai failed to start: No default profile configured; set IG_ACCESS_TOKEN ' +
        '(the default account token).',
    );
    assert.equal(run.stderr.includes(TOKEN), false, 'the misfiled token is never echoed');
    assert.equal(run.stdout, '');
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

    // The empty object parses, so doctor gets as far as reading it and refuses
    // it for carrying no account id (CC-DATA-88). A stub body of "undefined"
    // would not parse, reach getAccount as a bare string and be refused as "no
    // account object" instead.
    assert.equal(run.status, 1, `doctor must refuse an answer with no id, stderr: ${run.stderr}`);
    assert.match(
      run.stdout,
      /Reachability FAILED — .*the answer carries no usable account id \(no id field\)/,
    );
    assert.doesNotMatch(run.stdout, /no account object/);
    // The empty object carries no username, and doctor says nothing rather than
    // inventing one.
    assert.doesNotMatch(run.stdout, /\(@/);
  } finally {
    await sandbox.cleanup();
  }
});

// --- Rate-limit telemetry ---------------------------------------------------

test('the entry logs the rate-limit consumption the Graph response reported', async () => {
  // The `onUsage` seam is the ONLY thing in the process that observes how much
  // of the app's Graph quota a call spent, and Graph reports that exclusively in
  // RESPONSE HEADERS — never in the body. Until this test the stub could not set
  // a header at all, so `createIgRequest`'s `onUsage` argument was wired at the
  // composition root and never once called end-to-end: deleting the whole
  // `onUsage:` line from `src/index.ts` left the entire suite green. The failure
  // that hides behind that is silent and slow — an operator running at 95% of
  // quota gets no warning, and the first symptom is Graph refusing calls
  // outright (CC-RATE-8).
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_ACCOUNT_ID: '17841400000000000',
        // The usage record is `debug`; at the default `info` it is dropped at
        // the sink and this test would pass on an empty stream.
        IG_LOG_LEVEL: 'debug',
      },
      routes: [
        {
          match: '/17841400000000000',
          body: { id: '17841400000000000', username: 'acme' },
          // Every number here is distinct and chosen so that ONE arm of the
          // parse owns the answer. `X-App-Usage` peaks at 47 and the
          // business-use-case header at 63, so a reported 63 proves both were
          // read and the higher kept — the min, or `X-App-Usage` alone, would
          // say 47. Inside the BUC header the winner is in the SECOND entry of
          // the SECOND id, so a walk that stops at the first bucket or the first
          // entry says 47 as well. The two ids are not the same account on
          // purpose: Graph keys this header per business, and a real app talks
          // to more than one.
          headers: {
            'x-app-usage': '{"call_count":31,"total_cputime":12,"total_time":47}',
            'x-business-use-case-usage':
              '{"17841400000000000":[{"call_count":9,"total_cputime":4}],' +
              '"17841400000000001":[{"call_count":21},{"call_count":63,"total_cputime":8}]}',
          },
        },
      ],
    });

    assert.equal(run.status, 0, `doctor should be healthy, stderr: ${run.stderr}`);

    const usage = logRecords(run.stderr).filter((r) => r.msg === 'graph usage');
    // One record per RESPONSE, so the count is pinned to the traffic rather
    // than merely "at least one": a seam that reported twice per call would
    // double-count the quota an operator is reading.
    assert.equal(
      usage.length,
      (await recordedRequests(sandbox)).length,
      `expected one usage record per request, got ${JSON.stringify(usage)}`,
    );
    assert.equal(usage[0]?.maxPct, 63);
    // Pinned to the host the call actually went to, not to a constant: the two
    // auth paths consume two SEPARATE quotas, and a record naming the wrong one
    // sends an operator to throttle the host that was never the problem.
    assert.equal(usage[0]?.host, 'graph.instagram.com');
    // The raw headers stay OUT of the log. They are bulky, they are Meta's
    // shape to change, and `UsageSnapshot.raw` carries them for a caller that
    // asks — the entry's line is a summary an operator reads, not a dump.
    assert.equal(Object.hasOwn(usage[0] ?? {}, 'raw'), false);
    // ...and nowhere else in the log either. The check above looks inside ONE
    // record, so moving the dump to a line of its own — `graph usage headers`,
    // say — satisfies it while putting Meta's headers back on the operator's
    // stream. The claim is about the log, so it is asserted against the log.
    for (const fragment of ['x-app-usage', 'x-business-use-case-usage', 'call_count']) {
      assert.equal(
        run.stderr.includes(fragment),
        false,
        `raw usage headers reached the log via ${fragment}: ${run.stderr}`,
      );
    }
    // The record itself pinned WHOLE, `time` aside. Every assertion above reads
    // one key at a time off a slice filtered by `msg`, so neither a field added
    // beside `maxPct` nor a move to another level is visible to any of them —
    // and the level is the load-bearing half here: this line is deliberately
    // `debug`, below the operator's default, because it fires once per Graph
    // response and would otherwise drown the stream it shares with real events.
    const summary = { ...usage[0] };
    assert.equal(typeof summary.time, 'number', `no usable timestamp: ${JSON.stringify(summary)}`);
    delete summary.time;
    assert.deepEqual(summary, {
      level: 'debug',
      msg: 'graph usage',
      host: 'graph.instagram.com',
      maxPct: 63,
    });
  } finally {
    await sandbox.cleanup();
  }
});

test('the app-usage header alone still reports, across all three of its fields', async () => {
  // The companion to the test above, and the reason it is a SEPARATE run: there
  // the business-use-case header carries the larger number, so it — and it
  // alone — decides `maxPct`. Dropping the `X-App-Usage` parse entirely was
  // therefore invisible. Here it is the only header present, so nothing else can
  // supply the answer.
  //
  // Its value is `total_cputime`, the MIDDLE field, and it is larger than both
  // its neighbours: Graph throttles on whichever of call volume, CPU and wall
  // time runs out first, so a parse that reads only `call_count` — the obvious
  // one, and the one a summary would name — would report 12% while the app is
  // at 88% of its CPU budget and about to be cut off.
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_ACCOUNT_ID: '17841400000000000',
        IG_LOG_LEVEL: 'debug',
      },
      routes: [
        {
          match: '/17841400000000000',
          body: { id: '17841400000000000', username: 'acme' },
          headers: { 'x-app-usage': '{"call_count":12,"total_cputime":88,"total_time":47}' },
        },
      ],
    });

    assert.equal(run.status, 0, `doctor should be healthy, stderr: ${run.stderr}`);

    const usage = logRecords(run.stderr).filter((r) => r.msg === 'graph usage');
    assert.equal(usage.length, 1, `expected one usage record, got ${JSON.stringify(usage)}`);
    assert.equal(usage[0]?.maxPct, 88);
  } finally {
    await sandbox.cleanup();
  }
});

test('a response that reports no usage headers logs no percentage rather than zero', async () => {
  // Graph omits the headers on some routes and on some errors. The snapshot is
  // then EMPTY, and the distinction this pins is the one an operator acts on:
  // "Graph told us nothing" must not render as `maxPct: 0`, which reads as
  // "nothing consumed" and is the most reassuring possible lie. An absent key
  // is the honest answer, and the reason `parseUsage` builds the snapshot
  // key-by-key instead of defaulting the fields.
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_ACCOUNT_ID: '17841400000000000',
        IG_LOG_LEVEL: 'debug',
      },
      routes: [
        { match: '/17841400000000000', body: { id: '17841400000000000', username: 'acme' } },
      ],
    });

    assert.equal(run.status, 0, `doctor should be healthy, stderr: ${run.stderr}`);

    const usage = logRecords(run.stderr).filter((r) => r.msg === 'graph usage');
    // The seam still fires — the absence is in the VALUE, not in the reporting.
    assert.equal(usage.length, 1, `expected one usage record, got ${JSON.stringify(usage)}`);
    assert.equal(Object.hasOwn(usage[0] ?? {}, 'maxPct'), false);
    assert.equal(usage[0]?.host, 'graph.instagram.com');
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

test('a ~ config home from an unexpanding client env finds what a terminal login wrote (CC-CFG-60)', async () => {
  // An MCP client's JSON `env` block hands `XDG_CONFIG_HOME` (or `APPDATA`)
  // over literally, while the terminal that ran `login` let the shell expand the
  // same `~/cfg`. The entry used to ignore the unexpanded value as relative and
  // read the default home, so the credentials `login` wrote were never found.
  const sandbox = await makeSandbox();
  try {
    const home = path.join(path.dirname(sandbox.configHome), 'home');
    await mkdir(home, { recursive: true });
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: path.join(home, 'cfg') },
    );
    const variable = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
    const run = runEntry(sandbox, ['doctor'], {
      env: { HOME: home, USERPROFILE: home, [variable]: '~/cfg' },
      routes: [
        { match: '/17841400000000000', body: { id: '17841400000000000', username: 'acme' } },
      ],
    });
    assert.equal(run.status, 0, `doctor should be healthy, stderr: ${run.stderr}`);
    assert.match(run.stdout, /Active profile: default \(ig-login/);
  } finally {
    await sandbox.cleanup();
  }
});

test('a config home only a shell could expand stops the entry with a clear error (CC-CFG-61)', async () => {
  // `$HOME/cfg` names a directory to a shell and to nothing else. Ignored, the
  // server would silently read the default home while `login` in a terminal
  // wrote to the expanded one; the entry refuses to start and says why instead.
  const sandbox = await makeSandbox();
  try {
    const home = path.join(path.dirname(sandbox.configHome), 'home');
    const variable = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
    const run = runEntry(sandbox, ['doctor'], {
      env: { HOME: home, USERPROFILE: home, [variable]: '$HOME/cfg' },
    });
    assert.equal(run.status, 1);
    assert.equal(
      run.stderr,
      `instagram-mcp-ai failed to start: ${variable} is "$HOME/cfg", which only a shell can ` +
        'expand — it is not a path this server can use to find the credential store; set it ' +
        'to an absolute path\n',
    );
    assert.equal(run.stdout, '');
    assert.deepEqual(await recordedRequests(sandbox), [], 'nothing reached the wire');
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

test('every candidate env file is loaded, so the project .env still fills the gaps', async () => {
  // "The config home outranks the project `.env`" is only half the rule. The
  // candidate list is loaded in FULL, not until the first hit: `override: false`
  // hands the config home every key it sets, and the project file is then free
  // to supply the keys it does not. That is what lets a developer keep a
  // checked-out `.env` for knobs while `login`/`refresh` own the credential.
  //
  // Stopping after the first file that exists leaves the precedence test above
  // green — both files carry the same keys there, so the project one contributes
  // nothing either way — while silently dropping every setting only the project
  // file declares. Separating the two needs a key that exactly ONE of them sets,
  // so the config home carries the credential and the project file carries a
  // knob whose effect is visible in the run's own output.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: sandbox.configHome },
    );
    await writeFile(path.join(sandbox.cwd, '.env'), 'IG_LOG_LEVEL=debug\n', 'utf8');

    const run = runEntry(sandbox, ['doctor'], {
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    // The credential still comes from the config home, exactly as before...
    const requests = await recordedRequests(sandbox);
    assert.ok(
      (requests[0] ?? '').includes(`access_token=${encodeURIComponent(TOKEN)}`),
      `the config-home token must still win: ${requests.join(' | ')}`,
    );
    // ...and the knob only the project file declares took effect anyway.
    assert.ok(
      logRecords(run.stderr).some((r) => r.level === 'debug' && r.msg === 'graph request'),
      `the project .env's IG_LOG_LEVEL never reached the logger: ${run.stderr}`,
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('the entry logs at the level settings resolved, not at one of its own', async () => {
  // `createLogger({ level: settings.logLevel, ... })` is the only place the
  // operator's `IG_LOG_LEVEL` becomes an actual filter, and every other test
  // here either asks for `debug` or reads records that survive any level. Pin
  // the level down and nothing fails: a hardcoded `debug` is invisible to a test
  // that only ever looks for records it expects to find. The failure it hides is
  // not cosmetic — `graph request` names the host and path of every call the
  // server makes, so an entry that ignores the configured level narrates the
  // operator's whole Graph traffic into stderr on a server they asked to keep
  // quiet, and buries the warnings they did ask for in it.
  const sandbox = await makeSandbox();
  try {
    const opts = {
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
      env: { IG_ACCESS_TOKEN: TOKEN, IG_ACCOUNT_ID: '17841400000000000' },
    };

    const quiet = runEntry(sandbox, ['doctor'], {
      ...opts,
      env: { ...opts.env, IG_LOG_LEVEL: 'warn' },
    });
    assert.equal(quiet.status, 0, `stderr: ${quiet.stderr}`);
    assert.deepEqual(
      logRecords(quiet.stderr).filter((r) => r.level === 'debug'),
      [],
      `IG_LOG_LEVEL=warn must silence every debug record: ${quiet.stderr}`,
    );

    // The control: the same run at `debug` DOES emit one, so the assertion above
    // is a filter doing its job and not a path that simply logs nothing.
    const loud = runEntry(sandbox, ['doctor'], {
      ...opts,
      env: { ...opts.env, IG_LOG_LEVEL: 'debug' },
    });
    assert.equal(loud.status, 0, `stderr: ${loud.stderr}`);
    assert.ok(
      logRecords(loud.stderr).some((r) => r.level === 'debug' && r.msg === 'graph request'),
      `IG_LOG_LEVEL=debug must let the request record through: ${loud.stderr}`,
    );
  } finally {
    await sandbox.cleanup();
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

test('an explicit IG_ENV_FILE is loaded and is EXCLUSIVE — the standard candidates are skipped', async () => {
  // The other arm of the same decision (docs/plugin-install.md §"Where config
  // comes from"): a path in `IG_ENV_FILE` REPLACES the candidate list rather
  // than being prepended to it. Both halves need a run where the explicit file
  // and the config home disagree — a test with only one file on disk passes
  // whether the list is replaced or merely extended.
  //
  // It was previously exercised only by `test/release/packaging.test.ts`, which
  // spawns the packaged launcher against the shared build; that made a branch of
  // the entry's own module depend on a release test for its coverage.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: sandbox.configHome },
    );
    // Deliberately NOT `<configHome>/instagram-mcp-ai/.env` — a file at a path
    // nothing would look at unless it was named explicitly.
    const explicit = path.join(sandbox.configHome, 'operator-chosen.env');
    await writeFile(
      explicit,
      `IG_ACCESS_TOKEN=${EXPLICIT_TOKEN}\nIG_ACCOUNT_ID=17841400000000000\n`,
      'utf8',
    );

    // The candidate list this REPLACES has two entries, and the assertions below
    // only ever disproved the config-home one. Measured 2026-09-23: appending
    // `path.resolve(process.cwd(), '.env')` back onto the explicit branch
    // survived the whole suite. `override: false` keeps the credential half
    // safe — the explicit file still wins on any key it sets — but every key it
    // does NOT set stays injectable from whatever `.env` happens to sit in the
    // MCP client's working directory. An unrecognised name is the cheapest
    // observable for "this file was read at all": if the project `.env` got in,
    // the startup warning names it (CC-PROC-191).
    await writeFile(path.join(sandbox.cwd, '.env'), 'IG_LEAKED_FROM_PROJECT_ENV=1\n', 'utf8');

    const run = runEntry(sandbox, ['doctor'], {
      env: { IG_ENV_FILE: explicit },
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 0, `the explicit env file must be loaded, stderr: ${run.stderr}`);
    assert.equal(
      run.stderr.includes('IG_LEAKED_FROM_PROJECT_ENV'),
      false,
      `the project-local .env was read in spite of the explicit path: ${run.stderr}`,
    );
    const requests = await recordedRequests(sandbox);
    assert.ok(
      (requests[0] ?? '').includes(`access_token=${encodeURIComponent(EXPLICIT_TOKEN)}`),
      `the explicitly named file never reached the wire: ${requests.join(' | ')}`,
    );
    assert.ok(
      !(requests[0] ?? '').includes(TOKEN),
      'the config home must not be consulted when an explicit file is named',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('an explicit IG_ENV_FILE never overrides a value the MCP client passed in', async () => {
  // The explicit file is loaded on its own branch, so it needs its own proof of
  // the same `override: false` contract the candidate list is held to above: a
  // named file is still a file on disk, and the client's environment beats it.
  const sandbox = await makeSandbox();
  try {
    const explicit = path.join(sandbox.configHome, 'operator-chosen.env');
    await writeFile(
      explicit,
      `IG_ACCESS_TOKEN=${EXPLICIT_TOKEN}\nIG_ACCOUNT_ID=17841400000000000\n`,
      'utf8',
    );

    const run = runEntry(sandbox, ['doctor'], {
      env: { IG_ENV_FILE: explicit, IG_ACCESS_TOKEN: CLIENT_TOKEN },
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
  } finally {
    await sandbox.cleanup();
  }
});

test('an MCPB placeholder for an unset optional field reads as unset, not as a value (CC-CFG-46)', async () => {
  // An MCPB host may hand an optional `user_config` field the user left empty
  // to the server as the literal template `${user_config.IG_ACCOUNT_ID}`.
  // Read as a value, that string outranks the config-home file (the client's
  // environment always wins) and becomes the account id every request is sent
  // to; as `IG_ENV_FILE` it names a file that does not exist and refuses the
  // start. Treated as unset, the file fills the gap as it would for an absent key.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: sandbox.configHome },
    );

    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_ACCOUNT_ID: '${user_config.IG_ACCOUNT_ID}',
        IG_ENV_FILE: '${user_config.IG_ENV_FILE}',
        IG_MAX_ITEMS: '${user_config.IG_MAX_ITEMS}',
      },
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const requests = await recordedRequests(sandbox);
    assert.match(requests[0] ?? '', /\/17841400000000000\?/, requests.join(' | '));
    assert.equal(requests.join('').includes('user_config'), false, 'no placeholder reaches Graph');
    assert.equal(
      run.stderr.includes('IG_MAX_ITEMS'),
      false,
      `no settings complaint: ${run.stderr}`,
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('an MCPB placeholder written INTO an env file reads as unset too, so a later file fills it (CC-CFG-71)', async () => {
  // The CC-CFG-46 scrub ran over the client's environment only. A file that
  // carries the literal template — copied from a manifest, or written by a host
  // that expands nothing — handed `${user_config.IG_ACCOUNT_ID}` on as the
  // account id, and the key, now "set", kept the project `.env` from supplying
  // it. File values are now judged by the same rule the environment is.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login' },
      { configDir: sandbox.configHome },
    );
    const home = envFileIn(sandbox.configHome);
    await writeFile(
      home,
      `${await readFile(home, 'utf8')}IG_ACCOUNT_ID=\${user_config.IG_ACCOUNT_ID}\n` +
        'IG_MAX_ITEMS=${user_config.IG_MAX_ITEMS}\n',
      'utf8',
    );
    await writeFile(path.join(sandbox.cwd, '.env'), 'IG_ACCOUNT_ID=17841400000000000\n', 'utf8');

    const run = runEntry(sandbox, ['doctor'], {
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const requests = await recordedRequests(sandbox);
    assert.match(requests[0] ?? '', /\/17841400000000000\?/, requests.join(' | '));
    assert.equal(requests.join('').includes('user_config'), false, 'no placeholder reaches Graph');
    assert.equal(
      run.stderr.includes('IG_MAX_ITEMS'),
      false,
      `no settings complaint: ${run.stderr}`,
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('a relative IG_ENV_FILE stops the start instead of reading a file relative to the cwd (CC-CFG-70)', async () => {
  // The entry read a relative value against the cwd its client chose, while
  // `login` / `refresh` refused the same value: a server could run for weeks on
  // a file no refresh would ever update. The start now refuses it by the rule
  // the writer uses, even when a file of that name sits in the cwd.
  const sandbox = await makeSandbox();
  try {
    await writeFile(
      path.join(sandbox.cwd, 'relative.env'),
      `IG_ACCESS_TOKEN=${TOKEN}\nIG_ACCOUNT_ID=17841400000000000\n`,
      'utf8',
    );
    const run = runEntry(sandbox, ['doctor'], {
      env: { IG_ENV_FILE: 'relative.env' },
      routes: [{ match: '/17841400000000000', body: { id: '17841400000000000' } }],
    });

    assert.equal(run.status, 1, run.stderr);
    assert.equal(
      run.stderr,
      'instagram-mcp-ai failed to start: IG_ENV_FILE is set to "relative.env", which is not ' +
        'an absolute file name. A relative name is resolved against the working directory of ' +
        'whichever process reads it — for the server, the directory its MCP client starts it ' +
        'in — so the server and login / refresh could each use a different file; set ' +
        'IG_ENV_FILE to an absolute file name (a leading "~" is the home directory) and try ' +
        'again.\n',
    );
    assert.deepEqual(await recordedRequests(sandbox), []);
  } finally {
    await sandbox.cleanup();
  }
});

test("a token the client passes is never reported with the config home's recorded expiry", async () => {
  // The env files merge UNDER the client's environment key by key, so without
  // the source check the client's token was paired with the expiry `login`
  // recorded for the token in the config home — a different token — and
  // `doctor` reported that other token's expiry as this one's.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      {
        accessToken: TOKEN,
        authPath: 'ig-login',
        accountId: '17841400000000000',
        expiresAtSec: 4_000_000_000,
      },
      { configDir: sandbox.configHome },
    );
    const routes = [{ match: '/17841400000000000', body: { id: '17841400000000000' } }];

    // Control: the file's own token keeps its own record.
    const own = runEntry(sandbox, ['doctor'], { routes });
    assert.equal(own.status, 0, `stderr: ${own.stderr}`);
    assert.match(own.stdout, /Token expiry \(recorded in IG_TOKEN_EXPIRES_AT\): valid/);

    const client = runEntry(sandbox, ['doctor'], {
      env: { IG_ACCESS_TOKEN: CLIENT_TOKEN },
      routes,
    });
    assert.equal(client.status, 0, `stderr: ${client.stderr}`);
    assert.doesNotMatch(client.stdout, /recorded in IG_TOKEN_EXPIRES_AT\): valid/);
    assert.match(
      client.stdout,
      /Token expiry: unknown — Token expiry is unknown: no usable expiry/,
    );

    // A client that passes the token AND its record keeps both: same source.
    const both = runEntry(sandbox, ['doctor'], {
      env: { IG_ACCESS_TOKEN: CLIENT_TOKEN, IG_TOKEN_EXPIRES_AT: '4000000000' },
      routes,
    });
    assert.equal(both.status, 0, `stderr: ${both.stderr}`);
    assert.match(both.stdout, /Token expiry \(recorded in IG_TOKEN_EXPIRES_AT\): valid/);
  } finally {
    await sandbox.cleanup();
  }
});

test('an IG_ENV_FILE that names no readable file refuses to start and names the variable', async () => {
  // The explicit path REPLACES the candidate list, so a typo in it used to leave
  // the process with no env file at all and nothing on stderr saying so: the
  // operator read "No default profile configured" about the file they had just
  // configured, and with a token in the real environment the server started
  // without any of the other knobs that file set. A missing path and a
  // directory are the two shapes dotenv reports through `error` without
  // throwing; both must be refused before anything else runs.
  const sandbox = await makeSandbox();
  try {
    const missing = path.join(sandbox.configHome, 'no-such.env');
    const directory = path.join(sandbox.configHome, 'a-directory.env');
    await mkdir(directory, { recursive: true });
    for (const explicit of [missing, directory]) {
      const run = runEntry(sandbox, ['doctor'], {
        env: { IG_ENV_FILE: explicit, IG_ACCESS_TOKEN: TOKEN },
        routes: [{ match: '/me', body: { id: '17841400000000000' } }],
      });
      assert.equal(run.status, 1, `an unreadable IG_ENV_FILE must refuse, stderr: ${run.stderr}`);
      assert.equal(
        run.stderr,
        `instagram-mcp-ai failed to start: IG_ENV_FILE names "${explicit}", which could not be read as an env file\n`,
      );
      assert.equal(run.stdout, '');
      assert.deepEqual(await recordedRequests(sandbox), [], 'nothing may reach the wire');
    }
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

test('doctor judges token expiry against the injected clock, not against an unset one', async () => {
  // The expiry verdict is the only place a doctor run consults an instant at all,
  // and every other doctor test is blind to it: Path A reports `unknown`, and so
  // does a `debug_token` that carries no `expires_at`. What this pins is the
  // verdict itself, measured against an INJECTED instant rather than the real
  // wall clock — an expired credential must read `expired`, must not read
  // `valid` with decades left on it, and must exit 1 rather than send an
  // operator hunting the outage anywhere but the token.
  //
  // It deliberately does not claim to pin the `nowMs: clock.now()` wiring.
  // Dropping that argument is not separable by any input, here or in production:
  // `runDoctor` falls back to `Date.now()`, which is what `systemClock.now()`
  // reads — and the child's preload pins `Date.now()` to this very instant, so
  // both spellings answer identically. The wiring stays for the reason the
  // matching note on the `refresh` path in `src/index.ts` gives: the composition
  // root is the one place that injects the clock.
  const sandbox = await makeSandbox();
  try {
    // Now is 2025-08-12T12:00:00Z; the token died ~11 days before that.
    const nowMs = 1_755_000_000_000;
    const expiresAtSec = 1_754_000_000;
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_AUTH_PATH: 'fb-login',
        IG_APP_ID: '1234567890',
        IG_APP_SECRET: APP_SECRET,
        IG_TEST_FAKE_NOW_MS: String(nowMs),
      },
      routes: [
        {
          match: '/debug_token',
          body: { data: { is_valid: true, app_id: '1234567890', expires_at: expiresAtSec } },
        },
        { match: '/me', body: { id: '17841400000000000' } },
      ],
    });

    assert.equal(run.status, 1, `an expired token must fail the health check: ${run.stdout}`);
    // The whole line, as `test/cli/doctor.test.ts` pins it in-process: the entry
    // must hand the clock and the profile through unchanged, and a fragment
    // match would let the verdict drift its guidance or its timestamp.
    assert.equal(
      run.stdout.split('\n').find((l) => l.includes('Token expiry:')),
      '  FAIL  Token expiry: expired — Token expired at 2025-07-31T22:13:20.000Z; ' +
        'run the `login` CLI to obtain a new one.',
    );
    // The report is emitted as one write TERMINATED by a newline. Without it the
    // operator's next shell prompt lands mid-line on the summary, and a
    // line-oriented reader (a runbook `grep`, a CI log collector) can drop the
    // last line — which is the line carrying the verdict.
    assert.ok(
      run.stdout.endsWith('\n'),
      `the report must end with a newline: ${JSON.stringify(run.stdout.slice(-40))}`,
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('the Graph seam authenticates as the profile it was handed, not as the first one', async () => {
  // `makeRequest(profile)` is where a resolved profile becomes credentials on the
  // wire, and it is shared by the CLI diagnostics and every tool call. Bind it to
  // a fixed profile instead and a multi-account run acts as the WRONG account
  // while reporting the right one: doctor's header names `brand`, the request
  // asks the Graph API about `brand`'s account id, and the token proving who is
  // asking belongs to `default`. The same seam then signs writes, so the mix-up
  // is not confined to a read-only health check.
  const sandbox = await makeSandbox();
  try {
    const brandId = '17841400000000001';
    const run = runEntry(sandbox, ['doctor'], {
      env: {
        IG_ACCESS_TOKEN: PLAIN_TOKEN,
        IG_AUTH_PATH: 'ig-login',
        IG_ACCOUNT_ID: '17841400000000000',
        IG_PROFILE_BRAND_ACCESS_TOKEN: PLAIN_ALT_TOKEN,
        IG_PROFILE_BRAND_AUTH_PATH: 'ig-login',
        IG_PROFILE_BRAND_ACCOUNT_ID: brandId,
        IG_ACTIVE_PROFILE: 'brand',
      },
      routes: [{ match: `/${brandId}`, body: { id: brandId } }],
    });

    assert.equal(run.status, 0, `doctor should be healthy, stderr: ${run.stderr}`);
    const requests = await recordedRequests(sandbox);
    assert.equal(requests.length, 1, requests.join(' | '));
    assert.ok(
      (requests[0] ?? '').includes(`access_token=${PLAIN_ALT_TOKEN}`),
      `the active profile's own credential must authenticate the call: ${requests[0] ?? ''}`,
    );
    assert.ok(
      !(requests[0] ?? '').includes(PLAIN_TOKEN),
      `no other profile's credential may reach the wire: ${requests[0] ?? ''}`,
    );
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
    // The path is the operator's next step ("which file do I copy / check in?"),
    // and it is the only part of the notice that can be silently wrong: the write
    // resolves the config home itself, so a notice that omits it — or names the
    // path the test asked for rather than the one `writeCredentials` returned —
    // reads exactly the same on a run that saved the token somewhere else.
    assert.ok(
      run.stderr.includes(envFileIn(sandbox.configHome)),
      `the notice must name the file that was actually written: ${run.stderr}`,
    );
    // The three assertions above pin three pieces of one line: its head, its
    // expiry clause and the path somewhere inside it. None of them is
    // `$`-anchored, so text inserted between the path and `(expires:` — or
    // appended after the final stop, or on a second line — rides along unread.
    // Every part of this notice is already known exactly here (the path from
    // `envFileIn`, the instant from the pinned clock), so there is no reason to
    // pin it in pieces. Pinned against the whole stream rather than its first
    // line: on this run the notice IS the entire stderr, and with `stdout`
    // already pinned empty above, that makes everything the process said an
    // assertion.
    assert.equal(
      run.stderr,
      `Refreshed ig-login token for profile 'default' -> ${envFileIn(sandbox.configHome)} ` +
        `(expires: 2025-10-11T12:00:00.000Z).\n`,
      'the whole notice and nothing else, so no added clause or extra line rides along',
    );

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
    assert.match(
      saved,
      new RegExp(`^IG_TOKEN_EXPIRES_AT=1760184000:${tokenFingerprint(refreshed)}$`, 'm'),
    );
    assert.ok(!saved.includes(TOKEN), 'the stale token must be replaced, not appended');
  } finally {
    await sandbox.cleanup();
  }
});

test('refresh with an explicit IG_ENV_FILE writes that file, the only one the server reads (CC-CFG-63)', async () => {
  // The read side REPLACES its candidate list with `IG_ENV_FILE`; a write that
  // still went to the config home would leave the fresh token where the next
  // start never looks, and the old one — soon expired — where it does.
  const sandbox = await makeSandbox();
  try {
    const explicit = path.join(sandbox.configHome, 'operator-chosen.env');
    await writeFile(
      explicit,
      `IG_ACCESS_TOKEN=${TOKEN}\nIG_AUTH_PATH=ig-login\nIG_ACCOUNT_ID=17841400000000000\n`,
      'utf8',
    );
    const refreshed = 'IGQ-refreshed-into-explicit-file';
    const run = runEntry(sandbox, ['refresh'], {
      env: { IG_ENV_FILE: explicit },
      routes: [
        {
          match: '/refresh_access_token',
          body: { access_token: refreshed, token_type: 'bearer', expires_in: 5_184_000 },
        },
      ],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.ok(run.stderr.includes(`-> ${explicit} `), run.stderr);
    const saved = await readFile(explicit, 'utf8');
    assert.match(saved, new RegExp(`^IG_ACCESS_TOKEN=${refreshed}$`, 'm'));
    assert.match(saved, /^IG_ACCOUNT_ID=17841400000000000$/m, 'merged in place, not replaced');
    await assert.rejects(
      readFile(envFileIn(sandbox.configHome), 'utf8'),
      { code: 'ENOENT' },
      'the config home is not written when IG_ENV_FILE names the store',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('a "~" IG_ENV_FILE is the home directory for the read AND the refresh write (CC-CFG-66)', async () => {
  // An MCP client's JSON `env` passes `~/…` unexpanded. dotenv expanded it for
  // the read, but the writer refused it as relative, so `refresh` failed after
  // the server had loaded that very file. Both sides now expand it the same
  // way, so the file refresh reads is the file it writes.
  const sandbox = await makeSandbox();
  try {
    const home = path.join(path.dirname(sandbox.cwd), 'home');
    await mkdir(home, { recursive: true });
    const named = path.join(home, 'ig.env');
    await writeFile(
      named,
      `IG_ACCESS_TOKEN=${TOKEN}\nIG_AUTH_PATH=ig-login\nIG_ACCOUNT_ID=17841400000000000\n`,
      'utf8',
    );
    const refreshed = 'IGQ-refreshed-into-tilde-file';
    const run = runEntry(sandbox, ['refresh'], {
      env: { IG_ENV_FILE: '~/ig.env', HOME: home, USERPROFILE: home },
      routes: [
        {
          match: '/refresh_access_token',
          body: { access_token: refreshed, token_type: 'bearer', expires_in: 5_184_000 },
        },
      ],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.ok(run.stderr.includes(`-> ${named} `), run.stderr);
    assert.match(await readFile(named, 'utf8'), new RegExp(`^IG_ACCESS_TOKEN=${refreshed}$`, 'm'));
    await assert.rejects(stat(path.join(sandbox.cwd, '~')), { code: 'ENOENT' });
  } finally {
    await sandbox.cleanup();
  }
});

test('a shell-only IG_ENV_FILE stops the start with the variable named (CC-CFG-67)', async () => {
  // `$HOME/…`, `%APPDATA%…` and `~user/…` resolve only in a shell. The entry used
  // to pass them to dotenv — which reported the first two as unreadable and read
  // `~root/ig.env` as `<home>/root/ig.env` — and the refusal now names IG_ENV_FILE
  // and says what to set, before any request.
  for (const value of ['$HOME/ig.env', '%APPDATA%\\ig.env', '~root/ig.env']) {
    const sandbox = await makeSandbox();
    try {
      const run = runEntry(sandbox, ['refresh'], { env: { IG_ENV_FILE: value } });

      assert.equal(run.status, 1, `${value}: ${run.stderr}`);
      assert.equal(
        run.stderr,
        `instagram-mcp-ai failed to start: IG_ENV_FILE is ${JSON.stringify(value)}, which only ` +
          'a shell can expand — it is not a path this server can use to find the credential ' +
          'store; set it to an absolute path\n',
      );
      assert.deepEqual(await recordedRequests(sandbox), []);
    } finally {
      await sandbox.cleanup();
    }
  }
});

test('an IG_ENV_FILE that an env file supplies is dropped, so refresh writes where it read (CC-CFG-63)', async () => {
  // The server follows `IG_ENV_FILE` only from the client's environment; one set
  // INSIDE a loaded file arrives too late to change what was read. The writer
  // honours whatever the variable says, so without the drop the token would be
  // written to a file no start reads.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: sandbox.configHome },
    );
    const elsewhere = path.join(sandbox.configHome, 'elsewhere.env');
    const home = envFileIn(sandbox.configHome);
    await writeFile(home, `${await readFile(home, 'utf8')}IG_ENV_FILE=${elsewhere}\n`, 'utf8');
    const refreshed = 'IGQ-refreshed-into-config-home';
    const run = runEntry(sandbox, ['refresh'], {
      routes: [
        {
          match: '/refresh_access_token',
          body: { access_token: refreshed, token_type: 'bearer', expires_in: 5_184_000 },
        },
      ],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.ok(run.stderr.includes(`-> ${home} `), run.stderr);
    assert.match(await readFile(home, 'utf8'), new RegExp(`^IG_ACCESS_TOKEN=${refreshed}$`, 'm'));
    await assert.rejects(readFile(elsewhere, 'utf8'), { code: 'ENOENT' });
  } finally {
    await sandbox.cleanup();
  }
});

test('refresh exits when it is done instead of falling through into a server start', async () => {
  // Each subcommand branch ENDS the process. Lose that exit and `refresh` carries
  // on into the server path: it registers the whole tool surface and starts the
  // stdio transport, so a one-shot maintenance command an operator ran by hand
  // never returns — an interactive stdin reaches no EOF — and the credential that
  // was just rotated is served by a process nobody meant to start. The exit code
  // cannot show that here: a spawned child's stdin is already closed, so the
  // stray transport shuts down at once and the run still ends 0. The startup
  // telemetry is what gives it away — after a `refresh` there must be none.
  const sandbox = await makeSandbox();
  try {
    const run = runEntry(sandbox, ['refresh'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_AUTH_PATH: 'ig-login',
        IG_ACCOUNT_ID: '17841400000000000',
        IG_LOG_LEVEL: 'info',
      },
      routes: [
        {
          match: '/refresh_access_token',
          body: { access_token: 'IGQ-refreshed-token-value', expires_in: 5_184_000 },
        },
      ],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.match(run.stderr, /^Refreshed ig-login token for profile 'default' -> /);
    assert.doesNotMatch(run.stderr, /tools registered/, 'refresh must not register a tool surface');
    assert.doesNotMatch(run.stderr, /mcp server ready/, 'refresh must not start a transport');
    // ...and nothing beyond the exchange itself ever reached the network.
    assert.equal((await recordedRequests(sandbox)).length, 1);
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
  // emergency. The sentinel is reached through an `expires_in` of exactly 0,
  // the one lifetime that means "never" (CC-AUTH-64); a lifetime that merely
  // sums to the epoch is no record at all (CC-AUTH-65). The clock is pinned
  // so nothing in this run depends on the wall clock.
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
          body: { access_token: 'IGQ-never-expires', expires_in: 0 },
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

test('refresh survives an expires_in that names no instant a Date can hold', async () => {
  // `1e300` is finite, so it clears every `Number.isFinite` filter, and JSON
  // numbers are unbounded so it needs no hostile upstream — a truncated or
  // malformed numeric literal is enough. Added to `now` it is still `1e300`, and
  // `new Date(1e303)` is an Invalid Date whose `toISOString()` throws a bare
  // `RangeError: Invalid time value`.
  //
  // What made that severe is WHERE it landed: the notice is printed after the
  // rotated token has already been written to disk, so the throw turned a
  // successful rotation into `instagram-mcp-ai failed to start: Invalid time
  // value` and exit 1 — telling the operator to re-run a rotation that had in
  // fact succeeded, against an upstream that just rate-limited them for it.
  //
  // The assertion is deliberately about the label's STEM (`expires: unknown`),
  // not its full text: whether the value is filtered in `core/refresh.ts` or
  // rendered unrepresentable here, the honest answer is "unknown" either way and
  // this test pins the property that matters — no crash, no invented instant.
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
          body: { access_token: 'IGQ-absurd-expiry', expires_in: 1e300 },
        },
      ],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.match(run.stderr, /^Refreshed ig-login token for profile 'default' -> /);
    assert.match(run.stderr, /\(expires: unknown/);
    assert.doesNotMatch(run.stderr, /Invalid time value|Invalid Date|RangeError|NaN/);
    // The rotation itself still has to have happened: the whole point of not
    // throwing is that the token the operator now holds is on disk.
    const saved = await readFile(envFileIn(sandbox.configHome), 'utf8');
    assert.match(saved, /^IG_ACCESS_TOKEN=IGQ-absurd-expiry$/m);
  } finally {
    await sandbox.cleanup();
  }
});

test('refresh registers the token it just minted, before anything can persist or print it', async () => {
  // F-4 (docs/security.md §2, core/redact.ts): the exchange hands back a LIVE
  // long-lived credential, and it is a value the redactor cannot recognise on
  // sight — a rotated Page token is just a string, and the `EAA…`/`IG…` shape
  // patterns are a best-effort backstop, not the mechanism. Until that value is
  // registered, every string the process builds from the mint onwards carries it
  // in the clear: the persist that follows (whose fs failures quote what they
  // were rewriting), any log line this path grows later, an unhandled rejection
  // Node prints itself.
  //
  // The minted token is therefore deliberately shape-invisible: an exact
  // registration is the only thing in the redactor that can mask it. And the
  // probe reads the child's OWN registry — it imports the same compiled
  // `core/redact.js` the entry does — so what is pinned is the value that got
  // registered, not that some call was made.
  const sandbox = await makeSandbox();
  try {
    const routes = [
      { match: '/refresh_access_token', body: { access_token: PLAIN_REFRESHED_TOKEN } },
    ];
    const text = `minted ${PLAIN_REFRESHED_TOKEN} here`;
    const env = { IG_ACCESS_TOKEN: PLAIN_TOKEN, IG_AUTH_PATH: 'ig-login' };

    const probeFile = path.join(sandbox.cwd, 'probe-ok.txt');
    const run = runEntry(sandbox, ['refresh'], {
      env,
      routes,
      imports: [redactionProbe(text, probeFile)],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.equal(
      await readFile(probeFile, 'utf8'),
      'minted [REDACTED] here',
      'the rotated token must be masked by the redactor the server itself uses',
    );

    // The same rotation with the persist made to FAIL: the config home is a
    // regular FILE, so `mkdir` beneath it is ENOTDIR and the run dies through the
    // top-level handler. This is what pins the ORDER. Registering after a
    // successful write looks identical above, and leaves the one outcome that
    // ends in a thrown, printed error — a rotation the operator has to
    // investigate, with the fresh token already minted upstream — as exactly the
    // outcome where that token is still in the clear.
    const blocked = path.join(sandbox.cwd, 'config-home-is-a-file');
    await writeFile(blocked, 'not a directory\n');
    const failProbe = path.join(sandbox.cwd, 'probe-failed-write.txt');
    const failed = runEntry(sandbox, ['refresh'], {
      env: { ...configHomeEnv(blocked), ...env },
      routes,
      imports: [redactionProbe(text, failProbe)],
    });

    assert.equal(failed.status, 1, `the persist had to fail here: ${failed.stderr}`);
    assert.match(failed.stderr, /failed to start: .*(not a directory|ENOTDIR)/i);
    assert.equal(
      await readFile(failProbe, 'utf8'),
      'minted [REDACTED] here',
      'a rotation that fails to persist must still have registered the minted token',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('the startup-failure line is redacted: a token echoed by an error never reaches stderr', async () => {
  // `main().catch` is the last stop before stderr, reached both before and after
  // secrets exist. The first half is a guard: a failed `refresh` exchange whose
  // `error.message` echoes a registered token shaped like nothing in particular
  // must still print it masked (the registry, not the shape scrub, is what can
  // mask PLAIN_TOKEN). The second half is the regression: a failure that happens
  // before any registration — a token mis-filed under `IG_AUTH_MODE`, which the
  // config parser's refusal echoed as typed — went to stderr verbatim until the
  // catch ran its message through the redactor's shape backstop. The parser no
  // longer echoes a value that long at all (a 32-hex app secret matches no
  // shape), so what is pinned here is that the value stays off stderr.
  const sandbox = await makeSandbox();
  try {
    const echoed = runEntry(sandbox, ['refresh'], {
      env: { IG_ACCESS_TOKEN: PLAIN_TOKEN, IG_AUTH_PATH: 'ig-login' },
      routes: [
        {
          match: '/refresh_access_token',
          status: 400,
          body: { error: { message: `Cannot refresh ${PLAIN_TOKEN}`, code: 190 } },
        },
      ],
    });
    assert.equal(echoed.status, 1, `stderr: ${echoed.stderr}`);
    assert.match(echoed.stderr, /failed to start: .*Cannot refresh \[REDACTED\]/);
    assert.equal(echoed.stderr.includes(PLAIN_TOKEN), false, 'the registered token leaked');

    const misfiled = runEntry(sandbox, [], { env: { IG_ACCESS_TOKEN: 'x', IG_AUTH_MODE: TOKEN } });
    assert.equal(misfiled.status, 1);
    assert.match(
      misfiled.stderr,
      /failed to start: IG_AUTH_MODE .*unknown value of \d+ characters \(not echoed/,
    );
    assert.equal(misfiled.stderr.includes(TOKEN), false, 'the mis-filed token leaked');

    // A 32-hex app secret is the value the shape backstop cannot see.
    const hexSecret = 'abcdef0123456789abcdef0123456789';
    const misfiledSecret = runEntry(sandbox, [], {
      env: { IG_ACCESS_TOKEN: 'x', IG_AUTH_MODE: hexSecret },
    });
    assert.equal(misfiledSecret.status, 1);
    assert.match(misfiledSecret.stderr, /failed to start: IG_AUTH_MODE .*unknown value of 32/);
    assert.equal(misfiledSecret.stderr.includes(hexSecret), false, 'the mis-filed secret leaked');
  } finally {
    await sandbox.cleanup();
  }
});

test('refresh on fb-login exchanges through the app credentials and keeps the profile whole', async () => {
  // The two auth paths refresh through completely different endpoints, with
  // different parameters, and only this one needs the app credentials at all —
  // so every ig-login test above passes just as happily when the app id and app
  // secret are dropped from the exchange, or when the path is hardcoded.
  //
  // The second half is about what SURVIVES the rotation. `writeCredentials`
  // rewrites the profile's whole key set, so a credential left out of the call is
  // not merely unrefreshed — the rewritten file describes a profile that no
  // longer has it. On fb-login that is the difference between a config the next
  // start can use and one that fails on `appsecret_proof` with a token that is
  // perfectly valid.
  const sandbox = await makeSandbox();
  try {
    const refreshed = 'EAA-refreshed-long-lived-token';
    const run = runEntry(sandbox, ['refresh'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_AUTH_PATH: 'fb-login',
        IG_APP_ID: '1234567890',
        IG_APP_SECRET: APP_SECRET,
        IG_ACCOUNT_ID: '17841400000000000',
      },
      routes: [
        {
          match: '/oauth/access_token',
          body: { access_token: refreshed, token_type: 'bearer', expires_in: 5_184_000 },
        },
      ],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.match(run.stderr, /^Refreshed fb-login token for profile 'default' -> /);

    const requests = await recordedRequests(sandbox);
    assert.equal(requests.length, 1, requests.join(' | '));
    const url = requests[0] ?? '';
    assert.match(url, /^GET https:\/\/graph\.facebook\.com\//);
    assert.match(url, /grant_type=fb_exchange_token/);
    assert.ok(url.includes('client_id=1234567890'), url);
    assert.ok(url.includes(`client_secret=${APP_SECRET}`), 'the app secret proves the app itself');
    assert.ok(url.includes(`fb_exchange_token=${TOKEN}`), 'the OLD token is what is exchanged');

    const saved = await readFile(envFileIn(sandbox.configHome), 'utf8');
    assert.match(saved, new RegExp(`^IG_ACCESS_TOKEN=${refreshed}$`, 'm'));
    assert.match(saved, /^IG_AUTH_PATH=fb-login$/m);
    assert.match(saved, /^IG_ACCOUNT_ID=17841400000000000$/m);
    assert.match(saved, /^IG_APP_ID=1234567890$/m);
    assert.match(saved, new RegExp(`^IG_APP_SECRET=${APP_SECRET}$`, 'm'));
  } finally {
    await sandbox.cleanup();
  }
});

test('refresh rotates the ACTIVE profile and writes back under that profile own keys', async () => {
  // Everything about a named profile is carried by the NAME: which token is sent
  // to the exchange, and which `IG_PROFILE_<NAME>_*` keys the result is written
  // under. Rotate the right account but persist under `default` and the damage is
  // silent and doubled — the brand profile keeps the token that was just
  // invalidated upstream, while the default profile is handed a credential for an
  // account it does not own, which every later `IG_ACCESS_TOKEN` read then trusts.
  const sandbox = await makeSandbox();
  try {
    const refreshed = 'IGQ-refreshed-brand-token-value';
    const run = runEntry(sandbox, ['refresh'], {
      env: {
        IG_ACCESS_TOKEN: TOKEN,
        IG_AUTH_PATH: 'ig-login',
        IG_PROFILE_BRAND_ACCESS_TOKEN: PLAIN_ALT_TOKEN,
        IG_PROFILE_BRAND_AUTH_PATH: 'ig-login',
        IG_ACTIVE_PROFILE: 'brand',
      },
      routes: [{ match: '/refresh_access_token', body: { access_token: refreshed } }],
    });

    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.match(run.stderr, /^Refreshed ig-login token for profile 'brand' -> /);

    const requests = await recordedRequests(sandbox);
    assert.equal(requests.length, 1, requests.join(' | '));
    assert.ok(
      (requests[0] ?? '').includes(PLAIN_ALT_TOKEN),
      `the ACTIVE profile's token is the one exchanged: ${requests[0] ?? ''}`,
    );

    const saved = await readFile(envFileIn(sandbox.configHome), 'utf8');
    assert.match(saved, new RegExp(`^IG_PROFILE_BRAND_ACCESS_TOKEN=${refreshed}$`, 'm'));
    assert.doesNotMatch(
      saved,
      /^IG_ACCESS_TOKEN=/m,
      "the default profile must not be handed another account's token",
    );
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

    // The registration record WHOLE, not fragments of it. This line is written
    // before a single request arrives and is the first thing an operator reads
    // to confirm the server came up the way it was configured. It used to be
    // held by `/tools registered/` and `/"transport":"stdio"/`, which between
    // them said only that some line somewhere contained some text: neither could
    // see a field ADDED to the record, and `count` was read out of the line with
    // a regex rather than compared as part of it. `time` is the one volatile
    // slot, so it is checked for shape and then dropped.
    const registrations = stderr
      .split('\n')
      .filter((line) => line.includes('"msg":"tools registered"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(registrations.length, 1, `stderr: ${stderr}`);
    const record = registrations[0] as Record<string, unknown>;
    assert.equal(typeof record.time, 'number', `no usable timestamp: ${JSON.stringify(record)}`);
    delete record.time;
    assert.deepEqual(record, {
      level: 'info',
      msg: 'tools registered',
      count: names.length,
      transport: 'stdio',
    });
  } finally {
    await running.stop();
    await sandbox.cleanup();
  }
});

test('stdin EOF at a pending write confirmation exits at once and performs nothing (CC-PROC-206)', async () => {
  // The client leaves while a write waits at the confirmation prompt. Before the
  // fix the SDK transport ignored stdin EOF, the prompt stayed pending on its
  // 120 s timer, and the process sat there for two minutes. Now EOF closes the
  // transport, the prompt resolves as a refusal, and the process exits. The
  // route below would answer the write if it were ever sent: the empty request
  // log proves it was not, and the absent journal proves nothing claimed it was.
  const sandbox = await makeSandbox();
  const running = startEntry(sandbox, [], {
    env: {
      IG_ACCESS_TOKEN: TOKEN,
      IG_TOOL_PACKAGES: 'all',
      IG_WRITE_MODE: 'apply',
      IG_LOG_LEVEL: 'info',
    },
    routes: [{ match: '/', body: { success: true } }],
  });
  try {
    let stdout = '';
    running.child.stdout.setEncoding('utf8');
    running.child.stdout.on('data', (chunk: string) => (stdout += chunk));
    const exited = new Promise<number | null>((resolve) =>
      running.child.once('exit', (code) => resolve(code)),
    );
    const send = (msg: unknown): void => void running.child.stdin.write(`${JSON.stringify(msg)}\n`);

    await running.waitForStderr(/mcp server ready/);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: { elicitation: {} },
        clientInfo: { name: 'entry-test', version: '0.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'instagram_hide_comment',
        arguments: { commentId: '17890000000000001', apply: true },
      },
    });
    const deadline = Date.now() + 15_000;
    while (!stdout.includes('"method":"elicitation/create"')) {
      if (Date.now() > deadline) throw new Error(`no confirmation prompt: ${stdout}`);
      await delay(25);
    }

    running.child.stdin.end();
    // Far inside the 120 s prompt budget: an exit here can only be the close.
    const backstop = new AbortController();
    const code = await Promise.race([
      exited,
      delay(10_000, 'still running' as const, { signal: backstop.signal }),
    ]).finally(() => backstop.abort());
    assert.equal(code, 0, `stderr: ${running.stderr()}`);

    assert.deepEqual(await recordedRequests(sandbox), [], 'the write must not reach the Graph');
    await assert.rejects(readFile(sandbox.writeJournal, 'utf8'), { code: 'ENOENT' });
    const msgs = logRecords(running.stderr()).map((r) => r.msg);
    assert.ok(
      msgs.includes('mcp client closed stdin; finishing in-flight calls, then exiting'),
      msgs.join(' | '),
    );
    assert.ok(
      msgs.includes('write refused — human confirmation could not be obtained'),
      msgs.join(' | '),
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
  // `IGQ…` fixture token proves nothing here: the `IG` shape backstop masks that
  // one whether or not it was ever registered, which is why the startup-log
  // assertion in the sibling test above stayed green with the registry empty.
  //
  // So the drive is: hand each secret back to the server as ordinary tool INPUT
  // (`instagram_get_media`'s `mediaId` is free-form and its `logFields` echoes it
  // verbatim), and require the emitted line to read `[REDACTED]`. That is the
  // real leak path — a value that is a secret elsewhere in the configuration must
  // never surface in the operator's log just because it arrived as an argument.
  //
  // Two of the four secrets are here to pin the parts of that registration a
  // single-profile, already-trimmed configuration cannot see:
  //   - a SECOND profile, whose token only the loop over `profiles` reaches. A
  //     multi-account operator's second account is a real credential, and nothing
  //     about the first one's masking says whether the second was registered.
  //   - a PADDED `IG_HTTP_TOKEN`. The transport trims before comparing, so the
  //     trimmed value is the bearer clients actually send; register the untrimmed
  //     spelling and the string that matters is the one still in the clear.
  const sandbox = await makeSandbox();
  const running = startEntry(sandbox, [], {
    env: {
      IG_ACCESS_TOKEN: PLAIN_TOKEN,
      IG_AUTH_PATH: 'fb-login',
      IG_APP_ID: '1234567890',
      IG_APP_SECRET: PLAIN_APP_SECRET,
      IG_PROFILE_ALT_ACCESS_TOKEN: PLAIN_ALT_TOKEN,
      IG_PROFILE_ALT_AUTH_PATH: 'ig-login',
      IG_HTTP_TOKEN: `  ${PLAIN_BEARER}  `,
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

    // One call per secret: both profiles' tokens, the app secret, and the HTTP
    // bearer as the transport resolves it (trimmed), not as it was spelled.
    const secrets = [PLAIN_TOKEN, PLAIN_APP_SECRET, PLAIN_ALT_TOKEN, PLAIN_BEARER];
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

test('a dotenv knob in the environment cannot talk its way onto stdout', async () => {
  // The sibling test above proves `quiet: true` is PASSED. It cannot prove the
  // option is OBEYED, and under dotenv 17 it frequently is not: both switches
  // resolve as `parseBoolean(processEnv.DOTENV_CONFIG_* || (options && options.*))`,
  // so the environment wins the moment it carries either one. `DOTENV_CONFIG_QUIET`
  // set to any of `false`/`0`/`no`/`off`/`` brings the banner back, and
  // `DOTENV_CONFIG_DEBUG` adds a trace per candidate that names the config-home
  // path — both on the single stream the stdio transport frames, and both while
  // `loadEnvFiles` is still passing `quiet: true` and looking correct.
  //
  // Nothing here is the operator's fault: these are dotenv's own documented
  // switches, they are exported for a whole shell rather than one command, and
  // `baseEnv` hands the ambient environment to the child untouched. A developer
  // with `DOTENV_CONFIG_DEBUG=1` exported would have watched the test above go
  // red with no hint that the cause was their shell.
  const sandbox = await makeSandbox();
  try {
    const { writeCredentials } = await import('../src/core/config-write.js');
    await writeCredentials(
      'default',
      { accessToken: TOKEN, authPath: 'ig-login', accountId: '17841400000000000' },
      { configDir: sandbox.configHome },
    );

    const running = startEntry(sandbox, [], {
      env: { IG_LOG_LEVEL: 'info', DOTENV_CONFIG_DEBUG: '1', DOTENV_CONFIG_QUIET: 'false' },
    });
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

      for (const line of stdout.split('\n')) {
        if (line.trim() === '') continue;
        assert.doesNotThrow(
          () => JSON.parse(line),
          `non-JSON-RPC line on stdout: ${JSON.stringify(line)} \u2014 a dotenv switch in the ` +
            'environment beat the `quiet: true` passed in code, which is what withdrawing ' +
            '`DOTENV_CONFIG_QUIET`/`DOTENV_CONFIG_DEBUG` around the load is there to stop.',
        );
      }
      assert.match(running.stderr(), /tools registered/);
      assert.ok(
        !stdout.includes(sandbox.configHome),
        'the debug trace names the file it loaded, so a leaked path is the shape this takes',
      );
      assert.ok(!stdout.includes(TOKEN), 'no credential may reach stdout');
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
    // BOTH startup lines must name the transport that actually started. The
    // registration line is the earlier one and the one an operator greps to
    // confirm the server came up the way it was configured; a hard-coded label
    // there would contradict the ready line on every HTTP start, and the two
    // disagreeing is worse than either being wrong alone.
    assert.match(running.stderr(), /"msg":"tools registered"[^\n]*"transport":"http"/);
    assert.match(running.stderr(), /"msg":"mcp server ready"[^\n]*"transport":"http"/);
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

test('SIGTERM stops an HTTP server through its graceful close and exits 0', async () => {
  // CC-PROC-204. `startHttp` returns a teardown that closes in-flight
  // exchanges and every socket before the listener stops; the entry used to
  // discard it, so a real stop died at the signal and that teardown ran only in
  // tests. The preload's own SIGTERM fallback stands aside for an entry that has
  // a handler, so the exit measured here is the entry's — and the log lines
  // below are the proof that the close ran rather than the process merely ending.
  const sandbox = await makeSandbox();
  const port = await freePort();
  const running = startEntry(sandbox, [], {
    env: {
      IG_ACCESS_TOKEN: TOKEN,
      IG_TRANSPORT: 'http',
      IG_HTTP_HOST: '127.0.0.1',
      IG_PORT: String(port),
      IG_HTTP_TOKEN: 'entry-test-bearer-token',
      IG_LOG_LEVEL: 'info',
    },
  });
  let stdout = '';
  running.child.stdout.setEncoding('utf8');
  running.child.stdout.on('data', (chunk: string) => (stdout += chunk));
  try {
    await running.waitForStderr(/mcp server ready/);
    // A client holding a keep-alive socket open: the close must still finish,
    // because `closeAllConnections()` is part of the teardown being reached.
    const idle: Socket = await new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => resolve(socket));
      socket.once('error', reject);
    });
    const socketClosed = new Promise<void>((resolve) => idle.once('close', () => resolve()));
    idle.on('error', () => undefined);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      running.child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    running.child.kill('SIGTERM');
    const result = await exited;
    await socketClosed;

    assert.deepEqual(result, { code: 0, signal: null }, running.stderr());
    assert.equal(stdout, '', 'shutdown writes nothing to stdout');
    assert.match(
      running.stderr(),
      /"msg":"shutdown signal received; closing the http transport"[^\n]*"signal":"SIGTERM"/,
    );
    assert.match(running.stderr(), /"msg":"http transport closed; exiting"/);
  } finally {
    await running.stop();
    await sandbox.cleanup();
  }
});
