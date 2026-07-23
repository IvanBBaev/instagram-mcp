# instagram-mcp

**MCP server for the Instagram Platform (Meta Graph API) — design documentation.**

> **Status: implementation in progress.** The read path (account, media, insights)
> and the write path (content publishing, comment moderation) are implemented and
> tested; discovery ships behind the `reader` package profile. The documents under
> `docs/` remain the source of truth for the design. Not yet published to npm.

## What this will be

A locally-run, TypeScript **Model Context Protocol (MCP) server** that exposes
Instagram *professional account* (Business/Creator) operations as safe, well-annotated
MCP tools:

- **Content publishing** — feed images, carousels, Reels, Stories (container → publish flow)
- **Media management** — list/read own media, toggle comments
- **Comment moderation** — list, reply, hide/unhide, delete
- **Insights** — account and media metrics (post-2025 `views`-based metric set)
- **Discovery** — hashtag search, business discovery (public competitor profiles)
- **Messaging** *(later phase)* — Instagram DMs via the Messenger Platform

It talks **only to official Meta endpoints** (`graph.instagram.com`,
`graph.facebook.com`). No private/unofficial Instagram APIs, no scraping, no
credential automation against the Instagram app or website.

## Tools

The full v1 tool surface, generated from the tool registry — do not edit the
table by hand; run `npm run gen:readme`. **Auth paths** is the login path a tool
is valid for (`both` when unrestricted); **Access** is `Read` for read-only tools
and `Write` for mutating ones (writes preview by default — see Configuration).

<!-- BEGIN AUTOGEN:tools -->
| Tool | Package | Auth paths | Access | Summary |
| --- | --- | --- | --- | --- |
| `instagram_get_account` | account | both | Read | Fetch the profile of the operated Instagram professional account: username, display name, biography, website, profile-picture URL, and follower / following / media counts. |
| `instagram_list_linked_accounts` | account | fb-login | Read | Enumerate the Facebook Pages this token can act on and the Instagram business account linked to each (GET /me/accounts). |
| `instagram_token_status` | account | both | Read | Report the active credential: auth path (A = ig-login / B = fb-login), whether a token is configured, the resolved account ID, and — on Path B, via debug_token — validity, granted scopes, absolute expiry and days-left (with a refresh warning as the threshold nears). |
| `instagram_get_media` | media | both | Read | Fetch a single media object by id, including its carousel children (album items) under `children`. |
| `instagram_list_media` | media | both | Read | List the operated account's own media (feed posts, reels, stories, albums), newest first, cursor-paginated. |
| `instagram_set_comments_enabled` | media | both | Write | Toggle whether a media object accepts new comments (POST /{media-id}?comment_enabled=true\|false). |
| `instagram_get_account_insights` | insights | both | Read | Account-level insights for the operated Instagram professional account (GET /{ig-id}/insights). |
| `instagram_get_audience_demographics` | insights | both | Read | Follower / engaged-audience demographics for the operated account (GET /{ig-id}/insights with metric_type=total_value). |
| `instagram_get_media_insights` | insights | both | Read | Insights for a single media object (GET /{media-id}/insights). |
| `instagram_get_online_followers` | insights | both | Read | Hourly distribution of when the account's followers are online (GET /{ig-id}/insights?metric=online_followers&amp;period=lifetime). |
| `instagram_create_media_container` | publishing | both | Write | Phase 1 of publishing: create a media container that Instagram ingests from a public HTTPS URL. |
| `instagram_get_container_status` | publishing | both | Read | Read a media container's processing state: status_code is IN_PROGRESS, FINISHED, ERROR, EXPIRED, or PUBLISHED. |
| `instagram_get_publishing_limit` | publishing | both | Read | Report the account's content-publishing usage against its rolling-window quota. |
| `instagram_post_image` | publishing | both | Write | Publish a single feed image, or a 2–10 image carousel, in one call: create the container(s), wait for processing, then publish. |
| `instagram_post_reel` | publishing | both | Write | Publish a reel in one call: create the REELS container, wait for processing (reels can take a while), then publish. |
| `instagram_post_story` | publishing | both | Write | Publish a photo or video story in one call: create the STORIES container, wait for processing, then publish. |
| `instagram_publish_media` | publishing | both | Write | Phase 2 of publishing: publish a media container that has finished processing, returning the new media id. |
| `instagram_create_comment` | comments | both | Write | Post a new top-level comment on a media object (POST /{media-id}/comments). |
| `instagram_delete_comment` | comments | both | Write | Permanently delete a comment (DELETE /{comment-id}). |
| `instagram_get_comment` | comments | both | Read | Fetch a single comment by id, including its moderation state (hidden), parent/media context, and inline replies. |
| `instagram_hide_comment` | comments | both | Write | Hide a comment (POST /{comment-id}?hide=true) — reversible moderation, preferred over delete. |
| `instagram_list_comments` | comments | both | Read | List the top-level comments on a media object, newest first, cursor-paginated, with threaded replies expanded inline under `replies`. |
| `instagram_list_tagged_media` | comments | both | Read | List media the operated account has been TAGGED IN (the /tags edge), newest first, cursor-paginated. |
| `instagram_reply_to_comment` | comments | both | Write | Post a threaded reply under an existing comment (POST /{comment-id}/replies). |
| `instagram_unhide_comment` | comments | both | Write | Unhide a previously hidden comment (POST /{comment-id}?hide=false). |
| `instagram_discover_business` | discovery | fb-login | Read | Fetch another business/creator's PUBLIC profile and recent media by handle via GET /{ig-id}?fields=business_discovery.username(&lt;handle&gt;){followers_count,media_count,media{...}}. |
| `instagram_get_hashtag_media` | discovery | fb-login | Read | List PUBLIC media under a hashtag id via GET /{hashtag-id}/top_media or /{hashtag-id}/recent_media (choose via `edge`), which require the operated account's id as user_id. |
| `instagram_search_hashtag` | discovery | fb-login | Read | Resolve a hashtag name to its Instagram hashtag id(s) via GET /ig_hashtag_search?user_id={ig-id}&amp;q=&lt;hashtag&gt; (the returned id feeds instagram_get_hashtag_media). |
<!-- END AUTOGEN:tools -->

## Why build it

Per the ecosystem research (verified 2026-07-21): the Meta **ads** niche is
saturated — including Meta's own hosted Ads MCP (`mcp.facebook.com/ads`, ads-only) —
while the **organic Instagram** side has only thin coverage. The existing TypeScript
servers (`@mikusnuz/meta-mcp`, stale since 2026-03; `@mcpware/instagram-mcp`) ship
without tool annotations, structured output, token security, or tests. A
**well-engineered TypeScript Instagram MCP server** with npm distribution, proper
token security, rate-limit compliance, and honest Graph semantics is still missing.
That is the niche this project targets,
as a sibling of the planned `facebook-mcp` (Pages) server, sharing its architectural
reference: the production `servicenow-mcp-ai` layered design.

## Planned identity

| Item | Value |
|---|---|
| npm package | `instagram-mcp-ai` *(verified available 2026-07-21 — reserve with a stub early; `instagram-mcp` and `instagram-mcp-server` are squatted)* |
| MCP registry name | `io.github.IvanBBaev/instagram-mcp-ai` |
| Language / runtime | TypeScript (ESM), Node.js ≥ 22 (Node 20 is EOL) |
| MCP SDK | `@modelcontextprotocol/sdk` v1 (stable), `registerTool` + zod; v2 migration via codemod when GA |
| Transports | stdio (default), Streamable HTTP (opt-in, loopback-bound) |
| Env var prefix | `IG_` (uniform, from day one) |
| Graph API version | pinned `v25.0` in every URL |
| License | MIT |

## Documentation map

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layered architecture, tool registry, transports, config, testing strategy |
| [docs/auth.md](docs/auth.md) | The two Instagram auth paths, token types & lifetimes, scopes, app setup |
| [docs/tools.md](docs/tools.md) | Full tool catalog specification (names, annotations, inputs, Graph calls) |
| [docs/security.md](docs/security.md) | Token storage, redaction, SSRF policy, write safety, supply chain |
| [docs/operations.md](docs/operations.md) | Rate limits, retry/backoff, pagination, error taxonomy, versioning |
| [docs/corner-cases.md](docs/corner-cases.md) | Corner-case catalog (`CC-*` IDs) with expected behavior and live-probe register |
| [docs/roadmap.md](docs/roadmap.md) | Implementation roadmap: design gates D1–D3, phases M0–M6 with exit gates tied to corner cases |
| [docs/workplan.md](docs/workplan.md) | Parallel work plan: agent-sized tasks (`T-*`), file ownership, dependency graph, integration gates G1–G5 |
| [docs/reviews/](docs/reviews/summary.md) | Six role-based senior design reviews — start with the consolidated summary |

## Quickstart (preview — once implemented)

```jsonc
// claude_desktop_config.json / .mcp.json
{
  "mcpServers": {
    "instagram": {
      "command": "npx",
      "args": ["-y", "instagram-mcp-ai"],
      "env": {
        "IG_ACCESS_TOKEN": "<long-lived token>",
        "IG_ACCOUNT_ID": "<ig professional account id>"
      }
    }
  }
}
```

> **The #1 constraint to know up front:** Instagram ingests media **by public
> URL** — `image_url`/`video_url` must be reachable by Meta's servers. Publishing
> a local file means hosting it somewhere public first; v1 accepts URLs only.

## Configuration

All settings are environment variables with the uniform `IG_` prefix; the
canonical copy with inline comments is [`.env.example`](.env.example), and the
table below is generated from it — do not edit it by hand; run
`npm run gen:readme`. Choose exactly one auth path (set `IG_AUTH_MODE` only when
both tokens are present). Writes preview by default; set `IG_WRITE_MODE=apply`
(and `IG_ALLOW_DESTRUCTIVE=true` for deletes) to perform them.

<!-- BEGIN AUTOGEN:env -->
| Variable | Default | Description |
| --- | --- | --- |
| `IG_AUTH_MODE` |  | ig-login \| fb-login (auto-detected when only one token is set) |
| `IG_ACCESS_TOKEN` |  | Path A long-lived IG-login token (secret) |
| `IG_FB_ACCESS_TOKEN` |  | Path B page/system-user token (secret) |
| `IG_ACCOUNT_ID` |  | IG professional-account ID (skip a lookup / disambiguate) |
| `IG_APP_ID` |  | Meta app id (token exchange/refresh, appsecret_proof, debug_token) |
| `IG_APP_SECRET` |  | Meta app secret (secret) |
| `IG_ENV_FILE` |  | Env-file location override (default: XDG path) |
| `IG_ACTIVE_PROFILE` | `default` | Profile used when a tool call passes no `account` |
| `IG_TOOL_PACKAGES` | `core` | core \| reader \| publisher \| all, or an explicit list |
| `IG_PACKAGES_DENY` |  | Packages to remove after profile resolution |
| `IG_PACKAGES_READONLY` |  | Packages forced read-only |
| `IG_WRITE_MODE` | `preview` | preview \| apply (standing consent for writes) |
| `IG_ALLOW_DESTRUCTIVE` | `false` | Second gate for irreversible ops (delete_comment) |
| `IG_TRANSPORT` | `stdio` | stdio \| http |
| `IG_HTTP_HOST` | `127.0.0.1` |  |
| `IG_PORT` | `3000` |  |
| `IG_HTTP_TOKEN` |  | HTTP bearer token (secret; constant-time compare) |
| `IG_MAX_CONCURRENT` | `4` | Per-host concurrency semaphore |
| `IG_MAX_ITEMS` | `200` | fetchAll hard item cap |
| `IG_REFRESH_AFTER_DAYS` | `45` | Path-A auto-refresh threshold |
| `IG_TIMEOUT_MS` | `30000` | Per-request timeout for Graph calls |
| `IG_LOG_LEVEL` | `info` | debug \| info \| warn \| error |
| `IG_PRETTY_JSON` | `false` | Pretty-print JSON results |
<!-- END AUTOGEN:env -->

## Non-goals

- **Ads / Marketing API** — covered by Meta's official Ads MCP; out of scope permanently.
- **Unofficial APIs** — no `instagram-private-api`-style clients, no cookie/session reuse,
  no scraping. Official Graph API only.
- **Consumer (personal) accounts** — the Instagram Platform API only serves
  professional (Business/Creator) accounts; this server does not work around that.
- **Multi-tenant SaaS hosting** — this is a personal, locally-run server (single
  operator, one or few accounts). Streamable HTTP stays loopback-bound.
