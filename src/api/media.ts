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
 * strings), CC-DATA-11 (a `null` or empty cursor is unusable, not an exhausted
 * edge), CC-DATA-115 (the end of an edge is a missing `paging.next`, not a
 * missing cursor). CC-DATA-5 (deleted object) surfaces as a propagated
 * InstagramError.
 * A page answered with no readable listing (a `data` that is not a list, or a
 * body that is no envelope) ends the walk as a truncated, noted read rather than
 * a crash or an empty success ({@link UNREADABLE_PAGE_NOTE}).
 */
import {
  InstagramError,
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

/**
 * Flatten Graph's inline `children` edge to a plain array.
 *
 * Unverified upstream assumption, recorded rather than guessed: whether the
 * inline `children{…}` expansion carries a `paging` envelope of its own is NOT
 * answerable from this repository — `test/fixtures/` holds two hand-written
 * listing examples and no captured `media-detail.json`, so nothing here has ever
 * seen the real shape. (`scripts/capture-fixtures.mjs` would settle it: its
 * `media-detail` capture requests exactly {@link MEDIA_DETAIL_FIELDS}, and
 * `test/helpers/sanitize.ts` recurses into both `children` and `paging`, so a
 * captured fixture would show the envelope if Graph sends one.)
 *
 * Both halves of that sentence are a claim about a directory, so
 * `test/release/fixtures.test.ts` reads them back out of this comment and checks
 * them against it. The count had already gone stale once, and the day the
 * `media-detail` capture CC-DATA-9 waits for lands, that gate fails so this
 * paragraph is re-read against the evidence rather than outliving it.
 *
 * Dropping it is nevertheless safe, and the bound is a product rule rather than
 * a page size: a carousel holds **at most 10 children** (CC-PUB-6, verified
 * against Meta's own docs), so the edge cannot outrun any page Graph would
 * return and there is no second page for a cursor to point at. `children` is
 * therefore published as a bare array — the shape `tools/media.ts` declares in
 * its output schema — and not as a `{ items, paging }` listing.
 *
 * `req` casts the body, so the edge is checked for what it actually is
 * (CC-DATA-66): `children` is kept only when `children.data` IS an array. A
 * `children` that is not an object, or a `data` that is not a list (a string,
 * an object, a number), carries no readable child and is reported ABSENT — the
 * same as an edge Graph did not send — so the caller's `/children` fallback
 * still gets its chance on an album. It used to be kept whenever `data` was
 * truthy, which typed a string as `MediaChild[]` and, because a non-empty
 * string has a non-zero `length`, skipped that fallback. An EMPTY array is kept
 * as `[]` (CC-PROC-46): it is an edge that was read; what to publish for it is
 * the tool's call.
 *
 * A body that is not an object at all (JSON `null`, a number, a text body) is
 * no media object, and is refused as a malformed answer rather than destructured
 * into a raw TypeError.
 */
function normalizeDetail(raw: unknown): MediaDetail {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InstagramError('Instagram returned no media object for this id. Retry later.', {
      kind: 'upstream',
    });
  }
  const { children, ...rest } = raw as RawMediaDetail & { children?: unknown };
  const detail: MediaDetail = { ...rest };
  const data: unknown =
    typeof children === 'object' && children !== null
      ? (children as { data?: unknown }).data
      : undefined;
  if (Array.isArray(data)) detail.children = data as MediaChild[];
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

/**
 * Is `after` a cursor that can actually be sent back? Nothing validates the Graph
 * body — `req` CASTS it — so a field declared `string | undefined` holds anything
 * at all in fact, and two off-contract shapes arrive: JSON `null` and the empty
 * string. Neither names a position in the edge, and they differ only in an
 * accident of serialisation — `core/host.ts` drops a null query param, while
 * `&after=` does reach the wire — never in meaning. Both are therefore unusable,
 * and this ONE predicate decides it for the whole file, so the walk refuses to
 * continue on exactly the cursors the result refuses to publish (CC-DATA-11).
 * The publish site at the end of {@link fetchPagedEdge} records what each shape
 * breaks downstream.
 *
 * `undefined` is not usable either, but it is not off-contract: it is
 * {@link nextPageCursor} reporting that Graph omitted `paging.next`, i.e. the
 * edge is finished (CC-DATA-115). Callers must test for it FIRST — this predicate cannot
 * tell "finished" from "broken", and must not be asked to.
 *
 * Takes `unknown` on purpose. Narrowing the parameter to the declared type would
 * make the `typeof` check look redundant to the next reader, and it is the only
 * thing standing between a cursor of some third shape entirely and the query
 * string.
 */
function isUsableCursor(after: unknown): after is string {
  return typeof after === 'string' && after !== '';
}

/**
 * The resume cursor a Graph page offers, with the END of the edge read from
 * `paging.next` (CC-DATA-115). Returns `undefined` when the edge is finished,
 * and otherwise the cursor to continue from — which may be unusable, so callers
 * still run it through {@link isUsableCursor} (CC-DATA-11).
 *
 * Graph's cursor pagination marks the last page by OMITTING `paging.next`;
 * `paging.cursors` is still sent on it (Meta's "Paginated Results" reference —
 * "If `next` is not included, you have reached the end of the list" — and the
 * same rule this repo already applies to inline `replies`, CC-COM-15; the
 * hand-written `test/fixtures/example-list-comments.json` is that shape). Keying
 * the end on `cursors.after` published a resumable cursor on the last page,
 * reported a cap that landed on the final boundary as `truncated`, and spent
 * one extra request per `fetchAll`.
 *
 * `cursors.after` stays the resume token. When `next` is there and `cursors` is
 * not — an edge paging by URL alone — the `after` query parameter of the `next`
 * URL is the same cursor, so it is read from there (only that one parameter:
 * the URL also carries the access token, and is never republished). A `next`
 * with neither yields `null`: more remains and nothing addresses it, which every
 * caller reports as the CC-DATA-11 "present but unusable" stop, never as the end.
 *
 * `page` is a plain object at every call site; the optional chains carry a
 * `paging`/`cursors` of any other shape (including JSON `null`) to `undefined`.
 */
export function nextPageCursor(page: object): unknown {
  const paging = (page as { paging?: { next?: unknown; cursors?: { after?: unknown } } }).paging;
  if (paging?.next === undefined) return undefined;
  const after = paging.cursors?.after;
  if (after !== undefined) return after;
  return afterFromNextUrl(paging.next);
}

/**
 * The `after` query parameter of a `paging.next` URL, or `null` when it has none,
 * has it more than once, or `next` is not a URL at all.
 *
 * What the value can and cannot do (CC-DATA-117). The URL is never requested:
 * only its `after` is read, and that is sent as an ordinary query parameter to
 * the pinned Graph host through `core/host`, which encodes it — so a `next` on
 * another host, or a value carrying `&`, `#` or `%`-escapes, changes nothing
 * about where the request goes or what else it asks. `searchParams` decodes the
 * value once and `core/host` re-encodes it once, the same round trip Graph's own
 * link makes. A DUPLICATED `after` is refused: which copy a server honours is
 * its own choice (first-wins and last-wins both exist), so picking one could
 * resume from a position the link never meant; `null` is the CC-DATA-11
 * "present but unusable" stop, never the end of the listing.
 *
 * Equivalent-mutant note: the `catch` returning `''` instead of `null`, or an
 * `|| null` folding the `''` of a bare `?after=` into `null`, changes nothing
 * observable — both values fail {@link isUsableCursor}, and every caller gives
 * both the one verdict, "present but unusable". Measured 2026-09-26. `null` is
 * written because it says "no cursor" rather than imitating an empty one.
 */
function afterFromNextUrl(next: unknown): string | null {
  try {
    const values = new URL(String(next)).searchParams.getAll('after');
    return values.length === 1 ? (values[0] as string) : null;
  } catch {
    return null;
  }
}

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
 * single page left more, or when the walk stopped early with more to come) —
 * but only ever when Graph handed back a cursor that can actually be sent back,
 * so `truncated: true` with no `after` is a real and meaningful combination: the
 * read is incomplete and there is nothing to resume from (CC-DATA-11).
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
 * The note for a cap that stopped part-way through a page (CC-DATA-47). Shared
 * by the single-page and `fetchAll` stops because it is one fact about Graph's
 * cursors rather than about either walk: a cursor addresses a page boundary, so
 * items discarded INSIDE a page have no cursor at all — the one Graph sent with
 * the page resumes past them, and a page that ended the edge offers none.
 * Both shapes reach this note, which is why it speaks of the items and not of
 * the cursor. `api/discovery.ts` reaches the same verdict on its own walk and
 * publishes this same text for it, which is why it is exported.
 */
export const CAP_MID_PAGE_NOTE =
  'stopped at the item cap part-way through a page — no cursor addresses the items ' +
  'dropped here, so there is nothing to resume from; re-read with a smaller limit';

/**
 * Note for a page whose cursor is present but cannot be sent back (CC-DATA-11):
 * no proof the edge ended, so the listing may be incomplete. Exported for the
 * same reason as {@link CAP_MID_PAGE_NOTE}: `api/discovery.ts` publishes it too.
 */
export const UNUSABLE_CURSOR_NOTE =
  'the edge returned an unusable cursor (no way to continue) — the listing may be incomplete';

/**
 * Note for a page Graph answered with 200 and no readable listing: a `data` that
 * is not a list, or a body that is not an envelope at all (see
 * {@link readPageData}). Nothing on that page could be read, so the listing is
 * short by an unknown number of items and is published as truncated. Exported
 * for the same reason as the two notes above: it is one fact about an edge,
 * whichever walk met it.
 */
export const UNREADABLE_PAGE_NOTE =
  'Instagram returned an unreadable page (its listing was not a list) — nothing on it could be ' +
  'read, so the listing is incomplete; retry the read (from `after` when one is given)';

/**
 * The listing on one page, or `undefined` when the page has none that can be
 * read.
 *
 * `req` CASTS the body, so `GraphListResponse.data` being declared `T[]` says
 * what Graph documents, not what arrives. Only an array is a listing:
 *
 *   - an ABSENT `data` key is a read that succeeded with nothing in it — Graph
 *     omits the key on some empty edges rather than sending `[]` — and stays the
 *     empty listing it always was;
 *   - `data: null`, an object, a number, a boolean or a string is not a listing.
 *     Meta omits rather than nulls (CC-DATA-2), so `null` is as off-contract as
 *     the rest. A string was the quiet case: it is iterable, so `'abc'` used to
 *     become three one-character "items"; every other shape threw a raw
 *     `TypeError: data is not iterable` out of the walk;
 *   - a body that is not a plain object (JSON `null`, a scalar, an array) is no
 *     envelope at all. `null` threw on `page.data`; a scalar or an array read as
 *     an empty, FINISHED edge — the answer an account with no media gets.
 *
 * Returning `undefined` rather than `[]` for those is the whole point: the
 * caller must be able to tell "read, and empty" from "not read".
 */
function readPageData<TRaw>(page: unknown): TRaw[] | undefined {
  if (typeof page !== 'object' || page === null || Array.isArray(page)) return undefined;
  const data: unknown = (page as { data?: unknown }).data;
  if (data === undefined) return [];
  return Array.isArray(data) ? (data as TRaw[]) : undefined;
}

/**
 * Walk a Graph edge by cursor. Single page by default; with `fetchAll` follows
 * `paging.cursors.after` until the edge is exhausted — a page without
 * `paging.next`, see {@link nextPageCursor} (CC-DATA-115) — or `maxItems` is
 * reached (CC-DATA-4). A cursor invalidated between pages (a `validation` error) keeps
 * the partial result with `truncated: true` and a `note` (CC-DATA-1); any other
 * failure — on the first page or a later one — propagates (CC-DATA-105).
 *
 * The walk is **bounded four ways**, because Graph can hand back a page that
 * makes no progress (privacy-filtered or deleted items yield `data: []` while
 * still advertising an `after` cursor) and an unbounded `for(;;)` would then
 * hammer Meta until the whole app is throttled:
 *
 *   1. the cursor must be usable — a `null` or empty `after` is not a position
 *      in the edge, so it ends the walk instead of re-fetching a page that is
 *      already in hand (CC-DATA-11);
 *   2. the cursor must never repeat one this walk already followed — a repeated
 *      `after` is a request already answered, whether the edge hands it back on
 *      the very next page or cycles back to it later (`A → B → A`);
 *   3. a page that contributed no items ends the walk;
 *   4. at most {@link MAX_PAGES} pages per call.
 *
 * A page with no readable listing ends the walk too, before any of these are
 * consulted (see {@link readPageData}): it contributed nothing, and the cursor
 * it carries points past items this walk never saw.
 *
 * Every such stop returns `truncated: true` and a `note`, so nothing is silently
 * dropped. Guards 2-4 additionally hand back the `after` cursor, so the caller
 * can resume exactly where the walk gave up. Guard 1 cannot, and does not
 * pretend to: the only cursor it has is the unusable one that stopped it.
 *
 * The item cap (CC-DATA-4) is the one early stop whose cursor depends on WHERE
 * it landed. A Graph cursor addresses a page boundary, never an offset inside a
 * page, so the cap only has a cursor worth publishing when it stopped on a page
 * boundary: then it carries `after` and no note, because the cursor says
 * everything there is to say. A cap that stopped part-way through a page has no
 * such cursor at all — the one Graph sent with that page resumes past the items
 * just dropped, and a page that ended the edge offers none — so that stop
 * withholds `after` and carries a note instead (CC-DATA-47). A cap that stopped
 * on an unusable cursor withholds it for the third reason, and carries its own
 * note: a short listing with neither a cursor nor an explanation is the silent
 * drop this contract promises will not happen.
 */
export async function fetchPagedEdge<TRaw, T>(
  req: IgRequestFn,
  build: (after: string | undefined) => IgRequestOptions,
  params: PageParams,
  normalize: (raw: TRaw) => T,
): Promise<PagedResult<T>> {
  // `Math.floor` is load-bearing: a fractional cap lets one extra item through
  // AND hides the overflow. The `Math.max(0, …)` clamp is defensive only — every
  // cap <= 0 behaves identically against a length — and mirrors the same
  // expression in `api/discovery.ts`, where a negative cap WOULD reach Graph.
  //
  // Equivalent-mutant note: dropping the `Math.max(0, …)` is not observable from
  // here, for exactly that reason — `items.length` starts at 0 and only grows, so
  // every `length >= cap` below answers identically for a cap of 0 and for any
  // negative cap (and a NaN cap survives the clamp unchanged). It is kept because
  // it is what makes the two `items.length >= cap` comparisons safe, and because
  // the next caller to forward this cap to Graph as `limit` gets a valid value
  // for free. Until 2026-09-23 this said "three `>=` comparisons", contradicting
  // its own sentences either side of it: the third `>=` in this function is
  // `pageIndex >= MAX_PAGES`, which reads a page counter the clamp never touches.
  //
  // That equivalence is NOT self-contained: its premise is that the two
  // `items.length >= cap` guards below still spell the comparison `>=`. This
  // note and the two `===` notes below are each true alone and false as a SET.
  // Measured 2026-09-23 with all three applied at once: `length === -1` is never
  // true, so a negative cap stops matching anything — the item loop never breaks
  // on the cap, the page loop never concludes "we have all we are allowed to
  // keep", and the cap is gone. Probed against that build, `maxItems: -1` turns
  // ONE request returning zero items into FIFTY requests returning fifty,
  // stopping only at `MAX_PAGES`; every other `maxItems` answers identically.
  // The set survives the whole suite with an empty killer diff — measured
  // 2026-09-23, when the suite was 52 test files; the count is what was run, not
  // a standing fact about the suite — which is why it is written here rather
  // than pinned: no production path reaches it —
  // `core/settings.ts` clamps `IG_MAX_ITEMS` to `{ min: 1, max: 100_000 }` — but
  // every direct caller of the exported `fetchPagedEdge`/`listMedia` can.
  const cap = Math.max(0, Math.floor(params.maxItems));
  const items: T[] = [];
  let cursor = params.after;
  // Every cursor this walk has already sent (the caller's starting `after`
  // included). Comparing only against the previous cursor caught `A → A` and
  // missed a cycle `A → B → A`: the walk re-read pages already in `items`, so
  // the listing came back with the same items over and over until the cap or
  // MAX_PAGES, and — when the cap ended it — with no note at all.
  const followed = new Set<string>();
  if (cursor !== undefined) followed.add(cursor);
  // Widened past its declared type on purpose: the only writes below copy the
  // cursor Graph sent, and Graph can send `null` — or any other shape, since
  // `req` casts the body (see `nextAfter`). Typing this `string | undefined`
  // would not make the value one — it would only hide the off-contract value
  // from the reader, and from the publish-time check at the end that is there
  // precisely to catch it.
  let resultAfter: unknown;
  let truncated = false;
  let note: string | undefined;
  let pageIndex = 0;

  for (;;) {
    // Typed `unknown` on purpose: `req` casts the body, and everything below
    // reads it only after {@link readPageData} has checked what it really is.
    let page: unknown;
    try {
      page = await req<unknown>(build(cursor));
    } catch (err) {
      // CC-DATA-1: a cursor that went stale mid-listing keeps what we gathered.
      // Graph reports a stale cursor as an invalid parameter (code 100), which
      // `core/errors` maps to `validation` — and ONLY that kind is a stale
      // cursor. An expired token, a revoked permission, a rate limit or a Meta
      // outage on page 2+ used to be swallowed here too and published as a
      // short page advising "restart the listing", which is wrong for every one
      // of them (a rate-limited caller that restarts spends the quota again).
      // They propagate with their own kind instead (CC-DATA-105).
      if (pageIndex > 0 && isInstagramError(err) && err.kind === 'validation') {
        note = 'cursor may be stale (data changed between pages) — restart the listing';
        truncated = true;
        break;
      }
      throw err;
    }
    pageIndex += 1;

    // An unreadable page stops the walk here, before the cap or the cursor is
    // consulted, and keeps whatever earlier pages gathered.
    //
    // It is published as `truncated`: nothing on it was read, so there is no
    // proof the listing is complete — and an empty, untruncated answer is exactly
    // what an account with no media gets, so the model would report "nothing
    // here" for a read that never happened. The cursor the page ADVERTISES is
    // neither followed nor published: it addresses the boundary after the items
    // this walk could not read, and resuming from it would turn a visible short
    // read into an invisible hole (the CC-DATA-47 argument, one page wider). The
    // cursor that REQUESTED the page is the exact position to retry from, so that
    // is the one published — `cursor` is the caller's own `after` or one this
    // walk already proved usable, and the publish guard at the end still checks.
    // On the first page of a fresh listing there is none, and the note's "retry
    // the read" is then the whole instruction.
    const data = readPageData<TRaw>(page);
    if (data === undefined) {
      truncated = true;
      note = UNREADABLE_PAGE_NOTE;
      resultAfter = cursor;
      break;
    }
    let overflowed = false;
    let added = 0;
    for (const item of data) {
      // Equivalent-mutant note: `===` would behave identically here. `items`
      // starts empty, grows by exactly one per iteration, and is re-checked
      // before every push, so it lands ON the cap and can never step past it.
      // `>=` is the property this guard actually relies on rather than a
      // restatement of that invariant, and it is the form that still holds if a
      // negative cap ever reaches this line.
      //
      // …and that last clause is also this note's premise: the equivalence holds
      // only because the clamp above keeps `cap` non-negative. Rewrite both `>=`
      // guards AND drop the `Math.max(0, …)` and the cap disappears entirely —
      // see the measured joint divergence at the `cap` declaration.
      if (items.length >= cap) {
        overflowed = true;
        break;
      }
      items.push(normalize(item));
      // Equivalent-mutant note: `added` is only ever compared against 0 (the
      // no-progress guard below), so the direction it counts in is not
      // observable — every non-zero total behaves alike. It counts up because it
      // is a count.
      added += 1;
    }
    // Typed `unknown`, not the declared `string | undefined`: `req` CASTS the
    // Graph body instead of validating it, so `null`, `''` or a number arrive in
    // fact. Everything below turns on telling an ABSENT cursor apart from an
    // unusable one (CC-DATA-11), and a `string | undefined` annotation made
    // `nextAfter === null` a compile error, which is how the two once ended up in
    // the same bucket.
    //
    // `undefined` means Graph omitted `paging.next`: the edge is finished,
    // whatever `cursors.after` the last page still carries (CC-DATA-115).
    // `page` is a plain object by now ({@link readPageData} refused everything
    // else).
    const nextAfter = nextPageCursor(page as object);

    if (!params.fetchAll) {
      // Single page: expose the cursor so the caller can continue explicitly —
      // but only when the cap left this page whole. A Graph cursor addresses a
      // PAGE boundary, not an offset inside a page, so once the cap cut the page
      // short this `after` points past every item Graph sent, INCLUDING the ones
      // just dropped: handing it back turns a visible short read into an
      // invisible hole. Withhold it and say why (CC-DATA-47). `truncated` with
      // no `after` is a documented combination of this result type, and
      // `api/discovery.ts` decides the identical question the identical way.
      if (overflowed) {
        truncated = true;
        note = CAP_MID_PAGE_NOTE;
      } else if (nextAfter !== undefined && !isUsableCursor(nextAfter)) {
        // CC-DATA-11 on the DEFAULT path. A cursor that is there and cannot be
        // sent back is no proof the edge ended — the `fetchAll` walk below and
        // `api/discovery.ts` both say so — but this branch used to hand it to
        // the publish guard, which dropped it and left `truncated: false`: the
        // model read a page with more behind it as the whole listing. No `next`
        // means finished; `next` with an unusable cursor means unknown, and
        // says so.
        truncated = true;
        note = UNUSABLE_CURSOR_NOTE;
      } else {
        resultAfter = nextAfter;
      }
      break;
    }
    // Equivalent-mutant note: `===` is again indistinguishable, because the item
    // loop above cannot push past the cap — but `>=` is the condition this branch
    // depends on ("we have all we are allowed to keep"), not a coincidence of it.
    // Same premise as the guard inside the loop: equivalent only while `cap` is
    // non-negative. See the joint divergence measured at the `cap` declaration.
    if (items.length >= cap) {
      // Capped: truncated only when more data genuinely remains (CC-DATA-4) —
      // and the cursor is published only when the cap left the last page whole.
      if (overflowed) {
        // The cap cut this page short, exactly as in the single-page branch and
        // for exactly the same reason: `nextAfter` is the boundary of a page whose
        // tail this walk just discarded, so resuming from it would skip those
        // items without a trace. Withhold it (CC-DATA-47) — and note that this is
        // the one capped stop where a bigger `maxItems` genuinely would have
        // helped, which is why the note tells the caller to shrink the page
        // instead of leaving them nothing to act on.
        truncated = true;
        note = CAP_MID_PAGE_NOTE;
      } else if (nextAfter !== undefined) {
        // The cap landed ON a page boundary, so this cursor names the exact
        // position the walk stopped at and nothing has been dropped behind it.
        // `!== undefined`, deliberately not `!= null`: the CC-DATA-11 guard sits
        // BELOW the cap check, so an unusable cursor still reaches this line, and
        // it is no more proof of exhaustion here than it is there — a capped read
        // that ended on one must not be published as complete.
        truncated = true;
        resultAfter = nextAfter;
        // …but an unusable cursor is normalised out of `after` when the result is
        // assembled, so the promise the two lines above just made — "truncated,
        // and here is where to resume" — cannot be kept, and the caller is left
        // with a short listing, no cursor and no reason. The note is the only
        // thing left to carry the reason.
        //
        // It promises no resume because none exists, and it does NOT suggest a
        // larger `maxItems`: a bigger cap would not stop here at all, it would
        // carry the walk into the guard below, which stops on the very same cursor
        // with the very same items. There is nothing more to be had from this edge
        // on this read.
        if (!isUsableCursor(nextAfter)) {
          note = 'stopped at the item cap on an unusable cursor — nothing to resume from';
        }
      }
      break;
    }
    if (nextAfter === undefined) break; // no `paging.next`: exhausted every page

    // CC-DATA-11. Whatever is left is a cursor that IS there and cannot be used,
    // and an unusable cursor is not proof of anything: it neither continues the
    // walk nor completes it.
    //
    // The order is the whole design. `undefined` is checked first and breaks
    // cleanly, leaving `truncated` alone, because Graph omitting `paging.next` is
    // Graph saying the edge is finished (CC-DATA-115). Only then does "not usable" mean "broken"
    // rather than "done" — the two must stay distinguishable in the result,
    // because "the edge is finished" and "the edge handed back something that
    // cannot be sent back" are different facts about the same read and the
    // operator can act on the difference.
    //
    // Carrying such a cursor forward re-fetched a page already in `items`. A
    // `null` did it byte for byte — `core/host.ts` drops a null query param, so
    // `after=null` IS `after` absent and page 2 was page 1 — and an empty string
    // did it one step less obviously, reaching the wire as `&after=` and asking
    // the edge for a position it does not have. Either way the walk returned every
    // item twice (`p1a,p1b,p1a,p1b`) and only stopped a page later, when the
    // repeated-cursor guard noticed the cursor had not changed. Stopping here
    // forfeits nothing: the request that would follow has already been answered.
    //
    // No `after` is published, because the only cursor on offer is the unusable
    // one and a resume the caller cannot perform is worse than an honest stop.
    //
    // This comment used to claim that a plain `if (!nextAfter)` could not be
    // killed here. It is killed — measured 2026-09-22 — by `listMedia treats a
    // cursor of the wrong TYPE as unusable, not as a cursor`. The claim reasoned
    // about FALSY cursors only, and that is not what `isUsableCursor` tests: it
    // is `typeof after === 'string' && after !== ''`, so it also rejects a cursor
    // that is TRUTHY and not a string — a number, an object, whatever a broken
    // edge puts in `paging.cursors.after` under a `req` that casts its payload
    // instead of validating it. `!nextAfter` accepts every one of those and keeps
    // paginating on a value that can never be sent back as a cursor.
    //
    // Equivalent-mutant note: adding `resultAfter = nextAfter` to this block is
    // unobservable, and the reason is worth stating because it says where the
    // guarantee actually lives. `resultAfter` is read in exactly one place — the
    // `isUsableCursor(resultAfter)` publish guard at the end — and it cannot hold
    // a stale value from an earlier iteration, because every other assignment to
    // it is followed immediately by `break`. So on this line `resultAfter` is
    // `undefined`, and assigning it a cursor this very branch has just proved
    // unusable leaves the publish guard rejecting it all the same. The result is
    // byte-identical either way: it is the publish guard, not the omission here,
    // that keeps an unusable cursor out of `after`.
    if (!isUsableCursor(nextAfter)) {
      note = UNUSABLE_CURSOR_NOTE;
      truncated = true;
      break;
    }

    // Termination guards — each keeps what was gathered and hands back a cursor.
    if (followed.has(nextAfter)) {
      note = 'the edge returned the same cursor twice (no forward progress) — resume from `after`';
    } else if (added === 0) {
      note =
        'a page returned no items while more remained (filtered or deleted) — resume from `after`';
    } else if (pageIndex >= MAX_PAGES) {
      // Equivalent-mutant note: `pageIndex` rises by exactly one per page and the
      // walk breaks the moment this fires, so it can never overshoot MAX_PAGES —
      // `===` would agree. `>=` is written because this is a ceiling, not a
      // checkpoint: it must hold for every page at or beyond the limit.
      note = `stopped after ${MAX_PAGES} pages (per-call page ceiling) — resume from \`after\``;
    }
    if (note !== undefined) {
      truncated = true;
      resultAfter = nextAfter;
      break;
    }

    followed.add(nextAfter);
    cursor = nextAfter;
  }

  const result: PagedResult<T> = { items, truncated };
  // A cursor is PUBLISHED only when it is a value the caller could hand back —
  // {@link isUsableCursor}, the same test the walk above stops on, so a cursor can
  // never be good enough to follow and too broken to report, or the reverse. Two
  // off-contract shapes reach this line, and both are worse than no cursor:
  //
  //   - JSON `null`. `null !== undefined`, so it used to be copied into `after`,
  //     a field declared `string | undefined`, and `tools/media.ts` put it in
  //     `structuredContent.paging.after`, whose output schema is
  //     `z.string().optional()`. The MCP SDK validates structured content against
  //     that schema, so a page that read perfectly came back as an "Output
  //     validation error" and the whole tool call failed.
  //   - the empty string. It survives the output schema, but every tool INPUT
  //     schema types `after` as `z.string().min(1)` — the model would be handed a
  //     cursor and then refused the moment it sent that cursor back.
  //
  // Neither is fixed by loosening a schema (`.nullable()`/`.nullish()` would
  // publish `after: null` as a documented result and delete the guard). They are
  // normalised HERE, in the layer that owns the domain type, to the only thing an
  // unusable cursor can mean: there is nothing to resume from. `truncated` is
  // left exactly as the walk decided it, so a read that could not prove it was
  // complete is still never reported as complete — it simply says so without
  // also offering a cursor that does not work.
  if (isUsableCursor(resultAfter)) result.after = resultAfter;
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
      path: `/${encodeURIComponent(params.igAccountId)}/media`,
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
  const raw = await req<unknown>({
    method: 'GET',
    path: `/${encodeURIComponent(params.mediaId)}`,
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
  const res = await req<unknown>({
    method: 'GET',
    path: `/${encodeURIComponent(params.mediaId)}/children`,
    params: { fields: CHILD_FIELDS },
  });
  // `req` casts the body, so `data` is checked for what it is (CC-DATA-67): only
  // an array is a list of children. A missing or null edge, a `data` that is a
  // string or an object, and a body that is not an object at all (JSON `null`
  // crashed `res.data` with a raw TypeError) all read as "no children listed".
  const data: unknown =
    typeof res === 'object' && res !== null
      ? (res as GraphListResponse<MediaChild>).data
      : undefined;
  return Array.isArray(data) ? (data as MediaChild[]) : [];
}
