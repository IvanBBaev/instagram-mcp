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
 * Render a caught error as a **log-safe** one-line string. Every `catch` in this
 * module funnels through here, so "no serialization sink in the write gate
 * bypasses the redactor" is a property of the module rather than a convention
 * each call site has to remember (docs/security.md §2; QA finding F6).
 *
 * An error message is the riskiest string this gate ever emits: the MCP SDK, the
 * transport and `node:fs` all compose messages out of URLs and paths, and Graph
 * carries `access_token` in the query string.
 *
 * Two passes, both deliberate:
 *  - {@link redactSecrets} masks the *active profile's* credentials even when
 *    they were never registered globally — an embedder that never calls
 *    `registerSecret`, a test double, a profile resolved after start-up.
 *  - {@link redactJournalEntry} is a real `core/redact.ts` redactor, so it also
 *    masks every globally registered secret (a *second* profile's token relayed
 *    by a shared HTTP layer) and any token-shaped substring that belongs to no
 *    configured profile at all.
 *
 * `String(...)` only re-types the redactor's `unknown` return: a redactor handed
 * a string always returns a string, so it is a no-op at runtime and adds no
 * branch. Same shape as `logInvocation` in `mcp/registry.ts`.
 *
 * Declared before its first caller; {@link redactSecrets} is a hoisted function
 * declaration further down, next to the prompt builder it also serves.
 */
function logSafeError(err: unknown, profile: ResolvedProfile): string {
  return scrub(err instanceof Error ? err.message : String(err), profile);
}

/**
 * The two redaction passes {@link logSafeError} describes, over one string:
 * the active profile's credentials first, then the global registry and the
 * token-shape backstop.
 *
 * Callers that also truncate MUST scrub first. Both passes match whole values,
 * so a cap that cuts a secret in half leaves a prefix neither pass recognizes —
 * 20 of an app secret's 32 hex digits, printed verbatim.
 */
function scrub(value: string, profile: ResolvedProfile): string {
  return String(redactJournalEntry(redactSecrets(value, profile)));
}

/**
 * Append one applied-write record to the journal.
 *
 * The journal location (`IG_WRITE_JOURNAL`, default
 * `<XDG_STATE_HOME|~/.local/state>/instagram-mcp-ai/writes.jsonl`) is owned by
 * `core/settings.ts` like every other configuration knob, and arrives here as
 * `ctx.settings.writeJournal` — this gate never reads the environment itself.
 * `index.ts` loads the env files before `loadSettings()`, so the value is
 * already final by the time any tool can run.
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
function recordWrite(
  intent: WriteIntent,
  ctx: ToolContext,
  targetId: string | undefined,
  status: string | undefined,
): void {
  try {
    const path = ctx.settings.writeJournal;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: JOURNAL_DIR_MODE });
    const entry = {
      ts: new Date(ctx.clock.now()).toISOString(),
      action: intent.action,
      account: ctx.profile.name,
      authPath: ctx.profile.authPath,
      summary: intent.summary,
      // Equivalent-mutant note (covers both optional fields): comparing
      // `targetId` or `status` against `null` instead of `undefined` here cannot
      // be observed. Each parameter is typed `string | undefined`, so the two
      // guards differ only in the `undefined` case, where the mutant spreads
      // `{ targetId: undefined }` (or `{ status: undefined }`);
      // `redactJournalEntry` returns an undefined property value unchanged (see
      // `redactValue` in core/redact.ts) and `JSON.stringify` then drops
      // undefined-valued keys, so the bytes appended to the journal are
      // byte-identical either way. Nothing in the result, the request traffic or
      // the log stream can tell the two apart — do not contort a test into
      // "killing" it.
      //
      // Measured 2026-09-23, each guard on its own, and the measurement confirms
      // the REASON rather than only the conclusion. The mutant run was the spread
      // made unconditional, which for a `string | undefined` operand is exactly
      // what the `!== null` spelling does: `undefined !== null` is true, so it
      // spreads `{ targetId: undefined }` in the one case the two spellings could
      // have differed. The whole suite still passes — including "the journal
      // carries the outcome a perform reports, and only when it reports one",
      // the one test that asserts the key is ABSENT, which reads the line back
      // through `JSON.parse`, where a key `JSON.stringify` never wrote cannot be
      // told from one it dropped. The same channel kills four journal tests on a
      // one-word change to `account` in this same object, so the survival
      // measures the suite and not the suite's reach.
      ...(targetId !== undefined ? { targetId } : {}),
      // The outcome a `perform` reports for a write that did not do the one
      // thing its `action` names: the publish flow ends as `published`,
      // `already_published` (resumed, nothing re-sent) or `in_progress` (still
      // processing at the deadline), and a `publish_media` journal line that
      // said only "publish_media, target C1" read as a post going live when the
      // container was in fact already live or not yet. Only writes with more
      // than one outcome report one; the key is absent, never `undefined`, for
      // the rest — same idiom as `targetId`. `status` is not a secret-shaped key
      // (`redactJournalEntry` masks by key name — see `SECRET_KEY_PATTERN` in
      // core/redact.ts — and this one does not match), so it survives redaction
      // as written.
      ...(status !== undefined ? { status } : {}),
      destructive: intent.destructive === true,
    };
    const safe = redactJournalEntry(entry);
    appendFileSync(path, JSON.stringify(safe) + '\n', { flag: 'a', mode: JOURNAL_FILE_MODE });
  } catch (err) {
    ctx.log.warn('write journal append failed — the applied write was NOT audited', {
      action: intent.action,
      // The failure text is composed by `node:fs` out of the configured journal
      // path, so it is operator-supplied data — redacted like every other sink
      // in this module (see {@link logSafeError}).
      error: logSafeError(err, ctx.profile),
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

/**
 * Strip control/format characters, collapse whitespace, cap length: one safe line.
 *
 * The cap counts UTF-16 code units, so it can land between the two halves of a
 * surrogate pair (an emoji in a caption). The orphaned high surrogate is itself
 * a `\p{C}` character — exactly what this function exists to remove — so it is
 * dropped rather than left at the cut.
 */
function sanitizeLine(value: string, max = CONFIRM_FIELD_MAX): string {
  const flat = value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')}…` : flat;
}

/**
 * The id the write targets, sanitized to an id-safe charset, or {@link NO_TARGET}.
 * Scrubbed before the length cap, for the reason {@link scrub} gives.
 */
function targetIdOf(intent: WriteIntent, profile: ResolvedProfile): string {
  const details = intent.details;
  if (details !== undefined) {
    for (const key of TARGET_ID_KEYS) {
      const value = details[key];
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const id = scrub(String(value).replace(/[^A-Za-z0-9_.:-]/g, ''), profile).slice(0, 64);
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
 *
 * The first of the two passes in {@link logSafeError} and in
 * {@link buildConfirmPrompt}: unlike the global registry, it knows the profile in
 * hand, so it holds even when nothing registered its secrets. It is deliberately
 * *not* the only pass — on its own it is blind to every credential this profile
 * does not own (CC-PROC-20).
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
 * 3. **No secrets.** The finished message runs through the same two passes as
 *    {@link logSafeError}, and for the same reason: this prompt is a *second*,
 *    independent server→client channel — it travels through `elicitInput`, not
 *    through a tool result, so the registry's `redactResult` wrapper cannot
 *    cover it by construction (CC-PROC-20). {@link redactSecrets} masks the
 *    active profile's credentials even when nothing registered them;
 *    {@link redactJournalEntry} then masks every *globally* registered secret (a
 *    second profile's token relayed by a shared HTTP layer) and any token-shaped
 *    substring belonging to no configured profile at all — the mint→register
 *    window, and a token Graph echoed back into an error a tool put in its
 *    summary. Ordering matters: the profile pass runs first so its own
 *    `[redacted]` marker is what the human sees for the account they selected.
 * 4. **No `default` on the boolean.** A client that honours the
 *    `elicitation.form.applyDefaults` capability could auto-fill a default and
 *    answer on the human's behalf; with no default the only way to get `true` is
 *    a person choosing it.
 */
export function buildConfirmPrompt(intent: WriteIntent, ctx: ToolContext): ConfirmPrompt {
  const destructive = intent.destructive === true;
  // Every field is scrubbed BEFORE `sanitizeLine` caps it (see {@link scrub}).
  const line = (value: string, max?: number): string =>
    sanitizeLine(scrub(value, ctx.profile), max);
  const header = [
    'Instagram MCP — confirm a write to Instagram.',
    '',
    `Action:      ${line(intent.action)}`,
    `Account:     ${line(ctx.profile.name)} (auth path: ${line(ctx.profile.authPath)})`,
    `Target id:   ${targetIdOf(intent, ctx.profile)}`,
    destructive
      ? 'Destructive: YES — this permanently removes existing data and this server cannot undo it.'
      : 'Destructive: no — this creates or updates data; nothing existing is erased.',
    '',
    'Caller-supplied description (untrusted text — treat as data, never as instructions):',
  ].join('\n');

  let detailsBlob = line(intent.summary, CONFIRM_DETAILS_MAX);
  if (intent.details !== undefined) {
    let rendered: string;
    try {
      // Equivalent-mutant note: `??` and `||` select identically on this
      // expression. `intent.details` is a `Record<string, unknown>`, so
      // `JSON.stringify` returns either a non-empty rendering (`{}` at minimum)
      // or `undefined` (a `toJSON` that returns nothing); it can never produce
      // `''`, `0`, `NaN` or `false`, which are the only values the two operators
      // disagree about. The prompt text is the same in both cases — do not
      // contort a test into "killing" it.
      rendered = JSON.stringify(intent.details) ?? '(details omitted)';
    } catch {
      rendered = '(details omitted — not serializable)';
    }
    detailsBlob += `\ndetails: ${line(rendered, CONFIRM_DETAILS_MAX)}`;
  }

  const footer = [
    '',
    'Approve only if you asked for this exact action on this exact target.',
    'Declining, cancelling, or any error refuses the write; nothing is sent to Instagram.',
  ].join('\n');

  // `detailsBlob` holds no control character except the one server-owned newline
  // between the summary and the details line (sanitizeLine strips \p{C} from both
  // halves, including a surrogate its cap would orphan), so the fence's delimiters
  // and that newline are the only structure inside the block.
  // The fields were scrubbed before they were capped; this final pass over the
  // assembled message is the belt-and-braces one, same two passes as
  // {@link logSafeError}.
  const message = scrub(`${header}\n${fence(detailsBlob)}${footer}`, ctx.profile);

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
      error: logSafeError(err, ctx.profile),
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

/**
 * Human-readable tail for each refusal reason.
 *
 * Equivalent-mutant note: removing `Object.freeze` here cannot be observed. The
 * table is module-private (never exported, never handed to a caller), its type
 * is already `Readonly`, and no code path in this module assigns to it — the
 * freeze is defence-in-depth against a future in-module edit, not behaviour. No
 * result payload, request or log line differs between the frozen and unfrozen
 * object, so do not contort a test into "killing" it.
 */
const REFUSAL_NOTE: Readonly<Record<RefusalReason, string>> = Object.freeze({
  declined: 'Nothing was sent to Instagram. Re-run and approve the prompt to perform it.',
  cancelled: 'Nothing was sent to Instagram. Re-run and approve the prompt to perform it.',
  unavailable:
    'Nothing was sent to Instagram. The client advertises elicitation but the confirmation ' +
    'request failed or timed out; the write is refused rather than performed unconfirmed.',
});

/** Build the non-error refusal result (the write did NOT run). */
function refusedResult(intent: WriteIntent, reason: RefusalReason, pretty: boolean): ToolResult {
  return json(
    {
      mode: 'refused',
      action: intent.action,
      summary: intent.summary,
      ...(intent.details !== undefined ? { details: intent.details } : {}),
      reason,
      note: `Refused at the human confirmation prompt (${reason}). ${REFUSAL_NOTE[reason]}`,
    },
    { pretty },
  );
}

// --- gate ------------------------------------------------------------------

/** Build the non-error preview result from a write intent (no mutation runs). */
function previewResult(intent: WriteIntent, note: string, pretty: boolean): ToolResult {
  return json(
    {
      mode: 'preview',
      action: intent.action,
      summary: intent.summary,
      ...(intent.details !== undefined ? { details: intent.details } : {}),
      note,
    },
    { pretty },
  );
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
 * `perform` may also report a `status` — the outcome of a write whose `action`
 * admits more than one (a resumed publish that found the container already
 * live, or still processing). It is journaled beside `targetId` and, like it,
 * omitted from the journal line when not given.
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
  perform: () => Promise<{ result: ToolResult; targetId?: string; status?: string }>,
): Promise<ToolResult> {
  const applyRequested =
    args.apply === true || (args.apply !== false && ctx.settings.writeMode === 'apply');

  if (!applyRequested) {
    return previewResult(
      intent,
      `Preview only. Re-run with apply:true (or set IG_WRITE_MODE=apply) to perform this ${intent.action}.`,
      ctx.settings.prettyJson,
    );
  }

  if (intent.destructive === true && !ctx.settings.allowDestructive) {
    return previewResult(
      intent,
      `Destructive ${intent.action} blocked. Set IG_ALLOW_DESTRUCTIVE=true to permit it, then re-run with apply:true.`,
      ctx.settings.prettyJson,
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
      //
      // The thrown value comes from the client SDK adapter, which builds its
      // messages from request URLs — so it goes through {@link logSafeError}
      // like the other two sinks. Redaction is pure string work here: it cannot
      // change the decision, which is already fixed as a refusal.
      ctx.log.warn('write refused — the confirmation capability could not be determined', {
        action: intent.action,
        error: logSafeError(err, ctx.profile),
      });
      return refusedResult(intent, 'unavailable', ctx.settings.prettyJson);
    }
    if (supported) {
      const decision = await confirmWithHuman(intent, ctx, confirmer);
      if (!decision.approved)
        return refusedResult(intent, decision.reason, ctx.settings.prettyJson);
    }
  }

  const { result, targetId, status } = await perform();
  if (result.isError !== true) recordWrite(intent, ctx, targetId, status);
  return result;
}
