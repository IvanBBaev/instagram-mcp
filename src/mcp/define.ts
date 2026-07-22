/**
 * ToolSpec contract (Layer 2 seam). FROZEN at Gate G1. Every tool is a
 * `ToolSpec` object (tools-as-data); `tools/` files export these and `mcp/
 * registry.ts` turns them into MCP registrations. See docs/architecture.md §3.
 */
import type { z } from 'zod';
import type { AuthPath, IgRequestFn, Logger, ResolvedProfile, Settings } from '../core/types.js';
import type { Clock } from '../core/clock.js';

/** MCP tool annotations surfaced to clients for permission UX. */
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

export type ToolContent = ToolTextContent;

/** MCP `CallToolResult` subset the handlers produce. */
export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Parsed handler args: the tool's declared input plus the framework-injected
 * `account` selector (multi-profile). Write tools additionally see `apply`.
 */
export type ToolInputArgs<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>> & {
  account?: string;
  apply?: boolean;
};

/**
 * Per-call dependencies handed to every tool handler. Resolved by the registry
 * from the active profile + config; domain code takes what it needs and stays
 * decoupled from how these are built. `req` is the only network seam.
 */
export interface ToolContext {
  req: IgRequestFn;
  settings: Settings;
  profile: ResolvedProfile;
  clock: Clock;
  log: Logger;
}

export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
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
  output?: z.ZodRawShape;
  /** Fields safe to log — never secrets. */
  logFields?: (args: ToolInputArgs<S>) => Record<string, unknown>;
  handler: (args: ToolInputArgs<S>, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
}

/** Identity helper preserving the generic `S` at definition sites. */
export function defineTool<S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}
