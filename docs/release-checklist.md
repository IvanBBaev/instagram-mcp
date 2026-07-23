# Release Checklist

Ordered steps to cut a release of `instagram-mcp-ai` across all three distribution
channels (npm, MCP registry, MCPB bundle). `package.json` is the **single source of
truth** for the version; every other version copy is derived from it and kept in
lockstep by the drift test in
[`test/release/version-consistency.test.ts`](../test/release/version-consistency.test.ts).

> **`server.json` and `manifest.json` are produced by sibling release tasks**
> (`server.json` by T-R5, the MCPB `manifest.json` by T-R6). This checklist assumes
> both exist and are generated from the canonical env catalog
> ([architecture.md](architecture.md) §12).

> **Blocked steps.** Several steps below require **real Instagram credentials and
> live validation** and cannot be completed until a live junk account and a
> published-app posture are in hand. They are marked **[BLOCKED — live]**. Steps
> that are a maintainer-only publishing action are marked
> **[BLOCKED — maintainer]**. Everything else runs offline against mocks/fixtures
> today.

## Pre-flight (offline, runnable now)

1. **Quality gate green.** Run `npm run check` (lint + format check + build +
   tests). It must be green, including the version-consistency drift test. CI runs
   the same gate on the Node 22/24 × ubuntu/macOS/Windows matrix plus `npm audit`
   and CodeQL — confirm the matrix is green on the release commit.
2. **Live validation of the tool surface. [BLOCKED — live]** Before a *functional*
   release, the read path, publishing/moderation, and OAuth login must be exercised
   end-to-end against a real professional account (see the Lane E live protocols in
   [corner-cases.md](corner-cases.md) §9). Until then, only the `0.0.1`
   name-reservation stub can ship.

## Version bump (single source of truth = `package.json`)

3. **Bump the version in `package.json`.** Choose the semver increment from the
   nature of the changes (tool rename = breaking; see the stability policy).
4. **Propagate the version** to `server.json` (top-level `version` **and**
   `packages[].version`) and to the MCPB `manifest.json` `version`. These are
   generated from `package.json`; re-run their generators rather than editing by
   hand. The drift test asserts all three agree — do not skip it.
5. **Update the changelog.** In [`CHANGELOG.md`](../CHANGELOG.md), move the
   `## [Unreleased]` entries into a new `## [x.y.z] - YYYY-MM-DD` section, reset
   `Unreleased` to empty, and fix up the link references (add the tag-compare link
   for the new version; point `Unreleased` at `…/compare/vx.y.z...HEAD`).

## Tag & publish

6. **Commit and tag.** Commit the version bump + changelog, then create an
   annotated tag `vx.y.z`. The tag drives the publish workflows.
7. **npm publish with provenance. [BLOCKED — maintainer]** Publish via the release
   workflow using trusted publishing / OIDC (`npm publish --provenance`).
   `prepublishOnly` re-runs the full gate. This is a maintainer action requiring npm
   publish rights.
8. **Publish to the MCP registry. [BLOCKED — maintainer]** Publish `server.json`
   for `io.github.IvanBBaev/instagram-mcp-ai` **after** the npm publish succeeds
   (the registry validates against the published npm tarball). Maintainer action.
9. **Build and attach the MCPB bundle. [BLOCKED — maintainer]** Run `mcpb pack`,
   attach the resulting `.mcpb` to the GitHub Release for the tag, and verify the
   bundle's `manifest.json` version matches the tag.
   - **MCPB token acquisition. [BLOCKED — live]** The one-click install story for
     non-CLI users (keychain-backed `user_config`, getting a token into hand)
     depends on live OAuth and a published app; validate it on a clean machine
     before promoting the bundle.

## Post-publish verification

10. **Install-test all three channels [BLOCKED — live/maintainer]:** `npx
    instagram-mcp-ai` from a clean machine, the registry entry resolves in an MCP
    client, and the `.mcpb` installs into Claude Desktop and connects. Confirm the
    published versions match the tag.
11. **Announce / close out.** Verify the changelog link references resolve and the
    GitHub Release notes match `CHANGELOG.md`.

## Current status

- **Runnable now:** steps 1, 3–6 (offline) and the drift test.
- **Blocked on live credentials:** step 2, MCPB token acquisition, and the
  end-to-end install tests (step 10) — no live validation has been performed yet.
- **Blocked on maintainer publish rights:** steps 7–9 and the publish half of
  step 10 — these are deliberate manual actions, not automated here.
