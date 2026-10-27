# 2.0 Scoping Analysis

> First pass at scoping the major release after `1.0.0`. Written 2026-10-24,
> when `0.8.0` was on npm and `1.0.0` was blocked only on live credentials and
> owner go-aheads (see [roadmap.md](roadmap.md)). This document is a
> **recommendation**, not a plan of record. Nothing here is scheduled until the
> owner answers §8 and the items are moved into the roadmap.
>
> Four inputs fed it: a codebase/debt review, a Meta Instagram Platform
> changelog review, an MCP-specification and competitor review, and a
> feasibility review of the features parked in roadmap.md and
> [messaging.md](messaging.md). Meta facts were read from official
> developers.facebook.com pages on 2026-10-24. Anything not confirmed from an
> official page is marked `[verify]`, as in [corner-cases.md](corner-cases.md).

## 1. Summary

- **Theme for 2.0: catch up with the platform and the protocol, then ship one
  headline feature.** Since the v25.0 design, Meta has added roughly a dozen
  Instagram-relevant capabilities: collaboration invites, delete media, trial
  reels, alt text, AI-generated labelling, likes, new metrics and a 20-item
  carousel. The MCP spec moved to the stateless 2026-07-28 revision, which
  adds tasks, MCP Apps and multi-round-trip input requests.
- **Headline feature candidate:** an operator-storage upload helper, so a local
  file can be published without the operator hosting it. The public-URL
  requirement is the largest UX gap in the server today.
- **Not in 2.0:** a hosted multi-tenant remote server, webhooks, shopping,
  boosting, scheduling. **Messaging stays DEFER.** 2.0 only settles its owner
  conditions and builds its gate code dark.
- **Hard prerequisite.** Lane E (live probes) must have run before 2.0 GA.
  Every new endpoint below adds to a `[verify]` debt that 1.0 has not paid yet.

## 2. Starting point (2026-10-24)

| Area | State |
|---|---|
| Release | `0.8.0` on npm with provenance. `1.0.0` is cut-ready offline. 41 of the 43 remaining hours are blocked on live credentials or owner acts. |
| Surface | 29 tools in 6 packages (account, media, publishing, comments, insights, discovery). Profiles `core` / `reader` / `publisher` / `all`. |
| Protocol | MCP TS SDK v2. stdio plus opt-in Streamable HTTP (stateless, loopback-only, optional bearer). `outputSchema`/`structuredContent`, annotations and form elicitation are used. No resources, prompts, tasks or icons. |
| Graph | Pinned to `v25.0` in one constant (`src/core/host.ts`). The login CLI still uses unversioned OAuth URLs. |
| Quality | 2606 tests, 100 % coverage, hand-planted mutants, doc-drift gates. |
| Size | 43 source files, about 20k lines. 17 files are over 500 lines, much of it rationale comments. |
| Live validation | **None, ever.** No live probe has reached Meta, and no real post has been published. |

## 3. External changes: forced versus optional

### 3.1 Forced, or already in force

| Date | Change | Impact on this server |
|---|---|---|
| 2026-10-27 (all versions, v25 included) | `GET /?ids=`, `date_format` → error; `pretty`/`debug` ignored; ETag / `If-None-Match` / 304 removed | **None.** The source uses none of them (checked 2026-10-24). |
| 2026-07-30 | `media_url` is omitted, with HTTP 200, for video with licensed audio and for reels whose owner disabled downloads | **Already handled.** `media_url` is optional in every output schema. Worth one docs line telling clients to fall back to `permalink` / `thumbnail_url`. |
| 2025-01-21 → 2025-04-21 | `impressions`, `plays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count` deprecated; `views` added | Check the insights metric enums against the list in §4.3. |
| since Graph 20 | Demographics timeframes limited to `this_week` / `this_month` | This matches the open owner question on deprecated demographics timeframes. Meta has settled it, so it no longer needs a live check, only a docs-backed change. |
| 2028-07-29 | v25.0 end of life, per the versions table `[verify — unusually long lifetime]` | The pin is safe for about 21 months. v26 shipped 2026-07-29 with no Instagram-specific breaks found. |

### 3.2 Contradictions with our own docs to resolve

- **Carousel size.** Meta's publishing guide now says **up to 20** items. The
  server enforces 2–10 (`CAROUSEL_MAX`, the tool descriptions and
  corner-cases.md). `[verify]` against the current reference page before
  changing anything. Widening an input bound is a **minor** change under
  [stability.md](stability.md) §1.
- **Deleting media.** The 2025-12-03 changelog adds `DELETE /{ig-media-id}`
  (permission `instagram_manage_contents`). corner-cases.md still states that
  published feed media "cannot be deleted via the API". That sentence also
  shapes the live-test protocol, which avoids feed posts because they could
  not be cleaned up. Correct the docs. A delete tool is a §4 item.

## 4. Candidate scope

Verdicts: **GO**: recommended for 2.0. **COND**: GO only if the condition
holds. **DEFER**: not in 2.0, revisit later. **NO-GO**: rejected for 2.0.
Effort: S < ½ day, M ≈ 1–2 days, L ≥ 3 days.

### 4.1 Platform features (Meta)

| Candidate | Path | Effort | Verdict | Notes |
|---|---|---|---|---|
| `alt_text` on image publish | A+B | S | GO | Image posts only, not reels or stories. |
| `is_ai_generated` on publish | A+B | S | GO | For a carousel, set it on the parent only; Meta returns an error if a child carries it. |
| Carousel bound 10 → 20 | A+B | S | COND | Do it once the reference page confirms 20. This is a minor change. |
| `instagram_delete_media` | A+B | S | GO | Irreversible, so it sits behind preview→apply **and** `IG_ALLOW_DESTRUCTIVE`. It needs a new scope. It also unblocks clean live feed tests. |
| Collaboration invites (list / accept / decline) and collaborators on publish | A+B | S–M | COND (Lane E) | Read-only listing is cheap. Accepting an invite is a write. |
| Collaborative media list and search | B | S | COND (Lane E) | Read-only. |
| Trial reels (`trial_params.graduation_strategy`) | A+B | S | GO | Optional input on `post_reel` / the container. |
| Like / unlike media and comments | A+B | S | DEFER | Needs the new `instagram_manage_engagement` permission. It is a write on third-party content, with low value for an operator tool. |
| Branded content / paid partnership on publish | B | S | DEFER | Path B only, and the use case is niche. |
| @mentions read (`mentioned_media`, `mentioned_comment`) | B (A partial) | S | GO | Already listed in architecture.md under comments, but no tool exists. |
| Replies pager (`GET /{comment-id}/replies`) | A+B | S | GO | Today replies come back only inline, with a truncation flag. |
| Hashtag budget read (`recently_searched_hashtags`) | B | S | GO | Complements the local 30-per-7-day tracker. |
| Insights refresh: `reels_skip_rate`, `reposts`, `crossposted_views`, `facebook_views`, `total_*` (B), story `link_clicks` (B), reels watch-time, `breakdown` support | A/B | M | GO | Purge the deprecated metrics in the same change. Removing an accepted enum value is **major**, so it belongs here. |
| New media fields: `reposts_count`, `saved_count`, `shares_count`, `media_audio_type` | B | S | GO | Additive output, so it is minor. Could land in 1.x. |
| Resumable upload (`rupload.facebook.com`) | B | M | DEFER | Path B only. It adds an allowlisted host. Revisit after the upload helper. |
| Audio API | B | S | DEFER | No operator ask yet. |
| oEmbed without a token | — | S | DEFER | Little use from an authenticated server. |
| Graph v25 → v26 | — | S | COND | No Instagram breaks found. Do it as a 1.x minor once stability.md classifies version moves (§5). |

### 4.2 Protocol features (MCP)

| Candidate | Effort | Verdict | Notes |
|---|---|---|---|
| **2026-07-28 conformance**: `resultType`, `server/discover`, `ttlMs`/`cacheScope` on lists, deterministic tool order, and the D3 confirmation moved onto multi-round-trip `input_required` with a 2025-11-25 fallback | M | GO (first) | Server-initiated `elicitation/create` is replaced in the new revision. The D3 write gate must keep refusing safely when a client cannot elicit. Check what SDK v2 already provides before writing code. |
| Tasks extension for video / reel / carousel publishing (progress plus cancel) | M | GO | This replaces in-call polling and is the natural fit for container `IN_PROGRESS` → `FINISHED`. |
| Resources plus `resource_link` (profile, recent media, insights snapshot, metric glossary) | M | GO | Closes architecture-review finding F-18 (no resources or prompts). **Done 2026-10-27** (`src/mcp/resources.ts`; resources only, `resource_link` left out because each resource mirrors a tool result). |
| Prompts: weekly report, caption → publish, comment triage, discovery research | S | GO | Closes the other half of F-18. The leading competitor ships these. |
| MCP Apps post preview (`ui://`): render the preview→apply plan and an insights chart | L | COND | A strong differentiator, since no competitor has it. Do it only if the target clients render MCP Apps by 2.0. The preview must stay complete as text, because a UI must never be the only place a write is described. |
| Icons on server and tools (`server.json`, MCPB manifest) | S | GO | Cheap polish that directories display. |
| URL-mode elicitation for login / refresh | M | DEFER | Overlaps the CLI flows. Revisit if a hosted mode is ever chosen. |
| Sampling, roots, logging capability | — | NO-GO | Deprecated in 2026-07-28. |

### 4.3 Features parked in roadmap.md

| Candidate | Effort | Verdict | Notes |
|---|---|---|---|
| **Operator-storage upload helper** (S3-compatible, presigned URL) | M | **GO — headline** | Off by default and operator-configured. It needs a **separate** storage-host allowlist, and the server never fetches remote URLs. Reading local files brings path-traversal hardening and a new secret class (storage credentials). It can be built and unit-tested offline. Meta's ingestion of the presigned URL still needs a live check. |
| M6 Messaging | L | DEFER | messaging.md §7 conditions 1–3 need live calls. Probe 1 (do sends need a webhook subscription?) goes first, because a YES ends M6 for good. In 2.0, decide conditions 5 (Path A only) and 6 (staged delivery), and build the `IG_ALLOW_MESSAGING` gate and the `IG_WRITE_MODE=apply` exemption dark. |
| Webhook receiver | L | NO-GO | It needs an inbound public endpoint, which conflicts with loopback-only and with "never spin up tunnels". It would only fit as a separate hosted process. |
| Hosted multi-tenant remote server (OAuth 2.1, Connectors Directory) | L+ | NO-GO for 2.0 | It needs a per-tenant secret store, server-side refresh, per-tenant journal and rate limits, a public TLS bind and an ops burden. The architecture review excluded it explicitly. Competitors (Composio, Pipeboard, Meta's own Ads MCP) are hosted, so revisit it as a separate product decision, not a version item. |
| Product tagging / shopping | M | NO-GO | Meta is sunsetting commerce surfaces (Commerce/Checkout sunset in v26), and it needs catalog eligibility. |
| Boosting | L | NO-GO | Marketing API, a new host, real ad spend. |
| Scheduling | M | NO-GO | Graph has no native scheduling, and an emulation needs a daemon, which does not fit stdio. Prompts can cover "plan a posting calendar" without one. |

## 5. Breaking-change batch (major-only)

[stability.md](stability.md) §1 classifies narrowing an input, removing a
tool, a surface or an output field, and changing output meaning as **major**.
**Recommendation:** decide every narrowing item **before the 1.0.0 cut**, so it
ships with the `userTags` narrowing as one breaking batch. Whatever is left
over becomes the single 2.0 "tightening" batch below, so 1.x stays additive.

| Item | Today | 2.0 proposal |
|---|---|---|
| Env-var naming | `IG_PORT` next to `IG_HTTP_HOST`/`IG_HTTP_TOKEN`. `IG_AUTH_MODE` and `IG_AUTH_PATH` are aliases, and the code treats `AUTH_PATH` as canonical. | 1.x accepts `IG_HTTP_PORT` and warns on the old name. 2.0 removes `IG_PORT` and one of the auth spellings. |
| Profile names | Names with `-` are accepted, but a shell `export` refuses them | Restrict to `[A-Z0-9_]`. 1.x warns first. |
| Insights `since`/`until` | Only the 90-day retention is enforced | Add the 30-day window cap. |
| Discovery hashtag limit, reel `thumbOffset` max, duplicate `userTags` / carousel children | Accepted | Refuse before the call. |
| `limit` versus `IG_MAX_ITEMS` cursor | The cursor semantics differ when the cap applies | Pick one meaning and document it. |
| Deprecated insights metrics in input enums | Still accepted, where they remain in the enums | Remove them (§4.1). |
| Package membership | Moving a tool between packages changes what a profile exposes (precedent: the comment toggle moved from `media` to `comments`) | Have stability.md §1 classify this as major **in 1.0**, so 2.0 can carry any re-grouping, for example a new `engagement` package. |
| Absurd `Retry-After` | Fails fast with a wait estimate | Owner choice: keep it, or back off with a cap. Changing it alters behaviour on a documented error path. |

Also bind in 1.0 (stability.md §4 open questions): the `IG_*` names as they
are, the CLI commands, flags and exit codes 0/1/2, and the rule that a Graph
version move is **minor** unless Meta removes something an output promised.

## 6. Architecture work

| Item | Why | Effort |
|---|---|---|
| Split `src/cli/login.ts` (1333 lines) by Path A / Path B / redirect capture | Largest file. The two paths share little. | M |
| Split `src/core/config-write.ts` (1303 lines) into lock / atomic write / env parser | Three concerns in one module. **Done 2026-10-27** (`src/core/config-lock.ts`, `src/core/atomic-write.ts`, `src/core/env-file.ts`, plus `src/core/store-link.ts` for the symlink walk). | M |
| Factor the image / reel / story composites in `src/tools/publishing.ts` | Repeated flow shape, and `thumbOffset` is declared twice. Trial reels, alt text, AI labels and tasks will all touch this file. | M |
| Move CLI dispatch out of `src/index.ts` | The composition root and the CLI are mixed together. **Done 2026-10-27** (`src/cli/argv.ts`, `src/cli/refresh.ts`). | S |
| Drop the deprecated raw-shape `registerTool` workaround in `src/mcp/registry.ts` | SDK debt. Must happen before the SDK removes the overload. | S |
| Make the diagnostics/status tool undeniable (architecture-review finding F-19) | A deny list can currently switch off the tool used to diagnose the deny list. **Done 2026-10-27** (`ALWAYS_ON_TOOLS`). | S |
| Review the cost of the corner-case catalogue | 650+ rows and citation-count gates add friction to every change. Consider freezing closed rows into an archive file. | M |

Do the refactors **first** in the 2.0 branch, before the feature work, while
the 100 % coverage net and the mutants still describe today's behaviour.

## 7. Gates for 2.0

1. `1.0.0` is cut and published, and 1.x is additive only.
2. **Lane E has run** at least once: the read lanes, the publishing protocol and
   the messaging webhook probe. With delete media available, feed posts in live
   tests can be cleaned up.
3. A 2026-07-28 client and a 2025-11-25 client both pass the D3 confirmation
   path (an elicitation fallback, and refusal when the client cannot elicit).
4. The usual gate: `npm run check` green, manifest snapshot reviewed,
   stability.md §1 updated for every surface change, and the CHANGELOG
   breaking section complete.

## 8. Owner decisions needed

1. Is the theme in §1 right: platform and protocol catch-up plus the upload
   helper?
2. Which storage providers does the upload helper support? The recommendation
   is any S3-compatible endpoint via presigned PUT, with nothing provider-specific.
3. Should every narrowing item in §5 be decided before 1.0, so it ships with
   the `userTags` change?
4. Bind the env names, CLI surface and exit codes in 1.0, and classify Graph
   version moves and package-membership moves (stability.md §4)?
5. Messaging conditions 5 (Path A only) and 6 (staged delivery): yes or no?
6. MCP Apps preview: is it worth an L-size item now, or does it wait for client
   support?
7. Hosted remote mode: confirm it is out of 2.0. It is a separate product
   decision.
8. `Retry-After`: keep fail-fast, or back off?

## 9. Proposed phasing (after 1.0.0)

| Phase | Content | Live creds needed |
|---|---|---|
| 1.x | Additive work: new media fields, icons, prompts, resources, Graph v26 move, carousel 20 (if confirmed), `IG_HTTP_PORT` alias, deprecation warnings | No (prompts/resources), yes for verification of new fields |
| 2.0-α | Refactors (§6), 2026-07-28 conformance, tasks for publishing | No |
| 2.0-β | Platform features (§4.1 GO rows), insights refresh, delete media, upload helper | Partly; every new endpoint ships `[verify]` until Lane E |
| 2.0-rc | Breaking batch (§5), stability.md and CHANGELOG, Lane E pass | Yes |

## 10. Doc drift found during this analysis

Status 2026-10-27: every item except the carousel bound is fixed.

- **Fixed.** corner-cases.md, live-qa.md and `scripts/live-probe.mjs` said feed
  media cannot be deleted via the API. The changelog has said otherwise since
  2025-12-03 (§3.2). They now say this server has no delete tool, which is what
  keeps the `--allow-feed-post` lane irreversible.
- **Open, `[verify]`.** The carousel bound (2–10) disagrees with Meta's current
  guide (up to 20). It waits for the reference-page check (§4.1).
- **Fixed.** tools.md said "all 17" read tools. The surface is now 21 read and
  11 write, and tools.md says 21.
- **Fixed.** operations.md pointed to a webhook "phase-3 option" in roadmap.md
  that does not exist there. It now points to the roadmap's parked item and
  the NO-GO verdict in §4.3.
- **Fixed.** security.md counted 16 id-bearing fields. The `ID_FIELDS` sweep
  lists 23.

## 11. Sources (read 2026-10-24)

- Graph API changelog and the v26 changelog — developers.facebook.com/docs/graph-api/changelog
- Instagram Platform changelog — developers.facebook.com/docs/instagram-platform/changelog
- Media and user insights references — developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights,
  …/api-reference/instagram-user/insights
- Content publishing — developers.facebook.com/docs/instagram-platform/content-publishing
- Messaging API (Instagram Login) — developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
- Rate limiting — developers.facebook.com/docs/graph-api/overview/rate-limiting
- MCP specification 2026-07-28 changelog — modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP Apps SEP-1865 — modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp
- MCP registry remote servers — modelcontextprotocol.io/registry/remote-servers
