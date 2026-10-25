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

/**
 * Fields requested for a comment (and, recursively, for each reply). `from` is
 * requested beside `username` because Graph answers some comments with the
 * author only inside `from: { id, username }` and no top-level `username` at
 * all (CC-COM-22); the normalizers fold the two together below.
 */
const COMMENT_FIELDS =
  'id,text,username,from,timestamp,like_count,replies{id,text,username,from,timestamp,like_count}';

/** `get_comment` additionally pulls moderation state and parent/media context. */
const COMMENT_DETAIL_FIELDS =
  'id,text,username,from,timestamp,like_count,hidden,parent_id,media{id,media_type,permalink},' +
  'replies{id,text,username,from,timestamp,like_count}';

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
  /**
   * Graph's author object. Some comments arrive with the author ONLY here and
   * no top-level `username` (CC-COM-22) — typically replies, whose `username`
   * Graph has been observed to omit while `from.username` carries the handle.
   * `from` itself is omitted rather than nulled (CC-DATA-2), and its `username`
   * is untrusted third-party text exactly like the top-level field.
   */
  from?: { id?: string; username?: string };
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
  const { replies, from, ...rest } = raw;
  const comment: Comment = { ...rest };
  // An author Graph disclosed only inside `from` is still a known author
  // (CC-COM-22). `from` is consumed here and never reaches the domain object:
  // its `id` is another opaque identifier the tools never ask for, and its
  // `username` lands in the field the output schema and the [UNTRUSTED] fence
  // already cover. An explicit top-level `username` wins — `from` only fills
  // the hole, never overwrites what Graph disclosed directly.
  if (typeof from?.username === 'string' && !comment.username) comment.username = from.username;
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
  const { replies, from, ...rest } = raw;
  const detail: CommentDetail = { ...rest };
  // The same author fold as {@link normalizeComment} (CC-COM-22), so the two
  // bodies stay identical up to their declared types, as documented above.
  if (typeof from?.username === 'string' && !detail.username) detail.username = from.username;
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
 * Drop replies that Graph ALSO returned as top-level comments, and finish the
 * author information those duplicates carry.
 *
 * The `/{media-id}/comments` edge is observed (CC-COM-23) returning a reply
 * twice on one listing: once inline under its parent's `replies` array, where
 * Graph often discloses only `text` and `from` (CC-COM-22), and once as its own
 * top-level entry, where `username` is disclosed. Before this pass the model
 * read the same reply twice per thread and saw the inline copy as
 * author-unknown; moderation counts and reply decisions were inflated by the
 * duplicates.
 *
 * The inline copy is the one that keeps its place: the top-level duplicate is
 * removed, and its resolved `username` is handed DOWN to the inline reply, so
 * dedup never loses the author. Matching is by comment id only; an entry with
 * no usable id (CC-COM-16) can neither match nor be removed, and passes
 * through for the tool layer to count. Ids are Graph-global, so an id equal to
 * an inline reply's is that reply and nothing else.
 *
 * Ordering, cursors and `truncated` are untouched — this only shrinks `items`,
 * which can leave a `fetchAll` run a little under its cap: the duplicates were
 * occupying cap slots. `get_comment` needs no pass: it reads one object, there
 * is no top-level list beside it.
 */
function dropTopLevelReplyDuplicates(items: Comment[]): Comment[] {
  const byId = new Map<string, Comment>();
  for (const comment of items) {
    if (comment && typeof comment.id === 'string') byId.set(comment.id, comment);
  }
  const nestedIds = new Set<string>();

  function reconcile(comment: Comment): void {
    if (!comment || !Array.isArray(comment.replies)) return;
    for (const reply of comment.replies) {
      if (!reply || typeof reply.id !== 'string') continue;
      nestedIds.add(reply.id);
      const duplicate = byId.get(reply.id);
      if (typeof reply.username !== 'string' && typeof duplicate?.username === 'string') {
        reply.username = duplicate.username;
      }
      // A reply can itself be a parent, and Graph duplicates threads at any
      // depth, so the walk descends the whole thread it just cleaned.
      reconcile(reply);
    }
  }

  for (const comment of items) reconcile(comment);
  return items.filter((c) => !nestedIds.has(c?.id));
}

/**
 * List a media's comments, cursor-paginated, with replies expanded inline.
 * Single page by default; `fetchAll` aggregates up to `maxItems`.
 */
export async function listComments(
  req: IgRequestFn,
  params: ListCommentsParams,
): Promise<PagedComments> {
  const page = await fetchPagedEdge<RawComment, Comment>(
    req,
    (after) => ({
      method: 'GET',
      path: `/${encodeURIComponent(params.mediaId)}/comments`,
      params: { fields: COMMENT_FIELDS, limit: params.limit, after },
    }),
    params,
    normalizeComment,
  );
  page.items = dropTopLevelReplyDuplicates(page.items);
  return page;
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

/** `POST /{comment-id}/replies` with `message` in the form body — threaded reply. Returns the new id. */
export async function replyToComment(
  req: IgRequestFn,
  params: { commentId: string; message: string },
): Promise<CommentIdResult> {
  return req<CommentIdResult>({
    method: 'POST',
    path: `/${encodeURIComponent(params.commentId)}/replies`,
    body: { message: params.message },
  });
}

/** `POST /{media-id}/comments` with `message` in the form body — top-level comment. Returns the new id. */
export async function createComment(
  req: IgRequestFn,
  params: { mediaId: string; message: string },
): Promise<CommentIdResult> {
  return req<CommentIdResult>({
    method: 'POST',
    path: `/${encodeURIComponent(params.mediaId)}/comments`,
    body: { message: params.message },
  });
}

/** `POST /{comment-id}` with `hide=true|false` in the form body — reversible moderation. */
export async function setCommentHidden(
  req: IgRequestFn,
  params: { commentId: string; hide: boolean },
): Promise<CommentWriteResult> {
  return req<CommentWriteResult>({
    method: 'POST',
    path: `/${encodeURIComponent(params.commentId)}`,
    body: { hide: params.hide },
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

/** `POST /{media-id}` with `comment_enabled=true|false` in the form body — toggle whether a media accepts comments. */
export async function setCommentsEnabled(
  req: IgRequestFn,
  params: { mediaId: string; enabled: boolean },
): Promise<CommentWriteResult> {
  return req<CommentWriteResult>({
    method: 'POST',
    path: `/${encodeURIComponent(params.mediaId)}`,
    body: { comment_enabled: params.enabled },
  });
}
