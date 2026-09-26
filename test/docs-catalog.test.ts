/**
 * Structural gate for `docs/corner-cases.md`, the catalogue every other document
 * and ~100 source comments resolve a case against.
 *
 * `docs-sync.test.ts` ties the README to `allTools`, `docs-design.test.ts` ties
 * the design documents to the error taxonomy and the version pin,
 * `docs-user-guides.test.ts` ties the operator guides to the env/tool/scope
 * surface. None of them reads the catalogue at all — measured 2026-09-23, no test
 * in this repo opened the file. It is the largest single document the project
 * publishes and the one with the widest inbound surface, and it was the one
 * nothing checked.
 *
 * What each check buys, in the direction that actually hurts:
 *
 *   - **A citation that resolves to nothing.** `src/cli/doctor.ts` says "see
 *     docs/corner-cases.md CC-CFG-29" and `src/core/settings.ts` says CC-CFG-13.
 *     Those are the sentences a maintainer follows to find out why a line of code
 *     is shaped the way it is. Renumber or retire a row and the pointer still
 *     looks authoritative while leading nowhere — the reader concludes the comment
 *     is stale and ignores it, which is exactly the outcome the comment existed to
 *     prevent. This is the check with the widest reach: every citation site in
 *     `src/`, `test/`, `docs/`, `scripts/` and the README. How many that is, the
 *     catalogue's own preamble states and the last test in this file pins.
 *   - **An ID defined twice.** The IDs are the primary key. Two rows sharing one
 *     means every citation to it is ambiguous, and the second definition is
 *     usually a copy-paste that was meant to get the next free number. The
 *     registers in the last two sections legitimately re-list an ID they do not
 *     define, so the uniqueness claim is scoped to the main table.
 *   - **A dangling `[[wiki-link]]`.** The rows cross-reference each other by that
 *     syntax; a link to a row that does not exist reads as a claim that the
 *     argument was made somewhere else, when it was not.
 *   - **A row that lost a column.** Rows are `| ID | Scenario | Expected | When |`,
 *     and a literal `|` inside a code span has to be escaped as `\|` or it splits
 *     the row into five cells. Markdown renders the damage silently: the "When"
 *     value lands in the "Expected" column and the row still looks like a table.
 *   - **A themed section that stopped being themed.** §1-§7 group the originally
 *     designed cases by area and each heading names its prefix. The catalogue's
 *     convention is that later rows are appended chronologically at the end of §8
 *     whatever their prefix (see the preamble), so §8 is exempt by construction —
 *     but a `CC-PUB` row filed into §4 is neither themed nor chronological, and
 *     nothing about the file would look wrong.
 *   - **A hole in the numbering.** A prefix whose numbers skip one means a row was
 *     deleted outright. Retiring a case is fine; deleting its ID is not, because
 *     the citations elsewhere in the repo do not disappear with it. Keep the row
 *     and mark it retired.
 *
 * The scan reads the repository's own text rather than any build output, so it
 * sees a citation in a comment the compiler strips. The test process runs from the
 * repo root, so every path resolves from cwd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CATALOG = 'docs/corner-cases.md';

/** Directories whose text can cite a case, plus the README below. */
const SCANNED_DIRS: readonly string[] = ['src', 'test', 'docs', 'scripts', '.github'];

/** Extensions that carry prose or comments. Binary and lockfiles are not scanned. */
const SCANNED_EXTENSIONS: readonly string[] = ['.ts', '.md', '.mjs', '.js', '.yml', '.yaml'];

/** A case ID anywhere in running text. */
const ID_PATTERN = /\bCC-[A-Z]+-\d+\b/g;

/** A table row that DEFINES a case: the ID is the first cell. */
const ROW_PATTERN = /^\|\s*(CC-[A-Z]+-\d+)\s*\|/;

/**
 * The two furniture lines every section's table repeats. A pipe line before the first
 * register that is neither furniture nor a row is a row the parse missed.
 */
const TABLE_FURNITURE = /^\| ID \||^\|[-|]+\|$/;

/** A cross-reference between rows. */
const WIKI_LINK_PATTERN = /\[\[(CC-[A-Z]+-\d+)\]\]/g;

/** A numbered section heading that advertises the prefix it collects. */
const SECTION_PATTERN = /^## (\d+)\. .*\((CC-[A-Z]+)\)/;

/** Any numbered section heading, whether or not it advertises a prefix. */
const NUMBERED_HEADING = /^## (\d+)\. /;

/**
 * The preamble sentence that tells a reader where a row lives. Its figures — the tail
 * section’s number, how many rows it holds, how many the catalogue defines in all, how
 * many of the tail carry a foreign prefix, and the breakdown of those — are the only
 * description the document gives of its own shape, and the sentence is read literally so
 * that a rewrite fails loudly instead of checking nothing.
 */
const PREAMBLE_SHAPE = new RegExp(
  [
    '§(\\d+) today holds (\\d+) of the (\\d+) rows the catalogue defines, ',
    'and (\\d+) of those carry a prefix other than the `(CC-[A-Z]+)` ',
    'its heading advertises: ([^.]+)\\.',
  ].join(''),
);

/** One entry of that breakdown: a count, then the prefix it counts. */
const BREAKDOWN_ENTRY = /(\d+) `(CC-[A-Z]+)`/g;

/** The preamble sentence that states how much of the repo cites the catalogue. */
const PREAMBLE_SITES = /(\d+) citation sites across the repo/;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Every text file in the repo that could cite a case, the catalogue excluded. */
function citingFiles(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (SCANNED_EXTENSIONS.some((ext) => path.endsWith(ext))) out.push(path);
    }
  };
  for (const dir of SCANNED_DIRS) if (existsSync(dir)) walk(dir);
  out.push('README.md');
  return out.filter((path) => path !== CATALOG).sort();
}

/**
 * The catalogue's lines, its themed sections, and the index at which the registers
 * begin. The registers re-list IDs defined above and their rows carry three columns,
 * so the uniqueness, column-count and placement claims all stop at that index.
 *
 * That index used to be the literal `## 9.`, which is a fact about today's numbering
 * rather than about the document. Split section 8 and renumber, and the boundary
 * resolves to a heading in the middle of the table: the slice ends hundreds of rows
 * early, every per-row gate below walks the surviving prefix, and both floors in
 * {@link mainTableRows} still read healthy because the truncated list is neither
 * empty nor unparseable. Nothing reports the rows that fell off the end.
 *
 * So the boundary is derived from what actually distinguishes the two halves: a
 * themed section advertises the prefix it collects, a register does not. The
 * ordering claim is what keeps that derivation from acquiring the same blind spot
 * — a themed heading that loses its `(CC-XXX)` suffix would otherwise read as a
 * register and truncate the table just as quietly.
 */
function catalog(): {
  lines: readonly string[];
  mainTableEnd: number;
  themed: readonly { number: number; index: number; prefix: string }[];
} {
  const lines = read(CATALOG).split('\n');
  const themed: { number: number; index: number; prefix: string }[] = [];
  const registers: number[] = [];
  const order: ('themed' | 'register')[] = [];

  lines.forEach((line, index) => {
    const numbered = NUMBERED_HEADING.exec(line);
    if (numbered?.[1] === undefined) return;
    const section = SECTION_PATTERN.exec(line);
    if (section?.[2] === undefined) {
      registers.push(index);
      order.push('register');
    } else {
      themed.push({ number: Number(numbered[1]), index, prefix: section[2] });
      order.push('themed');
    }
  });

  const mainTableEnd = registers[0] ?? -1;
  assert.notEqual(
    mainTableEnd,
    -1,
    `${CATALOG} has no unthemed numbered section, so nothing marks where the main table ` +
      'ends and the registers begin.',
  );
  assert.ok(
    themed.length >= 7,
    `${CATALOG} parsed to ${themed.length} themed sections. SECTION_PATTERN no longer ` +
      'recognises the headings, so the boundary above is the first heading it failed on.',
  );
  assert.deepEqual(
    order.slice(themed.length),
    order.slice(themed.length).map(() => 'register'),
    `${CATALOG} has a themed section after a register. Either a register grew a ` +
      '`(CC-XXX)` suffix or a themed heading lost one, and the boundary above then falls ' +
      'in the middle of the main table.',
  );
  return { lines, mainTableEnd, themed };
}

/** Rows of the main table, with their 1-based line numbers. */
function mainTableRows(): readonly { id: string; line: number; text: string }[] {
  const { lines, mainTableEnd } = catalog();
  const rows: { id: string; line: number; text: string }[] = [];
  const unparsed: string[] = [];
  lines.slice(0, mainTableEnd).forEach((text, index) => {
    const match = ROW_PATTERN.exec(text);
    if (match?.[1] !== undefined) rows.push({ id: match[1], line: index + 1, text });
    else if (text.startsWith('|') && !TABLE_FURNITURE.test(text)) {
      unparsed.push(`line ${index + 1}: ${text.slice(0, 60)}`);
    }
  });

  // Two floors, because this walk comes back empty in two different ways and every
  // caller below states a per-row claim that an empty walk satisfies for free. It
  // returns nothing at all if the first register heading is ever reordered above the
  // table, since the slice then ends before the rows begin. It returns a SHORT list,
  // silently dropping exactly the rows it stopped understanding, if the row format
  // drifts — an ID wrapped in bold, a new prefix shape, a cell that lost its ID.
  // The first floor is emptiness, which is the whole of that defect: this table only
  // grows, so any threshold above zero would be arbitrary. The second is completeness,
  // and it is the one a partial drift trips while the count still looks healthy.
  assert.ok(
    rows.length > 0,
    `${CATALOG} parsed to zero main-table rows. Every per-row assertion in this file then ` +
      'passes by walking nothing: the first register heading comes before the table rather ' +
      'than after it.',
  );
  assert.deepEqual(
    unparsed,
    [],
    `${CATALOG} has table lines before the first register that ROW_PATTERN does not ` +
      'recognise as rows. They are not being checked for duplicate IDs, column count or ' +
      'section placement, and nothing else would report them missing.',
  );
  return rows;
}

/** Every ID the catalogue defines or re-lists, which is what a citation may name. */
function knownIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const line of read(CATALOG).split('\n')) {
    const match = ROW_PATTERN.exec(line);
    if (match?.[1] !== undefined) ids.add(match[1]);
  }
  return ids;
}

test('every case ID cited anywhere in the repo resolves to a catalogue row', () => {
  const known = knownIds();
  assert.ok(known.size > 300, 'the catalogue should not have shrunk to a handful of rows');

  const dangling: string[] = [];
  let sites = 0;
  for (const path of citingFiles()) {
    read(path)
      .split('\n')
      .forEach((line, index) => {
        for (const id of line.match(ID_PATTERN) ?? []) {
          sites += 1;
          if (!known.has(id)) dangling.push(`${path}:${index + 1} cites ${id}`);
        }
      });
  }

  // A guard that scans nothing passes vacuously. Pin the corpus size too, so that a
  // walker which silently stops descending — a renamed directory, a new extension,
  // a `statSync` that starts throwing — fails here rather than reporting clean.
  assert.ok(sites > 400, `expected hundreds of citation sites, scanned ${sites}`);
  assert.deepEqual(dangling, [], 'a citation names a case the catalogue does not define');
});

test('no case ID is defined twice in the main table', () => {
  const seen = new Map<string, number>();
  const clashes: string[] = [];
  for (const row of mainTableRows()) {
    const first = seen.get(row.id);
    if (first === undefined) seen.set(row.id, row.line);
    else clashes.push(`${row.id} defined at line ${first} and again at line ${row.line}`);
  }
  assert.deepEqual(clashes, [], 'the IDs are the primary key; two rows cannot share one');
});

test('every wiki-link in the catalogue points at a row that exists', () => {
  const known = knownIds();
  const dangling: string[] = [];
  read(CATALOG)
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(WIKI_LINK_PATTERN)) {
        const id = match[1];
        if (id !== undefined && !known.has(id)) dangling.push(`line ${index + 1} links to ${id}`);
      }
    });
  assert.deepEqual(dangling, [], 'a cross-reference names a case that does not exist');
});

test('every main-table row carries four columns with its literal pipes escaped', () => {
  const broken: string[] = [];
  for (const row of mainTableRows()) {
    // Split on unescaped pipes only: a `\|` inside a code span is content, not a
    // cell boundary. A four-column row has a leading and a trailing empty part, so
    // a well-formed split has six.
    const parts = row.text.split(/(?<!\\)\|/);
    if (parts.length !== 6) {
      broken.push(`line ${row.line} (${row.id}) splits into ${parts.length} parts, expected 6`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    'an unescaped `|` inside a cell silently shifts every column after it',
  );
});

/**
 * The mirror of the claim above, and the one that says the boundary itself is in the
 * right place. Every gate in this file walks `mainTableRows()`, which stops at the
 * first register; a boundary that resolves too early therefore costs coverage without
 * costing a single assertion. What separates the two halves structurally is the column
 * count — the main table carries four columns, the registers three — so a
 * four-column row found below the boundary is a main-table row nothing above checked.
 */
test('no main-table row is left below the register boundary', () => {
  const { lines, mainTableEnd } = catalog();
  const orphans: string[] = [];
  let registerRows = 0;

  lines.slice(mainTableEnd).forEach((text, offset) => {
    const match = ROW_PATTERN.exec(text);
    if (match?.[1] === undefined) return;
    registerRows += 1;
    if (text.split(/(?<!\\)\|/).length === 6) {
      orphans.push(`line ${mainTableEnd + offset + 1}: ${match[1]}`);
    }
  });

  assert.ok(
    registerRows > 0,
    'the registers hold no rows at all, so this check would pass over an empty tail.',
  );
  assert.deepEqual(
    orphans,
    [],
    'a four-column row sits below the register boundary. Either the boundary resolved to a ' +
      'heading inside the main table, in which case every gate above walked a truncated ' +
      'table, or a main-table row was filed under a register.',
  );
});

test('themed sections hold only the prefix their heading advertises', () => {
  const { themed } = catalog();
  // The tail is the last themed section rather than a written-down 7: it collects
  // every prefix by design, so the themed claim is made about the sections that
  // still make it. Reading the rows through mainTableRows() rather than re-walking
  // the lines inherits its two floors, so a row format this test stopped parsing is
  // reported there instead of quietly shrinking the set inspected here.
  const tail = themed.reduce((highest, section) => Math.max(highest, section.number), 0);
  const misfiled: string[] = [];
  let inspected = 0;

  for (const row of mainTableRows()) {
    const section = themed.filter((heading) => heading.index < row.line - 1).at(-1);
    if (section === undefined || section.number === tail) continue;
    inspected += 1;
    const prefix = row.id.slice(0, row.id.lastIndexOf('-'));
    if (prefix !== section.prefix) {
      misfiled.push(`line ${row.line}: ${row.id} sits in §${section.number} (${section.prefix})`);
    }
  }

  assert.ok(
    inspected > 0,
    `every main-table row was attributed to §${tail} or to no section at all, so this ` +
      'test compared nothing. The headings above the rows are no longer being found.',
  );
  assert.deepEqual(
    misfiled,
    [],
    `append a new row to the end of §${tail}, not into a themed section`,
  );
});

test('every prefix is numbered without gaps', () => {
  const numbers = new Map<string, Set<number>>();
  for (const id of knownIds()) {
    const cut = id.lastIndexOf('-');
    const prefix = id.slice(0, cut);
    const set = numbers.get(prefix) ?? new Set<number>();
    set.add(Number(id.slice(cut + 1)));
    numbers.set(prefix, set);
  }

  const holes: string[] = [];
  for (const [prefix, set] of [...numbers].sort()) {
    const highest = Math.max(...set);
    for (let n = 1; n < highest; n += 1) {
      if (!set.has(n)) holes.push(`${prefix}-${n}`);
    }
  }
  assert.deepEqual(
    holes,
    [],
    'a deleted row leaves its citations dangling; mark it retired instead',
  );
});

/**
 * The preamble is the only part of the catalogue that describes the catalogue: where a
 * row lives, how many there are, and how much of the repo points at them. A reader who
 * wants any of the three reads that paragraph and stops, which is what makes a stale
 * figure there worse than no figure at all — it is not read as out of date, it is read
 * as the answer.
 *
 * Measured 2026-09-23, against a preamble nobody had recounted since writing it: the
 * tail section was stated at 94 rows of 334 when it held 258 of 373, and the citation
 * surface at 575 when it was 613. The paragraph was arguing for the layout with figures
 * from a catalogue two thirds this size, and the same stale 575 had been copied into
 * this file’s own docstring, twice.
 *
 * Every figure the paragraph states is derivable from the document and the tree, so
 * derive them here. Updating one sentence is the price of the paragraph staying true;
 * the alternative, measured above, is that it silently stops being about this file.
 */
test('the preamble states figures that are still true of the catalogue', () => {
  const { lines, themed } = catalog();
  const preamble = lines
    .slice(0, themed[0]?.index ?? 0)
    .join(' ')
    .replace(/\s+/g, ' ');

  const stated = PREAMBLE_SHAPE.exec(preamble) ?? [];
  assert.ok(
    stated.length > 0,
    `${CATALOG} no longer states where a row lives in the shape PREAMBLE_SHAPE reads, so ` +
      'not one of its figures is being checked. Restore the sentence or update the pattern.',
  );

  const rows = mainTableRows();
  const tail = themed.reduce((highest, section) => Math.max(highest, section.number), 0);
  const tailPrefix = themed.find((section) => section.number === tail)?.prefix;
  const inTail = rows.filter(
    (row) => themed.filter((heading) => heading.index < row.line - 1).at(-1)?.number === tail,
  );
  const counts = new Map<string, number>();
  for (const row of inTail) {
    const prefix = row.id.slice(0, row.id.lastIndexOf('-'));
    if (prefix !== tailPrefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const foreign = [...counts.values()].reduce((sum, count) => sum + count, 0);

  assert.equal(Number(stated[1]), tail, `the preamble sends a reader to §${stated[1]}`);
  assert.equal(stated[5], tailPrefix, `§${tail} advertises ${tailPrefix}, not ${stated[5]}`);
  assert.equal(inTail.length, Number(stated[2]), `§${tail} holds ${inTail.length} rows`);
  assert.equal(rows.length, Number(stated[3]), `the main table defines ${rows.length} rows`);
  assert.equal(foreign, Number(stated[4]), `§${tail} holds ${foreign} foreign-prefix rows`);
  assert.deepEqual(
    [...(stated[6] ?? '').matchAll(BREAKDOWN_ENTRY)].map((hit) => `${hit[2]}: ${hit[1]}`).sort(),
    [...counts].map(([prefix, count]) => `${prefix}: ${count}`).sort(),
    `the preamble’s per-prefix breakdown of §${tail} is not what the section holds`,
  );

  const claimed = PREAMBLE_SITES.exec(preamble) ?? [];
  assert.ok(
    claimed.length > 0,
    `${CATALOG} no longer states how many citation sites name it, so the figure this file ` +
      'calls its widest inbound surface is unchecked.',
  );
  let sites = 0;
  for (const path of citingFiles()) sites += (read(path).match(ID_PATTERN) ?? []).length;
  assert.equal(sites, Number(claimed[1]), `the repo names a case ${sites} times`);
});
