/**
 * Loads sanitized Graph-response fixtures captured by Lane E (T-E1) from
 * `test/fixtures/`. Resolved from the project root so it works whether tests
 * run from source or built output.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixturesDir = join(process.cwd(), 'test', 'fixtures');

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as T;
}
