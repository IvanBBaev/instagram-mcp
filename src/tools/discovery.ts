/**
 * Discovery tool specs (Layer 3) — read-only surface of the `discovery` package.
 *
 * Three tools per docs/tools.md: `instagram_search_hashtag`,
 * `instagram_get_hashtag_media`, and `instagram_discover_business`. All read the
 * Instagram PUBLIC content graph via Facebook-Graph endpoints, so every spec is
 * **Path B (`fb-login`) only** (`paths: ['fb-login']`) and tagged
 * `package: 'discovery'`.
 *
 * HONESTY: these require Meta's "Instagram Public Content Access" feature, which
 * may be App-Review-gated even for own-app admins. The whole `discovery` package
 * ships **dark by default** (it is NOT part of the default `core` selection).
 *
 * Each handler calls the `api/discovery` layer through `ctx.req`, caps media with
 * `ctx.settings.maxItems`, and **fences untrusted third-party text** (captions,
 * usernames, bios) before returning it (docs/security.md §7). InstagramError from
 * the api layer is left to propagate — the registry maps and renders it.
 *
 * Import boundary: `api/*`, `mcp/*` and the error class from `core/types`;
 * never `core/http` or `core/host`.
 */
import { z } from 'zod';
import { graphObjectId } from './ids.js';
import { defineTool, type ToolSpec } from '../mcp/define.js';
import { fence, json } from '../mcp/result.js';
import {
  discoverBusiness,
  getHashtagMedia,
  searchHashtag,
  BUSINESS_MEDIA_CURSOR_PATTERN,
  INSTAGRAM_USERNAME_PATTERN,
  type BusinessDiscovery,
  type BusinessMediaPaging,
} from '../api/discovery.js';
import { InstagramError } from '../core/types.js';

// --- Hashtag-search budget (in-process, advisory only) ---------------------
// Meta enforces a 30-unique-hashtags / 7-days-per-account budget on
// ig_hashtag_search. This counter is an ADVISORY approximation so callers can
// pace themselves — it is NOT an enforcement mechanism and must not be read as
// one: nothing here blocks a search, `overBudget` only reports what this process
// has seen, and the map lives in module memory, so it resets on every restart
// and is not shared across processes (v1 scope). A long-lived stdio session is
// the only case where the count is even approximately right; Meta's own
// rejection remains the single hard signal. Keyed by account id; each value maps
// a normalized hashtag to the epoch-ms it was first seen in the rolling window.

const HASHTAG_BUDGET_LIMIT = 30;
const HASHTAG_BUDGET_WINDOW_DAYS = 7;
const HASHTAG_BUDGET_WINDOW_MS = HASHTAG_BUDGET_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const hashtagBudget = new Map<string, Map<string, number>>();

/** Strip a leading `#` and lower-case so `#NoFilter` and `nofilter` are one. */
function normalizeHashtag(q: string): string {
  // One leading run of "#" and whitespace in any order ("# travel", "##  Travel",
  // " \t#TRAVEL\n"), then the trailing whitespace. What is load-bearing is the
  // `\s` INSIDE the character class, not the order of the two calls. With `^#+`
  // alone, " #travel" keeps its "#" — the run no longer starts at index 0 — and
  // Graph cannot resolve "#travel", so the call is spent on nothing and a slot of
  // the 30-unique-hashtags budget is keyed on a tag nobody searched.
  //
  // Equivalent-mutant note: swapping the strip and the `.trim()` is NOT a live
  // guard. `[\s#]+` has already eaten the leading whitespace by the time the trim
  // runs, so the trim only ever reaches the tail either way. Measured over every
  // string of length 0..5 drawn from "#", space, tab, newline, "a", "B", "1", "_"
  // and ".": 66430 inputs, the swapped order differs on 0 of them while `^#+`
  // differs on 4062 (CC-PROC-193). Pin the class, not the order.
  //
  // An interior "#" ("a#b") is part of the tag and stays.
  return q
    .replace(/^[\s#]+/, '')
    .trim()
    .toLowerCase();
}

interface BudgetSnapshot {
  uniqueHashtagsUsed: number;
  limit: number;
  windowDays: number;
  remaining: number;
  overBudget: boolean;
  note: string;
}

/**
 * Record one hashtag search for `accountId` at `nowMs`, evicting entries older
 * than the rolling window first, and return the resulting budget snapshot.
 *
 * Equivalent-mutant note: no input separates `perAccount === undefined` from a
 * plain `!perAccount`. The value comes from `Map.prototype.get`, whose only two
 * outcomes are the stored value — always a `Map`, hence always truthy — and
 * `undefined` for a key that was never set; nothing falsy is ever stored under
 * an account id, because the only writer is the branch below. The explicit
 * comparison stays because it names the case being handled.
 */
function recordHashtagUsage(accountId: string, hashtag: string, nowMs: number): BudgetSnapshot {
  let perAccount = hashtagBudget.get(accountId);
  if (perAccount === undefined) {
    perAccount = new Map<string, number>();
    hashtagBudget.set(accountId, perAccount);
  }
  for (const [tag, seenAt] of perAccount) {
    if (nowMs - seenAt >= HASHTAG_BUDGET_WINDOW_MS) perAccount.delete(tag);
  }
  if (!perAccount.has(hashtag)) perAccount.set(hashtag, nowMs);
  const used = perAccount.size;
  return {
    uniqueHashtagsUsed: used,
    limit: HASHTAG_BUDGET_LIMIT,
    windowDays: HASHTAG_BUDGET_WINDOW_DAYS,
    remaining: Math.max(0, HASHTAG_BUDGET_LIMIT - used),
    overBudget: used > HASHTAG_BUDGET_LIMIT,
    note:
      'Advisory counter, NOT an enforced limit: the server never blocks a search on it. ' +
      'In-process only — resets on process restart, not persisted, not shared across processes ' +
      "(v1). Meta's own rejection is the hard signal.",
  };
}

// --- Output schemas --------------------------------------------------------
// Open enums stay `z.string()` (CC-DATA-6); every field but `id` is optional
// (CC-DATA-2); objects EMBEDDED in a tool output `.passthrough()` so additive
// Meta fields never break structured output (CC-DATA-7). A top-level output
// object is the exception — see the note on `businessOutput` for why a
// passthrough there is a promise the published schema cannot keep.

const budgetOutput = z
  .object({
    uniqueHashtagsUsed: z.number(),
    limit: z.number(),
    windowDays: z.number(),
    remaining: z.number(),
    overBudget: z.boolean(),
    note: z.string(),
  })
  .passthrough();

const hashtagMediaOutput = z
  .object({
    id: z.string(),
    caption: z.string().optional(),
    media_type: z.string().optional(),
    media_url: z.string().optional(),
    permalink: z.string().optional(),
    timestamp: z.string().optional(),
    like_count: z.number().optional(),
    comments_count: z.number().optional(),
  })
  .passthrough();

const businessMediaOutput = hashtagMediaOutput;

// No `.passthrough()` here, deliberately, unlike every schema above. This one is
// a TOP-LEVEL tool output: `instagram_discover_business` declares
// `output: businessOutput.shape`, and `.shape` is only the raw key -> schema map
// — the unknown-keys mode lives on the wrapper and does not survive. The SDK
// re-wraps that shape with a plain `z.object(...)` and publishes
// `additionalProperties: false` regardless of what was declared here, so a
// `.passthrough()` on this object would assert a guarantee it cannot deliver.
// It would also have nothing to carry: `api/discovery.discoverBusiness` copies
// the profile field by field off the wire rather than spreading it, so an
// additive Meta field is already gone before this schema is reached.
// CC-DATA-7 therefore lives one level down — `businessMediaOutput` (and
// `hashtagMediaOutput`, `budgetOutput`) are embedded as schemas, keep their
// passthrough, and are published `additionalProperties: true`; their items come
// straight off the wire, so additive fields really do arrive there.
const businessOutput = z.object({
  id: z.string().optional(),
  username: z.string().optional(),
  name: z.string().optional(),
  biography: z.string().optional(),
  website: z.string().optional(),
  followers_count: z.number().optional(),
  follows_count: z.number().optional(),
  media_count: z.number().optional(),
  media: z.array(businessMediaOutput).optional(),
  mediaPaging: z.object({ after: z.string().optional(), truncated: z.boolean() }).optional(),
  mediaLimitApplied: z.number().int().optional(),
  omittedWithoutId: z.number().int().optional(),
  note: z.string().optional(),
});

// --- Publishable values ----------------------------------------------------
//
// Everything below re-checks at runtime what the api-layer types already say,
// because those types are a CAST and not a proof: `core/host` states outright
// that `req` only casts a Graph body, so a field typed `string | undefined` is
// "whatever Meta put in the JSON". These helpers publish only values that (a)
// satisfy the declared output schema and (b) a caller can actually use.

/**
 * True for a non-null, non-array object — the shape a media record must have.
 *
 * Equivalent-mutant note: dropping `!Array.isArray(value)` cannot be observed by
 * any test worth writing. The only caller is `hasUsableId`, which immediately
 * demands a non-empty string `id`, and a JSON array never carries one — the
 * value reaching here came off the wire through `JSON.parse`, so an array with
 * an own `id` property is not expressible. Pinning that with a hand-built
 * `Object.assign([], { id: "x" })` would assert behaviour for an input the
 * transport cannot produce. The check stays because it is what makes the type
 * predicate honest: `Record<string, unknown>` claims a keyed record, and every
 * later mutation of this module (a new field read off `rec`) would inherit that
 * claim from here rather than re-deriving it. The same argument covers the wider
 * mutation — accepting any non-nullish value, primitives included: `hasUsableId`
 * would then read `.id` off a string, a number or a boolean, none of which has
 * one, so the entry is dropped exactly as it is today.
 */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True only for a non-empty string. Every id and cursor this module publishes
 * has to survive a round trip — the model spends it as the next call's
 * `hashtagId` or `after` — and both of those inputs reject `""`
 * (`graphObjectId()`, `.min(1)`), so an empty or non-string value is no handle
 * on anything, whatever the api-layer type claims. `api/media.ts` spells the
 * same rule for its own cursors as `isUsableCursor` (CC-DATA-11: a null or
 * empty cursor means "unusable", not "resume from the edge").
 */
function isUsableHandle(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Fence untrusted third-party text in place, or drop the field.
 *
 * A caption/bio/name that arrives as `null` (Meta does emit that for media with
 * no caption) or as a number reaches `fence()` typed as a string and throws
 * `TypeError: … .split is not a function` from inside the handler, which the
 * registry then renders as an `upstream` Instagram error — another party's data
 * failing the call under a mislabelled kind. Dropping is the only honest
 * alternative: a non-string cannot satisfy the declared `z.string().optional()`
 * output either, so publishing it as-is would trade the TypeError for an
 * output-validation error, and it must never be published unfenced. An empty
 * string is real text and stays fenced.
 */
function fenceField(rec: Record<string, unknown>, key: string): void {
  const value = rec[key];
  if (typeof value === 'string') {
    rec[key] = fence(value);
    return;
  }
  delete rec[key];
}

/**
 * Keep a numeric field only when the wire really sent a number, else drop it.
 *
 * The sibling of {@link fenceField} for the fields that carry no text. The api
 * layer CASTS the Graph body — `core/host` says so outright — so a property
 * declared `followers_count: number` means no more than “whatever Meta put in
 * the JSON”. Publishing a `null` under a key the output schema declares
 * `z.number()` either fails structured-output validation and takes the WHOLE
 * profile down over one field, or reaches the model as a number-shaped hole it
 * was promised could not exist. Every count is `.optional()`, so dropping the
 * one bad field costs nothing else (CC-PROC-172).
 */
function numberField(rec: Record<string, unknown>, key: string): void {
  if (typeof rec[key] !== 'number') delete rec[key];
}

/**
 * As {@link numberField}, for an id — kept only when it is a real string, and
 * never fenced: an id is spent on the next call, not read as prose.
 */
function stringField(rec: Record<string, unknown>, key: string): void {
  if (typeof rec[key] !== 'string') delete rec[key];
}

/**
 * One untrusted media object -> a publishable record: additive Meta fields ride
 * along (CC-DATA-7), the caption is fenced, and every other scalar the output
 * schema declares is re-checked against the type that schema promises. Hashtag
 * media and discovered media are the same shape (api/discovery's
 * `HashtagMediaItem` and `DiscoveredMedia`) and are published against the same
 * schema, so they share one mapper.
 *
 * The six re-checks below are not belt-and-braces. `hashtagMediaOutput` declares
 * seven fields beyond `id` and the api layer supplies every one of them through
 * a CAST of the Graph body, so `like_count: number | undefined` means no more
 * than "whatever Meta put in the JSON". One `null` under one of them fails
 * structured-output validation and takes the WHOLE page down as
 * `MCP error -32602` — precisely the failure {@link mediaRecords} drops id-less
 * entries to avoid, arriving through a different field (CC-DATA-48). Each of the
 * seven is `.optional()`, so dropping the one bad field costs the caller that
 * field and nothing else; the entry keeps its id and the page stays a page.
 * {@link businessToRecord} has re-checked every scalar it declares since it was
 * written, and this mapper declares the same kind of fields.
 *
 * `media_url` and `permalink` are re-checked but deliberately NOT fenced, unlike
 * the `website` of a discovered profile. A profile's website is typed by the
 * competitor being looked up; these two are minted by Meta for a media object it
 * already hosts. Fencing them would also break them as values — they are spent
 * as links, not read as prose — which is the same reason an `id` is re-checked
 * and never fenced.
 */
function mediaToRecord(m: Record<string, unknown>): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...m };
  fenceField(rec, 'caption');
  stringField(rec, 'media_type');
  stringField(rec, 'media_url');
  stringField(rec, 'permalink');
  stringField(rec, 'timestamp');
  numberField(rec, 'like_count');
  numberField(rec, 'comments_count');
  return rec;
}

/** True for a media object carrying an id the caller could spend downstream. */
function hasUsableId(m: unknown): m is Record<string, unknown> {
  return isRecordObject(m) && isUsableHandle(m.id);
}

/**
 * Map a media array, dropping every entry that is not an object with a usable
 * `id`. Both output schemas declare `id: z.string()` as REQUIRED, so a single
 * id-less entry would fail structured-output validation and take the whole page
 * down (`MCP error -32602`) — and an id-less media object is unusable anyway:
 * no other tool can address it. Losing one degenerate entry beats losing the
 * page, but the loss is COUNTED: a page that silently lists fewer objects than
 * Instagram sent reads as a complete page, so every caller publishes `omitted`
 * as `omittedWithoutId` plus a note (same wording as `tools/media`).
 */
function mediaRecords(items: readonly unknown[]): {
  records: Record<string, unknown>[];
  omitted: number;
} {
  const usable = items.filter(hasUsableId);
  return { records: usable.map(mediaToRecord), omitted: items.length - usable.length };
}

/**
 * The note for `count` entries dropped for want of a usable id. `what` names the
 * container they were dropped from, so the sentence says which list is short.
 */
function omittedWithoutIdNote(count: number, what: string): string {
  return (
    `omitted ${count} ${count === 1 ? 'item' : 'items'} Instagram returned without a usable id ` +
    `(nothing can address an object with no id), so ${what}`
  );
}

/** Note for a `business_discovery` media edge that arrived but is not a list. */
const UNREADABLE_MEDIA_EDGE_NOTE =
  'Instagram returned the media edge in a shape that is not a list, so no media are listed — ' +
  'this is not an account with no posts';

/**
 * Fence every free-text field of a discovered profile, re-check every scalar
 * the output schema declares, and fence each media caption.
 *
 * A discovered profile is the least trusted payload this server publishes:
 * every string in it is written by the competitor being looked up. `website`
 * belonged on the fenced list from the first version and was missed — Meta
 * returns it as free text, not as a validated URL, and a query string is a
 * comfortable place to park a line of instructions. The SAME field on the
 * OPERATED account has been fenced all along in `tools/account`, which made a
 * stranger’s copy of it the more trusted of the two (CC-PROC-172).
 */
function businessToRecord(b: BusinessDiscovery, notes: string[]): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...b };
  // The api layer's own note joins the handler's rather than overwriting them.
  // Equivalent-mutant note: dropping this `delete` is not observable today — a
  // string `b.note` is pushed below, so the handler always overwrites `rec.note`
  // with the joined list. It stays so the record never carries the api's note
  // under the handler's key by accident of ordering.
  delete rec.note;
  if (typeof b.note === 'string') notes.push(b.note);
  stringField(rec, 'id');
  fenceField(rec, 'username');
  fenceField(rec, 'name');
  fenceField(rec, 'biography');
  fenceField(rec, 'website');
  numberField(rec, 'followers_count');
  numberField(rec, 'follows_count');
  numberField(rec, 'media_count');
  // `api/discovery` publishes `media` only when the wire edge really is a list
  // and flags an unreadable one instead (CC-DATA-87). The `Array.isArray`
  // stays as the guard `.map()` needs whatever the api type claims.
  delete rec.mediaUnreadable;
  if (Array.isArray(b.media)) {
    const { records, omitted } = mediaRecords(b.media);
    rec.media = records;
    // CC-DATA-116: the edge's paging travels with the list, so a profile with
    // more posts than one page no longer reads as complete. `api/discovery`
    // sets `mediaPaging` together with `media` (readMediaEdge), so it is
    // present whenever this branch runs.
    const paging = b.mediaPaging as BusinessMediaPaging;
    rec.mediaPaging =
      paging.after === undefined
        ? { truncated: paging.truncated }
        : { after: paging.after, truncated: paging.truncated };
    if (paging.note !== undefined) notes.push(paging.note);
    if (omitted > 0) {
      rec.omittedWithoutId = omitted;
      notes.push(
        omittedWithoutIdNote(omitted, 'the media edge held more objects than media lists'),
      );
    }
  } else {
    // An edge `api/discovery` flagged as unreadable is one Instagram answered in
    // a shape nothing can read. Dropping it silently made it indistinguishable
    // from an undisclosed edge, and a caller asking "what did they post" read
    // that as nothing. An undisclosed edge stays silent: that is Meta declining
    // to disclose it.
    if (b.mediaUnreadable === true) notes.push(UNREADABLE_MEDIA_EDGE_NOTE);
    delete rec.media;
  }
  return rec;
}

// --- Shared honesty note (appended to every description) --------------------

const DISCOVERY_HONESTY =
  ' Requires Meta\'s "Instagram Public Content Access" feature, which may be ' +
  'App-Review-gated. Path B (fb-login) only. Part of the `discovery` package, ' +
  'which ships dark by default (not in the default `core` selection).';

// --- Tools -----------------------------------------------------------------

/** Note for a hashtag search whose `data` was present but not a list (`null` included), or whose body was not an object. */
const UNREADABLE_SEARCH_NOTE =
  'Instagram answered the search in a shape that is not a list, so no match could be read — ' +
  'an empty ids is not proof that no hashtag matched; retry later';

const searchHashtagTool = defineTool({
  name: 'instagram_search_hashtag',
  title: 'Search Instagram hashtag',
  description:
    'Resolve a hashtag name to its Instagram hashtag id(s) via ' +
    'GET /ig_hashtag_search?user_id={ig-id}&q=<hashtag> (the returned id feeds ' +
    'instagram_get_hashtag_media). Budget: Meta allows only 30 UNIQUE hashtags ' +
    'per account per rolling 7 days; the result carries an ADVISORY in-process ' +
    'counter for this — it is not an enforced limit (nothing is blocked on it), ' +
    'it resets on process restart, and it is NOT persisted or shared. ' +
    'A match Instagram returns without an id is left out, and omittedWithoutId plus note ' +
    'say how many were.' +
    DISCOVERY_HONESTY,
  package: 'discovery',
  paths: ['fb-login'],
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {
    hashtag: z
      .string()
      .min(1)
      .max(150)
      .describe(
        'Hashtag to look up, with or without a leading "#" (e.g. "nofilter" or "#nofilter"). ' +
          'Counts against the 30-unique-hashtags / 7-days-per-account budget.',
      ),
  },
  output: {
    query: z.string(),
    ids: z.array(z.string()),
    budget: budgetOutput,
    omittedWithoutId: z.number().int().optional(),
    note: z.string().optional(),
  },
  logFields: (args) => ({ hashtag: args.hashtag }),
  handler: async (args, ctx) => {
    const igId = ctx.profile.accountId ?? 'me';
    const query = normalizeHashtag(args.hashtag);
    // The schema's `.min(1)` is about the ARGUMENT; normalization can still
    // empty it ("#", "###", "  "), and `q=` on the wire is not a hashtag search.
    // Refusing here costs the caller nothing and keeps a meaningless lookup from
    // spending both a Graph call and a slot of the 30-unique-hashtags budget.
    // The message never echoes the value — error text reaches logs and model
    // context, and this argument is untrusted model input (same rule as
    // `api/discovery.assertValidUsername`).
    if (query === '') {
      throw new InstagramError(
        'Invalid hashtag: nothing is left after stripping the leading "#" characters and ' +
          'surrounding whitespace. Pass the hashtag name itself (e.g. "nofilter").',
        { kind: 'validation' },
      );
    }
    const refs = await searchHashtag(ctx.req, { igId, query });
    const budget = recordHashtagUsage(igId, query, ctx.clock.now());
    // Only ids that can be spent as the next call's `hashtagId`: an empty or
    // absent id is not a hashtag reference, and the declared output
    // (`z.array(z.string())`) would reject it and fail the whole call.
    // The drop is counted, not silent: an empty `ids` would otherwise read as
    // "no such hashtag" when Instagram in fact matched one. The body is cast,
    // not validated: a `null` entry is counted like an id-less one rather than
    // throwing on `.id`, and a `data` that is not an array holds no match to
    // read instead of crashing the call on `.map` — said in `note` below.
    const matches: unknown[] = Array.isArray(refs) ? refs : [];
    const ids = matches
      .filter(isRecordObject)
      .map((r) => r.id)
      .filter(isUsableHandle);
    const payload: Record<string, unknown> = { query, ids, budget };
    const omitted = matches.length - ids.length;
    if (omitted > 0) {
      payload.omittedWithoutId = omitted;
      payload.note = omittedWithoutIdNote(
        omitted,
        'Instagram matched more hashtags than ids lists',
      );
    }
    // Nothing to count is not the same as nothing matched: an empty `ids` from a
    // `data` that was not a list would otherwise read as "no such hashtag", and
    // the budget slot is spent either way.
    if (!Array.isArray(refs)) payload.note = UNREADABLE_SEARCH_NOTE;
    return json(payload, { pretty: ctx.settings.prettyJson });
  },
});

const getHashtagMediaTool = defineTool({
  name: 'instagram_get_hashtag_media',
  title: 'Get Instagram hashtag media',
  description:
    'List PUBLIC media under a hashtag id via GET /{hashtag-id}/top_media or ' +
    '/{hashtag-id}/recent_media (choose via `edge`), which require the operated ' +
    "account's id as user_id. Results are capped at the server item cap " +
    '(IG_MAX_ITEMS) with paging.truncated=true when the page exceeded the cap. ' +
    'To read the next page, pass the returned paging.after value back as `after`; ' +
    'it is omitted when the cap cut the page mid-way (paging.truncated=true), because ' +
    'no cursor can resume from there (lower `limit` instead). ' +
    'Captions are returned as fenced, untrusted text; the owner is not disclosed. ' +
    'paging.truncated=true with no after is also set when Instagram returned a cursor that ' +
    'cannot be sent again; note then says why the listing stopped. When Instagram returned a ' +
    'page that is not a list, nothing on it is read: paging.truncated=true, note says so, and ' +
    'paging.after is the cursor you sent (none on a first page) so that page can be retried. ' +
    'An item returned without an id is left out, and omittedWithoutId plus note say how many were.' +
    DISCOVERY_HONESTY,
  package: 'discovery',
  paths: ['fb-login'],
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {
    hashtagId: graphObjectId().describe(
      'The hashtag id to read media for (obtain it from instagram_search_hashtag).',
    ),
    edge: z
      .enum(['top', 'recent'])
      .describe(
        '"top" reads the most popular media (top_media); "recent" reads the newest media (recent_media).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Page-size hint forwarded to Instagram (1–100). Independent of the server item cap that bounds the result.',
      ),
    after: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Continuation cursor: the `paging.after` value returned by a previous call for the same ' +
          'hashtag id and edge. Omit to read the first page.',
      ),
  },
  output: {
    items: z.array(hashtagMediaOutput),
    paging: z.object({ after: z.string().optional(), truncated: z.boolean() }).passthrough(),
    omittedWithoutId: z.number().int().optional(),
    note: z.string().optional(),
  },
  logFields: (args) => ({ hashtagId: args.hashtagId, edge: args.edge, limit: args.limit }),
  handler: async (args, ctx) => {
    const igId = ctx.profile.accountId ?? 'me';
    const page = await getHashtagMedia(ctx.req, {
      hashtagId: args.hashtagId,
      igId,
      edge: args.edge,
      maxItems: ctx.settings.maxItems,
      limit: args.limit,
      after: args.after,
    });

    // `truncated` says there was more than the caller is holding; `after` is
    // handed back ONLY when it could actually be sent again. `api/discovery`
    // withholds it for a truncated page (no cursor addresses a position inside a
    // page) and turns an empty, null or non-string cursor into a truncated page
    // with a note (CC-DATA-11). This guard stays as the last line: publishing
    // `""` would hand back a value this tool's own `after` input rejects, and
    // `null` fails the declared output schema, killing a page that was fine.
    const paging: Record<string, unknown> = { truncated: page.truncated };
    if (isUsableHandle(page.after)) paging.after = page.after;

    // `api/discovery` hands on a list or an unreadable page's empty one
    // (CC-DATA-80), never the raw `data`.
    const { records: items, omitted } = mediaRecords(page.items);
    const payload: Record<string, unknown> = { items, paging };
    const notes: string[] = [];
    if (typeof page.note === 'string') notes.push(page.note);
    if (omitted > 0) {
      payload.omittedWithoutId = omitted;
      notes.push(omittedWithoutIdNote(omitted, 'the page held more objects than items lists'));
    }
    if (notes.length > 0) payload.note = notes.join('; ');
    return json(payload, { pretty: ctx.settings.prettyJson });
  },
});

const discoverBusinessTool = defineTool({
  name: 'instagram_discover_business',
  title: 'Discover Instagram business',
  description:
    "Fetch another business/creator's PUBLIC profile and recent media by handle " +
    'via GET /{ig-id}?fields=business_discovery.username(<handle>){followers_count,' +
    'media_count,media{...}}. The nested media edge is bounded by the server item ' +
    'cap (IG_MAX_ITEMS). Username, name, biography, website, and captions are ' +
    'returned as fenced, untrusted text; a personal/private/unknown handle returns an error. ' +
    'When mediaLimit exceeds the cap, mediaLimitApplied carries the number actually requested ' +
    'and note says so. mediaPaging.truncated=true means the media list may continue: pass ' +
    'mediaPaging.after back as mediaAfter to read the next page (no after: nothing can resume it, ' +
    'and note says why). A media object returned without an id is left out, and ' +
    'omittedWithoutId plus note say how many were.' +
    DISCOVERY_HONESTY,
  package: 'discovery',
  paths: ['fb-login'],
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {
    username: z
      .string()
      .min(1)
      .max(30)
      // The handle is interpolated into a Graph field expression by the api
      // layer, which has no escaping mechanism — so the input is constrained to
      // the exact Instagram handle charset. `api/discovery` re-checks it.
      .regex(
        INSTAGRAM_USERNAME_PATTERN,
        'must be a plain Instagram handle: letters, digits, "." and "_" only',
      )
      .describe(
        'The target public Instagram handle to look up, without a leading "@". ' +
          'Letters, digits, "." and "_" only (1-30 characters).',
      ),
    mediaLimit: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'How many recent media objects to request (0 for none). Bounded by the server item cap; ' +
          'defaults to min(25, cap).',
      ),
    mediaAfter: z
      .string()
      // Interpolated into the field expression as `media.after(<cursor>)`, which
      // has no escaping — so the charset is pinned exactly as for `username`,
      // and `api/discovery` re-checks it (CC-DATA-116).
      .regex(BUSINESS_MEDIA_CURSOR_PATTERN, 'must be a mediaPaging.after cursor returned earlier')
      .optional()
      .describe(
        "Continuation cursor for the media list: a previous response's mediaPaging.after for the " +
          'same username. Omit to read the most recent media.',
      ),
  },
  output: businessOutput.shape,
  logFields: (args) => ({
    username: args.username,
    mediaLimit: args.mediaLimit,
  }),
  handler: async (args, ctx) => {
    const igId = ctx.profile.accountId ?? 'me';
    // The `Math.min(25, ...)` in the default is load-bearing twice over. It
    // keeps the input `.describe()` promise ("defaults to min(25, cap)"), and it
    // keeps the default from ever counting as a clamp below: with a bare
    // `?? 25` and a cap under 25, a call that named no mediaLimit would be told
    // its request had been lowered. The clamp itself is NOT redundant either:
    // `mediaLimit` accepts up to 100 and the cap can be lower (CC-PROC-193).
    const requested = args.mediaLimit ?? Math.min(25, ctx.settings.maxItems);
    const mediaLimit = Math.min(requested, ctx.settings.maxItems);
    const biz = await discoverBusiness(ctx.req, {
      igId,
      username: args.username,
      mediaLimit,
      mediaAfter: args.mediaAfter,
    });
    const notes: string[] = [];
    // An EXPLICIT mediaLimit the cap lowered is surfaced: without it, a profile
    // with fewer media than asked for and a clamped request look identical, and
    // the model would read "10 of the 50 I asked for" as "they posted 10". The
    // default is never reported — nobody asked for a number it could contradict.
    const clamped = requested !== mediaLimit;
    if (clamped) {
      notes.push(
        `mediaLimit ${requested} exceeds the server item cap (IG_MAX_ITEMS), so ${mediaLimit} ` +
          'media objects were requested instead',
      );
    }
    const rec = businessToRecord(biz, notes);
    if (clamped) rec.mediaLimitApplied = mediaLimit;
    if (notes.length > 0) rec.note = notes.join('; ');
    return json(rec, { pretty: ctx.settings.prettyJson });
  },
});

/** Read-only discovery tools, registered by `mcp/registry.ts`. */
export const discoveryTools: readonly ToolSpec[] = Object.freeze([
  searchHashtagTool,
  getHashtagMediaTool,
  discoverBusinessTool,
] as unknown as ToolSpec[]);
