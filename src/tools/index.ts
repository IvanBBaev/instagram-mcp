/**
 * Tool-package barrel (Layer 3). Aggregates every domain package's tool surface
 * into one ordered, frozen `readonly ToolSpec[]` for `mcp/registry.ts` to
 * register. The surface spans read-only packages (account, media, insights,
 * discovery) and the write packages (publishing, comments) that pass every
 * mutation through the frozen `mcp/write-mode` gate. Adding a package = one
 * import + one spread here (keep the array order stable so the exposed tool
 * list is deterministic).
 *
 * Import boundary: tool packages only — never `api/*`, `core/http`, or `mcp/*`
 * beyond the shared `ToolSpec` type re-exported from `define.ts`.
 */
import type { ToolSpec } from '../mcp/define.js';
import { accountTools } from './account.js';
import { mediaTools } from './media.js';
import { insightsTools } from './insights.js';
import { publishingTools } from './publishing.js';
import { commentsTools } from './comments.js';
import { discoveryTools } from './discovery.js';

/**
 * Freeze one spec on its way onto the published surface: the spec object, its
 * annotations, and its input/output shapes.
 *
 * `defineTool` deliberately leaves a spec extensible — pinned, in that
 * direction, by `test/mcp/define.test.ts` — because definition sites build
 * specs up and a future decorator would tag them there. This is the other end
 * of that split: publication is where editing stops. The reason is a security
 * boundary, not tidiness. `mcp/registry.ts` decides the forced-read-only
 * surface with `spec.annotations.readOnlyHint !== true`, and `readOnlyHint` is
 * an optional field on a plain object, so before this freeze two property
 * writes from anything that could reach a spec turned a deployment that asked
 * for `reader` into one that hides and deletes comments as the operated
 * account (measured 2026-09-23 — CC-CFG-34). The `readonly` in the type below
 * does not stop that on its own: it is erased at emit, exactly as CC-CFG-32
 * records for `PACKAGE_PROFILES`.
 *
 * The depth stops at the shapes. `input` and `output` hold zod schema
 * instances, and zod memoises on the instance, so freezing a schema would turn
 * the library's own bookkeeping into a `TypeError` thrown from inside zod.
 * Freezing the record blocks the mutation that matters here — swapping, adding
 * or deleting a field of a registered tool's schema — and leaves zod alone.
 *
 * `Object.freeze` returns a non-object argument unchanged rather than throwing,
 * so the optional `output` needs no guard and this function has no branches.
 */
function publish(spec: ToolSpec): ToolSpec {
  Object.freeze(spec.annotations);
  Object.freeze(spec.input);
  Object.freeze(spec.output);
  return Object.freeze(spec);
}

/*
 * Equivalent-mutant note: five mutations of this module survive the whole suite
 * because none of them changes what the module computes.
 *
 * 1. The six spreads rewritten as `accountTools.concat(mediaTools, ..., discoveryTools)`
 *    builds a distinct array holding the identical spec objects in the identical order
 *    (verified by reference equality against the spread form), which `.map(publish)` then
 *    freezes one for one. Only the syntax moves.
 * 2. Dropping the trailing comma after the last spread is one character of source
 *    formatting; the array literal it emits is the same six spreads. Unlike 4 and
 *    5 the emit is not byte-identical: tsc preserves the comma, so this one is a
 *    one-byte diff (measured 2026-09-23: 4408 -> 4407 bytes, the sole hunk being
 *    the comma itself).
 * 3. `const` -> `let`. Nothing here or in any importer assigns to `allTools`, and an ESM
 *    import binding is read-only at the consumer either way, so no reachable code path can
 *    observe the difference. Held by the linter, not by a test.
 * 4. Deleting the `: readonly ToolSpec[]` annotation is type erasure: tsc infers
 *    `readonly ToolSpec[]` from `Object.freeze` over the spreads and emits byte-identical JS.
 * 5. `import type { ToolSpec }` -> `import { ToolSpec }`. `ToolSpec` is used only in type
 *    position and this build sets neither `verbatimModuleSyntax` nor `isolatedModules`, so
 *    TypeScript elides the import and emits byte-identical JS.
 *
 * Every mutation that does change the surface — a dropped, duplicated, reordered, sliced or
 * cross-wired spread — is killed by `test/tools/index.test.ts` (plus the registry manifest
 * snapshot and the README drift guard). Widening the element type (`unknown[]`) is caught by
 * tsc at `src/index.ts`, where `RegisterToolsDeps.tools` names `readonly ToolSpec[]`.
 * Narrowing the declaration back to a mutable `ToolSpec[]` is caught by tsc here, because
 * `Object.freeze` hands back a `readonly` array; dropping the `Object.freeze` call itself is
 * caught the same way, and then by the freeze assertions in `test/tools/index.test.ts`.
 */
/** The complete v1 tool surface, in a stable, deterministic order. */
export const allTools: readonly ToolSpec[] = Object.freeze(
  [
    ...accountTools,
    ...mediaTools,
    ...insightsTools,
    ...publishingTools,
    ...commentsTools,
    ...discoveryTools,
  ].map(publish),
);
