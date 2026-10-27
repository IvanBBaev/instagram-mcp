/**
 * Publishing tool specs (Layer 3) — the `publishing` package. Two granular
 * primitives plus three convenience composites over the two-phase Instagram
 * publish flow (create container → poll → publish), and the one way to take a
 * published media object back down:
 *
 *   - instagram_create_media_container   (write) low-level container create
 *   - instagram_get_container_status     (read)  poll a container's state
 *   - instagram_publish_media            (write) publish a finished container
 *   - instagram_get_publishing_limit     (read)  rolling-window quota
 *   - instagram_post_image               (write) image/carousel: create→publish
 *   - instagram_post_reel                (write) reel: create→poll→publish
 *   - instagram_post_story               (write) story: create→poll→publish
 *   - instagram_delete_media             (write) DESTRUCTIVE: delete published media
 *
 * Every mutation passes through {@link withWriteGate}: a **preview** (the
 * default) describes exactly what would happen and calls NOTHING (no container
 * create, no `media_publish`); an **apply** run performs it and is journaled.
 * A composite that is still processing when the poll budget elapses returns a
 * non-error `in_progress` result carrying `resume_container_id` — `media_publish`
 * is NEVER auto-retried, so the operator resumes explicitly rather than risking
 * a duplicate post (docs/operations.md §2, architecture §10).
 * That flow — resume arm, write gate, outcomes, failure re-attachment — is one
 * shape for all three composites and lives in `tools/publish-flow.ts`
 * ({@link runComposite}); each composite here supplies only its validation, the
 * preview of a new post and its container create.
 * `instagram_delete_media` is the package's only destructive tool and is
 * additionally gated by `IG_ALLOW_DESTRUCTIVE`, like `instagram_delete_comment`.
 *
 * The server never fetches user-supplied media URLs (SSRF policy), so only
 * structural checks are possible here — https URL form, caption limits, carousel
 * bounds. Pixel format, byte size, aspect ratio, and video duration cannot be
 * verified until Instagram fetches the URL at container creation. The one hint
 * available pre-fetch is the URL's extension, and it is applied uniformly:
 * EVERY still-image field — `imageUrl`, each carousel url, the story image and
 * the reel `coverUrl` — goes through {@link imageUrlFormatWarning} and surfaces
 * through `details.warnings` in the preview and `warnings` in the applied result
 * (CC-PUB-25 (a)). A video extension on one of those fields draws its own
 * sentence (CC-PUB-23). Video fields get no hint: a video extension is exactly
 * right there, and a field warned in one tool but not in another would teach a
 * rule that does not exist.
 *
 * The preview an operator approves for a composite post shows the caption
 * itself — a sanitised, truncated excerpt beside its counts — and the HOST of
 * every media URL, never its path or query, which may carry a signature
 * (CC-PUB-60, CC-PUB-8). A resume that was also handed media inputs says which
 * ones it ignores (CC-PUB-59).
 *
 * Import boundary: `api/*` + `mcp/*` only; never `core/http`.
 */
import { z } from 'zod';
import { graphObjectId } from './ids.js';
import { acknowledgedId } from './ack.js';
import { boundedArray } from './arrays.js';
import { publishIdMissing, runComposite, type FreshPost } from './publish-flow.js';
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
import { quoteGraphId } from '../core/errors.js';
import { PREVIEW_EXCERPT_MAX, previewExcerpt } from '../core/untrusted.js';
import {
  createCarouselContainer,
  createMediaContainer,
  deleteMedia,
  getContainerStatus,
  getPublishingLimit,
  publishMedia,
  type PublishFlowOptions,
} from '../api/publishing.js';
import {
  altText,
  assertCaptionWithinLimits,
  assertCarouselSize,
  assertHttpsUrl,
  containerMediaTypeSchema,
  httpsUrl,
  imageUrlFormatWarning,
  trialGraduationSchema,
  userTagSchema,
  MAX_USER_TAGS,
  CAROUSEL_MAX,
  CAROUSEL_MIN,
  type CaptionStats,
} from '../api/media-spec.js';

// --- Shared input fields ----------------------------------------------------

// Equivalent-mutant note (the shared INPUT fields below, and nothing else —
// see the caveat at the end): every `x !== undefined` guard on one of these
// fields reads the same as a bare truthiness test, and no test can tell the two
// apart — the value that would, a falsy-but-PRESENT one, is unreachable by
// construction:
//
//   - the media URLs are `httpsUrl()`, whose pattern refuses `''` (and whose
//     refinement would too — `new URL('')` throws), so an empty URL never
//     reaches a handler;
//   - `resumeContainerId`, `locationId`, `creationId`, `containerId` and each
//     carousel child are `graphObjectId()` — 1-64 characters of `[A-Za-z0-9_-]`,
//     so `''` is refused and no id can carry whitespace, which is equally why
//     wrapping one in `.trim()` on the way out is a no-op;
//   - `children` and `userTags` are arrays, and every array is truthy;
//     `.optional()` admits `undefined`, never `null`;
//   - `imageUrlFormatWarning` returns either `undefined` or a full sentence, so
//     `if (w !== undefined)` and `if (w)` are the same test on its result.
//
// They are written `!== undefined` regardless, because the statement being made
// is about ABSENCE — "the caller did not pass this field" — and the day one of
// these schemas is widened is not the day a guard should quietly change meaning.
// `caption` is the exception that proves the rule: `''` IS a legal caption, and
// the truthiness relaxation is caught wherever its stats reach a preview.
//
// The scope is the caller-supplied fields above and nothing else — the header
// used to say "module-wide", and that was measurably false. The `x !== undefined`
// guards on API-RESPONSE fields further down this module (`st.statusCode`,
// `st.status`, `limit.quotaTotal`, `limit.quotaDuration`, `limit.remaining`) are
// NOT equivalent, because Graph can answer `''` or `0` there and every one of the
// five is pinned. Relaxing either status guard is killed by "an empty status
// string is passed through rather than swallowed"; relaxing any of the three
// quota guards is killed by "a quota with nothing left reports remaining zero
// instead of staying silent", which feeds `quota_total`, `quota_duration` and
// `remaining` all as `0`.

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

const locationField = graphObjectId()
  .optional()
  .describe('Instagram location Page id to tag on the post.');

const aiGeneratedField = z
  .boolean()
  .optional()
  .describe(
    "Label the post as made or edited with AI (sent as is_ai_generated). Omit to leave Instagram's " +
      'default; not accepted on a carousel child.',
  );

const trialGraduationField = trialGraduationSchema
  .optional()
  .describe(
    'Reels only: publish as a trial reel, shown to non-followers first (sent as trial_params). ' +
      'MANUAL graduates it to followers from the Instagram app; SS_PERFORMANCE graduates it ' +
      'automatically if it performs well. Omit for a regular reel.',
  );

const resumeField = graphObjectId()
  .optional()
  .describe(
    'Resume a container from a previous apply that returned status=in_progress: pass its ' +
      'resume_container_id to finish publishing instead of creating a new post (avoids a duplicate). ' +
      'When set, the media inputs are ignored.',
  );

/**
 * The reel cover-frame offset, declared once for `instagram_create_media_container`
 * and `instagram_post_reel`. A factory rather than a shared constant, like
 * `httpsUrl()` (CC-PUB-35): each field builds its own instance and carries its
 * own description, so neither tool's published schema can turn into a `$ref`
 * to the other's, and the two descriptions — which say different things about
 * when the offset applies — stay separate.
 */
function thumbOffsetField(description: string) {
  return z.number().int().min(0).optional().describe(description);
}

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
  // `??`, not `||`: a blank configured id must stay blank (the request then
  // fails upstream) rather than silently acting on the token owner's `/me/...`.
  // Pinned by test, as in `instagram_get_account` and `instagram_list_media`.
  return ctx.profile.accountId ?? 'me';
}

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

/**
 * Consequence text for a container create acknowledged without an id. Nothing
 * was published — publishing needs the id — and there is no id to resume with,
 * so the honest advice is that a re-run starts over and the lost container, if
 * Graph made one, expires on its own (CC-PUB-3).
 */
const CONTAINER_ID_MISSING =
  'Nothing was published and there is no container to resume. Re-running creates a new ' +
  'container; one Graph may have made without reporting it expires unpublished within 24 h.';

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

// --- Package export ---------------------------------------------------------

/** Publishing tools, registered by `mcp/registry.ts`. */
export const publishingTools: readonly ToolSpec[] = Object.freeze([
  createMediaContainerTool,
  getContainerStatusTool,
  publishMediaTool,
  getPublishingLimitTool,
  postImageTool,
  postReelTool,
  postStoryTool,
  deleteMediaTool,
] as unknown as ToolSpec[]);
