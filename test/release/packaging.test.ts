/**
 * Distribution / packaging gate (G5). Verifies the two published-but-not-compiled
 * artifacts — the CommonJS bin launcher and the MCP-registry server.json — stay
 * consistent with the package identity, and that the launcher hands off to the
 * built ESM entry without tripping its own Node guard on a supported runtime.
 *
 * Runs from the repo root (cwd), so the artifacts are read by their repo paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const repoRoot = process.cwd();
const binPath = path.join(repoRoot, 'bin', 'instagram-mcp-ai.cjs');
const serverJsonPath = path.join(repoRoot, 'server.json');
const packageJsonPath = path.join(repoRoot, 'package.json');

test('bin launcher exists and starts with the Node shebang', () => {
  assert.ok(existsSync(binPath), 'bin/instagram-mcp-ai.cjs must exist');
  const source = readFileSync(binPath, 'utf8');
  const firstLine = source.split('\n')[0];
  assert.equal(firstLine, '#!/usr/bin/env node');
});

test('bin launcher references the built ESM entry and guards the Node version', () => {
  const source = readFileSync(binPath, 'utf8');
  assert.ok(source.includes('dist/src/index.js'), 'must reference the built ESM entry');
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

test('launcher hands off to the ESM entry without tripping its Node guard', () => {
  // A clean env with no IG_* credentials and an env-file override that points at
  // a non-existent path: the ESM entry loads, finds no profile, and fails fast —
  // exercising the launcher's hand-off without needing real credentials.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('IG_')) delete env[key];
  }
  env.IG_ENV_FILE = path.join(os.tmpdir(), 'instagram-mcp-nonexistent.env');

  const result = spawnSync(process.execPath, [binPath], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 20000,
  });

  assert.equal(result.error, undefined, 'launcher should spawn without error');
  assert.equal(
    result.signal,
    null,
    'launcher should exit on its own, not be killed by the timeout',
  );
  assert.equal(typeof result.status, 'number', 'launcher should exit with a numeric code');
  // The test host runs Node >= 22, so the launcher's own guard must not fire.
  assert.ok(
    !/requires Node/i.test(result.stderr),
    'Node guard must not trip on a supported runtime',
  );
  // Missing config makes the handed-off ESM entry fail to start (non-zero),
  // proving the launcher forwarded control instead of crashing itself.
  assert.notEqual(result.status, 0, 'missing config should make the server fail to start');
});
