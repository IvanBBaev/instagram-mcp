/**
 * Assert the compiled test corpus the runner will actually see is complete and
 * non-empty.
 *
 * `npm test` is `node --test "<glob>"`, and a glob that matches nothing is not
 * an error: node exits 0 having run zero tests, and c8 then measures zero
 * statements of zero files, so `--check-coverage --statements=100` passes too.
 * Both halves of the gate therefore accept a tree in which no test ran at all.
 * This is the missing floor. It runs OUTSIDE c8 — before `coverage` in the
 * `check` chain — so it is never itself instrumented, and it reads the runner's
 * glob out of package.json rather than restating it, so the two cannot drift.
 *
 * Both directions are asserted: every test source under `test/` must have a
 * compiled counterpart the glob matches, and every file the glob matches must
 * come from one. The second direction catches a stale build running a test
 * whose source was deleted.
 *
 * Both directions are keyed on the `.test.ts` suffix, so a third check keeps the
 * suffix honest: a file under `test/` that imports `node:test` IS a test, and if
 * it is not spelled `*.test.ts` it is either compiled to a name the glob never
 * matches (`auth.spec.ts`, `auth-test.ts`) or not compiled at all
 * (`auth.test.mts`). Either way it silently leaves the suite, and on a fresh
 * checkout nothing stale is left behind for the second direction to catch.
 *
 * Run via `npm run test:corpus`. Dependency-free (only `node:` builtins), a
 * plain ESM script deliberately outside `tsconfig` (`scripts` is not compiled).
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fail the gate with a message an operator can act on, and nothing else. */
function fail(message) {
  console.error(`test-corpus guard: ${message}`);
  process.exit(1);
}

/** The glob `npm test` hands to `node --test`, read from package.json. */
function runnerGlob() {
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const script = scripts.test ?? '';
  const quoted = /"([^"]+)"|'([^']+)'/.exec(script);
  if (quoted === null) {
    fail(
      `package.json "test" is \`${script}\`, which spells no quoted glob. This guard reads the ` +
        'glob from there so the two cannot drift; teach it the new spelling.',
    );
  }
  return quoted[1] ?? quoted[2];
}

/** Translate the `*` / `**` subset of glob syntax `node --test` accepts. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .split('**/')
    .map((part) => part.replace(/\*/g, '[^/]*'))
    .join('(?:[^/]+/)*');
  return new RegExp(`^${body}$`);
}

/** Every path under `dir`, relative to the repo root, in forward-slash form. */
function walk(dir) {
  if (!existsSync(join(repoRoot, dir))) return [];
  return readdirSync(join(repoRoot, dir), {
    recursive: true,
    encoding: 'utf8',
    withFileTypes: false,
  })
    .map((name) => `${dir}/${name.split(sep).join('/')}`)
    .sort();
}

const glob = runnerGlob();
const matches = globToRegExp(glob);

const sources = walk('test').filter((path) => path.endsWith('.test.ts'));
if (sources.length === 0) {
  fail(
    'no test sources under test/ — the guard would pass vacuously, which is the exact ' +
      'failure it exists to catch.',
  );
}

/** A module the runner could load, in any spelling TypeScript or Node accepts. */
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** An import of the runner's own API — what makes a file a test file. */
const IMPORTS_NODE_TEST =
  /\bfrom\s*['"]node:test['"]|\b(?:import|require)\(\s*['"]node:test['"]\s*\)/;

const misnamed = walk('test').filter(
  (path) =>
    CODE_FILE.test(path) &&
    !path.endsWith('.test.ts') &&
    statSync(join(repoRoot, path)).isFile() &&
    IMPORTS_NODE_TEST.test(readFileSync(join(repoRoot, path), 'utf8')),
);
if (misnamed.length > 0) {
  fail(
    `${misnamed.length} file(s) under test/ import node:test but are not named *.test.ts, so ` +
      `\`npm test\` never runs them — starting with ${misnamed[0]}. Rename it to *.test.ts.`,
  );
}

const expected = sources.map((path) => `dist/${path.slice(0, -'.ts'.length)}.js`);

const unmatched = expected.filter((path) => !matches.test(path));
if (unmatched.length > 0) {
  fail(
    `${unmatched.length} compiled test file(s) do not match \`${glob}\`, so \`npm test\` would ` +
      `never run them — starting with ${unmatched[0]}. The runner's glob and the layout of ` +
      'test/ disagree.',
  );
}

const missing = expected.filter((path) => !existsSync(join(repoRoot, path)));
if (missing.length > 0) {
  fail(
    `${missing.length} of ${expected.length} test file(s) were not compiled — starting with ` +
      `${missing[0]}. Run \`npm run build\` first; if a build just ran, tsconfig's include no ` +
      'longer reaches test/ and the suite is about to pass by running nothing.',
  );
}

const found = new Set(walk('dist').filter((path) => matches.test(path)));
const stale = [...found].filter((path) => !expected.includes(path));
if (stale.length > 0) {
  fail(
    `${stale.length} compiled test file(s) have no source under test/ — starting with ` +
      `${stale[0]}. A deleted or renamed test is still being run from a stale build; ` +
      'remove dist/ and rebuild.',
  );
}

console.log(`test-corpus guard: ${expected.length} compiled test files match \`${glob}\`.`);
