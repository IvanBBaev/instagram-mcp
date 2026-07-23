/**
 * Publishing tool specs (Layer 3) — the `publishing` package. Two granular
 * primitives plus three convenience composites over the two-phase Instagram
 * publish flow (create container → poll → publish):
 *
 *   - instagram_create_media_container   (write) low-level container create
 *   - instagram_get_container_status     (read)  poll a container's state
 *   - instagram_publish_media            (write) publish a finished container
 *   - instagram_get_publishing_limit     (read)  rolling-window quota
 *   - instagram_post_image               (write) image/carousel: create→publish
 *   - instagram_post_reel                (write) reel: create→poll→publish
 *   - instagram_post_story               (write) story: create→poll→publish
 *
 * Every mutation passes through {@link withWriteGate}: a **preview** (the
 * default) describes exactly what would happen and calls NOTHING (no container
 * create, no `media_publish`); an **apply** run performs it and is journaled.
 * A composite that is still processing when the poll budget elapses returns a
 * non-error `in_progress` result carrying `resume_container_id` — `media_publish`
 * is NEVER auto-retried, so the operator resumes explicitly rather than risking
 * a duplicate post (docs/operations.md §2, architecture §10).
 *
 * The server never fetches user-supplied media URLs (SSRF policy), so only
 * structural checks are possible here — https URL form, caption limits, carousel
 * bounds. Pixel format, byte size, aspect ratio, and video duration cannot be
 * verified until Instagram fetches the URL at container creation.
 *
 * Import boundary: `api/*` + `mcp/*` only; never `core/http`.
 */
import { z } from 'zod';
import {
  defineTool,
  type ToolContext,
  type ToolInputArgs,
  type ToolResult,
  type ToolSpec,
} from '../mcp/define.js';
import { json } from '../mcp/result.js';
import { withWriteGate, type WriteIntent } from '../mcp/write-mode.js';
import { InstagramError } from '../core/types.js';
import {
  createCarouselContainer,
  createMediaContainer,
  getContainerStatus,
  getPublishingLimit,
  publishMedia,
  runPublishFlow,
  type PublishFlowOptions,
} from '../api/publishing.js';
import {
  assertCaptionWithinLimits,
  assertCarouselSize,
  assertHttpsUrl,
  containerMediaTypeSchema,
  httpsUrlSchema,
  imageUrlFormatWarning,
  userTagSchema,
  CAROUSEL_MAX,
  CAROUSEL_MIN,
  type CaptionStats,
} from '../api/media-spec.js';

// --- Shared input fields ----------------------------------------------------

const applyField = z
  .boolean()
  .optional()
  .describe(
    'Set true to actually perform this write. Omitted (or false) returns a non-mutating preview of ' +
      'exactly what would happen and calls nothing, unless IG_WRITE_MODE=apply is configured. An ' +
      'explicit false always forces preview.',
  );

const captionField = z
  .string()
  .optional()
  .describe(
    'Caption text (≤ 2200 characters, ≤ 30 hashtags, ≤ 20 @mentions — counted as a client-side guard). ' +
      'Instagram renders @mentions and #hashtags.',
  );

const locationField = z
  .string()
  .min(1)
  .optional()
  .describe('Instagram location Page id to tag on the post.');

const resumeField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Resume a container from a previous apply that returned status=in_progress: pass its ' +
      'resume_container_id to finish publishing instead of creating a new post (avoids a duplicate). ' +
      'When set, the media inputs are ignored.',
  );

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

// --- Helpers ----------------------------------------------------------------

/** IG target id for the operated account (numeric id, else `me`). */
function igIdOf(ctx: ToolContext): string {
  return ctx.profile.accountId ?? 'me';
}

/** Compact caption stats for a preview payload. */
function captionSummary(stats: CaptionStats): Record<string, number> {
  return { characters: stats.codePoints, hashtags: stats.hashtags, mentions: stats.mentions };
}

/**
 * Shared apply/preview driver for the three composite post tools. In preview
 * mode {@link withWriteGate} returns before `perform`, so no container is created
 * and no `media_publish` is issued. In apply mode it drives {@link runPublishFlow}
 * and shapes one of three outcomes:
 *   - published         → the new media id (journaled as the write target);
 *   - already_published → a resumed container that was already live (not re-published);
 *   - in_progress       → still processing at the deadline; returns resume_container_id.
 */
async function executePublish(
  params: {
    ctx: ToolContext;
    args: { apply?: boolean; resumeContainerId?: string };
    intent: WriteIntent;
    createContainer: () => Promise<string>;
  },
  opts: PublishFlowOptions,
): Promise<ToolResult> {
  const { ctx, args, intent, createContainer } = params;
  return withWriteGate(intent, args, ctx, async () => {
    const flow = await runPublishFlow(
      { req: ctx.req, clock: ctx.clock, igId: igIdOf(ctx) },
      { resumeContainerId: args.resumeContainerId, createContainer },
      opts,
    );
    if (flow.status === 'published') {
      return {
        result: json({
          status: 'published',
          container_id: flow.containerId,
          media_id: flow.mediaId,
        }),
        targetId: flow.mediaId,
      };
    }
    if (flow.status === 'already_published') {
      return {
        result: json({
          status: 'already_published',
          container_id: flow.containerId,
          note: 'This container was already published; it was NOT published again.',
        }),
        targetId: flow.containerId,
      };
    }
    return {
      result: json({
        status: 'in_progress',
        resume_container_id: flow.containerId,
        note:
          'The media is still processing after the poll budget. Re-run this tool with apply:true and ' +
          'resumeContainerId set to this id to finish publishing — do NOT create a new post, which would ' +
          'duplicate it.',
      }),
      targetId: flow.containerId,
    };
  });
}

// --- instagram_create_media_container --------------------------------------

const createContainerInput = {
  mediaType: containerMediaTypeSchema
    .optional()
    .describe(
      'Container kind: REELS, STORIES, or CAROUSEL. OMIT for a single feed image — a feed image sends ' +
        'no media_type (IMAGE/VIDEO are invalid values).',
    ),
  imageUrl: httpsUrlSchema
    .optional()
    .describe('Public HTTPS image URL Instagram will fetch (feed image or carousel child).'),
  videoUrl: httpsUrlSchema
    .optional()
    .describe('Public HTTPS video URL Instagram will fetch (Reels/Stories video).'),
  caption: captionField,
  locationId: locationField,
  userTags: z
    .array(userTagSchema)
    .optional()
    .describe('User tags for a feed image: handles with optional 0–1 relative x/y coordinates.'),
  children: z
    .array(z.string().min(1))
    .min(CAROUSEL_MIN)
    .max(CAROUSEL_MAX)
    .optional()
    .describe('CAROUSEL album only: 2–10 previously-created child container ids to combine.'),
  coverUrl: httpsUrlSchema.optional().describe('Reels cover image URL.'),
  thumbOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Reels/video cover frame offset, in milliseconds.'),
  shareToFeed: z.boolean().optional().describe('Reels: also cross-post the reel to the main feed.'),
  isCarouselItem: z
    .boolean()
    .optional()
    .describe('Mark this container as a carousel child (when assembling an album manually).'),
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
    if (args.caption !== undefined) assertCaptionWithinLimits(args.caption);
    if (args.imageUrl !== undefined) assertHttpsUrl(args.imageUrl, 'imageUrl');
    if (args.videoUrl !== undefined) assertHttpsUrl(args.videoUrl, 'videoUrl');
    if (args.coverUrl !== undefined) assertHttpsUrl(args.coverUrl, 'coverUrl');
    if (args.children !== undefined) assertCarouselSize(args.children.length);

    const warning = args.imageUrl !== undefined ? imageUrlFormatWarning(args.imageUrl) : undefined;

    const details: Record<string, unknown> = {
      media_type: args.mediaType ?? '(feed image — no media_type)',
    };
    if (args.children !== undefined) details.children = args.children.length;
    if (warning !== undefined) details.warnings = [warning];

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
        videoUrl: args.videoUrl,
        caption: args.caption,
        locationId: args.locationId,
        userTags: args.userTags,
        children: args.children,
        coverUrl: args.coverUrl,
        thumbOffset: args.thumbOffset,
        shareToFeed: args.shareToFeed,
        isCarouselItem: args.isCarouselItem,
      });
      const payload: Record<string, unknown> = { status: 'created', container_id: r.id };
      if (warning !== undefined) payload.warnings = [warning];
      return { result: json(payload), targetId: r.id };
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
    containerId: z
      .string()
      .min(1)
      .describe('The media container id (creation_id) from instagram_create_media_container.'),
  },
  output: containerStatusOutput,
  logFields: (args) => ({ containerId: args.containerId }),
  handler: async (args, ctx) => {
    const st = await getContainerStatus(ctx.req, { containerId: args.containerId });
    const payload: Record<string, unknown> = { id: st.id };
    if (st.statusCode !== undefined) payload.status_code = st.statusCode;
    if (st.status !== undefined) payload.status = st.status;
    return json(payload);
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
    creationId: z
      .string()
      .min(1)
      .describe('The FINISHED media container id (creation_id) to publish.'),
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
      return { result: json({ status: 'published', media_id: r.id }), targetId: r.id };
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
    'only when the total is known. Read-only.',
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
    return json(payload);
  },
});

// --- instagram_post_image (composite) --------------------------------------

const postImageInput = {
  imageUrls: z
    .array(httpsUrlSchema)
    .min(1)
    .max(CAROUSEL_MAX)
    .optional()
    .describe(
      'Public HTTPS JPEG image URL(s) Instagram will fetch. One URL posts a single feed image; 2–10 ' +
        'URLs post a carousel album. Required unless resuming. Format/size/dimensions are unverifiable ' +
        'before Instagram fetches them.',
    ),
  caption: captionField,
  locationId: locationField,
  userTags: z
    .array(userTagSchema)
    .optional()
    .describe('User tags for a single feed image (not carousels): handles with optional 0–1 x/y.'),
  resumeContainerId: resumeField,
  apply: applyField,
};
type PostImageArgs = ToolInputArgs<typeof postImageInput>;

/**
 * Create (single image or 2–10 carousel) → poll → publish. Exported so tests can
 * force the in-progress path with `opts.maxPollMs = 0` (not a tool input).
 */
export async function runPostImage(
  args: PostImageArgs,
  ctx: ToolContext,
  opts: PublishFlowOptions = {},
): Promise<ToolResult> {
  const resuming = args.resumeContainerId !== undefined;
  const imageUrls = args.imageUrls ?? [];
  let stats: CaptionStats | undefined;
  const warnings: string[] = [];

  if (!resuming) {
    if (imageUrls.length < 1) {
      throw new InstagramError(
        'instagram_post_image needs at least one imageUrl (or a resumeContainerId to finish a prior attempt).',
        { kind: 'validation' },
      );
    }
    if (args.caption !== undefined) stats = assertCaptionWithinLimits(args.caption);
    for (const url of imageUrls) assertHttpsUrl(url, 'imageUrl');
    if (imageUrls.length >= CAROUSEL_MIN) assertCarouselSize(imageUrls.length);
    for (const url of imageUrls) {
      const w = imageUrlFormatWarning(url);
      if (w !== undefined) warnings.push(w);
    }
  }

  const createContainer = async (): Promise<string> => {
    if (imageUrls.length >= CAROUSEL_MIN) {
      const album = await createCarouselContainer(ctx.req, {
        igId: igIdOf(ctx),
        childImageUrls: imageUrls,
        caption: args.caption,
        locationId: args.locationId,
      });
      return album.id;
    }
    const imageUrl = imageUrls[0];
    if (imageUrl === undefined) {
      throw new InstagramError('No imageUrl to create a container from.', { kind: 'validation' });
    }
    const container = await createMediaContainer(ctx.req, {
      igId: igIdOf(ctx),
      imageUrl,
      caption: args.caption,
      locationId: args.locationId,
      userTags: args.userTags,
    });
    return container.id;
  };

  const details: Record<string, unknown> = resuming
    ? { resume_container_id: args.resumeContainerId }
    : {
        media_kind: imageUrls.length >= CAROUSEL_MIN ? 'carousel' : 'image',
        image_count: imageUrls.length,
      };
  if (stats !== undefined) details.caption = captionSummary(stats);
  if (warnings.length > 0) details.warnings = warnings;

  const intent: WriteIntent = {
    action: 'post_image',
    summary: resuming
      ? `Resume publishing container ${args.resumeContainerId}`
      : imageUrls.length >= CAROUSEL_MIN
        ? `Create a ${imageUrls.length}-image carousel and publish it to the feed`
        : 'Create a single feed image container and publish it',
    details,
  };

  return executePublish({ ctx, args, intent, createContainer }, opts);
}

const postImageTool = defineTool({
  name: 'instagram_post_image',
  title: 'Post an Instagram image or carousel',
  description:
    'Publish a single feed image, or a 2–10 image carousel, in one call: create the container(s), wait ' +
    'for processing, then publish. Preview (the default) performs nothing. If processing exceeds the ' +
    'poll budget the result is status=in_progress with a resume_container_id — re-run with apply:true ' +
    'and resumeContainerId to finish (never create a new post, which would duplicate it). Image format, ' +
    'byte size, and dimensions are validated by Instagram on fetch, not here.',
  package: 'publishing',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: postImageInput,
  logFields: (args) => ({
    images: args.imageUrls?.length ?? 0,
    resume: args.resumeContainerId !== undefined,
    apply: args.apply ?? false,
  }),
  handler: (args, ctx) => runPostImage(args, ctx),
});

// --- instagram_post_reel (composite) ---------------------------------------

const postReelInput = {
  videoUrl: httpsUrlSchema
    .optional()
    .describe(
      'Public HTTPS video URL for the reel (required unless resuming). Duration, codec, and size are ' +
        'unverifiable before Instagram fetches it.',
    ),
  caption: captionField,
  coverUrl: httpsUrlSchema.optional().describe('Public HTTPS cover image URL for the reel.'),
  thumbOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Cover frame offset in milliseconds (used when no coverUrl is given).'),
  shareToFeed: z.boolean().optional().describe('Also show the reel in the main feed.'),
  locationId: locationField,
  resumeContainerId: resumeField,
  apply: applyField,
};
type PostReelArgs = ToolInputArgs<typeof postReelInput>;

/** Create a REELS container → poll → publish. Exported for the maxPollMs=0 test path. */
export async function runPostReel(
  args: PostReelArgs,
  ctx: ToolContext,
  opts: PublishFlowOptions = {},
): Promise<ToolResult> {
  const resuming = args.resumeContainerId !== undefined;
  let stats: CaptionStats | undefined;

  if (!resuming) {
    if (args.videoUrl === undefined) {
      throw new InstagramError(
        'instagram_post_reel needs a videoUrl (or a resumeContainerId to finish a prior attempt).',
        { kind: 'validation' },
      );
    }
    assertHttpsUrl(args.videoUrl, 'videoUrl');
    if (args.coverUrl !== undefined) assertHttpsUrl(args.coverUrl, 'coverUrl');
    if (args.caption !== undefined) stats = assertCaptionWithinLimits(args.caption);
  }

  const createContainer = async (): Promise<string> => {
    const r = await createMediaContainer(ctx.req, {
      igId: igIdOf(ctx),
      mediaType: 'REELS',
      videoUrl: args.videoUrl,
      caption: args.caption,
      coverUrl: args.coverUrl,
      thumbOffset: args.thumbOffset,
      shareToFeed: args.shareToFeed,
      locationId: args.locationId,
    });
    return r.id;
  };

  const details: Record<string, unknown> = resuming
    ? { resume_container_id: args.resumeContainerId }
    : { media_kind: 'reel', share_to_feed: args.shareToFeed ?? undefined };
  if (stats !== undefined) details.caption = captionSummary(stats);

  const intent: WriteIntent = {
    action: 'post_reel',
    summary: resuming
      ? `Resume publishing container ${args.resumeContainerId}`
      : 'Create a reel container and publish it',
    details,
  };

  return executePublish({ ctx, args, intent, createContainer }, opts);
}

const postReelTool = defineTool({
  name: 'instagram_post_reel',
  title: 'Post an Instagram reel',
  description:
    'Publish a reel in one call: create the REELS container, wait for processing (reels can take a while), ' +
    'then publish. Preview performs nothing. If processing exceeds the poll budget the result is ' +
    'status=in_progress with a resume_container_id — re-run with apply:true and resumeContainerId to ' +
    'finish (never create a new post). Video duration, codec, and size are validated by Instagram on ' +
    'fetch, not here.',
  package: 'publishing',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: postReelInput,
  logFields: (args) => ({
    hasVideo: args.videoUrl !== undefined,
    resume: args.resumeContainerId !== undefined,
    apply: args.apply ?? false,
  }),
  handler: (args, ctx) => runPostReel(args, ctx),
});

// --- instagram_post_story (composite) --------------------------------------

const postStoryInput = {
  imageUrl: httpsUrlSchema
    .optional()
    .describe(
      'Public HTTPS JPEG image for a photo story. Provide exactly one of imageUrl or videoUrl.',
    ),
  videoUrl: httpsUrlSchema
    .optional()
    .describe('Public HTTPS video for a video story. Provide exactly one of imageUrl or videoUrl.'),
  resumeContainerId: resumeField,
  apply: applyField,
};
type PostStoryArgs = ToolInputArgs<typeof postStoryInput>;

/** Create a STORIES container → poll → publish. Exported for the maxPollMs=0 test path. */
export async function runPostStory(
  args: PostStoryArgs,
  ctx: ToolContext,
  opts: PublishFlowOptions = {},
): Promise<ToolResult> {
  const resuming = args.resumeContainerId !== undefined;

  if (!resuming) {
    const hasImage = args.imageUrl !== undefined;
    const hasVideo = args.videoUrl !== undefined;
    if (hasImage === hasVideo) {
      throw new InstagramError(
        'instagram_post_story needs exactly one of imageUrl or videoUrl (or a resumeContainerId).',
        { kind: 'validation' },
      );
    }
    if (args.imageUrl !== undefined) assertHttpsUrl(args.imageUrl, 'imageUrl');
    if (args.videoUrl !== undefined) assertHttpsUrl(args.videoUrl, 'videoUrl');
  }

  const createContainer = async (): Promise<string> => {
    const r = await createMediaContainer(ctx.req, {
      igId: igIdOf(ctx),
      mediaType: 'STORIES',
      imageUrl: args.imageUrl,
      videoUrl: args.videoUrl,
    });
    return r.id;
  };

  const details: Record<string, unknown> = resuming
    ? { resume_container_id: args.resumeContainerId }
    : { media_kind: 'story', source: args.imageUrl !== undefined ? 'image' : 'video' };

  const intent: WriteIntent = {
    action: 'post_story',
    summary: resuming
      ? `Resume publishing container ${args.resumeContainerId}`
      : 'Create a story container and publish it',
    details,
  };

  return executePublish({ ctx, args, intent, createContainer }, opts);
}

const postStoryTool = defineTool({
  name: 'instagram_post_story',
  title: 'Post an Instagram story',
  description:
    'Publish a photo or video story in one call: create the STORIES container, wait for processing, then ' +
    'publish. Provide exactly one of imageUrl or videoUrl. Preview performs nothing. If processing ' +
    'exceeds the poll budget the result is status=in_progress with a resume_container_id — re-run with ' +
    'apply:true and resumeContainerId to finish (never create a new post). Stories expire after 24 hours.',
  package: 'publishing',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: postStoryInput,
  logFields: (args) => ({
    source: args.imageUrl !== undefined ? 'image' : args.videoUrl !== undefined ? 'video' : 'none',
    resume: args.resumeContainerId !== undefined,
    apply: args.apply ?? false,
  }),
  handler: (args, ctx) => runPostStory(args, ctx),
});

// --- Package export ---------------------------------------------------------

/** Publishing tools, registered by `mcp/registry.ts`. */
export const publishingTools: ToolSpec[] = [
  createMediaContainerTool,
  getContainerStatusTool,
  publishMediaTool,
  getPublishingLimitTool,
  postImageTool,
  postReelTool,
  postStoryTool,
] as unknown as ToolSpec[];
