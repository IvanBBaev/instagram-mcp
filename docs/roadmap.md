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

## Design decisions to ratify before coding (Gate D)

These came out of the six-role review as load-bearing and unresolved. Each gets a
short written decision (a paragraph in the relevant doc) **before M1 starts**;
none needs a prototype first.

| ID | Decision | Options on the table | Blocks |
|---|---|---|---|
| **D1** | Auth-path capability matrix mechanism | (a) `ToolSpec.paths: ('ig-login'\|'fb-login')[]` metadata + registry filtering + call-time guard — recommended; (b) v1 simplification: one auth path per process | M1 registry |
| **D2** | Token-refresh persistence across config channels (CC-AUTH-4, CC-AUTH-14) | (a) XDG file is the only token home; client env documented as "static token, no auto-refresh, `token_status` warns"; (b) token indirection (env holds a reference, file holds the token); (c) refresh-in-place guidance per channel | M2 auto-refresh |
| **D3** | Human confirmation for writes (security review C1) | (a) MCP **elicitation** for `apply`/destructive confirms where the client supports it, env-flag fallback otherwise — recommended; (b) env flags only (status quo, documented as model-controllable) | M2 write gate |

Recorded alongside (no debate expected, written down so they are deliberate):
v1 MCP surface is **tools-only** (no Resources/Prompts); **no proxy support**
in v1 (`igRequest` talks straight to Meta); `doctor` surfaces the Meta app's
**Development vs Live mode** (dev-mode apps may face lower limits — `[verify]`).

## M0 — Scaffold (size M)

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

## M1 — Core read path (size L)

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
6. **Fixture capture**: live responses recorded during probes are sanitized
   (IDs, tokens, PII) and stored as unit-test fixtures (workplan T-E1).
7. **Live probes** (junk account): both auth paths smoke-tested; the
   **hashtag/PCA App-Review probe** — does `ig_hashtag_search` work for an
   own-app admin without the "Instagram Public Content Access" feature? Outcome
   decides the `discovery` package's fate (ships in M4 vs stays dark).

Corner cases owed: all CC-AUTH-1..13 (except 14), CC-RATE-1/2/3/6,
CC-DATA-1..7, CC-CFG-1/2/3/5/6/7, CC-PROC-2/4/6.

Exit gate: `get_account`, `list_media`, `token_status` work on both paths against
a real account; manifest snapshot in place; PCA probe answered and recorded.

## M2 — Publishing + write safety (size L, the riskiest phase)

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

## M3 — Moderation (size M)

Work items: `api/comments.ts` + `comments` package (list/get/reply/create/
hide/unhide/delete + `list_tagged_media`); `IG_ALLOW_DESTRUCTIVE` double gate
(CC-COM-7); one-level threading and disabled-comments handling (CC-COM-2/3);
hide-vs-delete guidance in docs; live probes for hide rules and length caps
(CC-COM-5/6).

Corner cases owed: CC-COM-1..7.
Exit gate: moderation flow exercised live; destructive gate proven by test.

## M4 — Insights & discovery (size M)

Work items: `api/insights.ts` with the per-`media_product_type` **metric matrix**
(CC-INS-2), post-2025 metric enums (CC-INS-7), 90-day retention clamping
(CC-INS-3), demographics `timeframe` handling (CC-INS-1), timezone probe
(CC-INS-4), `online_followers` watch-list handling (CC-INS-6). `discovery`
package **only if** the M1 PCA probe said GO: hashtag budget tracker
(self-healing counter — CC-RATE-4), `business_discovery`; otherwise the package
ships dark with the probe result documented.

Corner cases owed: CC-INS-1..7, CC-RATE-4.
Exit gate: insights verified against the junk account's real metrics; capability
matrix (D1) enforced end-to-end and snapshot-tested.

## M5 — Distribution (size M)

Work items: npm publish with provenance (trusted publishing / OIDC) + `.cjs`
launcher; `server.json` + MCP-registry publish (`io.github.IvanBBaev/instagram-mcp-ai`);
MCPB bundle with keychain-backed `user_config` + a token-acquisition story for
non-CLI users (devops condition); README generated sections (tool table, env
catalog) with sync tests; SECURITY.md, CHANGELOG.md, release checklist,
three-channel version-drift test; Claude Code plugin manifest;
**user-facing setup guide + troubleshooting table** (`docs/setup-guide.md`,
`docs/troubleshooting.md` — Meta-app creation through token-in-hand, both paths);
**tool-surface stability/semver policy + config-tier matrix**
(`docs/stability.md`: tool rename = breaking, deprecation via dual registration;
token-only vs full config tiers). The doc items can start much earlier
(workplan T-R1/T-R2) and are only *finalized* here.

Exit gate: all three channels (npm / registry / MCPB) install-tested from clean
machines; generated docs proven in sync by CI.

## M6 — Messaging (optional, gated design review first)

Path choice (A `instagram_business_manage_messages` vs B via Page), messaging
windows/policy, webhook question, write-safety shape for DMs. Ships dark until
its own review passes.

## Later / explicitly parked

- Webhook receiver for real-time comments/DMs (needs public endpoint).
- Operator-storage upload helper (S3 etc.) easing the public-URL constraint —
  would add `rupload.facebook.com`-class hosts to the allowlist only then.
- Product tagging / shopping, collab posts, boosting — niche until requested.
- SDK v2 migration via `npx @modelcontextprotocol/codemod v1-to-v2` once GA
  settles.

## Open-question register (tracked; blocking their phase, not the project)

1. **D1–D3 decisions** — before M1 (D1), before M2 (D2, D3).
2. Hashtag/PCA App-Review gate — M1 probe; decides M4 `discovery`.
3. Live `[verify]` register in [corner-cases.md](corner-cases.md) §9 — each item
   owned by the phase listed there.
4. Messaging path + policy constraints — M6 design review.
