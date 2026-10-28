/**
 * Decide which CI lane a change takes: `docs` (the docs tests and
 * `format:check` on one runner) or `full` (the OS x Node matrix and the
 * coverage gate).
 *
 * The rule is an allowlist, and every doubt resolves to `full`. A change goes
 * to the docs lane only when EVERY path it touches is prose that nothing but
 * the docs tests reads:
 *
 * - `docs/**\/*.md` or a top-level `*.md`. Anything else (`docs/index.html`,
 *   `docs/assets/`, `.github/**\/*.md`, `test/fixtures/README.md`) is `full`.
 * - Not `README.md`: its tool and env tables are generated from `dist/` and
 *   gated by the drift test. Not `CHANGELOG.md`: `docs-design` parses its
 *   release ledger as the source of truth for version prose, so it is treated
 *   as gate input rather than prose, and kept on the full lane.
 * - Not a doc a test outside the docs set reads. Measured 2026-10-28 by tracing
 *   every file each test opens: `test/core/config.test.ts` reads
 *   `docs/auth.md` and `docs/setup-guide.md`, and
 *   `test/release/mcpb-manifest.test.ts` reads `docs/privacy.md` through the
 *   manifest's `privacy_policies` link. Those are listed below; on top of the
 *   list, a doc whose file name appears in any test source outside the docs
 *   set is `full` too, so a test that starts reading a doc routes it out of the
 *   fast lane without anyone remembering this file.
 *
 * The docs set is the file list of package.json's `test:docs` script, read
 * from there so the lane and the job that runs it cannot drift.
 *
 * Modes:
 * - `node scripts/ci-lane.mjs --paths <path>...` prints the lane for the given
 *   repo paths. Used by the tests and by hand.
 * - `node scripts/ci-lane.mjs` (CI) diffs the change itself and prints
 *   `lane=<lane>` for `$GITHUB_OUTPUT`, with the reason on stderr. A pull
 *   request is diffed against its base (`HEAD^1` of the merge commit Actions
 *   checks out). A push is diffed against `github.event.before` (`CI_BEFORE`)
 *   only if that commit's own CI run succeeded: superseded runs are cancelled
 *   (`cancel-in-progress`), and a docs-only push on top of a cancelled or red
 *   code push must not be the only run that ever looked at that code. Any other
 *   event, a git or API error, or an empty diff is `full`.
 *
 * Dependency-free (only `node:` builtins), a plain ESM script outside
 * `tsconfig` (`scripts` is not compiled).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, sep } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Docs read by a test outside the docs set, so a change to them runs everything. */
const FULL_LANE_DOCS = new Set([
  'README.md',
  'CHANGELOG.md',
  'docs/auth.md',
  'docs/setup-guide.md',
  'docs/privacy.md',
]);

/** Translate the `*` / `**` subset of glob syntax `node --test` accepts. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .split('**/')
    .map((part) => part.replace(/\*/g, '[^/]*'))
    .join('(?:[^/]+/)*');
  return new RegExp(`^${body}$`);
}

/** The test sources the `test:docs` script runs, as `test/....test.ts` paths. */
function docsTestSources() {
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const patterns = (scripts['test:docs'] ?? '')
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ''))
    .filter((word) => word.startsWith('dist/test/'))
    .map((word) => globToRegExp(`${word.slice('dist/'.length, -'.js'.length)}.ts`));
  if (patterns.length === 0) throw new Error('package.json "test:docs" names no dist/test file');
  return (path) => patterns.some((pattern) => pattern.test(path));
}

/** Every test source outside the docs set, with its text. */
function otherTestSources() {
  const inDocsSet = docsTestSources();
  return readdirSync(join(repoRoot, 'test'), { recursive: true, encoding: 'utf8' })
    .map((name) => `test/${name.split(sep).join('/')}`)
    .filter((path) => path.endsWith('.ts') && !inDocsSet(path))
    .map((path) => readFileSync(join(repoRoot, path), 'utf8'));
}

/** The lane for a set of changed repo paths, with the first path that forced `full`. */
function laneFor(paths) {
  if (paths.length === 0) return { lane: 'full', reason: 'no changed paths to classify' };
  let others;
  for (const path of paths) {
    const prose = /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path) || /^[^/]+\.md$/.test(path);
    if (!prose) return { lane: 'full', reason: `${path} is not docs prose` };
    if (FULL_LANE_DOCS.has(path)) return { lane: 'full', reason: `${path} is read by a gate` };
    others ??= otherTestSources();
    const name = basename(path);
    if (others.some((text) => text.includes(name))) {
      return { lane: 'full', reason: `${path} is named by a test outside test:docs` };
    }
  }
  return { lane: 'docs', reason: `${paths.length} path(s), all docs prose` };
}

const git = (...args) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Whether the CI workflow succeeded on `sha` as a push, per the Actions API. */
async function pushRunSucceeded(sha) {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_WORKFLOW_REF } = process.env;
  const workflow = /\/\.github\/workflows\/([^@/]+)@/.exec(GITHUB_WORKFLOW_REF ?? '')?.[1];
  if (!GITHUB_API_URL || !GITHUB_REPOSITORY || !GITHUB_TOKEN || workflow === undefined) {
    return false;
  }
  const url =
    `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs` +
    `?head_sha=${sha}&event=push&status=success&per_page=1`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GET runs for ${sha} answered ${response.status}`);
  const { total_count: count } = await response.json();
  return count > 0;
}

/** The repo paths this CI run's change touches, or a reason it has none to offer. */
async function changedPaths() {
  const event = process.env.GITHUB_EVENT_NAME;
  let base;
  if (event === 'pull_request') {
    const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
    if (parents.length !== 3) return { reason: 'the PR checkout is not a merge commit' };
    base = 'HEAD^1';
  } else if (event === 'push') {
    const before = process.env.CI_BEFORE ?? '';
    if (!/^[0-9a-f]{40}$/.test(before) || /^0+$/.test(before)) {
      return { reason: 'the push has no previous commit to diff against' };
    }
    git('cat-file', '-e', `${before}^{commit}`);
    if (!(await pushRunSucceeded(before))) {
      return { reason: `CI did not succeed on the previous commit ${before.slice(0, 12)}` };
    }
    base = before;
  } else {
    return { reason: `event \`${event}\` always takes the full lane` };
  }
  const paths = git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD')
    .split('\0')
    .filter((path) => path !== '');
  return { paths };
}

if (process.argv[2] === '--paths') {
  console.log(laneFor(process.argv.slice(3)).lane);
} else {
  let decision;
  try {
    const { paths, reason } = await changedPaths();
    decision = paths === undefined ? { lane: 'full', reason } : laneFor(paths);
  } catch (error) {
    decision = { lane: 'full', reason: `could not classify the change: ${error.message}` };
  }
  console.error(`ci-lane: ${decision.lane} (${decision.reason})`);
  console.log(`lane=${decision.lane}`);
}
