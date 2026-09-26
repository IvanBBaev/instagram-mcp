/**
 * Quality-gate composition (G5). The gate is a chain of npm scripts plus two CI
 * jobs, and every link in it is hand-written text that nothing else reads. This
 * file pins the decisions the gate's meaning rests on: that the suite is proved
 * non-empty before anyone believes it, that coverage is measured over the files
 * the repo means to enforce rather than only the ones a run happened to load,
 * and that CI runs the same floor `npm run check` runs locally.
 *
 * Why the floor itself lives outside the suite: a test asserting "the suite ran"
 * cannot fire when the suite does not run. Measured 2026-09-23 — a build that
 * simply stopped compiling `test/` took `npm run check` to exit 0 with `# tests
 * 0` and every coverage threshold cleared, because a glob that matches nothing
 * is not an error and c8 measured only the files the run loaded, of which there
 * were none. So the floor is `scripts/assert-test-corpus.mjs`, invoked by the
 * chain before c8 starts; what this file pins is that the chain still invokes
 * it. See CC-PROC-164.
 *
 * Runs from the repo root (cwd), so the gate's own files are read by repo path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');

const scripts = (): Record<string, string> =>
  (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

/** The floor every other link in the chain is here to keep wired. */
const CORPUS_GUARD = 'scripts/assert-test-corpus.mjs';

/** What `check` and `test:full` spell to invoke it. */
const GUARD_STEP = 'npm run test:corpus';

/**
 * The roots the coverage report is meant to enforce. `dist/src` is the shipped
 * server, `bin` the launcher published beside it, and `test/helpers` the seams
 * the suite itself is built on — a helper with an untested arm is a test that
 * quietly stops testing. c8 has no such list of its own: before 2026-09-23 the
 * report's shape was whatever the run happened to load, which is why the three
 * are now named as `--include` globs and pinned here in both directions.
 */
const ENFORCED_ROOTS: ReadonlyArray<{ include: string; dir: string; extension: string }> = [
  { include: "--include='dist/src/**/*.js'", dir: 'dist/src', extension: '.js' },
  { include: "--include='dist/test/helpers/**/*.js'", dir: 'dist/test/helpers', extension: '.js' },
  { include: "--include='bin/**/*.cjs'", dir: 'bin', extension: '.cjs' },
];

/** Every script whose body reaches the test runner, directly or through another. */
function suiteRunningScripts(): string[] {
  return Object.entries(scripts())
    .filter(([name, body]) => name !== 'test' && /npm (?:test|run coverage)\b/.test(body))
    .map(([name]) => name)
    .sort();
}

/** Lines of a workflow file, grouped by the job whose block they fall in. */
function jobSteps(workflow: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of read(workflow).split('\n')) {
    const header = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      current = [];
      jobs.set(header[1], current);
      continue;
    }
    current?.push(line);
  }
  return jobs;
}

test('the corpus guard exists and is the script the chain names', () => {
  assert.ok(existsSync(path.join(repoRoot, CORPUS_GUARD)), `${CORPUS_GUARD} must exist`);
  assert.equal(scripts()['test:corpus'], `node ${CORPUS_GUARD}`);
});

test('every composite script that reaches the runner runs the corpus guard first', () => {
  assert.deepEqual(
    suiteRunningScripts(),
    ['check', 'coverage', 'test:full'],
    'a script now reaches the test runner that this gate has never seen. Decide whether it ' +
      'must run the corpus guard first — a path to the suite that skips the floor can report ' +
      'a green run of nothing — and then add it here',
  );

  for (const name of ['check', 'test:full']) {
    const body = scripts()[name] ?? '';
    const guard = body.indexOf(GUARD_STEP);
    const runner = body.search(/npm (?:test|run coverage)\b/);
    assert.ok(
      guard !== -1 && guard < runner,
      `the \`${name}\` script reaches the test runner without running \`${GUARD_STEP}\` first. ` +
        'An empty or half-compiled corpus would then be reported as a pass',
    );
  }
});

test('the coverage script deliberately does not run the guard itself', () => {
  const coverage = scripts()['coverage'] ?? '';
  assert.ok(
    !coverage.includes(GUARD_STEP),
    'the corpus guard has moved inside `coverage`, where c8 wraps it. A repo script that runs ' +
      'under an active coverage session joins the report it was never written to satisfy ' +
      '(CC-PROC-136), and the guard would take the gate down on its own statements. It belongs ' +
      'in the `check` chain immediately before `coverage`, which is where the chain puts it',
  );
});

test('coverage enforces the named roots rather than whatever a run loaded', () => {
  const coverage = scripts()['coverage'] ?? '';
  assert.ok(
    coverage.includes('c8 --all '),
    'the `coverage` script no longer passes `--all`. Without it c8 reports only the files the ' +
      'run loaded, so a run that loads nothing reports 100 % of nothing and clears every ' +
      'threshold — the exact hole CC-PROC-164 closed',
  );

  for (const root of ENFORCED_ROOTS) {
    assert.ok(
      coverage.includes(root.include),
      `the \`coverage\` script no longer includes \`${root.dir}\`, so nothing under it is ` +
        'enforced any more. Coverage would stay at 100 % while that code went untested',
    );
    const dir = path.join(repoRoot, root.dir);
    assert.ok(existsSync(dir), `${root.dir} is included in the coverage report but does not exist`);
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) =>
      name.endsWith(root.extension),
    );
    assert.ok(
      files.length > 0,
      `the \`coverage\` script includes \`${root.dir}\`, which holds no \`${root.extension}\` ` +
        'file. An include that matches nothing is not enforcement, it is the appearance of it',
    );
  }

  const declared = (coverage.match(/--include='[^']+'/g) ?? []).sort();
  assert.deepEqual(
    declared,
    ENFORCED_ROOTS.map((root) => root.include).sort(),
    'the `coverage` script includes a path this gate does not know about. Add it to ' +
      'ENFORCED_ROOTS with the reason it is enforced, or drop it from the script',
  );
});

test('CI runs the corpus guard before every step that executes the suite', () => {
  const jobs = jobSteps('.github/workflows/ci.yml');
  assert.ok(jobs.size > 0, '.github/workflows/ci.yml parsed into no jobs at all');

  let guarded = 0;
  for (const [name, lines] of jobs) {
    const guard = lines.findIndex((line) => line.includes(`run: ${GUARD_STEP}`));
    const runner = lines.findIndex((line) => /run: npm (?:test|run coverage)\s*$/.test(line));
    if (runner === -1) {
      assert.equal(
        guard,
        -1,
        `the \`${name}\` job runs the corpus guard but never runs the suite, so the guard ` +
          'guards nothing there',
      );
      continue;
    }
    assert.ok(
      guard !== -1 && guard < runner,
      `the \`${name}\` job runs the suite without running \`${GUARD_STEP}\` first. CI would ` +
        'then report a green run of a corpus it never checked existed',
    );
    guarded += 1;
  }
  assert.equal(
    guarded,
    2,
    'CI no longer has exactly the two suite-running jobs this gate was written against ' +
      '(`check` and `coverage`). Re-read the workflow and decide what the new one needs',
  );
});

/**
 * Run the real guard against a throwaway tree holding the given files. The guard
 * resolves its repo root from its own location, so a copy of it inside the tree
 * audits that tree and never this one. `NODE_V8_COVERAGE` is emptied for the
 * reason `live-probe-plan.test.ts` records: under `npm run coverage` the child
 * would otherwise join the report it was never written for.
 */
function runGuardOn(files: Readonly<Record<string, string>>): { status: number; output: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'corpus-guard-'));
  try {
    mkdirSync(path.join(root, 'scripts'));
    copyFileSync(path.join(repoRoot, CORPUS_GUARD), path.join(root, CORPUS_GUARD));
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: scripts()['test'] } }),
    );
    for (const [relative, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), body);
    }
    const run = spawnSync(process.execPath, [path.join(root, CORPUS_GUARD)], {
      env: { ...process.env, NODE_V8_COVERAGE: '' },
      encoding: 'utf8',
    });
    return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the corpus guard fails a test file whose name the runner glob never reaches', () => {
  const TEST_BODY = "import test from 'node:test';\ntest('runs', () => {});\n";
  const kept = { 'test/a.test.ts': TEST_BODY, 'dist/test/a.test.js': TEST_BODY };

  // The control: without it, a guard that failed every tree would pass the
  // assertions below for the wrong reason.
  const clean = runGuardOn(kept);
  assert.equal(clean.status, 0, `the guard rejected a well-formed corpus: ${clean.output}`);

  // What a fresh build leaves after a rename away from `*.test.ts`: tsc compiles
  // `b.spec.ts` to `b.spec.js`, which `dist/**/*.test.js` never matches, and a
  // `.mts` source is not compiled at all. Nothing stale remains to be caught.
  const renamed: ReadonlyArray<Record<string, string>> = [
    { 'test/b.spec.ts': TEST_BODY, 'dist/test/b.spec.js': TEST_BODY },
    { 'test/b-test.ts': TEST_BODY, 'dist/test/b-test.js': TEST_BODY },
    { 'test/b.test.mts': TEST_BODY },
    { 'test/b.cjs': "const test = require('node:test');\ntest('runs', () => {});\n" },
  ];
  for (const extra of renamed) {
    const [source] = Object.keys(extra);
    const run = runGuardOn({ ...kept, ...extra });
    assert.equal(
      run.status,
      1,
      `the guard passed a tree in which ${source} imports node:test but is not *.test.ts, so ` +
        `\`npm test\` would silently stop running it: ${run.output}`,
    );
    assert.ok(
      run.output.includes(String(source)),
      `the guard failed, but without naming ${source}: ${run.output}`,
    );
  }

  // Only code the runner could load counts: prose that quotes the import, and a
  // directory that merely carries a code suffix, are not test files.
  const bystanders = runGuardOn({
    ...kept,
    'test/NOTES.md': TEST_BODY,
    'test/fixtures.js/data.txt': 'not code',
  });
  assert.equal(bystanders.status, 0, `the guard rejected a non-test file: ${bystanders.output}`);
});

test('the release job runs the gate before the npm token is in scope', () => {
  const lines = jobSteps('.github/workflows/release.yml').get('publish-npm');
  assert.ok(lines !== undefined, 'release.yml no longer has a `publish-npm` job');

  const gate = lines.findIndex((line) => /run: npm run check\s*$/.test(line));
  const publish = lines.findIndex((line) => /run: npm publish\b/.test(line));
  const token = lines.findIndex((line) => line.includes('secrets.NPM_TOKEN'));
  assert.ok(
    gate !== -1 && gate < publish,
    'the release job no longer runs `npm run check` as its own step before publishing',
  );
  // Left to `prepublishOnly`, the gate runs INSIDE the publish step, whose env
  // carries NODE_AUTH_TOKEN into every dev dependency and every test child.
  assert.match(
    lines[publish] ?? '',
    /--ignore-scripts/,
    '`npm publish` runs lifecycle scripts again, so the whole gate executes with the token',
  );
  assert.ok(token > publish, 'the npm token is in scope before the publish step');

  // A `workflow_dispatch` has no release; skipping the check for it let a
  // dispatch from any branch publish that branch as `latest`.
  assert.ok(
    !lines.some((line) => /^\s*if: github\.event_name == 'release'\s*$/.test(line)),
    'the tag/version check is skipped for some trigger again',
  );
  assert.ok(
    lines.some((line) => line.includes('github.event.release.tag_name || github.ref_name')),
    'the tag/version check no longer falls back to the dispatched ref',
  );
});
