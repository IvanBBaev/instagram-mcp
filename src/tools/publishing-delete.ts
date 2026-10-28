/**
 * Publishing delete (Layer 3) — `instagram_delete_media`, the one way to take a
 * published media object back down, and the `publishing` package's only
 * destructive tool. It is gated by `withWriteGate` and additionally by
 * `IG_ALLOW_DESTRUCTIVE`, like `instagram_delete_comment`.
 * `tools/publishing.ts` joins it with the container tools and the composites
 * into the package's aggregate `publishingTools`.
 *
 * Import boundary: `api/*` + `mcp/*` only; never `core/http`.
 */
import { graphObjectId } from './ids.js';
import { applyField } from './publishing-shared.js';
import { defineTool, type ToolSpec } from '../mcp/define.js';
import { json } from '../mcp/result.js';
import { withWriteGate } from '../mcp/write-mode.js';
import { InstagramError } from '../core/types.js';
import { deleteMedia } from '../api/publishing.js';

// --- instagram_delete_media ------------------------------------------------

const deleteMediaTool = defineTool({
  name: 'instagram_delete_media',
  title: 'Delete a published media object',
  description:
    'Permanently delete a published post, reel, story or whole carousel album (DELETE /{ig-media-id}). ' +
    'IRREVERSIBLE: the media, its comments and its insights are gone. A single carousel child cannot be ' +
    'deleted (delete the album) and ad posts are not supported. Facebook Login (Path B) only, and the ' +
    'token needs the instagram_manage_contents permission. Double-gated: it runs only with apply:true ' +
    'AND IG_ALLOW_DESTRUCTIVE=true; otherwise it stays a preview.',
  package: 'publishing',
  paths: ['fb-login'],
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: {
    mediaId: graphObjectId().describe(
      'The id of the published media to delete (a post, reel, story or carousel album).',
    ),
    apply: applyField,
  },
  logFields: (args) => ({ mediaId: args.mediaId, apply: args.apply ?? false }),
  handler: (args, ctx) =>
    withWriteGate(
      {
        action: 'delete_media',
        summary: `Delete media ${args.mediaId}`,
        details: { mediaId: args.mediaId },
        destructive: true,
      },
      args,
      ctx,
      async () => {
        const ack = await deleteMedia(ctx.req, { mediaId: args.mediaId });
        // `{ success: false }` (or a bare `false`) is Meta declining the delete.
        // Echoing the id as deleted would tell the model the post is gone and
        // journal a removal that never happened. An ack that does not say is
        // read as done, as the comment delete does (CC-COM-21).
        if (ack.success === false) {
          throw new InstagramError(
            `Instagram declined to delete media ${args.mediaId} (success: false).`,
            { kind: 'upstream' },
          );
        }
        return {
          result: json({ deleted: args.mediaId }, { pretty: ctx.settings.prettyJson }),
          targetId: args.mediaId,
        };
      },
    ),
});

/** The delete tool, last in `publishingTools`. */
export const publishingDeleteTools: readonly ToolSpec[] = Object.freeze([
  deleteMediaTool,
] as unknown as ToolSpec[]);
