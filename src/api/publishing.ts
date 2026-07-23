/**
 * Publishing domain functions (Layer 1). The Instagram publish flow is
 * **two-phase**: create a media container (Meta ingests the media from a public
 * URL), then publish that container. These are pure functions over the injected
 * {@link IgRequestFn} seam plus an injectable {@link Clock} for the composite's
 * poll budget — no `core/http`, no `mcp`/`tools` imports.
 *
 * Verified Graph semantics (docs/tools.md, docs/operations.md, 2026-07-21):
 *   - a **feed image** container sends `image_url` with **no `media_type`**
 *     (`IMAGE`/`VIDEO` are invalid values); Reels/Stories/Carousel send theirs;
 *   - status_code ∈ IN_PROGRESS / FINISHED / ERROR / EXPIRED / PUBLISHED;
 *     subcode 2207027 = still processing → keep polling, never re-create;
 *   - the publishing quota total is read at **runtime** from `config.quota_total`
 *     (Meta docs conflict 100 vs 50 — never hardcoded); a carousel counts as 1;
 *   - `media_publish` is **never** auto-retried (duplicate-post risk).
 *
 * Content publishing works on BOTH auth paths, so host is left to the active
 * auth provider's default (no `host` override, no `paths` restriction).
 */
import type { GraphListResponse, IgRequestFn } from '../core/types.js';
import { InstagramError } from '../core/types.js';
import type { Clock } from '../core/clock.js';
import type { ContainerMediaType, UserTag } from './media-spec.js';

// --- create_media_container -------------------------------------------------

export interface CreateContainerParams {
  /** IG professional-account id, or `me`. */
  igId: string;
  /** Omit for a feed image (sends NO `media_type`); set for Reels/Stories/Carousel. */
  mediaType?: ContainerMediaType;
  imageUrl?: string;
  videoUrl?: string;
  caption?: string;
  locationId?: string;
  userTags?: UserTag[];
  /** Carousel album: 2–10 child container ids (validated at the tool layer). */
  children?: string[];
  /** Reels cover image URL. */
  coverUrl?: string;
  /** Reels/video: cover frame offset in milliseconds. */
  thumbOffset?: number;
  /** Reels: also cross-post to the feed. */
  shareToFeed?: boolean;
  /** Marks a container as a carousel item during album child creation. */
  isCarouselItem?: boolean;
}

/**
 * `POST /{ig-id}/media` — create a media container. Returns its id. A feed image
 * intentionally omits `media_type`. Array-valued fields are serialized the way
 * Graph expects: `children` as a comma-separated list, `user_tags` as JSON.
 */
export async function createMediaContainer(
  req: IgRequestFn,
  params: CreateContainerParams,
): Promise<{ id: string }> {
  const p: Record<string, string | number | boolean | undefined> = {};
  if (params.mediaType !== undefined) p.media_type = params.mediaType;
  if (params.imageUrl !== undefined) p.image_url = params.imageUrl;
  if (params.videoUrl !== undefined) p.video_url = params.videoUrl;
  if (params.caption !== undefined) p.caption = params.caption;
  if (params.locationId !== undefined) p.location_id = params.locationId;
  if (params.coverUrl !== undefined) p.cover_url = params.coverUrl;
  if (params.thumbOffset !== undefined) p.thumb_offset = params.thumbOffset;
  if (params.shareToFeed !== undefined) p.share_to_feed = params.shareToFeed;
  if (params.isCarouselItem === true) p.is_carousel_item = true;
  if (params.children !== undefined) p.children = params.children.join(',');
  if (params.userTags !== undefined) p.user_tags = JSON.stringify(params.userTags);

  const r = await req<{ id: string }>({
    method: 'POST',
    path: `/${params.igId}/media`,
    params: p,
  });
  return { id: r.id };
}

/**
 * Create a carousel album: one child container per image URL (each marked
 * `is_carousel_item`), then the album container (`media_type=CAROUSEL`) that
 * references them (CC-PUB-5/6). Child images send NO `media_type` (they are
 * feed images). Returns the album id plus the child ids created.
 */
export async function createCarouselContainer(
  req: IgRequestFn,
  params: { igId: string; childImageUrls: string[]; caption?: string; locationId?: string },
): Promise<{ id: string; childIds: string[] }> {
  const childIds: string[] = [];
  for (const imageUrl of params.childImageUrls) {
    const child = await createMediaContainer(req, {
      igId: params.igId,
      imageUrl,
      isCarouselItem: true,
    });
    childIds.push(child.id);
  }
  const album = await createMediaContainer(req, {
    igId: params.igId,
    mediaType: 'CAROUSEL',
    children: childIds,
    caption: params.caption,
    locationId: params.locationId,
  });
  return { id: album.id, childIds };
}

// --- get_container_status ---------------------------------------------------

/** Container processing state. `statusCode` is an open enum (string). */
export interface ContainerStatus {
  id: string;
  /** IN_PROGRESS / FINISHED / ERROR / EXPIRED / PUBLISHED (open enum). */
  statusCode?: string;
  /** Human-readable status detail, populated by Meta on ERROR. */
  status?: string;
}

/** `GET /{container-id}?fields=status_code,status`. Read-only, idempotent. */
export async function getContainerStatus(
  req: IgRequestFn,
  params: { containerId: string },
): Promise<ContainerStatus> {
  const r = await req<{ id: string; status_code?: string; status?: string }>({
    method: 'GET',
    path: `/${params.containerId}`,
    params: { fields: 'status_code,status' },
  });
  return { id: r.id, statusCode: r.status_code, status: r.status };
}

// --- publish_media ----------------------------------------------------------

/**
 * `POST /{ig-id}/media_publish?creation_id={container-id}` — publish a finished
 * container. Returns the new media id. NEVER auto-retried by any caller: a
 * duplicate post costs quota and is publicly visible (docs/operations.md §2).
 */
export async function publishMedia(
  req: IgRequestFn,
  params: { igId: string; creationId: string },
): Promise<{ id: string }> {
  const r = await req<{ id: string }>({
    method: 'POST',
    path: `/${params.igId}/media_publish`,
    params: { creation_id: params.creationId },
  });
  return { id: r.id };
}

// --- get_publishing_limit ---------------------------------------------------

export interface PublishingLimit {
  /** Containers published in the rolling window (a carousel counts as 1). */
  quotaUsage: number;
  /** Total allowance — read at runtime from `config.quota_total`, never hardcoded. */
  quotaTotal?: number;
  /** Rolling-window length in seconds, from `config.quota_duration`. */
  quotaDuration?: number;
  /** `quotaTotal - quotaUsage` when the total is known; otherwise absent. */
  remaining?: number;
}

interface PublishingLimitRow {
  quota_usage?: number;
  config?: { quota_total?: number; quota_duration?: number };
}

/**
 * `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config`. The quota
 * total is taken from `config.quota_total` at runtime (Meta docs conflict on the
 * number, so it is never hardcoded); `remaining` is derived only when known.
 */
export async function getPublishingLimit(
  req: IgRequestFn,
  params: { igId: string },
): Promise<PublishingLimit> {
  const res = await req<GraphListResponse<PublishingLimitRow>>({
    method: 'GET',
    path: `/${params.igId}/content_publishing_limit`,
    params: { fields: 'quota_usage,config' },
  });
  const row = res.data?.[0] ?? {};
  const quotaUsage = row.quota_usage ?? 0;
  const quotaTotal = row.config?.quota_total;
  const quotaDuration = row.config?.quota_duration;
  const limit: PublishingLimit = { quotaUsage };
  if (quotaTotal !== undefined) {
    limit.quotaTotal = quotaTotal;
    limit.remaining = Math.max(0, quotaTotal - quotaUsage);
  }
  if (quotaDuration !== undefined) limit.quotaDuration = quotaDuration;
  return limit;
}

// --- composite publish flow (create → poll → publish) -----------------------

/**
 * Internal (non-tool-input) poll budget. `maxPollMs = 0` is used by tests to hit
 * the resumable in-progress path with no real wait; the happy path returns
 * FINISHED on the first status check and never sleeps.
 */
export interface PublishFlowOptions {
  pollIntervalMs?: number;
  maxPollMs?: number;
}

export type PublishFlowResult =
  | { status: 'published'; containerId: string; mediaId: string }
  | { status: 'in_progress'; containerId: string }
  | { status: 'already_published'; containerId: string };

/**
 * Drive one container to publish: create it (or resume `resumeContainerId`
 * without re-creating — CC-PUB-2), poll its status against a deadline of
 * `clock.now() + maxPollMs`, then publish once it is FINISHED.
 *
 *   - FINISHED         → publish → `{ status: 'published', mediaId }`.
 *   - PUBLISHED        → `{ status: 'already_published' }` — never re-published
 *                        (the duplicate-post guard for a resumed container).
 *   - ERROR / EXPIRED  → throws {@link InstagramError}.
 *   - still processing at the deadline → `{ status: 'in_progress', containerId }`
 *                        so the caller can resume — NOT an error, NOT a retry.
 *
 * The status check runs BEFORE any sleep, so a container that is already
 * FINISHED (typical for images) publishes with zero waiting.
 */
export async function runPublishFlow(
  deps: { req: IgRequestFn; clock: Clock; igId: string },
  args: { resumeContainerId?: string; createContainer: () => Promise<string> },
  opts: PublishFlowOptions = {},
): Promise<PublishFlowResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const maxPollMs = opts.maxPollMs ?? 60000;
  const { req, clock, igId } = deps;

  const containerId = args.resumeContainerId ?? (await args.createContainer());
  const deadline = clock.now() + maxPollMs;

  for (;;) {
    const st = await getContainerStatus(req, { containerId });
    const code = (st.statusCode ?? '').toUpperCase();
    if (code === 'FINISHED') break;
    if (code === 'PUBLISHED') return { status: 'already_published', containerId };
    if (code === 'ERROR') {
      throw new InstagramError(
        `Container ${containerId} failed processing (status ERROR${st.status ? `: ${st.status}` : ''}); re-create it.`,
        { kind: 'upstream' },
      );
    }
    if (code === 'EXPIRED') {
      throw new InstagramError(
        `Container ${containerId} expired before it was published; re-create it.`,
        { kind: 'validation' },
      );
    }
    // IN_PROGRESS (or an unknown/empty code) — keep polling within the budget.
    if (clock.now() >= deadline) return { status: 'in_progress', containerId };
    await clock.sleep(pollIntervalMs);
  }

  const published = await publishMedia(req, { igId, creationId: containerId });
  return { status: 'published', containerId, mediaId: published.id };
}
