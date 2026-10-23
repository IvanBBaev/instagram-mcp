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
import {
  defineTool,
  type ToolContext,
  type ToolInputArgs,
  type ToolResult,
  type ToolSpec,
} from '../mcp/define.js';
import { json } from '../mcp/result.js';
import { withWriteGate, type WriteIntent } from '../mcp/write-mode.js';
import { InstagramError, isInstagramError } from '../core/types.js';
import { quoteGraphId } from '../core/errors.js';
import { PREVIEW_EXCERPT_MAX, previewExcerpt } from '../core/untrusted.js';
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
 * Consequence text for a container create acknowledged without an id. Nothing
 * was published — publishing needs the id — and there is no id to resume with,
 * so the honest advice is that a re-run starts over and the lost container, if
 * Graph made one, expires on its own (CC-PUB-3).
 */
const CONTAINER_ID_MISSING =
  'Nothing was published and there is no container to resume. Re-running creates a new ' +
  'container; one Graph may have made without reporting it expires unpublished within 24 h.';

/**
 * Consequence text for a `media_publish` acknowledged without an id. Graph may
 * have published anyway, so this must never read as "safe to retry": a second
 * publish of the same container is refused at best and a duplicate post at worst.
 */
function publishIdMissing(containerId: string): string {
  return (
    `The post may already be live. Do NOT publish container ${quoteGraphId(containerId)} again: read its ` +
    'state with instagram_get_container_status (PUBLISHED means the post exists) and find the ' +
    'post with instagram_list_media.'
  );
}

/**
 * Shared apply/preview driver for the three composite post tools. In preview
 * mode {@link withWriteGate} returns before `perform`, so no container is created
 * and no `media_publish` is issued. In apply mode it drives {@link runPublishFlow}
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
    args: { apply?: boolean; resumeContainerId?: string };
    intent: WriteIntent;
    createContainer: () => Promise<string>;
    warnings: readonly string[];
  },
  opts: PublishFlowOptions,
): Promise<ToolResult> {
  const { ctx, args, intent, createContainer, warnings } = params;
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
        { req: ctx.req, clock: ctx.clock, igId: igIdOf(ctx) },
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
  const resuming = args.resumeContainerId !== undefined;
  const imageUrls = args.imageUrls ?? [];
  let caption: Record<string, unknown> | undefined;
  const warnings: string[] = [];

  if (resuming) {
    const ignored = resumeIgnoredWarning(postImageInput, args);
    if (ignored !== undefined) warnings.push(ignored);
  } else {
    if (imageUrls.length < 1) {
      throw new InstagramError(
        'instagram_post_image needs at least one imageUrl (or a resumeContainerId to finish a prior attempt).',
        { kind: 'validation' },
      );
    }
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
  }

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
       above, so index 0 is always populated. Kept as a throw rather than a
       non-null assertion so a future refactor that breaks the invariant fails
       loudly instead of posting `undefined` to Graph. */
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

  const details: Record<string, unknown> = resuming
    ? { resume_container_id: args.resumeContainerId }
    : {
        media_kind: imageUrls.length >= CAROUSEL_MIN ? 'carousel' : 'image',
        image_count: imageUrls.length,
        media_hosts: mediaHosts(imageUrls),
      };
  if (caption !== undefined) details.caption = caption;
  if (!resuming && args.altTexts !== undefined)
    details.alt_texts = args.altTexts.map(previewExcerpt);
  if (!resuming && args.isAiGenerated !== undefined) details.ai_generated = args.isAiGenerated;
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

  return executePublish({ ctx, args, intent, createContainer, warnings }, opts);
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
  thumbOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Cover frame offset in milliseconds (used when no coverUrl is given).'),
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
  const resuming = args.resumeContainerId !== undefined;
  let caption: Record<string, unknown> | undefined;
  const warnings: string[] = [];

  if (resuming) {
    const ignored = resumeIgnoredWarning(postReelInput, args);
    if (ignored !== undefined) warnings.push(ignored);
  } else {
    if (args.videoUrl === undefined) {
      throw new InstagramError(
        'instagram_post_reel needs a videoUrl (or a resumeContainerId to finish a prior attempt).',
        { kind: 'validation' },
      );
    }
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
      isAiGenerated: args.isAiGenerated,
      trialGraduation: args.trialGraduation,
    });
    return acknowledgedId(r, 'media container', CONTAINER_ID_MISSING);
  };

  const details: Record<string, unknown> = resuming
    ? { resume_container_id: args.resumeContainerId }
    : // Equivalent-mutant note: `?? undefined` is a no-op — `shareToFeed` is
      // `boolean | undefined`, so both spellings write the same key with the
      // same value, and dropping the operator survives every test. It is kept
      // as the local marker that the key is emitted deliberately even when
      // unset: the preview is what an operator reads before approving a post,
      // and `share_to_feed: undefined` (pinned below) says "Instagram's default
      // applies" where an absent key reads as "this tool forgot to consider it".
      {
        media_kind: 'reel',
        share_to_feed: args.shareToFeed ?? undefined,
        media_hosts: mediaHosts([args.videoUrl, args.coverUrl]),
      };
  if (caption !== undefined) details.caption = caption;
  if (!resuming && args.isAiGenerated !== undefined) details.ai_generated = args.isAiGenerated;
  if (!resuming && args.trialGraduation !== undefined)
    details.trial_graduation = args.trialGraduation;
  // Same `details.warnings` channel the other publishing tools use — a list even
  // for one entry, so a caller reads warnings the same way everywhere, and
  // absent entirely when there is nothing to say (an always-present empty list
  // trains the operator to skim past the field).
  if (warnings.length > 0) details.warnings = warnings;

  const intent: WriteIntent = {
    action: 'post_reel',
    summary: resuming
      ? `Resume publishing container ${args.resumeContainerId}`
      : args.trialGraduation !== undefined
        ? 'Create a trial reel container and publish it to non-followers'
        : 'Create a reel container and publish it',
    details,
  };

  return executePublish({ ctx, args, intent, createContainer, warnings }, opts);
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
  const resuming = args.resumeContainerId !== undefined;
  const warnings: string[] = [];

  if (resuming) {
    const ignored = resumeIgnoredWarning(postStoryInput, args);
    if (ignored !== undefined) warnings.push(ignored);
  } else {
    const hasImage = args.imageUrl !== undefined;
    const hasVideo = args.videoUrl !== undefined;
    if (hasImage === hasVideo) {
      throw new InstagramError(
        'instagram_post_story needs exactly one of imageUrl or videoUrl (or a resumeContainerId).',
        { kind: 'validation' },
      );
    }
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
  }

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

  const details: Record<string, unknown> = resuming
    ? { resume_container_id: args.resumeContainerId }
    : {
        media_kind: 'story',
        source: args.imageUrl !== undefined ? 'image' : 'video',
        media_hosts: mediaHosts([args.imageUrl, args.videoUrl]),
      };
  if (!resuming && args.isAiGenerated !== undefined) details.ai_generated = args.isAiGenerated;
  if (warnings.length > 0) details.warnings = warnings;

  const intent: WriteIntent = {
    action: 'post_story',
    summary: resuming
      ? `Resume publishing container ${args.resumeContainerId}`
      : 'Create a story container and publish it',
    details,
  };

  return executePublish({ ctx, args, intent, createContainer, warnings }, opts);
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
export const publishingTools: readonly ToolSpec[] = Object.freeze([
  createMediaContainerTool,
  getContainerStatusTool,
  publishMediaTool,
  getPublishingLimitTool,
  postImageTool,
  postReelTool,
  postStoryTool,
] as unknown as ToolSpec[]);
