# instagram-mcp

**MCP server for the Instagram Platform (Meta Graph API) — design documentation.**

> **Status: design phase.** This repository currently contains only documentation.
> The documents under `docs/` are the source of truth for the upcoming implementation.
> No code exists yet; nothing here is published to npm.

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

## Non-goals

- **Ads / Marketing API** — covered by Meta's official Ads MCP; out of scope permanently.
- **Unofficial APIs** — no `instagram-private-api`-style clients, no cookie/session reuse,
  no scraping. Official Graph API only.
- **Consumer (personal) accounts** — the Instagram Platform API only serves
  professional (Business/Creator) accounts; this server does not work around that.
- **Multi-tenant SaaS hosting** — this is a personal, locally-run server (single
  operator, one or few accounts). Streamable HTTP stays loopback-bound.
