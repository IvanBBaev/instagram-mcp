# instagram-mcp-ai — Instagram MCP Server

<!--
  Badge note: the npm-version, downloads, coverage (Codecov) and Snyk badges go
  live only once the package is published to npm and Codecov is enabled for the
  repo. Until then they render "not found" / "invalid" — that is expected and
  intentional (the block matches the published sibling servicenow-mcp-ai).
-->

| [![npm version](https://img.shields.io/npm/v/instagram-mcp-ai?style=flat-square&logo=npm&logoColor=white&label=npm)](https://www.npmjs.com/package/instagram-mcp-ai) | [![npm downloads](https://img.shields.io/npm/dm/instagram-mcp-ai?style=flat-square&logo=npm&logoColor=white&label=downloads)](https://www.npmjs.com/package/instagram-mcp-ai) | [![node](https://img.shields.io/node/v/instagram-mcp-ai?style=flat-square&logo=nodedotjs&logoColor=white&label=node)](https://www.npmjs.com/package/instagram-mcp-ai) | [![tools](https://img.shields.io/badge/tools-28-blue?style=flat-square)](#tools) | [![License: MIT](https://img.shields.io/npm/l/instagram-mcp-ai?style=flat-square&color=blue&label=license)](LICENSE) |
| :--: | :--: | :--: | :--: | :--: |
| [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/instagram-mcp/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/instagram-mcp/actions/workflows/ci.yml) | [![coverage](https://img.shields.io/codecov/c/github/IvanBBaev/instagram-mcp/main?style=flat-square&logo=codecov&logoColor=white&label=coverage)](https://codecov.io/gh/IvanBBaev/instagram-mcp) | [![last commit](https://img.shields.io/github/last-commit/IvanBBaev/instagram-mcp?style=flat-square&logo=git&logoColor=white&label=last%20commit)](https://github.com/IvanBBaev/instagram-mcp/commits/main) | [![MCP](https://img.shields.io/badge/MCP-server-orange?style=flat-square)](https://modelcontextprotocol.io) | [![Known Vulnerabilities](https://snyk.io/test/npm/instagram-mcp-ai/badge.svg)](https://snyk.io/test/npm/instagram-mcp-ai) |

📖 **[Documentation site →](https://ivanbbaev.github.io/instagram-mcp/)**

A locally-run, TypeScript [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes an Instagram **professional account** (Business/Creator) over
the **official Meta Graph API** (`graph.instagram.com` / `graph.facebook.com`) —
content publishing, media management, comment moderation, insights and discovery,
as safe, well-annotated MCP tools. It talks **only to official Meta endpoints**:
no scraping, no `instagram-private-api`-style clients, no cookie/session reuse. It
ingests media **by public HTTPS URL only**. Credentials live in a local env file
and can be obtained/refreshed with a built-in CLI.

> **Status: implementation complete and tested — not yet published to npm.** The
> read path (account, media, insights), the write path (content publishing,
> comment moderation) and discovery are all implemented, unit-tested and CI-green
> across Linux/macOS/Windows on Node 22 and 24. The published npm package and the
> live badges follow once `npm publish` runs. The documents under [`docs/`](docs/)
> are the source of truth for the design.

**Contents:** [What it does](#what-it-does) · [Requirements](#requirements) ·
[Quickstart](#quickstart) · [Setup](#setup) ·
[Configure credentials](#configure-credentials) · [Run / debug](#run--debug) ·
[Write safety](#write-safety) · [Package profiles](#package-profiles) ·
[Tools](#tools) · [Configuration](#configuration) ·
[Security notes](#security-notes) ·
[Project documentation](#project-documentation) · [Support](#support)

_Built and maintained in my own time — a
[GitHub Sponsors](https://github.com/sponsors/IvanBBaev) tip keeps it going._

## What it does

The server exposes an Instagram professional account through **28 MCP tools**
grouped into six packages:

- **Content publishing** — feed images, 2–10 image carousels, Reels and Stories
  via the container → publish flow, plus one-call helpers (`instagram_post_image`
  / `_reel` / `_story`) and publishing-limit reporting.
- **Media management** — list/read own media (including album children) and
  toggle whether a post accepts comments.
- **Comment moderation** — list threads, reply, hide/unhide (reversible,
  preferred over delete) and delete; read tagged media.
- **Insights** — account and media metrics on the post-2025 `views`-based metric
  set, audience demographics and online-follower distribution.
- **Discovery** — hashtag search, hashtag top/recent media and public
  business/competitor discovery. *(Path B / `fb-login` only — see below.)*
- **Account** — profile, linked Facebook Pages / IG accounts, and a token-status
  report (auth path, expiry, days-left, refresh warning).

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`) so clients apply the right confirmation UX, and every mutation
passes through a preview-by-default [write gate](#write-safety). All Graph URLs
are pinned to a single API version (`v25.0`).

### Why build it

The Meta **ads** niche is saturated — including Meta's own hosted Ads MCP
(`mcp.facebook.com/ads`, ads-only) — while the **organic Instagram** side has
only thin coverage. The existing TypeScript servers ship without tool
annotations, structured output, token security or tests. A well-engineered
TypeScript Instagram MCP server with proper token security, rate-limit
compliance and honest Graph semantics fills that gap. It is a sibling of the
planned `facebook-mcp` (Pages) server and shares the layered architecture of the
production `servicenow-mcp-ai`.

> **The #1 constraint to know up front:** Instagram ingests media **by public
> URL** — `image_url` / `video_url` must be reachable by Meta's servers.
> Publishing a local file means hosting it somewhere public first; v1 accepts
> URLs only.

## Requirements

- **Node.js ≥ 22** (Node 20 is EOL). Enforced by `engines` and a runtime guard
  in the CLI launcher with a clear message. CI runs the full gate on Node **22
  and 24** across Linux, macOS and Windows.

## Quickstart

Register the server with an MCP client (Claude Desktop, VS Code Chat, the
Inspector…) by pointing the command at `npx` and supplying one auth path's
credentials:

```jsonc
// claude_desktop_config.json / .mcp.json
{
  "mcpServers": {
    "instagram": {
      "command": "npx",
      "args": ["-y", "instagram-mcp-ai"],
      "env": {
        "IG_ACCESS_TOKEN": "<long-lived ig-login token>",
        "IG_ACCOUNT_ID": "<ig professional account id>"
      }
    }
  }
}
```

That is Path A (Instagram Login). For the token, the simplest path is the
built-in `login` command — see [Configure credentials](#configure-credentials).
Everything else is optional tuning; the full list is under
[Configuration](#configuration).

## Setup

From source (for development):

```bash
npm install
npm run build
```

Or run the published package directly, without cloning:

```bash
npx instagram-mcp-ai
```

Credentials are read from `~/.config/instagram-mcp-ai/.env` (XDG), the project
`.env`, or real environment variables (which always win) — see below.

## Configure credentials

All settings are environment variables with the uniform `IG_` prefix; the
canonical copy with inline comments is [`.env.example`](.env.example). Choose
**exactly one** of the two Meta auth paths (set `IG_AUTH_MODE` only when both
tokens are present):

| Path | `IG_AUTH_MODE` | Token var | Host | Notes |
| ---- | -------------- | --------- | ---- | ----- |
| **A — Instagram Login** | `ig-login` | `IG_ACCESS_TOKEN` | `graph.instagram.com` | Token-only; `appsecret_proof` is **not** supported and never sent. The simplest path. |
| **B — Facebook Login** | `fb-login` | `IG_FB_ACCESS_TOKEN` | `graph.facebook.com` | Page/system-user token; requests carry an `appsecret_proof` HMAC (needs `IG_APP_SECRET`). **Required for the discovery tools** (hashtag search, business discovery). |

When only one token is set the mode is auto-detected. Discovery tools are
capability-filtered to Path B, so on Path A they are not registered at all.

### `login` — obtain a long-lived token

A live login needs a **registered Meta app** (an app id/secret and a redirect
URI whitelisted in the app's OAuth settings). With those in place:

```bash
# Path A (Instagram Login)
IG_APP_ID=... IG_APP_SECRET=... npx instagram-mcp-ai login --path ig

# Path B (Facebook Login)
IG_APP_ID=... IG_APP_SECRET=... npx instagram-mcp-ai login --path fb
```

It opens the browser, captures the loopback redirect, exchanges the code for a
long-lived (~60-day) token and writes it to the env file (chmod `0600` on POSIX).
No token or secret is ever printed. Run `npx instagram-mcp-ai login --help` for
all options (`--profile`, `--account-id`, `--scopes`, `--redirect-uri`). See
[docs/auth.md](docs/auth.md) for the full token model, scopes and app setup.

## Run / debug

The published `instagram-mcp-ai` binary (run it directly or via `npx`) has three
subcommands; with no subcommand it starts the MCP server on the configured
transport. All connection settings come from environment variables / the env file.

| Command | What it does |
| ------- | ------------ |
| `instagram-mcp-ai` | Starts the MCP server. Transport is `stdio` (default) or `http`, chosen by `IG_TRANSPORT`. |
| `instagram-mcp-ai login --path <ig\|fb>` | One-time browser OAuth to obtain and persist a long-lived token (see above). |
| `instagram-mcp-ai doctor` | Read-only health check for the active profile: config, token/auth, and one reachability GET. Exit `0` healthy, non-zero on failure. |
| `instagram-mcp-ai refresh` | Refresh the active profile's long-lived token and write it back (`ig_refresh_token` on Path A, `fb_exchange_token` on Path B). |

- **stdio** (default) — for local MCP clients. `stdout` is the protocol channel;
  all diagnostics go to `stderr`.
- **Streamable HTTP** — opt in with `IG_TRANSPORT=http`. Loopback-bound
  (`127.0.0.1:3000` by default via `IG_HTTP_HOST` / `IG_PORT`); set
  `IG_HTTP_TOKEN` to require an `Authorization: Bearer <token>` header
  (constant-time compared).

## Write safety

Every mutating tool passes through a single **write gate** (design gate D3):

- **Preview by default.** A write returns a non-mutating preview describing
  exactly what would change; nothing is sent to Meta.
- **Apply explicitly.** Pass `apply: true` on the call, or set
  `IG_WRITE_MODE=apply` for standing consent, to actually perform the write.
- **Destructive ops are double-gated.** Irreversible actions (e.g.
  `instagram_delete_comment`) additionally require `IG_ALLOW_DESTRUCTIVE=true`.
- **Journaled.** Every applied write is appended to a local, append-only JSONL
  journal (`~/.local/state/instagram-mcp-ai/writes.jsonl`, or `IG_WRITE_JOURNAL`)
  for auditing — best-effort, so a broken journal never fails an authorized write.

## Package profiles

Tools are grouped into packages so you can expose only what a client needs (fewer
tools keep the model focused). Set `IG_TOOL_PACKAGES` to a profile name or an
explicit comma list of packages:

| Profile | `IG_TOOL_PACKAGES=…` | Packages | Tools |
| ------- | -------------------- | -------- | :---: |
| `core` (default) | `account, media, publishing, comments, insights` | the everyday read + publish + moderate set | 25 |
| `reader` | `account, media, insights, comments, discovery` | read, insights and discovery (Path B for discovery) | 21 |
| `publisher` | `account, media, publishing, comments` | publish and moderate | 21 |
| `all` | every package | the full surface | 28 |

The six packages are `account`, `media`, `insights`, `publishing`, `comments`
and `discovery`. Two more knobs refine a selection: `IG_PACKAGES_DENY` removes
packages after the profile resolves, and `IG_PACKAGES_READONLY` forces a
package's write tools off (its read tools stay). Auth-path capability filtering
runs on top — a `reader` profile on Path A drops the three `fb-login`-only
discovery tools.

## Tools

The full v1 tool surface, generated from the tool registry — do not edit the
table by hand; run `npm run gen:readme`. **Auth paths** is the login path a tool
is valid for (`both` when unrestricted); **Access** is `Read` for read-only tools
and `Write` for mutating ones (writes preview by default — see
[Write safety](#write-safety)).

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

## Configuration

All settings are environment variables with the uniform `IG_` prefix; the
canonical copy with inline comments is [`.env.example`](.env.example), and the
table below is generated from it — do not edit it by hand; run
`npm run gen:readme`. Real environment variables always take precedence over the
file. Writes preview by default; set `IG_WRITE_MODE=apply` (and
`IG_ALLOW_DESTRUCTIVE=true` for deletes) to perform them.

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

## Project identity

| Item | Value |
| ---- | ----- |
| npm package | [`instagram-mcp-ai`](https://www.npmjs.com/package/instagram-mcp-ai) *(name reserved; not yet published)* |
| GitHub repository | [`IvanBBaev/instagram-mcp`](https://github.com/IvanBBaev/instagram-mcp) |
| MCP registry name | `io.github.IvanBBaev/instagram-mcp-ai` |
| Language / runtime | TypeScript (ESM), Node.js ≥ 22 |
| MCP SDK | `@modelcontextprotocol/sdk` v1 (`registerTool` + zod) |
| Transports | stdio (default), Streamable HTTP (opt-in, loopback-bound) |
| Env var prefix | `IG_` |
| Graph API version | pinned `v25.0` in every URL |
| License | MIT |

> **Note on names:** the npm package and MCP registry entry use `instagram-mcp-ai`
> (the unscoped `instagram-mcp` was already squatted on npm); the GitHub
> repository and the local working folder are `instagram-mcp`. The difference is
> cosmetic and does not affect the build or runtime.

## Non-goals

- **Ads / Marketing API** — covered by Meta's official Ads MCP; out of scope permanently.
- **Unofficial APIs** — no `instagram-private-api`-style clients, no cookie/session reuse,
  no scraping. Official Graph API only.
- **Consumer (personal) accounts** — the Instagram Platform API only serves
  professional (Business/Creator) accounts; this server does not work around that.
- **Multi-tenant SaaS hosting** — this is a personal, locally-run server (single
  operator, one or few accounts). Streamable HTTP stays loopback-bound.

## Security notes

- The env file is git-ignored and written **owner-only (`0600`)** — it holds
  plaintext tokens/secrets; do not commit real credentials.
- The server uses the stdio transport by default and only logs to `stderr`.
  Access tokens, app secrets and `appsecret_proof` HMACs are masked by a secret
  redactor before anything reaches a log sink; the `login`/`refresh`/`doctor`
  commands never print a token or secret.
- **SSRF guard:** Graph calls are restricted to the two allowlisted hosts
  (`graph.instagram.com`, `graph.facebook.com`) with the API version pinned, so a
  redirected or mistyped host cannot silently receive a token.
- **Media ingestion is URL-only** and by public HTTPS URL — no local files are
  uploaded, so the server never exfiltrates local content.
- Writes are **preview-by-default**, applied writes are journaled, and
  irreversible ops need a second explicit gate (`IG_ALLOW_DESTRUCTIVE`). See
  [Write safety](#write-safety) and [docs/security.md](docs/security.md).

## Project documentation

| Document | Contents |
| -------- | -------- |
| [docs/architecture.md](docs/architecture.md) | Layered architecture, tool registry, transports, config, testing strategy |
| [docs/auth.md](docs/auth.md) | The two Instagram auth paths, token types & lifetimes, scopes, app setup |
| [docs/tools.md](docs/tools.md) | Full tool catalog specification (names, annotations, inputs, Graph calls) |
| [docs/setup-guide.md](docs/setup-guide.md) | End-to-end setup walkthrough |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common failures and fixes |
| [docs/security.md](docs/security.md) | Token storage, redaction, SSRF policy, write safety, supply chain |
| [docs/operations.md](docs/operations.md) | Rate limits, retry/backoff, pagination, error taxonomy, versioning |
| [docs/stability.md](docs/stability.md) | Stability contract and versioning policy |
| [docs/corner-cases.md](docs/corner-cases.md) | Corner-case catalog (`CC-*` IDs) with expected behavior and live-probe register |
| [docs/roadmap.md](docs/roadmap.md) | Implementation roadmap: design gates D1–D3, phases M0–M6 with exit gates |
| [docs/workplan.md](docs/workplan.md) | Parallel work plan: agent-sized tasks, file ownership, dependency graph |
| [docs/release-checklist.md](docs/release-checklist.md) | Pre-publish release checklist |
| [docs/reviews/](docs/reviews/summary.md) | Six role-based senior design reviews — start with the consolidated summary |

The rendered [documentation site](https://ivanbbaev.github.io/instagram-mcp/)
mirrors these documents.

## Support

This project is built and maintained in my own time. If it saves you or your team
time, please consider supporting its continued development — sponsorship directly
funds new tools, bug fixes and keeping pace with Meta's Graph surface.

- **[GitHub Sponsors](https://github.com/sponsors/IvanBBaev)** — one-off or
  recurring, with no platform fee taken out (the preferred option).
- **[Ko-fi](https://ko-fi.com/ivanbbaev)** — quick one-off support; it also
  accepts **PayPal**, so it's the fallback for anyone without a GitHub account.
- **[Donate (Donatree)](https://donatr.ee/ivanbbaev/)** — a no-account donation
  page (card, PayPal and more) for a one-off tip.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/ivanbbaev)
[![Donate via Donatree](https://img.shields.io/badge/Donate-Donatree-22c55e?style=flat-square&logo=liberapay&logoColor=white)](https://donatr.ee/ivanbbaev/)

## Trademark

Instagram and Meta are trademarks of Meta Platforms, Inc. This project is
independent and **not affiliated with or endorsed by Meta**. The marks are used
**only nominatively** — to identify the platform this software interoperates
with. This project is licensed under the [MIT License](LICENSE); that license
covers the source code and grants no rights to use the Instagram or Meta
trademarks.
