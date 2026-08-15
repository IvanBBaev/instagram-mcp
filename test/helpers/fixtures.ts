/**
 * Loads sanitized Graph-response fixtures captured by Lane E (T-E1) from
 * `test/fixtures/`. Resolved from the project root so it works whether tests
 * run from source or built output.
 *
 * Fixtures are written by `scripts/capture-fixtures.mjs`, which runs every
 * response through `test/helpers/sanitize.ts` (default-deny allowlist +
 * redactor backstop) before anything reaches disk. Nothing under
 * `test/fixtures/` is raw Graph output.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The fixtures directory under a given repo root (single source of truth for both scripts). */
export function fixturesDirFor(repoRoot: string): string {
  return join(repoRoot, 'test', 'fixtures');
}

const fixturesDir = fixturesDirFor(process.cwd());

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T;
}

/** True when `name` exists in the fixtures directory. */
export function hasFixture(name: string): boolean {
  return existsSync(join(fixturesDir, name));
}

/**
 * Every `*.json` file name in `dir`, sorted. A missing directory is not an
 * error: it is the state of a checkout whose `test/fixtures/` has never been
 * populated, and the callers all treat "no captures" as "skip".
 *
 * Split out from {@link listFixtures} so the missing-directory arm can be
 * exercised against a path that is guaranteed absent — the module-level fixtures
 * directory is committed, so through `listFixtures` alone that arm is dead.
 */
export function listFixturesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

/**
 * Every `*.json` fixture file name, sorted. Empty when the directory holds no
 * captures yet — a fresh clone has only the directory's README, because real
 * captures require live credentials the repository must never contain.
 */
export function listFixtures(): string[] {
  return listFixturesIn(fixturesDir);
}
