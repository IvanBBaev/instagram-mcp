/**
 * Release gate: the CommonJS launcher (`bin/instagram-mcp-ai.cjs`).
 *
 * This shim is the first code that runs for every install channel — npm's
 * `bin`, the `npx` invocation the Claude Code plugin and the MCPB bundle both
 * launch through, and any direct clone. It has exactly two jobs, and until this
 * file existed only the happy path of the second one was tested
 * (`packaging.test.ts` proves a supported runtime hands off). Both *failure*
 * paths were unexercised, which is backwards: a launcher's failure behaviour is
 * the only thing a user ever sees when something is wrong.
 *
 * Covered here:
 *   1. The Node-floor guard actually refuses an under-floor runtime, and says so
 *      on **stderr** with the real floor in the text.
 *   2. The floor is the same number in all three places that declare it.
 *   3. A missing ESM entry is caught and reported rather than surfacing as an
 *      unhandled rejection — twice, from both sides of the same break: a
 *      relocated tree with no `dist/` (what a bad `files` allowlist ships) and
 *      the launcher in place with the entry path bent out from under it.
 *
 * Every case drives the **real** `bin/instagram-mcp-ai.cjs`, never a copy with
 * edits. The under-floor case stubs `process.versions.node` through a
 * `--require` preload; the relocation case copies the untouched file into a tree
 * where `../dist/src/index.js` does not resolve; the in-place case preloads a
 * `path.join` shim that redirects only the launcher's own entry path.
 *
 * The two missing-entry cases are not redundant. The relocated one reproduces
 * the real-world packaging break end to end but executes from a temp path, so
 * c8 attributes its lines there and `bin/` would still report the catch handler
 * as uncovered; the in-place one runs the shipped file at its shipped path, so
 * the coverage lands where the code lives. Renaming `dist/src/index.js` mid-run
 * — the obvious third option — would race every other test in the suite, all of
 * which import from `dist/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Locate the repo root: the nearest ancestor directory holding a `package.json`. */
function findRepoRoot(): string {
  const candidates: string[] = [process.cwd()];
  let dir = dirname(fileURLToPath(import.meta.url));
  let parent = dirname(dir);
  while (dir !== parent) {
    candidates.push(dir);
    dir = parent;
    parent = dirname(dir);
  }
  candidates.push(dir);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  throw new Error('could not locate repo root');
}

const repoRoot = findRepoRoot();
const launcherPath = join(repoRoot, 'bin', 'instagram-mcp-ai.cjs');

/** Read + parse a JSON file from the repo root. */
function readRepoJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, file), 'utf8')) as Record<string, unknown>;
}

/**
 * Pull the major version out of a range like `>=22`, `>=22.0.0` or `22.x`.
 *
 * Deliberately loose about the range *syntax* and strict about the *number*:
 * the point is to compare floors across files that legitimately spell the same
 * constraint differently, not to validate semver ranges.
 */
function floorMajor(range: string): number {
  // Anchored, and narrow on purpose. The first version of this read `/(\d+)/` —
  // the first digit run ANYWHERE in the string — which answers for shapes it
  // cannot actually mean: `18.x || >=20` reads as a floor of 18, and `>=22.12`
  // reads as 22, silently rounding the floor DOWN to a version the range
  // excludes. The shim compares majors and nothing finer, so rounding down is
  // not a display detail: it is the shim admitting a runtime `engines.node`
  // rejects. Refusing the shape is the only honest answer, and it is the
  // standard `parseNodeFloor` in `mcpb-manifest.test.ts` already holds this
  // repo's other Node-floor channel to.
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  assert.ok(
    match,
    `could not read a major version out of ${JSON.stringify(range)}: this gate compares a ` +
      'plain ">=X[.Y[.Z]]" floor, so widen the parser deliberately rather than letting a ' +
      'richer range be read by its first digits',
  );
  assert.ok(
    Number(match[2] ?? 0) === 0 && Number(match[3] ?? 0) === 0,
    `${JSON.stringify(range)} sets a floor below the major granularity the launcher shim can ` +
      'enforce, so the shim would admit a runtime this range excludes. Teach the shim to ' +
      'compare minors before tightening the range here',
  );
  return Number(match[1]);
}

/** The floor the shim itself enforces, read from its source. */
function launcherFloor(): number {
  const source = readFileSync(launcherPath, 'utf8');
  const match = /MIN_NODE_MAJOR\s*=\s*(\d+)/.exec(source);
  assert.ok(match, 'bin/instagram-mcp-ai.cjs must declare a numeric MIN_NODE_MAJOR');
  return Number(match[1]);
}

/** Run a command, capturing output, with a clean env free of IG_* credentials. */
function runNode(args: string[], cwd: string): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('IG_')) delete env[key];
  }
  return spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 20000 });
}

/** The one thing the launcher itself contributes to a failed hand-off. */
const LOAD_FAILURE_PREFIX = 'instagram-mcp-ai failed to load: ';

/**
 * Assert that `stderr` is the launcher's failure report and nothing else.
 *
 * The middle of this stream is V8's stack, which the shim does not author and a
 * test cannot spell out — but both ends are the shim's own. A containment match
 * on the prefix proved only that the attribution appears *somewhere*: a banner
 * printed before it, or advice appended under the stack, left the match green.
 * Pinning both boundaries states the real contract — the attribution comes
 * first, with nothing in front of it, and the stack is the last thing written.
 */
function assertIsLauncherFailureReport(stderr: string): void {
  assert.ok(
    stderr.startsWith(LOAD_FAILURE_PREFIX),
    `the report must open with "${LOAD_FAILURE_PREFIX}" and nothing before it, so the failure ` +
      `is attributable to this package; got ${JSON.stringify(stderr.slice(0, 80))}`,
  );
  const lines = stderr.replace(/\n$/, '').split('\n');
  assert.match(
    lines.at(-1) ?? '',
    /^ {4}at /,
    'the report must end with the last frame of the stack — nothing may be appended after it',
  );
}

test('the Node floor is the same number everywhere it is declared', () => {
  const pkg = readRepoJson('package.json');
  const engines = pkg.engines as Record<string, string> | undefined;
  assert.ok(engines?.node, 'package.json must declare engines.node');

  const manifest = readRepoJson('manifest.json');
  const compatibility = manifest.compatibility as Record<string, unknown> | undefined;
  const runtimes = compatibility?.runtimes as Record<string, string> | undefined;
  assert.ok(runtimes?.node, 'manifest.json must declare compatibility.runtimes.node');

  const fromEngines = floorMajor(engines.node);
  const fromManifest = floorMajor(runtimes.node);
  const fromLauncher = launcherFloor();

  // Drift here is not cosmetic and it fails in both directions. Raise `engines`
  // without raising the shim and the shim waves through a runtime the ESM graph
  // may not parse; raise the shim without raising `engines` and npm installs
  // cleanly, then the binary refuses to start.
  assert.equal(
    fromLauncher,
    fromEngines,
    `bin/instagram-mcp-ai.cjs enforces Node >= ${fromLauncher} but package.json ` +
      `engines.node is ${JSON.stringify(engines.node)}; the shim runs before npm's ` +
      `own engines check can help, so it must not be the looser of the two`,
  );
  assert.equal(
    fromManifest,
    fromEngines,
    `manifest.json compatibility.runtimes.node is ${JSON.stringify(runtimes.node)} but ` +
      `package.json engines.node is ${JSON.stringify(engines.node)}; Claude Desktop ` +
      `screens the bundle on the manifest value alone`,
  );
});

test('the launcher refuses an under-floor runtime on stderr and exits non-zero', () => {
  const floor = launcherFloor();
  const under = `${String(floor - 1)}.19.0`;

  // `process.versions.node` is what the shim reads, so overriding it in a preload
  // reproduces an old runtime faithfully without needing one installed. The real
  // launcher file runs unmodified.
  const tempDir = mkdtempSync(join(tmpdir(), 'instagram-mcp-launcher-'));
  try {
    const preload = join(tempDir, 'stub-node-version.cjs');
    writeFileSync(
      preload,
      `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(under)}, configurable: true });\n`,
      'utf8',
    );

    const result = runNode(['--require', preload, launcherPath], repoRoot);

    assert.equal(result.error, undefined, 'launcher should spawn without error');
    assert.equal(result.status, 1, 'an under-floor runtime must exit 1, not hand off');
    // stdout carries JSON-RPC on the stdio transport; a diagnostic there would be
    // a framing error, so the refusal has to go to stderr and stdout must stay clean.
    assert.equal(result.stdout, '', 'the guard must not write to stdout');
    // Whole-stream equality, not a phrase match. Every byte here is the shim's
    // own, and matching "requires Node.js >= 22" somewhere in it proved only
    // that the floor was named: the remediation line underneath could send the
    // user to a runtime still under the floor (`nvm install 20`), or invite a
    // bypass switch that does not exist, and nothing in the suite moved. The
    // refusal must name the real floor, the runtime actually found, and a fix
    // that reaches that floor.
    assert.equal(
      result.stderr,
      `instagram-mcp-ai requires Node.js >= ${String(floor)}, but this runtime is ${under}.\n` +
        `Use a newer runtime, e.g.: nvm install ${String(floor)} && nvm use ${String(floor)}\n`,
      `the refusal must read exactly as the shim writes it, naming the real floor ` +
        `(${String(floor)}) and the runtime found (${under})`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a missing ESM entry is reported, not thrown as an unhandled rejection', () => {
  // The shim resolves `../dist/src/index.js` relative to its own directory, so
  // relocating it to a tree without a `dist/` reproduces exactly the real-world
  // break: a published tarball whose `files` allowlist dropped the build output.
  // That is one typo away — `packaging.test.ts` guards the allowlist precisely
  // because it can happen — and this asserts the failure stays legible when it does.
  const tempDir = mkdtempSync(join(tmpdir(), 'instagram-mcp-nodist-'));
  try {
    const binDir = join(tempDir, 'bin');
    mkdirSync(binDir);
    const relocated = join(binDir, 'instagram-mcp-ai.cjs');
    copyFileSync(launcherPath, relocated);
    assert.ok(
      !existsSync(join(tempDir, 'dist')),
      'the fixture tree must not contain a dist/ directory',
    );

    const result = runNode([relocated], tempDir);

    assert.equal(result.error, undefined, 'launcher should spawn without error');
    assert.equal(result.status, 1, 'a failed hand-off must exit 1');
    assert.equal(result.stdout, '', 'the failure report must not write to stdout');
    assertIsLauncherFailureReport(result.stderr);
    // Node prints "[ERR_UNHANDLED_REJECTION]" / "Uncaught" when a rejection escapes.
    // Seeing the package's own prefix above and no such marker proves the `.catch`
    // ran rather than the process dying on the raw rejection.
    assert.ok(
      !/unhandled rejection/i.test(result.stderr),
      'the import rejection must be caught, not left to crash the process',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * Write a `--require` preload that bends ONLY the launcher's own entry path.
 *
 * The launcher resolves its target with a single
 * `path.join(__dirname, '..', 'dist', 'src', 'index.js')`, so replacing that one
 * result is enough to steer the hand-off anywhere. Every other join in the child
 * — including the ones Node's own module machinery performs — passes through
 * untouched, which is what keeps this from being a blunt instrument.
 *
 * `redirect` receives the real joined path and returns the path to load instead.
 */
function writeEntryBendPreload(dir: string, name: string, redirect: string): string {
  const preload = join(dir, name);
  writeFileSync(
    preload,
    [
      "'use strict';",
      "const path = require('node:path');",
      'const realJoin = path.join.bind(path);',
      "const suffix = ['dist', 'src', 'index.js'].join(path.sep);",
      'path.join = function (...args) {',
      '  const joined = realJoin(...args);',
      `  return joined.endsWith(suffix) ? ${redirect} : joined;`,
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  return preload;
}

test('the shipped launcher reports a failed hand-off from its own installed path', () => {
  // Same failure as above, driven without moving the file: the preload points
  // the entry at a path that does not exist. The point is attribution — this
  // runs `bin/instagram-mcp-ai.cjs` where npm installs it, so the catch
  // handler's coverage is recorded against the file that actually ships rather
  // than against a temp copy.
  const tempDir = mkdtempSync(join(tmpdir(), 'instagram-mcp-badentry-'));
  try {
    const preload = writeEntryBendPreload(tempDir, 'bend-entry-path.cjs', "joined + '.missing'");

    const result = runNode(['--require', preload, launcherPath], repoRoot);

    assert.equal(result.error, undefined, 'launcher should spawn without error');
    assert.equal(result.status, 1, 'a failed hand-off must exit 1');
    assert.equal(result.stdout, '', 'the failure report must not write to stdout');
    assertIsLauncherFailureReport(result.stderr);
    // The handler prints `err.stack` when there is one. A bare message would
    // strip the module specifier and leave the operator with nothing to act on.
    assert.ok(
      (result.stderr.split('\n')[0] ?? '').includes('index.js.missing'),
      'the report must name the entry it could not load, on its first line — the match this ' +
        'replaces accepted that name anywhere in the stream, including in text appended ' +
        'after the stack',
    );
    assert.ok(
      !/unhandled rejection/i.test(result.stderr),
      'the import rejection must be caught, not left to crash the process',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('an entry that rejects with a non-Error is still reported, not swallowed', () => {
  // `err && err.stack ? err.stack : String(err)` — the second arm. A module that
  // throws a bare value at top level rejects the dynamic import with that value,
  // and it has no `.stack`. Reading `err.stack` unguarded would print
  // "undefined"; dropping the fallback would print nothing at all and leave a
  // silent exit 1, which is the worst possible failure for the first code that
  // runs on every install channel.
  const tempDir = mkdtempSync(join(tmpdir(), 'instagram-mcp-throwstring-'));
  try {
    const thrower = join(tempDir, 'throws-a-string.mjs');
    writeFileSync(thrower, "throw 'entry refused to load';\n", 'utf8');
    const preload = writeEntryBendPreload(
      tempDir,
      'bend-entry-to-thrower.cjs',
      JSON.stringify(thrower),
    );

    const result = runNode(['--require', preload, launcherPath], repoRoot);

    assert.equal(result.error, undefined, 'launcher should spawn without error');
    assert.equal(result.status, 1, 'a failed hand-off must exit 1');
    assert.equal(result.stdout, '', 'the failure report must not write to stdout');
    // Whole-stream equality: with no stack to print, every byte of this report is
    // the shim's own. The containment match it replaces could not see a line
    // appended under the message — nor one printed above it — and the
    // `doesNotMatch` beside it could not either, because it carried no right
    // boundary. The stack-less value must be stringified rather than read
    // through a missing `.stack`, and nothing may be written around it.
    assert.equal(
      result.stderr,
      `${LOAD_FAILURE_PREFIX}entry refused to load\n`,
      'a rejection with no .stack must be reported as exactly String(err), on its own line',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
