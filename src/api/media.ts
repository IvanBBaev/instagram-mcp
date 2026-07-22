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
 * Corner cases covered: CC-DATA-1 (stale cursor mid-listing), CC-DATA-2 (fields
 * Meta omits rather than nulls — every field but `id` is optional), CC-DATA-4
 * (`fetchAll` cap / off-by-one), CC-DATA-6 (open Meta enums pass through as
 * strings). CC-DATA-5 (deleted object) surfaces as a propagated InstagramError.
 */
import { isInstagramError, type GraphListResponse, type IgRequestFn } from '../core/types.js';

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

export interface ListMediaParams {
  /** IG account whose media to list — the numeric IG-user id or `me`. */
  igAccountId: string;
  /**
   * Hard item cap for `fetchAll` (the resolved `IG_MAX_ITEMS`). Always supplied
   * by the caller so the api layer never reads settings itself.
   */
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
 * single page left more, or when `fetchAll` stopped at the cap with more to
 * come). `truncated` is true **iff** the read was capped while more data
 * genuinely remained — a capped read is never presented as complete. `note`
 * carries a non-fatal explanation (e.g. a cursor that went stale mid-listing).
 */
export interface PagedMedia {
  items: MediaItem[];
  after?: string;
  truncated: boolean;
  note?: string;
}

/**
 * List the operated account's own media, newest-first, cursor-paginated.
 *
 * Single page by default. With `fetchAll`, follows `paging.cursors.after` until
 * the edge is exhausted or `maxItems` is reached (CC-DATA-4). If a cursor is
 * invalidated between pages (media deleted mid-listing), the partial result is
 * returned with `truncated: true` and a `note` rather than discarded
 * (CC-DATA-1); a first-page failure is a genuine error and propagates.
 */
export async function listMedia(req: IgRequestFn, params: ListMediaParams): Promise<PagedMedia> {
  const cap = Math.max(0, Math.floor(params.maxItems));
  const items: MediaItem[] = [];
  let cursor = params.after;
  let resultAfter: string | undefined;
  let truncated = false;
  let note: string | undefined;
  let pageIndex = 0;

  for (;;) {
    let page: GraphListResponse<MediaItem>;
    try {
      page = await req<GraphListResponse<MediaItem>>({
        method: 'GET',
        path: `/${params.igAccountId}/media`,
        params: { fields: MEDIA_FIELDS, limit: params.limit, after: cursor },
      });
    } catch (err) {
      // CC-DATA-1: a cursor that went stale mid-listing keeps what we gathered.
      if (pageIndex > 0 && isInstagramError(err)) {
        note = 'cursor may be stale (media changed between pages) — restart the listing';
        truncated = true;
        break;
      }
      throw err;
    }
    pageIndex += 1;

    const data = page.data ?? [];
    let overflowed = false;
    for (const item of data) {
      if (items.length >= cap) {
        overflowed = true;
        break;
      }
      items.push(item);
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
    cursor = nextAfter;
  }

  const result: PagedMedia = { items, truncated };
  if (resultAfter !== undefined) result.after = resultAfter;
  if (note !== undefined) result.note = note;
  return result;
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
