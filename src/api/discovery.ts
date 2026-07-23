/**
 * Discovery domain functions (Layer 1). Read-only Graph calls that reach beyond
 * the operated account into Instagram's PUBLIC content graph: hashtag search,
 * a hashtag's top/recent media, and business/creator profile discovery.
 *
 * These are Facebook-Graph endpoints — **Path B (`fb-login`) only** — so every
 * call pins `host: 'graph.facebook.com'` and passes the operated account's IG id
 * as the `user_id` the endpoints require. They further depend on Meta's
 * "Instagram Public Content Access" feature, which may stay App-Review-gated;
 * that gate surfaces as a propagated {@link import('../core/types.js').InstagramError}
 * from the mapping layer, not client-side logic here.
 *
 * Pure functions over the injected {@link IgRequestFn} seam — no `core/http`,
 * no `mcp`/`tools` imports. Every field Meta may omit is optional (CC-DATA-2);
 * open enums (`media_type`, …) pass through as plain strings (CC-DATA-6).
 */
import type { GraphListResponse, IgRequestFn } from '../core/types.js';

// --- search_hashtag --------------------------------------------------------

/** A hashtag node reference — the opaque numeric hashtag id Meta assigns. */
export interface HashtagRef {
  id: string;
}

/**
 * `GET /ig_hashtag_search?user_id={ig-id}&q=<hashtag>` on graph.facebook.com —
 * resolve a hashtag name to its id(s). `query` is the hashtag **without** a
 * leading `#`. Returns the raw `data` array (usually a single id). Counts
 * against Meta's 30-unique-hashtags / 7-days-per-account budget — the tool
 * layer surfaces a best-effort counter for that.
 */
export async function searchHashtag(
  req: IgRequestFn,
  params: { igId: string; query: string },
): Promise<HashtagRef[]> {
  const res = await req<GraphListResponse<HashtagRef>>({
    method: 'GET',
    path: '/ig_hashtag_search',
    params: { user_id: params.igId, q: params.query },
    host: 'graph.facebook.com',
  });
  return res.data ?? [];
}

// --- get_hashtag_media -----------------------------------------------------

/** Which hashtag media edge to read: `top_media` vs `recent_media`. */
export type HashtagEdge = 'top' | 'recent';

/**
 * A public media object under a hashtag edge. Only `id` is guaranteed; Meta
 * omits (rather than nulls) fields it will not disclose (CC-DATA-2). The owner's
 * username is intentionally absent — hashtag media is public but not attributed.
 * `media_type` is an open enum (CC-DATA-6).
 */
export interface HashtagMediaItem {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

/** Field set requested for each hashtag media object. */
const HASHTAG_MEDIA_FIELDS = [
  'id',
  'caption',
  'media_type',
  'media_url',
  'permalink',
  'timestamp',
  'like_count',
  'comments_count',
].join(',');

export interface HashtagMediaParams {
  /** The hashtag id from {@link searchHashtag}. */
  hashtagId: string;
  /** Operated IG account id (required as `user_id` by these endpoints). */
  igId: string;
  /** Which edge to read. */
  edge: HashtagEdge;
  /** Hard item cap (the resolved `IG_MAX_ITEMS`); always supplied by the caller. */
  maxItems: number;
  /** Per-page size hint forwarded to Graph's `limit`. */
  limit?: number;
}

/**
 * Result of a hashtag-media read. `after` is the continuation cursor Graph
 * returned (when present). `truncated` is true **iff** the returned page held
 * more than `maxItems`, so a capped read is never presented as complete.
 */
export interface PagedHashtagMedia {
  items: HashtagMediaItem[];
  after?: string;
  truncated: boolean;
}

/**
 * `GET /{hashtag-id}/top_media` or `GET /{hashtag-id}/recent_media` on
 * graph.facebook.com — public media under a hashtag. Reads a single page and
 * caps it at `maxItems` (CC-DATA-4); `truncated` reflects a cap that cut the
 * page mid-way. The continuation cursor, when present, is surfaced as `after`.
 */
export async function getHashtagMedia(
  req: IgRequestFn,
  params: HashtagMediaParams,
): Promise<PagedHashtagMedia> {
  const cap = Math.max(0, Math.floor(params.maxItems));
  const edgePath = params.edge === 'top' ? 'top_media' : 'recent_media';
  const res = await req<GraphListResponse<HashtagMediaItem>>({
    method: 'GET',
    path: `/${params.hashtagId}/${edgePath}`,
    params: { user_id: params.igId, fields: HASHTAG_MEDIA_FIELDS, limit: params.limit },
    host: 'graph.facebook.com',
  });
  const data = res.data ?? [];
  const overflowed = data.length > cap;
  const items = overflowed ? data.slice(0, cap) : data;
  const nextAfter = res.paging?.cursors?.after;

  const result: PagedHashtagMedia = { items, truncated: overflowed };
  if (nextAfter !== undefined) result.after = nextAfter;
  return result;
}

// --- discover_business -----------------------------------------------------

/** A media object under another account's public `business_discovery`. */
export interface DiscoveredMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

/**
 * Public profile + recent media of another business/creator account. Every
 * field is optional — Meta omits what it will not disclose (CC-DATA-2). An
 * unknown/private/personal handle surfaces as a propagated InstagramError.
 */
export interface BusinessDiscovery {
  id?: string;
  username?: string;
  name?: string;
  biography?: string;
  website?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  media?: DiscoveredMedia[];
}

/** Profile field set requested inside the `business_discovery` sub-selection. */
const BUSINESS_FIELDS = [
  'id',
  'username',
  'name',
  'biography',
  'website',
  'followers_count',
  'follows_count',
  'media_count',
].join(',');

/** Field set requested for each discovered media object. */
const BUSINESS_MEDIA_FIELDS = [
  'id',
  'caption',
  'media_type',
  'media_url',
  'permalink',
  'timestamp',
  'like_count',
  'comments_count',
].join(',');

export interface DiscoverBusinessParams {
  /** Operated IG account id — the node the `business_discovery` field hangs off. */
  igId: string;
  /** Target public handle (without `@`). */
  username: string;
  /** Cap on the nested media edge (already bounded by the caller to `IG_MAX_ITEMS`). */
  mediaLimit: number;
}

/** Wire shape: the `business_discovery` field nests media as an inline edge. */
interface BusinessDiscoveryWire {
  id?: string;
  business_discovery?: {
    id?: string;
    username?: string;
    name?: string;
    biography?: string;
    website?: string;
    followers_count?: number;
    follows_count?: number;
    media_count?: number;
    media?: { data?: DiscoveredMedia[] };
  };
}

/**
 * `GET /{ig-id}?fields=business_discovery.username(<handle>){…,media{…}}` on
 * graph.facebook.com — public profile + recent media of another business/creator.
 * The nested `media` edge is bounded with `.limit(<mediaLimit>)`. The inline
 * `business_discovery.media.data` edge is flattened to a plain array.
 */
export async function discoverBusiness(
  req: IgRequestFn,
  params: DiscoverBusinessParams,
): Promise<BusinessDiscovery> {
  const cap = Math.max(0, Math.floor(params.mediaLimit));
  const mediaEdge = `media.limit(${cap}){${BUSINESS_MEDIA_FIELDS}}`;
  const field = `business_discovery.username(${params.username}){${BUSINESS_FIELDS},${mediaEdge}}`;
  const wire = await req<BusinessDiscoveryWire>({
    method: 'GET',
    path: `/${params.igId}`,
    params: { fields: field },
    host: 'graph.facebook.com',
  });
  const bd = wire.business_discovery ?? {};
  const result: BusinessDiscovery = {
    id: bd.id,
    username: bd.username,
    name: bd.name,
    biography: bd.biography,
    website: bd.website,
    followers_count: bd.followers_count,
    follows_count: bd.follows_count,
    media_count: bd.media_count,
  };
  if (bd.media?.data) result.media = bd.media.data;
  return result;
}
