/**
 * Write gate (Layer 2). The single choke point every mutating tool passes
 * through, implementing the design-gate D3 decision (docs/roadmap.md): a write
 * runs only when explicitly applied, previews are read-only, and every applied
 * write is recorded to a local append-only journal (CC-PROC-5, CC-PUB-16).
 *
 * FROZEN seam — imported by the publishing and comments packages. Resolution is
 * env-flag based (`apply` arg + `IG_WRITE_MODE` + `IG_ALLOW_DESTRUCTIVE`); MCP
 * elicitation is a later, backward-compatible enhancement layered on top.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ToolContext, ToolResult } from './define.js';
import { json } from './result.js';

/** Describes the mutation a write tool intends to perform. */
export interface WriteIntent {
  /** Machine verb, e.g. `publish_media`, `delete_comment`. */
  action: string;
  /** One-line human description of exactly what will change (shown in preview). */
  summary: string;
  /** Structured echo of the intended write, surfaced in the preview payload. */
  details?: Record<string, unknown>;
  /** Irreversible op — additionally requires `ctx.settings.allowDestructive`. */
  destructive?: boolean;
}

// --- write journal ---------------------------------------------------------

/** Default journal location: `<XDG_STATE_HOME|~/.local/state>/instagram-mcp-ai/writes.jsonl`. */
function journalPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.IG_WRITE_JOURNAL?.trim();
  if (explicit) return explicit;
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(base, 'instagram-mcp-ai', 'writes.jsonl');
}

/**
 * Append one applied-write record to the journal. Best-effort audit: any I/O
 * failure is swallowed (logged at debug) so a broken journal never fails a
 * write the operator already authorized.
 */
function recordWrite(intent: WriteIntent, ctx: ToolContext, targetId: string | undefined): void {
  try {
    const path = journalPath(process.env);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry = {
      ts: new Date(ctx.clock.now()).toISOString(),
      action: intent.action,
      account: ctx.profile.name,
      authPath: ctx.profile.authPath,
      summary: intent.summary,
      ...(targetId !== undefined ? { targetId } : {}),
      destructive: intent.destructive === true,
    };
    appendFileSync(path, JSON.stringify(entry) + '\n', { flag: 'a' });
  } catch (err) {
    ctx.log.debug('write journal append failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- gate ------------------------------------------------------------------

/** Build the non-error preview result from a write intent (no mutation runs). */
function previewResult(intent: WriteIntent, note: string): ToolResult {
  return json({
    mode: 'preview',
    action: intent.action,
    summary: intent.summary,
    ...(intent.details !== undefined ? { details: intent.details } : {}),
    note,
  });
}

/**
 * Gate a write. Call this INSTEAD of mutating directly; `perform` runs only in
 * apply mode:
 *
 * ```ts
 * return withWriteGate(
 *   { action: 'publish_media', summary: `Publish container ${id}`, details: { id } },
 *   args,
 *   ctx,
 *   async () => {
 *     const r = await ctx.req<{ id: string }>({
 *       method: 'POST',
 *       path: `/${igId}/media_publish`,
 *       params: { creation_id: id },
 *     });
 *     return { result: json({ published: r.id }), targetId: r.id };
 *   },
 * );
 * ```
 *
 * Resolution:
 *   - apply requested := `args.apply === true`, or (`args.apply !== false` and
 *     `ctx.settings.writeMode === 'apply'`). An explicit `apply: false` always
 *     forces preview, even under a global apply default.
 *   - a `destructive` intent additionally requires `ctx.settings.allowDestructive`.
 *   - preview → returns a non-error {@link ToolResult} describing the intended
 *     write; `perform` is NOT called (no network mutation).
 *   - apply → awaits `perform()`, journals the applied write on success
 *     (best-effort, never throws), and returns `perform()`'s result.
 */
export async function withWriteGate(
  intent: WriteIntent,
  args: { apply?: boolean },
  ctx: ToolContext,
  perform: () => Promise<{ result: ToolResult; targetId?: string }>,
): Promise<ToolResult> {
  const applyRequested =
    args.apply === true || (args.apply !== false && ctx.settings.writeMode === 'apply');

  if (!applyRequested) {
    return previewResult(
      intent,
      `Preview only. Re-run with apply:true (or set IG_WRITE_MODE=apply) to perform this ${intent.action}.`,
    );
  }

  if (intent.destructive === true && !ctx.settings.allowDestructive) {
    return previewResult(
      intent,
      `Destructive ${intent.action} blocked. Set IG_ALLOW_DESTRUCTIVE=true to permit it, then re-run with apply:true.`,
    );
  }

  const { result, targetId } = await perform();
  if (result.isError !== true) recordWrite(intent, ctx, targetId);
  return result;
}
