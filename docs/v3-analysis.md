# 3.0 Scoping Analysis

> First pass at scoping the major release after `2.0.0`. Written 2026-10-28,
> when `0.8.0` was on npm, `1.0.0` was still blocked on live credentials and
> owner go-aheads, and 2.0 was being built on `main` from
> [v2-analysis.md](v2-analysis.md). This document is a **recommendation**, not
> a plan of record. It assumes 2.0 ships roughly as v2-analysis §4 and §9
> describe. Nothing here is scheduled until the owner answers §9 here (and §8
> of v2-analysis, which is still open) and the items are moved into the
> roadmap.
>
> Four inputs fed it: a Meta Instagram Platform review (what changed after
> 2026-10-24 and what is announced for 2027–2028), an MCP-specification,
> SDK, competitor and distribution review, a feasibility review of the large
> items 2.0 parked, and a codebase/debt review of `main` at `eac7d36`. Meta
> facts were read from official developers.facebook.com pages on 2026-10-28.
> Anything not confirmed from an official page is marked `[verify]`, as in
> [corner-cases.md](corner-cases.md).

## 1. Summary

- **Meta has a third setup, and new features ship only there.** The Instagram
  Platform docs now describe "Instagram API with Unified Login" as "the
  recommended setup for new integrations" and say "New Instagram API features
  are released only for this setup." It calls `graph.facebook.com` with a
  Business Integration System User token and needs no Facebook Page. Instagram
  Login (Path A) and Facebook Login (Path B) are now described as setups for
  existing integrations. No sunset date is given for either. This is the
  single biggest input to 3.0.
- **Recommended theme for 3.0: local-first, on Meta's current setup.** Add
  Unified Login as a third auth path (headline), move the Graph pin and the
  Node floor before their deadlines, and extend the agent workflow surface
  (MCP skills, multi-account fan-out). Keep every security.md invariant:
  loopback only, single operator, no telemetry.
- **Hosted multi-tenant mode is a separate product, not a version of this
  package.** Every review reached the same conclusion. It would rewrite the
  threat model, needs an OAuth proxy in front of Meta and an ops burden. If
  the owner wants it, it becomes its own repo consuming `core/` as a library.
  3.0 only keeps that door open (§6).
- **Messaging and scheduling stay conditional.** Messaging reads become COND
  on the probe that decides M6 at all. Scheduling is COND as an OS-scheduler
  queue with no daemon.
- **Hard prerequisites.** 1.0 cut, 2.0 shipped, and Lane E run. 3.0 adds a
  third auth path while the first two have never been validated live.

## 2. Starting point (2026-10-28)

| Area | State |
|---|---|
| Release | `0.8.0` on npm. `1.0.0` cut-ready offline. 2.0 additive items landing on `main` ahead of the 1.0 cut. |
| Surface | 34 tools in 6 packages, 4 prompts, 4 resources, server icon. Profiles `core` / `reader` / `publisher` / `all`. |
| Auth | Path A (Instagram Login, `graph.instagram.com`) and Path B (Facebook Login, `graph.facebook.com`). Multi-account via `IG_PROFILE_<NAME>_*` and a per-call `account` argument. |
| Protocol | MCP TS SDK `^2.3.1` (2.4.0 on npm since 2026-10-23). The 2026-07-28 conformance branch (`feat/mcp-conformance`) moves D3 onto `input_required`. |
| Graph | Pinned to `v25.0`. |
| Runtime | `engines >=22`, CI on Node 22 and 24. |
| Quality | 2715 tests, 100 % coverage. Tests are 81k lines, 3.6× the source. corner-cases.md holds 653 IDs and 1990 pinned citation sites. |
| Size | 22.4k source lines, about 47 % comments or blank. |
| Live validation | **None, ever.** |

## 3. External changes: forced versus optional

### 3.1 Forced, with a date

| Date | Change | Impact |
|---|---|---|
| 2027-04-30 | Node 22 end of life | Raise `engines` to `>=24` (supported to 2028-04-30). A raised floor is **major**, so it belongs in 3.0. |
| ≥ 2027-07-28 | MCP: earliest removal of the features deprecated in 2026-07-28 (roots, sampling, logging, DCR, HTTP+SSE) | None used. The 2025-11-25 `elicitInput` fallback for D3 can be dropped once 2025-11-25 clients fade, not before. |
| 2028-07-29 | Graph v25.0 end of life (official versions table) | Move the pin. v26 has no Instagram breaks found. Do it in 2.x if stability.md classifies version moves as minor, otherwise in 3.0. |

No Instagram-specific deprecation of metrics, fields or permissions is
announced for 2027–2028.

### 3.2 Strategic, no date

- **Unified Login (Path C).** See §1. "Existing integrations" wording for
  Paths A and B suggests a sunset may come. Watch the changelog and the
  migration guide (not readable on 2026-10-28, `[verify]`).
- **MCP spec direction** (roadmap updated 2026-08-22, no date for the next
  revision): Tasks moving into core, server-initiated events, a single HTTP
  binding also spoken over stdio, a redesign of the `tools/call` result shape
  (`content` vs `structuredContent`), and agent identity (DPoP, workload
  identity, enterprise-managed auth). The result-shape redesign is the one that
  would force a rewrite of `src/mcp/result.ts` and `src/mcp/registry.ts`.
- **Distribution.** The Claude Connectors Directory accepts only remote HTTPS
  servers and no longer accepts local MCPB listings. A local server is listed
  through a **plugin**. Every tool needs a `title` and a read-only or
  destructive hint, and the listing needs a privacy policy.

## 4. Candidate scope

Verdicts and effort classes as in v2-analysis §4. XL means a separate project.

### 4.1 Platform features (Meta)

| Candidate | Path | Effort | Verdict | Notes |
|---|---|---|---|---|
| **Path C: Unified Login** (system-user token, Facebook Login for Business config flow, no Page lookup) | C | L | **GO — headline** | Host stays `graph.facebook.com`, so the allowlist does not change. Touches `src/cli/login*`, `src/core/auth.ts`, `src/core/token-shapes.ts`, doctor and scopes. `[verify]`: how the IG user id is resolved without a Page, whether system-user tokens expire, and which features (hashtag search, discovery, insights) work on C. Needs a live app before it can leave `[verify]`. |
| Graph pin v25 → v26 or later | all | S | GO | Forced by 2028-07-29. The version after v26 is not yet on the versions table `[verify]`. |
| Collaboration invites and collaborators on publish | B (A `[verify]`) | S–M | COND | Carried from 2.0. The overview says collaborators are Facebook Login for Business only, which contradicts the edge reference. |
| Collaborative media list and search | B | S | COND | Carried from 2.0. Official reference confirms B only. |
| Branded content / paid partnership on publish | B (C `[verify]`) | S | COND | The publishing guide now says Facebook Login only. Optional input, only on an operator ask. |
| Resumable upload (`rupload.facebook.com`) | B (C?) | M | COND | GO only if Path C lands and the 2.0 upload helper does not cover the case. Adds an allowlisted host. |
| Audio API (`/ig_audio`) | B | S | DEFER | Facebook Login apps only. No operator ask. |
| `enable_fb_login` OAuth parameter in the login CLI | A | S | GO | Re-added 2026-02-06 after a 2025 deprecation `[verify]`. |
| Likes | A+B | S | DEFER | Unchanged since 2.0. |
| `connected_threads_user`, `live_media`, `upcoming_events` | B | S | DEFER | Low operator value. `upcoming_events` reference did not render `[verify]`. |
| Creator Marketplace discovery | B | M | DEFER | Brand-side, off-mission for an operator tool. |
| Threads cross-posting | separate API | L | NO-GO here | Different host, product and permissions. Threads is a gap against competitors, but it belongs in a sibling `threads-mcp`, not this package. |
| Partnership ads, product tagging, boosting | B | M–L | NO-GO | Ads and commerce territory. Meta is sunsetting checkout. Real ad spend does not fit the D3 safety model. |
| Native scheduling | — | — | NO-GO | Graph still has none (see §4.3 for the local emulation). |

### 4.2 Protocol features (MCP)

| Candidate | Effort | Verdict | Notes |
|---|---|---|---|
| SDK 2.4.x bump | S | GO | Audit our schemas for the 2.4 behaviour changes: `x-mcp-header` on a number parameter is rejected, `.meta({id})` results are no longer wrapped, Ajv rejects invalid `$id`/`$ref` URI schemes. Can land in 2.x. |
| Skills extension (SEP-2640, `skill://`) | S–M | GO | Final, and SDK 2.4 ships `loadSkills`. Complements the 2.0 prompts with longer workflows. |
| Tasks into core, server-initiated events | S–M | COND | Follows the 2.0 tasks work once the spec lands it. Events could replace webhooks for some use cases without an inbound endpoint. |
| Tool risk metadata (SEP-2793), async approval (SEP-2848) | S | COND | A natural fit for the D3 gate and `IG_ALLOW_DESTRUCTIVE`, if accepted. |
| `tools/call` result-shape redesign | M | DEFER (watch) | Forced once it lands. Nothing to build yet. |
| HTTP-over-stdio single binding | M | DEFER | The SDK should absorb it. |
| MCP Apps preview UI | L | COND | Of the clients that render Apps, only Claude Desktop and Cursor reach a local stdio server `[verify]`. The rest need remote servers. The preview must stay complete as text. |
| Progressive discovery, scoped tool lists | M | DEFER | Experimental. Tool packages already cover the need. |
| DPoP, workload identity, enterprise-managed auth | L | NO-GO unless hosted | Remote, authorization-server-backed servers only. |

### 4.3 Large items parked by 2.0

| Candidate | Effort | Verdict | Notes |
|---|---|---|---|
| Multi-account fan-out (one report across profiles, per-profile deny lists or write gates) | S–M | GO | Multi-account already ships. This is an extension. Keep "multi-account" (one operator, many accounts) and "multi-tenant" (many operators) as separate terms. |
| M6 Messaging, pull-only reads | M | COND | Only if messaging probe 1 answers NO (sends work without a webhook subscription) and messaging.md §7 conditions 2–6 hold. Rewrites the security.md §5 claim that no third-party data transits the server. Sends need a separate review (another L). |
| Scheduling as a local queue plus an `instagram-mcp-ai publish-due` command run by the OS scheduler (launchd, cron, systemd timer) | M | COND | No daemon, no new secret, loopback intact. Needs an owner decision that confirmation at enqueue time counts as the D3 human confirmation, with a TTL and a re-check of `IG_ALLOW_DESTRUCTIVE` at fire time. The journal becomes the durable queue. A daemon variant stays NO-GO. |
| Webhook receiver | L | NO-GO here | Needs a public inbound endpoint. security.md §3 refuses non-loopback binds outright. Belongs to the hosted product. |
| Hosted multi-tenant remote server | XL | DEFER as a version item | A separate product decision and repo (§7). Meta has no DCR, CIMD or RFC 8414 metadata `[verify]`, so a remote server needs its own OAuth proxy in front of Meta, plus Advanced Access App Review and Business Verification. |

### 4.4 Distribution

| Candidate | Effort | Verdict | Notes |
|---|---|---|---|
| Plugin listing in the Claude directory | S | GO | The realistic Claude listing path for a local server. Check that every tool has a `title` and a hint, and add a privacy-policy section and the `privacy_policies` manifest field. |
| Keep `server.json` current with the registry schema | S | GO | The schema version and Server Card alignment are `[verify]`. |
| Connectors Directory listing | XL | Hosted only | Requires a remote HTTPS server with OAuth. |

## 5. Breaking-change batch (major-only)

3.0 should carry whatever the 2.0 batch (v2-analysis §5) does not settle, plus:

| Item | Today | 3.0 proposal |
|---|---|---|
| Node floor | `engines >=22`, `MIN_NODE_MAJOR = 22` | `>=24`. CI matrix 24 and 26. |
| Auth path naming | Two values, `ig-login` and `fb-login` | Add Path C. Decide whether A and B get deprecation warnings in 3.x, following Meta's wording. |
| Removals warned in 2.x | `IG_PORT`, one auth spelling, non-`[A-Z0-9_]` profile names | Remove in 2.0 if 1.x warned long enough, otherwise in 3.0. |
| New narrowing candidates from 2.0 work | Accepted | Story `link_clicks` gated to Path B, `media_audio_type` as a closed enum, non-negative integer check on `like_count`/`comments_count`. Each needs a live probe first. |
| `instagram_manage_contents` in fb-login default scopes | In the defaults since `05ace6b` | Owner question still open (WORKLOG 2026-10-28). If it becomes opt-in after 1.0, that is a narrowing. |
| 2025-11-25 elicitation fallback | Kept for old clients | Remove no earlier than the first spec revision on or after 2027-07-28. |

## 6. Architecture work

The `ToolContext` seam in `src/mcp/define.ts` (request, settings, profile,
clock, log) is sound. Two kinds of work follow from it.

**Hygiene** (cheap, not blocking):

| Item | Why | Effort |
|---|---|---|
| Split `src/tools/comments.ts` into read and write tools | 12 tools and two concerns, 819 code lines. Messaging would add a sibling surface. | M |
| Split `src/tools/publishing.ts` into container tools, composites and delete | 751 code lines across 8 tools after the `publish-flow` split. Tasks land here. | M |
| Split `src/api/insights.ts` into a metric catalogue and a fetch module | Lines 56–560 are tables and validation and grow with every Meta metric change. | S |
| Freeze the corner-case catalogue: archive closed rows, replace the exact citation count with a "resolves" check, drop the hand-kept tallies in the header | Every change edits the count, and parallel lanes collide on it (`2186adc` only reconciled the count). | M |
| Fast lane for docs-only changes, sharded `node --test` | 81k test lines. | S–M |
| TypeScript 6/7 and `typescript-eslint` compatibility | Scheduled, low risk. | S |

Leave `registry.ts`, `http.ts`, `media.ts`, `log.ts`, `transport.ts` and
`write-mode.ts` alone. They are single-concern and long mainly because of
rationale comments.

**Keep the hosted door open** (needed only if theme B in §7 is ever chosen,
but cheap to do while touching auth for Path C):

| Item | Where | Effort |
|---|---|---|
| A credential-provider port instead of raw tokens loaded once at startup (rotation without restart, a non-file backend) | `src/index.ts` `loadProfiles`, `src/core/config.ts`, `src/core/types.ts`, `src/core/refresh.ts` | L |
| Stop mutating `process.env` during bootstrap | `src/index.ts` | M |
| Inject the process-wide singletons: hashtag budget, HTTP semaphores, redactor registry | `src/tools/discovery.ts`, `src/core/http.ts`, `src/core/redact.ts` | M |
| A journal port with an identity field | `src/mcp/write-mode.ts` | S–M |

Path C is the right moment for the credential-provider port: it adds a third
token shape anyway.

## 7. Themes

**A. Local-first on Meta's current setup (recommended).** Path C, Graph and
Node moves, skills, multi-account fan-out, plugin listing. COND: messaging
reads, OS-scheduler queue, MCP Apps preview. Keeps every security.md
invariant, plays to the project's real differentiator (the write-safety
model), and stays shippable by one maintainer. Downside: no real-time
behaviour and no presence in the Connectors Directory, ChatGPT or Claude
web/mobile.

**B. Hosted remote product.** Multi-tenant OAuth proxy, Connectors
Directory, webhooks, daemon scheduling, real-time DMs, MCP Apps everywhere.
It gives parity with Composio and the SaaS schedulers and reaches far more
users. But it breaks the loopback and single-operator invariants, adds secret
classes (tenant tokens, authorization-server keys, the webhook secret), needs
Advanced Access and Business Verification, and carries an ops burden. It is
a second product. If chosen, build it as a separate repo on top of `core/`.

**Competitive position.** Meta publishes MCP servers for Ads, its developer
platform and WhatsApp Business, but **none for organic Instagram**. Open-source
competitors add Threads (mikusnuz/meta-mcp) or DMs. None has a write-safety
model comparable to preview→apply plus D3. Competitor details are from vendor
pages and directories `[verify]`.

## 8. Gates for 3.0

1. `2.0.0` is published, and 2.x is additive only.
2. Lane E has run for Paths A and B, and at least once for Path C.
3. Messaging probe 1 has an answer, if any messaging item is in scope.
4. Every new tool carries a `title` and a read-only or destructive hint, as
   the directory requires.
5. The usual gate: `npm run check` green on Node 24 and 26, manifest snapshot
   reviewed, stability.md §1 updated, CHANGELOG breaking section complete.

## 9. Owner decisions needed

1. Theme A or B (§7)? If B, is it a separate repo?
2. Path C as the 3.0 headline? Should A and B warn as legacy in 3.x?
3. Scheduling: does confirmation at enqueue time count as the D3 human
   confirmation?
4. Messaging: run probe 1 before 3.0 planning, so the COND rows can be
   settled?
5. Node floor `>=24` in 3.0 (forced by 2027-04-30)?
6. The corner-case catalogue freeze (§6): archive closed rows and drop the
   exact citation count?
7. Threads: a sibling `threads-mcp`, or out of scope?

## 10. Proposed phasing (after 2.0.0)

| Phase | Content | Live creds needed |
|---|---|---|
| 2.x | SDK 2.4 bump, Graph pin move (if minor), plugin listing polish, deprecation warnings for 3.0 removals | No |
| 3.0-α | Hygiene splits, catalogue freeze, Node 24 floor, credential-provider port | No |
| 3.0-β | Path C login and token shape, skills, multi-account fan-out, COND items that cleared | Yes, for Path C |
| 3.0-rc | Breaking batch (§5), stability.md and CHANGELOG, Lane E pass on all three paths | Yes |

## 11. Doc drift found during this analysis

- **Open.** [architecture.md](architecture.md) §8 says the HTTP transport
  "binds loopback unless a bearer token is configured" and that a non-loopback
  bind is refused only when there is no `IG_HTTP_TOKEN`. That implies a token
  allows a non-loopback bind. [security.md](security.md) §3 and
  `src/core/settings.ts` refuse every non-loopback bind, token or not.
  architecture.md is wrong.
- **Open.** v2-analysis §6 does not mark the `registerTool` raw-shape item
  done, but `bd2a00e` moved every call onto the typed overload.
- **Open, `[verify]`.** Meta's publishing guide shows a 50-posts-per-24-hours
  limit in one place and 100 elsewhere.

## 12. Sources (read 2026-10-28)

- Instagram API with Unified Login — developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login
- Instagram Platform overview and changelog — developers.facebook.com/docs/instagram-platform/overview, …/changelog
- Graph API changelog, versions table and v26 changelog — developers.facebook.com/docs/graph-api/changelog
- Content publishing — developers.facebook.com/docs/instagram-platform/content-publishing
- IG User reference — developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user
- Meta MCP servers — developers.facebook.com/documentation/mcp
- MCP roadmap — modelcontextprotocol.io/development/roadmap
- MCP 2026-07-28 changelog and deprecations — modelcontextprotocol.io/specification/2026-07-28/changelog, …/deprecated
- Skills extension SEP-2640 — modelcontextprotocol.io/seps/2640-skills-extension
- TypeScript SDK releases — github.com/modelcontextprotocol/typescript-sdk/releases
- Claude connector submission and authentication — claude.com/docs/connectors/building/submission, …/authentication
- Node.js release schedule — nodejs.org/en/about/previous-releases
