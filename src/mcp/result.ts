/**
 * MCP result builders (Layer 2). Small, dependency-free helpers that every
 * domain tool package uses to shape its `ToolResult` — a single text result,
 * a JSON result (with `structuredContent` when the payload is an object), a
 * safe error result, and the prompt-injection fence for untrusted third-party
 * text. See docs/tools.md ("Structured output") and docs/security.md.
 */
import type { ToolResult } from './define.js';
import { isInstagramError } from '../core/types.js';

/**
 * Prompt-injection fence delimiters. All Graph-returned free-text fields
 * (comments, captions, bios, mention text) are untrusted — docs/security.md §7
 * and the security review's F-2 finding treat them as an indirect
 * prompt-injection channel. F-2 prescribes wrapping such content in a
 * "clearly delimited, provenance-tagged envelope (a `source:
 * "instagram-user-content"` marker and structural fencing)" so downstream
 * clients/models can tell data from instructions. These constants are that
 * envelope; they are intentionally not exported (the frozen module API is the
 * four functions only).
 */
const FENCE_OPEN = '[UNTRUSTED source: "instagram-user-content"]';
const FENCE_CLOSE = '[/UNTRUSTED]';

/** Defanged forms substituted for any forged delimiter found inside content. */
const FENCE_OPEN_DEFANGED = '[ UNTRUSTED source: "instagram-user-content"]';
const FENCE_CLOSE_DEFANGED = '[ /UNTRUSTED]';

/** True for a non-null, non-array object — the shape MCP `structuredContent` accepts. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A single text-content result. */
export function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] };
}

/**
 * A JSON result. The text content is `JSON.stringify(data, null, pretty ? 2 : 0)`.
 * When `data` is a plain (non-null, non-array) object it is also exposed as
 * `structuredContent`; otherwise `structuredContent` is omitted.
 */
export function json(data: unknown, opts?: { pretty?: boolean }): ToolResult {
  const body = JSON.stringify(data, null, opts?.pretty ? 2 : 0);
  const result: ToolResult = { content: [{ type: 'text', text: body }] };
  if (isRecordObject(data)) {
    result.structuredContent = data;
  }
  return result;
}

/**
 * An error result (`isError: true`). For an {@link InstagramError} it renders a
 * safe line with the error `kind` and `message` and attaches a structured
 * `{ error: { kind, message, code?, subcode? } }` payload. The original
 * `cause` is never rendered or surfaced (it may hold raw upstream payloads),
 * and no tokens are emitted here. Any other value yields a generic message.
 * (Secret masking of token-shaped strings is a separate downstream concern —
 * `mcp/redact.ts` — this builder simply never dumps `cause`.)
 */
export function errorResult(err: unknown): ToolResult {
  if (isInstagramError(err)) {
    const result: ToolResult = {
      isError: true,
      content: [{ type: 'text', text: `Instagram error (${err.kind}): ${err.message}` }],
    };
    const error: Record<string, unknown> = { kind: err.kind, message: err.message };
    if (err.code !== undefined) error.code = err.code;
    if (err.subcode !== undefined) error.subcode = err.subcode;
    result.structuredContent = { error };
    return result;
  }
  return {
    isError: true,
    content: [{ type: 'text', text: 'Unexpected error' }],
  };
}

/**
 * Wrap untrusted third-party text (a caption, comment, bio, …) in the
 * injection fence so a caller can embed it in a result and have the model
 * treat it as data, not instructions. Any attempt by the content to forge the
 * fence boundary (an embedded open/close delimiter) is defanged so the true
 * delimiters bound the data exactly once.
 */
export function fence(untrusted: string): string {
  const neutralized = untrusted
    .split(FENCE_CLOSE)
    .join(FENCE_CLOSE_DEFANGED)
    .split(FENCE_OPEN)
    .join(FENCE_OPEN_DEFANGED);
  return `${FENCE_OPEN}\n${neutralized}\n${FENCE_CLOSE}`;
}
