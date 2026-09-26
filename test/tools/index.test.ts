/**
 * Contract test for the tool-package barrel (`src/tools/index.ts`, Layer 3).
 *
 * The barrel is a dozen lines of pure aggregation, which is exactly why it
 * needs a contract of its own: everything it can get wrong is silent. A dropped
 * spread removes a whole package from the MCP surface; a duplicated one
 * registers the same tool name twice; a reordered spread changes the order
 * clients list tools in and the order the generated README renders them in.
 *
 * Before this file existed, the *order* of `allTools` was pinned by exactly one
 * assertion in the suite: the README drift guard in `test/docs-sync.test.ts`,
 * whose failure message tells the maintainer to run `npm run gen:readme` — that
 * is, to regenerate the README *from* the reordered surface rather than to
 * question the reordering. A reshuffled barrel therefore presented itself as a
 * documentation chore. The membership of `allTools` was pinned only indirectly,
 * by `test/mcp/registry.test.ts` asserting what `buildManifest` groups out of
 * it. The assertions below make the barrel itself the subject.
 *
 * Offline by construction: this file only imports specs and reads their
 * metadata, never invoking a handler. `globalThis.fetch` is poisoned anyway, so
 * an import-time side effect that reached for the network would die here rather
 * than ship the operator's live credential to Meta from a test run. Restored in
 * `after()` so nothing leaks into another test file.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { ToolSpec } from '../../src/mcp/define.js';
import { allTools } from '../../src/tools/index.js';
import * as barrel from '../../src/tools/index.js';
import { accountTools } from '../../src/tools/account.js';
import { mediaTools } from '../../src/tools/media.js';
import { insightsTools } from '../../src/tools/insights.js';
import { publishingTools } from '../../src/tools/publishing.js';
import { commentsTools } from '../../src/tools/comments.js';
import { discoveryTools } from '../../src/tools/discovery.js';

const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('the tool barrel contract test must never touch the network');
};
after(() => {
  globalThis.fetch = realFetch;
});

/**
 * The v1 tool surface, pinned in registration order and deliberately written
 * out here instead of derived from the barrel — a list derived from the thing
 * under test cannot disagree with it. Adding, removing or moving a tool is
 * meant to be a deliberate edit to this array as well.
 */
const V1_SURFACE: readonly string[] = [
  // account (3)
  'instagram_get_account',
  'instagram_list_linked_accounts',
  'instagram_token_status',
  // media (2)
  'instagram_list_media',
  'instagram_get_media',
  // insights (4)
  'instagram_get_account_insights',
  'instagram_get_media_insights',
  'instagram_get_audience_demographics',
  'instagram_get_online_followers',
  // publishing (7)
  'instagram_create_media_container',
  'instagram_get_container_status',
  'instagram_publish_media',
  'instagram_get_publishing_limit',
  'instagram_post_image',
  'instagram_post_reel',
  'instagram_post_story',
  // comments (8, plus the media-tagged comment switch below)
  'instagram_list_comments',
  'instagram_get_comment',
  'instagram_list_tagged_media',
  'instagram_reply_to_comment',
  'instagram_create_comment',
  'instagram_hide_comment',
  'instagram_unhide_comment',
  'instagram_delete_comment',
  'instagram_set_comments_enabled',
  // discovery (3)
  'instagram_search_hashtag',
  'instagram_get_hashtag_media',
  'instagram_discover_business',
];

/**
 * The package tag carried by each entry of {@link V1_SURFACE}, in the same
 * order. Written out separately because tag and source file are not the same
 * thing: `instagram_set_comments_enabled` is defined in `tools/comments.ts` but
 * tagged `media`, so the tag sequence is not a run-length encoding of the
 * spreads and the registry regroups that one tool under a different package.
 */
const V1_PACKAGE_TAGS: readonly string[] = [
  ...Array<string>(3).fill('account'),
  ...Array<string>(2).fill('media'),
  ...Array<string>(4).fill('insights'),
  ...Array<string>(7).fill('publishing'),
  ...Array<string>(8).fill('comments'),
  'media',
  ...Array<string>(3).fill('discovery'),
];

/** The six package arrays in the order the barrel is supposed to spread them. */
const SPREADS: readonly (readonly [string, readonly ToolSpec[]])[] = [
  ['accountTools', accountTools],
  ['mediaTools', mediaTools],
  ['insightsTools', insightsTools],
  ['publishingTools', publishingTools],
  ['commentsTools', commentsTools],
  ['discoveryTools', discoveryTools],
];

test('allTools is exactly the v1 surface, in registration order', () => {
  assert.deepEqual(
    allTools.map((t) => t.name),
    [...V1_SURFACE],
    'the exposed tool surface changed — update V1_SURFACE only if the change is intended',
  );
  assert.equal(allTools.length, 28, 'the v1 surface is 28 tools');
});

test('allTools carries the pinned package tag for every position', () => {
  // The tag decides which package a tool is registered under, which decides
  // whether `IG_TOOL_PACKAGES=reader` or an `IG_PACKAGES_DENY` entry can reach
  // it. A tool that keeps its name but changes package silently changes who can
  // call it, and the name list above would not notice.
  assert.deepEqual(
    allTools.map((t) => t.package),
    [...V1_PACKAGE_TAGS],
  );
});

test('allTools is the six package arrays concatenated, by identity and in order', () => {
  // Identity, not deep equality: the barrel must hand the registry the very
  // spec objects its packages exported. A barrel that mapped, cloned or
  // re-wrapped them would still list the same names while shipping handlers
  // that no per-package test ever exercised.
  const expected: ToolSpec[] = [];
  for (const [, tools] of SPREADS) expected.push(...tools);

  assert.equal(allTools.length, expected.length, 'the barrel drops or duplicates a spread');
  for (const [i, spec] of expected.entries()) {
    assert.equal(allTools[i], spec, `position ${String(i)} is not the spec its package exported`);
  }
});

test('every package contributes all of its tools exactly once', () => {
  // The per-index check above already implies this, but it fails on the first
  // divergent slot and reports a position. This one names the package, which is
  // the fact a maintainer who just edited one spread actually needs.
  let counted = 0;
  for (const [label, tools] of SPREADS) {
    assert.ok(tools.length > 0, `${label} is empty — a package with no tools cannot be registered`);
    for (const spec of tools) {
      const occurrences = allTools.filter((t) => t === spec).length;
      assert.equal(
        occurrences,
        1,
        `${label} contributes ${spec.name} ${String(occurrences)} times`,
      );
    }
    counted += tools.length;
  }
  assert.equal(allTools.length, counted, 'allTools holds specs from outside the six packages');
});

test('no tool name appears twice in the surface', () => {
  // A duplicated spread registers the same name twice. `McpServer` rejects the
  // second registration at startup, so the failure mode is a server that will
  // not boot rather than a shadowed tool — still worth catching in a unit test
  // instead of at an operator's first launch.
  const seen = new Set<string>();
  for (const spec of allTools) {
    assert.equal(seen.has(spec.name), false, `${spec.name} is registered twice`);
    seen.add(spec.name);
  }
  assert.equal(seen.size, allTools.length);
});

test('packages first appear in the order the generated README renders them', () => {
  // `renderToolTable` groups rows by the order package tags first appear in
  // `allTools`, so this sequence is what decides the README section order.
  // Pinned here as well so that reordering the barrel fails as a surface change
  // and not only as README drift, which reads like a regeneration chore.
  const firstAppearance: string[] = [];
  for (const spec of allTools) {
    if (!firstAppearance.includes(spec.package)) firstAppearance.push(spec.package);
  }
  assert.deepEqual(firstAppearance, [
    'account',
    'media',
    'insights',
    'publishing',
    'comments',
    'discovery',
  ]);
});

test('the barrel copies its packages instead of aliasing one of them', () => {
  // Spreading produces a fresh array. The barrel now freezes what it hands out,
  // so an alias would not let a consumer splice a package array in place — it
  // would do the opposite damage, freezing `accountTools` (or whichever package
  // the barrel aliased) as a side effect of importing the barrel, and turning a
  // package file's own future edit into a `TypeError`. Either way the packages
  // must stay distinct objects from the surface built out of them.
  for (const [label, tools] of SPREADS) {
    assert.notEqual(allTools, tools, `allTools must not alias ${label}`);
  }
});

test('the barrel exports allTools and nothing else', () => {
  // The barrel is the registry's single import point for the tool surface. A
  // second export here would be a second, unpinned way to reach tools.
  assert.deepEqual(Object.keys(barrel).sort(), ['allTools']);
});

/*
 * The freeze contract.
 *
 * Until 2026-09-23 the barrel handed out a live, mutable array of live, mutable
 * spec objects, and the suite pinned every VALUE on that surface and not one of
 * its defences — `allTools.push({ name: 'instagram_exfiltrate' })` worked, and so
 * did the two property writes below. The type said `ToolSpec[]`, which is erased
 * at emit and stops nothing at runtime (CC-CFG-32). These tests exist because a
 * freeze is invisible: nothing else in the suite fails if `Object.freeze` is
 * dropped from `publish`, and the mutation that drops it looks like a cleanup.
 *
 * Each assertion writes and then reads back, rather than trusting `isFrozen`.
 * `Object.isFrozen` answers true for a frozen `Set` whose `.delete()` still
 * succeeds (CC-CFG-33), so on its own it is a claim about the flag and not about
 * what the object will accept.
 */

test('the published surface is frozen: allTools cannot be grown, shrunk or reordered', () => {
  const mutable = allTools as ToolSpec[];
  const before = allTools.map((spec) => spec.name);
  const first = allTools[0] as ToolSpec;

  assert.throws(() => mutable.push(first), TypeError, 'a tool can be appended to the surface');
  assert.throws(() => mutable.pop(), TypeError, 'a tool can be dropped from the surface');
  assert.throws(() => mutable.splice(0, 1), TypeError, 'the surface can be spliced');
  assert.throws(() => mutable.reverse(), TypeError, 'the surface can be reordered in place');
  assert.throws(
    () => {
      mutable[0] = first;
    },
    TypeError,
    'a position on the surface can be overwritten',
  );

  assert.deepEqual(
    allTools.map((spec) => spec.name),
    before,
    'a write got through: the surface is not the one the module published',
  );
});

test('every published spec is frozen, with its annotations and its input/output shapes', () => {
  assert.equal(allTools.length, 28, 'guard: an empty surface would pass this test vacuously');
  for (const spec of allTools) {
    assert.throws(
      () => {
        spec.name = 'instagram_impostor';
      },
      TypeError,
      `${spec.name}: its name can be rewritten`,
    );
    assert.throws(
      () => {
        spec.handler = () => ({ content: [] });
      },
      TypeError,
      `${spec.name}: its handler can be replaced`,
    );
    assert.throws(
      () => {
        spec.package = 'core';
      },
      TypeError,
      `${spec.name}: its package tag can be rewritten, moving it between profiles`,
    );
    assert.throws(
      () => {
        spec.annotations.readOnlyHint = !(spec.annotations.readOnlyHint ?? false);
      },
      TypeError,
      `${spec.name}: its annotations can be rewritten`,
    );

    // Adding a field is the write that works on every shape, including the
    // parameterless tools (`instagram_get_account` declares `{}`), and it is the
    // dangerous one: `registerTools` merges `{ ...spec.input, account }` into the
    // registered schema, so a field smuggled in here becomes an argument the
    // model may send. Swapping and deleting are only checkable where a field
    // exists, so they are asserted under a guard rather than skipped silently.
    for (const [label, shape] of [
      ['input', spec.input],
      ...(spec.output === undefined ? [] : ([['output', spec.output]] as const)),
    ] as const) {
      assert.throws(
        () => {
          shape.instagram_smuggled = z.string();
        },
        TypeError,
        `${spec.name}: a field can be added to its ${label} shape`,
      );

      const key = Object.keys(shape)[0];
      if (key === undefined) continue;
      assert.throws(
        () => {
          shape[key] = z.string();
        },
        TypeError,
        `${spec.name}: a declared ${label} field can be swapped for another schema`,
      );
      assert.throws(
        () => {
          delete shape[key];
        },
        TypeError,
        `${spec.name}: a declared ${label} field can be deleted`,
      );
    }
  }
});

test('a frozen spec is what keeps a forced-read-only deployment read-only', () => {
  // `registerTools` builds the forced-read-only surface with
  // `spec.annotations.readOnlyHint !== true` (src/mcp/registry.ts). `readOnlyHint`
  // is an optional field on a plain object, so before the freeze a single write
  // put the delete tool back on a surface the operator asked to be read-only —
  // and a second write cleared the destructive hint the client renders its
  // confirmation UI from. Neither write is a type error in TypeScript: the
  // element type of a `readonly ToolSpec[]` is a fully mutable `ToolSpec`.
  const del = allTools.find((spec) => spec.name === 'instagram_delete_comment');
  assert.ok(del, 'guard: the delete tool must be on the surface for this to measure anything');
  assert.equal(del.annotations.readOnlyHint, false, 'guard: it starts out a write tool');
  assert.equal(del.annotations.destructiveHint, true, 'guard: and a destructive one');

  assert.throws(() => {
    del.annotations.readOnlyHint = true;
  }, TypeError);
  assert.throws(() => {
    del.annotations.destructiveHint = false;
  }, TypeError);
  assert.throws(() => {
    delete del.annotations.destructiveHint;
  }, TypeError);

  assert.equal(
    del.annotations.readOnlyHint,
    false,
    'the delete tool now passes a read-only filter',
  );
  assert.equal(
    del.annotations.destructiveHint,
    true,
    'the delete tool now renders as non-destructive',
  );
});

test('the insights package shares one annotations object, and it is frozen once for all four', () => {
  // `src/tools/insights.ts` hands the same `readOnly` constant to all four specs.
  // That is fine, and worth pinning: it means one write used to flip four tools,
  // and it means freezing any one of them freezes the object the others read.
  const insights = allTools.filter((spec) => spec.package === 'insights');
  assert.equal(insights.length, 4, 'guard: the insights package is four tools');
  assert.equal(
    new Set(insights.map((spec) => spec.annotations)).size,
    1,
    'the four insights specs no longer share one annotations object',
  );
  for (const spec of insights) {
    assert.throws(
      () => {
        spec.annotations.readOnlyHint = false;
      },
      TypeError,
      `${spec.name}: the shared annotations object is writable through it`,
    );
  }
  assert.deepEqual(
    insights.map((spec) => spec.annotations.readOnlyHint),
    [true, true, true, true],
  );
});

test('each package array is frozen too, so the barrel is not the only door', () => {
  // Every spec on `allTools` is also reachable through the package array it came
  // from, and `test/tools/index.test.ts` is not the only importer of those —
  // `test/mcp/tool-metadata-contract.test.ts` imports all six. Freezing only the
  // barrel would leave `commentsTools.push(...)` open to anything that imports
  // the package directly, and the barrel spreads that array at load time, so the
  // extra tool would reach the real surface on the next process start.
  for (const [label, tools] of SPREADS) {
    const mutable = tools as ToolSpec[];
    const before = tools.length;
    assert.throws(() => mutable.push(mutable[0] as ToolSpec), TypeError, `${label} accepts a push`);
    assert.throws(() => mutable.pop(), TypeError, `${label} accepts a pop`);
    assert.equal(tools.length, before, `${label} changed length`);
  }
});
