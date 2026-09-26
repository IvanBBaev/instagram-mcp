/**
 * Distribution / packaging gate (G5). Verifies the published-but-not-compiled
 * artifacts — the CommonJS bin launcher, the MCP-registry server.json, and the
 * Claude Code plugin manifest — stay consistent with the package identity, and
 * that the launcher hands off to the built ESM entry without tripping its own
 * Node guard on a supported runtime.
 *
 * Runs from the repo root (cwd), so the artifacts are read by their repo paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const repoRoot = process.cwd();
const binPath = path.join(repoRoot, 'bin', 'instagram-mcp-ai.cjs');
const serverJsonPath = path.join(repoRoot, 'server.json');
const packageJsonPath = path.join(repoRoot, 'package.json');
const pluginJsonPath = path.join(
  repoRoot,
  'plugins',
  'instagram-mcp-ai',
  '.claude-plugin',
  'plugin.json',
);

/**
 * The built ESM entry the launcher exists to reach.
 *
 * The suite itself runs out of the build directory, so this file is always
 * present when these gates run. It is asserted anyway: the hand-off gate below
 * compares two processes, and two processes that both failed to start would
 * agree about everything.
 */
const entryPath = path.join(repoRoot, 'dist', 'src', 'index.js');

/** Run `node` with the given argv from the repo root, with no IG_* in the env. */
function runNode(args: string[], extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith('IG_') && !(key in extraEnv)) delete env[key];
  }
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('bin launcher exists and starts with the Node shebang', () => {
  assert.ok(existsSync(binPath), 'bin/instagram-mcp-ai.cjs must exist');
  const source = readFileSync(binPath, 'utf8');
  const firstLine = source.split('\n')[0];
  assert.equal(firstLine, '#!/usr/bin/env node');
});

test('bin launcher resolves the built ESM entry from its own directory', () => {
  const source = readFileSync(binPath, 'utf8');
  // The whole join, anchor included. What stood here until 2026-09-23 was
  // `source.includes('dist/src/index.js')`, and the launcher builds that path
  // out of four separate literals — so the string being matched occurs in the
  // file only inside the two comments that describe the line. Replacing the
  // entire resolution with a hard-coded `file:///nowhere.js` passed; rephrasing
  // a comment failed. It asserted the prose rather than the code.
  //
  // This is also the half of the pin that still works in a tree with no build
  // output, where the behavioural gate further down cannot run at all.
  assert.match(
    source,
    /\.join\(\s*__dirname,\s*'\.\.',\s*'dist',\s*'src',\s*'index\.js',?\s*\)/,
    'bin/instagram-mcp-ai.cjs must resolve the entry by joining __dirname with "..", ' +
      '"dist", "src" and "index.js". The shim lives in bin/, so the hop out of it is ' +
      'load-bearing, and it is the one segment of that path no other gate watches',
  );
  assert.ok(source.includes('process.versions.node'), 'must read the running Node version');
  assert.ok(source.includes('import('), 'must dynamically import the ESM entry');
});

test('server.json is valid JSON with the registry name and package version', () => {
  const manifest = JSON.parse(readFileSync(serverJsonPath, 'utf8')) as {
    name: string;
    version: string;
  };
  assert.equal(manifest.name, 'io.github.IvanBBaev/instagram-mcp-ai');

  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
  assert.equal(manifest.version, pkg.version);
});

test('Claude Code plugin manifest lives at plugins/instagram-mcp-ai/.claude-plugin/plugin.json and is well formed', () => {
  assert.ok(
    existsSync(pluginJsonPath),
    'plugins/instagram-mcp-ai/.claude-plugin/plugin.json must exist',
  );
  const plugin = JSON.parse(readFileSync(pluginJsonPath, 'utf8')) as Record<string, unknown>;

  // `name` is the only field Claude Code requires, and it must be kebab-case.
  assert.equal(typeof plugin.name, 'string', 'plugin.json.name must be a string');
  assert.match(
    plugin.name as string,
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'plugin.json.name must be kebab-case (lowercase alphanumerics separated by single hyphens)',
  );

  // Component paths are relative to the plugin root; this plugin ships no
  // commands/agents/skills, so declaring any of them would point at nothing.
  for (const key of ['commands', 'agents', 'skills', 'hooks']) {
    assert.ok(!(key in plugin), `plugin.json must not declare "${key}" — the plugin ships none`);
  }
});

test('plugin manifest launches the server from npm, not from an unbuilt repo path', () => {
  const plugin = JSON.parse(readFileSync(pluginJsonPath, 'utf8')) as {
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
  };
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name: string;
    version: string;
  };
  const servers = plugin.mcpServers ?? {};
  const names = Object.keys(servers);
  assert.ok(names.length > 0, 'plugin.json must declare at least one MCP server');

  for (const name of names) {
    const server = servers[name];
    const args = server?.args ?? [];
    // A Claude Code plugin is installed from git, where `dist/` does not exist
    // (it is gitignored). Referencing a built path would produce a plugin that
    // installs cleanly and then fails to start.
    for (const arg of args) {
      assert.ok(
        !arg.includes('dist/'),
        `plugin.json server "${name}" must not reference a built dist/ path — ` +
          `plugins are installed from git, which carries no dist/`,
      );
    }
    // The whole argv, in order — this is a command line that runs on the
    // operator's machine. "One of the args names the package" stays true when an
    // arg is ADDED (`--registry=https://…` sends npx to a registry nobody
    // audited, `--` swallows what follows) and when the order is changed (the
    // spec before `-y`, which makes npx prompt for consent and then hang under a
    // plugin host that has no terminal to answer from).
    assert.deepEqual(
      args,
      ['-y', `${pkg.name}@${pkg.version}`],
      `plugin.json server "${name}" must launch exactly: npx -y ${pkg.name}@${pkg.version}`,
    );
  }
});

test('the plugin manifest is deliberately excluded from the npm tarball', () => {
  // `files` is an allowlist, so .claude-plugin/ and plugins/ are already out — this asserts the
  // exclusion is intentional and stays that way. The Claude Code plugin channel
  // installs from the git repo / a marketplace, never from node_modules, so a
  // copy inside the tarball would be dead weight that can silently go stale.
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { files?: string[] };
  assert.ok(Array.isArray(pkg.files), 'package.json must keep an explicit `files` allowlist');
  for (const entry of pkg.files) {
    assert.ok(
      !entry.includes('.claude-plugin') && !entry.startsWith('plugins'),
      `package.json "files" must not ship .claude-plugin/ or plugins/ (found "${entry}")`,
    );
  }
});

test('the launcher hands control to the built entry, whose answer it passes through', () => {
  // `--help` is the one line the entry answers before it reads an env file, a
  // profile, the clock or the network: `assertUsage` runs immediately after the
  // Node guard and exits 0 with the usage on stderr. That lets the two channels
  // be compared on output the ENTRY authors and the shim has no way to produce,
  // without going anywhere near the operator's config home.
  //
  // Measured 2026-09-23. Until this gate existed, bending the shim's
  // `path.join(__dirname, '..', ...)` to `'.'` left the suite at 1954 pass and 0
  // fail while the installed binary died with ERR_MODULE_NOT_FOUND on every
  // channel — npm's `bin`, the `npx` line the plugin and the bundle both launch
  // through, and a direct clone. The reason was uniform: every status assertion
  // across this file and `launcher.test.ts` reads `=== 1` or `!== 0`, and the
  // one that claimed to prove a hand-off was `assert.notEqual(status, 0)`, which
  // a shim that never reaches the entry satisfies perfectly. The neighbouring
  // path mutants were caught all along — `'dist'`, `'src'` and `'index.js'` are
  // all watched by the bend-preload in `launcher.test.ts`, which matches on the
  // path's suffix. Only the anchor that suffix hangs off went unwatched.
  assert.ok(existsSync(entryPath), 'dist/src/index.js must be built before this gate runs');

  const direct = runNode([entryPath, '--help']);
  assert.equal(direct.error, undefined, 'the built entry should spawn without error');
  assert.equal(direct.status, 0, 'the built entry must answer `--help` with exit 0');
  assert.ok(
    direct.stderr.startsWith('Usage:'),
    'the built entry must answer `--help` with its usage on stderr. This gate holds the ' +
      'launcher to that answer, so an entry that stopped giving one would leave two empty ' +
      'streams agreeing about nothing',
  );

  const viaLauncher = runNode([binPath, '--help']);
  assert.equal(viaLauncher.error, undefined, 'launcher should spawn without error');
  assert.equal(
    viaLauncher.signal,
    null,
    'launcher should exit on its own, not be killed by the timeout',
  );
  // Every exit the shim makes on its own account is 1 — the Node-floor refusal
  // and the failed-import handler, and it has no third — so an exit code the
  // entry chose is itself proof the entry ran. Whole-stream equality on top of
  // that is what makes this a hand-off gate rather than a second usage gate:
  // whatever the entry says, the launcher must say exactly that and add nothing.
  // It subsumes the Node-guard check this replaces, too: a tripped guard writes
  // its refusal here instead of the usage.
  assert.equal(
    viaLauncher.status,
    direct.status,
    'the launcher must exit with the code the built entry chose; every exit the shim makes ' +
      'on its own is 1, so a mismatch means control never arrived',
  );
  assert.equal(viaLauncher.stdout, direct.stdout, 'the launcher must add nothing to stdout');
  assert.equal(
    viaLauncher.stderr,
    direct.stderr,
    'the launcher must pass stderr through untouched — a banner of its own, or a failure ' +
      'report standing in for the answer the entry gave, both surface here',
  );
});

test('the handed-off entry runs far enough to refuse a start it cannot make', () => {
  // The other half of the hand-off, and the reason this spawn survives the gate
  // above: `--help` returns before `loadEnvFiles`, so on its own it proves the
  // entry was ENTERED and nothing about the startup path behind it. Here the
  // env-file override points at a path that does not exist, so the entry loads,
  // refuses the unreadable env file and fails fast — in a child process, which
  // is what records coverage for the one branch of `loadEnvFiles` that an
  // in-process test cannot reach (CC-PROC-18).
  //
  // On its own this assertion is satisfied by a launcher that never reaches the
  // entry at all. That is not a flaw here; it is why the gate above exists.
  const result = runNode([binPath], {
    IG_ENV_FILE: path.join(os.tmpdir(), 'instagram-mcp-nonexistent.env'),
  });

  assert.equal(result.error, undefined, 'launcher should spawn without error');
  assert.equal(
    result.signal,
    null,
    'launcher should exit on its own, not be killed by the timeout',
  );
  assert.equal(typeof result.status, 'number', 'launcher should exit with a numeric code');
  assert.notEqual(result.status, 0, 'missing config should make the server fail to start');
});
