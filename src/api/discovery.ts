/**
 * Discovery domain functions (Layer 1). Read-only Graph calls that reach beyond
 * the operated account into Instagram's PUBLIC content graph: hashtag search,
 * a hashtag's top/recent media, and business/creator profile discovery.
 *
 * These are Facebook-Graph endpoints — **Path B (`fb-login`) only** — so every
 * call pins `host: 'graph.facebook.com'` and carries the operated account's IG
 * id, though not in one place: the two hashtag endpoints take it as a `user_id`
 * query parameter, while {@link discoverBusiness} addresses it as the PATH node
 * the `business_discovery` field expression hangs off and sends no `user_id` at
 * all (CC-PROC-192). They further depend on Meta's
 * "Instagram Public Content Access" feature, which may stay App-Review-gated;
 * that gate surfaces as a propagated {@link import('../core/types.js').InstagramError}
 * from the mapping layer, not client-side logic here.
 *
 * Pure functions over the injected {@link IgRequestFn} seam — no `core/http`,
 * no `mcp`/`tools` imports. Every field Meta may omit is optional (CC-DATA-2);
 * open enums (`media_type`, …) pass through as plain strings (CC-DATA-6).
 */
import { InstagramError } from '../core/types.js';
import type { GraphListResponse, IgRequestFn } from '../core/types.js';
import {
  CAP_MID_PAGE_NOTE,
  nextPageCursor,
  UNREADABLE_PAGE_NOTE,
  UNUSABLE_CURSOR_NOTE,
} from './media.js';

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
): Promise<HashtagRef[] | null> {
  const res = await req<GraphListResponse<HashtagRef>>({
    method: 'GET',
    path: '/ig_hashtag_search',
    params: { user_id: params.igId, q: params.query },
    host: 'graph.facebook.com',
  });
  // Only a MISSING `data` is "no match" (the same rule as `getHashtagMedia`
  // below and `fetchPagedEdge` in `api/media.ts`). Anything else that is not a
  // list — a `null` `data` included, or a body that is not an object at all — is
  // an answer this reader cannot read, returned as `null` so the tool layer says
  // the search was unreadable instead of reporting an empty `ids` as "no such
  // hashtag". The entries of a list are still cast, not validated.
  const body: unknown = res;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const data: unknown = res.data;
  if (data === undefined) return [];
  return Array.isArray(data) ? (data as HashtagRef[]) : null;
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
  /**
   * Continuation cursor — the `after` this function returned for the previous
   * page, forwarded to Graph as `after`. Omit for the first page. A returned
   * cursor is only useful if the caller can spend it, so it is an input here.
   */
  after?: string;
}

/**
 * Result of a hashtag-media read. `after` is the continuation cursor Graph
 * returned (when present and usable) — or, for a page that could not be read,
 * the cursor that requested it. `truncated` is true when the returned page held
 * more than `maxItems`, when Graph handed back a cursor that cannot be sent
 * back, or when the page itself was unreadable, so a read that could not prove
 * it was complete is never presented as complete. `note` says which it was, in
 * the same words `api/media.ts` uses for the same facts about its own walk.
 */
export interface PagedHashtagMedia {
  items: HashtagMediaItem[];
  after?: string;
  truncated: boolean;
  note?: string;
}

/**
 * `GET /{hashtag-id}/top_media` or `GET /{hashtag-id}/recent_media` on
 * graph.facebook.com — public media under a hashtag. Reads a single page and
 * caps it at `maxItems` (CC-DATA-4); `truncated` reflects a cap that cut the
 * page mid-way. The continuation cursor is surfaced as `after` and can be passed
 * back in as `params.after` to read the following page — but ONLY when the page
 * was not truncated, because a cursor cannot address a position inside a page.
 */
export async function getHashtagMedia(
  req: IgRequestFn,
  params: HashtagMediaParams,
): Promise<PagedHashtagMedia> {
  // Equivalent-mutant note: dropping the `Math.floor` here changes no observable
  // behaviour. `cap` reaches exactly two consumers and both are blind to a
  // fraction. For a fractional cap `f` with `Math.floor(f) === n`, an integer
  // page length L satisfies `L > n` exactly when `L > f`, because no integer lies
  // strictly between n and f — so `data.length > cap` is unchanged; and
  // `Array.prototype.slice` applies ToIntegerOrInfinity, which truncates f to n
  // anyway. Negative inputs are flattened by the `Math.max`; a NaN is NOT —
  // `Math.max(0, NaN)` is `NaN`, corrected 2026-09-23 — but it is inert in both
  // consumers rather than flattened: `L > NaN` is false, so the page comes back
  // uncapped with `truncated: false`, and `slice(0, NaN)` yields the empty array.
  // Both variants of the floor agree on it, which is all this note needs, and no
  // NaN reaches here in production anyway: `IG_MAX_ITEMS` is parsed through
  // `parseIntEnv(…, { min: 1, max: 100_000 })` in `core/settings.ts`. The
  // floor stays because it makes the intent explicit and because the identical
  // expression in `discoverBusiness` IS observable — there the value is
  // interpolated into `media.limit(<cap>)` and Graph reads the text literally.
  const cap = Math.max(0, Math.floor(params.maxItems));
  const edgePath = params.edge === 'top' ? 'top_media' : 'recent_media';
  const res = await req<GraphListResponse<HashtagMediaItem>>({
    method: 'GET',
    path: `/${encodeURIComponent(params.hashtagId)}/${edgePath}`,
    params: {
      user_id: params.igId,
      fields: HASHTAG_MEDIA_FIELDS,
      limit: params.limit,
      after: params.after,
    },
    host: 'graph.facebook.com',
  });
  // Only a MISSING `data` is an empty edge. A `data` that is present but not a
  // list — `null` included — or a body that is not an object at all is a page
  // this reader cannot read. It used to flow on untouched (and a non-object body
  // threw a raw TypeError on `.data`); a string longer than the cap was then
  // `.slice`d into a substring and reported as a page the cap cut mid-way.
  // Nothing of it is handed on — no record is ever assembled here — and the page
  // is published as incomplete. The cursor it advertises is never handed back:
  // resuming past it would skip whatever it held without a trace. The cursor
  // that REQUESTED it is, so the caller can retry exactly this page (the same
  // rule `fetchPagedEdge` applies in `api/media.ts`).
  const body: unknown = res;
  const raw: unknown =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as { data?: unknown }).data
      : null;
  if (raw !== undefined && !Array.isArray(raw)) {
    const unreadable: PagedHashtagMedia = {
      items: [],
      truncated: true,
      note: UNREADABLE_PAGE_NOTE,
    };
    if (params.after !== undefined) unreadable.after = params.after;
    return unreadable;
  }
  const data = (raw as HashtagMediaItem[] | undefined) ?? [];
  const overflowed = data.length > cap;
  const items = overflowed ? data.slice(0, cap) : data;
  // Read by the same rule as `fetchPagedEdge` (CC-DATA-115): `undefined` only
  // when Graph omitted `paging.next`, so the last page's `cursors.after` is not
  // handed back as a resume position, and a `next`-only page (hashtag edges may
  // page by URL alone) still yields the `after` its URL carries. Typed `unknown`
  // because `req` casts the body. `body` is a plain object here: every other
  // shape was refused as unreadable above.
  const nextAfter = nextPageCursor(body as object);

  const result: PagedHashtagMedia = { items, truncated: overflowed };
  // A Graph cursor addresses a PAGE boundary, not an offset inside a page. When
  // the item cap cut this page mid-way, `nextAfter` points past every item Graph
  // sent — including the ones just dropped — so handing it back would silently
  // skip them. Withhold it: `truncated` without `after` is the honest signal
  // that the remainder is only reachable by re-reading with a smaller `limit`,
  // and the note says so in words, with the text `list_media` publishes for
  // the same stop. Without it the model held `truncated: true` and no cursor and
  // no instruction, and the natural reading of that pair is "ask again", which
  // returns the same capped page.
  if (overflowed) {
    result.note = CAP_MID_PAGE_NOTE;
    return result;
  }
  if (nextAfter === undefined) return result; // no `paging.next`: the edge is finished
  // A cursor that IS there and cannot be sent back is no proof of the end: the
  // tool layer used to drop it and publish `truncated: false`, which reads as a
  // complete result. No `next` means finished; `next` with an unusable cursor
  // means unknown.
  if (typeof nextAfter !== 'string' || nextAfter === '') {
    result.truncated = true;
    result.note = UNUSABLE_CURSOR_NOTE;
    return result;
  }
  result.after = nextAfter;
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
  /**
   * Set exactly when `media` is: whether the media list can be proven complete,
   * and the cursor to continue it from (CC-DATA-116). See {@link readMediaEdge}.
   */
  mediaPaging?: BusinessMediaPaging;
  /**
   * `true` only when Graph sent a media edge nothing can read (see
   * {@link discoverBusiness}); `media` is then absent. Never set to `false`.
   */
  mediaUnreadable?: true;
  /** Set only when Graph answered without a profile ({@link NO_PROFILE_NOTE}). */
  note?: string;
}

/**
 * Paging of the nested `business_discovery` media edge (CC-DATA-116). Same
 * vocabulary as {@link PagedHashtagMedia}: `truncated` is true whenever the read
 * cannot prove the list complete; `after` is a cursor {@link discoverBusiness}
 * accepts back as `mediaAfter`; `note` says why the list may be incomplete.
 */
export interface BusinessMediaPaging {
  after?: string;
  truncated: boolean;
  note?: string;
}

/**
 * Note for a media page that came back with a resumable cursor. Meta's
 * business_discovery reference says a field-expanded media edge carries
 * `before`/`after` cursors when there are several pages, and NO `previous`/`next`
 * links — so nothing on the page says whether it is the last one.
 */
export const MEDIA_MORE_NOTE =
  'Instagram returned a media cursor, so more media may exist beyond this page ' +
  '(business_discovery sends no next link that would say it is the last one) — pass ' +
  'mediaPaging.after as mediaAfter to read further; an empty media list there means the end';

/**
 * The charset a `business_discovery` media cursor must have to be sent back.
 * Like the handle, the cursor is interpolated into the field expression
 * (`media.after(<cursor>)`), which has no escaping, so `(`, `)`, `{`, `}`, `,`,
 * `.` and whitespace are refused rather than quoted. Graph cursors are base64
 * (url-safe or standard, `=` padded), which this admits whole. A cursor Graph
 * sends outside it is reported as unusable, never interpolated.
 */
export const BUSINESS_MEDIA_CURSOR_PATTERN = /^[A-Za-z0-9_+/=-]{1,2048}$/;

/**
 * Note for a `business_discovery` answer that carried no profile object: an
 * empty result is then not an account that discloses nothing. The handle is not
 * echoed (see `assertValidUsername`). Exported so the tests pin the same text.
 */
export const NO_PROFILE_NOTE =
  'Instagram answered without a business_discovery profile for this handle, so nothing ' +
  'about the account could be read — this is not an account that discloses nothing; retry later';

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

/**
 * The Instagram handle charset — letters, digits, `.` and `_`, 1–30 chars. This
 * is a HARD constraint, not cosmetic input polish: `username` is interpolated
 * into the `business_discovery.username(<handle>)` field expression below, so a
 * handle carrying `)`, `{`, `}`, `,` or `.limit(` would rewrite the query the
 * server asks Graph for (extra fields off the operator's own account, an
 * inflated `media.limit()` burning quota). Graph field expressions have no
 * escaping mechanism, so the only safe move is to reject rather than quote.
 *
 * The tool layer validates with this same pattern; re-checking here is defence
 * in depth — the api layer must not trust its caller (docs/security.md §3,
 * which is where the field-expression rule lives; §7 is content policy).
 */
export const INSTAGRAM_USERNAME_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

/**
 * Reject a handle that is not a plain Instagram handle. The message never echoes
 * the offending payload — that string is untrusted third-party/model input and
 * error text ends up in logs and model context.
 */
function assertValidUsername(username: string): void {
  if (!INSTAGRAM_USERNAME_PATTERN.test(username)) {
    throw new InstagramError(
      'Invalid Instagram username: expected 1-30 characters, letters/digits/"."/"_" only ' +
        '(no leading "@", no spaces, no brackets or parentheses).',
      { kind: 'validation' },
    );
  }
}

export interface DiscoverBusinessParams {
  /** Operated IG account id — the node the `business_discovery` field hangs off. */
  igId: string;
  /** Target public handle (without `@`), matching {@link INSTAGRAM_USERNAME_PATTERN}. */
  username: string;
  /** Cap on the nested media edge (already bounded by the caller to `IG_MAX_ITEMS`). */
  mediaLimit: number;
  /**
   * Resume cursor for the media edge — a `mediaPaging.after` this function
   * returned — sent as `media.after(<cursor>)`. Must match
   * {@link BUSINESS_MEDIA_CURSOR_PATTERN}.
   */
  mediaAfter?: string;
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
    media?: unknown;
  };
}

/**
 * The wire's `business_discovery.media` edge -> `result.media`, or the
 * `mediaUnreadable` flag (CC-DATA-82, CC-DATA-87).
 *
 * Three verdicts, and the edge is judged here rather than by truthiness:
 *  - a list under `data` is the edge, published as sent (an empty one included —
 *    CC-PROC-46);
 *  - an ABSENT edge, an edge with no `data`, and the explicit `null` spelling of
 *    either are Meta declining to disclose it: no `media` key, and no note;
 *  - anything else is an edge Instagram sent in a shape nothing can read, and is
 *    flagged so the tool can say so.
 *
 * `bd.media?.data` used to be tested for truthiness, which sent every falsy
 * non-list down the "undisclosed" branch: a `data` of `''`, `0` or `false`, and an
 * edge that was itself `0`, `''`, `false`, a string or a bare list (`.data` on a
 * primitive or an array is `undefined`). Each was published as the silent
 * profile an account that hides its posts gets, where the truthy non-lists
 * (`data: 'p1,p2'`) were already noted. A bare list is not trusted as the edge
 * either: the wire promised `{data: [...]}`, and a list arriving in its place is
 * a shape change, not a lucky match.
 */
function readMediaEdge(edge: unknown, result: BusinessDiscovery): void {
  if (edge === undefined || edge === null) return;
  if (typeof edge !== 'object' || Array.isArray(edge)) {
    result.mediaUnreadable = true;
    return;
  }
  const data = (edge as { data?: unknown }).data;
  if (data === undefined || data === null) return;
  if (!Array.isArray(data)) {
    result.mediaUnreadable = true;
    return;
  }
  result.media = data as DiscoveredMedia[];
  result.mediaPaging = readMediaPaging(edge);
}

/**
 * The paging verdict of a media edge that was read (CC-DATA-116).
 *
 * The edge's `paging` used to be dropped whole, so a profile with more posts
 * than one page read as complete and nothing could fetch the rest. Meta's
 * business_discovery reference: the field-expanded `/media` edge carries
 * `before`/`after` cursors when there are several pages, and no `next` or
 * `previous` — so {@link nextPageCursor}'s end rule (no `next` = finished,
 * CC-DATA-115) would call every page the last one here. A `cursors.after` is
 * therefore read first and taken as "more may exist"; only when it is absent
 * does `nextPageCursor` decide, which covers a `next`-only page (the URL's
 * `after`) and the documented single-page answer (no cursor, no next: complete).
 * A cursor that cannot be interpolated back into the field expression is the
 * CC-DATA-11 "present but unusable" stop, not the end.
 */
function readMediaPaging(edge: object): BusinessMediaPaging {
  const cursor = (edge as { paging?: { cursors?: { after?: unknown } } }).paging?.cursors?.after;
  const after = cursor !== undefined ? cursor : nextPageCursor(edge);
  if (after === undefined) return { truncated: false };
  if (typeof after !== 'string' || !BUSINESS_MEDIA_CURSOR_PATTERN.test(after)) {
    return { truncated: true, note: UNUSABLE_CURSOR_NOTE };
  }
  return { after, truncated: true, note: MEDIA_MORE_NOTE };
}

/**
 * `GET /{ig-id}?fields=business_discovery.username(<handle>){…,media{…}}` on
 * graph.facebook.com — public profile + recent media of another business/creator.
 * The nested `media` edge is bounded with `.limit(<mediaLimit>)`, and resumed
 * with `.after(<mediaAfter>)` when a cursor is given. The inline
 * `business_discovery.media.data` edge is flattened to a plain array, and its
 * paging is published as `mediaPaging` (CC-DATA-116).
 *
 * `params.username` is interpolated into the field expression, so it is
 * re-validated here against {@link INSTAGRAM_USERNAME_PATTERN} before the string
 * is built.
 *
 * @throws InstagramError `kind: 'validation'` for a handle outside that charset,
 * or a `mediaAfter` outside {@link BUSINESS_MEDIA_CURSOR_PATTERN}.
 */
export async function discoverBusiness(
  req: IgRequestFn,
  params: DiscoverBusinessParams,
): Promise<BusinessDiscovery> {
  assertValidUsername(params.username);
  // The cursor is interpolated like the handle, so it is re-checked here too
  // (defence in depth; the tool input carries the same pattern). The message
  // does not echo it.
  let resume = '';
  if (params.mediaAfter !== undefined) {
    if (!BUSINESS_MEDIA_CURSOR_PATTERN.test(params.mediaAfter)) {
      throw new InstagramError(
        'Invalid mediaAfter cursor: pass back the mediaPaging.after a previous call returned.',
        { kind: 'validation' },
      );
    }
    resume = `.after(${params.mediaAfter})`;
  }
  const cap = Math.max(0, Math.floor(params.mediaLimit));
  const mediaEdge = `media${resume}.limit(${cap}){${BUSINESS_MEDIA_FIELDS}}`;
  const field = `business_discovery.username(${params.username}){${BUSINESS_FIELDS},${mediaEdge}}`;
  const wire = await req<BusinessDiscoveryWire | null>({
    method: 'GET',
    path: `/${encodeURIComponent(params.igId)}`,
    params: { fields: field },
    host: 'graph.facebook.com',
  });
  // A 200 with no `business_discovery` object is not a profile with nothing
  // disclosed: it is no profile at all. Mapping it to `{}` published an empty
  // object that the all-optional output schema accepts and a caller reads as
  // "this account exists and discloses nothing". Meta answers an unknown,
  // private or personal handle with an error, so this is a malformed answer. It
  // is said, not thrown: unlike `get_account`'s required `id` (CC-DATA-65) the
  // output schema here can be met honestly, and the caller gets the reason in
  // `note` beside nothing invented. `null`, an array and a scalar are the same
  // absence spelled by a cast body — and so is a whole body of JSON `null`,
  // which `core/http` returns as `null`: reading the field off it threw a raw
  // TypeError instead of saying so (CC-DATA-106). A scalar or array body
  // already yields an `undefined` field and lands on the same note.
  const bd = wire?.business_discovery;
  if (typeof bd !== 'object' || bd === null || Array.isArray(bd)) {
    return { note: NO_PROFILE_NOTE };
  }
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
  readMediaEdge(bd.media, result);
  return result;
}
