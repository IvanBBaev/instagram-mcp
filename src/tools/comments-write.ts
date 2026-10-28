/**
 * Comment write tools (Layer 3) — the write half of the `comments` package,
 * including the media comment toggle. Every mutation routes through the frozen
 * write gate (`mcp/write-mode.ts`): a preview never calls the network, an apply
 * performs and is journaled, and `delete_comment` is additionally gated by
 * `IG_ALLOW_DESTRUCTIVE`. `tools/comments.ts` joins these with the read tools
 * into the package's aggregate `commentsTools`.
 *
 * Import boundary: `api/*`, `mcp/*`, `core/types` and `core/untrusted` only;
 * never `core/http`. InstagramError from the api layer is left to propagate —
 * the registry maps and renders it.
 */
import { z } from 'zod';
import { graphObjectId } from './ids.js';
import { acknowledgedId, assertNoErrorEnvelope } from './ack.js';
import { defineTool, type ToolSpec } from '../mcp/define.js';
import { json } from '../mcp/result.js';
import { withWriteGate } from '../mcp/write-mode.js';
import { InstagramError } from '../core/types.js';
import { previewExcerpt, visibleText } from '../core/untrusted.js';
import {
  createComment,
  deleteComment,
  replyToComment,
  setCommentHidden,
  setCommentsEnabled,
  type CommentWriteResult,
} from '../api/comments.js';

/**
 * Refuse to report a write Graph declined.
 *
 * Hide, unhide, delete and the comment toggle answer `{ success: false }` when
 * Meta declines the write (the caller does not own the object, the comment is
 * already gone, the media does not accept the toggle). Echoing the argument as
 * done would tell the model the comment is hidden and journal a write that never
 * happened, so the refusal is raised instead: the gate journals only a result
 * that is not an error. An ack with no `success` key discloses nothing and is
 * left alone rather than read as a refusal.
 */
function assertAcknowledged(ack: CommentWriteResult, action: string): void {
  // An error envelope delivered with HTTP 200 carries no `success` key, so the
  // check below would wave it through as a silent ack; map it as the same body
  // on a 4xx would be mapped (see `tools/ack.ts`).
  assertNoErrorEnvelope(ack);
  // CC-COM-21: `core/http.ts` hands back `JSON.parse(text)` unchanged, so the
  // body can be a bare scalar. A bare `false` is Graph's legacy form of the same
  // refusal and must not read as `undefined` (done); `null` would throw a raw
  // TypeError. Any other non-object discloses nothing, like an absent key.
  const declined =
    (ack as unknown) === false ||
    (typeof ack === 'object' && ack !== null && ack.success === false);
  if (declined) {
    throw new InstagramError(`Instagram declined to ${action} (success: false).`, {
      kind: 'upstream',
    });
  }
}

/**
 * Consequence text for a reply or comment acknowledged without an id: Graph may
 * have posted it, so re-running could post it twice.
 */
const COMMENT_ID_MISSING =
  'It may have been posted anyway: check the comments with instagram_list_comments before ' +
  'posting it again.';

/**
 * The text of a reply or new comment. CC-COM-6 has always promised that an
 * empty OR whitespace-only message is refused client-side, but only `.min(1)`
 * was declared, so `"   "` reached Graph as a public write (CC-COM-18). `\S`
 * demands one non-whitespace character, and — unlike a `.trim()` — leaves the
 * text that is posted exactly as the caller wrote it.
 *
 * `\S` still let through a message made only of zero-width spaces, joiners, a
 * BOM or bidi marks: non-whitespace, yet it posts a comment that renders blank.
 * The refinement asks `visibleText` — the one "does this render as anything?"
 * test the server has — so the rule that decides whether a Graph message is
 * worth showing also decides whether a message is worth posting, and any
 * blank-renderer it learns (CC-DATA-126) is refused here too. The `\S` pattern
 * stays because it is what the published input schema can express.
 */
function messageField(what: string): z.ZodType<string> {
  return z
    .string()
    .min(1)
    .regex(/\S/, 'must contain a non-whitespace character')
    .refine((v) => visibleText(v) !== undefined, {
      message: 'must contain a visible character, not only invisible or zero-width ones',
    })
    .describe(`The ${what} text to post.`);
}

/**
 * The text a comment write is about to post, as its preview and confirm prompt
 * show it: the flattened, bounded excerpt the publishing previews give a
 * caption (CC-PUB-60), then its full length in code points. Without it the
 * human approving a PUBLIC reply or comment saw only ids and approved text they
 * never read. The excerpt comes first so it is what the reader meets first.
 */
function messageSummary(message: string): { excerpt: string; characters: number } {
  return { excerpt: previewExcerpt(message), characters: [...message].length };
}

/** The `apply` flag every write tool declares (the registry does not inject it). */
const applyField = z
  .boolean()
  .optional()
  .describe('Set true to perform the write; omitted/false previews only.');

// --- Write tools -----------------------------------------------------------
// Every write tool below states `readOnlyHint: false` EXPLICITLY, exactly as the
// publishing package does. Omitting it behaves identically today — the registry
// filter tests `!== true` and MCP defaults the hint to false — but the two are
// not the same to a reviewer or to a client reading `tools/list`: an absent hint
// is indistinguishable from an oversight, while `false` is a statement. The rule
// is enforced, not conventional: `test/mcp/tool-metadata-contract.test.ts`
// derives read-vs-write by executing every handler and fails if a tool it
// observed writing does not declare the hint. `destructiveHint` is stated the
// same way, and for a sharper reason: the MCP spec defaults an absent value to
// TRUE on a non-read-only tool, so omitting it would advertise a reversible
// write as destructive. The same contract test derives it from the gate.

const replyToCommentTool = defineTool({
  name: 'instagram_reply_to_comment',
  title: 'Reply to a comment',
  description:
    'Post a threaded reply under an existing comment (POST /{comment-id}/replies). Preview by default; ' +
    're-run with apply:true (or set IG_WRITE_MODE=apply) to perform the reply.',
  package: 'comments',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  input: {
    commentId: graphObjectId().describe('The id of the comment to reply to.'),
    message: messageField('reply'),
    apply: applyField,
  },
  logFields: (args) => ({ commentId: args.commentId, apply: args.apply ?? false }),
  handler: (args, ctx) =>
    withWriteGate(
      {
        action: 'reply_to_comment',
        summary: `Reply to comment ${args.commentId}`,
        details: { commentId: args.commentId, message: messageSummary(args.message) },
      },
      args,
      ctx,
      async () => {
        const r = await replyToComment(ctx.req, {
          commentId: args.commentId,
          message: args.message,
        });
        const replyId = acknowledgedId(r, 'reply', COMMENT_ID_MISSING);
        return {
          result: json(
            { replyId, parentCommentId: args.commentId },
            { pretty: ctx.settings.prettyJson },
          ),
          targetId: replyId,
        };
      },
    ),
});

const createCommentTool = defineTool({
  name: 'instagram_create_comment',
  title: 'Create a comment',
  description:
    'Post a new top-level comment on a media object (POST /{media-id}/comments). Preview by default; ' +
    're-run with apply:true (or set IG_WRITE_MODE=apply) to perform the comment.',
  package: 'comments',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  input: {
    mediaId: graphObjectId().describe('The id of the media to comment on.'),
    message: messageField('comment'),
    apply: applyField,
  },
  logFields: (args) => ({ mediaId: args.mediaId, apply: args.apply ?? false }),
  handler: (args, ctx) =>
    withWriteGate(
      {
        action: 'create_comment',
        summary: `Comment on media ${args.mediaId}`,
        details: { mediaId: args.mediaId, message: messageSummary(args.message) },
      },
      args,
      ctx,
      async () => {
        const r = await createComment(ctx.req, { mediaId: args.mediaId, message: args.message });
        const commentId = acknowledgedId(r, 'comment', COMMENT_ID_MISSING);
        return {
          result: json({ commentId, mediaId: args.mediaId }, { pretty: ctx.settings.prettyJson }),
          targetId: commentId,
        };
      },
    ),
});

/** Caveat attached to every applied hide (CC-COM-5(a)). */
const OWN_COMMENT_HIDE_NOTE =
  'Instagram always displays comments the media owner made on its own media, even with hide=true: ' +
  "if this comment is the account's own, it is still visible.";

const hideCommentTool = defineTool({
  name: 'instagram_hide_comment',
  title: 'Hide a comment',
  description:
    'Hide a comment (POST /{comment-id}?hide=true) — reversible moderation, preferred over delete. ' +
    'Idempotent: hiding an already-hidden comment leaves it hidden. A comment the media owner made on ' +
    'its own media always stays visible: Instagram accepts the call but hides nothing. Preview by ' +
    'default; re-run with apply:true (or set IG_WRITE_MODE=apply) to perform the change.',
  package: 'comments',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: {
    commentId: graphObjectId().describe('The id of the comment to hide.'),
    apply: applyField,
  },
  logFields: (args) => ({ commentId: args.commentId, apply: args.apply ?? false }),
  handler: (args, ctx) =>
    withWriteGate(
      {
        action: 'hide_comment',
        summary: `Hide comment ${args.commentId}`,
        details: { commentId: args.commentId },
      },
      args,
      ctx,
      async () => {
        const ack = await setCommentHidden(ctx.req, { commentId: args.commentId, hide: true });
        assertAcknowledged(ack, `hide comment ${args.commentId}`);
        // CC-COM-5(a): Instagram acknowledges hiding the media owner's own comment
        // and keeps displaying it. The acknowledgement carries no author, and
        // telling the two apart would cost a GET of the comment AND of the
        // account id (the profile may be `me`), so the caveat travels with every
        // success instead of a bare `hidden` the model would read as done.
        return {
          result: json(
            { hidden: args.commentId, note: OWN_COMMENT_HIDE_NOTE },
            { pretty: ctx.settings.prettyJson },
          ),
          targetId: args.commentId,
        };
      },
    ),
});

const unhideCommentTool = defineTool({
  name: 'instagram_unhide_comment',
  title: 'Unhide a comment',
  description:
    'Unhide a previously hidden comment (POST /{comment-id}?hide=false). Idempotent: unhiding a ' +
    'visible comment leaves it visible. Preview by default; re-run with apply:true (or set ' +
    'IG_WRITE_MODE=apply) to perform the change.',
  package: 'comments',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: {
    commentId: graphObjectId().describe('The id of the comment to unhide.'),
    apply: applyField,
  },
  logFields: (args) => ({ commentId: args.commentId, apply: args.apply ?? false }),
  handler: (args, ctx) =>
    withWriteGate(
      {
        action: 'unhide_comment',
        summary: `Unhide comment ${args.commentId}`,
        details: { commentId: args.commentId },
      },
      args,
      ctx,
      async () => {
        const ack = await setCommentHidden(ctx.req, { commentId: args.commentId, hide: false });
        assertAcknowledged(ack, `unhide comment ${args.commentId}`);
        return {
          result: json({ unhidden: args.commentId }, { pretty: ctx.settings.prettyJson }),
          targetId: args.commentId,
        };
      },
    ),
});

const deleteCommentTool = defineTool({
  name: 'instagram_delete_comment',
  title: 'Delete a comment',
  description:
    'Permanently delete a comment (DELETE /{comment-id}). IRREVERSIBLE — prefer instagram_hide_comment ' +
    'for moderation you may want to undo. Double-gated: it runs only with apply:true AND ' +
    'IG_ALLOW_DESTRUCTIVE=true; otherwise it stays a preview.',
  package: 'comments',
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  input: {
    commentId: graphObjectId().describe('The id of the comment to delete.'),
    apply: applyField,
  },
  logFields: (args) => ({ commentId: args.commentId, apply: args.apply ?? false }),
  handler: (args, ctx) =>
    withWriteGate(
      {
        action: 'delete_comment',
        summary: `Delete comment ${args.commentId}`,
        details: { commentId: args.commentId },
        destructive: true,
      },
      args,
      ctx,
      async () => {
        const ack = await deleteComment(ctx.req, { commentId: args.commentId });
        assertAcknowledged(ack, `delete comment ${args.commentId}`);
        return {
          result: json({ deleted: args.commentId }, { pretty: ctx.settings.prettyJson }),
          targetId: args.commentId,
        };
      },
    ),
});

/**
 * `set_comments_enabled` acts on a media object but is a comment control, so it
 * carries `package: 'comments'` like every other comment tool (CC-PROC-9).
 * The registry groups by tag, so the env-var controls follow the tag: tagged
 * `media`, `IG_PACKAGES_DENY=comments` left this write registered and no
 * incantation could remove it without also removing the genuine media reads.
 */
const setCommentsEnabledTool = defineTool({
  name: 'instagram_set_comments_enabled',
  title: 'Enable or disable commenting',
  description:
    'Toggle whether a media object accepts new comments (POST /{media-id}?comment_enabled=true|false). ' +
    'Idempotent: setting the value it already has is a no-op. Preview by default; re-run with ' +
    'apply:true (or set IG_WRITE_MODE=apply) to perform the change.',
  package: 'comments',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: {
    mediaId: graphObjectId().describe('The id of the media whose commenting to toggle.'),
    enabled: z
      .boolean()
      .describe('true to allow new comments on the media; false to disable commenting.'),
    apply: applyField,
  },
  logFields: (args) => ({
    mediaId: args.mediaId,
    enabled: args.enabled,
    apply: args.apply ?? false,
  }),
  handler: (args, ctx) =>
    withWriteGate(
      {
        action: 'set_comments_enabled',
        summary: `Set comments ${args.enabled ? 'enabled' : 'disabled'} on media ${args.mediaId}`,
        details: { mediaId: args.mediaId, enabled: args.enabled },
      },
      args,
      ctx,
      async () => {
        const ack = await setCommentsEnabled(ctx.req, {
          mediaId: args.mediaId,
          enabled: args.enabled,
        });
        assertAcknowledged(
          ack,
          `${args.enabled ? 'enable' : 'disable'} comments on media ${args.mediaId}`,
        );
        return {
          result: json(
            { mediaId: args.mediaId, commentsEnabled: args.enabled },
            { pretty: ctx.settings.prettyJson },
          ),
          targetId: args.mediaId,
        };
      },
    ),
});

/** The six comment write tools, in the order `commentsTools` lists them. */
export const commentsWriteTools: readonly ToolSpec[] = Object.freeze([
  replyToCommentTool,
  createCommentTool,
  hideCommentTool,
  unhideCommentTool,
  deleteCommentTool,
  setCommentsEnabledTool,
] as unknown as ToolSpec[]);
