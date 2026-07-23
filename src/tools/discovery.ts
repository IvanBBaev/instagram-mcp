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
 * Import boundary: `api/*` + `mcp/*` only; never `core/http`.
 */
import { z } from 'zod';
import { defineTool, type ToolSpec } from '../mcp/define.js';
import { fence, json } from '../mcp/result.js';
import {
  discoverBusiness,
  getHashtagMedia,
  searchHashtag,
  type BusinessDiscovery,
  type DiscoveredMedia,
  type HashtagMediaItem,
} from '../api/discovery.js';

// --- Hashtag-search budget (in-process, best-effort) -----------------------
// Meta enforces a 30-unique-hashtags / 7-days-per-account budget on
// ig_hashtag_search. We surface a best-effort approximation so callers can
// pace themselves. It is INTENTIONALLY not persisted: it lives in module memory
// only, resets when the process restarts, and is not shared across processes
// (v1 scope). Keyed by account id; each value maps a normalized hashtag to the
// epoch-ms it was first seen inside the current rolling window.

const HASHTAG_BUDGET_LIMIT = 30;
const HASHTAG_BUDGET_WINDOW_DAYS = 7;
const HASHTAG_BUDGET_WINDOW_MS = HASHTAG_BUDGET_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const hashtagBudget = new Map<string, Map<string, number>>();

/** Strip a leading `#` and lower-case so `#NoFilter` and `nofilter` are one. */
function normalizeHashtag(q: string): string {
  return q.trim().replace(/^#+/, '').toLowerCase();
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
    note: 'In-process best-effort counter — resets on process restart, not persisted, not shared across processes (v1).',
  };
}

// --- Output schemas --------------------------------------------------------
// Open enums stay `z.string()` (CC-DATA-6); every field but `id` is optional
// (CC-DATA-2); objects `.passthrough()` so additive Meta fields never break
// structured output (CC-DATA-7).

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

const businessOutput = z
  .object({
    id: z.string().optional(),
    username: z.string().optional(),
    name: z.string().optional(),
    biography: z.string().optional(),
    website: z.string().optional(),
    followers_count: z.number().optional(),
    follows_count: z.number().optional(),
    media_count: z.number().optional(),
    media: z.array(businessMediaOutput).optional(),
  })
  .passthrough();

// --- Untrusted-text fencing ------------------------------------------------

/** Fence a media object's caption (all other fields are ids/urls/counts). */
function hashtagMediaToRecord(m: HashtagMediaItem): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...m };
  if (m.caption !== undefined) rec.caption = fence(m.caption);
  return rec;
}

function discoveredMediaToRecord(m: DiscoveredMedia): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...m };
  if (m.caption !== undefined) rec.caption = fence(m.caption);
  return rec;
}

/** Fence every free-text field of a discovered profile plus each media caption. */
function businessToRecord(b: BusinessDiscovery): Record<string, unknown> {
  const rec: Record<string, unknown> = { ...b };
  if (b.username !== undefined) rec.username = fence(b.username);
  if (b.name !== undefined) rec.name = fence(b.name);
  if (b.biography !== undefined) rec.biography = fence(b.biography);
  if (b.media !== undefined) rec.media = b.media.map(discoveredMediaToRecord);
  return rec;
}

// --- Shared honesty note (appended to every description) --------------------

const DISCOVERY_HONESTY =
  ' Requires Meta\'s "Instagram Public Content Access" feature, which may be ' +
  'App-Review-gated. Path B (fb-login) only. Part of the `discovery` package, ' +
  'which ships dark by default (not in the default `core` selection).';

// --- Tools -----------------------------------------------------------------

const searchHashtagTool = defineTool({
  name: 'instagram_search_hashtag',
  title: 'Search Instagram hashtag',
  description:
    'Resolve a hashtag name to its Instagram hashtag id(s) via ' +
    'GET /ig_hashtag_search?user_id={ig-id}&q=<hashtag> (the returned id feeds ' +
    'instagram_get_hashtag_media). Budget: Meta allows only 30 UNIQUE hashtags ' +
    'per account per rolling 7 days; the result carries a best-effort in-process ' +
    'usage counter for this (it resets on process restart and is NOT persisted).' +
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
  },
  logFields: (args) => ({ hashtag: args.hashtag }),
  handler: async (args, ctx) => {
    const igId = ctx.profile.accountId ?? 'me';
    const query = normalizeHashtag(args.hashtag);
    const refs = await searchHashtag(ctx.req, { igId, query });
    const budget = recordHashtagUsage(igId, query, ctx.clock.now());
    return json({ query, ids: refs.map((r) => r.id), budget });
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
    'Captions are returned as fenced, untrusted text; the owner is not disclosed.' +
    DISCOVERY_HONESTY,
  package: 'discovery',
  paths: ['fb-login'],
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {
    hashtagId: z
      .string()
      .min(1)
      .describe('The hashtag id to read media for (obtain it from instagram_search_hashtag).'),
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
  },
  output: {
    items: z.array(hashtagMediaOutput),
    paging: z.object({ after: z.string().optional(), truncated: z.boolean() }).passthrough(),
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
    });

    const paging: Record<string, unknown> = { truncated: page.truncated };
    if (page.after !== undefined) paging.after = page.after;

    return json({ items: page.items.map(hashtagMediaToRecord), paging });
  },
});

const discoverBusinessTool = defineTool({
  name: 'instagram_discover_business',
  title: 'Discover Instagram business',
  description:
    "Fetch another business/creator's PUBLIC profile and recent media by handle " +
    'via GET /{ig-id}?fields=business_discovery.username(<handle>){followers_count,' +
    'media_count,media{...}}. The nested media edge is bounded by the server item ' +
    'cap (IG_MAX_ITEMS). Username, name, biography, and captions are returned as ' +
    'fenced, untrusted text; a personal/private/unknown handle returns an error.' +
    DISCOVERY_HONESTY,
  package: 'discovery',
  paths: ['fb-login'],
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: {
    username: z
      .string()
      .min(1)
      .max(30)
      .describe('The target public Instagram handle to look up, without a leading "@".'),
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
  },
  output: businessOutput.shape,
  logFields: (args) => ({ username: args.username, mediaLimit: args.mediaLimit }),
  handler: async (args, ctx) => {
    const igId = ctx.profile.accountId ?? 'me';
    const requested = args.mediaLimit ?? Math.min(25, ctx.settings.maxItems);
    const mediaLimit = Math.min(requested, ctx.settings.maxItems);
    const biz = await discoverBusiness(ctx.req, { igId, username: args.username, mediaLimit });
    return json(businessToRecord(biz));
  },
});

/** Read-only discovery tools, registered by `mcp/registry.ts`. */
export const discoveryTools: ToolSpec[] = [
  searchHashtagTool,
  getHashtagMediaTool,
  discoverBusinessTool,
] as unknown as ToolSpec[];
