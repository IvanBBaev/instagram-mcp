/**
 * Comments domain functions (Layer 1) — reads and writes of the `comments`
 * package plus the media-package comment toggle. Pure functions over the
 * injected {@link IgRequestFn} seam: they build {@link IgRequestOptions}, call
 * `req`, and return typed domain objects. No `core/http`, no `mcp`/`tools`
 * imports; policy (auth, retries, SSRF, usage headers) lives behind `req`.
 *
 * Reads: list a media's comments (cursor-paginated, replies expanded inline),
 * fetch a single comment with parent/media context, and list media the account
 * is tagged in. Writes: reply, create, hide/unhide, delete, and toggle whether
 * a media accepts comments. The write GATE (apply/destructive resolution and
 * journaling) is a Layer-2 concern (`mcp/write-mode.ts`) — this layer only
 * issues the Graph call.
 *
 * Corner cases mirror the media api: CC-DATA-1 (stale cursor mid-listing keeps
 * the partial result), CC-DATA-2 (Meta omits rather than nulls — every field
 * but `id` is optional), CC-DATA-4 (`fetchAll` cap / off-by-one). A deleted
 * comment / media surfaces as a propagated InstagramError (CC-DATA-5).
 */
import type { IgRequestFn } from '../core/types.js';
import { fetchPagedEdge, type PagedResult, type PageParams } from './media.js';

// The cursor walk is shared with `api/media.ts` — one loop, one set of
// termination guards. Re-exported so callers of this module keep seeing the
// paging vocabulary here.
export type { PagedResult, PageParams };

// --- Field sets ------------------------------------------------------------

/** Fields requested for a comment (and, recursively, for each reply). */
const COMMENT_FIELDS =
  'id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}';

/** `get_comment` additionally pulls moderation state and parent/media context. */
const COMMENT_DETAIL_FIELDS =
  'id,text,username,timestamp,like_count,hidden,parent_id,media{id,media_type,permalink},' +
  'replies{id,text,username,timestamp,like_count}';

/** Fields requested for each media object returned by the `/tags` edge. */
const TAGGED_MEDIA_FIELDS = 'id,caption,media_type,media_url,permalink,timestamp,username';

// --- Domain shapes ---------------------------------------------------------

/**
 * A comment. Only `id` is guaranteed — Meta omits fields it will not disclose
 * (CC-DATA-2). `text`/`username` are untrusted third-party free text and must
 * be fenced by the tool layer before being surfaced to the model.
 */
export interface Comment {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  like_count?: number;
  /** Threaded replies, flattened from Graph's inline `replies` edge. */
  replies?: Comment[];
}

/** A single comment with moderation state and parent/media context. */
export interface CommentDetail extends Comment {
  hidden?: boolean;
  /** Present when this comment is itself a reply. */
  parent_id?: string;
  /** The media the comment belongs to. `media_type` is an open enum (CC-DATA-6). */
  media?: { id: string; media_type?: string; permalink?: string };
}

/**
 * A media object the account is tagged in (`/tags` edge). `caption`/`username`
 * are untrusted third-party text; `media_type` is an open enum (CC-DATA-6).
 */
export interface TaggedMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  timestamp?: string;
  username?: string;
}

export type PagedComments = PagedResult<Comment>;
export type PagedTaggedMedia = PagedResult<TaggedMedia>;

/** Graph write acknowledgement (`{ success: true }`) for hide/delete/toggle. */
export interface CommentWriteResult {
  success?: boolean;
}

/** Graph create/reply acknowledgement (`{ id }`). */
export interface CommentIdResult {
  id: string;
}

// --- Wire shapes -----------------------------------------------------------

interface RawComment {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  like_count?: number;
  replies?: { data?: RawComment[] };
}

interface RawCommentDetail extends RawComment {
  hidden?: boolean;
  parent_id?: string;
  media?: { id: string; media_type?: string; permalink?: string };
}

/** Flatten Graph's inline `replies` edge to a plain (recursive) array. */
function normalizeComment(raw: RawComment): Comment {
  const { replies, ...rest } = raw;
  const comment: Comment = { ...rest };
  if (replies?.data) comment.replies = replies.data.map(normalizeComment);
  return comment;
}

/**
 * The same flattening for the single-comment read, typed at the wider shape.
 *
 * Equivalent-mutant note: calling {@link normalizeComment} here instead changes
 * NO output — `{ ...rest }` copies every key the payload actually carries, so
 * `hidden`/`parent_id`/`media` ride along whatever the parameter type says; the
 * reply edge is flattened by the very same recursive call; and `CommentDetail`
 * only widens `Comment` with optional fields, so the narrower return type still
 * assigns and the swap even compiles. No assertion over the returned value can
 * separate the two — do not contort a test into "killing" it.
 *
 * The second function earns its place by keeping the types honest at the seam:
 * `replies` is `Comment[]`, because the reply field set never asks for
 * moderation state or media context, while the top-level object `get_comment`
 * returns genuinely is the wider `CommentDetail`. One shared normalizer would
 * have to either promise moderation state on replies that cannot have it, or
 * narrow the detail read back down to a plain comment.
 */
function normalizeCommentDetail(raw: RawCommentDetail): CommentDetail {
  const { replies, ...rest } = raw;
  const detail: CommentDetail = { ...rest };
  if (replies?.data) detail.replies = replies.data.map(normalizeComment);
  return detail;
}

// --- Reads -----------------------------------------------------------------

export interface ListCommentsParams extends PageParams {
  /** The media object whose comments to list. */
  mediaId: string;
}

/**
 * List a media's comments, cursor-paginated, with replies expanded inline.
 * Single page by default; `fetchAll` aggregates up to `maxItems`.
 */
export async function listComments(
  req: IgRequestFn,
  params: ListCommentsParams,
): Promise<PagedComments> {
  return fetchPagedEdge<RawComment, Comment>(
    req,
    (after) => ({
      method: 'GET',
      path: `/${params.mediaId}/comments`,
      params: { fields: COMMENT_FIELDS, limit: params.limit, after },
    }),
    params,
    normalizeComment,
  );
}

/**
 * Fetch a single comment by id, with moderation state, parent/media context,
 * and inline replies. A deleted comment is a Graph error that propagates as an
 * {@link import('../core/types.js').InstagramError} (CC-DATA-5).
 */
export async function getComment(
  req: IgRequestFn,
  params: { commentId: string },
): Promise<CommentDetail> {
  const raw = await req<RawCommentDetail>({
    method: 'GET',
    path: `/${params.commentId}`,
    params: { fields: COMMENT_DETAIL_FIELDS },
  });
  return normalizeCommentDetail(raw);
}

export interface ListTaggedMediaParams extends PageParams {
  /** The IG professional-account id whose tagged media to list (or `me`). */
  igId: string;
}

/**
 * List media the account is tagged IN (`/{ig-id}/tags`), cursor-paginated.
 * This is not @mention discovery — those are separate, Path-B-only edges.
 */
export async function listTaggedMedia(
  req: IgRequestFn,
  params: ListTaggedMediaParams,
): Promise<PagedTaggedMedia> {
  return fetchPagedEdge<TaggedMedia, TaggedMedia>(
    req,
    (after) => ({
      method: 'GET',
      path: `/${params.igId}/tags`,
      params: { fields: TAGGED_MEDIA_FIELDS, limit: params.limit, after },
    }),
    params,
    (m) => m,
  );
}

// --- Writes ----------------------------------------------------------------

/** `POST /{comment-id}/replies?message=` — threaded reply. Returns the new id. */
export async function replyToComment(
  req: IgRequestFn,
  params: { commentId: string; message: string },
): Promise<CommentIdResult> {
  return req<CommentIdResult>({
    method: 'POST',
    path: `/${params.commentId}/replies`,
    params: { message: params.message },
  });
}

/** `POST /{media-id}/comments?message=` — top-level comment. Returns the new id. */
export async function createComment(
  req: IgRequestFn,
  params: { mediaId: string; message: string },
): Promise<CommentIdResult> {
  return req<CommentIdResult>({
    method: 'POST',
    path: `/${params.mediaId}/comments`,
    params: { message: params.message },
  });
}

/** `POST /{comment-id}?hide=true|false` — reversible moderation. */
export async function setCommentHidden(
  req: IgRequestFn,
  params: { commentId: string; hide: boolean },
): Promise<CommentWriteResult> {
  return req<CommentWriteResult>({
    method: 'POST',
    path: `/${params.commentId}`,
    params: { hide: params.hide },
  });
}

/** `DELETE /{comment-id}` — irreversible removal. */
export async function deleteComment(
  req: IgRequestFn,
  params: { commentId: string },
): Promise<CommentWriteResult> {
  return req<CommentWriteResult>({
    method: 'DELETE',
    path: `/${params.commentId}`,
  });
}

/** `POST /{media-id}?comment_enabled=true|false` — toggle whether a media accepts comments. */
export async function setCommentsEnabled(
  req: IgRequestFn,
  params: { mediaId: string; enabled: boolean },
): Promise<CommentWriteResult> {
  return req<CommentWriteResult>({
    method: 'POST',
    path: `/${params.mediaId}`,
    params: { comment_enabled: params.enabled },
  });
}
