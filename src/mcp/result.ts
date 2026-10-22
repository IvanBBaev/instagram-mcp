/**
 * MCP result builders (Layer 2). Small, dependency-free helpers for shaping a
 * `ToolResult` — a JSON result (with `structuredContent` when the payload is an
 * object), a safe text-only error result, and the prompt-injection fence for
 * untrusted third-party text. See docs/tools.md ("Structured output") and
 * docs/security.md.
 *
 * The three are not reached for evenly, which is worth knowing before a change to
 * one of them is read as a change to all three. Counted across `src`: `json` has
 * seven importers — all six domain tool packages and `mcp/write-mode.ts` —
 * `fence` has five, and `errorResult` has exactly one, and that one is
 * `mcp/registry.ts` rather than any tool package. A plain-text `text()` builder
 * once sat beside them with no `src` caller at all; it was removed rather than
 * kept as an unused export, because every tool body is JSON (so that
 * `IG_PRETTY_JSON` and `structuredContent` apply uniformly) and a handler that
 * reached for plain prose would bypass both.
 *
 * Nothing here masks secrets, and nothing here can: these builders are a
 * convention, not a boundary — a handler is free to assemble a `ToolResult`
 * literal and never call them. Masking therefore runs one layer out, over the
 * finished result, in the registry's per-call wrapper (`mcp/registry.ts`), which
 * is the only path a handler's RESULT takes to an MCP client.
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
 * three functions only).
 */
const FENCE_OPEN = '[UNTRUSTED source: "instagram-user-content"]';
const FENCE_CLOSE = '[/UNTRUSTED]';

/**
 * Filler a forged delimiter may carry inside its brackets and still read as the
 * tag: any whitespace, and any format character (`\p{Cf}` — the zero-width
 * space, joiner and non-joiner, the BOM, bidi controls, the tag block).
 */
const TAG_GAP = '[\\s\\p{Cf}]*';

/**
 * A forged fence delimiter, open or close, as a model would read one rather than
 * as a parser would (CC-DATA-125): a `[`, an optional `/`, the word `UNTRUSTED`
 * in any case, with {@link TAG_GAP} filler allowed before the slash and between
 * every letter, then whatever else sits on the line up to the next bracket (the
 * `source: "…"` attribute of an open delimiter, or any other), and the closing
 * `]` when there is one. Until 2026-09-30 only the two exact, case-sensitive
 * delimiters were defanged, so `[/untrusted]`, `[ /UNTRUSTED ]` or a zero-width
 * space inside the tag passed through as written — and a model is not a parser.
 *
 * `i` with `u` is Unicode case folding, so the long s (U+017F) and the Kelvin
 * sign (U+212A) fold onto `s` and `k` and are caught too; `u` is also what lets
 * `\p{Cf}` be spelled at all. `g` defangs every forgery, not just the first.
 * The run after the word stops at a newline, so a forgery cannot swallow the
 * next line into its brackets; a `[` it leaves unclosed is still defanged.
 */
const FORGED_DELIMITER = new RegExp(
  `\\[(${TAG_GAP}/?${TAG_GAP}${[...'UNTRUSTED'].join(TAG_GAP)}[^\\[\\]\\n]*)(\\])?`,
  'giu',
);

/** True for a non-null, non-array object — the shape MCP `structuredContent` accepts. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every payload a result may carry: any JSON-representable value **except**
 * `undefined`. `{}` is TypeScript's "anything but `null`/`undefined`", so this
 * union still accepts objects, arrays, strings, numbers, booleans and `null`
 * while making `json(undefined)` a compile error at the call site.
 *
 * That matters because MCP's content schema requires `text` to be a string:
 * `JSON.stringify(undefined)` returns `undefined`, which would emit a
 * `{ type: 'text' }` block with no `text` field at all and let a strict client
 * reject the whole response. Rejecting the input in the type system removes the
 * failure mode instead of papering over it — a `?? 'null'` fallback would hand
 * the model a literal `null` to read as data.
 */
type JsonPayload = NonNullable<unknown> | null;

/**
 * A JSON result. The text content is `JSON.stringify(data, null, pretty ? 2 : 0)`.
 * When `data` is a plain (non-null, non-array) object it is also exposed as
 * `structuredContent`; otherwise `structuredContent` is omitted.
 *
 * Both surfaces carry the value exactly as the handler built it — wire text
 * included, invisible characters and all (CC-DATA-103). What a client receives
 * in the text block differs by one rendering step applied later, by the
 * registry and after secret masking: every control, format and separator
 * character `JSON.stringify` left raw is written as a JSON escape, so the text
 * still parses back to `structuredContent` (CC-DATA-102; `mcp/registry.ts`
 * `escapeTextBlocks`, docs/security.md §7).
 *
 * @throws TypeError when `data` cannot be serialized. {@link JsonPayload} rules
 * `undefined` out at compile time, but the type still admits the other values
 * `JSON.stringify` drops rather than renders — a function, a symbol — and those
 * would produce the same `text`-less content block. They are refused the same
 * way a cyclic object or a BigInt is: loudly, so the registry reports the call
 * as an error, instead of quietly returning a malformed success.
 */
export function json(data: JsonPayload, opts?: { pretty?: boolean }): ToolResult {
  const body = JSON.stringify(data, null, opts?.pretty ? 2 : 0);
  if (body === undefined) {
    throw new TypeError('json(): payload is not JSON-serializable (it renders to nothing)');
  }
  // Equivalent-mutant note: a `body ?? '...'` fallback on the line below survives
  // the suite because the throw above makes it dead code. The guard is the
  // statement; a fallback would silently emit a body no caller asked for.

  const result: ToolResult = { content: [{ type: 'text', text: body }] };
  if (isRecordObject(data)) {
    result.structuredContent = data;
  }
  return result;
}

/**
 * An error result (`isError: true`). For an {@link InstagramError} it renders one
 * safe line carrying the whole typed error — `Instagram error (kind): message`,
 * followed by ` (code N)` or ` (code N, subcode M)` when Graph supplied them.
 * The original `cause` is never rendered or surfaced (it may hold raw upstream
 * payloads). Any other value yields a generic message.
 *
 * An error result carries NO `structuredContent` (CC-DATA-61). The MCP SDK
 * client (`Client.callTool`, measured on 1.30.0) validates `structuredContent`
 * against the tool's outputSchema whenever it is present, `isError` or not, so
 * an `{ error: {...} }` envelope on a tool that publishes an outputSchema came
 * back to the client as `-32602 Structured content does not match the tool's
 * output schema` and the typed error was lost. The text line is therefore the
 * error contract, and it keeps every field the envelope used to hold.
 *
 * What this builder guarantees is structural and narrow: it reads `kind`,
 * `message`, `code` and `subcode` and nothing else, so a raw upstream payload
 * cannot reach a client through it. It performs no secret masking — an earlier
 * version of this note promised that to a module named `mcp/redact.ts` which
 * has never existed. The redactor is `core/redact.ts`, and the registry runs it
 * over the finished result of every tool call (`mcp/registry.ts`
 * `redactResult`), this one included, so a secret that did reach `message` is
 * masked at that boundary rather than here.
 */
export function errorResult(err: unknown): ToolResult {
  if (isInstagramError(err)) {
    const codes: string[] = [];
    if (err.code !== undefined) codes.push(`code ${err.code}`);
    if (err.subcode !== undefined) codes.push(`subcode ${err.subcode}`);
    const suffix = codes.length > 0 ? ` (${codes.join(', ')})` : '';
    return {
      isError: true,
      content: [{ type: 'text', text: `Instagram error (${err.kind}): ${err.message}${suffix}` }],
    };
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
 * fence boundary — an embedded open or close delimiter, or a near-miss of one
 * ({@link FORGED_DELIMITER}) — is defanged so the true delimiters bound the
 * data exactly once.
 *
 * Defanging swaps the forgery's square brackets for white ones, `⟦…⟧`, and
 * leaves everything between them byte-exact (CC-DATA-125). Until 2026-09-30 it
 * inserted a space instead — `[ /UNTRUSTED]` — which a parser cannot confuse
 * with the delimiter but a model still reads as a closing tag. `⟦` is not `[`,
 * so no defanged form can match {@link FORGED_DELIMITER} or either real
 * delimiter again, and one pass covers both kinds. A bracketed phrase that
 * merely starts with the word — `[untrusted input]` — is defanged too; that is
 * the price of matching what a model reads, and it edits two characters.
 */
export function fence(untrusted: string): string {
  // CC-DATA-125, applied 2026-10-22: the forgery is LOOKED FOR in the NFKC fold
  // of the text, so the fullwidth and small-form brackets and slash (`［／ＵＮ…］`,
  // `﹇…﹈`) and the fullwidth letters read as the tag they look like. The fold
  // is per code point, and each folded UTF-16 unit remembers the code point it
  // came from, so the edit lands on the ORIGINAL text: only the code point that
  // folded to the forgery's `[` (and its `]`, when there is one) is swapped, and
  // everything else — the fullwidth letters included — stays byte-exact. Every
  // code point whose NFKC fold holds a `[` or `]` folds to exactly that one
  // character (U+FE47, U+FE48, U+FF3B, U+FF3D), so swapping the whole point
  // drops nothing. Cyrillic and Greek look-alikes (`UNTRUЅTED` with a Cyrillic
  // DZE) do not fold onto Latin and are an accepted residual (docs/security.md).
  const points = [...untrusted];
  const owner: number[] = [];
  let folded = '';
  points.forEach((point, index) => {
    const fold = point.normalize('NFKC');
    folded += fold;
    for (let unit = 0; unit < fold.length; unit += 1) owner.push(index);
  });
  const swaps = new Map<number, string>();
  for (const forgery of folded.matchAll(FORGED_DELIMITER)) {
    swaps.set(owner[forgery.index] as number, '⟦');
    if (forgery[2] !== undefined) {
      swaps.set(owner[forgery.index + forgery[0].length - 1] as number, '⟧');
    }
  }
  const neutralized = points.map((point, index) => swaps.get(index) ?? point).join('');
  return `${FENCE_OPEN}\n${neutralized}\n${FENCE_CLOSE}`;
}
