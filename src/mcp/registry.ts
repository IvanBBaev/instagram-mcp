/**
 * Tool registry & PACKAGES manifest (Layer 2). The single source of truth that
 * turns the tools-as-data surface into MCP registrations. See
 * docs/architecture.md §3 (PACKAGES manifest, `.strict()`, package-selection env
 * vars) and §4 (planned packages).
 *
 * Deliberately decoupled from concrete infrastructure: the tool list and the
 * per-profile request factory are *injected* (see {@link RegisterToolsDeps}), so
 * this module never imports `core/http`, `core/auth`, or `tools/*`. The
 * composition root (`index.ts`) supplies the real implementations; unit tests
 * supply fakes. That keeps registration testable without a live HTTP client and
 * lets the composition root be written in parallel.
 *
 * Resolution order (architecture §3, CC-CFG-7): package profile → deny → forced
 * read-only (from `IG_PACKAGES_READONLY` *and* from an inherently read-only
 * profile such as `reader`), then D1 capability filtering by the auth paths of
 * the configured profiles, then strict argument validation (unknown args are
 * rejected, never dropped — CC-CFG-6; see {@link strictInputSchema}).
 *
 * This is also where per-call observability happens: the wrapper emits one
 * structured `debug` line per invocation, built from the spec's own `logFields`
 * declaration and passed through the secret redactor first (see
 * {@link logInvocation} and QA finding F6). `core/redact.ts` is the only
 * infrastructure import that buys — it is pure and dependency-free, so the
 * "no `core/http`, no `core/auth`, no `tools/*`" rule above still holds.
 *
 * The same redactor also runs over the finished `ToolResult` on its way to the
 * client (CC-PROC-17; see {@link redactResult}). The per-call wrapper is the one
 * choke point every handler's RESULT passes through, so masking there is an
 * enforced control; `mcp/result.ts` is only a set of builders a handler may or
 * may not use, and a control that depends on a builder being called is a
 * convention wearing a control's name. A result is not the only thing a handler
 * can put in front of a user, though — the write gate's confirmation prompt
 * reaches the client through `elicitInput`, on its own path, and does its own
 * scrubbing in `mcp/write-mode.ts`.
 *
 * The same choke point renders the text blocks last: after masking, every
 * invisible character in them is written as a JSON escape (CC-DATA-102; see
 * {@link escapeTextBlocks}). `core/untrusted.ts`, which supplies that rule, is
 * as pure and dependency-free as `core/redact.ts`.
 */
import { z } from 'zod';
import type { ToolAnnotationSet, ToolInputArgs, ToolResult, ToolSpec } from './define.js';
import { errorResult } from './result.js';
import {
  CONFIRM_TIMEOUT_MS,
  type ConfirmPrompt,
  type WriteConfirmer,
  type WriteGateContext,
} from './write-mode.js';
import { InstagramError } from '../core/types.js';
import type { IgRequestFn, Logger, ResolvedProfile, Settings } from '../core/types.js';
import { resolveProfile, withAccount } from '../core/config.js';
import { toInstagramError } from '../core/errors.js';
import { createRedactor } from '../core/redact.js';
import { escapeInvisible } from '../core/untrusted.js';
import type { Clock } from '../core/clock.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

// --- PACKAGES manifest ------------------------------------------------------

/** One package's manifest entry: its name and the tools tagged with it. */
export interface PackageManifest {
  name: string;
  tools: ToolSpec[];
}

/**
 * Group tools by their `package` tag into the PACKAGES manifest. Pure and
 * deterministic: packages are returned in ascending name order, and each
 * package's tools keep their input order. Grouping *by* the tag makes the
 * "every spec matches its manifest entry" invariant hold by construction.
 *
 * @throws InstagramError `kind: 'validation'` for a spec with an empty package.
 */
export function buildManifest(tools: readonly ToolSpec[]): PackageManifest[] {
  const groups = new Map<string, ToolSpec[]>();
  for (const spec of tools) {
    const pkg = typeof spec.package === 'string' ? spec.package.trim() : '';
    if (pkg === '') {
      throw new InstagramError(
        `Tool '${spec.name}' has an empty package tag; every ToolSpec must declare a non-empty package.`,
        { kind: 'validation' },
      );
    }
    const list = groups.get(pkg) ?? [];
    list.push(spec);
    groups.set(pkg, list);
  }

  // The `?? []` arm is unreachable: every name comes from `groups.keys()`, so the
  // lookup always hits. Kept because `Map.get` is typed as possibly-undefined and
  // a non-null assertion here would silently produce a package with
  // `tools: undefined` if the map were ever built elsewhere.
  //
  // The ignore covers that one arm and nothing else. Until 2026-09-23 it was a
  // `start`/`stop` pair around the whole `return`, which also exempted
  // `buildManifest`'s only exit and the arrow that builds each entry — the part
  // every manifest test drives — from all four coverage metrics (CC-PROC-128).
  return [...groups.keys()].sort().map((name) => ({
    name,
    /* c8 ignore next */
    tools: groups.get(name) ?? [],
  }));
}

// --- Package selection ------------------------------------------------------

/**
 * Package profiles for `IG_TOOL_PACKAGES` (architecture §3/§4). Each lists the
 * curated package universe for that profile; selection intersects it with the
 * packages actually present in the manifest, so a profile may name a package
 * that has not shipped yet without error. `all` is handled separately (every
 * package in the manifest). v1 ships six packages: `account`, `media`,
 * `insights`, `publishing`, `comments` and `discovery` — `core` selects all but
 * `discovery`, which therefore ships dark until a profile opts into it.
 *
 * Note that a profile only picks *packages*, and most packages mix read and
 * write tools (`comments` and `media` both carry write tools). A profile that
 * must be read-only is listed in {@link READONLY_PROFILES} as well — the package
 * list alone is not a read-only boundary.
 *
 * Frozen at both levels, and the second level is the one that matters. A single
 * `Object.freeze` on the table refuses `PACKAGE_PROFILES.core = [...]` but says
 * nothing about `PACKAGE_PROFILES.core.push('discovery')` — which is exactly what
 * widening a profile means. Measured 2026-09-23: on a one-level freeze that push
 * SUCCEEDS while `Object.isFrozen(PACKAGE_PROFILES)` still answers `true`, so the
 * shallow spelling passes the obvious test and leaves the tool surface of every
 * server started later in the process open to an importer. The `readonly string[]`
 * in the type is compile-time only and a cast gets past it — the same argument
 * `cli/scopes.ts` makes for `ALWAYS_GRANTED_SCOPES` and `core/host.ts` for the
 * SSRF allowlist.
 */
export const PACKAGE_PROFILES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  core: Object.freeze(['account', 'media', 'publishing', 'comments', 'insights']),
  reader: Object.freeze(['account', 'media', 'insights', 'comments', 'discovery']),
  publisher: Object.freeze(['account', 'media', 'publishing', 'comments']),
});

/**
 * Profiles that are read-only *by definition*, not merely by package choice.
 * Selecting one forces every package it resolves to into the forced-read-only
 * set, exactly as if the operator had also passed `IG_PACKAGES_READONLY`, so no
 * tool lacking `readOnlyHint` is ever registered under it.
 *
 * This exists because the package list is not a safety boundary: `reader`
 * includes `comments` (for `instagram_list_comments` / `instagram_get_comment`)
 * and `media` (for `instagram_list_media`), and both packages also carry write
 * tools — comment create/reply/hide/delete and the media comment toggle. Without
 * this set a deployment configured `IG_TOOL_PACKAGES=reader` would still expose
 * tools that post and delete comments as the operated account, which is not what
 * the profile name promises.
 *
 * A frozen array rather than a `ReadonlySet`, for the reason `cli/scopes.ts`
 * spells `ALWAYS_GRANTED_SCOPES` that way: `ReadonlySet` is a compile-time type
 * that a cast gets past, and `Object.freeze` on a Set would not help either —
 * members live in internal slots rather than own properties, so `.delete()` on a
 * frozen Set succeeds silently even under strict mode while `Object.isFrozen`
 * still answers `true` (measured 2026-09-23). Dropping `reader` from this list at
 * runtime turns a deployment that asked for a read-only profile into one that can
 * post and delete comments as the operated account, so the immutability here has
 * to be the kind that throws. One member, so a linear `includes` is the lookup.
 */
export const READONLY_PROFILES: readonly string[] = Object.freeze(['reader']);

/**
 * Every environment variable {@link selectPackages} reads — the tool-selection
 * half of the recognised `IG_*` namespace. The composition root joins it with
 * the halves `core/settings.ts` and `core/config.ts` own to warn about an `IG_*`
 * name nothing reads (CC-CFG-13). `test/mcp/registry.test.ts` pins it against
 * the names `selectPackages` actually touches.
 */
export const PACKAGE_ENV_NAMES: readonly string[] = Object.freeze([
  'IG_TOOL_PACKAGES',
  'IG_PACKAGES_DENY',
  'IG_PACKAGES_READONLY',
]);

/** Split a comma list into trimmed, lowercased, non-empty tokens. */
function parseList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Resolve the active package names and the forced-read-only package names from
 * the environment, per architecture §3:
 *   `IG_TOOL_PACKAGES` (profile `core` default | `reader` | `publisher` | `all`,
 *   or an explicit comma list of package names)
 *   → minus `IG_PACKAGES_DENY`
 *   → `IG_PACKAGES_READONLY` marked read-only (applied at registration).
 *
 * A profile in {@link READONLY_PROFILES} additionally contributes *all* of its
 * surviving packages to the read-only set, so the profile itself is the
 * boundary rather than a hint the operator has to reinforce by hand.
 *
 * An explicit list naming a package absent from the manifest is a hard error.
 * Deny / read-only names are tolerated when absent (removing or masking a
 * package that is not present is harmless and keeps CC-CFG-7 forward-compatible).
 *
 * @throws InstagramError `kind: 'validation'` for an unknown explicit package.
 */
export function selectPackages(
  manifest: PackageManifest[],
  env: NodeJS.ProcessEnv,
): { active: Set<string>; readonly: Set<string> } {
  const available = new Set(manifest.map((p) => p.name));
  const raw = (env.IG_TOOL_PACKAGES ?? '').trim();
  const selection = raw === '' ? 'core' : raw;
  const lower = selection.toLowerCase();

  let active: Set<string>;
  // `Object.hasOwn`, not `in`: `Object.freeze` keeps the prototype, so `in`
  // would accept inherited keys like `constructor` / `toString` and hand the
  // profile branch a non-array value instead of failing with the clear
  // "unknown package" validation error below.
  // Equivalent-mutant note: dropping `!selection.includes(',')` cannot change
  // the result. It only matters for a selection that DOES contain a comma, and
  // such a string is never `'all'` and can never be an own key of
  // PACKAGE_PROFILES (`core` / `reader` / `publisher`), so the remaining
  // disjunction is already false for every comma-bearing input. The clause is
  // kept because it states the intent — a list is a list — and would still hold
  // if a profile name ever gained a comma; do not contort a test into
  // "killing" it.
  const usesProfile =
    !selection.includes(',') && (lower === 'all' || Object.hasOwn(PACKAGE_PROFILES, lower));
  if (usesProfile) {
    if (lower === 'all') {
      active = new Set(available);
    } else {
      // The `?? []` arm is unreachable, but not for the reason recorded here
      // until 2026-09-23: `usesProfile` is true for `'all'` as well, so the
      // `Object.hasOwn` call it named is not what keeps a missing key out of this
      // line — the enclosing `if (lower === 'all')` above is. What reaches here
      // is a comma-free selection that IS an own key of `PACKAGE_PROFILES`, so
      // the lookup always hits. The arm exists because `noUncheckedIndexedAccess`
      // types it as possibly-undefined, and an empty selection is the safe
      // reading if either guard ever moves.
      const profile =
        /* c8 ignore next */
        PACKAGE_PROFILES[lower] ?? [];
      active = new Set(profile.filter((p) => available.has(p)));
    }
  } else {
    // Explicit comma-separated list of package names.
    const names = parseList(selection);
    for (const name of names) {
      if (!available.has(name)) {
        throw new InstagramError(
          `IG_TOOL_PACKAGES names unknown package '${name}'; available packages: ` +
            `${[...available].sort().join(', ') || '(none)'} ` +
            `(or use a profile: core | reader | publisher | all).`,
          { kind: 'validation' },
        );
      }
    }
    active = new Set(names);
  }

  for (const name of parseList(env.IG_PACKAGES_DENY)) active.delete(name);

  const readonly = new Set(parseList(env.IG_PACKAGES_READONLY));
  // A read-only profile forces every package it still selects read-only, so the
  // profile name is the guarantee (see READONLY_PROFILES). Applied after deny so
  // the two sets stay consistent.
  if (usesProfile && READONLY_PROFILES.includes(lower)) {
    for (const name of active) readonly.add(name);
  }
  return { active, readonly };
}

// --- Registration -----------------------------------------------------------

export interface RegisterToolsDeps {
  server: McpServer;
  tools: readonly ToolSpec[];
  profiles: ResolvedProfile[];
  defaultProfileName: string;
  settings: Settings;
  clock: Clock;
  log: Logger;
  /** The one network seam, per profile. Injected by the composition root so the
   *  registry stays decoupled from core/http + core/auth. */
  makeRequest: (profile: ResolvedProfile) => IgRequestFn;
  env?: NodeJS.ProcessEnv; // defaults to process.env
  /**
   * Human-confirmation seam handed to the write gate (D3 option (a)). Defaults
   * to {@link serverConfirmer} over `server`; tests inject a fake so no real MCP
   * client is needed.
   */
  confirm?: WriteConfirmer;
  /**
   * Secret redactor for everything this registry emits: the per-call `logFields`
   * payload on its way to the log sink (QA finding F6) **and** the finished
   * `ToolResult` on its way to the MCP client (CC-PROC-17). One seam, both
   * sinks — two fields would let an embedder replace one and silently keep the
   * other. Defaults to a real {@link createRedactor}, so redaction is on unless
   * a caller deliberately replaces it; a missing dependency can never silently
   * disable it.
   *
   * This is belt-and-braces on purpose: the composition root already builds the
   * logger with a redactor, but `deps.log` is injected and a test double (or a
   * future embedder) may not redact. `logFields` is author-supplied code whose
   * "never carries secrets" property is a convention, and F6's point is that a
   * convention is not a control. The same reasoning applies to results: no api
   * function is *supposed* to project a token into one, but "supposed to" is
   * spread across every projection in `api/` and every message in
   * `core/errors.ts`.
   */
  redact?: (value: unknown) => unknown;
}

/**
 * Adapt the connected MCP server to the write gate's {@link WriteConfirmer}.
 *
 * Both halves are evaluated per call, not at registration: client capabilities
 * only exist after the `initialize` handshake, which happens after
 * {@link registerTools} has run.
 *
 * `isSupported()` is true only for **form** elicitation — the SDK normalizes a
 * legacy `elicitation: {}` declaration to `{ form: {} }`, while a client that
 * advertises only `elicitation.url` cannot answer this prompt and so falls back
 * to env flags rather than having every write refused. The server object is
 * treated as `Partial` because tests (and the stateless HTTP path) may hand over
 * a stub that has no underlying `Server` at all.
 */
export function serverConfirmer(server: McpServer): WriteConfirmer {
  const inner: Partial<Server> | undefined = server.server;
  return {
    isSupported(): boolean {
      if (typeof inner?.elicitInput !== 'function') return false;
      const caps = inner.getClientCapabilities?.();
      return caps?.elicitation?.form !== undefined;
    },
    async ask(prompt: ConfirmPrompt) {
      if (typeof inner?.elicitInput !== 'function') {
        // Unreachable through the gate (isSupported() guards it); throwing keeps
        // the seam total and fails closed if that ever changes.
        throw new InstagramError('The connected client cannot be asked to confirm this write.', {
          kind: 'permission',
        });
      }
      return inner.elicitInput(
        { mode: 'form', message: prompt.message, requestedSchema: prompt.requestedSchema },
        // Bound both budgets: `timeout` alone can be extended indefinitely by a
        // client that keeps sending progress notifications.
        { timeout: CONFIRM_TIMEOUT_MS, maxTotalTimeout: CONFIRM_TIMEOUT_MS },
      );
    },
  };
}

/**
 * Structural view of the one `McpServer` method the registry drives. The tool
 * callback is re-validated internally, so its args are `unknown` here and the
 * result is our {@link ToolResult} (a subset of the SDK `CallToolResult`).
 * `deps.server` is reached through this shape so tests can pass a small stub.
 *
 * `inputSchema` is deliberately a built **`ZodObject`**, not a `z.ZodRawShape` —
 * see {@link strictInputSchema} for why that distinction is the whole of
 * CC-CFG-6. The SDK's own signature accepts either (`inputSchema?:
 * ZodRawShapeCompat | AnySchema`), and only the object form preserves
 * `.strict()`.
 */
interface ToolRegistrar {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: z.AnyZodObject;
      outputSchema?: z.ZodRawShape;
      annotations?: ToolAnnotationSet;
    },
    cb: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>,
  ): unknown;
}

/**
 * The framework-injected multi-account selector added to every tool's input
 * schema (architecture §6). Optional; absent means the default profile.
 *
 * `.trim()` before `.min(1)`: a whitespace-only name (`'   '`) is not a profile
 * either, yet it would pass a bare `.min(1)` and then be BLANK to
 * `resolveProfile`, whose blank fallback is the literal `default` profile — not
 * `deps.defaultProfileName` (`IG_ACTIVE_PROFILE`). A write meant for the active
 * account would silently land on `default`. Trimmed, it fails `.min(1)` with the
 * same validation message as `''`, and a padded real name (`' work '`) resolves
 * as `work`, which is what `resolveProfile` would have made of it anyway. The
 * published JSON schema is unchanged (`trim` renders to nothing).
 */
const accountField = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Name of the configured account profile to operate as (multi-account). Omit to use the ' +
      'default profile (IG_ACTIVE_PROFILE).',
  );

/**
 * Build the closed input schema handed to the MCP server for one tool: the
 * spec's shape plus the injected `account` selector, sealed with `.strict()`.
 *
 * **This function is CC-CFG-6.** The MCP SDK validates tool arguments *itself*,
 * before our callback ever runs, and what it validates against is whatever
 * `registerTool` was given:
 *
 *   - `server/mcp.js` `validateToolInput()` calls
 *     `normalizeObjectSchema(tool.inputSchema)` and parses with the result,
 *     handing our callback `parseResult.data`.
 *   - `server/zod-compat.js` `normalizeObjectSchema()` detects a **raw shape**
 *     (no `_def`/`_zod`) and wraps it with `objectFromShape()`, a plain
 *     `z.object(shape)` — *non-strict*, so zod **strips** unknown keys.
 *   - The same function returns an already-built `ZodObject` **unchanged**.
 *
 * So passing a raw shape means our callback can never see an unknown key: the
 * SDK has already deleted it, and any `.strict()` re-parse inside the callback
 * is guaranteed to pass. Passing the built strict object instead makes the SDK
 * enforce the closed schema, which is what the invariant actually promises.
 *
 * The cost is that the rejection is then raised by the SDK
 * (`McpError(InvalidParams, "Input validation error: Invalid arguments for tool
 * <name>: <zod message>")`) rather than by our wrapper, so the result no longer
 * carries our `errorResult()` envelope. The `errorMap` below buys the *message*
 * back: zod consults a schema-bound error map when it raises the
 * `unrecognized_keys` issue, and the SDK renders that message verbatim after
 * its own "for tool <name>" prefix. A client therefore still reads
 *
 *   Input validation error: Invalid arguments for tool instagram_get_media:
 *   unknown argument(s) [bogus]; valid arguments: mediaId, fields, account.
 *
 * i.e. it still names the offending keys *and* the valid ones. The map only
 * covers root-level object issues — nested field issues carry their own
 * schemas' (default) messages, which the SDK already renders with a path.
 */
/**
 * Render the "valid arguments" list carried by every rejection message.
 *
 * The `(none)` fallback is defensive only: {@link registerOne} always folds the
 * injected `account` selector into the shape, so a registered tool's key list
 * is never empty even for a tool that declares no inputs of its own.
 *
 * Equivalent-mutant note: swapping `||` for `??` here is unobservable.
 * `Array.prototype.join` always returns a string, so the right operand is only
 * reachable for the empty-string result of an empty key list — and that list is
 * never empty, as the paragraph above explains. `??` therefore selects the same
 * branch as `||` for every input this function can actually receive; do not
 * contort a test into "killing" it.
 */
// The `(none)` arm is unreachable while `account` is injected. The ignore covers
// that arm alone: `next 3` spanned the declaration, the `return` and the closing
// brace, so a function every strict-schema test calls counted as neither called
// nor returned (CC-PROC-128).
function validArgList(validKeys: string[]): string {
  return (
    /* c8 ignore next */
    validKeys.join(', ') || '(none)'
  );
}

function strictInputSchema(shape: z.ZodRawShape): z.AnyZodObject {
  const validKeys = Object.keys(shape);
  return z
    .object(shape, {
      errorMap: (issue, ctx) => {
        if (issue.code === z.ZodIssueCode.unrecognized_keys) {
          return {
            message:
              `unknown argument(s) [${issue.keys.join(', ')}]; ` +
              `valid arguments: ${validArgList(validKeys)}.`,
          };
        }
        return { message: ctx.defaultError };
      },
    })
    .strict();
}

/** Build the human message for a strict-schema rejection (CC-CFG-6). */
function validationMessage(spec: ToolSpec, error: z.ZodError, validKeys: string[]): string {
  const unknownKeys: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') unknownKeys.push(...issue.keys);
  }
  const valid = validArgList(validKeys);
  if (unknownKeys.length > 0) {
    return `Unknown argument(s) [${unknownKeys.join(', ')}] for tool '${spec.name}'; valid arguments: ${valid}.`;
  }
  const detail = error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return `Invalid arguments for tool '${spec.name}': ${detail}.`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Emit the one structured log line per tool invocation.
 *
 * `ToolSpec.logFields` is the tools-as-data declaration of "what is safe to log
 * about this call"; until this function existed nothing ever called it, so the
 * server produced no per-tool trace at all. The line is emitted as soon as the
 * arguments have been validated — before the handler runs — so an invocation is
 * recorded even if the handler then hangs, throws, or is refused by the
 * capability guard. Every tool gets a line (`tool` and `account` ride on the
 * child bindings); a spec that declares no `logFields` simply contributes no
 * extra fields.
 *
 * Level is **debug**, matching the house convention for per-call operational
 * detail (`core/http.ts` logs `'graph request'` at debug); `info` is reserved
 * for lifecycle events such as `'tools registered'` and `'mcp server ready'`.
 *
 * Two safety properties:
 *
 * 1. **Redacted.** The payload goes through `redact` before it reaches the sink
 *    (F6). `logFields` is documented never to carry secrets, but this makes it
 *    an enforced property rather than a review promise.
 * 2. **Cannot fail the call.** `logFields` is author-supplied code and the sink
 *    is injected; either may throw. A logging failure must never fail a user's
 *    request, so everything here is contained — a throw degrades to a warning,
 *    and a sink that throws too is swallowed because there is nowhere left to
 *    report it.
 */
function logInvocation(
  spec: ToolSpec,
  args: ToolInputArgs<z.ZodRawShape>,
  log: Logger,
  redact: (value: unknown) => unknown,
): void {
  try {
    const produced = spec.logFields?.(args);
    // A spec may return a non-record (or nothing); the line is still emitted so
    // the invocation itself is never lost.
    const safe = redact(isPlainRecord(produced) ? produced : {});
    log.debug('tool invoked', isPlainRecord(safe) ? safe : {});
  } catch (err) {
    try {
      log.warn('tool log fields could not be built; the tool call is unaffected', {
        error: String(redact(err instanceof Error ? err.message : String(err))),
      });
    } catch {
      // The log sink itself is broken. Swallowing is the only option that keeps
      // the promise above: a logging failure never fails the tool call.
    }
  }
}

/**
 * True for a value that still has the shape of a {@link ToolResult}: a plain
 * record carrying a `content` array. Used to check what the redactor handed
 * back before it is returned to the client as a result.
 */
function isToolResultShape(value: unknown): value is ToolResult {
  return isPlainRecord(value) && Array.isArray(value.content);
}

/**
 * Mask secrets in the finished result of a tool call — CC-PROC-17.
 *
 * **Why here.** No known path puts a token into a result today: `core/http.ts`
 * keeps the access token in the query string and logs the path only,
 * `core/errors.ts` builds its message from Meta's own text and never from the
 * request URL or the raw body, and every `api/` function projects the wire
 * response into a narrow shape. But that is a property upheld by a convention
 * spread over a dozen files, each of which has to keep it independently. This
 * makes it one control in one place, and it must sit here rather than in
 * `mcp/result.ts`: the builders there are optional (a handler can return a
 * literal), while this wrapper is the only route a handler's result takes to a
 * client.
 *
 * **What it covers.** The whole envelope, on every path out of {@link registerOne}
 * — the text content and `structuredContent`, on success and on error alike.
 * That includes Instagram-supplied text (captions, comments, usernames) echoed
 * back in a success payload, which no other layer inspects.
 *
 * **A JSON body is redacted as a value, not as its text (CC-DATA-104).** By
 * the time this runs, `mcp/result.ts` `json()` has flattened the payload into
 * the text block, and masking that text as a string misses three things. Every
 * C0 control is an escape by then (`\n`, `\t`, `\b`, `\u00XX`), each ending in
 * a word character, so a 64-hex token right behind one has no `\b` boundary
 * left and the backstop passes it — `\b`, `\f` and a `\u` tail even glue their
 * last letter onto the hex run. A registered secret holding `"`, `\` or a
 * control is spelled differently in the text than it was registered. And no
 * object keys are left, so masking by key NAME never reached the text. So
 * before the whole result is masked, {@link redactJsonBodies} parses each text
 * block back, and one that is byte for byte its own `JSON.stringify` rendering
 * (compact or two-space, the two `json()` writes) is redacted as the value and
 * serialized again in the same spelling. That is not guessing at a block's
 * meaning: only a block that round-trips exactly is touched, so the text still
 * parses to `structuredContent`, both redacted by the same function. Any other
 * text — error prose, a hand-built literal — is masked as a string, as before.
 *
 * **What it costs, stated plainly.** `core/redact.ts` prefers over-redaction to
 * under-redaction, so legitimate content that is genuinely token-shaped — a
 * 20+-character run after a literal `IG`/`EAA`, a bare 64-hex string — is
 * masked. Ordinary captions, `@handles`, `#hashtags`, permalinks, timestamps
 * and the numeric ids this server traffics in are all unaffected (they are far
 * from those shapes), and that boundary is pinned by tests. The redactor also
 * deep-clones, so the result reaching the client is a copy: a handler cannot
 * hand the client a live object and expect identity to survive.
 *
 * **Failure is closed.** `redact` is an injected seam typed `unknown`. If it
 * returns something that is no longer a result, the original — which was never
 * masked — must not be sent as a fallback, so the call is reported as an error
 * instead. A throw is the same failure, not a different one: the default
 * redactor recurses, so a JSON body nested deeper than it can follow throws
 * `RangeError`, and an uncaught throw would reach the client as the SDK's
 * rendering of the exception message, unredacted (CC-DATA-108).
 */
function redactResult(result: ToolResult, redact: (value: unknown) => unknown): ToolResult {
  let masked: unknown;
  try {
    const decoded = redactJsonBodies(result, redact);
    masked = decoded === undefined ? undefined : redact(decoded);
  } catch {
    // Not rethrown: the SDK would render the exception's own message, a text
    // no redactor has seen, as the result (CC-DATA-108). `masked` is still
    // `undefined` here, so the shape check below withholds the result.
  }
  if (isToolResultShape(masked)) return masked;
  return errorResult(
    new InstagramError(
      'The tool result was withheld: the secret redactor did not return a usable result.',
      { kind: 'upstream' },
    ),
  );
}

/**
 * The indentation `JSON.stringify` wrote `text` with, and the value it wrote —
 * or `undefined` when `text` is not exactly one of the two renderings
 * `json()` produces (`0` compact, `2` pretty). The exact comparison is what
 * keeps a prose block that happens to parse from being reformatted.
 */
function jsonBody(text: string): { value: unknown; indent: 0 | 2 } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (JSON.stringify(value) === text) return { value, indent: 0 };
  if (JSON.stringify(value, null, 2) === text) return { value, indent: 2 };
  return undefined;
}

/**
 * The result with every JSON-body text block replaced by the serialization of
 * its redacted value (see {@link redactResult}); `undefined` when the redactor
 * returns something for a body that no longer serializes, so the caller fails
 * closed rather than falling back to the unmasked text.
 */
function redactJsonBodies(
  result: ToolResult,
  redact: (value: unknown) => unknown,
): ToolResult | undefined {
  const content: ToolResult['content'] = [];
  for (const block of result.content) {
    const body = typeof block.text === 'string' ? jsonBody(block.text) : undefined;
    if (body === undefined) {
      content.push(block);
      continue;
    }
    const masked = JSON.stringify(redact(body.value), null, body.indent) as string | undefined;
    if (masked === undefined) return undefined;
    content.push({ ...block, text: masked });
  }
  return { ...result, content };
}

/**
 * Render every text block of the finished result with no invisible character
 * left raw — CC-DATA-102, the text half of the rule in docs/security.md §7.
 *
 * `structuredContent` is data and is left exactly as the handler built it: a
 * caption keeps its ZWJ emoji sequences and its right-to-left marks, an id or a
 * cursor round-trips. The text block is what a client hands to the model, and
 * `JSON.stringify` leaves DEL, C1, bidi overrides, zero-width characters, tag
 * characters and U+2028/U+2029 raw inside a string — so a wire value could
 * reorder what the model reads, hide instructions in characters no human
 * reviewer sees, or break the line and forge an `Instagram error (auth): …`
 * frame of its own. {@link escapeInvisible} writes each of them as a JSON
 * `\uXXXX` escape, which leaves a JSON body parsing to the same value as
 * `structuredContent`.
 *
 * **Why here, and why after the redactor.** For the reason {@link redactResult}
 * gives: this wrapper is the only route to a client, while `json()` is a
 * builder a handler may skip. And the order matters: the token-shape backstop
 * `\b[a-f0-9]{64}\b` needs a word boundary, which a raw zero-width space in
 * front of a secret provides and its six-character escape (ending in the word
 * character `b`) would not — so masking runs on the raw text first.
 *
 * A block whose `text` is not a string (only an injected redactor can produce
 * one) is passed on untouched rather than stringified.
 */
function escapeTextBlocks(result: ToolResult): ToolResult {
  return {
    ...result,
    content: result.content.map((block) =>
      typeof block.text === 'string' ? { ...block, text: escapeInvisible(block.text) } : block,
    ),
  };
}

/** Register one surviving tool on the server with its strict per-call wrapper. */
function registerOne(
  registrar: ToolRegistrar,
  deps: RegisterToolsDeps,
  spec: ToolSpec,
  confirm: WriteConfirmer,
  redact: (value: unknown) => unknown,
): void {
  const shape: z.ZodRawShape = { ...spec.input, account: accountField };
  const strictSchema = strictInputSchema(shape);
  const validKeys = Object.keys(shape);

  const config: {
    title?: string;
    description?: string;
    inputSchema?: z.AnyZodObject;
    outputSchema?: z.ZodRawShape;
    annotations?: ToolAnnotationSet;
  } = {
    title: spec.title,
    description: spec.description,
    // The *built strict object*, never the raw shape — see strictInputSchema.
    inputSchema: strictSchema,
    annotations: spec.annotations,
  };
  // `outputSchema` stays a raw shape: the SDK wraps it the same way for both
  // the published JSON Schema and the structuredContent check, and a closed
  // *output* schema would only make our own results harder to evolve.
  if (spec.output !== undefined) config.outputSchema = spec.output;

  const invoke = async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
    // 1. Strict parse. Against a real McpServer this is a second line of
    //    defense — the SDK has already parsed with this exact schema and
    //    rejected unknown keys (strictInputSchema). It stays because
    //    `ToolRegistrar` is a seam: a stub registrar, an embedder calling the
    //    callback directly, or a future SDK that stops validating would
    //    otherwise leave the invariant unenforced. It also keeps the richer
    //    `errorResult()` envelope on the paths where it *can* fire.
    const parsed = strictSchema.safeParse(rawArgs);
    if (!parsed.success) {
      // Equivalent-mutant note: dropping `cause: parsed.error` below is not
      // observable. The error object never leaves this expression — it is
      // handed straight to `errorResult`, which renders only `kind` and
      // `message` into the text and the structured payload and is documented
      // never to render a cause. Nothing logs it either: this branch returns
      // before the handler runs. The cause is carried for a debugger attached
      // to a live process; do not contort a test into "killing" it.
      return errorResult(
        new InstagramError(validationMessage(spec, parsed.error, validKeys), {
          kind: 'validation',
          cause: parsed.error,
        }),
      );
    }
    const args = parsed.data as Parameters<typeof spec.handler>[0];

    // 2. Resolve the profile inside the active-account context so nested code
    //    (currentAccount()) sees the right account.
    //    Equivalent-mutant note: `??` cannot be distinguished from `||` here.
    //    The two operators differ only on a falsy-but-not-nullish left side, and
    //    the only such value for a string is `''`. `args` is `parsed.data`, so
    //    `account` has already passed `accountField` (`z.string().trim().min(1)`) —
    //    `''` (and, trimmed, any whitespace-only string) fails that parse and
    //    returns above, at the `!parsed.success` branch, before this line runs. The injected selector also wins the
    //    shape merge (`{ ...spec.input, account: accountField }`), so no spec
    //    can loosen it. Nothing can reach this expression with an empty string;
    //    do not contort a test into "killing" it.
    const name = args.account ?? deps.defaultProfileName;
    return withAccount(name, async () => {
      const log = deps.log.child({ tool: spec.name, account: name });
      // 2a. One structured line per invocation, from the spec's own `logFields`
      //     declaration. Never throws; see logInvocation.
      //     Equivalent-mutant note: moving this call inside the `try` below is
      //     not observable. The only thing the `try` adds is the catch that maps
      //     a throw to `errorResult`, and `logInvocation` is total — it wraps
      //     the `logFields` call, the redactor and the sink, and its inner catch
      //     swallows even a sink that throws while reporting the first failure
      //     (that containment is itself pinned by four tests). Relative order
      //     against `resolveProfile` is unchanged either way, so no observer —
      //     the sink, the result, or the account context — can tell the two
      //     placements apart; do not contort a test into "killing" it.
      logInvocation(spec, args, log, redact);
      try {
        const profile = resolveProfile(deps.profiles, name);

        // 3. Call-time capability guard (defense in depth — filtering already
        //    excluded a mismatched tool at registration).
        //    Equivalent-mutant note: the `' or '` separator below cannot be
        //    distinguished from `', '`. It is only visible with two or more
        //    entries in `spec.paths`, and `AuthPath` is the closed two-member
        //    union `'ig-login' | 'fb-login'` — a two-entry `paths` therefore
        //    contains every possible `profile.authPath`, so this branch is
        //    unreachable whenever more than one path is listed. Only the
        //    single-entry case can reach the message, and `join` emits no
        //    separator for it; do not contort a test into "killing" it.
        if (spec.paths !== undefined && !spec.paths.includes(profile.authPath)) {
          return errorResult(
            new InstagramError(
              `Tool '${spec.name}' is not available on the '${profile.authPath}' auth path ` +
                `(profile '${name}'); it requires ${spec.paths.join(' or ')}.`,
              { kind: 'permission' },
            ),
          );
        }

        // 4. Build the per-call context (the request and confirmation seams are
        //    injected). `confirm` is only read by the write gate; read tools
        //    never see it.
        const ctx: WriteGateContext = {
          req: deps.makeRequest(profile),
          settings: deps.settings,
          clock: deps.clock,
          profile,
          log,
          confirm,
        };

        // 5. Run the handler; it returns a ready ToolResult.
        return await spec.handler(args, ctx);
      } catch (err) {
        // 6. Handlers may throw; the registry renders it as an error result.
        return errorResult(toInstagramError(err));
      }
    });
  };

  // 7. Mask secrets in whatever came back, on every one of the paths above —
  //    CC-PROC-17, see redactResult. This wrapper, not the builders in
  //    `mcp/result.ts`, is the enforced control: a handler may return a
  //    `ToolResult` literal and never call a builder, but nothing reaches a
  //    client except through here.
  // 8. Then escape the invisible characters in every text block — CC-DATA-102,
  //    see escapeTextBlocks. After the redactor, never before it.
  const cb = async (rawArgs: Record<string, unknown>): Promise<ToolResult> =>
    escapeTextBlocks(redactResult(await invoke(rawArgs), redact));

  registrar.registerTool(spec.name, config, cb);
}

/**
 * Register every surviving tool on the server: build the manifest, resolve the
 * active packages / forced-read-only set, filter by auth path (D1) and by forced
 * read-only, and register the rest. Returns the names actually registered (for
 * logging + tests) and the manifest.
 *
 * D1 filtering uses the **union** of the auth paths of every configured profile,
 * not just the default one: a tool is reachable as long as *some* profile can
 * run it, because callers select the profile per call via the `account`
 * argument. Filtering on the default profile alone would hide, say, the
 * Path-B-only `discovery` tools from a client whose default profile is Path A
 * even when a Path B profile is configured alongside it. A call that pairs a
 * tool with a profile that cannot run it is still rejected by the call-time
 * capability guard in {@link registerOne} with an explicit message.
 */
export function registerTools(deps: RegisterToolsDeps): {
  registered: string[];
  manifest: PackageManifest[];
} {
  const env = deps.env ?? process.env;
  const manifest = buildManifest(deps.tools);
  const { active, readonly } = selectPackages(manifest, env);
  // Fail fast on a default profile that does not exist (a configuration error),
  // then filter against every path any configured profile can reach.
  resolveProfile(deps.profiles, deps.defaultProfileName);
  const authPaths = new Set(deps.profiles.map((p) => p.authPath));
  const registrar = deps.server as unknown as ToolRegistrar;
  const confirm = deps.confirm ?? serverConfirmer(deps.server);
  // Built once and shared by every registration: `createRedactor` reads the
  // global secret registry live on each call, so a redactor made here still
  // masks tokens minted (and registered) later at runtime.
  const redact = deps.redact ?? createRedactor();

  const registered: string[] = [];
  for (const pkg of manifest) {
    if (!active.has(pkg.name)) continue;
    const forceReadonly = readonly.has(pkg.name);
    for (const spec of pkg.tools) {
      // D1 capability filtering: `paths === undefined` means both auth paths;
      // otherwise keep the tool when any configured profile is on one of them.
      if (spec.paths !== undefined && !spec.paths.some((p) => authPaths.has(p))) continue;
      // Forced read-only: drop any non-read-only tool in the package.
      if (forceReadonly && spec.annotations.readOnlyHint !== true) continue;
      registerOne(registrar, deps, spec, confirm, redact);
      registered.push(spec.name);
    }
  }

  return { registered, manifest };
}
