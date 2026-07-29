# Implementation Roadmap

> Phases are **gates, not dates**: each ends with the quality gate green
> (`npm run check`: build + lint + format + tests + coverage + audit), the
> tool-manifest snapshot reviewed, and the phase's corner cases
> ([corner-cases.md](corner-cases.md), referenced by `CC-*` ID) handled.
> Review conditions from [reviews/summary.md](reviews/summary.md) are folded in
> as work items. Sizes are rough effort classes (S < half a day, M ≈ 1–2 days,
> L ≈ 3+ days) for a single senior developer.
>
> **Parallel execution:** the task-level breakdown for developing these phases
> concurrently with multiple agents lives in [workplan.md](workplan.md)
> (task IDs `T-*`, integration gates G1–G5 mapped to the M-phases below). The
> roadmap stays the milestone view; the workplan is the execution view.

## Current state (updated 2026-07-29)

Status vocabulary used throughout this file and [workplan.md](workplan.md):
**DONE** · **PARTIAL** (some of it shipped, rest named below) · **BLOCKED**
(cannot proceed, reason named) · **NOT STARTED**.

| Phase | Status | What is actually left |
|---|---|---|
| M0 Scaffold | **PARTIAL** | Everything green except the npm name reservation: `instagram-mcp-ai` is **not on the registry** (404 as of 2026-07-29), so the M0 exit claim "npm name owned" is currently false. |
| M1 Core read path | **PARTIAL** | All code shipped and unit-tested; **no live run has ever happened** — the exit gate ("works on both paths against a real account") is unmet, and the PCA probe is unanswered. |
| M2 Publishing + write safety | **PARTIAL** | Code shipped (containers, composites, journal, login/refresh CLIs) and D3 elicitation landed 2026-07-29. **Left: live verification only** — no real post has ever been published. |
| M3 Moderation | **PARTIAL** | 9 comment tools + the `IG_ALLOW_DESTRUCTIVE` double gate shipped and unit-tested; no live moderation run. |
| M4 Insights & discovery | **PARTIAL** | Insights shipped, never verified against real metrics. `discovery` is implemented and registered; its gating probe (T-E3) cannot run without live Path-B credentials, so the gate was **decided without it on 2026-07-29** — the package stays, reversibly. See the decision block below. |
| M5 Distribution | **PARTIAL** | Artifacts exist (README autogen + sync test, SECURITY.md, CHANGELOG.md, release checklist, stability.md, setup guide, troubleshooting, `server.json`, MCPB `manifest.json`, `.cjs` launcher, release workflow, and — from 2026-07-29 — `.claude-plugin/plugin.json`). **Not done:** the npm publish itself, the MCP-registry submission, and clean-machine install testing of all channels. Those are outward, irreversible acts awaiting an explicit go-ahead. |
| M6 Messaging | **NOT STARTED — design review answered DEFER** | Review written: [messaging.md](messaging.md). Verdict **DEFER (NO-GO for v1)**; the conditions that would flip it are listed there. |

**Cross-cutting blocker.** The whole of Lane E (live QA, `T-E1`–`T-E4`) is
**BLOCKED**: there are no live Meta credentials in this environment, and no probe
has ever been run. Consequently *every* `[verify]` marker in
[corner-cases.md](corner-cases.md) §9 is still open, and no milestone whose exit
gate says "live" or "against a real account" can honestly be called DONE. What
exists is a complete, unit-tested implementation that has never met the platform.

**Named open risk — `discovery` shipped ahead of its gate — DECIDED 2026-07-29:
it stays registered.** M4 below stated the `discovery` package ships "only if the
M1 PCA probe said GO". That probe (T-E3) needs live Path-B credentials this
project does not have, so it cannot run and the decision was made without it.

The choice was: keep `discovery` in `reader`/`all`, or move it behind an explicit
`IG_TOOL_PACKAGES` opt-in. **Kept**, because the exposure the risk note describes
is already narrower than it reads:

- It is **not** in the default `core` profile. Reaching it takes a deliberate
  `IG_TOOL_PACKAGES=reader` / `=all` — that is itself an opt-in, just a coarser one.
- D1 capability filtering (`src/mcp/registry.ts`) registers a `paths: ['fb-login']`
  tool only when some configured profile is actually on Path B, with a second
  call-time guard behind it. A Path-A deployment never sees these three tools at
  all, whatever profile it selects.
- Every one of the three descriptions carries the PCA honesty note in its own
  text, so a model reads the App-Review caveat before it ever calls.
- The failure mode is a mapped error, not a crash: Meta's 10/200-series code
  becomes `kind: 'permission'` with remediation (`src/core/errors.ts`).
- `all` means *every package*. Excluding one from it would make the profile lie.

What is given up: an operator on Path B who selects `reader` may get a permission
error from three of fifteen tools. That is a documented, recoverable outcome, not
data loss. **This is reversible** — if the probe ever runs and says NO-GO, drop
`'discovery'` from the `reader` and `all` profile lists in `src/mcp/registry.ts`
and the snapshot test will pin the new counts.

**Preamble reconciled 2026-07-29.** `npm run check` used to be
`lint + format:check + build + test`, with coverage and `npm audit` living only as
separate CI jobs — so the local gate was weaker than the sentence at the top of
this file claimed. It now really is
`lint + format:check + build + coverage + audit`, with the coverage thresholds
passed as `c8` CLI flags (c8 v10 does **not** read a `c8` key from
`package.json`, so a config block there would have been silently ignored).

## Design decisions to ratify before coding (Gate D)

These came out of the six-role review as load-bearing and unresolved. Each gets a
short written decision (a paragraph in the relevant doc) **before M1 starts**;
none needs a prototype first.

| ID | Decision | Options on the table | Blocks | Status |
|---|---|---|---|---|
| **D1** | Auth-path capability matrix mechanism | (a) `ToolSpec.paths: ('ig-login'\|'fb-login')[]` metadata + registry filtering + call-time guard — recommended; (b) v1 simplification: one auth path per process | M1 registry | **DONE** — (a) shipped: `ToolSpec.paths` in `src/mcp/define.ts`, filtering in `src/mcp/registry.ts` |
| **D2** | Token-refresh persistence across config channels (CC-AUTH-4, CC-AUTH-14) | (a) XDG file is the only token home; client env documented as "static token, no auto-refresh, `token_status` warns"; (b) token indirection (env holds a reference, file holds the token); (c) refresh-in-place guidance per channel | M2 auto-refresh | **DONE** — (a) chosen and implemented (`src/core/refresh.ts` header, `refresh` CLI is the sole writer); [auth.md](auth.md) §3/§5 updated to match 2026-07-29 |
| **D3** | Human confirmation for writes (security review C1) | (a) MCP **elicitation** for `apply`/destructive confirms where the client supports it, env-flag fallback otherwise — recommended; (b) env flags only (status quo, documented as model-controllable) | M2 write gate | **DONE 2026-07-29** — (a) landed: `WriteConfirmer` seam in `src/mcp/write-mode.ts`, `serverConfirmer()` adapter in `src/mcp/registry.ts`, documented in [security.md](security.md) §4. The prompt is the **third** gate, after `apply` and `IG_ALLOW_DESTRUCTIVE`, so it can only ever refuse an already-permitted write. Fails closed on decline/cancel/timeout/transport error; clients without `elicitation.form` keep the exact env-flag behaviour. |

Recorded alongside (no debate expected, written down so they are deliberate):
v1 MCP surface is **tools-only** (no Resources/Prompts); **no proxy support**
in v1 (`igRequest` talks straight to Meta); `doctor` surfaces the Meta app's
**Development vs Live mode** (dev-mode apps may face lower limits — `[verify]`).

## M0 — Scaffold (size M) — **PARTIAL**

**Left:** work item 4 only — the npm name is **not reserved** (`instagram-mcp-ai`
returns 404 on the registry as of 2026-07-29). Items 1–3 and 5 are done.

**Goal:** a repo where `npm run check` is green with zero tools registered.

Work items:
1. `git init` + `.git/info/exclude` for local AI-harness files; npm scaffold,
   TypeScript ESM `module: Node16`, **Node ≥ 22** engines + `.nvmrc`;
   MIT `LICENSE` file.
2. ESLint 9 flat config with the 4-layer `no-restricted-imports` boundaries,
   `no-console` (CC-PROC-1), Prettier, `node:test` + `c8` + `fast-check` harness
   wired to built output.
3. CI skeleton: lint/format/build/test matrix (Node 22/24 × ubuntu/macOS/Windows),
   `npm audit`, CodeQL.
4. **Reserve the npm name**: publish a `0.0.1` stub of `instagram-mcp-ai`
   (verified available 2026-07-21; adjacent names are squatted — this is the
   cheapest insurance in the plan).
5. `.env.example` generated from the architecture §12 env catalog (sync test
   stubbed now, enforced from M1).

Exit gate: green check on all CI legs; npm name owned; `CC-PROC-1` lint rule
proven by a failing-then-fixed test.

## M1 — Core read path (size L) — **PARTIAL**

**Left:** items 1–5 are DONE (core substrate, both auth providers, `account` +
`media` packages, registry + manifest snapshot, pagination/truncation/fencing,
`doctor`). Item 6's **harness** landed 2026-07-29 (`scripts/capture-fixtures.mjs`,
`test/helpers/sanitize.ts`, `test/fixtures/`), but it has never been pointed at a
live account, so every fixture in the tree is still hand-written. Item 7 is
**BLOCKED** — no live probe has run and the **PCA probe is unanswered** (its
consequence was decided without it; see M4). The exit gate below is therefore
**not met**.

**Goal:** real reads against a live IG professional account on **both** auth
paths, with the full safety substrate underneath.

Work items:
1. `core/`: settings, config + profiles (`AsyncLocalStorage`), errors
   (`InstagramError` with `kind`), stderr JSON logging, redaction, host allowlist,
   `igRequest` with retry matrix + usage-header parsing + semaphore +
   AbortSignal (CC-PROC-2), **injectable clock** (qa F1; CC-AUTH-13).
2. Auth providers per **D1/D2** decisions: token-in-env for both paths,
   per-profile auth-mode resolution (CC-CFG-2), startup validation
   (CC-AUTH-5/6/7).
3. `api/account.ts`, `api/media.ts`; packages `account` + `media` (read-only);
   registry + PACKAGES manifest + snapshot test; package-resolution order test
   (CC-CFG-7).
4. Pagination + truncation: cursor rebuild (never follow `paging.next` raw),
   `fetchAll` caps (CC-DATA-1/3/4), open enums + passthrough output schemas
   (CC-DATA-6/7); **injection fencing** for untrusted text in results
   (comments/captions marked as data, not instructions — security C2).
5. `doctor` CLI (token validity, account resolution, scopes, usage snapshot).
6. **Fixture capture** — **DONE 2026-07-29** (harness only). `scripts/capture-fixtures.mjs`
   records live responses, `test/helpers/sanitize.ts` strips IDs/tokens/PII,
   `test/helpers/fixtures.ts` loads them into unit tests, and
   `test/release/fixtures.test.ts` locks the sanitizer's guarantees so a fixture
   carrying a real token can never be committed unnoticed. `test/fixtures/` holds
   the schema README and one hand-written example. **The harness is ready; no
   live fixture has been captured** — that needs credentials (workplan T-E1).
7. **Live probes** (junk account) — **BLOCKED, no credentials.** Both auth paths
   smoke-tested; the **hashtag/PCA App-Review probe** — does `ig_hashtag_search`
   work for an own-app admin without the "Instagram Public Content Access"
   feature? The probe was to decide the `discovery` package's fate; since it
   cannot run, that decision was made without it — see the open-question register
   below (workplan T-E2/T-E3).

Corner cases owed: all CC-AUTH-1..13 (except 14), CC-RATE-1/2/3/6,
CC-DATA-1..7, CC-CFG-1/2/3/5/6/7, CC-PROC-2/4/6.

Exit gate: `get_account`, `list_media`, `token_status` work on both paths against
a real account; manifest snapshot in place; PCA probe answered and recorded.

## M2 — Publishing + write safety (size L, the riskiest phase) — **PARTIAL**

**Left:** items 1–5 are implemented and unit-tested (write gate + append-only
journal, 7 publishing tools incl. the three composites, media validation, `login`
and `refresh` CLIs, redaction of minted tokens), and item 1's D3 elicitation half
landed 2026-07-29. One gap remains: item 6's *live* protocol has never run, so the
exit gate ("real image + reel published") is **unmet**. The container
state-machine unit tests exist; the live half does not.

**Goal:** a real image post and a real reel published end-to-end via
preview → apply, with the duplicate-post chain provably broken.

Work items:
1. Write gate per **D3**: `mcp/write-mode.ts`, preview = read-only GETs only,
   write journal (append-only `O_APPEND` JSON lines — CC-PROC-5, CC-PUB-16).
2. `api/publishing.ts` + `publishing` package: container create (no `media_type`
   for feed images), status, publish, runtime quota read; container state-machine
   handling per the operations.md subcode table (CC-PUB-1/3/4/12/14).
3. Composites (`post_image`, `post_reel`, `post_story`): 60 s poll budget,
   resumable in-progress results, `resume_container_id` input (CC-PUB-2),
   carousel child orchestration (CC-PUB-5/6).
4. Client-side media validation: JPEG-only, size/aspect/duration limits,
   code-point caption counting (CC-PUB-9/10/11); URL pitfalls documented
   (CC-PUB-7/8).
5. `login` CLI (both paths: loopback callback, `state` check) + Path-A
   auto-refresh per **D2** (CC-AUTH-2/3/4/14); atomic comment-preserving env-file
   writes (CC-CFG-4); redaction learns **runtime-minted tokens** (login/refresh
   outputs, `appsecret_proof` values — security C3).
6. **Container state-machine test plan** (qa condition): every
   status/subcode transition as a unit test over mocked fetch; live protocol:
   stories-first (self-expiring), minimal feed posts.

Corner cases owed: CC-PUB-1..16, CC-AUTH-2/3/4/14, CC-RATE-5, CC-CFG-4,
CC-PROC-3/5.

Exit gate: real image + reel published via preview → apply; quota decrement
observed and reported; kill-switch (`IG_PACKAGES_READONLY=publishing`) verified;
no code path can publish twice from one instruction.

## M3 — Moderation (size M) — **PARTIAL**

**Left:** the live half only. The `comments` package ships **9** tools (the plan
said 8 — `instagram_set_comments_enabled` landed here rather than in `media`),
the `IG_ALLOW_DESTRUCTIVE` double gate is implemented and unit-tested, and
hide-vs-delete guidance is in the docs. The live probes for hide rules and length
caps (CC-COM-5/6) are **BLOCKED**, so the exit gate ("moderation flow exercised
live") is unmet; only its second half ("destructive gate proven by test") holds.

Work items: `api/comments.ts` + `comments` package (list/get/reply/create/
hide/unhide/delete + `list_tagged_media`); `IG_ALLOW_DESTRUCTIVE` double gate
(CC-COM-7); one-level threading and disabled-comments handling (CC-COM-2/3);
hide-vs-delete guidance in docs; live probes for hide rules and length caps
(CC-COM-5/6).

Corner cases owed: CC-COM-1..7.
Exit gate: moderation flow exercised live; destructive gate proven by test.

## M4 — Insights & discovery (size M) — **PARTIAL**

**Left:** `insights` (4 tools) and `discovery` (3 tools) are both implemented,
unit-tested and registered; D1 capability filtering is enforced and
snapshot-tested. One gap is left open, and one was closed by decision:

- Insights have **never been verified against real metrics** (exit gate unmet);
  CC-INS-4 (timezone) and the post-2025 metric enums remain `[verify]`.
- **The `discovery` gate was skipped — settled 2026-07-29.** The text below says
  the package ships "only if the M1 PCA probe said GO". T-E3 cannot run without
  live Path-B credentials, so the decision was taken without it: the package
  **stays registered** in `reader` and `all`, on the double-gating and
  error-mapping grounds set out in the named-open-risk block near the top of this
  file. Reversible if the probe ever runs and says NO-GO.

Work items: `api/insights.ts` with the per-`media_product_type` **metric matrix**
(CC-INS-2), post-2025 metric enums (CC-INS-7), 90-day retention clamping
(CC-INS-3), demographics `timeframe` handling (CC-INS-1), timezone probe
(CC-INS-4), `online_followers` watch-list handling (CC-INS-6). `discovery`
package (shipped without the probe — see above): hashtag budget tracker
(advisory in-process counter — CC-RATE-4), `business_discovery`.

Corner cases owed: CC-INS-1..7, CC-RATE-4.
Exit gate: insights verified against the junk account's real metrics; capability
matrix (D1) enforced end-to-end and snapshot-tested.

## M5 — Distribution (size M) — **PARTIAL**

**Left:** the artifacts exist; the *shipping* does not.

- **DONE:** `.cjs` bin launcher + `prepublishOnly` gate + `provenance: true`;
  `server.json`; MCPB `manifest.json`; README generated sections with the
  `test/docs-sync.test.ts` drift guard; `SECURITY.md`, `CHANGELOG.md`,
  `docs/release-checklist.md`, the three-channel version-drift test,
  `docs/stability.md`, `docs/setup-guide.md`, `docs/troubleshooting.md`; the
  OIDC release workflow.
- **DONE 2026-07-29:** the **Claude Code plugin manifest**
  (`.claude-plugin/plugin.json`), a fourth install channel. It is deliberately
  **outside** the npm tarball's `files` allowlist — the plugin channel installs
  from git, not from `node_modules` — and a test locks that exclusion in.
- **NOT DONE:** the npm publish itself (nothing is on the registry at all — not
  even the M0 stub); the MCP-registry submission.
- **BLOCKED (live/clean-machine):** the MCPB token-acquisition story for non-CLI
  users, and the exit gate's install testing of all three channels. See
  [release-checklist.md](release-checklist.md) §"Current status" for the same
  breakdown at step granularity.

Work items: npm publish with provenance (trusted publishing / OIDC) + `.cjs`
launcher; `server.json` + MCP-registry publish (`io.github.IvanBBaev/instagram-mcp-ai`);
Claude Code plugin manifest (`.claude-plugin/plugin.json`);
MCPB bundle with keychain-backed `user_config` + a token-acquisition story for
non-CLI users (devops condition); README generated sections (tool table, env
catalog) with sync tests; SECURITY.md, CHANGELOG.md, release checklist,
three-channel version-drift test;
**user-facing setup guide + troubleshooting table** (`docs/setup-guide.md`,
`docs/troubleshooting.md` — Meta-app creation through token-in-hand, both paths);
**tool-surface stability/semver policy + config-tier matrix**
(`docs/stability.md`: tool rename = breaking, deprecation via dual registration;
token-only vs full config tiers). The doc items can start much earlier
(workplan T-R1/T-R2) and are only *finalized* here.

Exit gate: all three channels (npm / registry / MCPB) install-tested from clean
machines; generated docs proven in sync by CI.

## M6 — Messaging (optional, gated design review first) — **NOT STARTED (review says DEFER)**

Path choice (A `instagram_business_manage_messages` vs B via Page), messaging
windows/policy, webhook question, write-safety shape for DMs. Ships dark until
its own review passes.

**The review is written: [messaging.md](messaging.md) — verdict DEFER
(NO-GO for v1).** No messaging code should be started. Summary of the reasoning:
sends need a gate stricter than the existing preview→apply +
`IG_ALLOW_DESTRUCTIVE` pair (a DM is not "destructive" under the shipped
taxonomy, so it would ship behind a model-set boolean alone); incoming DM text is
attacker-controlled and closes a private two-way loop that injection fencing
mitigates but does not control; the policy constraints rest on `[verify]` items
that need live credentials Lane E does not have; and one open question — whether
Meta requires an active `messages` webhook subscription for *sends* — could turn
DEFER into a permanent NO-GO for a loopback-only server. Six conditions to flip
the verdict are listed in messaging.md §7; re-opening M6 means updating that file
and re-issuing the verdict there.

## Later / explicitly parked

- Webhook receiver for real-time comments/DMs (needs public endpoint).
- Operator-storage upload helper (S3 etc.) easing the public-URL constraint —
  would add `rupload.facebook.com`-class hosts to the allowlist only then.
- Product tagging / shopping, collab posts, boosting — niche until requested.
- SDK v2 migration via `npx @modelcontextprotocol/codemod v1-to-v2` once GA
  settles.

## Open-question register (tracked; blocking their phase, not the project)

1. **D1–D3 decisions** — before M1 (D1), before M2 (D2, D3).
   **D1 DONE · D2 DONE · D3 DONE** (2026-07-29; see the Gate D table). Gate D is
   closed.
2. Hashtag/PCA App-Review gate — M1 probe; decides M4 `discovery`.
   **DECIDED WITHOUT THE PROBE 2026-07-29 — `discovery` stays registered.** The
   probe itself is still unanswerable (no live Path-B credentials), but the plan
   and the code no longer disagree: the reasoning and the one-line reversal are
   recorded in the named-open-risk block at the top of this file. Re-open if
   T-E3 ever runs and returns NO-GO.
3. Live `[verify]` register in [corner-cases.md](corner-cases.md) §9 — each item
   owned by the phase listed there. **ALL STILL OPEN** — Lane E has never run.
4. Messaging path + policy constraints — M6 design review.
   **ANSWERED — [messaging.md](messaging.md), verdict DEFER.**
5. *(new)* npm name reservation — `instagram-mcp-ai` is unclaimed on the registry
   (404, 2026-07-29). The M0 plan called this "the cheapest insurance in the
   plan"; it has not been bought. Adjacent names were already squatted in 2026-07.
