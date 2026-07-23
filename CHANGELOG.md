# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing functional is published to npm yet: `instagram-mcp-ai@0.0.1` is a
name-reservation stub only. This section is the honest running inventory of what
already exists in the source tree and will constitute the first published release.

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

[Unreleased]: https://github.com/IvanBBaev/instagram-mcp/commits/main

<!--
  Link-reference stub for the first published release. When cutting it, replace the
  Unreleased link above with a compare against the new tag and uncomment the line
  below (see docs/release-checklist.md).
-->
<!-- [0.1.0]: https://github.com/IvanBBaev/instagram-mcp/releases/tag/v0.1.0 -->
