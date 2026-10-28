# Parallel Work Plan (3.0)

> Task view of [v3-analysis.md](v3-analysis.md), written 2026-10-28 in the
> shape of [workplan.md](workplan.md). It splits the 3.0 candidates into
> agent-sized tasks (`V3-*`) that can run **at the same time in separate
> branches without stepping on each other**. Sizes are the roadmap classes:
> S < half a day, M ≈ 1–2 days, L ≈ 3+ days, per task, for one agent.
>
> This is a plan for the analysis's recommendation (theme A), not a plan of
> record. Tasks marked **COND** or **BLOCKED** wait for an owner decision
> (v3-analysis §9) or a live probe. Nothing breaking merges before `2.0.0` is
> published (gate G3 below).

## 1. Working agreement

The v1 agreement ([workplan.md](workplan.md) §1) still applies: contract-first,
exclusive file ownership, a contract-bump protocol, mocks at the seams, tests
travel with the task, live credentials are a singleton. 3.0 adds the rules
below, because most 3.0 work lands on files that are already crowded
(§3 lists them).

1. **One task, one branch, one worktree.** Branch `task/V3-<id>-<slug>`,
   worktree `~/Development/_branches/instagram-mcp-v3-<id>`:

   ```sh
   git worktree add ~/Development/_branches/instagram-mcp-v3-h1 -b task/V3-H1-comments-split
   ```

   The branch is the claim. Before starting, run
   `git branch --list 'task/V3-*'`; a task that already has a branch is taken.
2. **Owned files are exclusive.** Every task row lists the files it owns.
   A file not in the row is read-only for that task. A file in two rows has
   an order between those two tasks (a `Depends on` entry), never two open
   branches at once.
3. **Hotspot files follow §3**, whoever owns the rest of the task. These are
   the files every feature has to touch (CHANGELOG, generated files,
   registration lists, the corner-case catalogue).
4. **Contracts are frozen after V3-01.** `src/core/types.ts`,
   `src/mcp/define.ts`, `src/core/clock.ts` and `test/helpers/` change only
   in a contract-bump task, merged on its own. A feature branch that needs a
   contract change stops and asks for one.
5. **Merges are serial.** One task merges into `main` at a time, by the merge
   protocol in §2. Branches never merge into each other.
6. **Splits keep their public names.** A hygiene split keeps the old module
   path as the place that exports the aggregate (`commentsTools`,
   `publishingTools`, the insights API functions), so importers and
   registration lists do not change in the same commit.
7. **Breaking changes wait for G3.** Until `2.0.0` is published, only
   additive tasks (marked `2.x-safe` below) merge into `main`.

## 2. Merge protocol (per task)

Run from the task's worktree, in this order:

1. `git fetch` and `git rebase main`.
2. Resolve hotspot conflicts by the §3 rule for that file, never by hand
   for generated files.
3. Regenerate what the task touches: `npm run gen:readme`,
   `npm run gen:manifest`.
4. Assign final corner-case IDs and refresh any catalogue counters (§3).
5. Set the task's `Status` cell in this file to **DONE** with the date.
6. `npm run check` green on the rebased branch.
7. From the main checkout: `git merge --ff-only task/V3-<id>-<slug>`, then
   `git worktree remove` and `git branch -d`.

If `main` moved while step 6 ran, start again at step 1. Fast-forward only:
a merge commit means someone skipped the rebase.

## 3. Hotspot files

The files below changed most often between 2026-10-24 and 2026-10-28
(`git log` counts in brackets). They are shared by design, so they get a
rule instead of an owner.

| File | Rule |
|---|---|
| `docs/corner-cases.md` (13) | Before V3-00: new rows go at the end of the owning section; the "§8 holds N of M rows", per-prefix tallies and citation-site counts are updated **only** in the rebase step (§2 step 4). Before merge, renumber new IDs to the next free number. After V3-00 the counters are gone and only the append and renumber rules remain. |
| `CHANGELOG.md` (10) | Bullets only, appended at the end of the matching `[Unreleased]` subsection. After V3-02 the file merges with `merge=union`, so two appends never conflict; check the order after the rebase. The breaking-changes section belongs to V3-R2. |
| `docs/v2-analysis.md` (10), `docs/v3-analysis.md`, `docs/roadmap.md` | Status cells only, changed in the merge step. Prose belongs to V3-R2. |
| `docs/architecture.md` (10), `docs/security.md` (4), `docs/stability.md` (5), `docs/auth.md` | Edit only the section the task row names. New sections are appended. No renumbering or rewording of other sections in a feature branch. |
| `docs/tools.md` (8) | One section per new tool, appended at the end of its package. |
| `README.md` (6), `manifest.json` (4) | Generated. On conflict take `main`'s copy, then rerun `gen:readme` / `gen:manifest`. Hand edits to `manifest.json` are limited to keys the generator does not own (V3-D1). |
| `package.json`, `package-lock.json` | Dependency and engine changes belong to the task that owns them (V3-M1, V3-X1, V3-X3, V3-X4). On a lock conflict take `main`'s lock and rerun `npm install`. |
| `src/index.ts` (6), `test/index.test.ts` (5) | Owned by lane P in order (V3-P1, then V3-P2). V3-X1 changes only the `MIN_NODE_MAJOR` constant and its tests, after V3-P2. |
| `src/tools/index.ts`, `src/mcp/registry.ts` (4), `test/mcp/registry.test.ts` (4) | Registration is one import plus one entry, appended at the end. The list order is pinned by a test, so the same task appends its names to the pinned expectation. |
| `.env.example` (2), `test/env-catalog.test.ts` (2) | A new variable is appended at the end of its group, in the same commit as its catalogue entry. |
| `docs/v3-workplan.md` (this file) | `Status` cells only, in the merge step. |

## 4. Tasks

### Wave 0 — serial foundation

Merged one after another before any lane opens. Each removes a collision
that would otherwise hit every later branch.

| ID | Task | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **V3-00** | Freeze the corner-case catalogue: archive closed rows, replace the exact citation count with a "every citation resolves" check, drop the hand-kept tallies (v3-analysis §6) | `docs/corner-cases.md`, `test/docs-catalog.test.ts`, `test/source-citations.test.ts` | Owner decision §9.6 | M | NOT STARTED |
| **V3-01** | Contract bump: `CredentialProvider` interface, journal port interface, `ToolContext` fields for the injected singletons (hashtag budget, HTTP semaphores, redactor) and for a read-only view of all profiles. Defaults reproduce today's behaviour; nothing is wired yet | `src/core/types.ts`, `src/mcp/define.ts`, `test/helpers/`, `test/contracts.test.ts`, `test/mcp/define.test.ts` | — | M | NOT STARTED |
| **V3-02** | Merge plumbing: `CHANGELOG.md merge=union` in `.gitattributes` | `.gitattributes` | — | S | **DONE** 2026-10-28 |

V3-00 can run in parallel with V3-01 and V3-02 (no shared files). If the
owner declines the freeze, skip V3-00 and keep the "before V3-00" rule in §3.

### Lane H — hygiene splits (`2.x-safe`, no behaviour change)

| ID | Task | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **V3-H1** | Split comment tools into read and write modules | `src/tools/comments.ts` (keeps the aggregate export), new `src/tools/comments-read.ts`, `src/tools/comments-write.ts`, `test/tools/comments.test.ts` (may split the same way) | — | M | NOT STARTED |
| **V3-H2** | Split publishing tools into container tools, composites and delete | `src/tools/publishing.ts` (keeps the aggregate export), new `src/tools/publishing-*.ts`, `test/tools/publishing.test.ts` | — | M | NOT STARTED |
| **V3-H3** | Split the insights metric catalogue from the fetch code | `src/api/insights.ts`, new `src/api/insights-catalogue.ts`, `test/api/insights.test.ts` | — | S | NOT STARTED |

The three share no files and can run together from day one.

### Lane P — auth and Path C (one lane, serial inside)

| ID | Task | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **V3-P1** | Credential-provider port: profiles load through a provider; the file provider is the default; refresh writes back through it | `src/core/config.ts`, `src/core/refresh.ts`, new `src/core/credentials.ts`, `src/index.ts` (`loadProfiles` only), `test/core/config.test.ts`, `test/core/refresh.test.ts`, new `test/core/credentials.test.ts`, `test/index.test.ts`, `docs/architecture.md` (credentials section) | V3-01 | L | NOT STARTED |
| **V3-P2** | Stop mutating `process.env` during bootstrap | `src/index.ts`, `test/index.test.ts` | V3-P1 | M | NOT STARTED |
| **V3-P4** | `enable_fb_login` parameter in the login CLI (`2.x-safe`) | `src/cli/login-args.ts`, `test/cli/login.test.ts`, `docs/auth.md` (login section) | — | S | **DONE** 2026-10-28: `login --hide-fb-login`; also touched `src/cli/login.ts`, `src/cli/login-exchange.ts`, `docs/setup-guide.md` |
| **V3-P3** | Path C: Unified Login token shape, login flow without a Page lookup, doctor and scope checks | `src/cli/login.ts`, `src/cli/login-exchange.ts`, `src/cli/login-args.ts`, `src/cli/scopes.ts`, `src/cli/doctor.ts`, `src/core/auth.ts`, `src/core/token-shapes.ts`, `test/cli/*`, `test/core/auth.test.ts`, `test/core/token-shapes.test.ts`, `docs/auth.md`, `docs/setup-guide.md` | V3-P1, V3-P4, G3, owner decision §9.2 | L | BLOCKED (owner decision, live app for `[verify]` rows) |

V3-P4 can run in Wave 1 alongside V3-P1: they share no files. V3-P3 comes
last in the lane because it owns the files of both.

### Lane S — hosted-door seams (`2.x-safe`)

| ID | Task | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **V3-S1** | Inject the process-wide singletons through `ToolContext` | `src/core/http.ts`, `src/core/redact.ts`, `src/tools/discovery.ts`, `test/core/http.test.ts`, `test/core/redact.test.ts`, `test/tools/discovery.test.ts` | V3-01 | M | NOT STARTED |
| **V3-S2** | Journal port with an identity field | `src/mcp/write-mode.ts`, `test/mcp/write-mode.test.ts` | V3-01 | S–M | NOT STARTED |

### Lane M — MCP protocol (`2.x-safe`)

| ID | Task | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **V3-M1** | SDK 2.4.x bump and the schema audit (v3-analysis §4.2). On 2026-10-28 `src/` used none of the three changed features (`.meta`, `x-mcp-header`, `$id`), so the audit is expected to be a test run | `package.json` and `package-lock.json` (SDK lines), `plugins/instagram-mcp-ai/package*.json` | — | S | NOT STARTED |
| **V3-M2** | Skills extension (`skill://`): ship workflow skills next to the prompts | new `src/mcp/skills.ts`, new skill content directory, one line in `src/mcp/registry.ts`, `test/mcp/registry.test.ts` (append), new `test/mcp/skills.test.ts`, `docs/tools.md` (new section), `package.json` `files` | V3-M1 | S–M | NOT STARTED |

If V3-M1's audit does find a fix in a file another open task owns, the fix
goes into that task or waits for it to merge.

### Lane F — features

| ID | Task | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **V3-F1** | Multi-account fan-out: one report across profiles, per-profile write gates | new `src/tools/fanout.ts`, new `test/tools/fanout.test.ts`, one line in `src/tools/index.ts`, `test/mcp/registry.test.ts` (append), `src/core/settings.ts`, `test/core/settings.test.ts`, `.env.example` and `test/env-catalog.test.ts` (append), `docs/tools.md` (new section) | V3-01, V3-S2 | S–M | NOT STARTED |

### Lane D — distribution (`2.x-safe`)

| ID | Task | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **V3-D1** | Plugin listing: title and hint on every tool, privacy policy, `privacy_policies` manifest key | `plugins/instagram-mcp-ai/**`, new `docs/privacy.md`, `manifest.json` (non-generated keys), `test/release/plugin-manifest.test.ts`, `test/release/mcpb-manifest.test.ts`, `test/mcp/tool-metadata-contract.test.ts` (assertions only) | — | S | NOT STARTED |
| **V3-D2** | Keep `server.json` current with the registry schema | `server.json`, `test/release/version-consistency.test.ts` | — | S | **DONE** 2026-10-28, no change: `2025-12-11` is still the registry's current schema and `server.json` validates against it |

### Lane X — sweeping changes (solo windows)

These touch files across the whole tree. Each runs when **no other branch
is open**, or every open branch rebases right after it merges. Never two at
once.

| ID | Task | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **V3-X4** | Docs-only fast lane and sharded `node --test` (`2.x-safe`) | `package.json` (scripts), `.github/workflows/ci.yml`, `scripts/` | V3-M1 (both edit `package.json`) | S–M | NOT STARTED |
| **V3-X1** | Node floor `>=24`, CI matrix 24 and 26 | `package.json` (engines, `@types/node`), `package-lock.json`, `.nvmrc`, `.github/workflows/*.yml`, `src/index.ts` (`MIN_NODE_MAJOR`), `test/index.test.ts`, docs that name the floor | G3, V3-P2, V3-X4, owner decision §9.5 | S | BLOCKED (G3) |
| **V3-X3** | TypeScript 6/7 and `typescript-eslint` compatibility | `package.json`, `package-lock.json`, `tsconfig.json`, ESLint config, compile fixes anywhere | V3-X1 | S | NOT STARTED |
| **V3-X2** | Graph pin move from v25 to v26 or later | `src/core/host.ts`, `src/tools/ids.ts`, every test and fixture that names the pin, `test/docs-design.test.ts` (version allowlist), every doc that names the pin | Version after v26 confirmed `[verify]`, V3-E1 available for a re-run | S | BLOCKED (`[verify]`) |

### Lane E — live QA (single owner)

| ID | Task | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **V3-E1** | Lane E on Paths A and B, then at least once on Path C; settle the Path C `[verify]` rows | `docs/live-qa.md`, `docs/corner-cases.md` (the rows it settles) | Live credentials; V3-P3 for Path C | M | BLOCKED (live credentials) |

### Lane R — release

| ID | Task | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **V3-R1** | Removals warned in 2.x (`IG_PORT`, the old auth spelling, non-`[A-Z0-9_]` profile names), if 2.0 did not already remove them | the settings, env and profile-name modules involved, `.env.example`, `test/env-catalog.test.ts`, their tests | G3, V3-F1 (both edit `src/core/settings.ts`) | S | BLOCKED (G3) |
| **V3-R2** | Release docs: CHANGELOG breaking section, `docs/stability.md` §1, `docs/roadmap.md`, version bump, manifest snapshot | `CHANGELOG.md` (breaking section), `docs/stability.md`, `docs/roadmap.md`, `docs/v3-analysis.md`, version fields | Every task in scope | M | NOT STARTED |

### Conditional items (no owner yet)

These get a task row only after their condition clears. The files listed are
where they would land, so the order is known in advance.

| Item | Condition | Would own | Must come after |
|---|---|---|---|
| Messaging pull-only reads | Messaging probe 1 answers NO; messaging.md §7 holds (§9.4) | new `src/api/messaging.ts`, new `src/tools/messaging.ts`, `docs/security.md` §5 | V3-H1 |
| Local scheduling queue and `publish-due` | Owner decision §9.3 | new `src/cli/publish-due.ts`, `src/mcp/write-mode.ts` | V3-H2, V3-S2 |
| Collaborators, branded content on publish | Live probe of the Path A/B contradiction | `src/tools/publishing-*.ts`, `src/api/publishing.ts` | V3-H2 |
| Collaborative media list | Operator ask | `src/api/media.ts`, `src/tools/media.ts` | — |
| Resumable upload | Path C landed, upload helper gap confirmed | `src/api/publishing.ts`, `src/core/host.ts` (new host) | V3-P3, V3-H2 |
| MCP Apps preview UI | Client support confirmed | new `src/mcp/apps.ts`, `src/mcp/registry.ts` | V3-M1 |
| Tasks into core, events, risk metadata | Spec lands them | `src/mcp/*` per item | V3-M1 |

## 5. Dependency graph

```text
Wave 0:  V3-00 ─┐   V3-01 ─┬─> V3-P1 ─> V3-P2 ─┐
         V3-02 ─┘          ├─> V3-S1            │
                           ├─> V3-S2 ─> V3-F1 ─>│─> V3-R1 (G3)
                           │                    │
Wave 1:  V3-H1  V3-H2  V3-H3  V3-P4  V3-D1  V3-D2  V3-M1 ─> V3-M2
                                  │                  └──> V3-X4 ─┐
G3 (2.0.0 published):             └──> V3-P3 (after P1) ─> V3-E1  │
                                       V3-X1 (after P2, X4) <────┘
                                       V3-X1 ─> V3-X3
Late:                                  V3-X2 (after [verify]) ─> V3-E1 re-run
Release:                               V3-R2 (after everything in scope)
```

## 6. Gates and waves

| Gate | Exit criterion |
|---|---|
| **G0** | V3-01 and V3-02 merged; V3-00 merged or declined by the owner |
| **G1** | Lane H merged: the crowded tool files are split before features land on them |
| **G2** | V3-P1, V3-S1, V3-S2 merged: the seams Path C and fan-out build on |
| **G3** | `2.0.0` published; `main` is the 3.0 line; breaking tasks may merge |
| **G4** | V3-E1 passed on Paths A, B and C |
| **G5** | V3-R2 merged; v3-analysis §8 gates all met |

| Wave | Open in parallel | Max branches |
|---|---|---|
| 0 | V3-00, V3-01, V3-02 | 3 |
| 1 (after G0) | V3-H1, V3-H2, V3-H3, V3-P1, V3-P4, V3-S1, V3-S2, V3-M1, V3-D1, V3-D2 | 10 |
| 2 | V3-P2, V3-M2, V3-F1; then V3-X4 alone | 3, then 1 |
| 3 (after G3) | V3-P3, V3-R1; then V3-X1 alone, then V3-X3 alone | 2, then 1 |
| 4 | V3-E1; V3-X2 alone when unblocked; V3-R2 last | 1 |

Wave 1 is the payoff: ten tasks with no shared owned files. They meet only on
the hotspot files in §3, and the rules there make those meetings mechanical.

## 7. Agent task brief (template)

```text
Task: V3-<id> — <title>         Branch: task/V3-<id>-<slug>
Worktree: ~/Development/_branches/instagram-mcp-v3-<id>
Claim: `git branch --list 'task/V3-*'` first; stop if the branch exists.
Read first: docs/v3-analysis.md §<n>, docs/v3-workplan.md §1–§3, your CC rows.
You own ONLY: <owned files> (+ colocated tests). Everything else is read-only.
Hotspot files: follow docs/v3-workplan.md §3 exactly.
Contracts (src/core/types.ts, src/mcp/define.ts, src/core/clock.ts,
test/helpers/) are frozen; if you need a change, stop and ask for a contract bump.
Done: tests green, `npm run check` green after `git rebase main`, owned docs
updated, CHANGELOG bullet appended, merged by the §2 protocol, worktree and
branch removed.
House rules: English only; no AI attribution; no secrets; layer imports
core ← api ← mcp ← tools.
```
