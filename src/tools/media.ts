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

// --- Untrusted-text fencing ------------------------------------------------

/** Copy `id` first, then the rest, fencing the caption as untrusted data. */
function mediaItemToRecord(m: MediaItem): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...m };
  if (m.caption !== undefined) rec.caption = fence(m.caption);
  return rec;
}

function mediaDetailToRecord(m: MediaDetail): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...m };
  if (m.caption !== undefined) rec.caption = fence(m.caption);
  return rec;
}

// --- Tools -----------------------------------------------------------------

const listMediaTool = defineTool({
  name: 'instagram_list_media',
  title: 'List Instagram media',
  description:
    "List the operated account's own media (feed posts, reels, stories, albums), newest first, " +
    'cursor-paginated. Returns a single page by default; set fetchAll to aggregate pages up to the ' +
    "server's item cap (IG_MAX_ITEMS), in which case paging.truncated is true if more media remained. " +
    'Captions are returned as fenced, untrusted text. Some fields (like_count, media_url, counts on ' +
    'stories) may be absent when Instagram does not disclose them.',
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
  },
  logFields: (args) => ({
    limit: args.limit,
    fetchAll: args.fetchAll ?? false,
    hasCursor: args.after !== undefined,
  }),
  handler: async (args, ctx) => {
    const page = await listMedia(ctx.req, {
      igAccountId: ctx.profile.accountId ?? 'me',
      maxItems: ctx.settings.maxItems,
      limit: args.limit,
      after: args.after,
      fetchAll: args.fetchAll ?? false,
    });

    const paging: Record<string, unknown> = { truncated: page.truncated };
    if (page.after !== undefined) paging.after = page.after;

    const payload: Record<string, unknown> = {
      items: page.items.map(mediaItemToRecord),
      paging,
    };
    if (page.note !== undefined) payload.note = page.note;

    return json(payload);
  },
});

const getMediaTool = defineTool({
  name: 'instagram_get_media',
  title: 'Get Instagram media',
  description:
    'Fetch a single media object by id, including its carousel children (album items) under `children`. ' +
    'The caption is returned as fenced, untrusted text. Fields Instagram does not disclose are omitted ' +
    'rather than nulled; a deleted object or an expired story (stories last 24h) returns an error.',
  package: 'media',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {
    mediaId: z
      .string()
      .min(1)
      .describe('The Instagram media object id to fetch (e.g. an id from instagram_list_media).'),
  },
  output: {
    ...mediaFieldsShape,
    children: z.array(childOutput).optional(),
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

    return json(mediaDetailToRecord(media));
  },
});

/** Read-only media tools, registered by `mcp/registry.ts`. */
export const mediaTools: ToolSpec[] = [listMediaTool, getMediaTool] as unknown as ToolSpec[];
