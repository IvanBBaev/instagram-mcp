/**
 * The CI lane picker (`scripts/ci-lane.mjs`) and the shard runner
 * (`scripts/test-shard.mjs`). Both sit outside `tsconfig` and outside every
 * coverage root, so the 100 % report never sees them; these tests are what
 * observes them.
 *
 * The lane picker decides whether a change skips the OS x Node matrix and the
 * coverage gate, so its failure mode is a code change that CI never tested.
 * The pinned direction is therefore the conservative one: everything that is
 * not plainly docs prose, and every doc a gate or a non-docs test reads, takes
 * the full lane.
 *
 * Both scripts resolve the repo root from their own location, so a copy of one
 * inside a throwaway tree works on that tree and never on this one — the same
 * technique `quality-gate.test.ts` uses for the corpus guard. Doc paths in the
 * docs-lane cases are invented on purpose: the picker routes any doc whose file
 * name appears in a test outside the docs set to the full lane, and this file
 * is outside it, so naming a real docs-lane file here would move it.
 *
 * Runs from the repo root (cwd), like the other release gates beside it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();

/**
 * The child must neither join an active coverage report (see `runGuardOn` in
 * `quality-gate.test.ts`) nor believe it is a subprocess of this runner:
 * `NODE_TEST_CONTEXT` would make a nested `node --test` speak the runner's
 * internal protocol instead of exiting with its own verdict.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: '' };
  delete env['NODE_TEST_CONTEXT'];
  return env;
}

function run(script: string, args: readonly string[], cwd = repoRoot) {
  const child = spawnSync(process.execPath, [path.join(cwd, script), ...args], {
    cwd,
    env: childEnv(),
    encoding: 'utf8',
  });
  return { status: child.status, stdout: child.stdout, output: `${child.stdout}${child.stderr}` };
}

const lane = (...paths: string[]): string =>
  run('scripts/ci-lane.mjs', ['--paths', ...paths]).stdout.trim();

/** Build a throwaway repo holding a copy of `script` and the given files. */
function withTree<T>(
  script: string,
  files: Readonly<Record<string, string>>,
  body: (root: string) => T,
): T {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-scripts-'));
  try {
    mkdirSync(path.join(root, 'scripts'));
    copyFileSync(path.join(repoRoot, script), path.join(root, script));
    for (const [relative, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), text);
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A doc path no file in the repo names. Spelled in two pieces because this
 * source is itself a test outside the docs set: a literal name here would be
 * found by the picker and send the path to the full lane.
 */
const invented = (directory: string, stem: string): string => `${directory}invented-${stem}.md`;

test('docs prose nothing else reads takes the docs lane', () => {
  assert.equal(lane(invented('docs/', 'guide')), 'docs');
  assert.equal(lane(invented('docs/reviews/', 'review'), invented('', 'NOTES')), 'docs');
});

test('anything that is not docs prose takes the full lane', () => {
  for (const path of [
    'src/index.ts',
    'package.json',
    '.github/workflows/ci.yml',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'test/fixtures/README.md',
    'scripts/ci-lane.mjs',
    'docs/index.html',
    'docs/assets/styles.css',
    `${invented('docs/', 'guide')}x`,
  ]) {
    assert.equal(lane(path), 'full', `${path} must take the full lane`);
  }
  // One code path among docs is enough.
  assert.equal(lane(invented('docs/', 'guide'), 'src/index.ts'), 'full');
});

test('docs a gate or a non-docs test reads take the full lane', () => {
  for (const path of [
    'README.md',
    'CHANGELOG.md',
    'docs/auth.md',
    'docs/setup-guide.md',
    'docs/privacy.md',
  ]) {
    assert.equal(lane(path), 'full', `${path} must take the full lane`);
  }
});

test('an empty change takes the full lane', () => {
  assert.equal(lane(), 'full');
});

test('a doc named by a test outside test:docs leaves the docs lane', () => {
  const files = {
    'package.json': JSON.stringify({
      scripts: { 'test:docs': 'node --test "dist/test/docs-*.test.js" dist/test/cites.test.js' },
    }),
    'test/docs-catalog.test.ts': "read('docs/listed.md');\n",
    'test/cites.test.ts': "read('docs/cited.md');\n",
    'test/core/config.test.ts': "read('docs/' + 'pinned.md');\n",
  };
  withTree('scripts/ci-lane.mjs', files, (root) => {
    const at = (...paths: string[]) =>
      run('scripts/ci-lane.mjs', ['--paths', ...paths], root).stdout.trim();
    assert.equal(at('docs/listed.md', 'docs/cited.md'), 'docs');
    assert.equal(at('docs/pinned.md'), 'full');
    assert.equal(at('docs/listed.md', 'docs/pinned.md'), 'full');
  });
});

test('outside a CI event the picker prints lane=full', () => {
  const env = { ...childEnv(), GITHUB_EVENT_NAME: 'workflow_dispatch' };
  const child = spawnSync(process.execPath, ['scripts/ci-lane.mjs'], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'lane=full\n');
  assert.match(child.stderr, /workflow_dispatch/);
});

const PASSING = "import test from 'node:test';\ntest('passes', () => {});\n";

/**
 * The runner's summary line, in either default reporter: Node 22 prints TAP
 * (`# tests 3`) to a pipe, Node 24 prints spec (`ℹ tests 3`) to a pipe too.
 */
const TESTS_SUMMARY = /^(?:#|ℹ) tests (\d+)$/m;

test('the shard runner refuses a malformed or impossible shard', () => {
  for (const args of [[], ['0/2'], ['3/2'], ['1/0'], ['a/b'], ['1/2', '2/2']]) {
    const result = run('scripts/test-shard.mjs', args);
    assert.equal(
      result.status,
      2,
      `test:shard ${args.join(' ')} must be refused: ${result.output}`,
    );
  }
});

test('the shards of a corpus are disjoint and together run all of it', () => {
  const files = {
    'package.json': JSON.stringify({
      type: 'module',
      scripts: { test: 'node --test "dist/**/*.test.js"' },
    }),
    'dist/test/a.test.js': PASSING,
    'dist/test/b.test.js': PASSING,
    'dist/test/nested/c.test.js': PASSING,
  };
  withTree('scripts/test-shard.mjs', files, (root) => {
    const counts = ['1/2', '2/2'].map((shard) => {
      const result = run('scripts/test-shard.mjs', [shard], root);
      assert.equal(result.status, 0, `shard ${shard} failed: ${result.output}`);
      return Number(TESTS_SUMMARY.exec(result.output)?.[1]);
    });
    assert.deepEqual(counts.sort(), [1, 2]);
    assert.equal(TESTS_SUMMARY.exec(run('scripts/test-shard.mjs', ['1/1'], root).output)?.[1], '3');
    const tooMany = run('scripts/test-shard.mjs', ['1/4'], root);
    assert.equal(
      tooMany.status,
      2,
      `four shards over three files must be refused: ${tooMany.output}`,
    );
  });
});

test('a failing test fails its shard', () => {
  const files = {
    'package.json': JSON.stringify({
      type: 'module',
      scripts: { test: 'node --test "dist/**/*.test.js"' },
    }),
    'dist/test/fails.test.js':
      "import test from 'node:test';\ntest('fails', () => { throw 1; });\n",
  };
  withTree('scripts/test-shard.mjs', files, (root) => {
    assert.equal(run('scripts/test-shard.mjs', ['1/1'], root).status, 1);
  });
});
