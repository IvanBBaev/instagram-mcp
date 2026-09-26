/**
 * Tests for the frozen Layer-2 tool contract (`src/mcp/define.ts`, Gate G1).
 *
 * The module is a contract rather than behaviour: seven of its eight exports
 * are types that vanish at compile time, and the eighth — `defineTool` — is an
 * identity helper. Both halves are pinned here.
 *
 * **Type half.** `Expect<Equal<A, B>>` resolves to the literal `true` only when
 * `A` and `B` are the *same* type to the checker. Unlike a pair of `extends`
 * constraints it separates `k?: T` from `k: T | undefined`, so it catches a
 * member being renamed, retyped, added, removed, or having its optionality
 * flipped. Every assertion is consumed by a runtime `assert`, so a drifted
 * contract is a build error (TS2344 on `Expect`), not a seam that silently
 * widened under the four tool packages that depend on it.
 *
 * **Runtime half.** `defineTool` must hand back the very object it was given:
 * same reference, same own keys in the same order, no defaults injected, its
 * attributes untouched, and neither `handler` nor `logFields` invoked. Every
 * `tools/` file defines its specs as `defineTool({ … })` literals and the
 * registry later reads `spec.input`, `spec.annotations` and `spec.paths` off
 * the result, so anything the helper copied or sealed would diverge from what
 * the definition site wrote.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { defineTool } from '../../src/mcp/define.js';
import type {
  ToolAnnotationSet,
  ToolContent,
  ToolContext,
  ToolInputArgs,
  ToolResult,
  ToolSpec,
  ToolTextContent,
} from '../../src/mcp/define.js';
import type {
  AuthPath,
  IgRequestFn,
  Logger,
  ResolvedProfile,
  Settings,
} from '../../src/core/types.js';
import type { Clock } from '../../src/core/clock.js';

// `define.ts` is a pure contract and nothing in this file performs I/O, but the
// guard is kept structural anyway: if anything here ever grows a path that
// reaches for the real network instead of the injected `req` seam it fails
// offline, rather than sending a live Meta token to graph.facebook.com from a
// unit test.
const realFetch: typeof globalThis.fetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('define contract tests must never touch the network');
};
after(() => {
  globalThis.fetch = realFetch;
});

/**
 * Exact type equality. The two deferred conditionals are mutually assignable
 * only when `X` and `Y` are identical to the checker — which, unlike
 * `X extends Y ? …`, distinguishes an optional member from a required one that
 * admits `undefined`, and `unknown` from `any`.
 */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** Compile-time assertion: instantiating it with `false` is a TS2344 build error. */
type Expect<T extends true> = T;

/**
 * The keys `T` declares optional (`k?:`), as opposed to merely admitting
 * `undefined`. `Record<never, never>` is the empty object type spelled without
 * the `{}` literal the lint config rejects.
 */
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

/** A representative declared input shape: one required field, one optional. */
type Shape = { mediaId: z.ZodString; limit: z.ZodOptional<z.ZodNumber> };

/**
 * A shape whose zod *input* and *output* types differ. `z.infer` is the output
 * side, so a handler sees `limit: number` (the default already applied) rather
 * than `limit?: number`; nothing else distinguishes `z.infer` from `z.input`.
 */
type DefaultedShape = { limit: z.ZodDefault<z.ZodNumber> };

// --- the type contract -----------------------------------------------------

test('contract: ToolAnnotationSet is exactly the four MCP hints, every one optional', () => {
  const exact: Expect<
    Equal<
      ToolAnnotationSet,
      {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      }
    >
  > = true;
  const allOptional: Expect<
    Equal<
      OptionalKeys<ToolAnnotationSet>,
      'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'
    >
  > = true;
  // The registry's forced-read-only filter tests `readOnlyHint !== true`, so the
  // hint has to stay a boolean: a string or a widened `unknown` would make every
  // tool look non-read-only and silently drop the whole package.
  const readOnly: Expect<Equal<ToolAnnotationSet['readOnlyHint'], boolean | undefined>> = true;
  const destructive: Expect<Equal<ToolAnnotationSet['destructiveHint'], boolean | undefined>> =
    true;
  const idempotent: Expect<Equal<ToolAnnotationSet['idempotentHint'], boolean | undefined>> = true;
  const openWorld: Expect<Equal<ToolAnnotationSet['openWorldHint'], boolean | undefined>> = true;
  assert.equal(exact, true);
  assert.equal(allOptional, true);
  assert.equal(readOnly, true);
  assert.equal(destructive, true);
  assert.equal(idempotent, true);
  assert.equal(openWorld, true);
});

test('contract: ToolTextContent is a required `text` literal tag plus a required string', () => {
  const exact: Expect<Equal<ToolTextContent, { type: 'text'; text: string }>> = true;
  // The tag must stay the literal `'text'`: `mcp/result.ts` writes it unchecked
  // and MCP clients switch on it, so widening it to `string` would let a typo
  // through to the wire.
  const literalTag: Expect<Equal<ToolTextContent['type'], 'text'>> = true;
  const nothingOptional: Expect<Equal<OptionalKeys<ToolTextContent>, never>> = true;
  assert.equal(exact, true);
  assert.equal(literalTag, true);
  assert.equal(nothingOptional, true);
});

test('contract: ToolContent is the text block and nothing else', () => {
  // Widening this union (an image/audio/resource member) would make every
  // `result.content[0].text` read in the suite and in `tools/` unsound.
  const exact: Expect<Equal<ToolContent, ToolTextContent>> = true;
  const stillLiteral: Expect<Equal<ToolContent, { type: 'text'; text: string }>> = true;
  assert.equal(exact, true);
  assert.equal(stillLiteral, true);
});

test('contract: ToolResult requires `content` and keeps structuredContent/isError optional', () => {
  const exact: Expect<
    Equal<
      ToolResult,
      {
        content: ToolContent[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      }
    >
  > = true;
  const optionalKeys: Expect<Equal<OptionalKeys<ToolResult>, 'structuredContent' | 'isError'>> =
    true;
  // `content` is a list even for the single-block results the builders emit —
  // the MCP wire shape is an array, and the write gate reads `result.isError`
  // as a tri-state (`!== true`), so it must stay `boolean | undefined`.
  const contentIsAList: Expect<Equal<ToolResult['content'], ToolContent[]>> = true;
  const isErrorTriState: Expect<Equal<ToolResult['isError'], boolean | undefined>> = true;
  const structured: Expect<
    Equal<ToolResult['structuredContent'], Record<string, unknown> | undefined>
  > = true;
  assert.equal(exact, true);
  assert.equal(optionalKeys, true);
  assert.equal(contentIsAList, true);
  assert.equal(isErrorTriState, true);
  assert.equal(structured, true);
});

test('contract: ToolContext is the five injected dependencies, all required', () => {
  const exact: Expect<
    Equal<
      ToolContext,
      {
        req: IgRequestFn;
        settings: Settings;
        profile: ResolvedProfile;
        clock: Clock;
        log: Logger;
      }
    >
  > = true;
  // Nothing here may become optional: the registry builds the context once per
  // call and every tool reads all five without a guard. An optional member would
  // move the failure from the build to a live tool call.
  const nothingOptional: Expect<Equal<OptionalKeys<ToolContext>, never>> = true;
  // `req` is the *only* network seam (architecture §3). Widening it to
  // `unknown`/`Function` would let a tool build its own transport unnoticed.
  const reqIsTheSeam: Expect<Equal<ToolContext['req'], IgRequestFn>> = true;
  const settings: Expect<Equal<ToolContext['settings'], Settings>> = true;
  const profile: Expect<Equal<ToolContext['profile'], ResolvedProfile>> = true;
  const clock: Expect<Equal<ToolContext['clock'], Clock>> = true;
  const log: Expect<Equal<ToolContext['log'], Logger>> = true;
  assert.equal(exact, true);
  assert.equal(nothingOptional, true);
  assert.equal(reqIsTheSeam, true);
  assert.equal(settings, true);
  assert.equal(profile, true);
  assert.equal(clock, true);
  assert.equal(log, true);
});

test('contract: ToolInputArgs is the declared input intersected with account/apply', () => {
  const exact: Expect<
    Equal<ToolInputArgs<Shape>, z.infer<z.ZodObject<Shape>> & { account?: string; apply?: boolean }>
  > = true;
  const keys: Expect<Equal<keyof ToolInputArgs<Shape>, 'mediaId' | 'limit' | 'account' | 'apply'>> =
    true;
  const optionalKeys: Expect<
    Equal<OptionalKeys<ToolInputArgs<Shape>>, 'limit' | 'account' | 'apply'>
  > = true;
  // The framework-injected pair: `account` selects the profile (registry step 2),
  // `apply` drives the write gate. Both optional, and `account` a string — the
  // registry does `args.account ?? deps.defaultProfileName`.
  const account: Expect<Equal<ToolInputArgs<Shape>['account'], string | undefined>> = true;
  const apply: Expect<Equal<ToolInputArgs<Shape>['apply'], boolean | undefined>> = true;
  // The tool's own declared fields survive the intersection unchanged.
  const required: Expect<Equal<ToolInputArgs<Shape>['mediaId'], string>> = true;
  const optional: Expect<Equal<ToolInputArgs<Shape>['limit'], number | undefined>> = true;
  assert.equal(exact, true);
  assert.equal(keys, true);
  assert.equal(optionalKeys, true);
  assert.equal(account, true);
  assert.equal(apply, true);
  assert.equal(required, true);
  assert.equal(optional, true);
});

test('contract: ToolInputArgs uses the parsed OUTPUT of the schema, not its input', () => {
  // Handlers run on `parsed.data`, so a `.default()` has already been applied by
  // the time they see the argument. Typing the seam with `z.input` would tell
  // every handler the field might be missing and push a pointless `?? default`
  // into each of them — or, worse, invite one to re-apply a different default.
  const outputSide: Expect<Equal<ToolInputArgs<DefaultedShape>['limit'], number>> = true;
  assert.equal(outputSide, true);
});

test('contract: ToolInputArgs has no default shape — every use has to name one', () => {
  // Deliberately unlike `ToolSpec`, which *does* default `S` so the registry can
  // hold a heterogeneous `ToolSpec[]`. There is no such need here: every
  // reference is either a definition site (shape known) or the registry's
  // explicit `ToolInputArgs<z.ZodRawShape>`. A silent default would let a
  // handler be typed against the empty shape and lose its own fields without a
  // single call site changing.
  // @ts-expect-error — a missing type argument must stay a build error (TS2314).
  const bare = null as unknown as ToolInputArgs;
  assert.equal(bare, null);
});

test('contract: ToolSpec declares exactly ten members, three of them optional', () => {
  const keys: Expect<
    Equal<
      keyof ToolSpec<Shape>,
      | 'name'
      | 'title'
      | 'description'
      | 'package'
      | 'paths'
      | 'annotations'
      | 'input'
      | 'output'
      | 'logFields'
      | 'handler'
    >
  > = true;
  // `paths: undefined` means "both auth paths" (D1) and `logFields`/`output` are
  // genuinely per-tool. Everything else is mandatory: the registry reads `name`,
  // `title`, `description`, `package`, `annotations`, `input` and `handler` for
  // every single registration with no fallback.
  const optionalKeys: Expect<
    Equal<OptionalKeys<ToolSpec<Shape>>, 'paths' | 'output' | 'logFields'>
  > = true;
  const name: Expect<Equal<ToolSpec<Shape>['name'], string>> = true;
  const title: Expect<Equal<ToolSpec<Shape>['title'], string>> = true;
  const description: Expect<Equal<ToolSpec<Shape>['description'], string>> = true;
  const pkg: Expect<Equal<ToolSpec<Shape>['package'], string>> = true;
  assert.equal(keys, true);
  assert.equal(optionalKeys, true);
  assert.equal(name, true);
  assert.equal(title, true);
  assert.equal(description, true);
  assert.equal(pkg, true);
});

test('contract: ToolSpec.paths is an optional list of AuthPath (the D1 capability matrix)', () => {
  // A list, not a single value: `registerTools` filters with `.some()` and the
  // call-time guard with `.includes()`. Narrowing it to `AuthPath` or widening
  // it to `string[]` would break the first or defeat the second.
  const exact: Expect<Equal<ToolSpec<Shape>['paths'], AuthPath[] | undefined>> = true;
  assert.equal(exact, true);
});

test('contract: ToolSpec.annotations is required and ToolSpec.output is an optional raw shape', () => {
  // `registerTools` reads `spec.annotations.readOnlyHint` unguarded for every
  // tool, so the member cannot become optional.
  const annotations: Expect<Equal<ToolSpec<Shape>['annotations'], ToolAnnotationSet>> = true;
  // `output` stays a raw shape (not a built ZodObject): the SDK wraps it for both
  // the published JSON Schema and the structuredContent check, and it is
  // deliberately independent of the input shape `S`.
  const output: Expect<Equal<ToolSpec<Shape>['output'], z.ZodRawShape | undefined>> = true;
  assert.equal(annotations, true);
  assert.equal(output, true);
});

test('contract: ToolSpec.input keeps the caller-declared shape S, not a widened raw shape', () => {
  // This is the whole point of the generic: `logFields` and `handler` are typed
  // from `S`, so a definition site gets its own field names back. Collapsing
  // `input: S` to `input: z.ZodRawShape` would turn every handler argument into
  // an index-signature bag.
  const exact: Expect<Equal<ToolSpec<Shape>['input'], Shape>> = true;
  assert.equal(exact, true);
});

test('contract: ToolSpec.logFields is an optional S-typed projection to a record', () => {
  const exact: Expect<
    Equal<
      ToolSpec<Shape>['logFields'],
      ((args: ToolInputArgs<Shape>) => Record<string, unknown>) | undefined
    >
  > = true;
  assert.equal(exact, true);
});

test('contract: ToolSpec.handler takes (args, ctx) and may be sync or async', () => {
  // Both arities matter: `tools/account.ts` has synchronous handlers and every
  // network tool is `async`. Narrowing the return to just `Promise<ToolResult>`
  // (or just `ToolResult`) would reject half the tool surface.
  const exact: Expect<
    Equal<
      ToolSpec<Shape>['handler'],
      (args: ToolInputArgs<Shape>, ctx: ToolContext) => ToolResult | Promise<ToolResult>
    >
  > = true;
  assert.equal(exact, true);
});

test('contract: ToolSpec defaults its type parameter to z.ZodRawShape', () => {
  // `mcp/registry.ts` stores heterogeneous tools as `ToolSpec[]`; without the
  // default that bare reference does not compile.
  const defaulted: Expect<Equal<ToolSpec, ToolSpec<z.ZodRawShape>>> = true;
  assert.equal(defaulted, true);
});

test('contract: defineTool is generic in S and returns the same instantiation it takes', () => {
  // An identity helper that lost the generic on either side would erase the
  // per-tool typing at exactly the place it is meant to preserve it.
  const params: Expect<Equal<Parameters<typeof defineTool<Shape>>, [ToolSpec<Shape>]>> = true;
  const returns: Expect<Equal<ReturnType<typeof defineTool<Shape>>, ToolSpec<Shape>>> = true;
  assert.equal(params, true);
  assert.equal(returns, true);
});

// --- defineTool at runtime -------------------------------------------------

/** The declared input shape used by the runtime specs below. */
const shape = {
  mediaId: z.string().min(1).describe('The media id to read.'),
  limit: z.number().int().optional().describe('Maximum items to return.'),
};

/** A minimal, complete spec — only the mandatory members. */
function minimalSpec(): ToolSpec<typeof shape> {
  return {
    name: 'instagram_get_thing',
    title: 'Get thing',
    description: 'Reads a thing from the Graph API.',
    package: 'media',
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: shape,
    handler: () => ({ content: [{ type: 'text', text: 'ok' }] }),
  };
}

test('defineTool: returns the very object it was handed, not a copy of it', () => {
  const spec = minimalSpec();
  assert.equal(defineTool(spec), spec);
});

test('defineTool: adds no members and injects no defaults for the optional ones', () => {
  const spec = minimalSpec();
  const keysBefore = Object.keys(spec);
  const defined = defineTool(spec);
  // Read them off the result, so a helper that returned an enriched clone fails
  // here even though the input object itself was left alone.
  assert.deepEqual(Object.keys(defined), keysBefore);
  assert.equal(Object.hasOwn(defined, 'paths'), false);
  assert.equal(Object.hasOwn(defined, 'output'), false);
  assert.equal(Object.hasOwn(defined, 'logFields'), false);
  // `paths: undefined` is the D1 "valid on both auth paths" encoding and the
  // registry tests it with `!== undefined`, so an injected `paths: []` would
  // silently unregister the tool everywhere rather than register it everywhere.
  assert.equal(defined.paths, undefined);
});

test('defineTool: carries the optional members through untouched when they are present', () => {
  const logFields = (args: ToolInputArgs<typeof shape>): Record<string, unknown> => ({
    mediaId: args.mediaId,
  });
  const output = { id: z.string() };
  const paths: AuthPath[] = ['fb-login'];
  const spec: ToolSpec<typeof shape> = { ...minimalSpec(), paths, output, logFields };
  const defined = defineTool(spec);
  assert.equal(defined.paths, paths);
  assert.equal(defined.output, output);
  assert.equal(defined.logFields, logFields);
});

test('defineTool: does not rewrite the declared strings, shape or annotations', () => {
  const spec = minimalSpec();
  const annotations = spec.annotations;
  const defined = defineTool(spec);
  // Nested members must be the same references: `mcp/registry.ts` passes
  // `spec.annotations` straight to `registerTool` and spreads `spec.input` into
  // the strict schema, so a deep copy here would detach both from the tool
  // module that declared them.
  assert.equal(defined.annotations, annotations);
  assert.equal(defined.input, shape);
  assert.equal(defined.annotations.readOnlyHint, true);
  assert.equal(defined.annotations.openWorldHint, true);
  assert.equal(defined.annotations.destructiveHint, undefined);
  assert.equal(defined.name, 'instagram_get_thing');
  assert.equal(defined.title, 'Get thing');
  assert.equal(defined.description, 'Reads a thing from the Graph API.');
  assert.equal(defined.package, 'media');
});

test('defineTool: normalises nothing — a malformed name is handed back verbatim', () => {
  // `defineTool` must not quietly repair a bad spec. `mcp/registry.ts` registers
  // `spec.name` verbatim and `test/docs-sync.test.ts` compares it against the
  // documented surface, so trimming here would hide the defect from both instead
  // of letting the malformed name surface where it can be fixed.
  const spec = minimalSpec();
  spec.name = '  instagram_get_thing\t';
  const defined = defineTool(spec);
  assert.equal(defined.name, '  instagram_get_thing\t');
  // The caller's own object must be left alone too, not repaired in place.
  assert.equal(spec.name, '  instagram_get_thing\t');
});

test('defineTool: never runs the spec — neither handler nor logFields is invoked', () => {
  // Handlers reach Instagram. A definition-time call would fire a Graph request
  // (or, here, the offline fetch guard) at module load, before any client has
  // asked for anything.
  const spec: ToolSpec<typeof shape> = {
    ...minimalSpec(),
    logFields: () => {
      throw new Error('logFields must not run at definition time');
    },
    handler: () => {
      throw new Error('handler must not run at definition time');
    },
  };
  const defined = defineTool(spec);
  assert.equal(defined, spec);
});

test('defineTool: the handler it hands back is the same function and still runs', async () => {
  let seen: ToolInputArgs<typeof shape> | undefined;
  const handler = (args: ToolInputArgs<typeof shape>): ToolResult => {
    seen = args;
    return { content: [{ type: 'text', text: `id=${args.mediaId}` }] };
  };
  const spec: ToolSpec<typeof shape> = { ...minimalSpec(), handler };
  const defined = defineTool(spec);
  const ctx = {} as unknown as ToolContext;
  const result = await defined.handler({ mediaId: '42', account: 'alt' }, ctx);
  assert.deepEqual(result, { content: [{ type: 'text', text: 'id=42' }] });
  assert.equal(seen?.mediaId, '42');
  assert.equal(seen?.account, 'alt');
  // Last: `assert.equal` is an assertion signature, so it narrows its first
  // argument to the declared type of the second for the rest of the block.
  assert.equal(defined.handler, handler);
});

test('defineTool: leaves the spec extensible — it neither freezes nor seals it', () => {
  // "Identity" covers the object's attributes, not just its address: sealing the
  // definition would turn any later in-place edit (a test fixture, a future
  // decorator that tags a spec) into a TypeError thrown from module scope,
  // because ESM code is always strict.
  const spec = minimalSpec();
  const defined = defineTool(spec);
  assert.equal(Object.isFrozen(defined), false);
  assert.equal(Object.isSealed(defined), false);
  assert.equal(Object.isExtensible(defined), true);
  assert.equal(Object.getPrototypeOf(defined), Object.prototype);
});

test('defineTool: is a unary function', () => {
  // A second parameter would mean the helper had grown options — i.e. stopped
  // being the identity the definition sites assume.
  assert.equal(typeof defineTool, 'function');
  assert.equal(defineTool.length, 1);
});
