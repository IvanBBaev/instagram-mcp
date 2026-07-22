# Product & DX Review — instagram-mcp documentation set

## 1. Reviewer & scope

- **Role**: Senior product-minded developer-experience (DX) engineer, MCP servers & AI-agent tooling.
- **Date**: 2026-07-21.
- **Scope**: The full design-phase documentation set — `README.md`, `docs/tools.md`
  (primary focus), `docs/auth.md`, `docs/architecture.md`, `docs/operations.md`,
  `docs/security.md`, `docs/roadmap.md` — reviewed as a *product*: tool surface for
  an LLM consumer, onboarding funnel for three personas, competitive positioning
  (verified against the live ecosystem on 2026-07-21 via GitHub API, npm registry,
  and web search), and documentation quality.
- **Out of scope**: implementation correctness of Graph API facts (covered by the
  `[verify]` discipline and other role reviews), security architecture in depth.
- **Method note**: competitive claims below were checked live today; GitHub
  star/push data comes from the GitHub API, npm data from the npm registry API.
  No reviewed document was modified.

## 2. Executive summary

**Verdict: CONDITIONAL GO** (details in §8).

This is one of the better-thought-out MCP server designs I have reviewed: the tool
surface is deliberately compact, annotated, and structured-output-aware; the
plan-and-apply write gate, quota-aware previews, and honest error taxonomy directly
answer the documented prior-art complaints (misleading descriptions, response-size
pain, unused MCP features). The two-path auth documentation is unusually clear for
this notoriously confusing platform.

Top points:

1. **The README's competitive claim is stale as of today.** Two TypeScript
   Instagram MCP servers with npm distribution now exist (`@mcpware/instagram-mcp`,
   `@mikusnuz/meta-mcp`). The *full* differentiation claim (annotations, structured
   output, token security, rate-limit compliance) still holds — but the shorthand
   "no maintained TypeScript Instagram MCP server" will read as false to anyone who
   searches. Reword and name the prior art. Meta's official MCP remains **ads-only**
   — the organic-content positioning survives. `instagram-mcp-ai` is **available on
   npm** today; the obvious alternatives are already squatted — reserve it early.
2. **The public-URL media constraint is the predicted #1 support issue and it is
   invisible in the README.** It lives only in a design note inside `tools.md`.
   Persona 1 (non-technical creator) hits it on their very first "post this image".
3. **The auth-mode env vars are never named.** `auth.md` says the path is "selected
   by which env vars are present" but no document defines them; the quickstart shows
   a config that cannot work for Path B (no app secret). There is no consolidated
   env-var inventory anywhere.
4. **Persona 3 (Claude Desktop / MCPB) has no token-acquisition story.** MCPB
   `user_config` expects a pasted long-lived token; the only way to obtain one is a
   CLI `login` flow that this persona will never run.
5. Tool-surface polish items: `create_comment` vs `reply_to_comment` ambiguity,
   `publish_media` vs `post_*` steering risk, a handful of missing high-value tools
   (list active stories, reply-to-mention, location lookup), and per-tool
   response-size defaults for the nested-expansion tools.

None of this threatens the architecture. All conditions are documentation and
naming-level fixes, best absorbed now — `tools.md` itself says names are final
"unless a review changes them", and this review proposes changes.

## 3. Tool-surface review

### 3.1 Is ~25 tools the right surface?

**Yes.** 25–30 tools is the sweet spot for an LLM consumer: large enough to cover
the platform's real capabilities, small enough that every description fits in
context and the model can discriminate between tools. The package/profile system
(`core` default, `IG_TOOL_PACKAGES`, deny/readonly lists) lets operators shrink it
further — this is genuinely better than the 97–200-tool competitors, whose surfaces
are unusable in practice (the archived `oliverames/meta-mcp-server` is the
cautionary tale, correctly cited).

One accounting problem: **the catalog contains 28 tools, not "≈25"** (account 3,
media 3, publishing 7, comments 8, insights 4, discovery 3), and `operations.md` §6
mentions a per-host **telemetry debug tool in the `account` package** that appears
nowhere in `tools.md`. Small drift, but this project's whole pitch is manifest
discipline — state the exact number and put every tool in the catalog (Finding 9).

### 3.2 Composite vs primitive balance

The balance is right and well-reasoned: the container flow is exactly the kind of
multi-step protocol models get wrong (create → poll → publish, with video
`FINISHED` gating), so `post_image` / `post_reel` / `post_story` composites earn
their place, and keeping the primitives exposed preserves advanced control
(e.g. resuming a failed publish with a surviving container ID — `operations.md` §2
handles this correctly).

The **risk is steering, not structure**: a model asked to "post this image" sees
both `instagram_publish_media` and `instagram_post_image` and may pick the former
(it contains the everyday word "publish"), then fail for lack of a container ID.
`tools.md` specifies Graph calls but **never drafts the model-facing description
text**, which is the load-bearing artifact for steering. For the publishing trio
and the comment pair, the exact wording should be designed now, in the spec, not
improvised at implementation time (Finding 6).

### 3.3 Naming consistency

`instagram_<verb>_<noun>` is followed almost everywhere. Concrete suggestions:

| Tool | Issue | Suggestion |
|---|---|---|
| `instagram_token_status` | No verb — breaks the stated convention. | Rename `instagram_get_token_status`. |
| `instagram_publish_media` | Reads as the everyday "publish a post" action; it is actually step 2 of the manual container flow. | Rename **`instagram_publish_container`** (input is a container/creation ID — make the name say so). Description: "Low-level step 2… For a normal post, use `instagram_post_image` / `_reel` / `_story`." |
| `instagram_create_comment` vs `instagram_reply_to_comment` | Ambiguous pair; a model replying to a user's comment may pick `create_comment`. `create_comment` (top-level comment on *own* media) is a rare use case. | Either **merge**: one `instagram_create_comment` taking `media_id` *or* `reply_to_comment_id` (mutually exclusive, zod-enforced), or rename the top-level one `instagram_comment_on_media` and cross-reference both descriptions ("to answer a user's comment, use `instagram_reply_to_comment`"). |
| `instagram_post_image` | Also handles carousels — not guessable from the name. | Keep the name; title/description must say "single image **or carousel** (2–10 items)". Consider `carousel` mention in the title. |
| `instagram_get_hashtag_media` | Requires a prior `search_hashtag` call, which spends the 30-unique-hashtags/7-days budget and forces a two-step dance. | Accept a hashtag **name**, resolve the ID internally, and **persist an ID cache** (hashtag IDs are stable) so repeat lookups cost no budget. Keep `search_hashtag` as the primitive. |
| `instagram_list_linked_accounts` | Path B only, but registered from M1 while the auth-path capability matrix lands in M4. | Gate registration by auth path from M1 — a Path-A model should never see the tool at all (better than a description caveat). |
| `instagram_set_comments_enabled` | Fine (verb+noun+state). | Keep; annotate description as "moderation toggle, reversible". |
| `instagram_get_online_followers` | Metric flagged `[verify]` — may not survive v25. | Keep the flag; drop the tool rather than ship a dead metric. |

### 3.4 Missing high-value tools

- **List active stories** — `GET /{ig-id}/stories`. You can *post* a story but
  cannot see which stories are live (needed for story insights targeting and for
  "what's on my story right now?"). Cheap, read-only, obviously useful.
- **Reply to a mention** — `list_mentions` has no action counterpart; the mentions
  API supports replying to a comment/media where you are @mentioned. Without it the
  mentions package is read-only in a workflow that is inherently about responding.
- **Location lookup** — `create_media_container` accepts `location_id`, but no tool
  (and no doc) explains how to obtain one. A dangling input an LLM will
  hallucinate values for. Either document the acquisition path or drop `location_id`
  from v1 inputs.
- Deliberate, correct absences worth **documenting as FAQ** so users don't file
  issues: no `delete_media` (the API does not allow deleting IG media), no native
  scheduled posts (the IG API has no scheduling; suggest the container's 24 h
  lifetime is *not* a scheduling mechanism), no follower lists (API doesn't expose
  them), no personal accounts.

### 3.5 Oversized-response risks

The character-budget truncation loop and `{ items, paging }` envelope are the right
global mechanisms; four tools need **per-tool defaults** specified in the catalog:

1. `instagram_discover_business` — nested `media{...}` on a public profile can be
   enormous. Default should be profile-only; media expansion opt-in with an item cap.
2. `instagram_list_comments` — `replies{...}` expansion is unbounded on viral
   posts. Default: no reply expansion; per-comment reply counts + a `get_comment`
   / explicit expansion path.
3. `instagram_get_hashtag_media` — `top_media`/`recent_media` on popular hashtags;
   needs a low default `limit`.
4. `instagram_get_audience_demographics` — `city` breakdown can return hundreds of
   rows; default to top-N with `truncated: true`.

Also: `media_url` / `thumbnail_url` are long **signed CDN URLs that expire**. They
inflate every `list_media` row and go stale in stored transcripts. Consider
excluding `media_url` from the `list_media` default field set (keep `permalink`),
offering it on `get_media`, and documenting the expiry.

### 3.6 Write-safety UX

Plan-and-apply is the correct answer to model-driven mutation — but note the DX
cost: **every write becomes two round-trips** by default. Two requirements: (a) the
preview response must contain an explicit machine-actionable affordance ("re-call
this tool with `apply: true` to execute") so models complete the loop reliably;
(b) `IG_WRITE_MODE=apply` must be documented prominently as the standing-consent
mode for operators who trust their setup, otherwise the double-call pattern will be
perceived as a bug. The auto-injected `account` argument is good for multi-profile;
its `.describe()` should say "omit unless multiple profiles are configured" so
single-profile models don't invent values.

## 4. Onboarding walkthroughs

### Persona 1 — Non-technical creator, only an IG account

Their path: convert account to professional → **create a Meta developer app** →
configure "Instagram API with Instagram Login" → run `login` → configure the MCP
client. Friction points, in order encountered:

1. **The developer-app wall.** `auth.md` §1A says Path A needs "no Facebook
   account link" — true for the *login*, but **creating the Meta app requires a
   Meta developer account** (registered via Facebook). The docs never acknowledge
   this; persona 1 will feel misled at step 2. Needs an explicit caveat and a
   screenshot-level future guide (the promised "step-by-step in the future README"
   is the right plan — commit to it).
2. **Token acquisition.** The `login` CLI (M2) is the answer, but the README
   quickstart shows a raw `IG_ACCESS_TOKEN` env var with no pointer to how a
   non-developer obtains one.
3. **The public-URL constraint — the wall they cannot climb.** "Post this image
   from my computer" fails: Meta ingests media by public URL only. This persona has
   no hosting. The constraint is honestly documented — but only in a design note
   in `tools.md`. It must be in the README's feature list ("publishing requires
   your media at a public URL — see FAQ"), in the quickstart, in the composite
   tools' descriptions, and in the container tool's error text. The roadmap's
   operator-storage upload helper is the real fix; it is currently "later /
   explicitly parked" — for this persona it is the difference between usable and
   not, and deserves a promotion to a numbered phase once M5 ships.
4. **60-day token cliff.** Auto-refresh runs "at first use of a session" — a
   creator who pauses for two months returns to a dead token. `token_status`
   warnings only help people who call tools. Document the recovery path ("run
   `login` again") in the troubleshooting doc; consider a `doctor`-suggested
   calendar reminder in the MCPB notes.

**Bottom line**: persona 1 is only truly served at M5 (MCPB) + the storage helper.
That is fine — but the docs should say who v1 is for, so expectations are set.

### Persona 2 — Developer already using facebook-mcp with Business Manager

The best-served persona; Path B with a system-user token is a genuinely smooth
story ("one app for both servers" is a strong pitch). Friction points:

1. **Scope union on the existing token.** They must regenerate the system-user
   token adding the five `instagram_*` scopes and assign the IG-linked Page + IG
   account as assets. `auth.md` §2.4 covers it in one line; a short "coming from
   facebook-mcp" subsection (regenerate token → add scopes → set `IG_*` vars,
   reusing the same token value) would remove all guesswork.
2. **The quickstart config is Path-A-shaped.** Path B needs the app secret for
   `appsecret_proof`, but no `IG_APP_SECRET`-style var is documented anywhere, and
   the README example implies token+ID is always enough. This persona will
   configure Path B and hit an undocumented failure (Finding 3).
3. **Which ID goes in `IG_ACCOUNT_ID`?** Page ID vs IG-scoped user ID vs IG
   business account ID confusion is endemic on this platform.
   `instagram_list_linked_accounts` + `doctor` solve discovery; the env-var doc
   must state precisely which ID is expected (and ideally accept a Page ID with a
   helpful error).

### Persona 3 — Claude Desktop user installing via MCPB

The MCPB bundle with keychain-backed `user_config` is the right vehicle — but the
funnel currently **breaks at "obtain token"**: `user_config` asks them to paste a
long-lived token, and the only documented way to get one is the `login` CLI, which
this persona will not run. Options, in order of preference:

1. **URL-mode elicitation** (MCP 2025-11-25, SEP-1036 — already noted in the
   ecosystem research this project cites) for an in-band OAuth flow at first tool
   call. This is the modern answer and nobody in the niche does it — a genuine
   differentiator. At minimum, put it on the roadmap as the persona-3 unlock.
2. A guided one-command bridge: "open Terminal, paste
   `npx instagram-mcp-ai login`, then paste the resulting token into the config
   screen" — clunky but workable if step-by-step with screenshots.
3. De-scope persona 3 for v1 and say so.

Any of the three is acceptable; the current docs choose none (Finding 4).

### The two-path story

`auth.md` explains the fork better than most material on the topic — the decision
table (§1, "Path selection guidance") is exactly right. The problem is placement:
**the README never mentions that two paths exist.** A first-touch reader sees a
single quickstart config and forms a one-path mental model that `auth.md` later
has to break. Three sentences and the decision table (or a link to it) in the
README fix this.

## 5. Competitive positioning (verified 2026-07-21)

### 5.1 What exists today

Live data (GitHub API / npm registry, today):

| Project | Lang | Stars | Last push | npm | Notes |
|---|---|---|---|---|---|
| [jlbadano/ig-mcp](https://github.com/jlbadano/ig-mcp) | Python | 160 | 2026-02-09 | — | "Production-ready" IG Business server; the Python reference. Semi-idle ~5 months. |
| [mcpware/instagram-mcp](https://github.com/mcpware/instagram-mcp) | Python repo; **TS npm pkg** | 23 | 2026-06-02 | [`@mcpware/instagram-mcp`](https://www.npmjs.com/package/@mcpware/instagram-mcp) v1.0.4 (2026-03-18; npm untouched since 2026-03-19), ~611 dl/mo | 23 Graph API tools incl. posts, comments, **DMs**, stories, reels, carousels, hashtags, analytics; Docker; ships a `.claude-plugin`. Billed as a TS rewrite of ig-mcp. |
| [mikusnuz/meta-mcp](https://github.com/mikusnuz/meta-mcp) | **TypeScript** | 13 | 2026-03-24 | [`@mikusnuz/meta-mcp`](https://www.npmjs.com/package/@mikusnuz/meta-mcp) v2.0.2 (2026-03-24), ~570 dl/mo | 57 tools: **33 Instagram** (publishing incl. reels/stories/carousels with alt text, comments, insights, DMs, hashtags, mentions) + 18 Threads + 6 Meta; Graph v25.0. Env-token auth only; **no annotations, no structuredContent, no write safety, no redaction, no tests/CI mentioned** (README verified today). Stale ~4 months. |
| [arjun1194/insta-mcp](https://github.com/arjun1194/insta-mcp) | TypeScript | 8 | 2025-12-28 | — | No license; analytics/engagement focus. |
| [anand-kamble/mcp-instagram](https://github.com/anand-kamble/mcp-instagram) | TypeScript | 6 | 2025-11-24 | — | Stale. |
| [duhlink/instagram-server-next-mcp](https://github.com/duhlink/instagram-server-next-mcp), [Bob-lance/instagram-engagement-mcp](https://github.com/Bob-lance/instagram-engagement-mcp) | — | — | — | — | Unofficial-API / browser-session based — outside this project's policy universe. |
| **Meta official MCP** (`mcp.facebook.com/ads`) | hosted | — | live (beta since 2026-04-29) | — | **Still ads-only**: campaigns, ad sets, creatives, reporting. No organic Instagram publishing, comments, or insights. Sourced from third-party coverage ([commonthreadco](https://commonthreadco.com/blogs/coachs-corner/meta-ai-mcp-cli-ads-connectors-ecommerce), [claudefa.st](https://claudefa.st/blog/tools/mcp-extensions/meta-mcp-cli), [get-ryze.ai](https://www.get-ryze.ai/blog/meta-official-mcp-what-it-does-and-how-to-install)); no Meta primary announcement verified — same caveat as the facebook-mcp research. |

### 5.2 Is the README claim still true?

**As written — no longer defensible.** "No maintained, well-engineered TypeScript
Instagram MCP server with npm distribution…" is a conjunction whose *full* form
still holds: neither TS competitor has MCP annotations, structured output, token
redaction, rate-limit compliance, write safety, or a visible test suite. But the
shorthand reading ("no TypeScript Instagram MCP server") is now false —
`@mikusnuz/meta-mcp` and `@mcpware/instagram-mcp` are TypeScript, on npm, cover
the same organic surface (both including DMs, which this project defers to
phase 2), and have real download counts. Both are arguably un-*maintained* (npm
stale since March), but "maintained" is a moving target and a bad load-bearing word.

**Recommendation**: reposition from "nothing exists" to "nothing exists *at this
engineering bar*" — name the two competitors, list the concrete differentiators
(annotations + structuredContent, plan-and-apply write safety, token
security/redaction, rate-limit budget, both auth paths incl. system-user tokens,
tests/CI, MCPB), and treat their DM coverage as pressure to not let phase 2 slip
forever. The niche started filling in Feb–Mar 2026; speed matters now.

### 5.3 npm name check

Registry checks (2026-07-21):

| Name | Status |
|---|---|
| **`instagram-mcp-ai`** | **AVAILABLE** (404 on registry) — the planned name is free today. |
| `instagram-mcp` | **Taken** (v1.1.7, 2025-10-24, "RapidAPI" — unofficial-API based; repo agent-llama/instagram-mcp). |
| `instagram-mcp-server` | **Taken** (v1.6.6, 2026-06-25, maintainer `raveenb` — the **same account that squatted `facebook-mcp-server`**; "SENSE + ACT tools for the Graph API", no public repo). |
| `ig-mcp` | Available (404). |

The `raveenb` pattern (both obvious `*-mcp-server` names claimed, no public repos)
is active squatting in this exact namespace. **Reserve `instagram-mcp-ai` with a
stub publish now**, not at M0 — the roadmap gates it behind scaffold start, which
is too late if design review takes weeks.

## 6. Findings

Severity: **Critical** (blocks GO) / **High** (fix before or at scaffold) /
**Medium** (fix before the relevant milestone) / **Low** (polish).

| # | Sev | Doc / section | Finding | Recommendation |
|---|---|---|---|---|
| 1 | High | `README.md` "Why build it" | The "no maintained… TypeScript Instagram MCP server" claim is contestable as of 2026-07-21: `@mikusnuz/meta-mcp` (TS, 33 IG tools, npm, v25.0) and `@mcpware/instagram-mcp` (TS npm pkg, 23 tools) exist. The full-conjunction claim survives; the shorthand does not. | Reword to "nothing at this engineering bar", name the prior art, list concrete differentiators (§5.2). Keeps the project honest — its own brand value. |
| 2 | High | `README.md` (absent); `tools.md` publishing note | The public-URL media-ingestion constraint — the predicted #1 support issue — appears only in a `tools.md` design note. The README advertises "feed images, carousels, Reels, Stories" with no caveat. | Surface in README feature list + quickstart, in the three composite tools' descriptions, in container error text, and in a FAQ with practical hosting options. Promote the operator-storage upload helper from "parked" to a numbered post-M5 phase. |
| 3 | High | `auth.md` §1/§4; `README.md` quickstart | Auth-path selection is "by which env vars are present", but **no document names the vars**. Path B requires the app secret (`appsecret_proof`) yet no `IG_APP_SECRET`/`IG_APP_ID` var is defined; the quickstart config cannot work for Path B. No consolidated env-var inventory exists. | Add a canonical env-var table (name, path A/B/both, required/optional, default) to `auth.md` or `architecture.md` §6 now; show both quickstart variants in the README. |
| 4 | High | `architecture.md` §11; `roadmap.md` M5 | MCPB persona has no token-acquisition story: `user_config` expects a pasted token; the only acquisition path is the CLI `login`. | Choose and document one: URL-mode elicitation OAuth (preferred — also a differentiator), a guided `npx … login` copy-paste bridge, or explicit v1 de-scope of persona 3. |
| 5 | Medium | `tools.md` comments | `instagram_create_comment` vs `instagram_reply_to_comment` is an ambiguous pair; models replying to users may pick the wrong one. | Merge into one tool (`media_id` xor `reply_to_comment_id`) or rename to `instagram_comment_on_media` + cross-referencing descriptions (§3.3). |
| 6 | Medium | `tools.md` publishing | `instagram_publish_media` will attract "post this" intents; model-facing description text — the actual steering artifact — is not drafted anywhere in the spec. | Rename to `instagram_publish_container`; draft the exact descriptions for the publishing trio and comment pair in `tools.md` before names freeze. |
| 7 | Medium | `tools.md` media/comments/discovery | Missing high-value tools: list active stories (`GET /{ig-id}/stories`), reply-to-mention (action counterpart of `list_mentions`), and any way to obtain a `location_id` (dangling input models will hallucinate). | Add stories-list and mention-reply to the catalog (M3/M4); document location-ID acquisition or drop the input from v1. |
| 8 | Medium | `tools.md` + `operations.md` §4 | Oversized-response risk on `discover_business` (nested `media{...}`), `list_comments` (`replies{...}`), `get_hashtag_media`, and city-breakdown demographics; global truncation exists but per-tool defaults are unspecified. `media_url` signed CDN URLs are huge **and expire** — undocumented. | Specify per-tool defaults: no nested expansion by default, low default limits, top-N breakdowns with `truncated: true`. Drop `media_url` from `list_media` defaults (keep `permalink`); document CDN-URL expiry. |
| 9 | Medium | `tools.md` "Tool-count budget"; `operations.md` §6 | "≈25 tools" vs 28 in the catalog; the telemetry debug tool exists only in `operations.md`. | State the exact count; every registered tool appears in the catalog (the manifest snapshot will enforce this later — the docs should match now). |
| 10 | Medium | `README.md` | The two-path auth fork — the platform's single most confusing property — is not mentioned in the README; first contact with it is `auth.md`. | Add a 3-sentence path summary + the decision table (or link) to the README. |
| 11 | Medium | docs set (absent) | No user-facing FAQ/troubleshooting doc: permission-error decoding (code → missing scope → fix), token-expiry recovery, why no post deletion / scheduling / personal accounts / follower lists, URL constraint, CDN expiry. `operations.md` has the internal taxonomy but no user-facing mapping. | Add `docs/faq.md` (or a troubleshooting section) at M1; wire error remediation texts to it. |
| 12 | Medium | `auth.md` §1A/§2 | "No Facebook account link required" (Path A) omits that **creating the Meta developer app requires a Meta developer account** — persona 1's first wall. | Add the caveat in §1A and §2; commit to the screenshot-level app-setup guide for the future README. |
| 13 | Low | `tools.md` account; `architecture.md` §8 | Naming drift: `instagram_token_status` lacks a verb; `IG_PORT` pairs inconsistently with `IG_HTTP_HOST`. | `instagram_get_token_status`; `IG_HTTP_PORT`. |
| 14 | Low | `tools.md` account; `roadmap.md` M1/M4 | `list_linked_accounts` (Path B only) ships M1, but auth-path registry gating arrives M4 — a Path-A model sees a tool that cannot work for three milestones. | Gate this one tool by auth path from M1. |
| 15 | Low | `tools.md` discovery | Two-step hashtag flow spends the 30-unique/7-days budget awkwardly. | Let `get_hashtag_media` accept a hashtag name; resolve + persist an ID cache (IDs are stable) to preserve budget (§3.3). |
| 16 | Low | `roadmap.md` M0 | npm-name reservation is gated behind scaffold start while an active squatter (`raveenb`) has already claimed both obvious names in this namespace (June 2026). | Publish a `0.0.1` placeholder of `instagram-mcp-ai` now; it is free today (§5.3). |
| 17 | Low | `tools.md` write safety | Plan-and-apply doubles round-trips on every write; if previews lack an explicit "re-call with `apply: true`" affordance, weaker models stall, and operators unaware of `IG_WRITE_MODE=apply` will read it as a bug. | Specify the preview affordance text in the spec; document `IG_WRITE_MODE=apply` prominently as standing consent. |

No Critical findings.

## 7. Recommendations summary (prioritized)

1. **Now (design phase, before scaffold)**
   - Reserve `instagram-mcp-ai` on npm with a stub publish (F16 — cheap, time-sensitive).
   - Rewrite the README "Why build it" competitive claim naming the prior art (F1).
   - Surface the public-URL constraint in the README + quickstart (F2).
   - Add the canonical env-var table incl. Path-B vars and both quickstart variants (F3).
   - Add the two-path summary to the README (F10) and the developer-account caveat to `auth.md` (F12).
   - Resolve the tool-name changes while names are still cheap: `publish_container`,
     `get_token_status`, the comment-pair merge/rename (F5, F6, F13).
   - Fix the tool-count statement and fold the debug tool into the catalog (F9).
2. **M1–M2**
   - Draft model-facing descriptions for the publishing trio + comment pair in `tools.md` (F6).
   - Per-tool response-size defaults for the four risky tools; `media_url` policy (F8).
   - Start `docs/faq.md` with permission-error decoding and the "why not" list (F11).
   - Gate `list_linked_accounts` by auth path from M1 (F14).
   - Specify the preview affordance + `IG_WRITE_MODE` guidance (F17).
3. **M3–M5**
   - Add stories-list and mention-reply tools; settle `location_id` (F7).
   - Hashtag name-resolution + ID cache (F15).
   - Decide the MCPB login story — URL elicitation preferred — before M5 ships (F4).
   - Promote the operator-storage upload helper to a numbered phase (F2 follow-up).
4. **Strategic**
   - Both TS competitors ship DMs today; do not let the phase-2 `messaging` package
     drift indefinitely — it is the one surface gap a comparison table will show.
   - Speed is now a feature: the niche began filling in Feb–Mar 2026.

## 8. Verdict

**CONDITIONAL GO** on product/DX grounds.

The product thesis remains sound *today*: Meta's official MCP is still ads-only,
the organic-Instagram niche has no competitor at this engineering bar, and the
design's differentiators (compact annotated surface, plan-and-apply safety,
structured output, real token security, two auth paths, npm + MCPB distribution)
map one-to-one onto the documented complaints about existing servers. The tool
surface is the right size and shape; the docs are unusually honest (`[verify]`
discipline, explicit non-goals) and the auth explanation is best-in-class.

**Conditions** (all documentation-level, resolvable in days):

1. Competitive claim rewritten with prior art named (F1) — the current wording
   would undermine credibility on day one.
2. Public-URL constraint surfaced in README/quickstart/FAQ (F2).
3. Canonical env-var inventory incl. the Path-B variables (F3).
4. A decided, documented MCPB token-acquisition story — or an explicit persona-3
   de-scope (F4).
5. Tool-naming decisions from §3.3 ratified while names are still cheap (F5, F6).

With those addressed, this is a GO — and the competitive data argues for moving
briskly: the name is free today, the squatters are active, and the TypeScript
competitors, while stale, exist.
