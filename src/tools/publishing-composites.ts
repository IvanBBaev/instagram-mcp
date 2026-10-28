/**
 * Publishing composites (Layer 3) — the one-call post tools of the `publishing`
 * package, each create → poll → publish:
 *
 *   - instagram_post_image               (write) image/carousel: create→publish
 *   - instagram_post_reel                (write) reel: create→poll→publish
 *   - instagram_post_story               (write) story: create→poll→publish
 *
 * The flow they share — resume arm, write gate, outcomes, failure
 * re-attachment — lives in `tools/publish-flow.ts` ({@link runComposite}); each
 * composite here supplies only its validation, the preview of a new post and its
 * container create. `tools/publishing.ts` joins these with the container tools
 * and the delete into the package's aggregate `publishingTools`.
 *
 * Import boundary: `api/*` + `mcp/*` only; never `core/http`.
 */
import { z } from 'zod';
import { acknowledgedId } from './ack.js';
import { boundedArray } from './arrays.js';
import { runComposite, type FreshPost } from './publish-flow.js';
import {
  applyField,
  aiGeneratedField,
  captionField,
  CONTAINER_ID_MISSING,
  igIdOf,
  locationField,
  resumeField,
  thumbOffsetField,
  trialGraduationField,
} from './publishing-shared.js';
import {
  defineTool,
  type ToolContext,
  type ToolInputArgs,
  type ToolResult,
  type ToolSpec,
} from '../mcp/define.js';
import { InstagramError } from '../core/types.js';
import { quoteGraphId } from '../core/errors.js';
import { PREVIEW_EXCERPT_MAX, previewExcerpt } from '../core/untrusted.js';
import {
  createCarouselContainer,
  createMediaContainer,
  type PublishFlowOptions,
} from '../api/publishing.js';
import {
  altText,
  assertCaptionWithinLimits,
  assertCarouselSize,
  assertHttpsUrl,
  httpsUrl,
  imageUrlFormatWarning,
  userTagSchema,
  MAX_USER_TAGS,
  CAROUSEL_MAX,
  CAROUSEL_MIN,
  type CaptionStats,
} from '../api/media-spec.js';

// --- Preview helpers --------------------------------------------------------

/**
 * Longest caption excerpt a preview shows, in code points (CC-PUB-60): the
 * shared {@link PREVIEW_EXCERPT_MAX}, which the comment-write previews use too.
 */
export const CAPTION_EXCERPT_MAX = PREVIEW_EXCERPT_MAX;

/**
 * Caption summary for a preview payload: the excerpt the operator reads before
 * approving a public post, then the counts the limits are enforced on
 * (CC-PUB-60). The excerpt comes first so it is the part of the details blob the
 * reader meets first.
 */
function captionSummary(caption: string, stats: CaptionStats): Record<string, unknown> {
  return {
    excerpt: previewExcerpt(caption),
    characters: stats.codePoints,
    hashtags: stats.hashtags,
    mentions: stats.mentions,
  };
}

/**
 * The distinct hosts of the given media URLs, in argument order (CC-PUB-60). The
 * host tells the operator whose CDN Instagram will fetch from; the path and query
 * are withheld because a pre-signed URL carries its credential there (CC-PUB-8),
 * and `URL.host` never includes userinfo. Every URL has already passed
 * `assertHttpsUrl`, so the parse cannot throw here.
 */
function mediaHosts(urls: readonly (string | undefined)[]): string[] {
  const hosts: string[] = [];
  for (const url of urls) {
    if (url === undefined) continue;
    const host = new URL(url).host;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

// --- instagram_post_image (composite) --------------------------------------

const postImageInput = {
  imageUrls: boundedArray(httpsUrl(), 1, CAROUSEL_MAX)
    .optional()
    .describe(
      'Public HTTPS JPEG image URL(s) Instagram will fetch. One URL posts a single feed image; 2–10 ' +
        'URLs post a carousel album. Required unless resuming. Format/size/dimensions are unverifiable ' +
        'before Instagram fetches them.',
    ),
  altTexts: boundedArray(altText(), 1, CAROUSEL_MAX)
    .optional()
    .describe(
      'Alt text per image, in the same order as imageUrls — exactly one entry per URL, each ≤ 1000 ' +
        'characters. Omit to post without alt text.',
    ),
  caption: captionField,
  locationId: locationField,
  userTags: boundedArray(userTagSchema, 0, MAX_USER_TAGS)
    .optional()
    .describe(
      'User tags for a single feed image (not carousels), at most 20: handles without "@" (letters, digits, "." and "_") with optional 0–1 x/y.',
    ),
  isAiGenerated: aiGeneratedField,
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
  const imageUrls = args.imageUrls ?? [];

  const fresh = (): FreshPost => {
    if (imageUrls.length < 1) {
      throw new InstagramError(
        'instagram_post_image needs at least one imageUrl (or a resumeContainerId to finish a prior attempt).',
        { kind: 'validation' },
      );
    }
    const warnings: string[] = [];
    let caption: Record<string, unknown> | undefined;
    if (args.caption !== undefined) {
      caption = captionSummary(args.caption, assertCaptionWithinLimits(args.caption));
    }
    for (const url of imageUrls) assertHttpsUrl(url, 'imageUrl');
    // Equivalent-mutant note: `>=` here can be spelled `>` (or even
    // `>= CAROUSEL_MAX`) with no observable difference, because the only bound
    // this call can still enforce is the upper one. An EMPTY list is already gone
    // (the `< 1` throw above); a list of 1 is a legal single image, and what keeps
    // it out of the carousel check is this guard rather than that throw — the note
    // said "a list of 1" until 2026-09-23, which credited the wrong line. From
    // there on the reasoning is unchanged: `assertCarouselSize` passes everything from
    // CAROUSEL_MIN up to CAROUSEL_MAX — so at exactly CAROUSEL_MIN the call is a
    // no-op and skipping it is indistinguishable from making it. `>=` is kept
    // because it states the actual rule — "this is a carousel, check it against
    // the carousel bounds" — rather than an off-by-one that happens to work; a
    // future change to the lower bound would then be caught here instead of
    // slipping through a guard tuned to the old value.
    if (imageUrls.length >= CAROUSEL_MIN) assertCarouselSize(imageUrls.length);
    // Index-aligned with imageUrls, so a length mismatch has no meaning to
    // guess at: which image a lone extra (or missing) entry belongs to is
    // exactly what the caller has to say.
    if (args.altTexts !== undefined && args.altTexts.length !== imageUrls.length) {
      throw new InstagramError(
        `altTexts needs exactly one entry per imageUrl, in the same order (got ${args.altTexts.length} ` +
          `for ${imageUrls.length} image(s)).`,
        { kind: 'validation' },
      );
    }
    for (const url of imageUrls) {
      const w = imageUrlFormatWarning(url);
      if (w !== undefined) warnings.push(w);
    }
    // CC-PUB-6: a carousel has nowhere to put user tags. Graph accepts
    // `user_tags` on a single feed image only, so `createCarouselContainer`
    // sends none — neither on the children nor on the album — and an album
    // posts untagged whatever was passed here. The field description says
    // "(not carousels)", but a description is advice the caller may not have
    // read and this is a fact about the request that actually went out: the
    // preview is what an operator approves, and approving one that lists tags
    // for a post that will carry none is a promise the tool cannot keep. Tags
    // cannot be added to a published carousel afterwards either.
    // Warned rather than refused on purpose — the album itself is exactly what
    // was asked for, and refusing the whole post over an extra field that
    // changes nothing would be the more expensive failure.
    if (args.userTags !== undefined && imageUrls.length >= CAROUSEL_MIN) {
      warnings.push(
        `userTags is ignored for a carousel: Instagram accepts user tags on a single feed image ` +
          `only, so the ${args.userTags.length} tag(s) passed are NOT applied to this album.`,
      );
    }

    const details: Record<string, unknown> = {
      media_kind: imageUrls.length >= CAROUSEL_MIN ? 'carousel' : 'image',
      image_count: imageUrls.length,
      media_hosts: mediaHosts(imageUrls),
    };
    if (caption !== undefined) details.caption = caption;
    if (args.altTexts !== undefined) details.alt_texts = args.altTexts.map(previewExcerpt);
    if (args.isAiGenerated !== undefined) details.ai_generated = args.isAiGenerated;
    return {
      details,
      warnings,
      summary:
        imageUrls.length >= CAROUSEL_MIN
          ? `Create a ${imageUrls.length}-image carousel and publish it to the feed`
          : 'Create a single feed image container and publish it',
    };
  };

  const createContainer = async (): Promise<string> => {
    if (imageUrls.length >= CAROUSEL_MIN) {
      const album = await createCarouselContainer(ctx.req, {
        igId: igIdOf(ctx),
        childImageUrls: imageUrls,
        childAltTexts: args.altTexts,
        caption: args.caption,
        locationId: args.locationId,
        isAiGenerated: args.isAiGenerated,
      });
      return acknowledgedId(
        album,
        'carousel album container',
        `${CONTAINER_ID_MISSING} Child containers already created: ${album.childIds.map(quoteGraphId).join(', ')}.`,
      );
    }
    const imageUrl = imageUrls[0];
    /* c8 ignore start -- unreachable: a narrowing guard for `noUncheckedIndexedAccess`.
       This closure only runs when there is no `resumeContainerId` (see
       `runPublishFlow`), and that path already threw on `imageUrls.length < 1`
       in `fresh` above, so index 0 is always populated. Kept as a throw rather
       than a non-null assertion so a future refactor that breaks the invariant
       fails loudly instead of posting `undefined` to Graph. */
    if (imageUrl === undefined) {
      throw new InstagramError('No imageUrl to create a container from.', { kind: 'validation' });
    }
    /* c8 ignore stop */
    const container = await createMediaContainer(ctx.req, {
      igId: igIdOf(ctx),
      imageUrl,
      altText: args.altTexts?.[0],
      caption: args.caption,
      locationId: args.locationId,
      userTags: args.userTags,
      isAiGenerated: args.isAiGenerated,
    });
    return acknowledgedId(container, 'media container', CONTAINER_ID_MISSING);
  };

  return runComposite(
    {
      ctx,
      igId: igIdOf(ctx),
      action: 'post_image',
      input: postImageInput,
      args,
      fresh,
      createContainer,
    },
    opts,
  );
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
  videoUrl: httpsUrl()
    .optional()
    .describe(
      'Public HTTPS video URL for the reel (required unless resuming). Duration, codec, and size are ' +
        'unverifiable before Instagram fetches it.',
    ),
  caption: captionField,
  coverUrl: httpsUrl().optional().describe('Public HTTPS cover image URL for the reel.'),
  thumbOffset: thumbOffsetField(
    'Cover frame offset in milliseconds (used when no coverUrl is given).',
  ),
  shareToFeed: z.boolean().optional().describe('Also show the reel in the main feed.'),
  locationId: locationField,
  isAiGenerated: aiGeneratedField,
  trialGraduation: trialGraduationField,
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
  const fresh = (): FreshPost => {
    if (args.videoUrl === undefined) {
      throw new InstagramError(
        'instagram_post_reel needs a videoUrl (or a resumeContainerId to finish a prior attempt).',
        { kind: 'validation' },
      );
    }
    const warnings: string[] = [];
    let caption: Record<string, unknown> | undefined;
    assertHttpsUrl(args.videoUrl, 'videoUrl');
    if (args.coverUrl !== undefined) {
      assertHttpsUrl(args.coverUrl, 'coverUrl');
      // The cover is a still image with the same JPEG constraint as a feed
      // image, so it gets the same non-fatal hint every other still-image field
      // gets — including the video sentence when a `.mp4` lands here (CC-PUB-23).
      // `videoUrl` gets none: a video extension is exactly right there.
      const coverWarning = imageUrlFormatWarning(args.coverUrl);
      if (coverWarning !== undefined) warnings.push(coverWarning);
    }
    if (args.caption !== undefined) {
      caption = captionSummary(args.caption, assertCaptionWithinLimits(args.caption));
    }

    // Equivalent-mutant note: `?? undefined` is a no-op — `shareToFeed` is
    // `boolean | undefined`, so both spellings write the same key with the
    // same value, and dropping the operator survives every test. It is kept
    // as the local marker that the key is emitted deliberately even when
    // unset: the preview is what an operator reads before approving a post,
    // and `share_to_feed: undefined` (pinned below) says "Instagram's default
    // applies" where an absent key reads as "this tool forgot to consider it".
    const details: Record<string, unknown> = {
      media_kind: 'reel',
      share_to_feed: args.shareToFeed ?? undefined,
      media_hosts: mediaHosts([args.videoUrl, args.coverUrl]),
    };
    if (caption !== undefined) details.caption = caption;
    if (args.isAiGenerated !== undefined) details.ai_generated = args.isAiGenerated;
    if (args.trialGraduation !== undefined) details.trial_graduation = args.trialGraduation;
    return {
      details,
      warnings,
      summary:
        args.trialGraduation !== undefined
          ? 'Create a trial reel container and publish it to non-followers'
          : 'Create a reel container and publish it',
    };
  };

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
      isAiGenerated: args.isAiGenerated,
      trialGraduation: args.trialGraduation,
    });
    return acknowledgedId(r, 'media container', CONTAINER_ID_MISSING);
  };

  return runComposite(
    {
      ctx,
      igId: igIdOf(ctx),
      action: 'post_reel',
      input: postReelInput,
      args,
      fresh,
      createContainer,
    },
    opts,
  );
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
  imageUrl: httpsUrl()
    .optional()
    .describe(
      'Public HTTPS JPEG image for a photo story. Provide exactly one of imageUrl or videoUrl.',
    ),
  videoUrl: httpsUrl()
    .optional()
    .describe('Public HTTPS video for a video story. Provide exactly one of imageUrl or videoUrl.'),
  isAiGenerated: aiGeneratedField,
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
  const fresh = (): FreshPost => {
    const hasImage = args.imageUrl !== undefined;
    const hasVideo = args.videoUrl !== undefined;
    if (hasImage === hasVideo) {
      throw new InstagramError(
        'instagram_post_story needs exactly one of imageUrl or videoUrl (or a resumeContainerId).',
        { kind: 'validation' },
      );
    }
    const warnings: string[] = [];
    if (args.imageUrl !== undefined) {
      assertHttpsUrl(args.imageUrl, 'imageUrl');
      // A photo story is a still image under the same JPEG rule as a feed image.
      // Without this the byte-identical `.png` that warns on `instagram_post_image`
      // published in silence here, which reads as approval rather than as an
      // unchecked field. A `.mp4` here draws the video sentence (CC-PUB-23). The
      // video story is left unhinted for the reason given in `instagram_post_reel`.
      //
      // Equivalent-mutant note: `args.videoUrl ?? args.imageUrl` cannot be told
      // from `args.imageUrl` at this line — the `hasImage === hasVideo` throw
      // above guarantees exactly one of the two is set, so inside this branch
      // `args.videoUrl` is always `undefined`.
      const imageWarning = imageUrlFormatWarning(args.imageUrl);
      if (imageWarning !== undefined) warnings.push(imageWarning);
    }
    if (args.videoUrl !== undefined) assertHttpsUrl(args.videoUrl, 'videoUrl');

    const details: Record<string, unknown> = {
      media_kind: 'story',
      source: args.imageUrl !== undefined ? 'image' : 'video',
      media_hosts: mediaHosts([args.imageUrl, args.videoUrl]),
    };
    if (args.isAiGenerated !== undefined) details.ai_generated = args.isAiGenerated;
    return { details, warnings, summary: 'Create a story container and publish it' };
  };

  const createContainer = async (): Promise<string> => {
    const r = await createMediaContainer(ctx.req, {
      igId: igIdOf(ctx),
      mediaType: 'STORIES',
      imageUrl: args.imageUrl,
      videoUrl: args.videoUrl,
      isAiGenerated: args.isAiGenerated,
    });
    return acknowledgedId(r, 'media container', CONTAINER_ID_MISSING);
  };

  return runComposite(
    {
      ctx,
      igId: igIdOf(ctx),
      action: 'post_story',
      input: postStoryInput,
      args,
      fresh,
      createContainer,
    },
    opts,
  );
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

/** The composite post tools, in the order `publishingTools` lists them. */
export const publishingCompositeTools: readonly ToolSpec[] = Object.freeze([
  postImageTool,
  postReelTool,
  postStoryTool,
] as unknown as ToolSpec[]);
