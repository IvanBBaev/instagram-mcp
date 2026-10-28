/**
 * Publishing container tools (Layer 3) — the granular half of the `publishing`
 * package: the two phases of the Instagram publish flow as separate calls, and
 * the two reads an operator steers them by.
 *
 *   - instagram_create_media_container   (write) low-level container create
 *   - instagram_get_container_status     (read)  poll a container's state
 *   - instagram_publish_media            (write) publish a finished container
 *   - instagram_get_publishing_limit     (read)  rolling-window quota
 *
 * Both writes pass through `withWriteGate`; `media_publish` is never retried.
 * `tools/publishing.ts` joins these with the composites and the delete into the
 * package's aggregate `publishingTools`.
 *
 * Import boundary: `api/*` + `mcp/*` only; never `core/http`.
 */
import { z } from 'zod';
import { graphObjectId } from './ids.js';
import { acknowledgedId } from './ack.js';
import { boundedArray } from './arrays.js';
import { publishIdMissing } from './publish-flow.js';
import {
  applyField,
  aiGeneratedField,
  captionField,
  CONTAINER_ID_MISSING,
  igIdOf,
  locationField,
  thumbOffsetField,
  trialGraduationField,
} from './publishing-shared.js';
import { defineTool, type ToolSpec } from '../mcp/define.js';
import { json } from '../mcp/result.js';
import { withWriteGate, type WriteIntent } from '../mcp/write-mode.js';
import { InstagramError } from '../core/types.js';
import { previewExcerpt } from '../core/untrusted.js';
import {
  createMediaContainer,
  getContainerStatus,
  getPublishingLimit,
  publishMedia,
} from '../api/publishing.js';
import {
  altText,
  assertCaptionWithinLimits,
  assertCarouselSize,
  assertHttpsUrl,
  containerMediaTypeSchema,
  httpsUrl,
  imageUrlFormatWarning,
  userTagSchema,
  MAX_USER_TAGS,
  CAROUSEL_MAX,
  CAROUSEL_MIN,
} from '../api/media-spec.js';

// --- Read-tool output schemas ----------------------------------------------

const containerStatusOutput = {
  id: z.string(),
  status_code: z.string().optional(),
  status: z.string().optional(),
} as const;

const publishingLimitOutput = {
  quota_usage: z.number(),
  quota_total: z.number().optional(),
  quota_duration: z.number().optional(),
  remaining: z.number().optional(),
} as const;

// --- instagram_create_media_container --------------------------------------

const createContainerInput = {
  mediaType: containerMediaTypeSchema
    .optional()
    .describe(
      'Container kind: REELS, STORIES, or CAROUSEL. OMIT for a single feed image — a feed image sends ' +
        'no media_type (IMAGE/VIDEO are invalid values).',
    ),
  // Every URL field builds its own `httpsUrl()` instance (CC-PUB-35), so each
  // publishes its own description rather than a `$ref` to its first twin.
  imageUrl: httpsUrl()
    .optional()
    .describe('Public HTTPS image URL Instagram will fetch (feed image or carousel child).'),
  altText: altText()
    .optional()
    .describe(
      'Alt text for the image (≤ 1000 characters): a feed image or a carousel child only — it needs ' +
        'imageUrl and no mediaType, since Instagram refuses it on REELS, STORIES and a CAROUSEL album.',
    ),
  videoUrl: httpsUrl()
    .optional()
    .describe('Public HTTPS video URL Instagram will fetch (Reels/Stories video).'),
  caption: captionField,
  locationId: locationField,
  userTags: boundedArray(userTagSchema, 0, MAX_USER_TAGS)
    .optional()
    .describe(
      'User tags for a feed image (at most 20): handles without "@" (letters, digits, "." and "_") with optional 0–1 relative x/y coordinates.',
    ),
  children: boundedArray(graphObjectId(), CAROUSEL_MIN, CAROUSEL_MAX)
    .optional()
    .describe('CAROUSEL album only: 2–10 previously-created child container ids to combine.'),
  coverUrl: httpsUrl().optional().describe('Reels cover image URL.'),
  thumbOffset: thumbOffsetField('Reels/video cover frame offset, in milliseconds.'),
  shareToFeed: z.boolean().optional().describe('Reels: also cross-post the reel to the main feed.'),
  isCarouselItem: z
    .boolean()
    .optional()
    .describe('Mark this container as a carousel child (when assembling an album manually).'),
  isAiGenerated: aiGeneratedField,
  trialGraduation: trialGraduationField,
  apply: applyField,
};

const createMediaContainerTool = defineTool({
  name: 'instagram_create_media_container',
  title: 'Create Instagram media container',
  description:
    'Phase 1 of publishing: create a media container that Instagram ingests from a public HTTPS URL. ' +
    'This does NOT publish — poll instagram_get_container_status until FINISHED, then call ' +
    'instagram_publish_media with the returned container id. Omit media_type for a single feed image; ' +
    'set REELS/STORIES/CAROUSEL otherwise. Media format, size, and duration are validated by Instagram ' +
    'on fetch (the server never downloads the URL), so only URL form and caption limits are checked here.',
  package: 'publishing',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: createContainerInput,
  logFields: (args) => ({
    mediaType: args.mediaType ?? '(feed-image)',
    hasImage: args.imageUrl !== undefined,
    hasVideo: args.videoUrl !== undefined,
    children: args.children?.length ?? 0,
    apply: args.apply ?? false,
  }),
  handler: (args, ctx) => {
    // Equivalent-mutant note: this one guard can be relaxed to `if (args.caption)`
    // with no observable difference — the call's only effect here is to throw,
    // and the single falsy caption `''` breaks none of the limits. It is NOT
    // equivalent in the composite post tools, where the same call's stats are
    // summarised into the preview an operator approves, so an empty caption
    // there still has to be counted and shown.
    if (args.caption !== undefined) assertCaptionWithinLimits(args.caption);
    if (args.imageUrl !== undefined) assertHttpsUrl(args.imageUrl, 'imageUrl');
    if (args.videoUrl !== undefined) assertHttpsUrl(args.videoUrl, 'videoUrl');
    if (args.coverUrl !== undefined) assertHttpsUrl(args.coverUrl, 'coverUrl');
    if (args.children !== undefined) assertCarouselSize(args.children.length);
    // Graph takes `alt_text` on an image container only. Refused here rather
    // than left to Graph, which would refuse it only after the write gate — and
    // a reel or story preview that showed the alt text would promise an
    // accessibility label the post can never carry.
    if (
      args.altText !== undefined &&
      (args.mediaType !== undefined || args.imageUrl === undefined)
    ) {
      throw new InstagramError(
        'altText applies to an image container only (imageUrl, no mediaType): Instagram does not ' +
          'accept alt text on REELS, STORIES or a CAROUSEL album — set it on each carousel child instead.',
        { kind: 'validation' },
      );
    }
    // Same reasoning for the AI label, which Graph refuses on a carousel child:
    // the album container is where a carousel carries it.
    if (args.isAiGenerated !== undefined && args.isCarouselItem === true) {
      throw new InstagramError(
        'isAiGenerated cannot be set on a carousel child (isCarouselItem): Instagram does not accept ' +
          'it there — set it on the CAROUSEL album container instead.',
        { kind: 'validation' },
      );
    }
    if (args.trialGraduation !== undefined && args.mediaType !== 'REELS') {
      throw new InstagramError(
        'trialGraduation applies to a REELS container only: Instagram accepts trial_params with ' +
          'media_type REELS and nothing else.',
        { kind: 'validation' },
      );
    }

    // EVERY still-image URL this container can carry is hinted, in argument
    // order: `imageUrl` (feed image or carousel child) and `coverUrl` (a reel
    // cover is a still image under the same JPEG rule). Warning one and not the
    // other is worse than warning neither — silence on `coverUrl` reads as "this
    // one is fine" and teaches a rule that does not exist.
    //
    // `videoUrl` is deliberately excluded: a video extension is exactly right
    // there. A video extension on `imageUrl` or `coverUrl` draws the hint's own
    // video sentence (CC-PUB-23).
    //
    // The hint names the extension, not the field, so two offending URLs with
    // the same extension produce two identical lines. Left as is: the same
    // container cannot meaningfully carry both a feed `imageUrl` and a reel
    // `coverUrl`, and re-wording the message belongs to `api/media-spec.ts`.
    const warnings: string[] = [];
    for (const url of [args.imageUrl, args.coverUrl]) {
      if (url === undefined) continue;
      const w = imageUrlFormatWarning(url);
      if (w !== undefined) warnings.push(w);
    }

    const details: Record<string, unknown> = {
      media_type: args.mediaType ?? '(feed image — no media_type)',
    };
    if (args.children !== undefined) details.children = args.children.length;
    if (args.altText !== undefined) details.alt_text = previewExcerpt(args.altText);
    if (args.isAiGenerated !== undefined) details.ai_generated = args.isAiGenerated;
    if (args.trialGraduation !== undefined) details.trial_graduation = args.trialGraduation;
    if (warnings.length > 0) details.warnings = warnings;

    const intent: WriteIntent = {
      action: 'create_media_container',
      summary: `Create a ${args.mediaType ?? 'feed image'} media container`,
      details,
    };

    return withWriteGate(intent, args, ctx, async () => {
      const r = await createMediaContainer(ctx.req, {
        igId: igIdOf(ctx),
        mediaType: args.mediaType,
        imageUrl: args.imageUrl,
        altText: args.altText,
        videoUrl: args.videoUrl,
        caption: args.caption,
        locationId: args.locationId,
        userTags: args.userTags,
        children: args.children,
        coverUrl: args.coverUrl,
        thumbOffset: args.thumbOffset,
        shareToFeed: args.shareToFeed,
        isCarouselItem: args.isCarouselItem,
        isAiGenerated: args.isAiGenerated,
        trialGraduation: args.trialGraduation,
      });
      const containerId = acknowledgedId(r, 'media container', CONTAINER_ID_MISSING);
      const payload: Record<string, unknown> = { status: 'created', container_id: containerId };
      if (warnings.length > 0) payload.warnings = warnings;
      return { result: json(payload, { pretty: ctx.settings.prettyJson }), targetId: containerId };
    });
  },
});

// --- instagram_get_container_status ----------------------------------------

const getContainerStatusTool = defineTool({
  name: 'instagram_get_container_status',
  title: 'Get media container status',
  description:
    "Read a media container's processing state: status_code is IN_PROGRESS, FINISHED, ERROR, EXPIRED, " +
    'or PUBLISHED. Publish only once it is FINISHED. IN_PROGRESS means keep polling (do not re-create); ' +
    'ERROR/EXPIRED means re-create the container. Read-only.',
  package: 'publishing',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {
    containerId: graphObjectId().describe(
      'The media container id (creation_id) from instagram_create_media_container.',
    ),
  },
  output: containerStatusOutput,
  logFields: (args) => ({ containerId: args.containerId }),
  handler: async (args, ctx) => {
    const st = await getContainerStatus(ctx.req, { containerId: args.containerId });
    const payload: Record<string, unknown> = { id: st.id };
    if (st.statusCode !== undefined) payload.status_code = st.statusCode;
    if (st.status !== undefined) payload.status = st.status;
    return json(payload, { pretty: ctx.settings.prettyJson });
  },
});

// --- instagram_publish_media -----------------------------------------------

const publishMediaTool = defineTool({
  name: 'instagram_publish_media',
  title: 'Publish media container',
  description:
    'Phase 2 of publishing: publish a media container that has finished processing, returning the new ' +
    'media id. The container must be FINISHED (see instagram_get_container_status). This is never ' +
    'auto-retried — a repeated publish costs quota and posts a duplicate; retry only after confirming ' +
    'the previous call did not already publish.',
  package: 'publishing',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: {
    creationId: graphObjectId().describe(
      'The FINISHED media container id (creation_id) to publish.',
    ),
    apply: applyField,
  },
  logFields: (args) => ({ creationId: args.creationId, apply: args.apply ?? false }),
  handler: (args, ctx) => {
    const intent: WriteIntent = {
      action: 'publish_media',
      summary: `Publish container ${args.creationId}`,
      details: { creation_id: args.creationId },
    };
    return withWriteGate(intent, args, ctx, async () => {
      const r = await publishMedia(ctx.req, { igId: igIdOf(ctx), creationId: args.creationId });
      const mediaId = acknowledgedId(r, 'publish', publishIdMissing(args.creationId));
      return {
        result: json(
          { status: 'published', media_id: mediaId },
          { pretty: ctx.settings.prettyJson },
        ),
        targetId: mediaId,
      };
    });
  },
});

// --- instagram_get_publishing_limit ----------------------------------------

const getPublishingLimitTool = defineTool({
  name: 'instagram_get_publishing_limit',
  title: 'Get publishing rate limit',
  description:
    "Report the account's content-publishing usage against its rolling-window quota. quota_usage is how " +
    'many posts have been published in the window (a carousel counts as one); quota_total is read live ' +
    'from Instagram (the documented number varies, so it is never hardcoded) and remaining is derived ' +
    'only when the total is known. When Instagram reports no usage the call fails rather than ' +
    'reporting 0. Read-only.',
  package: 'publishing',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {},
  output: publishingLimitOutput,
  handler: async (_args, ctx) => {
    const limit = await getPublishingLimit(ctx.req, { igId: igIdOf(ctx) });
    const payload: Record<string, unknown> = { quota_usage: limit.quotaUsage };
    if (limit.quotaTotal !== undefined) payload.quota_total = limit.quotaTotal;
    if (limit.quotaDuration !== undefined) payload.quota_duration = limit.quotaDuration;
    if (limit.remaining !== undefined) payload.remaining = limit.remaining;
    return json(payload, { pretty: ctx.settings.prettyJson });
  },
});

/** The container tools, in the order `publishingTools` lists them. */
export const publishingContainerTools: readonly ToolSpec[] = Object.freeze([
  createMediaContainerTool,
  getContainerStatusTool,
  publishMediaTool,
  getPublishingLimitTool,
] as unknown as ToolSpec[]);
