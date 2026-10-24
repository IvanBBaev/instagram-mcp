/**
 * Comments domain functions (Layer 1) — reads and writes of the `comments`
 * package plus the media-package comment toggle. Pure functions over the
 * injected {@link IgRequestFn} seam: they build {@link IgRequestOptions}, call
 * `req`, and return typed domain objects. No `core/http`, no `mcp`/`tools`
 * imports; policy (auth, retries, SSRF, usage headers) lives behind `req`.
 *
 * Reads: list a media's comments (cursor-paginated, replies expanded inline),
 * page through one comment's replies, fetch a single comment with parent/media
 * context, list media the account is tagged in, and look up one @mention of the
 * account (Path B only). Writes: reply, create, hide/unhide, delete, and toggle whether
 * a media accepts comments. The write GATE (apply/destructive resolution and
 * journaling) is a Layer-2 concern (`mcp/write-mode.ts`) — this layer only
 * issues the Graph call.
 *
 * Corner cases mirror the media api: CC-DATA-1 (stale cursor mid-listing keeps
 * the partial result), CC-DATA-2 (Meta omits rather than nulls — every field
 * but `id` is optional), CC-DATA-4 (`fetchAll` cap / off-by-one). A deleted
 * comment / media surfaces as a propagated InstagramError (CC-DATA-5).
 */
import { GRAPH_ID_PATTERN } from '../core/errors.js';
import { InstagramError, type IgRequestFn } from '../core/types.js';
import { fetchPagedEdge, type PagedResult, type PageParams } from './media.js';

// The cursor walk is shared with `api/media.ts` — one loop, one set of
// termination guards. Re-exported so callers of this module keep seeing the
// paging vocabulary here.
export type { PagedResult, PageParams };

// --- Field sets ------------------------------------------------------------

/** Fields requested for a reply, inline or from the `/replies` edge. */
const REPLY_FIELDS = 'id,text,username,timestamp,like_count';

/** Fields requested for a comment, with its first page of replies inline. */
const COMMENT_FIELDS = `${REPLY_FIELDS},replies{${REPLY_FIELDS}}`;

/** `get_comment` additionally pulls moderation state and parent/media context. */
const COMMENT_DETAIL_FIELDS =
  'id,text,username,timestamp,like_count,hidden,parent_id,media{id,media_type,permalink},' +
  'replies{id,text,username,timestamp,like_count}';

/** Fields requested for each media object returned by the `/tags` edge. */
const TAGGED_MEDIA_FIELDS = 'id,caption,media_type,media_url,permalink,timestamp,username';

/**
 * Fields requested for media whose caption @mentions the account. Meta serves
 * no `permalink` here, and `owner` only on the account's own media, so neither
 * is asked; `username` names the author when it is someone else.
 */
const MENTIONED_MEDIA_FIELDS =
  'id,caption,media_type,media_url,timestamp,username,like_count,comments_count';

/** Fields requested for a comment that @mentions the account; `media{id}` is its post. */
const MENTIONED_COMMENT_FIELDS = 'id,text,timestamp,like_count,media{id}';

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
   * only the first page (CC-COM-15); {@link listCommentReplies} reads the rest.
   * Absent when the edge said nothing more.
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

/**
 * A media object whose caption @mentions the account. `caption`/`username` are
 * untrusted third-party text; `media_type` is an open enum (CC-DATA-6).
 */
export interface MentionedMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  timestamp?: string;
  username?: string;
  like_count?: number;
  comments_count?: number;
}

/** A comment that @mentions the account. `text` is untrusted third-party text. */
export interface MentionedComment {
  id: string;
  text?: string;
  timestamp?: string;
  like_count?: number;
  /** The media the comment was made on. */
  media?: { id: string };
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

export interface ListCommentRepliesParams extends PageParams {
  /** The comment whose replies to list. */
  commentId: string;
}

/**
 * List one comment's replies (`GET /{comment-id}/replies`), cursor-paginated.
 *
 * The inline `replies` edge of {@link listComments} and {@link getComment}
 * stops at its first page and only says so (`repliesTruncated`, CC-COM-15);
 * this walks the same edge on its own, so a long thread can be read whole.
 * Instagram threads one level deep, so a reply carries no `replies` of its own.
 */
export async function listCommentReplies(
  req: IgRequestFn,
  params: ListCommentRepliesParams,
): Promise<PagedComments> {
  return fetchPagedEdge<RawComment, Comment>(
    req,
    (after) => ({
      method: 'GET',
      path: `/${encodeURIComponent(params.commentId)}/replies`,
      params: { fields: REPLY_FIELDS, limit: params.limit, after },
    }),
    params,
    normalizeComment,
  );
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

export interface MentionLookupParams {
  /** Operated IG account id — the node the `mentioned_*` field hangs off. */
  igId: string;
}

/**
 * Refuse an object id that would rewrite the field expression it is placed in.
 *
 * The id goes inside `mentioned_media.media_id(<id>)`, a Graph field
 * expression with no escaping mechanism, so percent-encoding is no defence
 * there: a `)`, `{` or `,` would ask Graph for something else. The tool input
 * carries the same pattern; this is defence in depth, and the message does not
 * echo the value.
 */
function assertFieldExpressionId(id: string, what: string): void {
  if (!GRAPH_ID_PATTERN.test(id)) {
    throw new InstagramError(
      `Invalid ${what}: expected 1-64 characters, letters/digits/"_"/"-" only.`,
      { kind: 'validation' },
    );
  }
}

/**
 * The object a `mentioned_*` field expansion answered with, or a refusal.
 *
 * The answer is the account node with the looked-up object nested under the
 * field. A 200 without it — or a body that is no object at all — names no
 * mention, and an empty result would read as one that discloses nothing.
 */
function mentionedObject(wire: unknown, field: string, what: string): Record<string, unknown> {
  const nested: unknown =
    typeof wire === 'object' && wire !== null
      ? (wire as Record<string, unknown>)[field]
      : undefined;
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
    throw new InstagramError(`Instagram returned no ${what} for this id. Retry later.`, {
      kind: 'upstream',
    });
  }
  return nested as Record<string, unknown>;
}

/**
 * Look up the media whose caption @mentions the account
 * (`GET /{ig-id}?fields=mentioned_media.media_id(<id>){…}`). Path B only.
 * Instagram offers no listing of mentions: the id comes from a mention webhook
 * or a link. Story mentions are not supported by Meta.
 */
export async function getMentionedMedia(
  req: IgRequestFn,
  params: MentionLookupParams & { mediaId: string },
): Promise<MentionedMedia> {
  assertFieldExpressionId(params.mediaId, 'media id');
  const wire = await req<unknown>({
    method: 'GET',
    path: `/${encodeURIComponent(params.igId)}`,
    params: { fields: `mentioned_media.media_id(${params.mediaId}){${MENTIONED_MEDIA_FIELDS}}` },
    host: 'graph.facebook.com',
  });
  return mentionedObject(wire, 'mentioned_media', 'mentioned media') as unknown as MentionedMedia;
}

/**
 * Look up a comment that @mentions the account
 * (`GET /{ig-id}?fields=mentioned_comment.comment_id(<id>){…}`). Path B only.
 * Meta answers with an error when comments are off on the media it sits on.
 */
export async function getMentionedComment(
  req: IgRequestFn,
  params: MentionLookupParams & { commentId: string },
): Promise<MentionedComment> {
  assertFieldExpressionId(params.commentId, 'comment id');
  const wire = await req<unknown>({
    method: 'GET',
    path: `/${encodeURIComponent(params.igId)}`,
    params: {
      fields: `mentioned_comment.comment_id(${params.commentId}){${MENTIONED_COMMENT_FIELDS}}`,
    },
    host: 'graph.facebook.com',
  });
  return mentionedObject(
    wire,
    'mentioned_comment',
    'mentioned comment',
  ) as unknown as MentionedComment;
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
