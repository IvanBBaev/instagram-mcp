/**
 * Prose that cites the suite (`src/**`, `test/**`, `scripts/**` and `docs/**` -> `test/**`).
 *
 * This repository's source files carry two kinds of note that name a test by
 * title: an equivalent-mutant note ("this mutation survives, and here is what
 * kills the ones that matter") and a pin note ("this line looks removable; it is
 * not, and X is what says so"). The corner-case catalogue does the same in prose,
 * and both exist to stop a future reader from deleting a guard they cannot see the
 * point of - so both are only worth the space they take if what they quote still
 * resolves to something that runs.
 *
 * A rename breaks that silently, and it breaks it in the worst direction: the
 * note still reads as a measurement, the test it points at is gone, and nobody
 * learns which of the two happened. Renaming a test is also not a rare event
 * here - a test whose name claims more than its assertions observe gets renamed
 * the moment that is noticed (CC-PROC-127), and each of those renames is a
 * chance to orphan a citation.
 *
 * Scope, and what it deliberately leaves out. Two forms carry a checkable claim:
 * a QUOTED title after a pin verb (straight quotes in `src/` comments, curly ones
 * in the docs), and a backticked repo PATH after the same verb. A backticked
 * citation that is not a path is NOT scraped, and that is a decision rather than
 * an oversight: in these docs a code span holds code as readily as a title -
 * `killed by ` + "`only list_linked_accounts is restricted to the fb-login path`"
 * is a test title, `pinned by ` + "`replies: { data: [] }`" is a fixture and
 * `held by ` + "`includes('\"0.0.0.0\"')`" is an assertion fragment - so the span
 * alone says nothing about which, and a gate that guessed would either miss
 * titles or fail on code. Quote a title you want held. Unquoted paraphrase is
 * prose, and the two suite titles built from template literals are not scraped
 * either; nothing cites them.
 *
 * A second gate lives here, on the same premise seen from the other side. A
 * broken citation is prose that stopped being true; an escape sequence left
 * sitting in a comment is prose that was never legible at all. Nothing else in
 * the repo looks: prettier reformats a comment without reading it, the compiler
 * does not look inside one, and the coverage gate cannot reach text that never
 * runs. Both are found by opening the same files this gate already opens.
 *
 * Strictly read-only: this file opens files, never writes one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

const REPO_ROOT = findRepoRoot();

/** Every file under one repo directory with the given extension, read once. */
function treeOf(dir: string, ext: string): { path: string; text: string }[] {
  const root = join(REPO_ROOT, dir);
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith(ext))
    .map((rel) => ({ path: `${dir}/${rel}`, text: readFileSync(join(root, rel), 'utf8') }));
}

/**
 * Every title the suite registers, in the two spellings a citation can resolve
 * to: `test('...')` and `describe('...')`.
 */
function suiteTitles(): Set<string> {
  const titles = new Set<string>();
  for (const file of treeOf('test', '.ts')) {
    for (const match of file.text.matchAll(/\b(?:test|describe)\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      titles.add((match[2] ?? '').replace(/\\(['"\\])/g, '$1'));
    }
  }
  return titles;
}

/**
 * Comment prose with its line furniture removed, so a citation that wraps across
 * two lines reads as one string. `* ` and `// ` are dropped along with the break;
 * everything else is left where it is.
 */
function flattenComments(text: string): string {
  return text.replace(/\n\s*(?:\*|\/\/)\s?/g, ' ');
}

/**
 * Every file whose prose may cite the suite, flattened. Markdown wraps mid
 * sentence, so a citation there can straddle a line break just as a comment can;
 * collapsing the break is what lets one regex read both.
 */
function citingProse(): { path: string; prose: string }[] {
  return [
    ...treeOf('src', '.ts').map(({ path, text }) => ({ path, prose: flattenComments(text) })),
    // The suite cites itself, and until 2026-09-23 nothing watched those
    // citations. A test file is where a rename is EASIEST to make - the title and
    // the note that quotes it sit in the same tree, often the same file - and
    // three such citations were already here, unwatched: two titles in
    // `test/core/config-write.test.ts` and a path in `test/tools/pretty-json.test.ts`.
    // All three resolved when this was widened, so nothing was broken; what was
    // missing was anything that would say so if one stopped resolving.
    //
    // `scripts/**` contributes none today and is swept anyway: `live-probe.mjs` is
    // a harness with the same habit of explaining itself by naming what holds it,
    // and a tree only enters this gate when someone remembers it exists.
    ...treeOf('test', '.ts').map(({ path, text }) => ({ path, prose: flattenComments(text) })),
    ...treeOf('scripts', '.mjs').map(({ path, text }) => ({ path, prose: flattenComments(text) })),
    ...treeOf('docs', '.md').map(({ path, text }) => ({
      path,
      prose: text.replace(/\n\s*/g, ' '),
    })),
    {
      path: 'README.md',
      prose: readFileSync(join(REPO_ROOT, 'README.md'), 'utf8').replace(/\n\s*/g, ' '),
    },
  ];
}

/** `<verb> by "<title>"` anywhere in the flattened prose, in either quote style. */
const CITATION =
  /(?:[Pp]inned|[Kk]illed|[Cc]aught|[Hh]eld|[Gg]uarded) by\s+["\u201c]([^"\u201d]{6,200})["\u201d]/g;

/** `<verb> by `<repo path>`` - a pointer at a whole file rather than one title. */
const PATH_CITATION =
  /(?:[Pp]inned|[Kk]illed|[Cc]aught|[Hh]eld|[Gg]uarded) by\s+`((?:src|test|docs)\/[^`\s]+)`/g;

/** The registered title that shares the longest prefix with `cited`, if any is close. */
function nearest(cited: string, titles: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestLength = 12;
  for (const title of titles) {
    let shared = 0;
    while (shared < title.length && shared < cited.length && title[shared] === cited[shared]) {
      shared += 1;
    }
    if (shared > bestLength) {
      bestLength = shared;
      best = title;
    }
  }
  return best;
}

test('every test a comment or a document cites by title is a test that still exists', () => {
  const titles = suiteTitles();
  assert.ok(
    titles.size > 100,
    `only ${titles.size} test titles were scraped out of test/ - the scrape is broken, and a ` +
      'broken scrape passes this file silently',
  );

  const citations: { path: string; cited: string }[] = [];
  for (const { path, prose } of citingProse()) {
    for (const match of prose.matchAll(CITATION)) {
      citations.push({ path, cited: (match[1] ?? '').trim() });
    }
  }
  assert.ok(
    citations.length > 0,
    'no comment or document cites a test by title any more. Either the notes were removed - in ' +
      'which case delete this file - or the citation spelling drifted away from ' +
      `${String(CITATION)} and this gate has been passing on an empty set`,
  );

  for (const { path, cited } of citations) {
    const suggestion = nearest(cited, titles);
    assert.ok(
      titles.has(cited),
      `${path} cites "${cited}" as what holds a line in place, and no test in the suite has ` +
        'that title. The note reads as a measurement either way, so whoever meets it next ' +
        'cannot tell whether the test was renamed or the guard was deleted.' +
        (suggestion === undefined ? '' : ` Closest title that does exist: "${suggestion}".`),
    );
  }
});

test('every test file a comment or a document cites by path is a file that still exists', () => {
  // The other citation form, and the one a move breaks rather than a rename: a
  // note that names a whole file says "the evidence lives over there", and a
  // reader who follows it to nothing has no way to tell a relocated suite from a
  // deleted one. Cheap to check and unambiguous - unlike a backticked title, a
  // backticked path either resolves or it does not.
  const citations: { path: string; cited: string }[] = [];
  for (const { path, prose } of citingProse()) {
    for (const match of prose.matchAll(PATH_CITATION)) {
      citations.push({ path, cited: match[1] ?? '' });
    }
  }
  assert.ok(
    citations.length > 0,
    'no comment or document points at a test file by path any more; if that is deliberate, ' +
      `delete this test rather than leaving ${String(PATH_CITATION)} matching nothing`,
  );

  for (const { path, cited } of citations) {
    assert.ok(
      existsSync(join(REPO_ROOT, cited)),
      `${path} names \`${cited}\` as where its evidence lives, and there is no such file`,
    );
  }
});

// --- comment legibility -------------------------------------------------------

/**
 * Every comment in one TypeScript or JavaScript source, parsed rather than
 * guessed at.
 *
 * Where a comment starts is not something a regex can decide in this tree. A
 * Graph URL puts `//` inside a string on dozens of lines, and the citation
 * patterns above put what looks like a comment opener inside a regular
 * expression.
 *
 * The compiler's bare scanner is not enough either, which is worth writing down
 * because the first draft of this gate used it and shipped green against a tree
 * it could not read. A standalone scanner carries no template-literal state: it
 * is the PARSER that tells it when a closing brace resumes a template. Driven by
 * `scan()` alone, the backtick that ends a substitution template is read as the
 * backtick that opens a new one, and everything up to the next backtick - the
 * comments among it - disappears inside a token. On `test/core/clock.test.ts`
 * that draft reported three comments where the file has sixty-two, missed all
 * fifty-nine single-line ones, and therefore passed.
 *
 * Parsing is what resolves it, because the parser is what drives those modes.
 * Every comment in a file is leading trivia of exactly one token, so walking all
 * of them and asking what trivia sits in front of each sees every comment; the
 * same range is offered by a node and by its first descendants, which is what
 * `seen` discards.
 */
function commentsIn(path: string, text: string): { text: string; pos: number }[] {
  const kind = path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const found: { text: string; pos: number }[] = [];
  const seen = new Set<number>();
  const walk = (node: ts.Node): void => {
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      found.push({ text: text.slice(range.pos, range.end), pos: range.pos });
    }
    for (const child of node.getChildren(source)) walk(child);
  };
  walk(source);
  return found;
}

/**
 * A backslash-u escape sequence, in both spellings ECMAScript accepts: four hex
 * digits, or any number of them inside braces.
 *
 * Inside a string, a template or a regular expression this is one character and
 * the source file stays ASCII, which is why the suite uses it deliberately in
 * about two dozen fixtures. Inside a comment nothing interprets it, and the
 * sentence reaches its reader with six raw characters wedged into the middle of
 * it.
 */
const INERT_ESCAPE = /\\u(?:\{[0-9a-fA-F]{1,6}\}|[0-9a-fA-F]{4})/g;

test('no comment ships an escape sequence that reaches the reader unresolved', () => {
  // How this happens is worth stating, because it is not a typo: these notes are
  // written by tooling that keeps non-ASCII out of its own output, and a dash or
  // an ellipsis that belongs in a string arrives in a comment unchanged. Six of
  // them had accumulated across three files before anything looked (CC-PROC-180),
  // one of them in the middle of the sentence explaining why the test below it
  // exists. The failure mode is pure legibility, which is exactly why no other
  // gate here can see it: the file compiles, the suite is green, the coverage is
  // 100 %, and the paragraph a future maintainer has to trust is gibberish.
  const offenders: string[] = [];
  for (const file of [
    ...treeOf('src', '.ts'),
    ...treeOf('test', '.ts'),
    ...treeOf('scripts', '.mjs'),
  ]) {
    for (const comment of commentsIn(file.path, file.text)) {
      const firstLine = file.text.slice(0, comment.pos).split('\n').length;
      const lines = comment.text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        for (const hit of lines[i]?.match(INERT_ESCAPE) ?? []) {
          offenders.push(`${file.path}:${firstLine + i} ${hit}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a comment carries an escape sequence nothing will resolve; write the character itself',
  );
});
