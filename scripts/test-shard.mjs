/**
 * Run one deterministic slice of the compiled test corpus.
 *
 * Usage: `npm run test:shard -- <index>/<total>` (for example `2/3`), or the
 * same value in `TEST_SHARD`. `1/1` is the whole suite, file for file the run
 * `npm test` makes.
 *
 * The slicing is Node's own `--test-shard`, available on every Node the
 * `engines` field accepts: the runner expands the glob, then keeps the files
 * whose position modulo `total` is `index - 1`. The shards of one run are
 * therefore disjoint and together are the whole corpus, on any one platform.
 * This wrapper exists because `npm run <script> -- x` appends `x` after the
 * glob, where `node --test` reads it as one more file pattern, not a flag.
 *
 * The glob is read out of package.json's `test` script, as the corpus guard
 * reads it, so a shard can never run a different corpus from `npm test`. It is
 * not a coverage path: c8 measures the one unsharded `coverage` run, and a
 * shard proves only that its files pass. Run `npm run test:corpus` first, as
 * CI does; with a complete corpus and `total` no larger than the file count,
 * every shard holds at least one file, so no shard can pass by running nothing.
 *
 * Dependency-free (only `node:` builtins), a plain ESM script outside
 * `tsconfig` (`scripts` is not compiled).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fail with a message an operator can act on, and nothing else. */
function fail(message) {
  console.error(`test-shard: ${message}`);
  process.exit(2);
}

const spec = process.argv[2] ?? process.env.TEST_SHARD ?? '';
const parsed = /^([1-9]\d*)\/([1-9]\d*)$/.exec(spec);
if (parsed === null || process.argv.length > 3) {
  fail(
    `expected exactly one shard as <index>/<total> (e.g. \`npm run test:shard -- 2/3\`), ` +
      `got \`${process.argv.slice(2).join(' ') || spec}\`.`,
  );
}
const index = Number(parsed[1]);
const total = Number(parsed[2]);
if (index > total)
  fail(`shard ${index}/${total} does not exist: the index runs from 1 to ${total}.`);

const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const quoted = /"([^"]+)"|'([^']+)'/.exec(scripts.test ?? '');
if (quoted === null) {
  fail(`package.json "test" spells no quoted glob; teach this script the new spelling.`);
}
const glob = quoted[1] ?? quoted[2];

// Same `*` / `**` subset the corpus guard translates. Counted here only to
// refuse a `total` that would leave a shard empty; the runner does the slicing.
const body = glob
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .split('**/')
  .map((part) => part.replace(/\*/g, '[^/]*'))
  .join('(?:[^/]+/)*');
const matches = new RegExp(`^${body}$`);
const files = existsSync(join(repoRoot, 'dist'))
  ? readdirSync(join(repoRoot, 'dist'), { recursive: true, encoding: 'utf8' })
      .map((name) => `dist/${name.split(sep).join('/')}`)
      .filter((path) => matches.test(path))
  : [];
if (files.length === 0) {
  fail(`no file matches \`${glob}\`. Run \`npm run build\` and \`npm run test:corpus\` first.`);
}
if (total > files.length) {
  fail(
    `${total} shards over ${files.length} test files would leave a shard with nothing to run, ` +
      'which passes. Use fewer shards.',
  );
}

const run = spawnSync(process.execPath, ['--test', `--test-shard=${index}/${total}`, glob], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (run.error !== undefined) fail(`could not start the test runner: ${run.error.message}`);
process.exit(run.status ?? 1);
