/**
 * Docs gate for the two design documents that carry machine-checkable numbers:
 * `docs/operations.md` and `docs/auth.md`.
 *
 * `docs-sync.test.ts` ties the README to `allTools`, `docs-user-guides.test.ts`
 * ties the operator guides to the env/tool/scope/flag surface, and
 * `env-catalog.test.ts` ties `.env.example` back to the source. None of them
 * reaches the design docs — and those are the ones that state the *contract*: the
 * error taxonomy the model branches on, the retry budget an operator sizes a rate
 * limit against, the version pinned into every URL, and the hosts the SSRF
 * allowlist admits. Each of those is a number or a name that already exists in the
 * code, so drift between them is mechanically detectable and nothing detected it.
 *
 * What each check buys, in the direction that actually hurts:
 *
 *   - **A taxonomy row that lies.** §3 tells the reader which `kind` a Graph code
 *     becomes; the model is documented as branching on `kind`. A row claiming
 *     `rate_limit` for a code the mapper calls `validation` sends a reader — human
 *     or model — into a backoff loop for an error that will never clear.
 *   - **A subcode listed on one side only.** A subcode in the table that
 *     `deriveKind` never special-cases reads as a handled case that is not; a
 *     subcode handled in code but absent from the table is an undocumented
 *     behaviour nobody can review.
 *   - **A retry budget that does not match the code.** "max 3 retries" and
 *     "capped 60 s" are what an operator uses to reason about worst-case latency
 *     and quota burn. They are private constants in `core/http.ts`; changing one
 *     changed nothing else in this repo.
 *   - **A stale version pin.** `GRAPH_VERSION` appears in ~30 places across the
 *     docs. A bump that updates the constant and half the prose leaves the other
 *     half telling operators to expect a version the server never sends.
 *   - **An undocumented host.** Every `graph.*.com` name in the docs is a host the
 *     reader will believe the server talks to. The allowlist is the security
 *     boundary; the docs must not describe a wider one, nor a narrower one.
 *
 * The `core/http.ts` constants are read out of the TypeScript source rather than
 * imported, because they are module-private: exporting them purely to be testable
 * would widen the HTTP client's surface for the benefit of one assertion. Same
 * technique, and same reasoning, as the source scans in `env-catalog.test.ts` and
 * `docs-user-guides.test.ts`.
 *
 * The test process runs from the repo root, so every path resolves from cwd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { mapGraphError } from '../src/core/errors.js';
import { GRAPH_VERSION, ALLOWED_HOSTS } from '../src/core/host.js';
import { DEFAULT_SETTINGS, loadSettings } from '../src/core/settings.js';

/**
 * Version-shaped tokens that are not the Graph API version, each with the reason
 * it is exempt. An explicit list rather than a blanket pattern: a genuinely stale
 * Graph pin must not be able to hide behind "well, some versions are not Graph".
 *
 * Dotless majors are in scope as of 2026-09-23 — see the scrape below for why —
 * so most of this list is them, and the test asserts that none of them is the
 * pinned version or its major.
 *
 * This package's own release tags are deliberately NOT here. Until 2026-09-23
 * `v0.7.0` was, hardcoded, and that entry was wrong in both directions at once: it
 * went stale the moment the version was bumped, and the documents that name a tag
 * do not all name the CURRENT one — `docs/roadmap.md` and `docs/workplan.md`
 * record the 2026-08-25 publication of `v0.7.0` as a dated fact, which stays true
 * however far the version moves. Deriving the entry from `package.json` would
 * therefore have started accusing those two records on the next bump. The tags are
 * read from `CHANGELOG.md` instead — see `releaseTags` below.
 */
const NON_GRAPH_VERSIONS: ReadonlyMap<string, string> = new Map([
  [
    'v0.9.9',
    'a tag this package has deliberately never shipped, named in `docs/corner-cases.md` ' +
      'CC-PROC-139 as the mutant that proves the CHANGELOG ledger check bites',
  ],
  ['v22.23.2', 'the Node runtime a measurement was taken on (CC-PROC-34)'],
  ['v1.2', 'a path segment in an example CDN URL (CC-PUB-24)'],
  ['v1.0', "the workplan document's own version"],
  ['v1', "this server's own first generation, and the MCP SDK major it builds on"],
  ['v2', 'the MCP SDK major this project deliberately does not use (beta, API churn)'],
  ['v3', 'the zod major the SDK pins'],
  ['v4', 'IPv4, in the phrases "v4-mapped form" and "the v4 address"'],
  [
    'v8',
    "the JavaScript engine, named inside `v8-to-istanbul` — the mapper c8's line and " +
      'branch attribution comes from (CC-PROC-128)',
  ],
  ['v10', "the c8 major whose config discovery the roadmap's coverage note describes"],
  ['v26', 'the NEXT Graph major, named only as a forward-looking upgrade note'],
]);

/**
 * Every version this package has actually released, as a `v`-prefixed tag, read
 * from the changelog's released sections. `## [Unreleased]` carries no digits and
 * so never enters the set, which is the point: a document naming a tag that has
 * not shipped is claiming a release that did not happen, and that is drift worth
 * failing on rather than exempting.
 *
 * `CHANGELOG.md` is not one of `allDocs()`, so this is not a self-comparison: the
 * ledger is one side of the pair and the governed documents are the other, and an
 * assertion still fails when either moves without the other.
 */
function releaseTags(): ReadonlySet<string> {
  const tags = new Set(
    [...read('CHANGELOG.md').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].flatMap((m) =>
      m[1] === undefined ? [] : [`v${m[1]}`],
    ),
  );
  assert.ok(
    tags.size > 0,
    'CHANGELOG.md no longer has a released version section this parser can read, so every ' +
      'release tag the docs name is about to be reported as a stale Graph pin',
  );
  return tags;
}

/** Status used to probe the mapper: a plain Graph 4xx, so no status rule fires. */
const NEUTRAL_STATUS = 400;

/**
 * The sentence that closes §2's retry budget. It is the document's own right
 * boundary for that statement: everything from "Backoff:" up to it is the budget
 * an operator sizes a rate limit against, and the prose after it explains *why*
 * and is free to be rewritten.
 */
const NO_AUTO_RETRY_RULE = '**No non-idempotent write is auto-retried';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Subtrees of `docs/` these gates deliberately do not govern, with the reason.
 *
 * `docs/reviews/` holds dated snapshots of what outside reviewers said on a
 * given day — every one of them opens with its own `**Date:**` line. Their worth
 * is as a record, so a guard that forced them to name today's pinned Graph
 * version would be rewriting the record to keep a test quiet:
 * `docs/reviews/platform-api-review.md` says the January 2025 metric purge
 * "landed v21/v22", which is a fact about v21 and v22 and stays true however far
 * the pin moves.
 */
const UNGOVERNED_DOC_TREES: ReadonlyMap<string, string> = new Map([
  ['reviews', 'dated external-review snapshots; each is a record of a day, not a live claim'],
]);

/**
 * Every markdown file these gates govern: the top level of `docs/`, plus the
 * README.
 *
 * The scope is a decision, not `readdirSync`'s default. Until 2026-09-23 this
 * said "every markdown file the project publishes", which was not true —
 * `docs/reviews/` is published too, and seven files sat outside every gate below
 * while the comment said they did not. The test after this one is what keeps the
 * two halves honest: it walks `docs/` in full and fails on any subtree that is
 * neither governed here nor named in `UNGOVERNED_DOC_TREES` with a reason.
 */
function allDocs(): readonly string[] {
  const docs = readdirSync('docs')
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`);
  return [...docs, 'README.md'].sort();
}

/**
 * Published pages that are not markdown.
 *
 * `docs/index.html` is the project's landing page — the document the most
 * people read and the fewest people edit. It states the pinned Graph version
 * four times and names the Graph hosts twelve times, in the same claiming voice
 * as the markdown, and until 2026-09-23 the `.md` filter above meant no gate in
 * this file had ever read a line of it. Measured that day: changing its `v25.0`
 * badge to `v24.0` passed all 1939 tests of this suite.
 */
const PUBLISHED_HTML: readonly string[] = ['docs/index.html'];

/**
 * Every page the two claim-gates below read: the markdown, plus the published
 * HTML. The gates ask what a document CLAIMS about the pin and the reachable
 * hosts, and a landing page claims it in exactly the way a markdown file does.
 */
function governedPages(): readonly string[] {
  return [...allDocs(), ...PUBLISHED_HTML].sort();
}

test('every markdown file under docs/ is either governed by these gates or excluded by name', () => {
  // A scope that is merely the shape of the scrape is a scope nobody chose. Move
  // a governed document into a new subdirectory — `docs/guides/setup-guide.md` —
  // and the non-recursive read above stops seeing it, every gate in this file
  // quietly stops covering it, and nothing anywhere says so. This is the one
  // assertion in the file that reads the directory rather than the documents, and
  // it exists so that leaving the governed set is a thing you have to do on
  // purpose.
  const everyDoc = readdirSync('docs', { recursive: true, encoding: 'utf8' }).filter((rel) =>
    rel.endsWith('.md'),
  );
  const governed = new Set(allDocs());

  const ungoverned = new Map<string, string[]>();
  for (const rel of everyDoc) {
    if (governed.has(`docs/${rel}`)) continue;
    const tree = rel.split(/[/\\]/)[0] ?? '';
    ungoverned.set(tree, [...(ungoverned.get(tree) ?? []), rel]);
  }

  for (const [tree, files] of ungoverned) {
    assert.ok(
      UNGOVERNED_DOC_TREES.has(tree),
      `docs/${tree}/ is outside every gate in this file (${files.length} file(s), e.g. ` +
        `docs/${files[0]}) and no reason is recorded. Either move the documents up to the top ` +
        'level of docs/, where they are governed, or add the subtree to UNGOVERNED_DOC_TREES ' +
        'with the reason it is exempt',
    );
  }

  for (const [tree, reason] of UNGOVERNED_DOC_TREES) {
    assert.ok(
      ungoverned.has(tree),
      `UNGOVERNED_DOC_TREES exempts docs/${tree}/ as ${reason}, and there is no such subtree ` +
        'holding markdown any more. A stale exemption is how a subtree silently re-enters or ' +
        'leaves scope later — drop the entry',
    );
  }

  // Positive control on the partition itself: an exemption list that matched the
  // whole of docs/ would satisfy both loops above and govern nothing.
  assert.ok(
    governed.size > UNGOVERNED_DOC_TREES.size,
    'the governed set has collapsed; the gates below would be reading almost nothing',
  );
});

test('every published HTML page is one the claim-gates in this file read', () => {
  // The same discipline the markdown partition above applies, on the other half
  // of what the site publishes. Without it, PUBLISHED_HTML is a hand list and a
  // second page — a `docs/pricing.html`, a generated `docs/api.html` — joins
  // the site stating whatever it likes about the pin and the hosts, governed by
  // nothing and announced by nothing.
  const published = readdirSync('docs', { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.html'))
    .map((rel) => `docs/${rel}`)
    .sort();
  assert.deepEqual(
    published,
    [...PUBLISHED_HTML].sort(),
    'docs/ publishes an HTML page that the version and host gates below do not read. Add it to ' +
      'PUBLISHED_HTML, or stop publishing it — a page on the site is a claim the project makes.',
  );
});

/**
 * The body of a numbered section, located by its heading text rather than its
 * number: renumbering the document must not silently empty a guard.
 */
function section(path: string, headingText: string): string {
  const doc = read(path);
  const heading = new RegExp(`^## .*${headingText}.*$`, 'm').exec(doc);
  assert.notEqual(heading, null, `${path} no longer has a section matching "${headingText}"`);
  const rest = doc.slice((heading?.index ?? 0) + (heading?.[0].length ?? 0));
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The text of a section between two markers, with soft wraps collapsed to single
 * spaces. Collapsing first lets a guard survive a legitimate re-wrap of the
 * document; the two markers give the span a left *and* a right boundary, which
 * is exactly what a containment match lacks — it proves a phrase is present
 * somewhere and says nothing about the clauses added around it.
 */
function spanBetween(body: string, from: string, to: string, where: string): string {
  const prose = body.replace(/\s+/g, ' ');
  const start = prose.indexOf(from);
  assert.notEqual(start, -1, `${where} no longer contains "${from}"`);
  const stop = prose.indexOf(to, start + from.length);
  assert.notEqual(stop, -1, `${where} no longer contains "${to}" after "${from}"`);
  return prose.slice(start, stop).trim();
}

/** Split a markdown table row into its cells, ignoring escaped pipes. */
function cellsOf(row: string): string[] {
  return row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());
}

/** The data rows of the first markdown table in `body`. */
function tableRows(body: string): string[][] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[\s:|-]+\|$/.test(line))
    .map(cellsOf)
    .slice(1);
}

interface TaxonomyRow {
  readonly codes: readonly number[];
  readonly subcodes: readonly number[];
  readonly kind: string | undefined;
  readonly raw: string;
}

/** Parse §3's `code | meaning | mapping` table into codes, subcodes and kind. */
function taxonomyRows(): readonly TaxonomyRow[] {
  const rows: TaxonomyRow[] = [];
  for (const cells of tableRows(section('docs/operations.md', 'Error taxonomy'))) {
    const first = cells[0];
    const mapping = cells[2];
    if (first === undefined || mapping === undefined) continue;

    const subcodes: number[] = [];
    const codes: number[] = [];
    let rest = first.replace(/subcode\s+(\d+)/g, (_m, d: string) => {
      subcodes.push(Number(d));
      return ' ';
    });
    // "500-class" names an HTTP band, not a Graph error code.
    rest = rest.replace(/\d+-class/g, ' ');
    // An en-dashed range contributes both endpoints.
    rest = rest.replace(/(\d+)\s*[–-]\s*(\d+)/g, (_m, a: string, b: string) => {
      codes.push(Number(a), Number(b));
      return ' ';
    });
    for (const m of rest.matchAll(/\d+/g)) codes.push(Number(m[0]));

    rows.push({
      codes,
      subcodes,
      kind: /`kind: ([a-z_]+)`/.exec(mapping)?.[1],
      raw: first,
    });
  }
  assert.ok(rows.length > 0, 'the error-taxonomy table in docs/operations.md parsed to no rows');
  return rows;
}

/** A named `const NAME = <number>;` read out of a TypeScript source file. */
function numericConst(path: string, name: string): number {
  const found = new RegExp(`const ${name} = ([0-9_]+)`).exec(read(path));
  assert.notEqual(found, null, `${path} no longer declares ${name}`);
  return Number((found?.[1] ?? '').replace(/_/g, ''));
}

/**
 * Every plain Graph code `deriveKind` decides on, read off the ladder rather than
 * listed here. The subcode `switch` above it is the next test's business; these are
 * the `code === n` rungs and the one band, which is what §3's `code` column names.
 */
function ladderCodes(): number[] {
  const src = read('src/core/errors.ts');
  const singles = [...src.matchAll(/code === (\d+)/g)].flatMap((m) =>
    m[1] === undefined ? [] : [Number(m[1])],
  );
  const bands = [...src.matchAll(/code >= (\d+) && code <= (\d+)/g)].flatMap((m) =>
    m[1] === undefined || m[2] === undefined ? [] : [Number(m[1]), Number(m[2])],
  );
  const codes = [...new Set([...singles, ...bands])].sort((a, b) => a - b);
  assert.ok(codes.length > 0, 'no `code === n` rungs could be parsed out of src/core/errors.ts');
  return codes;
}

test('every taxonomy row maps its codes to the kind the mapper really returns', () => {
  const rows = taxonomyRows();

  // The `continue` below is a row's exemption from this test, so the rows that take
  // it are named rather than counted. A subcode row earns it honestly: its mapping
  // column describes an action, and the subcode test that follows is what holds it.
  // A row that merely lost the backticks around `kind: x` looks identical to the
  // loop, and would sit outside every assertion in this file while §3 went on
  // stating a mapping for it.
  const unexplained = rows.filter((row) => row.kind === undefined && row.subcodes.length === 0);
  assert.deepEqual(
    unexplained.map((row) => row.raw),
    [],
    'a docs/operations.md §3 row names a plain Graph code but no `kind: x`, so the loop below ' +
      'walks past it. Either restore the mapping or move the row under a subcode deriveKind ' +
      'special-cases.',
  );

  const checked: number[] = [];
  for (const row of rows) {
    if (row.kind === undefined) continue;
    for (const code of row.codes) {
      const actual = mapGraphError(NEUTRAL_STATUS, { error: { code } }).kind;
      assert.equal(
        actual,
        row.kind,
        `docs/operations.md §3 says code ${code} ("${row.raw}") is kind "${row.kind}", ` +
          `but mapGraphError returns "${actual}"`,
      );
      checked.push(code);
    }
  }

  // What the loop covered, against the ladder itself rather than against a floor. A
  // floor leaves slack, and slack is where a row that stopped being read hides: the
  // count was 13 against a floor of 10, so three rows could go quiet before anything
  // said so. The codes a subcode row carries are subtracted because that row carries
  // its own reason for having no kind; every other rung must have been walked above,
  // and nothing that is not a rung may have been.
  const bySubcode = new Set(rows.filter((r) => r.subcodes.length > 0).flatMap((r) => r.codes));
  assert.deepEqual(
    [...new Set(checked)].sort((a, b) => a - b),
    ladderCodes().filter((code) => !bySubcode.has(code)),
    'the codes walked above are not the codes deriveKind decides on. A rung §3 does not name ' +
      'is a classification no operator can look up; a §3 entry no rung answers to is a promise ' +
      'about a code that in fact falls through to the default.',
  );
});

test('the taxonomy table and deriveKind agree on which subcodes are special-cased', () => {
  const documented = new Set(taxonomyRows().flatMap((r) => r.subcodes));
  const implemented = new Set(
    [...read('src/core/errors.ts').matchAll(/^\s*case (\d{6,}):/gm)].flatMap((m) =>
      m[1] === undefined ? [] : [Number(m[1])],
    ),
  );
  assert.ok(implemented.size > 0, 'no subcode cases could be parsed out of src/core/errors.ts');
  assert.deepEqual(
    [...documented].sort((a, b) => a - b),
    [...implemented].sort((a, b) => a - b),
    'docs/operations.md §3 lists different Graph subcodes than deriveKind special-cases',
  );
});

test('the kind discriminant documented in §3 is exactly the ErrorKind union', () => {
  const prose = section('docs/operations.md', 'Error taxonomy');
  const listed = /`((?:[a-z_]+ \| )+[a-z_]+)`/.exec(prose)?.[1];
  assert.notEqual(listed, undefined, 'docs/operations.md §3 no longer spells out the kind union');

  const union = /export type ErrorKind = ([^;]+);/.exec(read('src/core/types.ts'))?.[1];
  assert.notEqual(union, undefined, 'src/core/types.ts no longer declares ErrorKind');
  const members = [...(union ?? '').matchAll(/'([a-z_]+)'/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );

  assert.deepEqual(
    (listed ?? '').split(' | '),
    members,
    'docs/operations.md §3 and the ErrorKind union list different kinds (or a different order)',
  );
});

test('§2 states the retry budget core/http.ts actually implements', () => {
  const body = section('docs/operations.md', 'Retry / backoff matrix');
  const base = numericConst('src/core/http.ts', 'BACKOFF_BASE_MS');
  const cap = numericConst('src/core/http.ts', 'BACKOFF_CAP_MS');
  const retryAfterCap = numericConst('src/core/http.ts', 'RETRY_AFTER_CAP_MS');
  const attempts = numericConst('src/core/http.ts', 'MAX_ATTEMPTS');

  // All four numbers live in one sentence, and each used to be matched on its
  // own, anywhere in the section. A containment match cannot see what is written
  // *around* the number it pins: "capped 60 s, though only on the first attempt"
  // and an extra sentence promising a POST retry the client never performs both
  // left every pinned phrase byte-for-byte intact. Pin the budget statement
  // whole instead — from "Backoff:" to the bolded rule that closes it — so a
  // clause inserted into it, or appended after it, has to change this string.
  // MAX_ATTEMPTS counts the first try; the doc counts the retries after it.
  assert.equal(
    spanBetween(body, 'Backoff:', NO_AUTO_RETRY_RULE, 'docs/operations.md §2'),
    `Backoff: \`min(${base}·2^n, ${cap}) ms + jitter\`, max ${attempts - 1} retries; ` +
      `\`Retry-After\` honored, capped ${retryAfterCap / 1000} s. ` +
      `Per-host concurrency semaphore (default ${DEFAULT_SETTINGS.maxConcurrent}).`,
    'docs/operations.md §2 no longer states exactly the retry budget core/http.ts implements ' +
      `(MAX_ATTEMPTS = ${attempts}, BACKOFF_BASE_MS = ${base}, BACKOFF_CAP_MS = ${cap}, ` +
      `RETRY_AFTER_CAP_MS = ${retryAfterCap})`,
  );
});

test('§4 states the item cap DEFAULT_SETTINGS actually applies', () => {
  // Same reasoning as §2. The old match pinned "`IG_MAX_ITEMS`, default 200" and
  // nothing on either side of it, so a qualifier appended inside the same
  // parenthetical — ", and ignored whenever `after` is supplied" — redefined the
  // cap an operator sizes a run against without touching a pinned byte. The
  // page size used to read "server default 25", which the server never applied:
  // no list tool gives `limit` a default and none forwards one it was not handed,
  // so the 25 was Graph's choice, not ours (CC-CFG-45). The no-default half is
  // derived from the tool sources below rather than taken on trust.
  const listTools = ['media', 'comments', 'discovery'].map((name) => ({
    name,
    body: read(`src/tools/${name}.ts`),
  }));
  let limitInputs = 0;
  for (const { name, body } of listTools) {
    for (const match of body.matchAll(/\blimit: z\n([\s\S]*?)\.describe\(/g)) {
      limitInputs += 1;
      assert.doesNotMatch(
        match[1] ?? '',
        /\.default\(/,
        `src/tools/${name}.ts gives \`limit\` a default, so docs/operations.md §4 no longer holds`,
      );
    }
    assert.doesNotMatch(
      body,
      /limit: args\.limit \?\?/,
      `src/tools/${name}.ts substitutes a page size for an omitted limit`,
    );
  }
  assert.equal(limitInputs, 4, 'the four list tools each take a `limit` input');
  assert.equal(
    spanBetween(
      section('docs/operations.md', 'Pagination'),
      'list tools take',
      'A read returns',
      'docs/operations.md §4',
    ),
    'list tools take `after?` + `limit?` (no default: an omitted `limit` is not ' +
      'forwarded, so Instagram picks the page size; hard cap `IG_MAX_ITEMS`, default ' +
      `${DEFAULT_SETTINGS.maxItems} with \`fetchAll: true\`).`,
    'docs/operations.md §4 no longer states exactly the pagination budget the server applies',
  );
});

test('the publishing design note promises only the pre-flight `api/media-spec` performs', () => {
  // `src/api/media-spec.ts` names this document as its own source of truth, and
  // the document used to answer with a list of checks the module does not
  // contain: “image spec (JPEG only … PNG is rejected; ≤ 8 MB, aspect 0.8–1.91),
  // reels spec (3 s–15 min, ≤ 300 MB), stories video (≤ 60 s, ≤ 100 MB) enforced
  // client-side with zod before any quota is spent”. None of it was true: the
  // module exports no byte, aspect or duration constant at all,
  // `imageUrlFormatWarning` returns a STRING and never throws, so a PNG is
  // warned about and published, and even the caption limits are an imperative
  // `InstagramError` rather than zod (CC-PROC-173). The stamp on the end made it
  // worse — the NUMBERS are indeed verified against Meta, so the stamp read as
  // certifying the enforcement claim beside them.
  //
  // Pinned with both boundaries and derived from the constants, so the clause
  // cannot regrow a qualifier and cannot drift from the limits it quotes.
  const spec = 'src/api/media-spec.ts';
  assert.equal(
    spanBetween(
      section('docs/tools.md', 'Package `publishing`'),
      'Caption limits',
      "Meta's own limits",
      'the docs/tools.md media-hosting design note',
    ),
    `Caption limits (${numericConst(spec, 'MAX_CAPTION_CODEPOINTS')} code points, ` +
      `${numericConst(spec, 'MAX_HASHTAGS')} hashtags, ${numericConst(spec, 'MAX_MENTIONS')} @tags), ` +
      `carousel bounds (${numericConst(spec, 'CAROUSEL_MIN')}–${numericConst(spec, 'CAROUSEL_MAX')} ` +
      'children) and well-formed `https://` URLs are refused before the call is made. Pixel format, ' +
      'byte size, aspect ratio and duration are NOT checked here — the server never fetches a media ' +
      'URL, so it never sees the bytes; a clearly non-JPEG extension only warns, and the container is ' +
      'created anyway. Meta rejects the rest at fetch time, which costs a publishing slot.',
    'docs/tools.md claims a client-side pre-flight src/api/media-spec.ts does not perform',
  );

  // The span above has a right boundary, so a qualifier cannot regrow INSIDE it.
  // The rest of the section is guarded by vocabulary instead. The whole failure
  // was a client-side-enforcement verb sitting next to Meta's numbers, where the
  // `[verified against official docs]` stamp read as certifying it: the numbers
  // are Meta's and are verified, the enforcement was never ours to claim beside
  // them. Nowhere in this section is there anything left for these three words to
  // describe truthfully, so the whole section is the right scope — a narrower one
  // just moves the sentence a line down.
  const publishing = section('docs/tools.md', 'Package `publishing`').replace(/\s+/g, ' ');
  for (const claim of [/\benforc/i, /client-side/i, /\bzod\b/i]) {
    assert.equal(
      claim.test(publishing),
      false,
      `${String(claim)} reappeared in the publishing section: what Meta refuses at fetch ` +
        'time is not what this server checks before the call',
    );
  }

  // The same fact is stated a second time, to a reader who has already hit the
  // failure, and the two statements must name the same three checks. This is the
  // half that was right all along: it is the pin that stops the honest one
  // drifting back towards the confident one.
  assert.match(
    read('docs/troubleshooting.md').replace(/\s+/g, ' '),
    /the server checks only what is structurally visible \(caption length, carousel bounds, well-formed `https:\/\/`\), because it never sees the bytes/,
    'docs/troubleshooting.md no longer names the same three structurally-checkable things',
  );
});

test('§3 states the HTTP-transport bind and token rules the product really applies', () => {
  // `docs/security.md` §3 is where an operator plans a deployment, and until
  // 2026-09-23 both of its transport refusal rules were false — each in the
  // direction that costs the operator something. Nothing had ever read the file:
  // every `docs/security.md` hit in `test/` was a comment in another suite citing
  // a section number (CC-PROC-175).
  const body = section('docs/security.md', 'Network policy');

  // Half one, tied to the layer that actually decides. The document used to say a
  // non-loopback bind "*with* a token starts". It does not and cannot: this check
  // runs before the transport is built and never reads the token, so the operator
  // who follows that sentence gets a refusal from a different layer pointing at a
  // different remedy.
  assert.throws(
    () => loadSettings({ IG_HTTP_HOST: '0.0.0.0', IG_HTTP_TOKEN: 'a-long-enough-bearer' }),
    /IG_HTTP_HOST must be one of the loopback spellings/,
    'a bearer must not buy a non-loopback bind, or docs/security.md §3 has to say so again',
  );

  // Half two has no function to call — it is entry-point wiring — and its code
  // side is pinned by `a blank IG_HTTP_TOKEN is treated as no authentication, and
  // said so out loud` in test/index.test.ts, which starts the real process and
  // serves an anonymous request with 200. What was missing is the document side.
  //
  // Both bullets are pinned whole, by equality, because "refused" and "starts" are
  // one word apart: a containment match proves a phrase is somewhere in the
  // section and says nothing about the clause written next to it.
  assert.equal(
    spanBetween(
      body,
      '- **A non-loopback bind',
      '- **The bearer check runs',
      'docs/security.md §3',
    ),
    '- **A non-loopback bind is refused outright, token or not** — the process does ' +
      'not start, and no `IG_HTTP_TOKEN` changes that. `IG_HTTP_HOST` accepts only ' +
      'the loopback spellings (`127.0.0.0/8`, `localhost`, `::1`, `[::1]`); the check ' +
      'lives in `core/settings.ts`, runs before the transport is built, and never ' +
      "reads the token. Binding `0.0.0.0` publishes the operator's Instagram account " +
      'to the network segment, and a shared secret is not a substitute for not doing ' +
      'it — to expose the transport, put an authenticating reverse proxy in front of ' +
      'a loopback bind. `startHttp` carries a second, looser guard that would allow a ' +
      'non-loopback bind once a bearer is set; it is defence in depth for a direct ' +
      'caller of that function, and no `IG_HTTP_HOST` an operator can set reaches it. ' +
      '- **A blank token counts as no token, out loud** — it neither authenticates ' +
      'nor refuses. `IG_HTTP_TOKEN=` and `IG_HTTP_TOKEN=" "` are what an operator ' +
      'gets from an unset shell variable or an empty line in a unit file, and ' +
      'treating either as "a token is configured" would authenticate every caller ' +
      'while reporting that it is protected. The entry point trims the value and ' +
      'drops it, so the server starts with the same **error**-level no-authentication ' +
      'line an unset token produces, and serves anonymous requests. `startHttp` would ' +
      'refuse a blank token outright if one ever reached it; none does, so that log ' +
      'line is the whole signal — a blank token is the one spelling that looks ' +
      'configured and is not.',
    'docs/security.md §3 no longer states the bind and blank-token rules the product applies',
  );
});

test('every Graph API version named in the docs is the pinned one', () => {
  // The scrape is deliberately wider than `vN.N`. Until 2026-09-23 it required a
  // dot — `/\bv\d+(?:\.\d+)+/` — so a bare major was invisible to it, and three
  // were in the docs already: `v25` and `v26` in `docs/operations.md` §6 and `v26`
  // again in `docs/stability.md`. That is the spelling a stale pin is most likely
  // to wear, because prose about an API GENERATION drops the `.0` a URL carries.
  // The pin's own major counts as the pin; every other token needs a named reason.
  const graphMajor = GRAPH_VERSION.replace(/\..*$/, '');
  for (const [token, reason] of NON_GRAPH_VERSIONS) {
    assert.ok(
      token !== GRAPH_VERSION && token !== graphMajor,
      `NON_GRAPH_VERSIONS exempts "${token}" as ${reason}, but that is the pinned Graph ` +
        'version — an exemption on the pin hides every stale sibling of it',
    );
  }
  const released = releaseTags();
  const stale: string[] = [];
  const used = new Set<string>();
  for (const path of governedPages()) {
    for (const m of read(path).matchAll(/\bv\d+(?:\.\d+)*\b/g)) {
      const token = m[0];
      if (token === GRAPH_VERSION || token === graphMajor) continue;
      if (released.has(token)) continue;
      if (NON_GRAPH_VERSIONS.has(token)) {
        used.add(token);
        continue;
      }
      stale.push(`${path}: ${token}`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `these version tokens are neither the pinned Graph version (${GRAPH_VERSION}), a release ` +
      'tag CHANGELOG.md records, nor a known non-Graph version — bump the prose with the ' +
      'constant, or add the token to NON_GRAPH_VERSIONS with a reason',
  );

  // The other direction, added 2026-09-23. Until then the list was only ever
  // checked against the pin, so an entry whose document stopped naming it stayed
  // here indefinitely, exempting a token nobody had decided to exempt any more.
  // Requiring every entry to still match something also puts a tripwire under
  // `allDocs()` itself: if the scrape above ever stopped reading the documents,
  // `stale` would be empty and pass, and this is the assertion that would not.
  assert.deepEqual(
    [...NON_GRAPH_VERSIONS.keys()].filter((token) => !used.has(token)),
    [],
    'these NON_GRAPH_VERSIONS entries no longer match anything in the governed docs. Drop the ' +
      'entry, or find out why the document that motivated it stopped naming the token — a ' +
      'stale exemption is indistinguishable from a deliberate one',
  );
});

test('the docs name only Graph hosts the SSRF allowlist admits, and name them all', () => {
  // Multi-label, because Meta's own Graph family is: `graph.video.facebook.com` is
  // a real upload host, and a single-label pattern (`graph.[a-z0-9-]+\.com`, this
  // test until 2026-09-23) cannot match it — so the one Graph host a doc is most
  // likely to name WITHOUT the allowlist admitting it was the one host this guard
  // could not see. Hosts outside the `graph.` family stay out of scope on purpose:
  // `docs/architecture.md` §5 names `rupload.facebook.com` as the host that joins
  // the allowlist only if a resumable-upload phase ships, and a guard that failed
  // on a documented roadmap item would be pushing the doc to stay silent about it.
  const allowed = new Set<string>(ALLOWED_HOSTS);
  for (const path of governedPages()) {
    for (const m of read(path).matchAll(/graph\.(?:[a-z0-9-]+\.)+com/g)) {
      const host = m[0];
      assert.ok(
        allowed.has(host),
        `${path} names the Graph host "${host}", which is not on ALLOWED_HOSTS — the docs must ` +
          'not describe a wider reachable surface than the allowlist permits',
      );
    }
  }
  const authDoc = read('docs/auth.md');
  for (const host of allowed) {
    assert.ok(
      authDoc.includes(host),
      `docs/auth.md never names the allowlisted host "${host}" — an operator reading the auth ` +
        'document would not know the server talks to it',
    );
  }
});
