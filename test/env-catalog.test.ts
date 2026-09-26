/**
 * Docs gate: `.env.example` and the shipped source must name the same `IG_*` set,
 * and `docs/architecture.md` §12 must state the accepted range of every numeric
 * knob truthfully.
 *
 * `docs-sync.test.ts` already ties the README env catalog to `.env.example`, so
 * the operator-facing chain is guarded from `.env.example` outwards. This closes
 * the other end — `.env.example` inwards, against the code — and the direction
 * that matters most is the one that has already failed here:
 *
 *   - **Documented but absent from the source** is a *phantom variable*: a knob
 *     the docs promise and nothing reads. `IG_FB_ACCESS_TOKEN` was exactly this,
 *     surviving in guides and manifests long after the code settled on a single
 *     `IG_ACCESS_TOKEN` for both auth paths. Operators set it, nothing happened,
 *     and no test objected. The manifest suites now guard that one name in two
 *     files; this guards the whole class in the source of truth.
 *   - **Present in the source but undocumented** is a hidden knob: behaviour a
 *     user can trigger and cannot look up.
 *
 * The scan is deliberately broad — every `IG_*` token in `src/`, not just
 * `env.IG_*` member reads. Two idioms read the environment here (direct member
 * access, and helpers taking the name as a string literal such as
 * `parseEnumEnv(env, 'IG_LOG_LEVEL', …)`), and a narrow regex that models only
 * the first would pass while phantoms accumulated behind the second. Breadth
 * costs a small, explicit exception list; narrowness would cost the guarantee.
 *
 * Scope is `src/` alone. `scripts/` holds developer tooling that the `files`
 * allowlist never publishes, so a name there is not a promise to anyone.
 *
 * The last test extends the same idea from names to *values*: a documented range
 * is a promise about which inputs are accepted, and it is the kind of promise
 * that rots silently — nothing fails when a bound moves in `loadSettings` and the
 * table keeps the old number. It is checked in the direction that helps an
 * operator: the bounds are READ OUT OF THE DOCS and enforced against the code, so
 * the table cannot be the thing that is wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSettings } from '../src/core/settings.js';
import { isInstagramError } from '../src/core/types.js';

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

/**
 * An `IG_*` token, anchored so it cannot start mid-identifier. Without the
 * lookbehind, `XDG_CONFIG_HOME` yields a spurious `IG_HOME` — the tail of a word
 * that has nothing to do with this project's namespace.
 */
const IG_TOKEN = /(?<![A-Za-z0-9_])IG_[A-Z][A-Z0-9_]*/g;

/**
 * `IG_*` names in `src/` that are deliberately not environment variables, each
 * with the reason it is exempt. An unexplained allowlist is where real drift
 * eventually hides, so every entry is justified here and checked for staleness
 * by the last test in this file.
 */
const NOT_ENV_VARS: ReadonlyMap<string, string> = new Map([
  ['IG_AUTHORIZE_URL', 'local const in src/cli/login.ts — the Instagram OAuth authorize endpoint'],
  ['IG_TOKEN_URL', 'local const in src/cli/login.ts — the Instagram token-exchange endpoint'],
  ['IG_GRAPH_BASE', 'local const in src/cli/login.ts — the graph.instagram.com base URL'],
  ['IG_HOST', 'local const in src/core/auth.ts — the Path A Graph host'],
  [
    'IG_HTTP_PORT',
    'named only to be denied: a comment in src/core/settings.ts states the port ' +
      'variable is IG_PORT, not IG_HTTP_PORT. Documenting it would create the ' +
      'very variable the comment warns does not exist.',
  ],
  [
    'IG_PROFILE__ACCESS_TOKEN',
    'named only as a counter-example: an equivalent-mutant note in src/core/config.ts ' +
      'cites it as the malformed key the empty-name guard rejects. It is the spelling of ' +
      'a profile variable that must NOT resolve, so documenting it would invite an ' +
      'operator to set the one key the parser is built to drop.',
  ],
]);

/** Every `.ts` file under a directory, recursively. */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Map every `IG_*` token found in `src/` to the first file that mentions it. */
function scanSource(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of collectTsFiles(join(repoRoot, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IG_TOKEN)) {
      if (!found.has(match[0])) found.set(match[0], relative(repoRoot, file));
    }
  }
  return found;
}

/** Every `IG_*` token named anywhere in `.env.example`, keys and comments alike. */
function scanEnvExample(): Set<string> {
  // Comments count as documentation: `IG_AUTH_PATH` is documented as an alias on
  // the `IG_AUTH_MODE` line rather than as a key of its own, and that is a real
  // mention an operator can find. Requiring a leading `KEY=` would call it
  // undocumented and be wrong.
  const text = readFileSync(join(repoRoot, '.env.example'), 'utf8');
  return new Set([...text.matchAll(IG_TOKEN)].map((m) => m[0]));
}

test('.env.example documents no variable the source never mentions', () => {
  const inSource = scanSource();
  const documented = scanEnvExample();

  const phantoms = [...documented].filter((name) => !inSource.has(name)).sort();
  assert.deepEqual(
    phantoms,
    [],
    `.env.example documents ${String(phantoms.length)} variable(s) absent from src/: ` +
      `${phantoms.join(', ')}. Either the code stopped reading them (delete the ` +
      `entries — a knob that does nothing is worse than no knob, because operators ` +
      `set it and trust it) or a rename landed in one place only.`,
  );
});

test('the source mentions no IG_* variable .env.example fails to document', () => {
  const inSource = scanSource();
  const documented = scanEnvExample();

  const undocumented = [...inSource]
    .filter(([name]) => !documented.has(name) && !NOT_ENV_VARS.has(name))
    .map(([name, file]) => `${name} (${file})`)
    .sort();

  assert.deepEqual(
    undocumented,
    [],
    `src/ names ${String(undocumented.length)} IG_* variable(s) that .env.example does ` +
      `not: ${undocumented.join(', ')}. Document each one, or — if it is not an ` +
      `environment variable at all — add it to NOT_ENV_VARS with the reason.`,
  );
});

test('every NOT_ENV_VARS exemption still corresponds to something in the source', () => {
  const inSource = scanSource();
  const stale = [...NOT_ENV_VARS.keys()].filter((name) => !inSource.has(name)).sort();

  // An allowlist that is never pruned stops being an allowlist and becomes a
  // blind spot: a future variable reusing a stale name would be waved through
  // without anyone documenting it.
  assert.deepEqual(
    stale,
    [],
    `NOT_ENV_VARS exempts ${String(stale.length)} name(s) that no longer appear in src/: ` +
      `${stale.join(', ')}. Remove the dead entries so the exemption list keeps ` +
      `meaning what it says.`,
  );
});

/** The numeric knobs, paired with the {@link Settings} field each one lands in. */
const NUMERIC_KNOBS = [
  { env: 'IG_MAX_CONCURRENT', field: 'maxConcurrent' },
  { env: 'IG_MAX_ITEMS', field: 'maxItems' },
  { env: 'IG_REFRESH_AFTER_DAYS', field: 'refreshAfterDays' },
  { env: 'IG_TIMEOUT_MS', field: 'timeoutMs' },
  { env: 'IG_PORT', field: 'httpPort' },
] as const;

/** The `(range 1–64)` note in the §12 row that mentions `name`, or `undefined`. */
function documentedRange(doc: string, name: string): { min: number; max: number } | undefined {
  const row = doc.split('\n').find((line) => line.startsWith('|') && line.includes(`\`${name}\``));
  // An en dash reads correctly in the rendered table; a hyphen is accepted so a
  // future edit typed on a plain keyboard is not silently treated as "no range".
  const match = row?.match(/range (\d+)\s*[–-]\s*(\d+)/);
  return match ? { min: Number(match[1]), max: Number(match[2]) } : undefined;
}

test('architecture §12 states the true accepted range of every numeric knob', () => {
  const doc = readFileSync(join(repoRoot, 'docs', 'architecture.md'), 'utf8');

  for (const { env, field } of NUMERIC_KNOBS) {
    const range = documentedRange(doc, env);
    assert.ok(range, `${env} has no "(range min–max)" note in the §12 table`);
    const { min, max } = range;

    // Both edges from inside as well as outside. A range check with the wrong
    // strictness (`<=` where `<` was meant) rejects everything an
    // out-of-range-only assertion throws at it, so the outside half alone cannot
    // tell the documented ceiling from one step below it.
    assert.equal(
      loadSettings({ [env]: String(min) })[field],
      min,
      `${env}=${min} must be accepted`,
    );
    assert.equal(
      loadSettings({ [env]: String(max) })[field],
      max,
      `${env}=${max} must be accepted`,
    );

    for (const outside of [min - 1, max + 1]) {
      assert.throws(
        () => loadSettings({ [env]: String(outside) }),
        (err: unknown) => isInstagramError(err) && err.kind === 'validation',
        `${env}=${outside} is outside the documented range and must be refused`,
      );
    }
  }
});

/**
 * The rows of the §12 catalog table, sliced out of the document rather than
 * matched across the whole of it. The range notes counted below are a claim about
 * that table specifically — a `(range 1–60)` written into some other section's
 * prose is not a catalog entry, and counting it here would let it stand in for the
 * entry that is actually missing.
 */
function envCatalogRows(doc: string): string[] {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => /^## \d+\. Environment variable catalog/.test(line));
  assert.notEqual(
    start,
    -1,
    'docs/architecture.md no longer has an "Environment variable catalog" section, so the ' +
      'range notes below would be counted over nothing.',
  );
  const offset = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const end = offset === -1 ? lines.length : start + 1 + offset;
  return lines.slice(start, end).filter((line) => line.startsWith('|'));
}

/**
 * Every environment variable `loadSettings` puts through a `{ min, max }` clamp,
 * read out of the source. The bounds themselves are deliberately not captured: they
 * are the document's business, as the file docstring explains, and what this scrape
 * is for is the *set* of knobs that has one.
 */
function clampedKnobs(): string[] {
  const source = readFileSync(join(repoRoot, 'src', 'core', 'settings.ts'), 'utf8');
  const calls = source.matchAll(
    /parseIntEnv\(\s*env,\s*'(IG_[A-Z0-9_]+)',[^,]*,\s*\{\s*min:\s*[\d_]+,\s*max:\s*[\d_]+/g,
  );
  return [...calls].flatMap((match) => (match[1] === undefined ? [] : [match[1]])).sort();
}

/**
 * {@link NUMERIC_KNOBS} is the one hand list in this file without a counterpart, and
 * the test above is a per-item loop over it: a knob the list omits is a knob whose
 * documented range nothing checks, and the loop walks past it reporting the knobs it
 * does name as healthy. Adding a sixth clamp to `loadSettings` is the ordinary way
 * that happens — nothing about writing one prompts an edit here.
 *
 * So the list answers to the source. The equality holds in both directions on
 * purpose: a knob the source clamps and the list omits goes unchecked, and a knob
 * the list names and the source no longer clamps is a range assertion standing on
 * nothing, which keeps passing for whatever reason it happens to pass for.
 */
test('every knob loadSettings clamps has a documented range, and no other row claims one', () => {
  const clamped = clampedKnobs();
  assert.deepEqual(
    clamped,
    NUMERIC_KNOBS.map((knob) => knob.env).sort(),
    'NUMERIC_KNOBS no longer matches the `{ min, max }` clamps in src/core/settings.ts. A knob ' +
      'the source clamps and this list omits has no documented range anyone checks; a knob ' +
      'this list names and the source does not clamp is a range assertion with nothing behind ' +
      'it.',
  );

  // The same completeness claim from the document's side. A `(range ...)` note on a
  // row for something `loadSettings` does not clamp promises an operator a
  // validation that will not happen, and the loop above never reads that row.
  const doc = readFileSync(join(repoRoot, 'docs', 'architecture.md'), 'utf8');
  const noted = envCatalogRows(doc).flatMap((row) => [...row.matchAll(/range \d/g)]);
  assert.equal(
    noted.length,
    clamped.length,
    `the §12 catalog table carries ${noted.length} "(range ...)" note(s) for ${clamped.length} ` +
      'clamped knob(s). An extra note documents a bound nothing enforces.',
  );
});
/**
 * The `IG_*` names the composition root reads out of `process.env` itself,
 * scraped from the source it is built from.
 *
 * `unrecognisedEnvNames` warns about every `IG_*` name nothing reads (CC-CFG-13)
 * by subtracting one list per owner, and each owner is supposed to pin its own
 * half against what it actually reads: `core/settings.ts` and `mcp/registry.ts`
 * both do, through a recording `Proxy` over the env they are handed. The entry’s
 * half had no counterpart, and the docstring above `ENTRY_ENV_NAMES` claimed one
 * for it.
 *
 * The `Proxy` technique does not transfer. `src/index.ts` reads `process.env`
 * directly rather than an injected env, and it cannot be imported at all —
 * `main()` runs at module scope, which is why every other test of the entry
 * spawns it as a child process. So this pin is textual, over the same source the
 * build compiles, in the idiom `clampedKnobs` above already uses.
 */
function entrySource(): string {
  return readFileSync(join(repoRoot, 'src', 'index.ts'), 'utf8');
}

/** Every `process.env.IG_*` member read in the entry, deduplicated and sorted. */
function entryEnvReads(source: string): string[] {
  const reads = source.matchAll(/process\.env\.(IG_[A-Z0-9_]+)/g);
  const names = [...reads].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  return [...new Set(names)].sort();
}

/** The `ENTRY_ENV_NAMES` literal, read as text because the module cannot be imported. */
function entryEnvNames(source: string): string[] {
  const literal = /const ENTRY_ENV_NAMES: readonly string\[\] = \[([^\]]*)\]/.exec(source)?.[1];
  assert.notEqual(
    literal,
    undefined,
    'ENTRY_ENV_NAMES is no longer a plain array literal in src/index.ts, so this gate can no ' +
      'longer read it. Adjust the pattern rather than deleting the check.',
  );
  const quoted = (literal ?? '').matchAll(/'(IG_[A-Z0-9_]+)'/g);
  return [...quoted].flatMap((match) => (match[1] === undefined ? [] : [match[1]])).sort();
}

test('ENTRY_ENV_NAMES is exactly the IG_* set the composition root reads itself', () => {
  const source = entrySource();
  const read = entryEnvReads(source);
  const declared = entryEnvNames(source);

  // Both scrapes are floored. If either pattern silently stopped matching, an
  // empty set would compare equal to an empty set and this gate would pass for
  // the one reason that means nothing.
  assert.ok(read.length > 0, 'found no process.env.IG_* read in src/index.ts — the scrape broke');
  assert.ok(declared.length > 0, 'found no name in the ENTRY_ENV_NAMES literal — the scrape broke');

  // Read in both directions, like the two sibling pins. A name the entry reads
  // and this list omits is a working knob reported to the operator as a typo;
  // a name the list carries and the entry no longer reads silences the warning
  // for a variable that does nothing. Measured 2026-09-23: dropping
  // `IG_ENV_FILE` from the list survived the whole suite before this test
  // existed, while the identical drop from `SETTINGS_ENV_NAMES` was killed by
  // its own pin — the positive control that says the suite can see this class of
  // change at all.
  assert.deepEqual(read, declared);
  assert.equal(new Set(declared).size, declared.length, 'no duplicates');
});
