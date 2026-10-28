/**
 * The create → poll → publish flow shared by the three composite post tools in
 * `tools/publishing-composites.ts` (`instagram_post_image`, `_post_reel`, `_post_story`).
 *
 * Each composite owns only what differs between them — its validation, the
 * preview `details` of a NEW post, its summary sentence and the container
 * create. Everything else is one shape and lives here, so the three cannot
 * drift apart:
 *
 *   - the resume arm: a `resumeContainerId` skips validation, shows only the
 *     container id plus the ignored-inputs warning (CC-PUB-59), and reads
 *     "Resume publishing container …";
 *   - `details.warnings`, attached last and absent when there is nothing to say;
 *   - the write gate, the publish flow, the three outcomes and their journal
 *     status, and the container id re-attached to a mid-flow failure (CC-PUB-4).
 *
 * `media_publish` is NEVER auto-retried here or below: a flow still processing
 * at the poll deadline returns `in_progress` with `resume_container_id`, and the
 * operator resumes explicitly (docs/operations.md §2, architecture §10).
 *
 * Import boundary: `api/*` + `mcp/*` (and sibling `tools/*` helpers) only; never
 * `core/http`.
 */
import { acknowledgedId } from './ack.js';
import { type ToolContext, type ToolResult } from '../mcp/define.js';
import { json } from '../mcp/result.js';
import { withWriteGate, type WriteIntent } from '../mcp/write-mode.js';
import { InstagramError, isInstagramError } from '../core/types.js';
import { quoteGraphId } from '../core/errors.js';
import { runPublishFlow, type PublishFlowOptions } from '../api/publishing.js';

/**
 * The warning a resume carries when the caller also passed media inputs
 * (CC-PUB-59). A resume publishes the existing container, which cannot be
 * changed, so a caption or URL passed beside `resumeContainerId` is ignored; the
 * field description says so, but a caller who did not read it would otherwise
 * approve a post believing its new caption applies. The ignored fields are read
 * off the tool's own input shape, so a field added later is covered without an
 * edit here.
 */
function resumeIgnoredWarning(
  shape: Record<string, unknown>,
  args: Record<string, unknown>,
): string | undefined {
  const ignored = Object.keys(shape).filter(
    (key) => key !== 'resumeContainerId' && key !== 'apply' && args[key] !== undefined,
  );
  if (ignored.length === 0) return undefined;
  return (
    'resumeContainerId is set, so these inputs are ignored — the existing container is ' +
    `published exactly as it was created and cannot be changed: ${ignored.join(', ')}.`
  );
}

/**
 * Re-attach a created container's id to a failure that would otherwise drop it
 * (CC-PUB-4 — the duplicate-post corner case).
 *
 * `runPublishFlow` creates the container FIRST and only then polls and
 * publishes. Those two steps are ordinary Graph calls, so a 429, a 500 or a
 * dropped socket throws straight out of the flow with the brand-new container
 * id held in nothing but a local variable. All the caller sees is "posting
 * failed", and the obvious recovery — post it again — is exactly the duplicate
 * this module exists to prevent: the container may already be FINISHED, and if
 * the failure was on `media_publish` itself the post may already be live and
 * only the response lost.
 *
 * The success paths hand the id back in `structuredContent`; this is the same
 * promise kept on the failure paths, in the only channel an error has — the
 * message the model reads (`mcp/registry.ts` renders it through
 * `errorResult`). The original message, kind and Graph metadata are carried
 * over unchanged, the house pattern of `carouselAbortError` in
 * `api/publishing.ts`, so any handling that keys on `kind`, `status` or `code`
 * is unaffected.
 *
 * Two deliberate non-firings:
 *
 *   - `containerId === undefined` — nothing was created yet, so nothing is
 *     lost. This is the carousel mid-build abort, whose own error already
 *     accounts for the orphaned children, and any failure of the container
 *     create itself.
 *   - the message already names the container — `runPublishFlow`'s terminal
 *     ERROR and EXPIRED errors name it and end with "re-create it", which the
 *     addendum below would flatly contradict. The rule is literal on purpose:
 *     this exists to restore an id the error dropped, and an error carrying the
 *     id dropped nothing. It is imprecise in one harmless direction — if Graph
 *     happens to echo the id in an unrelated message the advice is skipped too,
 *     but the caller still has the id, which is the part that cannot be
 *     recovered by hand. If `api/publishing.ts` ever stopped naming the
 *     container, this would simply start firing on those paths, which is the
 *     safe direction to fail in.
 */
function resumableFailure(err: unknown, containerId: string | undefined): unknown {
  if (containerId === undefined) return err;
  const graph = isInstagramError(err) ? err : undefined;
  const originalMessage = graph?.message ?? String(err);
  // The id as every message names it — bare when it is a Graph id, quoted and
  // bounded when the wire sent something else (CC-PUB-56) — which is also
  // the spelling `api/publishing.ts` put into the ERROR and EXPIRED messages.
  const named = quoteGraphId(containerId);
  if (originalMessage.includes(named)) return err;
  return new InstagramError(
    `${originalMessage} — publishing did not complete, but container ${named} was already ` +
      'created and may even be live. Do NOT post again blindly: read its state with ' +
      `instagram_get_container_status. If it is FINISHED, re-run this tool with apply:true and ` +
      `resumeContainerId set to ${named}; if it is PUBLISHED the post already exists — find ` +
      'it with instagram_list_media.',
    {
      kind: graph?.kind ?? 'upstream',
      status: graph?.status,
      code: graph?.code,
      subcode: graph?.subcode,
      fbtraceId: graph?.fbtraceId,
      cause: err,
    },
  );
}

/**
 * Consequence text for a `media_publish` acknowledged without an id. Graph may
 * have published anyway, so this must never read as "safe to retry": a second
 * publish of the same container is refused at best and a duplicate post at worst.
 * Shared with the granular `instagram_publish_media`.
 */
export function publishIdMissing(containerId: string): string {
  return (
    `The post may already be live. Do NOT publish container ${quoteGraphId(containerId)} again: read its ` +
    'state with instagram_get_container_status (PUBLISHED means the post exists) and find the ' +
    'post with instagram_list_media.'
  );
}

/**
 * Apply/preview driver behind {@link runComposite}. In preview mode
 * {@link withWriteGate} returns before `perform`, so no container is created and
 * no `media_publish` is issued. In apply mode it drives {@link runPublishFlow}
 * and shapes one of three outcomes:
 *   - published         → the new media id (journaled as the write target);
 *   - already_published → a resumed container that was already live (not re-published);
 *   - in_progress       → still processing at the deadline; returns resume_container_id.
 * Each arm reports its outcome as the gate's `status`, so the journal line says
 * which of the three happened: without it every arm journals as the same
 * `publish_media` write against a target id, and a resume that re-sent nothing
 * is indistinguishable in the audit trail from a post going live.
 */
async function executePublish(
  params: {
    ctx: ToolContext;
    igId: string;
    args: { apply?: boolean; resumeContainerId?: string };
    intent: WriteIntent;
    createContainer: () => Promise<string>;
    warnings: readonly string[];
  },
  opts: PublishFlowOptions,
): Promise<ToolResult> {
  const { ctx, igId, args, intent, createContainer, warnings } = params;
  // The preview's `details.warnings`, carried into every applied outcome too
  // (CC-PUB-25 (a)): an operator running with `IG_WRITE_MODE=apply` never sees a
  // preview, and without this the hint reached nobody. Absent, never `[]`, when
  // there is nothing to say — the same rule as the preview.
  const withWarnings = (payload: Record<string, unknown>): Record<string, unknown> =>
    warnings.length > 0 ? { ...payload, warnings: [...warnings] } : payload;
  return withWriteGate(intent, args, ctx, async () => {
    // The id is captured as the flow produces it rather than read back off the
    // result, because the paths that need it most have no result to read from
    // (see `resumableFailure`). A resume already knows its id up front.
    let containerId = args.resumeContainerId;
    const trackCreate = async (): Promise<string> => {
      const id = await createContainer();
      containerId = id;
      return id;
    };
    let flow;
    try {
      flow = await runPublishFlow(
        { req: ctx.req, clock: ctx.clock, igId },
        { resumeContainerId: args.resumeContainerId, createContainer: trackCreate },
        opts,
      );
    } catch (err) {
      throw resumableFailure(err, containerId);
    }
    if (flow.status === 'published') {
      // `runPublishFlow` passes a silent `media_publish` ack through as
      // `mediaId: undefined` (CC-PUB-29). Reported as `published` it would give
      // the model no handle on the post and journal a publish with no target, so
      // it is raised instead; the refusal already names the container and the
      // check-before-retry advice, so it needs no `resumableFailure` wrapping.
      const mediaId = acknowledgedId(
        { id: flow.mediaId },
        'publish',
        publishIdMissing(flow.containerId),
      );
      return {
        result: json(
          withWarnings({
            status: 'published',
            container_id: flow.containerId,
            media_id: mediaId,
          }),
          { pretty: ctx.settings.prettyJson },
        ),
        targetId: mediaId,
        status: 'published',
      };
    }
    if (flow.status === 'already_published') {
      return {
        result: json(
          withWarnings({
            status: 'already_published',
            container_id: flow.containerId,
            // Explicitly null, not omitted. This arm is reached by a caller that
            // retried after a timeout and needs to know which post exists; the
            // container status edge returns only `id`/`status_code`/`status`, so
            // there is no media id to plumb through (CC-PUB-4). A missing key
            // reads as "forgot to include it" and invites a caller to retry for
            // real; `null` plus the note below says the id is unavailable here and
            // names the one call that can find it. Guessing "the newest media" is
            // refused on purpose — it would attribute an unrelated post.
            media_id: null,
            note:
              'This container was already published; it was NOT published again. Instagram returns ' +
              'no media id for an already-published container, so media_id is null rather than ' +
              'guessed — use instagram_list_media to locate the existing post (match it by caption ' +
              'or timestamp).',
          }),
          { pretty: ctx.settings.prettyJson },
        ),
        targetId: flow.containerId,
        status: 'already_published',
      };
    }
    return {
      result: json(
        withWarnings({
          status: 'in_progress',
          resume_container_id: flow.containerId,
          note:
            'The media is still processing after the poll budget. Re-run this tool with apply:true and ' +
            'resumeContainerId set to this id to finish publishing — do NOT create a new post, which would ' +
            'duplicate it.',
        }),
        { pretty: ctx.settings.prettyJson },
      ),
      targetId: flow.containerId,
      status: 'in_progress',
    };
  });
}

/**
 * What a composite says about a NEW post — never consulted on a resume. Built by
 * the composite's `fresh` callback, which is also where its validation throws.
 */
export interface FreshPost {
  /**
   * Preview `details` for the new post, in the key order the operator reads
   * them. `warnings` is NOT part of it: {@link runComposite} attaches that key
   * last, for a resume and a new post alike.
   */
  readonly details: Record<string, unknown>;
  /** Non-fatal hints for the new post; carried into the preview and every applied outcome. */
  readonly warnings: string[];
  /** The intent summary: what the operator is approving, in one sentence. */
  readonly summary: string;
}

/**
 * One composite post, end to end: resume-or-validate, the preview intent, then
 * {@link executePublish}.
 *
 * A resume (`args.resumeContainerId` set) skips `fresh` entirely — there is
 * nothing new to validate, since the existing container is published exactly as
 * it was created — and its `details` are the container id alone, plus the
 * ignored-inputs warning when the caller also passed media fields. `input` is
 * the tool's own input shape, which is what that warning reads its field names
 * from. A new post runs `fresh`, so its validation throws before the write gate
 * and a refused post never reaches a preview.
 *
 * `createContainer` is handed through unchanged and runs only on an applied new
 * post: {@link runPublishFlow} skips it whenever a resume id is present.
 */
export async function runComposite(
  spec: {
    ctx: ToolContext;
    /** IG target id for the operated account. */
    igId: string;
    action: string;
    input: Record<string, unknown>;
    args: { apply?: boolean; resumeContainerId?: string } & Record<string, unknown>;
    fresh: () => FreshPost;
    createContainer: () => Promise<string>;
  },
  opts: PublishFlowOptions,
): Promise<ToolResult> {
  const { ctx, igId, action, input, args, fresh, createContainer } = spec;
  let post: FreshPost;
  if (args.resumeContainerId !== undefined) {
    const ignored = resumeIgnoredWarning(input, args);
    post = {
      details: { resume_container_id: args.resumeContainerId },
      warnings: ignored !== undefined ? [ignored] : [],
      summary: `Resume publishing container ${args.resumeContainerId}`,
    };
  } else {
    post = fresh();
  }
  const { details, warnings, summary } = post;
  // Same `details.warnings` channel the other publishing tools use — a list even
  // for one entry, so a caller reads warnings the same way everywhere, and
  // absent entirely when there is nothing to say (an always-present empty list
  // trains the operator to skim past the field).
  if (warnings.length > 0) details.warnings = warnings;
  const intent: WriteIntent = { action, summary, details };
  return executePublish({ ctx, igId, args, intent, createContainer, warnings }, opts);
}
