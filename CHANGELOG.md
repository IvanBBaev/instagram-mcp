# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.7.0] — 2026-08-25

First published release. `0.7.0` rather than `0.1.0` because the feature surface
is complete — all 28 tools across five packages, both auth paths, four
distribution manifests — and what separates it from `1.0.0` is field validation
against live accounts, not missing functionality. The `0.0.1` that appeared in
the manifests before this tag was a pre-release placeholder and was never
published to any channel.

npm is the only channel published by this tag. The MCP-registry submission, the
MCPB bundle and the Claude Code plugin listing are separate manual steps (see
`docs/release-checklist.md`); their manifests carry `0.7.0` so they are ready to
submit, but carrying the version is not the same as being listed.

### Added

- **Frozen contracts + core substrate.** Shared type contracts (`ToolSpec`,
  `InstagramError` with a `kind` discriminant, `IgRequestFn`, `AuthProvider`,
  config/profile/settings shapes, injectable `Clock`); auth providers for both
  Instagram-login and Facebook-login paths with per-profile mode resolution and
  `appsecret_proof`; an HTTP client (`igRequest`) with a hard SSRF host allowlist,
  the retry/backoff matrix (`Retry-After` cap, per-host semaphore), usage-header
  parsing, and the `v25.0` version pin; a redaction layer masking configured
  secrets and token-shaped strings; the `InstagramError` taxonomy mapping the full
  Graph error/subcode table.
- **Read path.** `account` package (get account, list linked accounts, token
  status), `media` package (list/get media, toggle comments), and `insights`
  package (account/media insights, audience demographics, online followers) with
  the post-2025 `views`-based metric set, cursor pagination, and code-point-safe
  truncation.
- **Write path (through the write gate).** `publishing` package implementing the
  container → publish flow for feed images, carousels, Reels, and Stories
  (composite post tools with a poll budget, resumable containers, runtime quota
  checks), plus comment moderation (list/get/reply/create/hide/unhide/delete and
  tagged media). Every write is preview-by-default with `apply` to execute;
  irreversible deletes are double-gated; `media_publish` is never auto-retried.
- **Discovery** (Facebook-login only). Hashtag search with a local 30-per-7-days
  budget tracker, hashtag media, and business discovery of public competitor
  profiles.
- **CLI.** `login` (loopback OAuth for both paths with a checked `state`),
  `doctor` (token validity, account resolution, scope inventory, publishing quota,
  usage headroom, Meta-app Development/Live mode, config-tier report), and
  `refresh` (Path-A token refresh with a configurable threshold).
- **Transports.** stdio (default, stdout-purity guarded) and an opt-in,
  loopback-bound Streamable HTTP transport with a constant-time bearer check.
- **Distribution manifests for four channels.** `package.json` (npm) as the single
  source of truth, `server.json` (MCP registry), `manifest.json` (MCPB bundle for
  Claude Desktop) and `.claude-plugin/plugin.json` (Claude Code plugin, launching
  the server through a version-pinned `npx`). A release drift test asserts all
  four agree on the version, and the plugin manifest is deliberately excluded from
  the npm tarball.
- **Quality gate.** `npm run check` now runs `lint → format:check → build →
  coverage → audit`. Coverage is enforced by c8 `--check-coverage` thresholds
  rather than merely reported, and `npm run audit` hard-gates high-severity
  advisories in the runtime dependency tree (`--omit=dev`), with dev-only
  advisories surfaced informationally by `npm run audit:dev`.

### Fixed

- The **moderate** path-traversal advisory
  ([GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9)) in
  `@hono/node-server`, reached transitively through `@modelcontextprotocol/sdk`,
  is cleared: the lockfile now resolves a patched version, and
  `npm audit --omit=dev` reports zero advisories in the runtime tree.

### Known limitations

- No tool has been exercised against a live Instagram account by CI. The suite is
  fully offline by construction — every test injects its transport and a
  `globalThis.fetch` guard fails the test if a mutant reaches the network — so
  what is proven is behaviour against recorded Graph shapes, not against Meta's
  live responses. Live-probe scripts exist (`scripts/live-probe.mjs`) but are
  operator-run.

[Unreleased]: https://github.com/IvanBBaev/instagram-mcp/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/IvanBBaev/instagram-mcp/releases/tag/v0.7.0
