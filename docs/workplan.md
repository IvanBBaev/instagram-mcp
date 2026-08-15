# Parallel Work Plan (v1.0)

> Execution-level breakdown of [roadmap.md](roadmap.md) into small, agent-sized
> tasks (`T-*`) that can be developed **concurrently by independent agents**.
> The roadmap remains the milestone/gate view (M0–M6); this document is the task
> view. Each roadmap phase is reached by integrating a set of tasks at a gate
> (G1–G5 below). Sizes reuse the roadmap classes: S < half a day, M ≈ 1–2 days,
> L ≈ 3+ days — per task, for one agent.
>
> **Status (updated 2026-08-07).** Every table below carries a `Status` column:
> **DONE** · **PARTIAL** · **BLOCKED** · **NOT STARTED**, with a one-line note on
> what is left for anything that is not DONE. The headline: Lanes A–D are
> essentially complete as *code*, Lane R has produced its artifacts but shipped
> none of them, and **Lane E has never run at all** — there are no live Meta
> credentials in this environment, so every gate whose exit criterion is "live"
> is unmet. See [roadmap.md](roadmap.md) §"Current state" for the milestone view.
> Where a task's real files differ from its planned `Owned files`, the status
> cell says so rather than the plan being quietly rewritten.
>
> **What changed on 2026-08-07.** Lane E's status split in two, and the
> distinction is worth keeping: the *protocol* is now built and testable
> (`scripts/live-probe.mjs` — 26 probes, 7 lanes, three escalating consent flags),
> while *execution* is still blocked on credentials. "Blocked on a token" is a very
> different project state from "nobody has written the probe yet", and the earlier
> single **BLOCKED** label hid that. On Lane R, T-R8's second blocker closed: the
> repo is now its own plugin marketplace and the plugin prompts for its credential
> via `userConfig`, leaving the npm publish (T-03) as the only thing standing
> between the plugin channel and an install.
>
> **A note on the notes (2026-08-02).** Several status cells had accumulated
> "the docs still say X" complaints that were fixed in the docs without the
> complaint being retracted here — this file was reporting defects that no
> longer existed (T-04, T-A4, T-D2), and calling a shipped artifact missing
> (the plugin manifest, now T-R8). Every claim in this file was re-checked
> against the source on 2026-08-02. A status cell that names a defect in
> another file is a liability: it is read as current, and it ages silently.
> Prefer pointing at the file that holds the truth over restating it here.

## 1. Working agreement (what makes parallelism safe)

1. **Contract-first.** Task T-02 freezes the shared interfaces (`ToolSpec`,
   `InstagramError`, `IgRequestFn`, `AuthProvider`, config/profile shapes,
   `Clock`, test seams). Merging T-02 is **Gate G1** — nothing else starts
   before it; everything after it builds against those types with mocks.
2. **Exclusive file ownership.** Every task lists its owned files; a file
   belongs to exactly one task. Cross-cutting edits go through the owning task.
   Integration points are designed to be append-only one-liners (a new package
   = one import line in the registry), so merges stay trivial.
3. **Contract-change protocol.** After G1 the contract files are frozen.
   A needed change becomes a dedicated *contract-bump* PR touching only
   contract files, listing every impacted task; feature branches never edit
   contract files. This is the only coordination point between agents.
4. **Mocks at the seams.** Domain tasks (Lane D) build against a mocked
   `IgRequestFn` (the `withFetch` recording helper from T-02); auth/core tasks
   are consumed via their interfaces. No task waits for another's
   *implementation* — only for its *interface* (already frozen at G1).
5. **Tests travel with the task.** Definition of done for every task:
   its unit tests colocated and green, `npm run check` green locally with the
   rest of the system mocked, owned docs updated, corner cases from its
   `CC owed` column either tested or explicitly deferred to a live probe.
6. **Branch naming** `task/<id>-<slug>` (e.g. `task/T-D3a-publishing-primitives`);
   one PR per task; the task ID in the PR title.
7. **House rules** apply to every agent: English-only repo content, no AI
   attribution, secrets never in code/fixtures/logs, layer boundaries
   (`core ← api ← mcp ← tools`) enforced by lint.
8. **Live credentials are a singleton.** Only Lane E tasks touch the real junk
   account; everything else runs on mocks/fixtures. Lane E has a single owner
   at any time.

## 2. Serial foundation (Wave 0 — no parallelism yet)

| ID | Task & scope | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| **T-01** | **Scaffold** — npm/TS ESM `Node16`, Node ≥ 22 engines + `.nvmrc`, ESLint 9 flat (4-layer boundaries, `no-console` — CC-PROC-1), Prettier, `node:test` + `c8` + `fast-check` wired to built output, CI matrix (Node 22/24 × ubuntu/macOS/Windows), `npm audit` + CodeQL, MIT `LICENSE`, `.env.example` stub, `.git/info/exclude` for AI-harness files | root configs, `.github/workflows/`, `LICENSE` | — | M | **DONE** |
| **T-02** | **Contracts freeze** *(= Gate G1)* — `InstagramError` + `kind`, Graph envelope/paging types, `ToolSpec`/`ToolResult`/annotations, `AuthProvider` + auth-mode types, `IgRequestFn` signature + options, config/profile/settings shapes, `Clock` interface; test seams: `withFetch` recording mock, `fakeClock`, fixture loader | `src/core/types.ts`, `src/core/clock.ts`, `src/mcp/define.ts`, `test/helpers/` | T-01, T-04 (D1 shapes `ToolSpec.paths`) | M | **DONE** |
| **T-03** | **npm stub** — publish `instagram-mcp-ai@0.0.1` placeholder (name verified available 2026-07-21; adjacent names squatted) | stub `package.json` only | T-01 (minimal) | S | **NOT STARTED** — the registry returns 404 for `instagram-mcp-ai` (2026-07-29); the name is still unclaimed. `CHANGELOG.md` describes the stub as if it were published — it is not. |
| **T-04** | **Decision records** — ratify D1–D3 with the owner and write them into auth/architecture/security docs; record the no-debate decisions: tools-only MCP surface in v1 (no Resources/Prompts), no proxy support in v1, `doctor` surfaces Meta-app Development/Live mode | decision paragraphs in `docs/` | — (docs only; **needs owner sign-off**) | S | **PARTIAL — owner sign-off only** (2026-08-02). All three gates are decided, landed and written up: D1 in [roadmap.md](roadmap.md) §"Gate D" (`ToolSpec.paths` + registry filtering), D2 in [auth.md](auth.md) §5 ("RESOLVED, option (a)" — the XDG file is the sole token home), D3 in [security.md](security.md) §"Design gate D3" ("implemented" — MCP elicitation in `src/mcp/write-mode.ts`). The no-debate decisions are recorded too: tools-only surface and no-proxy in [roadmap.md](roadmap.md) line 87, and `doctor` does surface Development-vs-Live mode (`src/cli/doctor.ts` §"Meta app mode"). What is left is not a doc pass — it is the **owner's ratification**, which no agent can supply. |

## 3. Parallel lanes (all unblock at G1)

### Lane A — core substrate

| ID | Task & scope | Owned files | Depends on | CC owed | Size | Status |
|---|---|---|---|---|---|---|
| T-A1 | Config + profiles: env-file resolution (`IG_ENV_FILE` → XDG → project; `%APPDATA%` on win32), atomic comment-preserving `0600` writes, profiles via `AsyncLocalStorage` | `src/core/config.ts` | G1 | CC-CFG-1/2/3/5/8, CC-CFG-4 (mechanism) | M | **DONE** — the write half landed in a second file, `src/core/config-write.ts` |
| T-A2 | Settings + env catalog: every §12 knob as a documented reader (incl. `IG_TIMEOUT_MS`, `IG_LOG_LEVEL`); machine-readable catalog for generators; stderr JSON logger with levels + `safeUrl` | `src/core/settings.ts`, `src/core/log.ts` | G1 | — | M | **DONE 2026-07-30** — readers, logger and the machine-readable catalog were already done; the last knob, `IG_WRITE_JOURNAL`, now has a home in `core/settings.ts`. `Settings.writeJournal` (a Gate-G1 contract bump, landed on its own) is resolved by `loadSettings` and read by the gate as `ctx.settings.writeJournal`; `src/mcp/write-mode.ts` no longer touches `process.env`, and the resolver behind the field is module-private, so there is exactly one entry point. Safe because `loadEnvFiles()` runs immediately before `loadSettings()` in `src/index.ts`, so the value is final before any tool can run. |
| T-A3 | Redaction: mask configured secrets + token-shape patterns; **runtime-minted token registration API** (login/refresh outputs, `appsecret_proof`); `fast-check` property tests | `src/core/redact.ts` | G1 | — | S | **DONE** |
| T-A4 | HTTP client: host allowlist (SSRF), `igRequest` with retry matrix, `Retry-After` cap, semaphore (`IG_MAX_CONCURRENT`), `AbortSignal`, `IG_TIMEOUT_MS`, usage-header parsing, pinned `v25.0` | `src/core/host.ts`, `src/core/http.ts` | G1 (A2/A3 via interfaces) | CC-RATE-1/2/3/6, CC-PROC-2 | L | **DONE** — allowlist is the two Graph hosts only. `rupload.facebook.com` is deliberately excluded and now says so in all three places: `src/core/host.ts`, architecture §5, and [security.md](security.md) §3, which explains that it joins only when a resumable-upload phase ships, so v1 carries no dead allowlist entry. |
| T-A5 | Error mapping: Graph error envelope → `InstagramError` kinds; full subcode table from operations.md (80002, 2207051, 24/2207008, 9007/2207027, 9/2207042, 4/17/32/613); table-driven tests | `src/core/errors.ts` | G1 | mapping rows of the taxonomy | S | **DONE** |

### Lane B — MCP glue

| ID | Task & scope | Owned files | Depends on | CC owed | Size | Status |
|---|---|---|---|---|---|---|
| T-B1 | Registry + PACKAGES manifest: resolution order (profile → deny → readonly), invariant loop, **D1 capability filtering** (`ToolSpec.paths`), manifest snapshot test. New packages = one appended import line | `src/mcp/registry.ts` | G1 | CC-CFG-6/7 | M | **DONE** |
| T-B2 | Results: `{items, paging}` shape, code-point-safe char-budget truncation, `IG_PRETTY_JSON`, **injection fencing** wrapper marking untrusted text (comments, captions) as data; property tests | `src/mcp/result.ts` | G1 | CC-DATA-3/4, CC-PROC-6 | M | **DONE** |
| T-B3 | Write gate + journal per **D3**: preview/apply resolution, elicitation-or-env fallback, append-only `O_APPEND` JSON-lines journal | `src/mcp/write-mode.ts` | G1, T-04 (D3) | CC-PROC-3/5, CC-PUB-16 | M | **DONE 2026-07-29** — env-flag resolution, `0600` append-only journal, and the elicitation half all ship. The confirmation gate sits **third** in the chain, after `apply` and after `IG_ALLOW_DESTRUCTIVE`, so it can only refuse a write that is already permitted — it can never grant one. |
| T-B4 | Transports + entry: stdio (stdout purity), Streamable HTTP (loopback, `timingSafeEqual` bearer), `index.ts` Node guard + subcommand routing + bootstrap | `src/mcp/transport.ts`, `src/index.ts` | G1 | CC-PROC-1/4 | M | **DONE** — `login` / `doctor` / `refresh` subcommands all routed |

### Lane C — auth & CLI

| ID | Task & scope | Owned files | Depends on | CC owed | Size | Status |
|---|---|---|---|---|---|---|
| T-C1 | Auth providers: both paths, per-profile mode resolution, `appsecret_proof` on `graph.facebook.com` only, startup validation | `src/core/auth.ts` | G1 | CC-AUTH-5/6/10/11 | M | **PARTIAL** — providers DONE and host-driven as designed. **CC-AUTH-5 is retired, not skipped:** `src/core/config.ts` reads only `IG_ACCESS_TOKEN`, never `IG_FB_ACCESS_TOKEN`, so "both token vars set" is not a state the server can enter (see the note under §3) |
| T-C2 | Token metadata + status: `debug_token` (Path B) / `/me` fallback (Path A), expiry math on the injectable clock, scope inventory, usage snapshot; exposes `getTokenStatus()` consumed by T-D1's tool | `src/api/token-status.ts` | G1, C1 (interface) | CC-AUTH-1/7/9/12/13 | M | **DONE** — landed inside `src/api/account.ts`, not the planned `src/api/token-status.ts` |
| T-C3 | `login` CLI: loopback OAuth for both paths, random+checked `state`, code → short → long-lived exchange, persist via T-A1's writer, register minted token with T-A3 | `src/cli/login.ts` | A1, A3, C1 | CC-CFG-4 (exercise) | L | **PARTIAL** — implemented and unit-tested; the OAuth flow has **never been run against Meta** (BLOCKED on Lane E) |
| T-C4 | Refresh per **D2**: `ig_refresh_token`, `IG_REFRESH_AFTER_DAYS` threshold, re-read-before-write guard, per-channel policy | `src/core/refresh.ts` | C2, A1, T-04 (D2) | CC-AUTH-2/3/4/14 | M | **PARTIAL** — D2 option (a) implemented (`refresh` CLI is the sole writer, XDG is the only token home); CC-AUTH-14 stays `[verify]` until a live probe |
| T-C5 | `doctor` CLI: token validity, account resolution, scopes, quota, usage snapshot, **Meta-app Development/Live mode**, **config-tier report** (token-only vs full) | `src/cli/doctor.ts` | C1, C2 (rest mocked) | — | M | **PARTIAL** — implemented and unit-tested; never run against a live app |

### Lane D — domain packages (api + tools + tests per package; all mock `IgRequestFn` until G2)

| ID | Task & scope | Owned files | Depends on | CC owed | Size | Status |
|---|---|---|---|---|---|---|
| T-D1 | `account` package (3 tools; `token_status` wraps T-C2's function) | `src/api/account.ts`, `src/tools/account.ts` | G1, C2 (interface) | — | S | **DONE** — 3 tools as planned |
| T-D2 | `media` package (3 tools; carousel children, deleted-media handling, open enums + passthrough output schemas) | `src/api/media.ts`, `src/tools/media.ts` | G1 | CC-DATA-1/2/5/6/7 | S | **DONE — 2 tools, not 3**: `instagram_set_comments_enabled` shipped in the `comments` package instead, and architecture §4 now agrees — `media` reads "read-only", the toggle is listed under `comments`. The split is the right one: the tool writes, and every other write in the system is reached through a package whose tools all write. |
| T-D3a | `publishing` primitives (4 tools): container create (**no `media_type` for feed images**), status, publish (**never auto-retried**), runtime quota read; client-side media validation (JPEG-only, size/aspect/duration, code-point captions); `alt_text` support `[verify — live probe]` | `src/api/publishing.ts`, `src/api/media-spec.ts`, `src/tools/publishing.ts` | G1 | CC-PUB-1/3/4/7/8/9/10/11/12/14/15 | M | **DONE** (code) — `alt_text` and the CC-PUB `[verify]` rows still owe a live probe |
| T-D3b | `publishing` composites (`post_image`/`post_reel`/`post_story`): 60 s poll budget on the injectable clock, resumable results + `resume_container_id`, carousel orchestration, quota refusal | `src/tools/publishing-composites.ts` | D3a, B3 | CC-PUB-2/5/6/13, CC-RATE-5 | M | **DONE** (code) — merged into `src/tools/publishing.ts`; the planned separate file does not exist. Never run live. |
| T-D4 | `comments` package (8 tools): threading, disabled-comments, `IG_ALLOW_DESTRUCTIVE` double gate, **fencing applied to comment text** (via T-B2), `list_tagged_media` tags-vs-mentions semantics | `src/api/comments.ts`, `src/tools/comments.ts` | G1, B2/B3 (interfaces) | CC-COM-1..7 | M | **DONE — 9 tools** (absorbed `instagram_set_comments_enabled` from T-D2). CC-COM-5/6 still owe a live probe. |
| T-D5 | `insights` package (4 tools): per-`media_product_type` metric matrix, required `timeframe`, 90-day retention clamp, `online_followers` watch-list, `follower_count` metric `[verify — live probe]` | `src/api/insights.ts`, `src/tools/insights.ts` | G1 | CC-INS-1/2/3/5/6/7 | M | **DONE** (code) — never checked against real metrics; CC-INS-4 timezone still `[verify]` |
| T-D6 | `discovery` package (3 tools, **gated on T-E3 = GO**): local hashtag-budget tracker (30/7d, self-healing), `business_discovery` | `src/api/discovery.ts`, `src/tools/discovery.ts` | G1, **T-E3** | CC-RATE-4 | M | **DONE — gate decided without the probe 2026-07-29.** Code is complete and registered: absent from `core`, present in `reader` and `all`. T-E3 could not run (no Path-B credentials), so the choice between "keep it registered" and "move it behind an opt-in" was **decided rather than deferred** — it stays, reversibly; the reasoning and the one-line reversal (drop `'discovery'` from two profile lists in `src/mcp/registry.ts`) are in [roadmap.md](roadmap.md). Running the probe later can only confirm or reverse that call, so this task no longer blocks. |

### Lane E — live QA (single owner; the only lane touching real credentials)

> **Lane E has never run.** There are no live Meta credentials in this
> environment, so all four tasks below are **BLOCKED**. This is the single
> largest gap between what the repo contains and what the plan claims: the
> implementation is complete and unit-tested, and entirely unproven against the
> platform.

| ID | Task & scope | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| T-E1 | Fixture-capture harness: record live Graph responses, **sanitize** (IDs, tokens, PII), store as unit-test fixtures | `scripts/capture-fixtures.mjs`, `test/helpers/sanitize.ts`, `test/fixtures/` | G1 | S | **DONE 2026-07-29 — harness only.** Capture script, sanitizer (IDs/tokens/PII), fixture loader (`test/helpers/fixtures.ts`) and `test/release/fixtures.test.ts` (locks the sanitizer so a real token cannot be committed unnoticed) all ship. **No live capture has run** — every fixture in the tree is still hand-written; that half waits on T-E2 credentials. `.ts` in the original scope became `.mjs`: the script is run directly by `node`, not built through `tsc`. |
| T-E2 | M1 live-probe protocol (corner-cases §9): both auth paths smoke-tested on the junk account; answers read-side `[verify]` items (CC-INS-4 timezone, CC-AUTH-14); feeds T-E1 fixtures | `scripts/live-probe.mjs`, probe notes in `docs/corner-cases.md` §9 | read path integrated (pre-G2) | M | **HARNESS DONE 2026-08-07 · EXECUTION BLOCKED** — no credentials, so §9's `[verify]` register is still untouched. What changed: the protocol is no longer prose to work through by hand. `scripts/live-probe.mjs` implements it as **26 probes across 7 lanes**, each declaring in an `answers:` field which corner case it discharges, with a report that names skipped lanes and their reason rather than silently omitting them. Read-only by default; three escalating consent flags (`--allow-writes` → `--allow-feed-post` → `--allow-token-refresh`) gate the irreversible parts, and lanes are ordered so that everything answerable read-only runs first — a run that dies halfway has already banked CC-INS-4 and the whole PCA/hashtag lane without writing anything. Running it against a real account is all that remains. |
| T-E3 | **PCA/hashtag probe**: does `ig_hashtag_search` work for an own-app admin without App Review? Decides T-D6's fate. Runnable early with a throwaway script | `scripts/live-probe.mjs` (`discovery` lane), probe record in `docs/auth.md` §5 | C1 (or standalone script) | S | **HARNESS DONE 2026-08-07 · EXECUTION BLOCKED — no credentials.** The "throwaway script" is now the `discovery` lane of `scripts/live-probe.mjs` — 4 probes (`hashtag-search`, `hashtag-media`, `recently-searched-hashtags`, `business-discovery`), **read-only, no consent flag needed**, so this is the cheapest live task in the plan the moment a token exists. Its dependent no longer waits on it: the `discovery` gate was **decided without the probe on 2026-07-29** (package stays registered in `reader`/`all`; reasoning and the one-line reversal in [roadmap.md](roadmap.md)). Running it can only confirm or reverse that call. `recently-searched-hashtags` additionally reconciles the local 30/7d advisory counter against Meta's server-side count (CC-RATE-4). |
| T-E4 | Publishing/moderation live protocol: **stories-first** (self-expiring), minimal feed posts; answers CC-PUB-4 (double publish), CC-PUB-6 (mixed carousel), CC-PUB-11 (caption unit), CC-COM-5/6 (hide rules, length cap) | `scripts/live-probe.mjs` (`container`/`story`/`feed`/`comment`/`auth` lanes), probe notes in `docs/corner-cases.md` §9 | write path integrated (pre-G3) | M | **HARNESS DONE 2026-08-07 · EXECUTION BLOCKED** — no credentials; **no post has ever been published by this server.** The write lanes of `scripts/live-probe.mjs` implement the protocol stories-first exactly as specified, and encode the irreversibility in the flag design rather than in a warning: `container` (dry containers, never published), `story` and `comment` need `--allow-writes` (24 h expiry / deletable — recoverable), while `feed` needs a **separate** `--allow-feed-post` because a published feed post cannot be deleted via the API, and `auth` needs a **third** flag `--allow-token-refresh` because it rotates the live credential and rewrites the XDG env file. Neither of the last two is implied by `--allow-writes`. CC-COM-6's ladder brackets the undocumented cap by bisection and stops on a spam block (CC-COM-4) rather than reporting the block as a length answer. |

### Lane R — release & user docs (docs tasks can start right after T-04)

| ID | Task & scope | Owned files | Depends on | Size | Status |
|---|---|---|---|---|---|
| T-R1 | **Setup guide + troubleshooting**: Meta-app creation → both auth paths → token in hand, Development-vs-Live mode, troubleshooting table (top errors → causes → fixes) | `docs/setup-guide.md`, `docs/troubleshooting.md` | T-04; polish after E2 | M | **PARTIAL — blocked half only** (2026-07-30). Both docs are written and the `IG_FB_ACCESS_TOKEN` defect is **fixed**: the phantom variable is purged from both guides, which now document the single `IG_ACCESS_TOKEN` for both paths. What remains is the post-E2 polish (real error strings in the troubleshooting table), which is **BLOCKED — no credentials**. |
| T-R2 | **Stability policy + config tiers**: semver for the tool surface (rename = breaking; deprecation via dual registration), config-tier matrix (token-only vs full: what works, what degrades, refresh `[verify]`) | `docs/stability.md` | T-04 | S | **DONE** |
| T-R3 | README generated sections (tool table, env catalog) + docs-sync tests | `scripts/gen-readme.ts`, `test/docs-sync.test.ts` | B1, A2 | S | **DONE** — generator shipped as `scripts/gen-readme.mjs`; the drift test covers only README's two AUTOGEN blocks |
| T-R4 | npm packaging: `.cjs` bin launcher (Node guard → ESM `import()`), `prepublishOnly` full gate, provenance | `bin/instagram-mcp-ai.cjs` | T-01 | S | **DONE** — launcher, `prepublishOnly`, `provenance: true`, and an OIDC release workflow all in place |
| T-R5 | `server.json` + MCP-registry publish (`io.github.IvanBBaev/instagram-mcp-ai`), generated + sync-tested | `server.json`, gen script | R4, A2 | S | **PARTIAL** — `server.json` exists and is version-drift-tested; **the registry submission has not been made** |
| T-R6 | MCPB bundle: keychain-backed `user_config`, token-acquisition story for non-CLI users | MCPB manifest | R4, C3 | M | **PARTIAL** — `manifest.json` + `docs/mcpb-install.md` exist; the bundle has **never been built or installed** on a clean machine, and the non-CLI token-acquisition story is BLOCKED on live OAuth. `test/release/mcpb-manifest.test.ts` (2026-08-02, 14 tests) now guards the manifest against the drift a human eye cannot catch in JSON: a **phantom variable** (declared but read by no code — the `IG_FB_ACCESS_TOKEN` defect class, and worse here because it renders as a labelled form field that silently does nothing), a broken `env` ↔ `user_config` bijection, self-referencing interpolation, an unmasked credential, a required-ness flag that disagrees with what `loadProfiles` actually refuses to start without, a default that drifts from the server's, and the Node floor drifting from `package.json` `engines` (compared as parsed floors, so `>=22` and `>=22.0.0` are correctly the same). Defaults are read back from `DEFAULT_SETTINGS`/`selectPackages` rather than restated, with one deliberate exception: an independent `!== 'apply'` interlock that still fails if the *server* default is ever flipped, which the derived checks would otherwise happily agree with. The manifest is currently fully consistent — the tests were proven to bite against mutated copies, not against a passing file alone. |
| T-R7 | `SECURITY.md`, `CHANGELOG.md`, release checklist, version-drift test across every distribution channel | those files | — | S | **DONE** — the owed correction landed: `CHANGELOG.md` now states plainly that `0.0.1` is a pre-release placeholder, not a published version. The drift test grew from three channels to **four** as T-R8 added one; it is written to take a new channel as a new constant, so the next one costs a line. |
| **T-R8** | **Claude Code plugin manifest** — `.claude-plugin/plugin.json` declaring the stdio server, wired into the version-drift test as a fourth channel | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | R4 | S | **PARTIAL** (2026-08-02, revised 2026-08-07 — one of the two blockers is closed). The manifest declares the server as `npx -y instagram-mcp-ai@<version>` and **pins the version twice** — in `version` and inside the `npx` args — both covered by the (four-, not three-channel) version-drift test; the npx pin is parsed rather than exact-string-matched, so a floating `@latest` or a missing pin fails distinguishably from a stale one. `.claude-plugin/` is deliberately outside the npm tarball's `files` allowlist and `test/release/packaging.test.ts` asserts that exclusion: the plugin channel installs from git/marketplace, never from `node_modules`. **Closed since the first revision:** (a) the repo **is** now a marketplace — `.claude-plugin/marketplace.json` lists the single plugin with `"source": "./"`, so `/plugin marketplace add IvanBBaev/instagram-mcp` then `/plugin install instagram-mcp-ai@instagram-mcp` resolves; (b) the credential-UX gap is closed — `plugin.json` now declares `userConfig.IG_ACCESS_TOKEN` (`sensitive: true` → OS keychain, `required: true`) and wires it through `mcpServers.instagram.env` as `${user_config.IG_ACCESS_TOKEN}`, so the channel prompts exactly like the MCPB bundle instead of demanding a hand-placed env var. Both files validate against their published JSON schemas (ajv, draft-07), and `test/release/plugin-manifest.test.ts` (16 tests) locks the contract: no unrecognised field, no phantom variable (the `IG_FB_ACCESS_TOKEN` defect class), `env` interpolating *its own* `userConfig` key rather than a neighbour's, required-ness agreeing with what `loadProfiles` actually refuses to start without, and no credential value embeddable in either manifest. **The one remaining blocker is T-03** — `npx` resolves from npm and the name is still unpublished, so an install succeeds and the server then fails to launch. Operator page: `docs/plugin-install.md` (rewritten 2026-08-07 against the real manifests; its earlier "no marketplace / no userConfig" text described a state that no longer exists). Never executed by a real client — the `${user_config.…}` interpolation is schema-valid and unit-asserted but unproven end-to-end. |

**Config-var discrepancy — RESOLVED 2026-07-29 (affects T-A2, T-C1, T-R1).**
`IG_FB_ACCESS_TOKEN` was documented as the Path-B token variable in
`.env.example`, `README.md`, architecture §12, `docs/setup-guide.md`,
`docs/troubleshooting.md`, `docs/stability.md`, `docs/mcpb-install.md`,
`docs/index.html` and CC-AUTH-5 — but **no source file ever read it**, so a user
following the Path-B setup guide got a server with no token at all.

Resolved in favour of the code: there is **one** token variable,
`IG_ACCESS_TOKEN`, for both paths; the path decides the host and whether an
`appsecret_proof` HMAC is attached. This is what `src/core/config.ts` always
did, and it generalizes cleanly to named profiles (`IG_PROFILE_<NAME>_*`).
The path is inferred as `fb-login` from `IG_APP_ID` + `IG_APP_SECRET`, and
`IG_AUTH_MODE` (docs-canonical, with `IG_AUTH_PATH` accepted as an alias)
overrides the inference. Zero migration cost — the package is unpublished, so
there is no installed base. **CC-AUTH-5 is retired**: the "both token vars set"
state it guarded cannot exist.

## 4. Dependency graph

```mermaid
graph LR
  T01[T-01 scaffold] --> T02[T-02 contracts]
  T04[T-04 decisions D1–D3] --> T02
  T01 --> T03[T-03 npm stub]
  T02 --> G1{{G1 fan-out}}
  G1 --> A[Lane A core A1–A5]
  G1 --> B[Lane B mcp B1–B4]
  G1 --> C[Lane C auth C1–C5]
  G1 --> D[Lane D packages D1–D5]
  G1 --> E1[T-E1 fixtures]
  T04 --> R[Lane R docs R1–R7]
  A --> G2{{G2 = M1 exit: read path live}}
  B --> G2
  C --> G2
  D --> G2
  E2[T-E2 live probe] --> G2
  E3[T-E3 PCA probe] --> D6[T-D6 discovery]
  G2 --> G3{{G3 = M2 exit: write path live}}
  E4[T-E4 publish probe] --> G3
  G3 --> G4{{G4 = M3/M4 exit}}
  D6 --> G4
  G4 --> G5{{G5 = M5 exit: shipped}}
  R --> G5
```

## 5. Integration gates → roadmap mapping

| Gate | Means | Integrates | Roadmap | Status |
|---|---|---|---|---|
| **G1** | Contracts frozen, fan-out begins | T-01..T-04 | M0 exit | **PASSED** (T-03 still outstanding but does not block fan-out) |
| **G2** | Real reads on both auth paths | A1–A5, B1/B2/B4, C1/C2/C5, D1/D2, E1/E2/E3 | M1 exit | **CODE-INTEGRATED, NOT PASSED** — the read path is wired end-to-end, but "real reads" has never happened (E1/E2/E3 blocked) |
| **G3** | Real publish via preview → apply; duplicate-post chain provably broken | B3, C3/C4, D3a/D3b, E4 (publishing) | M2 exit | **CODE-INTEGRATED, NOT PASSED** — nothing has been published; the duplicate-post chain is proven by unit tests only |
| **G4** | Moderation + insights (+ discovery if E3 = GO) live | D4, D5, D6, E4 (moderation) | M3+M4 exit | **CODE-INTEGRATED, NOT PASSED** — and D6 was integrated *without* the "if E3 = GO" condition being evaluated |
| **G5** | Three-channel distribution install-tested | R1–R7 | M5 exit | **NOT PASSED** — no channel has been published or install-tested |

A gate is only "passed" when its stated exit criterion is true, not when the
code that would satisfy it exists. Commit history shows G2/G3/G5 declared as
landed in commit subjects; by this table's definition none of the live gates has
actually been met, because Lane E has never run.

Gate reviews are **integration tasks in their own right** (wire the lanes in
`index.ts`/registry, run the full live protocol, snapshot review) — owned by one
integrator agent per gate, not parallelized.

## 6. Suggested waves (max useful concurrency)

- **Wave 0 (serial):** T-04 → T-01 → T-02 (+T-03 alongside). One agent, plus the
  owner ratifying decisions.
- **Wave 1 (after G1) — up to ~14 parallel:** A1 A2 A3 A4 A5 · B1 B2 B4 · C1 C2
  · D1 D2 D3a D5 · E1 E3 · R1 R2 R4 R7 (throttle to taste; file ownership makes
  any subset safe).
- **Wave 2:** B3 (needs D3), C3 C4 C5 · D3b D4 · R3 R5 → **G2 integration** →
  T-E2.
- **Wave 3:** G3 integration + T-E4 · D6 (if E3 GO) · R6 → G4 → G5.

The critical path is **T-04 → T-02 → A4 → G2 → D3b/E4 → G3**; everything else
has slack. If only one thing gets extra agents, it is Lane A4 review and the
gate integrations.

**Where the waves actually stand (2026-07-29, revised 2026-08-07).** Waves 1–3 are
complete as code: every Lane A/B/C/D task has shipped an implementation with unit
tests. What remains is not more parallel development — it is the serial,
single-owner work the plan always said only one agent could do:

1. **Lane E — the harness is built; only execution remains.** As of 2026-08-07 the
   §9 protocol is an executable script (`scripts/live-probe.mjs`, 26 probes / 7
   lanes) rather than a checklist, so the ordering below is now just the order to
   pass flags in, not four separate authoring tasks:
   `node scripts/live-probe.mjs` (covers **T-E3** and the read half of **T-E2** with
   no consent flag) → `--allow-writes` (**T-E4**'s recoverable lanes) →
   `--allow-feed-post` / `--allow-token-refresh` (the two irreversible ones,
   deliberately last and deliberately separate). **T-E1**'s live-capture half rides
   along on the same credentials. Every one of these is blocked on exactly one
   thing: a token for a junk professional account.
2. **Finish T-04's last third:** D3 elicitation (in progress this session).
3. **Reconcile docs with code** — `IG_FB_ACCESS_TOKEN` (above), `IG_WRITE_JOURNAL`
   missing from the env catalog, `docs/auth.md` §5's stale open questions,
   `docs/security.md` §3's `rupload.facebook.com` claim, architecture §4's
   "toggle comments" placement.
4. **Then, and only then, T-03 + the M5 publishes** (npm, MCP registry, MCPB,
   plugin) and the clean-machine install tests. Note the ordering hardened since
   this was written: T-03 (the npm publish) is now the **sole** remaining blocker
   for the plugin channel too, so it gates two channels, not one.

## 7. Agent task brief (template)

Every task agent gets this brief:

```
Task: <T-ID> — <title>            Branch: task/<id>-<slug>
Read first: docs/architecture.md §<n>, docs/<relevant>.md, docs/corner-cases.md (your CC rows)
You own ONLY: <owned files> (+ colocated tests). Do not edit contract files or other tasks' files.
Contracts: src/core/types.ts, src/mcp/define.ts, src/core/clock.ts, test/helpers/ — frozen; if a change is unavoidable, stop and request a contract-bump.
Definition of done: unit tests green; `npm run check` green; CC rows tested or explicitly deferred to a live probe; owned docs updated.
House rules: English only; no AI attribution; no secrets anywhere; layer imports core ← api ← mcp ← tools.
```
