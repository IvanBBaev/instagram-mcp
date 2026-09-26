/**
 * Capture tooling (`scripts/capture-fixtures.mjs`). The script is the only
 * writer of `test/fixtures/`, and it is the one program in this repository that
 * nothing ever runs: it sits outside `tsconfig`, outside every coverage include
 * root and outside the test corpus. The 100% report is structurally blind to it.
 *
 * Measured 2026-09-23 — dropping `thumbnail_url` from the script's `CHILD_FIELDS`
 * copy and, in the same mutant, turning its exit code into a lie left the whole
 * suite green with an empty killer diff, while the identical field drop inside
 * `src/api/media.ts` was killed by three tests by name. The harness can see this
 * class of change perfectly well; it simply had nothing to say about the copy.
 *
 * The script's own header states the duplication rule in prose — when a field
 * set changes in the api layer, change it here too — and the prose was the whole
 * enforcement. It had already failed: the `content_publishing_limit` list sent
 * `config,quota_usage` while `src/api/publishing.ts` sent `quota_usage,config`.
 *
 * So this file reads both sides as text and compares them. Textual rather than
 * by import, for the reason CC-PROC-166 records: the constants are module-private
 * on the api side, the script is never compiled, and importing the script would
 * run its `main()` against a live account.
 *
 * Runs from the repo root (cwd), like the other release gates beside it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');

/** The mirror. Nothing in the repo executes it, so nothing else observes it. */
const CAPTURE_SCRIPT = 'scripts/capture-fixtures.mjs';

/**
 * Every field-set constant the capture script copies, against the module that
 * owns the original. `MEDIA_DETAIL_FIELDS` is derived on both sides from the two
 * entries above it and is listed anyway: it pins the composition, not just the
 * parts, and a drift in how the children edge is spelled would slip past a check
 * that only compared the pieces.
 */
const MIRRORED_FIELD_SETS: ReadonlyArray<readonly [name: string, owner: string]> = [
  ['ACCOUNT_FIELDS', 'src/api/account.ts'],
  ['MEDIA_FIELDS', 'src/api/media.ts'],
  ['CHILD_FIELDS', 'src/api/media.ts'],
  ['MEDIA_DETAIL_FIELDS', 'src/api/media.ts'],
  ['COMMENT_FIELDS', 'src/api/comments.ts'],
  ['COMMENT_DETAIL_FIELDS', 'src/api/comments.ts'],
  ['TAGGED_MEDIA_FIELDS', 'src/api/comments.ts'],
];

/**
 * The two field lists the script writes inline instead of through a constant,
 * against the module that sends the same list. These are the ones that drifted.
 */
const MIRRORED_INLINE_FIELDS: ReadonlyArray<readonly [fields: string, owner: string]> = [
  ['quota_usage,config', 'src/api/publishing.ts'],
  ['name,instagram_business_account{id,username}', 'src/api/account.ts'],
];

/** The declared body of every `*_FIELDS` constant in one file, in source order. */
function fieldSetBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const match of source.matchAll(/^const ([A-Z_]*FIELDS) =([^;]*);/gm)) {
    const name = match[1];
    const body = match[2];
    if (name !== undefined && body !== undefined) bodies.set(name, body);
  }
  return bodies;
}

/**
 * What such a body evaluates to, resolved against the constants declared before
 * it. Three shapes appear across the two sides and all three are handled, which
 * is the point of doing this rather than comparing the source lines: the api
 * layer spells a list as an array joined with a comma while the script spells
 * the same list as one string, and a comparison that could not see through that
 * difference would have nothing to say about either.
 */
function evaluateFieldSet(body: string, known: ReadonlyMap<string, string>): string {
  const template = /^\s*`([^`]*)`\s*$/.exec(body)?.[1];
  if (template !== undefined) {
    return template.replace(/\$\{([A-Z_]+)\}/g, (_whole, name: string) => {
      const value = known.get(name);
      assert.notEqual(value, undefined, `${name} is interpolated before it is declared`);
      return value ?? '';
    });
  }
  const array = /^\s*\[([\s\S]*)\]\s*\.join\(','\)\s*$/.exec(body)?.[1];
  const literals = [...(array ?? body).matchAll(/'([^']*)'/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
  return literals.join(array === undefined ? '' : ',');
}

/** Every `*_FIELDS` constant in one file, resolved to the string Graph receives. */
function fieldSets(relative: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, body] of fieldSetBodies(read(relative))) {
    values.set(name, evaluateFieldSet(body, values));
  }
  return values;
}

test('the field sets the capture script copies still match the ones src/api sends', () => {
  const mirror = fieldSets(CAPTURE_SCRIPT);
  // Floored deliberately. If the declaration pattern stopped matching — a rename,
  // a reformat, a move into an object literal — two empty maps would agree about
  // everything, and this gate would pass for the one reason that means nothing.
  assert.ok(
    mirror.size >= MIRRORED_FIELD_SETS.length,
    `${CAPTURE_SCRIPT} declares ${mirror.size} field-set constants, expected at least ` +
      `${MIRRORED_FIELD_SETS.length} — the scan broke before it compared anything.`,
  );

  const owned = new Map<string, Map<string, string>>();
  for (const [, owner] of MIRRORED_FIELD_SETS) {
    if (owned.has(owner)) continue;
    const sets = fieldSets(owner);
    assert.ok(sets.size > 0, `no field-set constant was found in ${owner} — the scan broke.`);
    owned.set(owner, sets);
  }

  for (const [name, owner] of MIRRORED_FIELD_SETS) {
    const copy = mirror.get(name);
    const original = owned.get(owner)?.get(name);
    assert.notEqual(copy, undefined, `${CAPTURE_SCRIPT} no longer declares ${name}.`);
    assert.notEqual(original, undefined, `${owner} no longer declares ${name}.`);
    assert.equal(
      copy,
      original,
      `${CAPTURE_SCRIPT} asks Graph for a different ${name} than ${owner} does. ` +
        'A fixture captured with the wrong field set is a fixture of an endpoint ' +
        'this server never calls.',
    );
  }

  // The other direction: a constant added to the script but not to the table
  // above would be a copy watched by nothing, which is the state this file exists
  // to end.
  const untabled = [...mirror.keys()].filter(
    (name) => !MIRRORED_FIELD_SETS.some(([mirrored]) => mirrored === name),
  );
  assert.deepEqual(
    untabled.sort(),
    [],
    `${CAPTURE_SCRIPT} declares a field set this gate does not know about. Add it to ` +
      'MIRRORED_FIELD_SETS beside the src/api module it copies.',
  );
});

test('every field list the capture script sends inline is one src/api sends too', () => {
  const source = read(CAPTURE_SCRIPT);
  const inline = [...source.matchAll(/fields: '([^']*)'/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
  // Same floor, same reason: a scan that found nothing must not read as agreement.
  assert.deepEqual(
    [...inline].sort(),
    MIRRORED_INLINE_FIELDS.map(([fields]) => fields).sort(),
    `${CAPTURE_SCRIPT} sends a different set of inline field lists than this gate ` +
      'knows about. Add it to MIRRORED_INLINE_FIELDS beside its owning module.',
  );

  for (const [fields, owner] of MIRRORED_INLINE_FIELDS) {
    assert.ok(
      read(owner).includes(`fields: '${fields}'`),
      `${CAPTURE_SCRIPT} asks for \`${fields}\`, but ${owner} no longer sends that list.`,
    );
  }
});

test('the capture script reports a run in which captures failed as a failure', () => {
  const source = read(CAPTURE_SCRIPT);

  // Every recorded outcome carries an explicit verdict. An arm added without one
  // reads as a failure below, which is the safe direction — but it would make a
  // clean run exit 1, and either way the contract has drifted.
  const recorded = source.match(/results\.push\(\{/g) ?? [];
  const verdicts = source.match(/\bok: (?:true|false)\b/g) ?? [];
  assert.ok(recorded.length >= 4, `only ${recorded.length} recorded outcomes — the scan broke.`);
  assert.equal(
    verdicts.length,
    recorded.length,
    `${CAPTURE_SCRIPT} records ${recorded.length} capture outcomes but states ` +
      `${verdicts.length} verdicts. Every arm needs an explicit \`ok\`.`,
  );

  // And the verdict is read, rather than merely written.
  assert.ok(
    source.includes('results.filter((result) => !result.ok)'),
    `${CAPTURE_SCRIPT} no longer counts its failed captures.`,
  );

  // Until 2026-09-23 the last line of `main` was a bare `return 0;`, so a run in
  // which every capture failed printed a wall of `failed (...)` lines and told
  // its caller it had succeeded. The early exits inside `main` are indented one
  // level deeper; this matches only the terminal expression.
  assert.ok(
    source.includes('\n  return failed.length > 0 ? 1 : 0;\n'),
    `${CAPTURE_SCRIPT} no longer ends by returning a non-zero code when a capture failed.`,
  );
  assert.equal(
    source.includes('\n  return 0;\n'),
    false,
    `${CAPTURE_SCRIPT} ends with an unconditional success again.`,
  );
});
