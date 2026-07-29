/**
 * Media domain functions (Layer 1). Read-only: list own media, fetch a single
 * media object (with carousel children), and list a carousel's children.
 *
 * These are pure functions over the injected {@link IgRequestFn} seam — they
 * build {@link IgRequestOptions}, call `req`, and return typed domain objects.
 * No `core/http`, no `mcp`/`tools` imports; policy (auth, retries, SSRF, usage
 * headers) lives behind `req`. Writes (e.g. toggling `comment_enabled`) and
 * publishing are intentionally out of scope here.
 *
 * This module also owns {@link fetchPagedEdge}, the ONE cursor-walk used by
 * every paginated edge in the api layer (`api/comments.ts` imports it) — the
 * loop's termination guards are safety-critical, so they exist once.
 *
 * Corner cases covered: CC-DATA-1 (stale cursor mid-listing), CC-DATA-2 (fields
 * Meta omits rather than nulls — every field but `id` is optional), CC-DATA-4
 * (`fetchAll` cap / off-by-one), CC-DATA-6 (open Meta enums pass through as
 * strings). CC-DATA-5 (deleted object) surfaces as a propagated InstagramError.
 */
import {
  isInstagramError,
  type GraphListResponse,
  type IgRequestFn,
  type IgRequestOptions,
} from '../core/types.js';

/** Field set requested for a media object (feed post, reel, story, album). */
const MEDIA_FIELDS = [
  'id',
  'caption',
  'media_type',
  'media_product_type',
  'media_url',
  'permalink',
  'thumbnail_url',
  'timestamp',
  'like_count',
  'comments_count',
].join(',');

/** Field set requested for each child of a carousel album. */
const CHILD_FIELDS = [
  'id',
  'media_type',
  'media_url',
  'thumbnail_url',
  'permalink',
  'timestamp',
].join(',');

/** `get_media` expands children inline so a carousel resolves in one call. */
const MEDIA_DETAIL_FIELDS = `${MEDIA_FIELDS},children{${CHILD_FIELDS}}`;

/**
 * A single child of a carousel album. `media_type` is an **open** enum — Meta
 * may add values (CC-DATA-6), so it stays a plain string.
 */
export interface MediaChild {
  id: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
}

/**
 * A media object as returned by list/get. Only `id` is guaranteed; Meta omits
 * (rather than nulls) fields it will not disclose — `like_count` hidden by the
 * author, `media_url` on copyright-muted media, counts on stories (CC-DATA-2).
 * `media_type`/`media_product_type` are open enums (CC-DATA-6).
 */
export interface MediaItem {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  permalink?: string;
  thumbnail_url?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

/** A media object plus its carousel children (present only for albums). */
export interface MediaDetail extends MediaItem {
  children?: MediaChild[];
}

/** Wire shape of a media object where children arrive as an inline edge. */
interface RawMediaDetail extends MediaItem {
  children?: { data?: MediaChild[] };
}

/** Flatten Graph's inline `children` edge to a plain array. */
function normalizeDetail(raw: RawMediaDetail): MediaDetail {
  const { children, ...rest } = raw;
  const detail: MediaDetail = { ...rest };
  if (children?.data) detail.children = children.data;
  return detail;
}

// --- Shared cursor pagination ----------------------------------------------

/**
 * Hard ceiling on the pages a single `fetchAll` will follow. With the default
 * `IG_MAX_ITEMS` (200) and a typical page size (25) a complete walk is ~8 pages,
 * so this only fires when the edge misbehaves — it is a safety net, not a cap
 * an ordinary listing can hit.
 */
const MAX_PAGES = 50;

/** Paging inputs shared by every listing. `maxItems` is always supplied by the
 * caller so the api layer never reads settings itself. */
export interface PageParams {
  /** Hard item cap for `fetchAll` (the resolved `IG_MAX_ITEMS`). */
  maxItems: number;
  /** Per-page size hint forwarded to Graph's `limit`. */
  limit?: number;
  /** Opaque cursor (`paging.cursors.after`) to resume from. */
  after?: string;
  /** Page beyond the first, up to `maxItems`. Defaults to a single page. */
  fetchAll?: boolean;
}

/**
 * Result of a listing. `after` is the cursor to continue from (present when a
 * single page left more, or when the walk stopped early with more to come).
 * `truncated` is true **iff** the read was cut short while more data genuinely
 * remained — a capped read is never presented as complete. `note` carries a
 * non-fatal explanation (a stale cursor, or an edge that stopped making
 * progress).
 */
export interface PagedResult<T> {
  items: T[];
  after?: string;
  truncated: boolean;
  note?: string;
}

export type PagedMedia = PagedResult<MediaItem>;

/**
 * Walk a Graph edge by cursor. Single page by default; with `fetchAll` follows
 * `paging.cursors.after` until the edge is exhausted or `maxItems` is reached
 * (CC-DATA-4). A cursor invalidated between pages keeps the partial result with
 * `truncated: true` and a `note` (CC-DATA-1); a first-page failure propagates.
 *
 * The walk is **bounded three ways**, because Graph can hand back a page that
 * makes no progress (privacy-filtered or deleted items yield `data: []` while
 * still advertising an `after` cursor) and an unbounded `for(;;)` would then
 * hammer Meta until the whole app is throttled:
 *
 *   1. the cursor must actually change (a repeated `after` is the same request);
 *   2. a page that contributed no items ends the walk;
 *   3. at most {@link MAX_PAGES} pages per call.
 *
 * Every such stop returns `truncated: true` plus the `after` cursor, so nothing
 * is silently dropped — the caller can resume exactly where the walk gave up.
 */
export async function fetchPagedEdge<TRaw, T>(
  req: IgRequestFn,
  build: (after: string | undefined) => IgRequestOptions,
  params: PageParams,
  normalize: (raw: TRaw) => T,
): Promise<PagedResult<T>> {
  const cap = Math.max(0, Math.floor(params.maxItems));
  const items: T[] = [];
  let cursor = params.after;
  let resultAfter: string | undefined;
  let truncated = false;
  let note: string | undefined;
  let pageIndex = 0;

  for (;;) {
    let page: GraphListResponse<TRaw>;
    try {
      page = await req<GraphListResponse<TRaw>>(build(cursor));
    } catch (err) {
      // CC-DATA-1: a cursor that went stale mid-listing keeps what we gathered.
      if (pageIndex > 0 && isInstagramError(err)) {
        note = 'cursor may be stale (data changed between pages) — restart the listing';
        truncated = true;
        break;
      }
      throw err;
    }
    pageIndex += 1;

    const data = page.data ?? [];
    let overflowed = false;
    let added = 0;
    for (const item of data) {
      if (items.length >= cap) {
        overflowed = true;
        break;
      }
      items.push(normalize(item));
      added += 1;
    }
    const nextAfter = page.paging?.cursors?.after;

    if (!params.fetchAll) {
      // Single page: expose the cursor so the caller can continue explicitly.
      resultAfter = nextAfter;
      if (overflowed) truncated = true;
      break;
    }
    if (items.length >= cap) {
      // Capped: truncated only when more data genuinely remains (CC-DATA-4).
      if (overflowed || nextAfter !== undefined) {
        truncated = true;
        resultAfter = nextAfter;
      }
      break;
    }
    if (nextAfter === undefined) break; // exhausted every page

    // Termination guards — each keeps what was gathered and hands back a cursor.
    if (nextAfter === cursor) {
      note = 'the edge returned the same cursor twice (no forward progress) — resume from `after`';
    } else if (added === 0) {
      note =
        'a page returned no items while more remained (filtered or deleted) — resume from `after`';
    } else if (pageIndex >= MAX_PAGES) {
      note = `stopped after ${MAX_PAGES} pages (per-call page ceiling) — resume from \`after\``;
    }
    if (note !== undefined) {
      truncated = true;
      resultAfter = nextAfter;
      break;
    }

    cursor = nextAfter;
  }

  const result: PagedResult<T> = { items, truncated };
  if (resultAfter !== undefined) result.after = resultAfter;
  if (note !== undefined) result.note = note;
  return result;
}

// --- list_media -------------------------------------------------------------

export interface ListMediaParams extends PageParams {
  /** IG account whose media to list — the numeric IG-user id or `me`. */
  igAccountId: string;
}

/**
 * List the operated account's own media, newest-first, cursor-paginated.
 * Pagination semantics (cap, resume cursor, termination guards) live in
 * {@link fetchPagedEdge}.
 */
export async function listMedia(req: IgRequestFn, params: ListMediaParams): Promise<PagedMedia> {
  return fetchPagedEdge<MediaItem, MediaItem>(
    req,
    (after) => ({
      method: 'GET',
      path: `/${params.igAccountId}/media`,
      params: { fields: MEDIA_FIELDS, limit: params.limit, after },
    }),
    params,
    (m) => m,
  );
}

export interface GetMediaParams {
  /** The IG media object id to fetch. */
  mediaId: string;
}

/**
 * Fetch a single media object by id, with carousel children expanded inline.
 * A deleted object / expired story is a Graph error that propagates as an
 * {@link import('../core/types.js').InstagramError} (CC-DATA-5).
 */
export async function getMedia(req: IgRequestFn, params: GetMediaParams): Promise<MediaDetail> {
  const raw = await req<RawMediaDetail>({
    method: 'GET',
    path: `/${params.mediaId}`,
    params: { fields: MEDIA_DETAIL_FIELDS },
  });
  return normalizeDetail(raw);
}

export interface GetMediaChildrenParams {
  /** The carousel-album media id whose children to list. */
  mediaId: string;
}

/**
 * List the children of a carousel album via the `/children` edge. Used as a
 * fallback when the inline expansion in {@link getMedia} is absent, and
 * available to callers that want children on their own.
 */
export async function getMediaChildren(
  req: IgRequestFn,
  params: GetMediaChildrenParams,
): Promise<MediaChild[]> {
  const res = await req<GraphListResponse<MediaChild>>({
    method: 'GET',
    path: `/${params.mediaId}/children`,
    params: { fields: CHILD_FIELDS },
  });
  return res.data ?? [];
}
