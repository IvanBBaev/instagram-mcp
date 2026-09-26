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
import { InstagramError, type IgRequestFn } from '../core/types.js';
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
  /**
   * True when the inline `replies` edge announced a further page. That edge is
   * paged like any other and nothing here follows it, so `replies` then holds
   * only the first page (CC-COM-15). Absent when the edge said nothing more.
   */
  repliesTruncated?: true;
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
  replies?: { data?: RawComment[]; paging?: { next?: unknown } };
}

interface RawCommentDetail extends RawComment {
  hidden?: boolean;
  parent_id?: string;
  media?: { id: string; media_type?: string; permalink?: string };
}

/**
 * Flatten Graph's inline `replies` edge to a plain (recursive) array.
 *
 * Three Graph answers stay three domain answers: no `replies` key means "not
 * disclosed" (CC-DATA-2) and stays absent; `{ data: [] }` means "read, and there
 * are none" and becomes `[]`; `{}` is the first case in the second's clothes and
 * must not leak the envelope into a field typed as an array. The body is cast,
 * not validated, so a `data` that is not an array is treated like `{}` rather
 * than handed to `.map`.
 *
 * Equivalent-mutant note: routing the recursive call through
 * {@link normalizeCommentDetail} changes NO output — the two bodies are
 * identical up to their declared parameter/return types, and both copy whatever
 * keys the payload actually carries. See the note on that function; no
 * assertion over the returned value can separate the two.
 */
function normalizeComment(raw: RawComment): Comment {
  // The body is cast, so a `data` entry can be `null`, and destructuring it threw
  // a TypeError that failed the whole page as an `upstream` error. A non-object
  // entry is handed through untouched: it has no usable id, so the tool layer
  // leaves it out and counts it (CC-COM-16) instead of this layer hiding it.
  if (raw === null || typeof raw !== 'object') return raw;
  const { replies, ...rest } = raw;
  const comment: Comment = { ...rest };
  if (Array.isArray(replies?.data)) comment.replies = replies.data.map(normalizeComment);
  if (repliesContinue(replies)) comment.repliesTruncated = true;
  return comment;
}

/**
 * Whether Graph's inline `replies` edge says more replies exist than it sent.
 *
 * Field expansion pages a nested edge exactly as it pages a top-level one, and
 * `paging.next` is present only while a further page exists — `cursors` alone
 * are sent on the last page too, so they prove nothing. Before this, the
 * envelope was dropped whole and a thread cut at its first page read as the
 * complete conversation (CC-COM-15). The URL itself is never republished: it
 * carries the access token, and no tool can follow it.
 */
function repliesContinue(replies: RawComment['replies']): boolean {
  const next = replies?.paging?.next;
  return typeof next === 'string' && next !== '';
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
 * The same equivalence covers every other place the two normalizers can be
 * swapped: delegating this whole body to {@link normalizeComment}, mapping the
 * reply array through this function instead, calling {@link normalizeComment} at
 * the `getComment` call site below, and handing THIS function to `fetchPagedEdge`
 * as the projection `listComments` walks its pages with. All five produce
 * byte-identical output for every possible payload, and all five compile —
 * `RawCommentDetail` only adds optional fields to `RawComment`, and
 * `CommentDetail` only adds optional fields to `Comment`, so the swap type-checks
 * in both directions. They differ only in which types the seam declares.
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
  if (Array.isArray(replies?.data)) detail.replies = replies.data.map(normalizeComment);
  if (repliesContinue(replies)) detail.repliesTruncated = true;
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
      path: `/${encodeURIComponent(params.mediaId)}/comments`,
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
 *
 * A body that is not an object at all (JSON `null`, a number, a text body, a
 * list) is no comment object, and is refused as a malformed answer — the same
 * `upstream` refusal `getMedia` gives (CC-DATA-83). `null` used to be
 * destructured into a raw TypeError whose engine text reached the caller, and a
 * scalar or a list was spread into a record with no id (a list even into
 * `{ "0": … }`).
 *
 * The guard sits here, not in {@link normalizeCommentDetail}, on purpose: that
 * normalizer is documented as interchangeable with {@link normalizeComment},
 * which must hand a non-object reply entry through for the tool layer to count
 * (CC-COM-16). Refusing inside it would make the swap observable and turn one
 * odd reply into a failed read.
 */
export async function getComment(
  req: IgRequestFn,
  params: { commentId: string },
): Promise<CommentDetail> {
  const raw = await req<unknown>({
    method: 'GET',
    path: `/${encodeURIComponent(params.commentId)}`,
    params: { fields: COMMENT_DETAIL_FIELDS },
  });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InstagramError('Instagram returned no comment object for this id. Retry later.', {
      kind: 'upstream',
    });
  }
  return normalizeCommentDetail(raw as RawCommentDetail);
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
      path: `/${encodeURIComponent(params.igId)}/tags`,
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
    path: `/${encodeURIComponent(params.commentId)}/replies`,
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
    path: `/${encodeURIComponent(params.mediaId)}/comments`,
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
    path: `/${encodeURIComponent(params.commentId)}`,
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
    path: `/${encodeURIComponent(params.commentId)}`,
  });
}

/** `POST /{media-id}?comment_enabled=true|false` — toggle whether a media accepts comments. */
export async function setCommentsEnabled(
  req: IgRequestFn,
  params: { mediaId: string; enabled: boolean },
): Promise<CommentWriteResult> {
  return req<CommentWriteResult>({
    method: 'POST',
    path: `/${encodeURIComponent(params.mediaId)}`,
    params: { comment_enabled: params.enabled },
  });
}
