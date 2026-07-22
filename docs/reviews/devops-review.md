# DevOps / Release Engineering Review — instagram-mcp documentation set

## 1. Reviewer & scope

- **Role**: Senior DevOps / release engineer — operability & delivery review.
- **Date**: 2026-07-21.
- **Reviewed documents** (design phase, no code):
  - `README.md`
  - `docs/architecture.md` (§1, §5, §6, §9, §11 primary)
  - `docs/operations.md` (primary)
  - `docs/roadmap.md` (primary)
  - `docs/auth.md`, `docs/tools.md`, `docs/security.md`
- **Reference delivery setup** (the pattern being replicated): the production
  `servicenow-mcp-ai` repository — `.github/workflows/` (`ci.yml`, `publish.yml`,
  `publish-mcp.yml`, `codeql.yml`), `bin/servicenow-mcp-ai.cjs`, `server.json`,
  `package.json` scripts — plus §1/§6 of
  `facebook-mcp/docs/ai/research/servicenow-mcp-architecture.md`.
- **Scope**: CI design, release engineering, the three distribution channels
  (npm / MCP registry / MCPB) and their sync risks, config & environment
  operability, field diagnosability, upgrade story, CI secret hygiene, roadmap
  realism, and cross-document contradictions on operational knobs.
- **Out of scope**: Graph API semantic correctness, tool UX, security threat
  modeling beyond its delivery/ops intersection (covered by other role reviews).

Verification performed during the review:

- `npm view instagram-mcp-ai` → **E404, name available** on the npm registry as of
  2026-07-21. Adjacent names are **taken by unrelated projects**: `instagram-mcp`
  (v1.1.7) and `instagram-mcp-server` (v1.6.6); `ig-mcp` is free.
- The reference repo contains **no MCPB machinery** (its `extension/` directory is
  a VS Code extension; workflows cover npm, MCP registry, and VS Code marketplace
  only). The roadmap's M5 MCPB deliverable therefore has no in-house prior art.

## 2. Executive summary

**Verdict: CONDITIONAL GO** (conditions in §7).

This is one of the strongest delivery designs I have reviewed at the
documentation-only stage, for a simple reason: it replicates, nearly verbatim, a
delivery pipeline that already exists and demonstrably works (`servicenow-mcp-ai`
v2.0.1: tag-triggered CI publish with provenance, tag==version gate,
`prepublishOnly` backstop, OIDC-based MCP-registry publish with zero extra
secrets, `.cjs` ancient-Node launcher with its own CI probe, manifest/README sync
tests). Where the docs say "same as the reference", the risk is low and the plan
is credible.

The residual risk concentrates in exactly the places where this project
*departs* from the reference:

1. **MCPB is net-new.** It is listed as one bullet in M5, but it is the only
   distribution channel with no working example in-house, and it interacts
   badly with the documented config precedence: client-injected env always wins
   over the XDG env file, yet Path-A token refresh persists to the XDG file —
   so an MCPB/keychain-configured token can go stale with no durable fix
   (Finding F-1, the single worst operational trap in the design).
2. **There is no canonical env-var catalog.** Roughly 15 `IG_*` knobs are
   scattered across five documents with no single table of names, defaults,
   required-ness, and secret-ness — yet three artifacts (`.env.example`,
   `server.json` `environmentVariables`, MCPB `user_config`) must be generated
   from exactly that catalog (F-3).
3. **The Node 20 floor contradicts the "no EOL Node" rationale** — Node 20 went
   EOL 2026-04-30, before this project will ship (F-4).
4. **Release discipline is under-specified**: CHANGELOG.md is an M5 deliverable
   but no tagging strategy, release checklist, or three-channel version-sync
   test is documented, and M3–M5 have no exit criteria (F-6, F-7).

Cross-document consistency on operational knobs is otherwise very good — retry
matrix, backoff constants, concurrency default, rate-limit thresholds,
pagination caps, and quota numbers are stated identically wherever they appear.
The two real contradictions found are small: a telemetry debug tool promised in
operations.md §6 that is absent from the tools.md catalog (F-16), and
`rupload.facebook.com` allowlisted while v1 explicitly never uploads bytes
(F-10).

## 3. Delivery-pipeline assessment

### 3.1 CI design (architecture §11, roadmap M0)

Planned: lint, format check, build, test matrix (Node 20/22/24 on ubuntu + macOS
+ a Windows leg), `npm audit`, CodeQL; coverage ratchet via `c8` with
non-blocking Codecov upload (architecture §10).

- **Matrix choice**: replicates the reference (`ci.yml`: ubuntu 20/22/24, one
  macOS leg on the `.nvmrc` Node, a separate Windows job, coverage/audit run
  once on ubuntu/22). This is a sound shape: version coverage on the cheap OS,
  one leg per "different" platform, single-source coverage so the ratchet is
  deterministic. Two corrections needed:
  - Node 20 is EOL as of 2026-04-30 — the matrix and the engine floor need a
    deliberate decision (F-4).
  - The reference CI also has a **`launcher-node12` probe** (asserts the `.cjs`
    launcher prints a human "requires Node.js >= 20" message and exits non-zero
    under ancient Node, instead of a SyntaxError). The instagram-mcp docs adopt
    the launcher but never mention the probe; it is the only test that proves
    the launcher's entire reason to exist (F-14).
- **Gates**: `npm run check` = build + lint + format + tests + coverage + audit
  (roadmap preamble) matches the reference's `check` script, and every phase
  gate requires it green plus a reviewed manifest snapshot. Good: the quality
  gate is defined once and reused by CI, by phase exits, and by
  `prepublishOnly`.
- **Audit posture**: the reference runs `npm audit --omit=dev
  --audit-level=high` — production deps only, high+ severity. With exactly three
  runtime deps this will essentially never be noisy. Recommend documenting the
  same flags so "npm audit in CI" (security.md §6) is not interpreted as a
  dev-tree-inclusive, warning-level gate that cries wolf.
- **Coverage upload**: non-blocking Codecov mirrors the reference
  (`fail_ci_if_error: false`) — correct call; a coverage-SaaS outage must not
  block merges. Note this implies the **one** CI secret (`CODECOV_TOKEN`) — see
  §3.4.
- **Windows leg**: the reference needed `.gitattributes`-enforced LF so the
  generated-docs drift tests stay byte-identical on Windows checkouts. The
  instagram docs plan the same sync tests but do not mention the LF enforcement
  — carry it over in M0, or the Windows leg will fail on the first generated-doc
  test (folded into F-8).

### 3.2 Release engineering (architecture §11, roadmap M5)

- **npm provenance + `prepublishOnly`**: the plan ("npm publish (with
  provenance)"; "`prepublishOnly` runs the full gate") matches the reference,
  whose `publish.yml` is the right template: tag-triggered (`v*`), tag must
  equal `package.json` version, `npm run check` in the workflow **and** again
  via `prepublishOnly` as a backstop, `--provenance` with `id-token: write`.
  None of this is written down in the instagram docs beyond the two phrases —
  the tag/version gate and "publish only from CI, never from a laptop" policy
  should be stated explicitly (F-6).
- **`.cjs` launcher pattern**: correctly adopted (architecture §11). The
  reference launcher is ~20 lines of deliberately ancient-parseable CJS doing
  only the version guard, then `import("../build/index.js")`. Keep the `files`
  publish allowlist (`["build", "!build/**/*.map", "bin"]`) from the reference
  so maps and source never ship.
- **SDK version pinning**: "MCP SDK v1 minor pin" (roadmap M0) is ambiguous —
  the reference uses caret `^1.12.0` plus a lockfile plus Dependabot, which is
  the right combination (patch/minor security fixes flow; the lockfile makes
  builds reproducible; provenance covers the tarball). An exact-minor pin would
  silently opt out of v1 security patches. Define the intended semantics (F-9).
- **zod v3 + SDK v1**: matches the reference. Fine for now; note that the v2
  codemod migration will likely also force the zod v4 jump — one more reason the
  migration needs a scheduled decision gate rather than a "parked" bullet
  (F-9).

### 3.3 The three distribution channels and their sync risks

| Channel | Prior art in reference | Version source | Sync mechanism planned |
|---|---|---|---|
| npm (`instagram-mcp-ai`) | Yes (`publish.yml`) | `package.json` | tag==version gate (implied) |
| MCP registry (`server.json`) | Yes (`publish-mcp.yml`, GitHub OIDC, runs after npm publish) | `server.json` — **version appears twice** (top level + `packages[0]`) | "generated and kept in sync by script" (architecture §11) |
| MCPB bundle (`.mcpb`) | **No** | MCPB `manifest.json` | **none documented** |

- The npm → MCP-registry ordering in the reference is load-bearing: the registry
  validates the published tarball's `mcpName` field, so `publish-mcp.yml` runs
  on `workflow_run` after "Publish" succeeds. Two details the instagram docs
  omit: (a) **`package.json` must itself carry the `mcpName` field** (the
  registry checks the tarball, not `server.json`); (b) the registry publish
  needs **no secret at all** (GitHub OIDC via `mcp-publisher login
  github-oidc`). Both should be stated so M5 doesn't rediscover them (F-7).
- MCPB is the weak leg: no build workflow, no artifact hosting decision (GitHub
  Release asset is the natural choice), no version-sync test, no statement of
  how `user_config` maps onto the `IG_*` env contract, and a genuine
  config-precedence trap for Path-A tokens (F-1, F-2).
- **Version-sync test**: the planned README/env-docs sync tests (architecture
  §10) should be extended to a single drift test asserting
  `package.json.version == server.json (both occurrences) == MCPB manifest
  version`, and that `server.json` `environmentVariables` and MCPB
  `user_config` are generated from the same env catalog as `.env.example`
  (F-3, F-7).

### 3.4 Secrets in CI

The review brief asks: none should be needed — do the docs imply that? Result:

- **Meta credentials in CI: correctly zero.** The testing strategy (architecture
  §10) runs everything against a `withFetch()` recording mock; the live-account
  checks in M1/M2 exit criteria are operator-run, not CI. This is the right
  design but it is only *implied* — no document states the invariant "CI holds
  no Meta credentials; live checks are manual". Make it explicit so a future
  "just add a smoke test with a real token" PR trips over a written policy
  (F-8).
- **`NPM_TOKEN`**: the reference still uses a long-lived npm token
  (`NODE_AUTH_TOKEN: secrets.NPM_TOKEN`). As of 2026, npm **trusted publishing
  (OIDC)** removes that secret entirely and grants provenance in the same
  motion — this project should start there rather than inherit the token
  (F-8).
- **`CODECOV_TOKEN`**: needed for the upload; low-sensitivity, non-blocking
  step. Acceptable as the only repository secret.
- **MCP registry**: GitHub OIDC, no secret (see §3.3). Good.

Net: achievable end-state is **one low-value CI secret (Codecov)**, which is
excellent for a project whose runtime holds never-expiring Meta tokens.

## 4. Operability assessment

### 4.1 Configuration & environment

- **Precedence** (`IG_ENV_FILE` → XDG `~/.config/instagram-mcp-ai/.env` →
  project `.env`; client env wins via `dotenv override: false`; atomic
  comment-preserving `0600` writes to the XDG path) replicates a proven design.
  Two gaps:
  - The **write-back target vs read precedence** interaction is unspecified and
    dangerous: if the token was *read* from client-injected env (MCPB keychain,
    `claude_desktop_config.json`) or from `IG_ENV_FILE`, but the Path-A refresh
    *persists* to the XDG file, the refreshed token loses to the stale source
    on next boot. This must be resolved by design, not discovered in the field
    (F-1).
  - **Windows**: XDG paths (`~/.config/...`, `~/.local/state/...`) are
    undefined on win32, yet the CI matrix has a Windows leg and MCPB targets
    Claude Desktop, which is heavily Windows/macOS. The path mapping
    (`%APPDATA%` / `%LOCALAPPDATA%`) needs one sentence and one settings
    function (F-5).
- **Env-var catalog**: missing as a single artifact; see F-3. It also needs to
  answer questions currently unanswered anywhere: which vars select Path A vs
  Path B, what happens when both paths' vars are present (auth.md §1 says
  "selected by which env vars are present" — ambiguous when both are), and
  whether `IG_ACCOUNT_ID` (README quickstart) is required or resolved.
- **Multi-profile** (`IG_PROFILE_<NAME>_*` + auto-injected per-request selector
  via `AsyncLocalStorage`) is a proven mechanism, but the selector is named
  `account` (tools.md legend) — which collides semantically with the IG
  *account ID*, the `account` *package*, and `IG_ACCOUNT_ID`. The model will
  put IG user IDs in it. The reference called it `instance`; call this one
  `profile` (F-11).

### 4.2 Diagnosability in the field

The 2am scenario — the token dies while the operator sleeps:

- **What works well**: error 190 maps to `AuthError` with remediation text
  naming the CLI command (operations §3); `instagram_token_status` carries
  validity, path, expiry, days-left warning (<10 days) and the last rate-limit
  snapshot; `doctor` does token validity, account resolution, scope inventory,
  quota, one cheap read per package, rate-limit headroom; Path-A auto-refresh
  at `IG_REFRESH_AFTER_DAYS=45` shrinks the window in which death is possible;
  structured stderr JSON logs never carry tokens or full URLs. For a local
  single-operator server this is a genuinely good diagnosability story — the
  operator wakes up, runs `doctor`, and is told exactly what to run.
- **Gap — startup behavior on dead credentials is unspecified** (F-6…
  specifically F-13): auth.md §3 says validation happens "on startup and in
  doctor", but not what startup *does* on failure. Under a GUI MCP client a
  hard exit is the worst outcome: the server silently disappears from the tool
  list and the operator sees a generic client error, with the real reason
  buried in a client log file. The design should commit to **start-degraded**:
  boot, register tools, and return the actionable `AuthError` from every call
  and from `token_status`, never `process.exit` on a bad token.
- **Gap — the refresh dead-end**: Path-A refresh requires the token to be
  unexpired. Once it *has* expired, only interactive `login` (browser) helps —
  which is fine locally but impossible for the model to do on the operator's
  behalf. The `AuthError` remediation text should distinguish "refresh will
  work" from "you must re-login" using the persisted expiry metadata.
- **Telemetry counters** (calls, retries, throttles per host) are promised in
  operations §6 via "a debug tool in the `account` package" — which does not
  exist in tools.md's catalog (F-16). In-memory, reset-on-restart counters are
  acceptable for this deployment model; just say so.
- **Write journal** (`~/.local/state/instagram-mcp-ai/`) has no growth/rotation
  policy (F-17) and the hashtag 30/7d budget counter has no specified storage
  location or per-account keying (F-15) — both are small but are exactly the
  kind of state files that surprise operators a year in.

### 4.3 Upgrade story

- **Graph v25→v26**: "a deliberate, changelog-reviewed PR that bumps one
  constant in `core/settings.ts` and re-runs the manifest snapshot" (operations
  §5) is the right shape — the version pin lives in one place and every URL is
  built from it. Two refinements: (a) auth.md flags as **[verify]** whether
  `graph.instagram.com` accepts `/v25.0/` path segments — if it does not, the
  "pinned in every URL" invariant needs a per-host version policy, and the
  snapshot test should encode it (F-12); (b) the bump PR should have a written
  playbook: read Meta changelog → bump constant → `doctor` + one live read and
  one live publish-preview per package against a real account → review
  snapshot diff → minor release. Put it in operations §5 (F-12).
- **MCP SDK v1→v2 mid-life**: the codemod path (`npx
  @modelcontextprotocol/codemod v1-to-v2`) is named, which is more than most
  designs do, but it sits in "Later / explicitly parked" with no trigger. A
  mid-life forced migration (SDK v1 EOL, a client requiring spec `2026-07-28`
  behavior, zod v4 requirement) is the single most likely large unplanned work
  item in this project's first two years. Define the decision trigger now
  (F-9). On the positive side, architecture §1's choice to *not* build on
  Sampling/Roots/Logging (deprecated in `2026-07-28`) and §8's
  stateless-friendly HTTP design deliberately minimize the migration surface —
  good forward engineering.
- **Node**: see F-4; the floor decision should be revisited at every major
  release, and the matrix updated when 26 goes LTS (October 2026, i.e. before
  M5 at any realistic pace).

### 4.4 Roadmap realism (delivery standpoint)

- **Sequencing is sound**: scaffold+CI first (M0), read path with `doctor` and
  both auth providers before any write (M1), write safety *before* the
  publishing tools that need it (M2), destructive moderation behind its double
  gate (M3), metrics/discovery (M4), distribution last (M5), messaging gated
  behind its own design review (M6). Gates-not-dates with a uniform quality
  gate is the right model. M0's pre-flight (npm name, SDK pin, Meta changelog)
  is exactly right — and the npm-name question is now answered (available).
- **Weaknesses**:
  - **M5 is overloaded and its only novel item is its hardest**: npm + registry
    publish are workflow-copying exercises from the reference; MCPB is new
    engineering (manifest, pack, hosting, keychain mapping, the F-1 precedence
    problem) hiding behind one bullet. Split M5 or explicitly rank MCPB as its
    risk item with its own design note (F-2).
  - **M3–M5 have no exit criteria** while M1/M2 have crisp ones. M5
    especially needs them: "fresh machine `npx -y instagram-mcp-ai doctor`
    works; registry entry resolves; MCPB installs into Claude Desktop and
    publishes a preview; provenance verifiable on npmjs.com" (F-6).
  - **No release checklist / tagging strategy / changelog discipline**:
    CHANGELOG.md appears as an M5 file deliverable, but nothing says
    keep-a-changelog format, entry-per-release, semver policy, `v*` tag
    convention, tag==version gate, or post-publish smoke. One short
    RELEASING.md (or a roadmap subsection) closes this (F-6).

### 4.5 Cross-document consistency on operational knobs

Checked every knob that appears in more than one document. Consistent:
backoff formula (`min(500·2^n, 8000) + jitter`) and `Retry-After` cap 60 s
(architecture §5 = operations §2); concurrency default 4 (`IG_MAX_CONCURRENT`);
90 % proactive-throttle threshold (architecture §5 = operations §1); publishing
quota 100/24 h (operations §1 = tools.md = security §4); hashtag budget 30/7 d
(operations §1 = tools.md); page default 25 / cap `IG_MAX_ITEMS` 200 (operations
§4, unnamed-but-compatible in architecture §7); XDG config path (architecture §6
= auth §4); refresh default 45 d (`IG_REFRESH_AFTER_DAYS`, auth §3 only).

Inconsistencies found: the phantom debug tool (F-16), `rupload.facebook.com`
(F-10), HTTP env-var naming style (`IG_PORT` vs `IG_HTTP_HOST`/`IG_HTTP_TOKEN`,
F-11), the "≈ 25 tools" claim vs 28 tools actually cataloged (F-16), and the
Node-EOL rationale (F-4). No conflicting *values* for any shared numeric knob —
notably better than typical multi-doc design sets.

## 5. Findings

Severity scale: **Critical** (blocks GO), **High** (must fix before the affected
milestone), **Medium** (fix during design/implementation of the affected area),
**Low** (hygiene; fix opportunistically).

---

**F-1 · High — MCPB/client-env token refresh trap: the refreshed token can lose
to the stale one.**
*Affected*: architecture §6; auth.md §3–§4; tools/roadmap M5 (MCPB).
Config precedence is env-first (`dotenv override: false` — "env passed by the
MCP client always wins over the env file"), and Path-A auto-refresh persists the
new 60-day token "to the XDG path". When the token was supplied by the MCP
client (MCPB keychain `user_config`, `claude_desktop_config.json` `env` block)
or via `IG_ENV_FILE`, the refreshed token written to the XDG file is shadowed by
the stale injected value on every subsequent boot. The server will keep
refreshing in-memory each session until the injected token passes its 60-day
expiry, then die permanently with no durable fix except manual reconfiguration —
the precise failure the auto-refresh exists to prevent. Note the server cannot
write back into the OS keychain through MCPB `user_config`.
*Recommendation*: (a) define the invariant "a refreshed token is persisted to,
and next read from, the same logical source" — for client-injected tokens,
persist refresh output to the XDG file **and** prefer the XDG copy when its
stored `obtained-at` metadata is newer than the injected token's (a narrow,
documented exception to env-first, keyed on token identity); (b) for the MCPB
channel, recommend Path B system-user tokens (never-expiring) as the default
guidance, or have MCPB `user_config` carry only app ID/secret and drive token
acquisition through `login`; (c) make `doctor` detect and report the
shadowed-token condition explicitly.

**F-2 · High — MCPB channel has no delivery pipeline design and no in-house
prior art.**
*Affected*: architecture §11; roadmap M5.
The reference repo ships npm, MCP-registry, and VS Code channels — no MCPB.
For instagram-mcp, MCPB is one roadmap bullet with no build workflow, no
signing/packing step, no artifact hosting decision, no version-sync mechanism,
and no `user_config`→`IG_*` mapping spec, while being the channel aimed at the
least technical operators (worst-equipped to debug drift or the F-1 trap).
*Recommendation*: before M5, write a one-page MCPB delivery note: `manifest.json`
generated from the same source as `server.json` (same script family as
`gen:manifest`); `mcpb pack` in the tag-triggered publish workflow; attach the
`.mcpb` to the GitHub Release; version asserted equal to `package.json` by a CI
drift test; `user_config` entries generated from the env catalog (F-3) with
`sensitive: true` for token/secret. Consider making MCPB "M5b" so npm+registry
(pure replication) are not held hostage by it.

**F-3 · Medium — No canonical environment-variable catalog.**
*Affected*: all documents; worst in auth.md (no token var names at all).
~15 `IG_*` knobs are scattered: `IG_ACCESS_TOKEN`/`IG_ACCOUNT_ID` (README only),
`IG_TOOL_PACKAGES`/`IG_PACKAGES_DENY`/`IG_PACKAGES_READONLY`/`IG_MAX_CONCURRENT`/
`IG_ENV_FILE`/`IG_PROFILE_<NAME>_*`/`IG_PRETTY_JSON`/`IG_TRANSPORT`/`IG_HTTP_HOST`/
`IG_PORT`/`IG_HTTP_TOKEN` (architecture), `IG_MAX_ITEMS` (operations),
`IG_WRITE_MODE`/`IG_ALLOW_DESTRUCTIVE` (tools), `IG_REFRESH_AFTER_DAYS` (auth).
Never defined: the Path-B token/app-secret/app-id var names, which vars select
which auth path, precedence when both paths' vars are set, whether
`IG_ACCOUNT_ID` is required or resolvable. Three generated artifacts
(`.env.example`, `server.json` `environmentVariables` with
`isRequired`/`isSecret`, MCPB `user_config`) all depend on this catalog.
*Recommendation*: add a single env-var table (operations.md or a new
`docs/config.md`): name, default, required-ness, secret-ness, consuming
component, since-milestone. Specify `getAuthMode()` precedence for the
both-paths-present case and have `doctor` warn on ambiguity. Make the M0
`.env.example` generated from it.

**F-4 · Medium — Node 20 floor contradicts the "no EOL Node" rationale; CI
matrix inherited without re-validation.**
*Affected*: README (identity table); architecture §1, §11.
Architecture §1 justifies "Node ≥ 20" with "no EOL Node", but Node 20 reached
end-of-life 2026-04-30 — before this project will ship any code. The 20/22/24
matrix is copied from a reference that predates that date.
*Recommendation*: decide at M0: either floor = 22 (consistent with the stated
rationale; matrix 22/24, add 26 when it goes LTS in Oct 2026) or keep floor = 20
for reach and rewrite the rationale honestly ("EOL tolerated for launcher
reach"). Update `engines`, `.nvmrc` rationale, and the CI matrix together; keep
the ancient-Node launcher probe either way.

**F-5 · Medium — Windows path story undefined while Windows is in the support
matrix.**
*Affected*: architecture §6; tools.md (write journal); operations §1 (hashtag
counter); roadmap M5 (MCPB).
XDG paths (`~/.config/instagram-mcp-ai/.env`, `~/.local/state/instagram-mcp-ai/`)
have no Windows mapping, yet CI has a Windows leg and MCPB targets Claude
Desktop on Windows/macOS. Every piece of persistent state (env file, write
journal, hashtag budget, token metadata) hits this.
*Recommendation*: define once in `core/settings.ts` design: config →
`%APPDATA%\instagram-mcp-ai\`, state → `%LOCALAPPDATA%\instagram-mcp-ai\` (or
adopt the `env-paths` convention without the dependency); note that `chmod 0600`
is a no-op on win32 and the compensating control is the user-profile ACL.

**F-6 · Medium — Release discipline unspecified: no tagging strategy, release
checklist, changelog discipline, or M3–M5 exit criteria.**
*Affected*: roadmap M5 (and preamble); architecture §11.
CHANGELOG.md and SECURITY.md are listed as M5 files, but nothing defines: semver
policy, `v*` tag convention, the tag==`package.json`-version CI gate,
publish-only-from-CI policy, post-publish smoke verification, or exit criteria
for M3/M4/M5 (M1/M2 have crisp ones).
*Recommendation*: add a short release-engineering subsection (or RELEASING.md at
M5): keep-a-changelog format with an entry per release; semver; tag `vX.Y.Z`
pushed only after `npm run check` green; publish workflow = the reference
`publish.yml` pattern (tag==version gate, check, `--provenance`, never from a
laptop); post-publish smoke = `npx -y instagram-mcp-ai@latest doctor` on a clean
machine + registry entry resolves + MCPB installs. Write exit criteria for
M3–M5 in the same style as M1/M2.

**F-7 · Medium — Three-channel version/metadata sync has no drift test; two
registry-publish preconditions undocumented.**
*Affected*: architecture §10–§11; roadmap M5.
`server.json` carries the version **twice** (top level and `packages[0]`); MCPB
`manifest.json` adds a third copy; `package.json` is the source of truth. The
planned README/env-docs sync tests don't mention these. Also undocumented: (a)
`package.json` must carry the `mcpName` field — the MCP registry validates the
*npm tarball*, not `server.json`; (b) registry publish must run **after** npm
publish succeeds (`workflow_run` ordering in the reference) and needs no secret
(GitHub OIDC).
*Recommendation*: extend the sync-test suite with a drift test over
`package.json.version` == both `server.json` versions == MCPB manifest version,
plus `mcpName` presence in `package.json`; document the publish ordering and
OIDC login in the M5 plan. Generate `server.json` and the MCPB manifest from one
script (`gen:manifest` family).

**F-8 · Medium — CI secret policy is implied, not stated; npm token is
avoidable.**
*Affected*: architecture §10–§11; security.md §6; roadmap M0/M5.
The mock-fetch test strategy correctly implies CI needs no Meta credentials, and
M1/M2 live checks are operator-run — but no document states the invariant.
The reference's `publish.yml` still uses a long-lived `NPM_TOKEN`; npm trusted
publishing (OIDC) now removes it and yields provenance in the same motion.
Also: the reference needed `.gitattributes`-enforced LF for the generated-docs
tests to pass on the Windows leg — not mentioned in the M0 scaffold list.
*Recommendation*: state in security.md/operations: "CI holds no Meta
credentials; all live-account verification is manual." Use npm trusted
publishing from the first release (target end-state: `CODECOV_TOKEN` as the only
repository secret). Add `.gitattributes` (LF) to the M0 scaffold checklist.

**F-9 · Medium — SDK pin semantics ambiguous; v2 migration has no trigger.**
*Affected*: README (identity table); architecture §1; roadmap M0 and "Later".
"MCP SDK v1 minor pin" could mean exact-minor (opts out of v1 security patches)
or caret-within-v1 (the reference's `^1.12.0` + lockfile + Dependabot). The v2
migration sits in "explicitly parked" with a codemod named but no decision
criteria, despite being the most likely forced mid-life work item (SDK v1
maintenance wind-down, spec `2026-07-28` client requirements, zod v4 coupling).
*Recommendation*: specify caret-within-v1 + lockfile + Dependabot at M0. Add a
standing roadmap item: "re-evaluate SDK v2 each quarter; migrate when (v2 GA ∧
codemod stable ∧ (v1 in maintenance ∨ a target client requires ≥ 2026-07-28
behavior))". Budget it as a minor-version release with full manifest-snapshot
review.

**F-10 · Low — `rupload.facebook.com` allowlisted but unused in v1.**
*Affected*: architecture §5; security.md §3; vs tools.md publishing design note.
tools.md states v1 ingestion is URL-only ("the server never uploads local
bytes"); `rupload.facebook.com` (resumable upload host) therefore has no v1
caller, yet sits in the SSRF allowlist in two documents. Dead allowlist surface
contradicts the least-privilege posture the security doc otherwise takes.
*Recommendation*: drop it from the v1 allowlist; reintroduce alongside the
future upload helper with its own justification. Keeps the allowlist test
honest: every allowlisted host has a calling code path.

**F-11 · Low — Naming hygiene: per-request `account` selector and `IG_PORT`.**
*Affected*: architecture §6, §8; tools.md legend.
(a) The auto-injected profile selector is named `account`, colliding with the
`account` package, `IG_ACCOUNT_ID`, and the IG account concept — models will
pass IG user IDs into it. The reference used `instance` (unambiguous). (b)
`IG_PORT` breaks the `IG_HTTP_*` grouping (`IG_HTTP_HOST`, `IG_HTTP_TOKEN`) —
the reference's `SN_PORT` was flagged "historical" by the porting research; this
is the day-one chance to fix it.
*Recommendation*: rename the selector to `profile`; use `IG_HTTP_PORT`.

**F-12 · Low — Graph version pin unverified on `graph.instagram.com`; no
written upgrade playbook.**
*Affected*: operations §5; auth.md §5; architecture §5.
Architecture asserts version-pinned URLs on both hosts; auth.md flags
`/v25.0/` support on `graph.instagram.com` as **[verify]**. If unsupported, the
one-constant bump story needs a per-host version policy encoded in the snapshot
test. The v25→v26 bump procedure also deserves a five-line checklist (changelog
review → constant bump → live `doctor` + per-package smoke → snapshot diff →
minor release).
*Recommendation*: resolve the [verify] at M1 (it gates the URL-builder design);
add the upgrade playbook to operations §5.

**F-13 · Low — Startup behavior on dead/missing credentials unspecified.**
*Affected*: auth.md §3; architecture §9; operations §6.
"Validate on startup" without a stated failure mode risks the worst GUI-client
outcome: a hard exit makes the server vanish from the client with a generic
error. (Severity Low only because the reference's bootstrap conventions make
start-degraded the likely default; it still must be written down — it defines
the whole 2am experience.)
*Recommendation*: specify start-degraded: always boot and register tools;
surface `AuthError` with remediation from every call and `token_status`; exit
non-zero only for structurally unusable config (no credentials at all in any
source), with a clear stderr line. Distinguish "run `refresh`" from "token
expired — run `login`" using persisted expiry metadata.

**F-14 · Low — Ancient-Node launcher CI probe not carried over.**
*Affected*: architecture §11 (CI list).
The `.cjs` launcher's only purpose is a human error message under old Node; the
reference proves it with a dedicated `launcher-node12` CI job (expects non-zero
exit + "requires Node.js >= 20" text, not a SyntaxError). The instagram CI plan
lists matrix/audit/CodeQL but not this probe — the one test that can catch an
accidental `?.` or ESM leak into the launcher.
*Recommendation*: replicate the probe job in the M0 CI skeleton.

**F-15 · Low — Hashtag 30/7d budget counter: persistence and keying
unspecified.**
*Affected*: operations §1; tools.md discovery.
The counter is "local persistent" but has no stated storage location, no
per-account (and per-profile) keying, and no acknowledgment that it is a
local-only heuristic that diverges if the operator queries hashtags through any
other client (the API offers no usage endpoint).
*Recommendation*: store under the state dir (`~/.local/state/instagram-mcp-ai/`,
F-5 mapping on Windows), keyed by IG account ID, rolling-window pruned; document
the divergence caveat in the tool description so the model relays it honestly.

**F-16 · Low — Tool-catalog drift already present at design time.**
*Affected*: operations §6 vs tools.md; tools.md tool-count budget.
operations §6 promises "per-host telemetry counters … exposed via a debug tool
in the `account` package"; tools.md's `account` package has no such tool. The
"≈ 25 tools" budget also undercounts the cataloged surface (28 across the six
non-messaging packages). Trivial today, but this project's own discipline
(manifest snapshot, generated README) exists precisely to prevent this class of
drift — the docs should hold themselves to it.
*Recommendation*: add the debug tool to tools.md (e.g.
`instagram_get_diagnostics`, RO) or fold the counters into
`instagram_token_status` and amend operations §6; correct the count.

**F-17 · Low — Write-journal growth unbounded.**
*Affected*: tools.md (write safety); security.md §4.
The append-only journal in `~/.local/state/instagram-mcp-ai/` has no size cap,
rotation, or retention statement. Years of publishes/moderation on a
long-running personal server will accumulate silently.
*Recommendation*: one policy sentence (e.g. NDJSON, rotate at N MB or M
entries, keep last K files) and a `doctor` line reporting journal size.

**F-18 · Low — npm-name adjacency and trademark exposure.**
*Affected*: README (planned identity); roadmap M0/open question 1.
Verified 2026-07-21: **`instagram-mcp-ai` is available** (E404). But
`instagram-mcp` (v1.1.7) and `instagram-mcp-server` (v1.6.6) are live, unrelated
packages — install-instruction typos will land users on foreign code, and this
repo's own directory name (`instagram-mcp`) equals the foreign package's name.
Secondary: "instagram" in the package name carries a nonzero
trademark-complaint risk (npm has honored Meta takedowns before); mitigation is
the standard "unofficial, not affiliated with Meta" README disclaimer.
*Recommendation*: reserve the name early in M0 (publish a 0.0.1 placeholder or
scaffold-publish promptly after the name check); make every install snippet
copy-pasteable with the exact `instagram-mcp-ai` string; add the
non-affiliation disclaimer to the README at first publish.

## 6. Recommendations summary (prioritized)

1. **(F-1)** Resolve the refresh-persistence vs env-precedence contradiction by
   design before M2 (`login`/auto-refresh) and gate MCPB (M5) on it; make
   `doctor` detect shadowed tokens; steer MCPB users to Path B system-user
   tokens.
2. **(F-2)** Write the MCPB delivery design note (build, host, version-sync,
   `user_config` mapping) before M5; consider splitting M5 into npm+registry
   (replication) and MCPB (new work).
3. **(F-3)** Create the canonical env-var catalog (names, defaults, required,
   secret, auth-path selection & precedence) — by M1, since `.env.example`,
   `server.json`, and MCPB all generate from it.
4. **(F-4)** Decide the Node floor at M0 with an honest EOL rationale; set the
   CI matrix accordingly (add 26 when LTS).
5. **(F-6, F-7)** Add release discipline: tagging strategy, tag==version gate,
   publish-only-from-CI, changelog format, post-publish smoke, M3–M5 exit
   criteria, and a three-channel version drift test.
6. **(F-8)** State the "no Meta credentials in CI" invariant explicitly; adopt
   npm trusted publishing (OIDC) so `CODECOV_TOKEN` is the only CI secret; add
   `.gitattributes` LF enforcement to M0.
7. **(F-9)** Fix SDK pin semantics (caret-within-v1 + lockfile + Dependabot)
   and give the v2 migration a quarterly-reviewed trigger.
8. **(F-13)** Specify start-degraded behavior on dead credentials — it defines
   the field-failure experience.
9. **(F-5, F-10–F-12, F-14–F-18)** Hygiene batch: Windows paths, drop
   `rupload` from the v1 allowlist, `profile`/`IG_HTTP_PORT` renames, resolve
   the `graph.instagram.com` version-pin [verify] at M1 + upgrade playbook,
   launcher CI probe, hashtag-counter persistence, journal rotation, catalog
   drift fixes, early npm-name reservation + disclaimer.

## 7. Verdict

**CONDITIONAL GO** on delivery and operability grounds.

The delivery core — CI matrix and gates, coverage ratchet, audit/CodeQL,
tag-triggered provenance publish with `prepublishOnly` backstop, OIDC registry
publish, `.cjs` launcher, manifest/README sync testing, three-dependency supply
chain — is a faithful replication of a pipeline that already runs in production,
and the documentation set is unusually consistent on operational numbers. The
diagnosability story (`doctor`, `token_status`, structured stderr logs,
actionable error taxonomy) is above the bar for this class of server.

Conditions to clear, tied to the milestones that need them:

1. **Before M2**: F-1 resolved by design (refresh persistence vs env
   precedence), F-13 specified (start-degraded), F-3 env catalog in place
   (needed by M1 auth providers already).
2. **Before M0 exit**: F-4 Node-floor decision; F-8 CI-secret invariant +
   trusted-publishing decision; F-14 launcher probe and `.gitattributes` in the
   CI skeleton; F-18 name reservation.
3. **Before M5**: F-2 MCPB delivery design note; F-6 release
   checklist/tagging/changelog discipline + M3–M5 exit criteria; F-7
   three-channel drift test and registry-publish preconditions documented.

None of the findings challenge the architecture or the channel strategy; they
are all closable with documentation and small design decisions before the
affected milestone. With the three condition groups met, this plan is a GO.

*npm name check (2026-07-21): `instagram-mcp-ai` — available (registry 404).
Adjacent taken names: `instagram-mcp` v1.1.7, `instagram-mcp-server` v1.6.6.*
