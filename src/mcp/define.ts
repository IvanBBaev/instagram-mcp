/**
 * ToolSpec contract (Layer 2 seam). FROZEN at Gate G1. Every tool is a
 * `ToolSpec` object (tools-as-data); `tools/` files export these and `mcp/
 * registry.ts` turns them into MCP registrations. See docs/architecture.md §3.
 */
// Equivalent-mutant note: dropping `type` from this import (`import { z } from 'zod'`)
// cannot be observed. `z` is referenced only in type positions in this file, so TypeScript
// elides the binding either way and the emitted JavaScript is byte-identical — there is no
// runtime import to detect and no type-check difference to assert on.
import type { z } from 'zod';
import type {
  AuthPath,
  HashtagBudgetLedger,
  IgRequestFn,
  Logger,
  ProfileSummary,
  ResolvedProfile,
  SecretRegistry,
  SemaphoreRegistry,
  Settings,
} from '../core/types.js';
import type { Clock } from '../core/clock.js';

/**
 * MCP tool annotations surfaced to clients for permission UX.
 *
 * Equivalent-mutant note: writing `ToolSpec.annotations` as `Partial<ToolAnnotationSet>`
 * is unobservable, because every member below is already optional — `Partial` is the
 * identity mapping over this type, so both spellings accept and produce exactly the same
 * values and no assertion can separate them.
 */
export interface ToolAnnotationSet {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /** Always true here — every tool hits a remote API. */
  openWorldHint?: boolean;
}

export interface ToolTextContent {
  type: 'text';
  text: string;
}

/**
 * Equivalent-mutant note: `ToolContent` is a bare alias, so restating `ToolResult.content`
 * as `ToolTextContent[]` names the identical type. The alias exists to mark the extension
 * point for future content kinds (image, resource); until a second member joins the union
 * the two spellings are the same type and nothing can tell them apart.
 */
export type ToolContent = ToolTextContent;

/** MCP `CallToolResult` subset the handlers produce. */
export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * A tool's zod raw shape: field name to a *classic* zod schema. zod 4's own
 * `z.ZodRawShape` is a readonly map of core `$ZodType`s, which hides the classic
 * API (`.description`, `.safeParse`) from everything that reads a spec's fields.
 */
export type ToolShape = Record<string, z.ZodType>;

/**
 * Parsed handler args: the tool's declared input plus the framework-injected
 * `account` selector (multi-profile). Write tools additionally see `apply`.
 */
export type ToolInputArgs<S extends ToolShape> = z.infer<z.ZodObject<S>> & {
  account?: string;
  apply?: boolean;
};

// --- 3.0 ports (contract bump V3-01) ----------------------------------------

/**
 * One applied write, as the write gate journals it (`mcp/write-mode.ts`). The
 * members and their order are today's journal line, plus `identity`.
 *
 * The gate passes the entry through its redactor BEFORE {@link WriteJournal.append}
 * sees it, so every backend sits inside the same secret boundary as the log
 * stream (F6) without redacting anything itself.
 */
export interface WriteJournalEntry {
  /** ISO-8601 time of the write, from `ctx.clock`. */
  ts: string;
  /** The intent's machine verb, e.g. `publish_media`. */
  action: string;
  /** Profile name the write ran as (`ctx.profile.name`). */
  account: string;
  authPath: AuthPath;
  summary: string;
  /** Id of the object written, when the tool reported one. */
  targetId?: string;
  /** Outcome of a write whose action admits more than one. */
  status?: string;
  destructive: boolean;
  /**
   * WHO asked for the write: {@link ToolContext.identity}. Absent for the local
   * single operator — every call today — so an entry without it is byte-for-byte
   * today's journal line. "Multi-account" (one operator, many profiles) never
   * sets it; only a multi-tenant embedder does.
   */
  identity?: string;
}

/**
 * The applied-write journal port (V3-S2 moves the gate onto it). The default,
 * used whenever {@link ToolContext.journal} is absent, is today's append-only
 * JSONL file at `settings.writeJournal` (0700 directory, 0600 file).
 */
export interface WriteJournal {
  /**
   * Record one applied write. Best-effort by contract: the gate catches a
   * throw or a rejection and logs a warning — the write has already happened,
   * so a broken journal never turns it into an error result.
   */
  append(entry: Readonly<WriteJournalEntry>): void | Promise<void>;
}

/**
 * A read-only view of every configured profile, for tools that work across
 * accounts (multi-account fan-out, V3-F1). It lists profiles without any
 * secret; a tool that needs to act as one asks for that profile's context.
 */
export interface ProfileDirectory {
  /** The profile a call without `account` uses. */
  readonly defaultName: string;
  /** Every configured profile, default first, with no token or app secret. */
  list(): readonly ProfileSummary[];
  /**
   * The context the registry would have built had this call passed
   * `account: name` — that profile's `req`, `profile` and journal, the same
   * settings, clock and singletons, and any write-gate seams the registry
   * attaches (so `withWriteGate` gates each profile on its own). Lookup and
   * errors follow `resolveProfile`. The D1 auth-path check is NOT applied: a
   * caller filters on {@link ProfileSummary.authPath} first.
   */
  contextFor(name: string): Promise<ToolContext>;
}

/**
 * Per-call dependencies handed to every tool handler. Resolved by the registry
 * from the active profile + config; domain code takes what it needs and stays
 * decoupled from how these are built. `req` is the only network seam.
 *
 * The five required members are the Gate-G1 contract. The optional ones were
 * added by the 3.0 contract bump (V3-01) and are OPTIONAL so that no existing
 * handler, test or context literal changes: an absent member means exactly
 * today's behaviour (the process-wide singleton, the file journal, no
 * cross-profile view). V3-S1 (singletons), V3-S2 (journal, identity) and V3-F1
 * (profiles) make the registry populate them.
 */
export interface ToolContext {
  req: IgRequestFn;
  settings: Settings;
  profile: ResolvedProfile;
  clock: Clock;
  log: Logger;
  /**
   * Non-secret principal the call is made for, journaled as
   * {@link WriteJournalEntry.identity}. Absent = the local single operator.
   * Never a token or any value that grants access.
   */
  identity?: string;
  /** Applied-write journal. Absent = the JSONL file at `settings.writeJournal`. */
  journal?: WriteJournal;
  /** Every configured profile, secret-free. Absent = this call sees only `profile`. */
  profiles?: ProfileDirectory;
  /** Advisory hashtag-search counter. Absent = the module-level one in `tools/discovery.ts`. */
  hashtagBudget?: HashtagBudgetLedger;
  /**
   * Per-host concurrency counters `req` was built over. Handlers never call it;
   * it travels so a context derived from this one (`profiles.contextFor`)
   * shares the same process budget. Absent = the shared registry in `core/http.ts`.
   */
  semaphores?: SemaphoreRegistry;
  /**
   * Secret registry for a handler that mints a secret mid-call. Absent = the
   * module-level registry in `core/redact.ts`.
   */
  secrets?: SecretRegistry;
}

export interface ToolSpec<S extends ToolShape = ToolShape> {
  /** `instagram_<verb>_<noun>`. */
  name: string;
  title: string;
  /** Model-facing; states Graph semantics honestly. */
  description: string;
  /** Registry package tag (must match its PACKAGES manifest entry). */
  package: string;
  /**
   * D1 capability matrix: auth paths this tool is valid for. `undefined` =
   * both. The registry filters the surface and a call-time guard enforces it.
   */
  paths?: AuthPath[];
  annotations: ToolAnnotationSet;
  /** zod raw shape; every field `.describe()`d. Registered with `.strict()`. */
  input: S;
  /** structuredContent schema where the shape is stable. */
  output?: ToolShape;
  /** Fields safe to log — never secrets. */
  logFields?: (args: ToolInputArgs<S>) => Record<string, unknown>;
  handler: (args: ToolInputArgs<S>, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
}

/**
 * Identity helper preserving the generic `S` at definition sites.
 *
 * Equivalent-mutant note: rewriting this declaration as an arrow constant
 * (`export const defineTool = <S extends ToolShape>(spec: ToolSpec<S>) => spec`) is
 * unobservable from outside the module. Arity, `Function.prototype.name`, the returned
 * reference and the inferred type are all unchanged. What does change is hoisting, and
 * `.prototype`/constructability — an arrow has no `.prototype` and `new defineTool(…)`
 * throws. Nothing calls `defineTool` above this line and nothing constructs it, so none
 * of the three is reachable from outside.
 *
 * Equivalent-mutant note: `return spec as ToolSpec<S>` is equally unobservable. `spec` is
 * already declared `ToolSpec<S>`, so the assertion narrows nothing and erases at emit.
 */
export function defineTool<S extends ToolShape>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}
