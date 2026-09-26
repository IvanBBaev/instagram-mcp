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
  be sent, to which endpoint, with which side effects — and performs **no write
  request**. A preview does not report publishing-quota impact; read it with
  `instagram_get_publishing_limit`.
- Previews **cannot pre-validate media URLs**: the server never fetches
  user-supplied URLs (SSRF policy — [security.md](security.md)), so reachability
  is only proven when Meta fetches the URL at container creation. The publishing
  tools' input descriptions state this limitation explicitly.
- Applied writes append to a local **write journal** (`IG_WRITE_JOURNAL`; default
  `$XDG_STATE_HOME/instagram-mcp-ai/writes.jsonl`, i.e. `~/.local/state/instagram-mcp-ai/writes.jsonl`
  when `XDG_STATE_HOME` is unset or relative).
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
| `instagram_list_media` | RO | Own media, cursor-paginated: `GET /{ig-id}/media?fields=id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count`. Stories are not on this edge (Meta serves them on `GET /{ig-id}/stories`, which no tool reads), and Meta caps it at the 10K most recent media |
| `instagram_get_media` | RO | Single media by ID, same field set + `children{...}` for carousels. An album whose inline expansion is missing, empty or not a list falls back to `GET /{media-id}/children`; `children` is omitted (never `[]`) when neither lists an item |
| `instagram_set_comments_enabled` | I | Toggle commenting: `POST /{media-id}?comment_enabled=true\|false` |

## Package `publishing`

The Instagram publish flow is **two-phase**: create a container, then publish it.
Media is **ingested by public URL** — Meta's servers fetch `image_url`/`video_url`;
the server never uploads local bytes for images (see design note below).

| Tool | Ann. | Purpose / Graph call |
|---|---|---|
| `instagram_create_media_container` | — | `POST /{ig-id}/media`. Feed image: `image_url` with **no `media_type` param** (`IMAGE` is not a valid value; neither is `VIDEO` — feed video *is* Reels) *[verified 2026-07-21]*. `media_type` = `REELS` / `STORIES` / `CAROUSEL` for the rest; `video_url`, `caption`, `location_id`, `user_tags`, `children` (carousel: 2–10 container IDs), `cover_url`/`thumb_offset` + `share_to_feed` (reels). Returns container ID |
| `instagram_get_container_status` | RO | `GET /{container-id}?fields=status_code,status` → `IN_PROGRESS` / `FINISHED` / `ERROR` / `EXPIRED` / `PUBLISHED`. Video containers must reach `FINISHED` before publish; subcode 2207027 = still processing → keep polling, never re-create |
| `instagram_publish_media` | — | `POST /{ig-id}/media_publish?creation_id={container-id}`. **Never auto-retried** (duplicate-post risk) |
| `instagram_get_publishing_limit` | RO | `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config` — quota total read at **runtime** from `config.quota_total` (Meta docs conflict: 100 vs 50 — never hardcoded) *[verified 2026-07-21]*; carousel = 1 |
| `instagram_post_image` | — | **Convenience composite**: container + poll + publish for a single image/carousel in one call; the preview shows the full plan |
| `instagram_post_reel` | — | Convenience composite for `REELS` (video URL, cover, share_to_feed) |
| `instagram_post_story` | — | Convenience composite for `STORIES` (image or video) |

**Design note — media hosting**: because ingestion is URL-based, publishing a local
file requires a publicly reachable URL. v1 documents this constraint honestly and
accepts only URLs. A later phase may add an opt-in helper that uploads to
**operator-configured** storage (e.g. their S3 bucket); the server will never spin up
tunnels or anonymous hosting. Caption limits (2200 code points, 30 hashtags, 20
@tags), carousel bounds (2–10 children) and well-formed `https://` URLs are refused
before the call is made. Pixel format, byte size, aspect ratio and duration are NOT
checked here — the server never fetches a media URL, so it never sees the bytes; a
clearly non-JPEG extension only warns, and the container is created anyway. Meta
rejects the rest at fetch time, which costs a publishing slot. Meta's own limits, to
size media against before spending one: **JPEG only** for every still image (feed,
story and reel cover; PNG is not supported), ≤ 8 MB, aspect 0.8–1.91; reels 3 s–15
min, **≤ 300 MB**; stories video ≤ 60 s, ≤ 100 MB *[verified 2026-07-21 against
official docs]*.

**Write acknowledgements.** A write Instagram answers with HTTP 200 but an error
envelope (`{ error: { ... } }`) is reported as that Graph error — same kind and
code as the 4xx carrying it — never as a missing id (CC-PUB-53). A carousel is
aborted when any child container comes back without a usable id, before the album
is created; the error lists the child containers already created (CC-PUB-51). An
`ERROR` container's `status` detail is quoted and cut to 200 characters in the
error the composites raise (CC-PUB-52): control, format and separator characters
become visible `\u{…}` escapes, `"` and `\` are backslash-escaped, and a cut
detail ends `…"` followed by its full length (CC-DATA-95).

## Package `comments`

| Tool | Ann. | Purpose / Graph call |
|---|---|---|
| `instagram_list_comments` | RO | `GET /{media-id}/comments?fields=id,text,username,timestamp,like_count,replies{...}`, cursor-paginated |
| `instagram_get_comment` | RO | `GET /{comment-id}?fields=...` incl. parent/media context |
| `instagram_reply_to_comment` | — | `POST /{comment-id}/replies?message=...` (threaded reply); an empty or whitespace-only `message` is refused before any call (CC-COM-18) |
| `instagram_create_comment` | — | Top-level comment on own media: `POST /{media-id}/comments?message=...`; an empty or whitespace-only `message` is refused before any call (CC-COM-18) |
| `instagram_hide_comment` | I | `POST /{comment-id}?hide=true` (reversible moderation — preferred over delete) |
| `instagram_unhide_comment` | I | `POST /{comment-id}?hide=false` |
| `instagram_delete_comment` | **D** | `DELETE /{comment-id}` — irreversible; double-gated (apply + `IG_ALLOW_DESTRUCTIVE`) |
| `instagram_list_tagged_media` | RO | Media the account is **tagged in**: `GET /{ig-id}/tags` (both auth paths). Note *[verified 2026-07-21]*: tags ≠ @mentions — pull-based @mention lookup (`mentioned_media`/`mentioned_comment`) is **Path B only**; Path A can only *reply* to mentions (`POST /{ig-id}/mentions`); story @mentions unsupported on Path A |

## Package `insights`

Built on the **post-2025-01-08 metric set** (`views`-centric; `video_views`,
`profile_views` etc. are gone — never referenced).

| Tool | Ann. | Purpose / Graph call |
|---|---|---|
| `instagram_get_account_insights` | RO | `GET /{ig-id}/insights?metric=views,reach,accounts_engaged,total_interactions,likes,comments,shares,saves,replies,follows_and_unfollows,profile_links_taps&period=day&metric_type=total_value&since=&until=` — `metric_type=time_series` is served for `reach` only: it defaults to `metric=reach`, and any other metric with it is refused before a call (CC-INS-25); a `since` after `until` is refused (CC-INS-26) |
| `instagram_get_media_insights` | RO | `GET /{media-id}/insights?metric=views,reach,likes,comments,saved,shares,total_interactions` — the default set, sent for a feed post, a reel and for an absent or unrecognized `media_product_type`; `media_product_type=STORY` defaults to `views,reach,replies,shares,total_interactions,navigation` instead (CC-INS-14) |
| `instagram_get_audience_demographics` | RO | `GET /{ig-id}/insights?metric=follower_demographics,engaged_audience_demographics&period=lifetime&metric_type=total_value&breakdown=age\|gender\|city\|country&timeframe=...` — `timeframe` **required** (`last_14_days\|last_30_days\|last_90_days\|prev_month\|this_month\|this_week`), not `since`/`until`; `period=lifetime` is always sent, Meta marks it required (CC-INS-27); requires ≥ 100 followers *[verified 2026-07-21]* |
| `instagram_get_online_followers` | RO | `GET /{ig-id}/insights?metric=online_followers&period=lifetime` — data covers the **last 30 days only**; metric alive in the legacy reference but absent from the new docs tree → **deprecation watch-list** *[verified 2026-07-21]* |

## Package `discovery` (profiles `reader` and `all`; **Path B only** *[verified 2026-07-21]*)

Additional gate: the hashtag endpoints require the **"Instagram Public Content
Access"** feature, which may be App-Review-gated even for own-app admins — an M1
empirical probe decides whether this package ships or stays dark (see roadmap).

| Tool | Ann. | Purpose / Graph call |
|---|---|---|
| `instagram_search_hashtag` | RO | `GET /ig_hashtag_search?user_id={ig-id}&q=nofilter` → hashtag ID. Budget: **30 unique hashtags / 7 days** per account — tracked locally and surfaced in results |
| `instagram_get_hashtag_media` | RO | `GET /{hashtag-id}/top_media` or `/recent_media` (`user_id` required; public media only) |
| `instagram_discover_business` | RO | Public profile + media of another business/creator: `GET /{ig-id}?fields=business_discovery.username(<handle>){followers_count,media_count,media{...}}`. The media edge publishes `mediaPaging`: `truncated: true` with `after` when Instagram returned a media cursor — pass it back as `mediaAfter` (sent as `media.after(<cursor>)`) to read further — and without `after`, plus a `note`, when the cursor is unusable (CC-DATA-116) |

## Package `messaging` (phase 2 — design TBD)

Conversations list, read messages, send reply (24-hour human-agent window rules),
via Messenger Platform endpoints. Deliberately deferred: policy-sensitive
(messaging windows), webhook-dependent for real-time, and the write-safety model
needs its own review. Will ship dark until reviewed.

## Structured output

Every read-only tool (all 17 of them: account, media and comment reads, `token_status`,
`publishing_limit`, container status, insights, discovery) declares `outputSchema` and
returns `structuredContent` alongside text; write tools declare none.
List tools return `{ items, paging: { after?, truncated }, note? }`. `after` is
present only when it is a cursor the caller could actually send back, so
`truncated: true` with no `after` is meaningful rather than a gap; `note` sits
beside `paging`, not inside it, and appears only when the stop has a cause the
caller cannot read off `paging` — a listing cut short by an unusable cursor, for
instance. That holds on the default single-page read too: a page that ends on a
cursor Instagram sent but that cannot be sent back reports `truncated: true` with
that note, never a complete listing (CC-DATA-11). A page Instagram answers with no
readable listing (a `data` that is not a list, or a body that is not an object) is
likewise `truncated: true` with a note, never an empty complete listing; `after`,
when present, re-reads that page (CC-DATA-69). The end of a listing is the page
Instagram sends without `paging.next`: that page publishes no `after` even though
Instagram still sends cursors on it, so a read that ends there is complete, and a
page that has `paging.next` but no cursor resumes from the `after` inside that URL,
or reports `truncated: true` with the unusable-cursor note when the URL has none
or names `after` more than once (CC-DATA-115, CC-DATA-117).

Nothing the server leaves out is left out silently. An item Instagram returned
without a usable id is counted in `omittedWithoutId` with a `note` (lists,
`search_hashtag`, a carousel's `children` in `get_media` — CC-DATA-60 — and
comments and replies at any depth in `list_comments` and `get_comment` — CC-COM-16);
a `null` or non-object entry counts the same way, including in `search_hashtag`
(CC-DATA-62) and `list_linked_accounts` (CC-DATA-64). A `get_account` profile Meta
returns without an id publishes the configured account id it was read by, or fails
as an `upstream` error on a `me` read (CC-DATA-65); a `discover_business` answer with
no `business_discovery` profile in it publishes only a `note` saying so, never an empty
profile (CC-DATA-79). `get_container_status`, `get_media` and `get_comment` read one
object by the id they are given, so an answer without a usable id publishes that requested
id rather than failing the call (CC-DATA-76, CC-DATA-77, CC-DATA-78); a body that
is not an object at all fails `get_comment`, `get_account`, `token_status` and the four
insights tools with an `upstream` error instead (CC-DATA-83, CC-DATA-84, CC-DATA-85,
CC-DATA-86). A `data` that is
present but not a list (`null` included) is said in `note`, never passed off as an empty
result: `get_hashtag_media` then reports `truncated: true`, reads nothing from that page
and publishes as `after` only the cursor that requested it, never the one the page
advertised (CC-DATA-80); `search_hashtag` returns no ids (CC-DATA-81); an insights
tool publishes no metrics and names every requested one in `missingMetrics` with a note
saying the list was unreadable, not that the metrics had no data (CC-INS-22); a
`discover_business` media edge that is not a list is left out with a `note`
(CC-DATA-82) — a falsy one, or an edge that is not an object, included; an edge without
`data`, or `null`, is Meta declining to disclose it and stays silent (CC-DATA-87).
A comment or tagged-media field of the wrong type is dropped from its record
rather than failing the call — `get_comment`'s nested `media` context included
(CC-COM-19). A
comment whose inline reply thread Instagram cut at its first page carries
`repliesTruncated: true` (CC-COM-15). An insights row that lost unreadable
intervals says how many in `omittedValues` (CC-INS-18) — an interval whose `value` is
neither a finite number nor an object is one of them (CC-INS-19), as is one whose `value`
map holds a member that is not a finite number (CC-INS-23), and a `values` that is not
a list at all counts as one (CC-INS-24). A `total_value` measurement
that is unreadable — a non-numeric `value`, a breakdown result without a finite `value` and
string `dimension_values`, or a breakdown with no `results` list — is left out and counted
in `omittedTotalValues` (CC-INS-20, CC-INS-21). A requested metric
with no row at all is named in `missingMetrics` (CC-INS-17).

Upstream strings are published in `structuredContent` exactly as Meta sent them
(inside the `[UNTRUSTED …]` fence where the field is free text). The text block is the
JSON of the same value with every control, format (bidi, zero-width, tag) and
line/paragraph-separator character written as a `\uXXXX` escape, so it parses back to
`structuredContent` but carries nothing invisible and cannot break a line
(CC-DATA-102, CC-DATA-103; [security.md](security.md) §7).

The text block is compact JSON by default. With `IG_PRETTY_JSON=true` every tool —
reads, applied writes, and the write gate's own preview, destructive-block and refusal
results — renders it at a two-space indent instead; `structuredContent` is the same
either way (CC-DATA-30).

`token_status` reads a Path-B `data_access_expires_at` of `0` the way it reads
`expires_at: 0`: as "no expiry", not as the 1970 epoch. `dataAccessExpiresAt` is then
absent, exactly as when Meta leaves the field out, and no warning is raised
(CC-DATA-113). A window that has already closed keeps its `dataAccessExpiresAt` and adds
its own sentence to `warning` — the token can still be valid while every data read
fails — beside any token-expiry warning, never instead of it (CC-AUTH-77).

A failed call is `isError: true` with one text line and **no** `structuredContent`:
`Instagram error (<kind>): <message>`, followed by ` (code N)`, ` (subcode M)` or
` (code N, subcode M)` when Graph supplied them. `kind` is one of `auth`, `permission`,
`rate_limit`, `validation`, `upstream`; anything else renders as `Unexpected error`.
The envelope is text-only on purpose: the MCP SDK client validates any
`structuredContent` against the tool's `outputSchema` even on an error result, so an
`{ error }` object would turn every typed error into a `-32602` schema rejection
(CC-DATA-61).

## Tool-count budget

Initial surface: **28 tools** across 6 packages — deliberately compact; every tool
earns its context-window cost. Composites (`post_image`, `post_reel`, `post_story`)
exist because the container flow is a multi-step protocol the model otherwise gets
wrong; the primitive tools remain exposed for advanced control.

Composites cap internal polling at **60 s**. If the container is still processing
at the cap, they return a resumable **in-progress result carrying the container
ID** instead of blocking — guarding against the client-timeout → model-retry →
duplicate-post chain — and `media_publish` is never auto-retried.
