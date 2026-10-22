# Release Checklist

Ordered steps to cut a release of `instagram-mcp-ai` across all **four** distribution
channels. `package.json` is the **single source of truth** for the version; every
other version copy is derived from it and kept in lockstep by the drift test in
[`test/release/version-consistency.test.ts`](../test/release/version-consistency.test.ts).

| # | Channel | Manifest | Installed from |
|---|---|---|---|
| 1 | npm | `package.json` | `npx instagram-mcp-ai` |
| 2 | MCP registry | `server.json` | registry entry `io.github.IvanBBaev/instagram-mcp-ai` |
| 3 | MCPB bundle | `manifest.json` | `.mcpb` attached to the GitHub Release (Claude Desktop) |
| 4 | Claude Code plugin | `plugins/instagram-mcp-ai/.claude-plugin/plugin.json` | the git repo / a plugin marketplace |

The Claude Code plugin does **not** ship in the npm tarball (`files` in
`package.json` is an allowlist and deliberately omits `.claude-plugin/` and
`plugins/`). It is
installed from git and launches the server via `npx instagram-mcp-ai@<version>`,
so the plugin manifest pins the npm version it serves — the drift test asserts
that pin as well.

## Reality check — one channel of four has shipped

As of 2026-10-13:

- **npm — published.** `instagram-mcp-ai@0.8.0` is `latest`, with build provenance,
  published by `.github/workflows/release.yml` from the `v0.8.0` GitHub Release
  (run `38320610715`). `0.7.0` (2026-08-25) was the first publish and claimed the name. Note that the roadmap's M0 item "reserve the npm name by
  publishing a `0.0.1` stub" was never carried out and is now moot: the first
  thing published was the real package, not a stub.
- **MCP registry —** no `server.json` has been submitted.
- **MCPB —** no `.mcpb` bundle has been built or attached to a release.
- **Claude Code plugin —** the manifest exists in-tree and its `npx` pin now
  resolves against a real package, but the repo is not listed in any plugin
  marketplace.

Tags `v0.7.0` and `v0.8.0` are cut, each with a dated `CHANGELOG.md` section. The
npm lane below has been exercised twice, end to end; the other three have not.

## 1.0.0 cut readiness — pass of 2026-10-22

A local, offline pass over every step below for the `1.0.0` cut, at `46e6eb5`
(`0.8.0` plus `[Unreleased]`). Nothing was bumped, tagged, pushed or published.
`1.0.0` is the field-validated release ([roadmap.md](roadmap.md), release
target), so a step that needs the live platform is a blocker, not a formality.

| Step | State | Evidence or blocker |
|---|---|---|
| 1 Quality gate | **local green, CI red** | `npm run check` passes locally: 2603/2603 tests, 100% on all four coverage axes, 0 runtime advisories. The CI run on the last pushed `main` commit (`3088d8e`, run `38321727348`) **failed**: `check` on windows-latest (Node 22 and 24) fails the journal-diagnosis, token-store read, CC-CFG-69 home, catalogue-preamble and HTTP SIGTERM tests, and macos-latest/Node 22 fails "the temp file is brought to 0600 whatever the ambient umask". `main` has been red on CI since at least `ad39305` (2026-10-10). The 18 local commits since `3088d8e` have not been through CI. |
| 2 Advisories | green | `npm audit --omit=dev`: 0 vulnerabilities. |
| 3 Live validation | **blocked — live** | No probe has ever run against Meta (E2, E3, E4, AUTH-LIVE, INS-LIVE). M1–M4 stay PARTIAL. |
| 4–5 Version bump | ready, not done | Only after the blockers clear; the drift test covers all six copies. |
| 6 Changelog | ready | `[Unreleased]` holds every user-facing change since `0.8.0`; one entry (`userTags`, CC-PUB-61) is breaking under [stability.md](stability.md) §1 and must ship in `1.0.0` itself. |
| 7–8 Tag, npm | **[human]** | Not started. `0.8.0` is `latest` on npm. |
| 9–11 Registry, MCPB, plugin listing | **[human]** | Not started (R5, R6, R8 wait on the owner's go-ahead). |
| 12 Install tests | **blocked — live/human** | No clean-machine install of any channel (INSTALL). |
| Stability promise | reviewed | [stability.md](stability.md) §4: the tool surface is ready to bind; whether `1.0.0` also binds the `IG_*` variables, the CLI surface, profile membership and Graph-version moves is an owner decision. |
| Gate D sign-off | **blocked — owner** | T-04 (D1–D3) not signed off. |

**Verdict: not cuttable.** What stands between this tree and `1.0.0`: a green CI
matrix on the release commit, the live runs and the fixes they surface, the
owner's T-04 sign-off and stability-scope decision, and the owner's go-ahead for
the outward steps 7–11.

## Legend

- **[human]** — an irreversible outward action that a person must take
  deliberately. Publishing to npm or the MCP registry cannot be undone (npm
  unpublish is time-boxed and registry entries are public immediately), and a
  git tag that has been pushed is effectively permanent. Automation may prepare
  these steps but must never trigger them unattended.
- **[blocked — live]** — needs real Instagram credentials and a live
  professional account; cannot be completed offline.
- everything unmarked runs offline today against mocks and fixtures.

## Pre-flight (offline, runnable now)

1. **Quality gate green.** Run `npm run check`. It is the full gate:
   `lint → format:check → build → test:corpus → coverage → audit`.
   - `test:corpus` is the floor under everything below it: it asserts that every
     test source under `test/` was compiled and that the glob `npm test` hands to
     `node --test` reaches each one. A glob matching nothing is not an error —
     node exits 0 having run zero tests, and before 2026-09-23 c8 then measured
     zero statements of zero files and cleared all four thresholds, so the whole
     gate (and with it `prepublishOnly`) passed a tree in which nothing ran. The
     guard runs outside c8, by design; `--all` in the `coverage` script is the
     second, independent channel. See CC-PROC-164.
   - `coverage` runs the whole suite under c8 with `--check-coverage` and the
     thresholds pinned in the `coverage` script; a coverage regression fails the
     gate rather than merely reporting one. All four thresholds are **100**
     (statements, branches, functions, lines) and the tree currently meets them
     — `src/`, `bin/` and the `test/helpers/` seams alike. The handful of arms
     that provably cannot execute (a `noUncheckedIndexedAccess` fallback behind a
     regex that always captures, a `DROP` sentinel the root walk cannot return,
     the preload's non-string-URL arms) carry `/* c8 ignore start … stop */` with
     the reason written out, so "100" means *examined*, not *skipped*. Raising
     new code past this gate means writing the test, not lowering the number.
   - `audit` is `npm audit --audit-level=high --omit=dev` — a hard gate on the
     dependency tree consumers actually install. Dev-only advisories are surfaced
     by `npm run audit:dev` (informational; CI runs it with `continue-on-error`)
     because they never reach a consumer of the published package.
   - The version-consistency drift test must pass; it covers all four channels.
   - Confirm the CI matrix (Node 22/24 × ubuntu/macOS/Windows) plus the coverage,
     audit and CodeQL jobs are green on the release commit.
2. **Review outstanding advisories.** `npm audit --omit=dev` must report zero
   advisories in the runtime tree. Anything below the `high` gate threshold does
   not fail the build, so read the output rather than trusting the exit code, and
   do not publish with an advisory outstanding when a fix is available. (The
   **moderate** path-traversal advisory in `@hono/node-server`, reached
   transitively through `@modelcontextprotocol/sdk`, was cleared before `0.7.0`
   by refreshing `package-lock.json` onto `@modelcontextprotocol/sdk@1.30.0`. Since
   the SDK v2 migration on 2026-10-10 the same package arrives through
   `@modelcontextprotocol/node`; `npm audit --omit=dev` reported zero advisories on
   that tree the same day.)
3. **Live validation of the tool surface. [blocked — live]** The read path,
   publishing/moderation, and OAuth login have still never been exercised
   end-to-end against a real professional account (see the Lane E live protocols in
   [corner-cases.md](corner-cases.md) §9). This did not block `0.7.0` — the release
   notes say plainly that what is proven is behaviour against recorded Graph
   shapes — but it is what stands between the current `0.x` and a `1.0.0` that
   claims field validation. Do not let a release imply otherwise.

## Version bump (single source of truth = `package.json`)

4. **Bump the version in `package.json`.** Choose the semver increment from the
   nature of the changes (tool rename = breaking; see the stability policy).
5. **Propagate the version.** There are **six** places it is written, not four —
   the plugin channel alone holds three of them:
   - `server.json` — top-level `version` **and** `packages[].version`
   - `manifest.json` (MCPB) — `version`
   - `plugins/instagram-mcp-ai/.claude-plugin/plugin.json` — `version` **and** the pinned
     `instagram-mcp-ai@<version>` in `mcpServers.instagram.args`
   - `.claude-plugin/marketplace.json` — `plugins[0].version`, the version shown
     in the install listing before anything is fetched
   The drift test asserts the four *channels* agree and separately checks the two
   extra copies (the `npx` pin and the marketplace entry) — do not skip it.
6. **Update the changelog.** In [`CHANGELOG.md`](../CHANGELOG.md), move the
   `## [Unreleased]` entries into a new `## [x.y.z] - YYYY-MM-DD` section, reset
   `Unreleased` to empty, and fix up the link references (add the tag-compare link
   for the new version; point `Unreleased` at `…/compare/vx.y.z...HEAD`). Use the
   real release date — never a placeholder or a guessed one.

## Tag & publish

7. **Commit and tag. [human]** Commit the version bump + changelog, then create an
   annotated tag `vx.y.z` and push it. The tag drives the publish workflows, and a
   pushed tag is not safely retractable.
8. **npm publish with provenance. [human]** Publish via the release workflow:
   `npm publish` authenticated by the `NPM_TOKEN` repo secret, with provenance
   from `publishConfig.provenance` plus the job's OIDC `id-token` grant. The workflow re-runs
   the full gate (`npm run check`, including coverage thresholds and the audit) as
   its own step before the npm token is in scope, then publishes with
   `--ignore-scripts`. A manual `workflow_dispatch` re-run must be started from the
   `vx.y.z` tag, not a branch. Requires npm publish rights; an npm publish is
   effectively irreversible.
9. **Publish to the MCP registry. [human]** Publish `server.json` for
   `io.github.IvanBBaev/instagram-mcp-ai` **after** the npm publish succeeds — the
   registry validates against the published npm tarball. Public and immediate.
10. **Build and attach the MCPB bundle. [human]** Run `scripts/build-mcpb.sh . ./out`
    (never a bare `mcpb pack` from the repo root — it archives `src/`, `test/`, dev
    `node_modules` and local AI-harness files), attach the resulting
    `out/instagram-mcp-ai-<version>.mcpb` to the GitHub Release for the tag with
    `gh release upload`, and verify the bundle's `manifest.json` version matches the tag.
    - **MCPB token acquisition. [blocked — live]** The one-click install story for
      non-CLI users (keychain-backed `user_config`, getting a token into hand)
      depends on live OAuth and a published app; validate it on a clean machine
      before promoting the bundle.
11. **List the Claude Code plugin. [human]** The plugin is served from the git
    repo rather than the npm tarball (`.claude-plugin/` and `plugins/` are outside the `files`
    allowlist, asserted by `test/release/packaging.test.ts`). Both blockers are
    now closed:
    - **The repo IS a marketplace.** `.claude-plugin/marketplace.json` exists and
      lists this repo's single plugin with `"source": "./plugins/instagram-mcp-ai"`
      (resolved against the marketplace root, the repo root; the plugin root holds
      only `.claude-plugin/plugin.json` and no `package.json`, so Claude Code runs no
      `npm ci` in the user's plugin cache), so
      `/plugin marketplace add IvanBBaev/instagram-mcp` resolves. Both manifests
      validate against the published JSON schemas. An earlier version of this step
      said tagging alone made the plugin installable; it did not, and the missing
      marketplace file was why.
    - **The `npx` pin needs step 8 to have landed.**
      `plugins/instagram-mcp-ai/.claude-plugin/plugin.json` launches `npx -y instagram-mcp-ai@<version>`,
      so the matching npm version must exist first. For `0.8.0` it does; what
      remains is the listing itself and an install by a real Claude Code client.

    See [plugin-install.md](plugin-install.md) for the operator-facing page,
    including how a credential reaches a server whose manifest declares none.

## Post-publish verification

12. **Install-test all four channels [blocked — live/human]:**
    - `npx instagram-mcp-ai` from a clean machine
    - the registry entry resolves in an MCP client
    - the `.mcpb` installs into Claude Desktop and connects
    - `/plugin install` picks up `plugins/instagram-mcp-ai/.claude-plugin/plugin.json` and the server
      starts under Claude Code
    Confirm every published version matches the tag.
13. **Announce / close out. [human]** Verify the changelog link references resolve
    and the GitHub Release notes match `CHANGELOG.md`.

## Current status

- **Runnable now:** steps 1, 2, 4–6 (offline) and the four-channel drift test.
- **Blocked on live credentials:** step 3, MCPB token acquisition, and the
  end-to-end install tests (step 12).
- **Requires a human:** steps 7–11 and the publish half of step 12 — deliberate,
  irreversible outward actions, never automated unattended.
- **Most urgent:** the three unshipped channels (see the reality check above) —
  the MCP-registry submission, the MCPB bundle, and the plugin-marketplace
  listing. The npm name is claimed (`0.7.0`) and `0.8.0` is published, so the `npx` pin the plugin
  manifest carries now resolves against a real package; nothing but the manual
  submissions is in the way.
