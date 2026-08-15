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
| 4 | Claude Code plugin | `.claude-plugin/plugin.json` | the git repo / a plugin marketplace |

The Claude Code plugin does **not** ship in the npm tarball (`files` in
`package.json` is an allowlist and deliberately omits `.claude-plugin/`). It is
installed from git and launches the server via `npx instagram-mcp-ai@<version>`,
so the plugin manifest pins the npm version it serves — the drift test asserts
that pin as well.

## Reality check — nothing has shipped yet

As of this checklist's last revision, **not one channel has been published**:

- **npm — the name is not even reserved.** `npm view instagram-mcp-ai` returns
  **404**: the package does not exist in the registry. The roadmap's M0 item
  "reserve the npm name by publishing a `0.0.1` stub" was never carried out, so
  the name is still unclaimed and could be taken by someone else. Reserving it is
  the cheapest and most urgent outstanding action.
- **MCP registry —** no `server.json` has been submitted.
- **MCPB —** no `.mcpb` bundle has been built or attached to a release.
- **Claude Code plugin —** the manifest exists in-tree but the repo is not listed
  in any plugin marketplace.

No git tag `v*` has been cut and `CHANGELOG.md` has no released section. Treat
every "publish" step below as never-yet-exercised.

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
   `lint → format:check → build → coverage → audit`.
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
2. **Review outstanding advisories.** `npm audit --omit=dev` currently reports a
   **moderate** path-traversal advisory in `@hono/node-server` reached
   transitively through `@modelcontextprotocol/sdk`. It sits below the `high`
   gate threshold, so it does not fail the build — but do not publish a release
   with it outstanding when a fix is available. `@modelcontextprotocol/sdk@1.30.0`
   depends on a patched `@hono/node-server`, and the declared range (`^1.0.0`)
   already allows it, so refreshing `package-lock.json` clears it.
3. **Live validation of the tool surface. [blocked — live]** Before a *functional*
   release, the read path, publishing/moderation, and OAuth login must be exercised
   end-to-end against a real professional account (see the Lane E live protocols in
   [corner-cases.md](corner-cases.md) §9). Until then, only a name-reservation stub
   can ship.

## Version bump (single source of truth = `package.json`)

4. **Bump the version in `package.json`.** Choose the semver increment from the
   nature of the changes (tool rename = breaking; see the stability policy).
5. **Propagate the version.** There are **six** places it is written, not four —
   the plugin channel alone holds three of them:
   - `server.json` — top-level `version` **and** `packages[].version`
   - `manifest.json` (MCPB) — `version`
   - `.claude-plugin/plugin.json` — `version` **and** the pinned
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
8. **npm publish with provenance. [human]** Publish via the release workflow using
   trusted publishing / OIDC (`npm publish --provenance`). `prepublishOnly` re-runs
   the full gate (including coverage thresholds and the audit). Requires npm
   publish rights; an npm publish is effectively irreversible.
9. **Publish to the MCP registry. [human]** Publish `server.json` for
   `io.github.IvanBBaev/instagram-mcp-ai` **after** the npm publish succeeds — the
   registry validates against the published npm tarball. Public and immediate.
10. **Build and attach the MCPB bundle. [human]** Run `mcpb pack`, attach the
    resulting `.mcpb` to the GitHub Release for the tag, and verify the bundle's
    `manifest.json` version matches the tag.
    - **MCPB token acquisition. [blocked — live]** The one-click install story for
      non-CLI users (keychain-backed `user_config`, getting a token into hand)
      depends on live OAuth and a published app; validate it on a clean machine
      before promoting the bundle.
11. **List the Claude Code plugin. [human]** The plugin is served from the git
    repo rather than the npm tarball (`.claude-plugin/` is outside the `files`
    allowlist, asserted by `test/release/packaging.test.ts`). One blocker is now
    closed and one remains:
    - **The repo IS a marketplace.** `.claude-plugin/marketplace.json` exists and
      lists this repo's single plugin with `"source": "./"` (the marketplace root
      is the directory containing `.claude-plugin/`, i.e. the repo root), so
      `/plugin marketplace add IvanBBaev/instagram-mcp` resolves. Both manifests
      validate against the published JSON schemas. An earlier version of this step
      said tagging alone made the plugin installable; it did not, and the missing
      marketplace file was why.
    - **The `npx` pin resolves nothing until step 8 lands.**
      `.claude-plugin/plugin.json` launches `npx -y instagram-mcp-ai@<version>`,
      so the matching npm version must exist first. This is the whole remaining
      blocker for the channel.

    See [plugin-install.md](plugin-install.md) for the operator-facing page,
    including how a credential reaches a server whose manifest declares none.

## Post-publish verification

12. **Install-test all four channels [blocked — live/human]:**
    - `npx instagram-mcp-ai` from a clean machine
    - the registry entry resolves in an MCP client
    - the `.mcpb` installs into Claude Desktop and connects
    - `/plugin install` picks up `.claude-plugin/plugin.json` and the server
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
- **Most urgent:** reserve the npm name (see the reality check above); it is
  currently unclaimed.
