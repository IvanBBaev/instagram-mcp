# Tool Catalog Specification

> Design document. Tool names are final unless a review changes them; Graph calls
> are indicative (host depends on auth path — see [auth.md](auth.md)) and pinned to
> v25.0. Every input field carries a zod `.describe()`; every tool carries MCP
> annotations. Naming convention: `instagram_<verb>_<noun>`.

Legend: **RO** = `readOnlyHint: true` · **D** = `destructiveHint: true` ·
**I** = `idempotentHint: true`. All tools are `openWorldHint: true` (remote API).
Every schema auto-receives an optional `account` argument (multi-profile selector).

## Write safety (applies to every non-RO tool)

Mirrors the reference plan-and-apply gate:

- Every write tool accepts `apply?: boolean`. Without `apply: true` (and unless
  `IG_WRITE_MODE=apply`), the tool returns a **non-mutating preview** — what would
  be sent, to which endpoint, with which side effects (e.g. "this consumes 1 of the
  remaining publishing quota") — and performs **no write request**. A preview may
  issue read-only GETs (e.g. the quota check), never anything mutating.
- Previews **cannot pre-validate media URLs**: the server never fetches
  user-supplied URLs (SSRF policy — [security.md](security.md)), so reachability
  is only proven when Meta fetches the URL at container creation. Previews state
  this limitation explicitly.
- Applied writes append to a local **write journal** (`~/.local/state/instagram-mcp-ai/`).
- `instagram_delete_comment` is additionally gated by `IG_ALLOW_DESTRUCTIVE=true`.

## Package `account`

| Tool | Ann. | Purpose / Graph call |
|---|---|---|
| `instagram_get_account` | RO | Profile of the operated account: `GET /{ig-id}?fields=username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count` |
| `instagram_list_linked_accounts` | RO | Path B only: enumerate Pages + linked IG accounts: `GET /me/accounts?fields=name,instagram_business_account{id,username}` |
| `instagram_token_status` | RO | Token metadata: validity, path (A/B), scopes, expires-at, days-left warning; rate-limit budget snapshot from last-seen usage headers |

## Package `media`

| Tool | Ann. | Purpose / Graph call |
|---|---|---|
| `instagram_list_media` | RO | Own media, cursor-paginated: `GET /{ig-id}/media?fields=id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count` |
| `instagram_get_media` | RO | Single media by ID, same field set + `children{...}` for carousels |
| `instagram_set_comments_enabled` | I | Toggle commenting: `POST /{media-id}?comment_enabled=true\|false` |

## Package `publishing`

The Instagram publish flow is **two-phase**: create a container, then publish it.
Media is **ingested by public URL** — Meta's servers fetch `image_url`/`video_url`;
the server never uploads local bytes for images (see design note below).

| Tool | Ann. | Purpose / Graph call |
|---|---|---|
| `instagram_create_media_container` | — | `POST /{ig-id}/media`. Feed image: `image_url` with **no `media_type` param** (`IMAGE` is not a valid value; neither is `VIDEO` — feed video *is* Reels) *[verified 2026-07-21]*. `media_type` = `REELS` / `STORIES` / `CAROUSEL` for the rest; `video_url`, `caption`, `location_id`, `user_tags`, `children` (carousel: 2–10 container IDs), `cover_url`/`thumb_offset` + `share_to_feed` (reels). Returns container ID |
| `instagram_get_container_status` | RO, I | `GET /{container-id}?fields=status_code,status` → `IN_PROGRESS` / `FINISHED` / `ERROR` / `EXPIRED` / `PUBLISHED`. Video containers must reach `FINISHED` before publish; subcode 2207027 = still processing → keep polling, never re-create |
| `instagram_publish_media` | — | `POST /{ig-id}/media_publish?creation_id={container-id}`. Preview mode reports quota impact first. **Never auto-retried** (duplicate-post risk) |
| `instagram_get_publishing_limit` | RO | `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config` — quota total read at **runtime** from `config.quota_total` (Meta docs conflict: 100 vs 50 — never hardcoded) *[verified 2026-07-21]*; carousel = 1 |
| `instagram_post_image` | — | **Convenience composite**: container + poll + publish for a single image/carousel in one call; the preview shows the full plan |
| `instagram_post_reel` | — | Convenience composite for `REELS` (video URL, cover, share_to_feed) |
| `instagram_post_story` | — | Convenience composite for `STORIES` (image or video) |

**Design note — media hosting**: because ingestion is URL-based, publishing a local
file requires a publicly reachable URL. v1 documents this constraint honestly and
accepts only URLs. A later phase may add an opt-in helper that uploads to
**operator-configured** storage (e.g. their S3 bucket); the server will never spin up
tunnels or anonymous hosting. Caption limits (2,200 chars, 30 hashtags, 20 @tags),
image spec (**JPEG only** — PNG is rejected; ≤ 8 MB, aspect 0.8–1.91), reels spec
(3 s–15 min, **≤ 300 MB**), stories video (≤ 60 s, ≤ 100 MB) enforced client-side
with zod before any quota is spent *[verified 2026-07-21 against official docs]*.

## Package `comments`

| Tool | Ann. | Purpose / Graph call |
|---|---|---|
| `instagram_list_comments` | RO | `GET /{media-id}/comments?fields=id,text,username,timestamp,like_count,replies{...}`, cursor-paginated |
| `instagram_get_comment` | RO | `GET /{comment-id}?fields=...` incl. parent/media context |
| `instagram_reply_to_comment` | — | `POST /{comment-id}/replies?message=...` (threaded reply) |
| `instagram_create_comment` | — | Top-level comment on own media: `POST /{media-id}/comments?message=...` |
| `instagram_hide_comment` | I | `POST /{comment-id}?hide=true` (reversible moderation — preferred over delete) |
| `instagram_unhide_comment` | I | `POST /{comment-id}?hide=false` |
| `instagram_delete_comment` | **D** | `DELETE /{comment-id}` — irreversible; double-gated (apply + `IG_ALLOW_DESTRUCTIVE`) |
| `instagram_list_tagged_media` | RO | Media the account is **tagged in**: `GET /{ig-id}/tags` (both auth paths). Note *[verified 2026-07-21]*: tags ≠ @mentions — pull-based @mention lookup (`mentioned_media`/`mentioned_comment`) is **Path B only**; Path A can only *reply* to mentions (`POST /{ig-id}/mentions`); story @mentions unsupported on Path A |

## Package `insights`

Built on the **post-2025-01-08 metric set** (`views`-centric; `video_views`,
`profile_views` etc. are gone — never referenced).

| Tool | Ann. | Purpose / Graph call |
|---|---|---|
| `instagram_get_account_insights` | RO | `GET /{ig-id}/insights?metric=views,reach,accounts_engaged,total_interactions,likes,comments,shares,saves,replies,follows_and_unfollows,profile_links_taps&period=day&metric_type=total_value&since=&until=` |
| `instagram_get_media_insights` | RO | `GET /{media-id}/insights?metric=views,reach,likes,comments,saved,shares,total_interactions` (+ `navigation`,`replies` for stories; set varies by `media_product_type`) |
| `instagram_get_audience_demographics` | RO | `GET /{ig-id}/insights?metric=follower_demographics,engaged_audience_demographics&metric_type=total_value&breakdown=age\|gender\|city\|country&timeframe=...` — `timeframe` **required** (`last_14_days\|last_30_days\|last_90_days\|prev_month\|this_month\|this_week`), not `since`/`until`; requires ≥ 100 followers *[verified 2026-07-21]* |
| `instagram_get_online_followers` | RO | `GET /{ig-id}/insights?metric=online_followers&period=lifetime` — data covers the **last 30 days only**; metric alive in the legacy reference but absent from the new docs tree → **deprecation watch-list** *[verified 2026-07-21]* |

## Package `discovery` (profile `all`; **Path B only** *[verified 2026-07-21]*)

Additional gate: the hashtag endpoints require the **"Instagram Public Content
Access"** feature, which may be App-Review-gated even for own-app admins — an M1
empirical probe decides whether this package ships or stays dark (see roadmap).

| Tool | Ann. | Purpose / Graph call |
|---|---|---|
| `instagram_search_hashtag` | RO | `GET /ig_hashtag_search?user_id={ig-id}&q=nofilter` → hashtag ID. Budget: **30 unique hashtags / 7 days** per account — tracked locally and surfaced in results |
| `instagram_get_hashtag_media` | RO | `GET /{hashtag-id}/top_media` or `/recent_media` (`user_id` required; public media only) |
| `instagram_discover_business` | RO | Public profile + media of another business/creator: `GET /{ig-id}?fields=business_discovery.username(<handle>){followers_count,media_count,media{...}}` |

## Package `messaging` (phase 2 — design TBD)

Conversations list, read messages, send reply (24-hour human-agent window rules),
via Messenger Platform endpoints. Deliberately deferred: policy-sensitive
(messaging windows), webhook-dependent for real-time, and the write-safety model
needs its own review. Will ship dark until reviewed.

## Structured output

Tools with stable shapes (`token_status`, `publishing_limit`, container status,
insights) declare `outputSchema` and return `structuredContent` alongside text.
List tools return `{ items, paging: { after?, truncated } }`.

## Tool-count budget

Initial surface: **28 tools** across 6 packages — deliberately compact; every tool
earns its context-window cost. Composites (`post_image`, `post_reel`, `post_story`)
exist because the container flow is a multi-step protocol the model otherwise gets
wrong; the primitive tools remain exposed for advanced control.

Composites cap internal polling at **60 s**. If the container is still processing
at the cap, they return a resumable **in-progress result carrying the container
ID** instead of blocking — guarding against the client-timeout → model-retry →
duplicate-post chain — and `media_publish` is never auto-retried.
