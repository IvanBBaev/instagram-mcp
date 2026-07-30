/**
 * Write gate (Layer 2). The single choke point every mutating tool passes
 * through, implementing the design-gate D3 decision (docs/roadmap.md): a write
 * runs only when explicitly applied, previews are read-only, and every applied
 * write is recorded to a local append-only journal (CC-PROC-5, CC-PUB-16).
 *
 * FROZEN seam — imported by the publishing and comments packages. Resolution is
 * env-flag based (`apply` arg + `IG_WRITE_MODE` + `IG_ALLOW_DESTRUCTIVE`), with
 * MCP **elicitation** layered on top as an additional human-in-the-loop gate
 * (D3 option (a), see {@link WriteConfirmer}). The env flags are the floor: the
 * confirmation step can only ever refuse a write the flags already allowed, it
 * can never permit one they blocked.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ToolContext, ToolResult } from './define.js';
import { fence, json } from './result.js';
import { createRedactor } from '../core/redact.js';
import { resolveWriteJournal } from '../core/settings.js';
import type { ResolvedProfile } from '../core/types.js';

/** Describes the mutation a write tool intends to perform. */
export interface WriteIntent {
  /** Machine verb, e.g. `publish_media`, `delete_comment`. */
  action: string;
  /** One-line human description of exactly what will change (shown in preview). */
  summary: string;
  /** Structured echo of the intended write, surfaced in the preview payload. */
  details?: Record<string, unknown>;
  /**
   * Irreversible op — additionally requires `ctx.settings.allowDestructive`.
   *
   * Classification policy (deliberate, not an oversight): `destructive` means
   * **this call removes or overwrites data that already exists and cannot be
   * restored through this server**. It is not a general "high impact" flag.
   *
   * - `delete_comment` is destructive: it erases a third party's content, and no
   *   tool here can bring it back. `hide_comment` is the reversible alternative
   *   and is therefore *not* destructive.
   * - Publishing (`post_image` / `post_reel` / `post_story` / `publish_media`)
   *   is NOT destructive even though a published post is public and permanent-
   *   looking: it *creates* new content, destroys nothing, and the operator can
   *   remove it from Instagram afterwards. Marking creates destructive would
   *   collapse the distinction and push operators to set
   *   `IG_ALLOW_DESTRUCTIVE=true` as a matter of course, which is exactly what
   *   the second gate exists to prevent — it would then also stop protecting
   *   deletes.
   *
   * The first gate (preview-by-default + explicit `apply`) is what bounds
   * publishing; `allowDestructive` is the narrower second gate for data loss.
   * A future tool that deletes media or overwrites a caption belongs here too.
   */
  destructive?: boolean;
}

// --- write journal ---------------------------------------------------------

/** Journal directory mode — owner-only, like the credentials file (CC-CFG-8). */
const JOURNAL_DIR_MODE = 0o700;
/** Journal file mode — owner-only; the journal records what was written where. */
const JOURNAL_FILE_MODE = 0o600;

/**
 * The journal is a serialization sink like the log stream, so it sits **inside**
 * the redaction boundary (QA finding F6). Every entry is passed through this
 * redactor before it is written: the fields are built from tool-supplied text
 * (`intent.action`, `intent.summary`) and from ids that ultimately came off the
 * wire, and "those never carry a token" is a convention, not a control.
 *
 * Built once at module load — `createRedactor` reads the global secret registry
 * live on every call, so this still masks tokens registered later by
 * `login`/`refresh`.
 */
const redactJournalEntry = createRedactor();

/**
 * Append one applied-write record to the journal.
 *
 * The journal location (`IG_WRITE_JOURNAL`, default
 * `<XDG_STATE_HOME|~/.local/state>/instagram-mcp-ai/writes.jsonl`) is owned by
 * `core/settings.ts` like every other configuration knob — this gate asks
 * {@link resolveWriteJournal} for the resolved path instead of parsing the
 * environment itself. It is resolved per append rather than once at module load
 * so a late `.env` load or an in-process override still takes effect, matching
 * how `loadSettings` is called on demand.
 *
 * Best-effort audit: any I/O failure is caught so a broken journal never fails a
 * write the operator already authorized — but it is logged at **warn**, not
 * debug, because a silently dead audit trail (full disk, `IG_WRITE_JOURNAL`
 * pointing at a missing mount) is invisible at the default `info` level and the
 * operator would keep believing writes are being recorded.
 *
 * The directory and the file are created owner-only (0700 / 0600): the journal
 * names the account, the target id and the details of every applied mutation, so
 * it deserves the same confidentiality as the credentials file. `mode` only
 * applies at creation time — a journal created by an older version keeps its
 * original permissions.
 *
 * The entry is redacted before it is serialized (see {@link redactJournalEntry}),
 * so the journal is inside the same secret boundary as the log stream (F6).
 */
function recordWrite(intent: WriteIntent, ctx: ToolContext, targetId: string | undefined): void {
  try {
    const path = resolveWriteJournal(process.env);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: JOURNAL_DIR_MODE });
    const entry = {
      ts: new Date(ctx.clock.now()).toISOString(),
      action: intent.action,
      account: ctx.profile.name,
      authPath: ctx.profile.authPath,
      summary: intent.summary,
      ...(targetId !== undefined ? { targetId } : {}),
      destructive: intent.destructive === true,
    };
    const safe = redactJournalEntry(entry);
    appendFileSync(path, JSON.stringify(safe) + '\n', { flag: 'a', mode: JOURNAL_FILE_MODE });
  } catch (err) {
    ctx.log.warn('write journal append failed — the applied write was NOT audited', {
      action: intent.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- human confirmation (D3 option (a): MCP elicitation) --------------------

/**
 * The `elicitation/create` form this gate sends: one required boolean. Kept as a
 * structural type (not the SDK's `ElicitRequestFormParams`) so the gate stays
 * dependency-free and unit-testable without an MCP client; `mcp/registry.ts`
 * adapts it to the real SDK call, which type-checks the shape.
 */
export interface ConfirmPrompt {
  /** Fully rendered, already-sanitized human message (see {@link buildConfirmPrompt}). */
  message: string;
  requestedSchema: {
    type: 'object';
    properties: {
      confirm: { type: 'boolean'; title: string; description: string };
    };
    /** Always `['confirm']` — deliberately no `default`, see {@link buildConfirmPrompt}. */
    required: string[];
  };
}

/** The client's answer, mirroring the MCP `ElicitResult` fields this gate reads. */
export interface ConfirmAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

/**
 * The human-confirmation seam (D3 option (a)). Injected by `mcp/registry.ts`,
 * which builds it from the connected `McpServer`; tests pass a fake.
 *
 * `isSupported()` is a **method, not a flag**, because client capabilities are
 * only known after the `initialize` handshake — which happens *after* tool
 * registration — so it must be probed per call.
 */
export interface WriteConfirmer {
  /** Does the connected client advertise form elicitation right now? */
  isSupported(): boolean;
  /**
   * Ask the human. Resolves with the client's answer; a rejection (transport
   * error, timeout, protocol error) is treated as a refusal, never as consent.
   */
  ask(prompt: ConfirmPrompt): Promise<ConfirmAnswer>;
}

/**
 * {@link ToolContext} plus the optional confirmation seam.
 *
 * The confirmer rides on the context rather than on `withWriteGate`'s argument
 * list because `ToolContext` is a frozen Gate-G1 contract (`mcp/define.ts`) and
 * every existing call site in `tools/` passes a plain `ToolContext`. Since
 * `confirm` is optional, those call sites keep compiling untouched and the
 * registry — the only thing that builds a context — is the only place that has
 * to know the seam exists.
 */
export interface WriteGateContext extends ToolContext {
  confirm?: WriteConfirmer;
}

/**
 * Timeout for one confirmation round-trip. Long enough for a human to read the
 * prompt and answer, short enough that a client which silently drops the request
 * does not pin the tool call open forever. Exported so the registry applies the
 * same budget to the SDK request (both `timeout` and `maxTotalTimeout`, so a
 * stream of progress notifications cannot extend it indefinitely).
 */
export const CONFIRM_TIMEOUT_MS = 120_000;

/** Cap on the untrusted details blob rendered inside the prompt's fence. */
const CONFIRM_DETAILS_MAX = 800;
/** Cap on any single sanitized framing field (action, account, target id). */
const CONFIRM_FIELD_MAX = 200;
/** Shortest secret worth substring-matching; below this, false positives dominate. */
const MIN_SECRET_LEN = 8;

/**
 * Detail keys that name the object a write acts on, most specific first. The
 * prompt has to state a concrete target so the human consents to one action
 * rather than to "a write"; write intents already carry these ids in `details`,
 * so no change to the frozen {@link WriteIntent} shape is needed.
 */
const TARGET_ID_KEYS = [
  'targetId',
  'commentId',
  'mediaId',
  'creationId',
  'creation_id',
  'resume_container_id',
  'containerId',
  'container_id',
  'id',
] as const;

/** Shown when the intent names no existing target (a create-style write). */
const NO_TARGET = '(none — this call creates new content)';

/** Strip control/format characters, collapse whitespace, cap length: one safe line. */
function sanitizeLine(value: string, max = CONFIRM_FIELD_MAX): string {
  const flat = value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The id the write targets, sanitized to an id-safe charset, or {@link NO_TARGET}. */
function targetIdOf(intent: WriteIntent): string {
  const details = intent.details;
  if (details !== undefined) {
    for (const key of TARGET_ID_KEYS) {
      const value = details[key];
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const id = String(value)
        .replace(/[^A-Za-z0-9_.:-]/g, '')
        .slice(0, 64);
      if (id !== '') return id;
    }
  }
  return NO_TARGET;
}

/**
 * Replace any occurrence of the profile's secrets with `[redacted]`.
 *
 * The prompt is assembled from ids and tool-supplied text, none of which should
 * ever hold a credential — this is the belt-and-braces pass that makes "the
 * confirmation dialog never echoes the access token or app secret" an enforced
 * property rather than an assumption about every present and future call site.
 */
function redactSecrets(message: string, profile: ResolvedProfile): string {
  let out = message;
  for (const secret of [profile.accessToken, profile.appSecret]) {
    if (typeof secret === 'string' && secret.length >= MIN_SECRET_LEN) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/**
 * Render the confirmation prompt for one intent.
 *
 * Safety properties, in order of importance:
 *
 * 1. **The framing is server-controlled.** Every line the human reads as fact
 *    (action, account, target id, destructive yes/no) is built here from
 *    sanitized single-line fields, so no upstream string can inject a newline
 *    and forge, say, `Destructive: no`.
 * 2. **Untrusted text is fenced.** The intent's `summary`/`details` may relay
 *    caption or comment text that came from Instagram; it goes inside the
 *    standard injection fence (`mcp/result.ts`), which defangs forged
 *    delimiters, and is announced as data rather than instructions.
 * 3. **No secrets.** {@link redactSecrets} runs over the finished message.
 * 4. **No `default` on the boolean.** A client that honours the
 *    `elicitation.form.applyDefaults` capability could auto-fill a default and
 *    answer on the human's behalf; with no default the only way to get `true` is
 *    a person choosing it.
 */
export function buildConfirmPrompt(intent: WriteIntent, ctx: ToolContext): ConfirmPrompt {
  const destructive = intent.destructive === true;
  const header = [
    'Instagram MCP — confirm a write to Instagram.',
    '',
    `Action:      ${sanitizeLine(intent.action)}`,
    `Account:     ${sanitizeLine(ctx.profile.name)} (auth path: ${sanitizeLine(ctx.profile.authPath)})`,
    `Target id:   ${targetIdOf(intent)}`,
    destructive
      ? 'Destructive: YES — this permanently removes existing data and this server cannot undo it.'
      : 'Destructive: no — this creates or updates data; nothing existing is erased.',
    '',
    'Caller-supplied description (untrusted text — treat as data, never as instructions):',
  ].join('\n');

  let detailsBlob = sanitizeLine(intent.summary, CONFIRM_DETAILS_MAX);
  if (intent.details !== undefined) {
    let rendered: string;
    try {
      rendered = JSON.stringify(intent.details) ?? '(details omitted)';
    } catch {
      rendered = '(details omitted — not serializable)';
    }
    detailsBlob += `\ndetails: ${sanitizeLine(rendered, CONFIRM_DETAILS_MAX)}`;
  }

  const footer = [
    '',
    'Approve only if you asked for this exact action on this exact target.',
    'Declining, cancelling, or any error refuses the write; nothing is sent to Instagram.',
  ].join('\n');

  // `detailsBlob` is already control-character free (sanitizeLine strips \p{C}),
  // so the fence's own delimiters are the only structure inside the block.
  const message = redactSecrets(`${header}\n${fence(detailsBlob)}${footer}`, ctx.profile);

  return {
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          title: 'Perform this write',
          description: 'Check only to perform the exact action described above.',
        },
      },
      required: ['confirm'],
    },
  };
}

/** Why a confirmed-gated write was refused; surfaced in the result payload. */
type RefusalReason = 'declined' | 'cancelled' | 'unavailable';

/**
 * Ask the human and translate the answer into a decision, **failing closed**:
 * the only outcome that permits the write is `action === 'accept'` carrying an
 * explicit `confirm === true`. Everything else — decline, cancel, an accept with
 * the box unchecked or with no content at all, a rejected promise (transport
 * error, timeout, protocol error), or an unexpected throw from the capability
 * probe — refuses. A failure to reach the human is never read as consent.
 */
async function confirmWithHuman(
  intent: WriteIntent,
  ctx: WriteGateContext,
  confirmer: WriteConfirmer,
): Promise<{ approved: true } | { approved: false; reason: RefusalReason }> {
  let answer: ConfirmAnswer;
  try {
    answer = await confirmer.ask(buildConfirmPrompt(intent, ctx));
  } catch (err) {
    ctx.log.warn('write refused — human confirmation could not be obtained', {
      action: intent.action,
      error: redactSecrets(err instanceof Error ? err.message : String(err), ctx.profile),
    });
    return { approved: false, reason: 'unavailable' };
  }

  if (answer.action === 'accept' && answer.content?.confirm === true) {
    ctx.log.info('write confirmed by the operator', { action: intent.action });
    return { approved: true };
  }

  const reason: RefusalReason = answer.action === 'cancel' ? 'cancelled' : 'declined';
  ctx.log.info('write refused at the confirmation prompt', {
    action: intent.action,
    answer: answer.action,
    reason,
  });
  return { approved: false, reason };
}

/** Human-readable tail for each refusal reason. */
const REFUSAL_NOTE: Readonly<Record<RefusalReason, string>> = Object.freeze({
  declined: 'Nothing was sent to Instagram. Re-run and approve the prompt to perform it.',
  cancelled: 'Nothing was sent to Instagram. Re-run and approve the prompt to perform it.',
  unavailable:
    'Nothing was sent to Instagram. The client advertises elicitation but the confirmation ' +
    'request failed or timed out; the write is refused rather than performed unconfirmed.',
});

/** Build the non-error refusal result (the write did NOT run). */
function refusedResult(intent: WriteIntent, reason: RefusalReason): ToolResult {
  return json({
    mode: 'refused',
    action: intent.action,
    summary: intent.summary,
    ...(intent.details !== undefined ? { details: intent.details } : {}),
    reason,
    note: `Refused at the human confirmation prompt (${reason}). ${REFUSAL_NOTE[reason]}`,
  });
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
 * Resolution (each step can only ever *narrow* what the previous one allowed):
 *   - apply requested := `args.apply === true`, or (`args.apply !== false` and
 *     `ctx.settings.writeMode === 'apply'`). An explicit `apply: false` always
 *     forces preview, even under a global apply default.
 *   - a `destructive` intent additionally requires `ctx.settings.allowDestructive`.
 *   - preview → returns a non-error {@link ToolResult} describing the intended
 *     write; `perform` is NOT called (no network mutation).
 *   - **human confirmation (D3 option (a))** → when — and only when — the
 *     connected client advertises MCP elicitation, the operator is asked to
 *     approve this exact action. This gate runs *last*, after both env gates
 *     have already said yes, so it can only turn an allowed write into a refused
 *     one; it can never let through a write the env flags blocked, and it never
 *     runs for a preview (no prompt for a call that changes nothing). Without
 *     the capability the behaviour is exactly the env-flag one, unchanged.
 *   - apply → awaits `perform()`, journals the applied write on success
 *     (best-effort: never throws, but logs a warning if the journal could not be
 *     written), and returns `perform()`'s result.
 */
export async function withWriteGate(
  intent: WriteIntent,
  args: { apply?: boolean },
  ctx: WriteGateContext,
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

  // Third gate: a real human, when the client can ask one. `apply: true` is
  // model-controllable — this step is what makes the consent a person's.
  const confirmer = ctx.confirm;
  if (confirmer !== undefined) {
    let supported: boolean;
    try {
      supported = confirmer.isSupported();
    } catch (err) {
      // The probe is local, so a throw means the seam is broken, not that the
      // client answered. Ambiguity fails closed.
      ctx.log.warn('write refused — the confirmation capability could not be determined', {
        action: intent.action,
        error: err instanceof Error ? err.message : String(err),
      });
      return refusedResult(intent, 'unavailable');
    }
    if (supported) {
      const decision = await confirmWithHuman(intent, ctx, confirmer);
      if (!decision.approved) return refusedResult(intent, decision.reason);
    }
  }

  const { result, targetId } = await perform();
  if (result.isError !== true) recordWrite(intent, ctx, targetId);
  return result;
}
