/**
 * Path-injection regression tests for the whole api layer.
 *
 * `core/host.ts` builds every Graph URL as `https://<host>/v25.0<path>` by plain
 * string concatenation — deliberately, because a caller legitimately composes
 * multi-segment paths there. That makes each api function responsible for
 * encoding the ids IT interpolates, and until this file existed nothing proved
 * they did. An id is a model-supplied value, so the three failures below were
 * reachable from a tool call:
 *
 *   1. `#` in an id truncates the URL at the fragment. The whole query string —
 *      `access_token` included — becomes a fragment and the request goes out
 *      UNAUTHENTICATED.
 *   2. `?` or `&` in an id injects caller-chosen query parameters AHEAD of the
 *      auth parameters `core/http.ts` merges in.
 *   3. `../` in an id lets URL normalisation collapse `/v25.0/../me` to `/me`,
 *      silently dropping the pinned Graph API version.
 *
 * These tests assert on the URL the TRANSPORT actually received, parsed with the
 * same WHATWG parser `fetch` uses — not on a string this file assembled. A test
 * that re-implements the builder would keep passing while the real URL rotted.
 *
 * The sweep is only as good as its inventory, so the inventory is enforced
 * rather than asserted in prose (CC-PROC-15): the last test in this file scans
 * the `src/api/*.ts` sources and fails unless every function that builds a path
 * from anything but a literal has an entry in {@link PATH_CALLS}. A new api
 * function with an id in its path therefore cannot be added without being swept.
 *
 * Fully hermetic: the request seam is a real `createIgRequest` over an injected
 * `fetchImpl`, its own semaphore registry and a non-sleeping clock, so no socket
 * is opened and no shared process state is touched. The drift test reads source
 * files from disk and opens nothing else.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthProvider, IgRequestFn, Logger, Settings } from '../../src/core/types.js';
import type { Clock } from '../../src/core/clock.js';
import { DEFAULT_SETTINGS } from '../../src/core/settings.js';
import { createIgRequest, createSemaphoreRegistry } from '../../src/core/http.js';
import { getAccount } from '../../src/api/account.js';
import {
  createComment,
  deleteComment,
  getComment,
  listComments,
  listTaggedMedia,
  replyToComment,
  setCommentHidden,
  setCommentsEnabled,
} from '../../src/api/comments.js';
import { getMedia, getMediaChildren, listMedia } from '../../src/api/media.js';
import {
  getAccountInsights,
  getAudienceDemographics,
  getMediaInsights,
  getOnlineFollowers,
} from '../../src/api/insights.js';
import {
  createMediaContainer,
  getContainerStatus,
  getPublishingLimit,
  publishMedia,
} from '../../src/api/publishing.js';
import { discoverBusiness, getHashtagMedia } from '../../src/api/discovery.js';

/**
 * Nothing in this file may reach the network. Every request runs through an
 * injected `fetchImpl`, so a call to the global is a bug in the test, not a slow
 * test — fail it loudly and put the real implementation back afterwards.
 */
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = () => {
  throw new Error('path-injection tests must not open a socket — fetchImpl is injected');
};
after(() => {
  globalThis.fetch = realFetch;
});

// --- Harness ----------------------------------------------------------------

const auth: AuthProvider = {
  path: 'ig-login',
  defaultHost: 'graph.instagram.com',
  authParams: () => Promise.resolve({ access_token: 'IG_TOKEN' }),
};

const clock: Clock = { now: () => 0, sleep: () => Promise.resolve() };

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

const settings: Settings = { ...DEFAULT_SETTINGS };

/**
 * A real request seam over a recording transport. `body` is whatever Graph
 * should answer; every api function under test only needs a well-formed shell.
 */
function harness(body: unknown = { id: '1', data: [] }): { req: IgRequestFn; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: unknown) => {
    urls.push(typeof input === 'string' ? input : String(input));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;

  const req = createIgRequest({
    auth,
    settings,
    clock,
    log: silent,
    fetchImpl,
    semaphores: createSemaphoreRegistry(),
  });
  return { req, urls };
}

/** The single URL the transport saw, parsed exactly as `fetch` would parse it. */
function soleUrl(urls: string[]): URL {
  assert.equal(urls.length, 1, 'exactly one request reached the transport');
  return new URL(urls[0]!);
}

/**
 * One entry per api function that interpolates a value into its request path,
 * each reduced to `(req, id) => Promise<unknown>` so the three injection cases
 * below sweep the whole layer instead of spot-checking one module.
 *
 * `source` is the `<file>:<function>` this entry stands for, and it is not
 * decoration: the drift test at the bottom of this file scans `src/api/*.ts` and
 * fails unless this set is exactly the set of functions that build a path from
 * something other than a literal. Adding an api function without adding it here
 * — the way this coverage would otherwise rot — is a test failure, not a silent
 * gap.
 *
 * `id` is always routed to the value that lands in the PATH. Where a function
 * also takes ids that only ever reach the query string (`getHashtagMedia`'s
 * `igId`, `publishMedia`'s `creationId`), those are given benign fixed values:
 * `core/host.ts` encodes the query itself, so they are not what this file is
 * about.
 */
const PATH_CALLS: {
  source: string;
  label: string;
  call: (req: IgRequestFn, id: string) => Promise<unknown>;
}[] = [
  {
    source: 'account.ts:getAccount',
    label: 'getAccount(igId)',
    call: (req, id) => getAccount(req, { igId: id }),
  },
  {
    source: 'comments.ts:listComments',
    label: 'listComments(mediaId)',
    call: (req, id) => listComments(req, { mediaId: id, maxItems: 10 }),
  },
  {
    source: 'comments.ts:getComment',
    label: 'getComment(commentId)',
    call: (req, id) => getComment(req, { commentId: id }),
  },
  {
    source: 'comments.ts:listTaggedMedia',
    label: 'listTaggedMedia(igId)',
    call: (req, id) => listTaggedMedia(req, { igId: id, maxItems: 10 }),
  },
  {
    source: 'comments.ts:replyToComment',
    label: 'replyToComment(commentId)',
    call: (req, id) => replyToComment(req, { commentId: id, message: 'hello' }),
  },
  {
    source: 'comments.ts:createComment',
    label: 'createComment(mediaId)',
    call: (req, id) => createComment(req, { mediaId: id, message: 'hello' }),
  },
  {
    source: 'comments.ts:setCommentHidden',
    label: 'setCommentHidden(commentId)',
    call: (req, id) => setCommentHidden(req, { commentId: id, hide: true }),
  },
  {
    source: 'comments.ts:deleteComment',
    label: 'deleteComment(commentId)',
    call: (req, id) => deleteComment(req, { commentId: id }),
  },
  {
    source: 'comments.ts:setCommentsEnabled',
    label: 'setCommentsEnabled(mediaId)',
    call: (req, id) => setCommentsEnabled(req, { mediaId: id, enabled: false }),
  },
  {
    source: 'discovery.ts:getHashtagMedia',
    label: 'getHashtagMedia(hashtagId)',
    call: (req, id) =>
      getHashtagMedia(req, { hashtagId: id, igId: '17841400000000001', edge: 'top', maxItems: 10 }),
  },
  {
    source: 'discovery.ts:discoverBusiness',
    label: 'discoverBusiness(igId)',
    call: (req, id) => discoverBusiness(req, { igId: id, username: 'natgeo', mediaLimit: 5 }),
  },
  {
    source: 'insights.ts:getAccountInsights',
    label: 'getAccountInsights(accountId)',
    call: (req, id) => getAccountInsights(req, { accountId: id }),
  },
  {
    source: 'insights.ts:getMediaInsights',
    label: 'getMediaInsights(mediaId)',
    call: (req, id) => getMediaInsights(req, { mediaId: id, metrics: ['views'] }),
  },
  {
    source: 'insights.ts:getAudienceDemographics',
    label: 'getAudienceDemographics(accountId)',
    call: (req, id) =>
      getAudienceDemographics(req, { accountId: id, breakdown: 'age', timeframe: 'this_week' }),
  },
  {
    source: 'insights.ts:getOnlineFollowers',
    label: 'getOnlineFollowers(accountId)',
    call: (req, id) => getOnlineFollowers(req, { accountId: id }),
  },
  {
    source: 'media.ts:listMedia',
    label: 'listMedia(igAccountId)',
    call: (req, id) => listMedia(req, { igAccountId: id, maxItems: 10 }),
  },
  {
    source: 'media.ts:getMedia',
    label: 'getMedia(mediaId)',
    call: (req, id) => getMedia(req, { mediaId: id }),
  },
  {
    source: 'media.ts:getMediaChildren',
    label: 'getMediaChildren(mediaId)',
    call: (req, id) => getMediaChildren(req, { mediaId: id }),
  },
  {
    source: 'publishing.ts:createMediaContainer',
    label: 'createMediaContainer(igId)',
    call: (req, id) =>
      createMediaContainer(req, { igId: id, imageUrl: 'https://example.invalid/a.jpg' }),
  },
  {
    source: 'publishing.ts:getContainerStatus',
    label: 'getContainerStatus(containerId)',
    call: (req, id) => getContainerStatus(req, { containerId: id }),
  },
  {
    source: 'publishing.ts:publishMedia',
    label: 'publishMedia(igId)',
    call: (req, id) => publishMedia(req, { igId: id, creationId: '17999000000000001' }),
  },
  {
    source: 'publishing.ts:getPublishingLimit',
    label: 'getPublishingLimit(igId)',
    call: (req, id) => getPublishingLimit(req, { igId: id }),
  },
];

// --- Consequence 1: the token must not fall into a fragment -----------------

test('an id containing "#" leaves access_token in the query, never in a fragment', async () => {
  // Pre-fix this produced `.../v25.0/X#/comments?fields=...&access_token=...`:
  // everything from the `#` on is a fragment, which fetch does NOT send. The
  // call left the process without credentials and came back as a 400 nobody
  // could explain.
  for (const { label, call } of PATH_CALLS) {
    const { req, urls } = harness();
    await call(req, 'X#injected');
    const url = soleUrl(urls);
    assert.equal(url.hash, '', `${label}: the URL carries no fragment at all`);
    assert.equal(
      url.searchParams.get('access_token'),
      'IG_TOKEN',
      `${label}: the token is still a real query parameter`,
    );
    assert.equal(url.pathname.includes('#'), false, `${label}: the "#" is encoded, not structural`);
  }
});

// --- Consequence 2: no smuggled query parameters ---------------------------

test('an id containing "?" or "&" cannot introduce a query parameter', async () => {
  // `?`/`&` in an id opened the query string early, so the injected pairs landed
  // BEFORE the auth params `core/http.ts` appends — first-wins parsers on the
  // far side would then read the attacker's value.
  for (const hostile of ['X?access_token=STOLEN', 'X&fields=id&limit=999', 'X?a=1&b=2']) {
    for (const { label, call } of PATH_CALLS) {
      const { req, urls } = harness();
      await call(req, hostile);
      const url = soleUrl(urls);
      const keys = [...url.searchParams.keys()];
      for (const smuggled of ['a', 'b', 'limit']) {
        assert.equal(
          keys.includes(smuggled),
          false,
          `${label} / ${hostile}: no "${smuggled}" parameter appeared`,
        );
      }
      assert.equal(
        url.searchParams.getAll('access_token').join(','),
        'IG_TOKEN',
        `${label} / ${hostile}: exactly one access_token, and it is ours`,
      );
      assert.equal(
        url.searchParams.get('fields') === 'id',
        false,
        `${label} / ${hostile}: the injected fields value did not take over`,
      );
    }
  }
});

// --- Consequence 3: the version pin survives ------------------------------

test('an id containing "../" cannot strip the pinned /v25.0 segment', async () => {
  // `new URL()` resolves dot segments, so `/v25.0/../me` really did become `/me`
  // by the time fetch saw it — a versionless call, which is exactly what
  // GRAPH_VERSION exists to prevent.
  for (const hostile of ['../me', '..%2fme', 'X/../../me']) {
    for (const { label, call } of PATH_CALLS) {
      const { req, urls } = harness();
      await call(req, hostile);
      const url = soleUrl(urls);
      assert.ok(
        url.pathname.startsWith('/v25.0/'),
        `${label} / ${hostile}: version pin survives normalisation (got ${url.pathname})`,
      );
    }
  }
});

// --- The negative direction: real ids must still work ----------------------

test('legitimate Graph ids round-trip through the path byte-for-byte', async () => {
  // The failure mode of an over-eager fix: encoding that mangles the ids Meta
  // actually issues. Both observed forms are pinned — the plain 17-digit id and
  // the underscore-joined `<user-id>_<media-id>` form Meta returns on permalinks
  // and webhooks (`_` is unreserved, so encodeURIComponent must leave it alone).
  for (const id of ['17841400008460056', '17841400008460056_17877854240352520']) {
    const { req, urls } = harness();
    await getComment(req, { commentId: id });
    assert.equal(soleUrl(urls).pathname, `/v25.0/${id}`);
  }

  const { req, urls } = harness();
  await listComments(req, { mediaId: '17841400008460056_17877854240352520', maxItems: 10 });
  assert.equal(soleUrl(urls).pathname, '/v25.0/17841400008460056_17877854240352520/comments');
});

test('the literal path segments around an id are NOT encoded', async () => {
  // Encoding the whole template instead of just the variable would turn
  // `/17841/comments` into `/17841%2Fcomments` and address a media object that
  // does not exist. The separators must stay separators.
  const { req, urls } = harness();
  await getMediaChildren(req, { mediaId: '17841400008460056' });
  assert.equal(soleUrl(urls).pathname, '/v25.0/17841400008460056/children');
});

// --- Drift guard: PATH_CALLS must stay exhaustive ---------------------------
//
// Everything above sweeps the functions PATH_CALLS names. Nothing above notices
// the function it does NOT name, which is precisely the residual CC-PROC-7 left
// behind (CC-PROC-15): the encoding is fixed for the code that exists, not for
// the code written next. So the sources are read back and compared.
//
// The scan is intentionally structural and dumb — no TypeScript AST, no
// dependency — because a parser here would be a second implementation to keep
// correct. It errs toward false POSITIVES (a `path:` in a doc comment, a private
// helper that builds a path) and never toward silence: the cost of a false
// positive is one entry or one reworded comment, the cost of a false negative is
// an unauthenticated request nobody notices.

/**
 * Locate the repo root: the nearest directory containing a `package.json`. The
 * test process runs from the repo root (`npm test` -> `node --test` with
 * cwd = repo root) so `process.cwd()` is tried first; if cwd does not hold a
 * `package.json` (a compiled test invoked directly from elsewhere), walk up from
 * this compiled file's own location instead. Mirrors
 * `test/release/version-consistency.test.ts`.
 */
function findRepoRoot(): string {
  const candidates: string[] = [process.cwd()];
  let dir = dirname(fileURLToPath(import.meta.url));
  let parent = dirname(dir);
  while (dir !== parent) {
    candidates.push(dir);
    dir = parent;
    parent = dirname(dir);
  }
  candidates.push(dir); // filesystem root

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(
    `could not locate repo root: no package.json found in any of ${candidates.join(', ')}`,
  );
}

/**
 * True when the expression after `path:` starts with a complete string or
 * template literal that interpolates nothing, and that literal is the whole
 * value — the terminator must be a `,` or a `}` (or end of line), so
 * `path: '/' + id` is NOT mistaken for the literal `'/'`.
 */
function isLiteralPath(expression: string): boolean {
  const text = expression.trimStart();
  return (
    /^'[^'\\]*'\s*(?:[,}]|$)/.test(text) ||
    /^"[^"\\]*"\s*(?:[,}]|$)/.test(text) ||
    /^`[^`$\\]*`\s*(?:[,}]|$)/.test(text)
  );
}

/** Top-level `function`/`const` declarations, in source order, as scope markers. */
const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_$]+)/gm;
/** A `path:` property and everything after it on that line. */
const PATH_PROPERTY = /\bpath:\s*([^\n]+)/g;
/**
 * The other spelling a request path wears: a `path` local declared first and
 * handed to the descriptor as shorthand (— `req({ method, path })`). The
 * value to judge is the right-hand side of the declaration, exactly as it is
 * for the property form.
 */
const PATH_DECLARATION = /\b(?:const|let)\s+path\s*=\s*([^\n]+)/g;
/**
 * Every Graph request descriptor in this layer carries a `method`. It is the
 * witness the count below leans on: a descriptor cannot be built without one,
 * and it is written in the same object literal as the path.
 */
const REQUEST_METHOD = /\bmethod:/g;

/**
 * Scan every `.ts` file under `src/api/`, at any depth, for request paths that
 * are not plain literals, returning `<file>:<function>` for each — `<file>`
 * relative to `src/api/` — deduplicated and sorted. The enclosing function
 * is the nearest top-level declaration above the match — a path built inside an
 * inner arrow function (`fetchPagedEdge`'s page builder, for instance) is still
 * attributed to the exported function that owns it.
 *
 * Two spellings are recognised, and the scan refuses to guess at a third. A
 * pattern that knows only some of the ways a path can be written does not
 * report the ones it cannot see: it reports nothing about them, so the drift
 * guard below stays green while a whole function goes unswept. Hence the count
 * per file — one path for every `method` in the module — which is what makes a
 * new spelling a failure instead of a silence.
 *
 * The depth is a decision, not `readdirSync`’s default. `src/api/` is flat
 * today, so a recursive and a non-recursive walk read the same seven modules;
 * they differ the day an edge grows a sub-folder. A non-recursive read hands
 * back the directory’s own name, the `.ts` filter drops it, and the module
 * inside is never scanned — while `tsconfig.json`, whose include glob reaches
 * every depth under `src/`, compiles it into the build all the same. The
 * extension is a decision too, and that same glob is why `.ts` alone is right:
 * a `.mts` here would never reach `dist/`, so it is not a live request path.
 * Measured 2026-09-23 — CC-PROC-163.
 */
function scanInterpolatedApiPaths(): string[] {
  const apiDir = join(findRepoRoot(), 'src', 'api');
  const files = readdirSync(apiDir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .sort();
  assert.ok(
    files.length > 0,
    `no api sources found under ${apiDir} — the drift guard cannot pass vacuously`,
  );

  const found: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(apiDir, file), 'utf8');
    const declarations = [...source.matchAll(DECLARATION)];
    const pathSites = [
      ...source.matchAll(PATH_PROPERTY),
      ...source.matchAll(PATH_DECLARATION),
    ].sort((a, b) => a.index - b.index);

    // The floor, and the reason this scan can be trusted at all. Everything
    // below reports on the paths the two patterns above happen to match; a path
    // written a third way is not reported as a gap, it is simply absent, and
    // `unswept` comes back empty either way. `method` is the one part of a
    // request descriptor that cannot be left out or built elsewhere, so it
    // counts the descriptors, and every descriptor owes this scan exactly one
    // path it can read.
    const methods = [...source.matchAll(REQUEST_METHOD)].length;
    assert.equal(
      pathSites.length,
      methods,
      `${file}: ${methods} request descriptors but ${pathSites.length} readable request ` +
        `paths. A path this scan cannot read is a path it cannot report as unswept, so the ` +
        `guard below would pass over the function that builds it. Teach PATH_PROPERTY or ` +
        `PATH_DECLARATION the spelling used here.`,
    );

    for (const match of pathSites) {
      if (isLiteralPath(match[1] ?? '')) continue;
      const owner = declarations.filter((d) => d.index < match.index).pop();
      assert.ok(
        owner,
        `${file}: a computed request path at offset ${match.index} sits above every ` +
          `top-level declaration, so it cannot be attributed to a function`,
      );
      found.push(`${file}:${owner[1] ?? ''}`);
    }
  }
  return [...new Set(found)].sort();
}

test('PATH_CALLS covers every api function that builds a computed request path', () => {
  const scanned = scanInterpolatedApiPaths();
  const declared = [...new Set(PATH_CALLS.map((c) => c.source))].sort();

  const unswept = scanned.filter((s) => !declared.includes(s));
  assert.deepEqual(
    unswept,
    [],
    `these api functions interpolate a value into their request path but no PATH_CALLS ` +
      `entry exercises them, so nothing proves they encode it: ${unswept.join(', ')}. ` +
      `Add an entry with source: '<file>:<function>' to PATH_CALLS above.`,
  );

  const stale = declared.filter((s) => !scanned.includes(s));
  assert.deepEqual(
    stale,
    [],
    `these PATH_CALLS entries name a source that no longer builds a computed path ` +
      `(renamed, deleted, or the path became a literal): ${stale.join(', ')}. ` +
      `Remove or re-point them — a stale entry hides the next real gap.`,
  );
});
