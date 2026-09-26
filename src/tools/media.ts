/**
 * Media tool specs (Layer 3) — read-only surface of the `media` package.
 *
 * Two tools per docs/tools.md: `instagram_list_media` and `instagram_get_media`
 * (both `readOnlyHint`). The package's write tool (`instagram_set_comments_enabled`)
 * is deliberately not defined here — it belongs to the media-write task.
 *
 * Each handler calls the `api/media` layer through `ctx.req`, caps `fetchAll`
 * with `ctx.settings.maxItems`, and **fences untrusted media text** (captions)
 * before returning it to the model (docs/security.md §7). InstagramError from
 * the api layer is left to propagate — the registry maps and renders it.
 *
 * Import boundary: `api/*` + `mcp/*` only; never `core/http`.
 */
import { z } from 'zod';
import { graphObjectId } from './ids.js';
import { defineTool, type ToolSpec } from '../mcp/define.js';
import { fence, json } from '../mcp/result.js';
import {
  getMedia,
  getMediaChildren,
  listMedia,
  type MediaDetail,
  type MediaItem,
} from '../api/media.js';

// --- Output schemas --------------------------------------------------------
// Open enums (`media_type`, `media_product_type`) stay `z.string()` so values
// Meta later adds pass through (CC-DATA-6). Every field but `id` is optional
// because Meta omits rather than nulls (CC-DATA-2). Nested objects use
// `.passthrough()` so additive Meta fields never break structured output
// (CC-DATA-7).

const childOutput = z
  .object({
    id: z.string(),
    media_type: z.string().optional(),
    media_url: z.string().optional(),
    thumbnail_url: z.string().optional(),
    permalink: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

/** Reusable field shape for a media object. */
const mediaFieldsShape = {
  id: z.string(),
  caption: z.string().optional(),
  media_type: z.string().optional(),
  media_product_type: z.string().optional(),
  media_url: z.string().optional(),
  permalink: z.string().optional(),
  thumbnail_url: z.string().optional(),
  timestamp: z.string().optional(),
  like_count: z.number().optional(),
  comments_count: z.number().optional(),
} as const;

const mediaItemOutput = z.object(mediaFieldsShape).passthrough();

// --- Untrusted-text fencing and publishable values -------------------------
//
// `api/media` CASTS the Graph body (`core/host` says so outright), so a field
// typed `caption?: string` or `like_count?: number` means no more than "whatever
// Meta put in the JSON". Meta does send `caption: null` for a post with no
// caption; handed to `fence()` that threw `TypeError: … .split` from inside the
// handler, which the registry rendered as an `upstream` Instagram error. Any
// other scalar of the wrong type failed structured-output validation and took
// the WHOLE listing down as `MCP error -32602` over one field of one post. Every
// declared field but `id` is `.optional()`, so a field of the wrong type is
// dropped and costs the caller that field and nothing else — the same rule
// `tools/discovery` applies to the same media shape (CC-DATA-48).

/**
 * True for a media object or carousel child carrying an id another tool could
 * address. Both schemas declare `id: z.string()` as REQUIRED, so one id-less
 * entry would fail validation for the whole page; the entry is unusable anyway.
 */
function hasUsableId(m: unknown): boolean {
  const id: unknown = (m as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id !== '';
}

/**
 * The note published beside `omittedWithoutId`. An id-less entry is left out
 * rather than published (see {@link hasUsableId}), but leaving it out SILENTLY
 * told the model that a page of ten was a page of eight — and, on a page cut
 * short, that the account holds fewer posts than it does. The count says how
 * many; this says why, in the same place the paging notes already go.
 */
function omittedWithoutIdNote(count: number): string {
  return (
    `omitted ${count} ${count === 1 ? 'item' : 'items'} Instagram returned without a usable id ` +
    '(nothing can address an object with no id), so the page held more objects than items lists'
  );
}

/** Fence untrusted text in place, or drop the field when it is not a string. */
function fenceField(rec: Record<string, unknown>, key: string): void {
  const value = rec[key];
  if (typeof value === 'string') rec[key] = fence(value);
  else delete rec[key];
}

/** Keep a field only when it has the type its output schema declares. */
function typedField(rec: Record<string, unknown>, key: string, type: 'string' | 'number'): void {
  if (typeof rec[key] !== type) delete rec[key];
}

/** Keys a carousel child publishes as strings (`childOutput`). */
const CHILD_STRING_FIELDS = [
  'media_type',
  'media_url',
  'thumbnail_url',
  'permalink',
  'timestamp',
] as const;

/** Keys a media object publishes as strings, besides the fenced caption. */
const MEDIA_STRING_FIELDS = [...CHILD_STRING_FIELDS, 'media_product_type'] as const;

/**
 * Fence the caption and re-check every other declared scalar in place. Shared
 * by the two record builders below, which differ only in the record type they
 * accept and in the detail view's `children`.
 */
function publishMediaFields(rec: Record<string, unknown>): Record<string, unknown> {
  fenceField(rec, 'caption');
  for (const key of MEDIA_STRING_FIELDS) typedField(rec, key, 'string');
  typedField(rec, 'like_count', 'number');
  typedField(rec, 'comments_count', 'number');
  return rec;
}

/** One carousel child -> a publishable record (additive fields ride along). */
function childToRecord(c: unknown): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...(c as Record<string, unknown>) };
  for (const key of CHILD_STRING_FIELDS) typedField(rec, key, 'string');
  return rec;
}

// Equivalent-mutant note: the two helpers below differ only in their parameter
// type and in `children`, which a listed item never carries (the listing does
// not request the edge). They are kept apart because each is typed on the
// record its own tool publishes (`MediaItem` for the listing, `MediaDetail` for
// the detail view); one helper over the union would stop telling either call
// site which fields it is actually copying.
/** Copy `id` first, then the rest, fencing the caption as untrusted data. */
function mediaItemToRecord(m: MediaItem): Record<string, unknown> {
  return publishMediaFields({ ...m });
}

function mediaDetailToRecord(m: MediaDetail, requestedId: string): Record<string, unknown> {
  const rec = publishMediaFields({ ...m, id: detailId(m, requestedId) });
  // The edge is published only when it really is a NON-EMPTY list, minus any
  // id-less child — and that drop is counted and noted (CC-DATA-60), exactly as
  // the listing does, so an album of three that lists two does not read as an
  // album of two. `api/media` already reduces a non-array edge to absent; the
  // `Array.isArray` stays because this record is built from a cast body.
  //
  // An EMPTY list is omitted, never published as `children: []` (CC-DATA-68).
  // It reaches here only when neither the inline expansion nor the `/children`
  // fallback listed anything (or on a non-album that sent an empty edge), and
  // `[]` would be the positive claim "this album provably has no items" — the
  // same claim the handler already refuses to make when the inline edge is
  // missing rather than empty. The two cases used to disagree: a missing
  // inline edge plus an empty fallback published no key, an EMPTY inline edge
  // plus the same empty fallback published `children: []`.
  if (Array.isArray(m.children) && m.children.length > 0) {
    const usable = m.children.filter(hasUsableId);
    rec.children = usable.map(childToRecord);
    const omitted = m.children.length - usable.length;
    if (omitted > 0) {
      rec.omittedWithoutId = omitted;
      rec.note = omittedChildrenNote(omitted);
    }
  } else delete rec.children;
  return rec;
}

/**
 * The id `get_media` publishes. `id` is REQUIRED in its output, and unlike a
 * listing entry the object cannot simply be left out, so an id-less body failed
 * the whole read as `MCP error -32602` and every field that did arrive was lost.
 * The read is `GET /{mediaId}`, so the object answering is the one asked about
 * and the requested id is the honest fallback; a usable id Graph does send still
 * wins, as in `instagram_get_account` (CC-DATA-77).
 */
function detailId(m: MediaDetail, requestedId: string): string {
  return hasUsableId(m) ? m.id : requestedId;
}

/**
 * The note `get_media` publishes beside `omittedWithoutId` when a carousel child
 * came back without an id. Worded for the album, not the page: `children` is
 * the list that is short, and the album holds more items than it shows.
 */
function omittedChildrenNote(count: number): string {
  return (
    `omitted ${count} carousel ${count === 1 ? 'child' : 'children'} Instagram returned without ` +
    'a usable id (nothing can address an object with no id), so the album holds more items than ' +
    'children lists'
  );
}

// --- Tools -----------------------------------------------------------------

const listMediaTool = defineTool({
  name: 'instagram_list_media',
  title: 'List Instagram media',
  description:
    "List the operated account's own media (feed posts, reels, albums), newest first, " +
    'cursor-paginated. Stories are not included: Instagram serves live stories on a separate edge ' +
    'this tool does not read, so an empty or story-free page says nothing about active stories. ' +
    'Returns a single page by default; set fetchAll to aggregate pages up to the ' +
    "server's item cap (IG_MAX_ITEMS), in which case paging.truncated is true if more media remained. " +
    'Captions are returned as fenced, untrusted text. Some fields (like_count, media_url) may be ' +
    'absent when Instagram does not disclose them. An item Instagram returns without ' +
    'an id is left out, and omittedWithoutId plus note say how many were.',
  package: 'media',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Page-size hint forwarded to Instagram (1–100). Independent of the server item cap that ' +
          'bounds fetchAll.',
      ),
    after: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Opaque pagination cursor from a previous response's paging.after. Omit to start from the " +
          'newest media.',
      ),
    fetchAll: z
      .boolean()
      .optional()
      .describe(
        'When true, follow cursors and aggregate pages up to the server item cap (IG_MAX_ITEMS). The ' +
          'result sets paging.truncated=true when the cap is reached while more media remained.',
      ),
  },
  output: {
    items: z.array(mediaItemOutput),
    paging: z.object({ after: z.string().optional(), truncated: z.boolean() }).passthrough(),
    note: z.string().optional(),
    omittedWithoutId: z.number().int().optional(),
  },
  // Equivalent-mutant note: below, `args.fetchAll ?? false` and
  // `args.fetchAll || false` cannot be told apart. The schema types this
  // argument `boolean | undefined`, and `??` and `||` differ only on the
  // falsy-but-defined values `??` keeps — of those, only `false` is in the
  // domain, and it maps to `false` either way. `??` is still the honest
  // operator: it says the default applies to "absent", not to "falsy".
  logFields: (args) => ({
    limit: args.limit,
    fetchAll: args.fetchAll ?? false,
    // Equivalent-mutant note: `!!args.after` cannot be told apart from this.
    // The single value that separates them is `after: ''`, and `logFields` never
    // sees it: `after` is `z.string().min(1)` and the registry builds the audit
    // line from `parsed.data`, so the empty string is refused before this runs.
    // The strict form stays because the field answers "did the caller supply a
    // cursor?", which is a question about presence, not about truthiness.
    hasCursor: args.after !== undefined,
  }),
  handler: async (args, ctx) => {
    const page = await listMedia(ctx.req, {
      igAccountId: ctx.profile.accountId ?? 'me',
      maxItems: ctx.settings.maxItems,
      limit: args.limit,
      after: args.after,
      // Equivalent-mutant note: two mutants of this line are unobservable.
      // `args.fetchAll || false` coincides with `??` for the same reason as in
      // logFields above. Dropping the coalesce entirely (`fetchAll:
      // args.fetchAll`) is also equivalent *today*, because `PageParams.fetchAll`
      // is optional and `listMedia` branches on `if (!params.fetchAll)`, which
      // treats `undefined` and `false` identically. The explicit `false` is kept
      // so the default lives here, in the tool that documents it, rather than
      // depending on a falsy check one layer down.
      fetchAll: args.fetchAll ?? false,
    });

    // Equivalent-mutant note: relaxing either guard below to plain truthiness is
    // unobservable, because the api layer has already normalised both fields.
    // `fetchPagedEdge` publishes `after` only through `isUsableCursor`
    // (`api/media.ts`), which refuses the empty string outright — that is the
    // layer CC-DATA-23 makes responsible for the distinction — and every `note`
    // it can set is a non-empty literal. Removing a guard is a different matter
    // and is caught: `structuredContent` travels as a live object, so an
    // unconditional assignment leaves the key present with an `undefined` value,
    // which reads as "here is your next cursor, it just has no value". The strict
    // form stays because this layer must not quietly lean on the other one's
    // guard: it asks whether the api layer OFFERED a cursor or a note, not whether
    // what it offered happens to be truthy.
    const paging: Record<string, unknown> = { truncated: page.truncated };
    if (page.after !== undefined) paging.after = page.after;

    const usable = page.items.filter(hasUsableId);
    const payload: Record<string, unknown> = {
      items: usable.map(mediaItemToRecord),
      paging,
    };
    // An id-less entry is still dropped (the schema requires `id`), but the drop
    // is counted and noted rather than silent. Both keys are published only when
    // something was dropped, so a clean page carries neither.
    const omitted = page.items.length - usable.length;
    const notes: string[] = [];
    if (page.note !== undefined) notes.push(page.note);
    if (omitted > 0) {
      payload.omittedWithoutId = omitted;
      notes.push(omittedWithoutIdNote(omitted));
    }
    if (notes.length > 0) payload.note = notes.join('; ');

    return json(payload, { pretty: ctx.settings.prettyJson });
  },
});

const getMediaTool = defineTool({
  name: 'instagram_get_media',
  title: 'Get Instagram media',
  description:
    'Fetch a single media object by id, including its carousel children (album items) under `children`. ' +
    'The caption is returned as fenced, untrusted text. Fields Instagram does not disclose are omitted ' +
    'rather than nulled; a deleted object or an expired story (stories last 24h) returns an error. ' +
    'A carousel child Instagram returns without an id is left out, and omittedWithoutId plus note ' +
    'say how many were.',
  package: 'media',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {
    mediaId: graphObjectId().describe(
      'The Instagram media object id to fetch (e.g. an id from instagram_list_media).',
    ),
  },
  output: {
    ...mediaFieldsShape,
    children: z.array(childOutput).optional(),
    omittedWithoutId: z.number().int().optional(),
    note: z.string().optional(),
  },
  logFields: (args) => ({ mediaId: args.mediaId }),
  handler: async (args, ctx) => {
    const media = await getMedia(ctx.req, { mediaId: args.mediaId });

    // Fallback: some responses omit inline children on carousels — fetch the
    // `/children` edge so albums always resolve their items.
    if (
      media.media_type === 'CAROUSEL_ALBUM' &&
      (media.children === undefined || media.children.length === 0)
    ) {
      const children = await getMediaChildren(ctx.req, { mediaId: args.mediaId });
      if (children.length > 0) media.children = children;
    }

    return json(mediaDetailToRecord(media, args.mediaId), { pretty: ctx.settings.prettyJson });
  },
});

/** Read-only media tools, registered by `mcp/registry.ts`. */
export const mediaTools: readonly ToolSpec[] = Object.freeze([
  listMediaTool,
  getMediaTool,
] as unknown as ToolSpec[]);
