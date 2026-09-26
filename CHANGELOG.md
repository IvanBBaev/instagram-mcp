# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `discover_business`: new `mediaAfter` input and `mediaPaging` output. The
  nested media edge now reports `truncated: true` with an `after` cursor when
  Instagram returned one; pass it back as `mediaAfter` (sent as
  `media.after(<cursor>)`) to read the next page of the profile's media
  (CC-DATA-116).

### Changed

- A bare `IG_TOKEN_EXPIRES_AT` record (`<seconds>` with no token fingerprint) is
  still read, but `token_status` and `doctor` now report it as unverified in every
  dated state, `valid` and `never` included, instead of presenting it as a fact
  about the current token (CC-AUTH-70).
- The Path A expiry note now reads "This is the expiry `login`/`refresh` recorded
  in … for this token."
- A JSON text block now has key-name masking too: an `access_token` value that
  was masked only in `structuredContent` is now `[REDACTED]` in the text as well
  (CC-DATA-104).
- `summarizeDataAccessExpiry` in `src/api/account.ts` is the one place that reads
  `data_access_expires_at`, and both `token_status` and `doctor` use it, so the two
  diagnostics cannot disagree (CC-AUTH-77).
- README lists the `--app-id` / `--app-secret` login options; `docs/auth.md` §2 links the setup guide instead of a "future README".

### Fixed

- `instagram_get_account_insights` with `metric_type: "time_series"` now defaults to
  `reach`, the only account metric Instagram serves as a time series, and refuses
  any other metric with it before a call; a bare `time_series` used to request all
  eleven metrics and always fail (CC-INS-25).
- `instagram_get_account_insights` now refuses a `since` after `until` instead of
  forwarding the inverted window (CC-INS-26).
- `instagram_get_audience_demographics` now sends `period=lifetime`, which Meta
  marks required (CC-INS-27).
- `login` no longer waits forever on a token endpoint that accepts the connection
  and never answers: each OAuth exchange now has the same 30 s timeout as
  `refresh` (CC-AUTH-72).
- `login` no longer follows a redirect from a token endpoint. A 307/308 on the
  Instagram code exchange used to re-send the app secret and the authorization
  code to the redirect target; like `refresh`, it now fails instead
  (CC-AUTH-73).
- A `Retry-After` value that is neither delta-seconds nor an IMF-fixdate (`1.5`,
  `-1`, `+5`, `60,`) now falls back to exponential backoff. V8 read these as
  dates in 2001 or 1960, so the retry fired with no delay (CC-RATE-17).
- A media URL (`imageUrls`, `imageUrl`, `videoUrl`, `coverUrl`) containing a
  control character is refused as not a well-formed https URL. The parser silently
  dropped a trailing newline or a tab/LF inside the host, so the URL was judged
  valid while the raw string, sent to Graph unchanged, named a different host
  (CC-PUB-57).
- `IG_PRETTY_JSON=true` now pretty-prints the text block of every tool, and of the
  write gate's preview and refusal results; 25 of the 28 tools used to ignore it
  (CC-DATA-30, CC-DATA-112).
- `token_status` no longer reports a Path B `data_access_expires_at` of `0` as a
  data-access window that closed in 1970; `dataAccessExpiresAt` is absent, as when
  Meta omits the field (CC-DATA-113).
- `login` and `refresh` record the expiry when Meta quotes `expires_in` as a
  canonical non-negative integer string; any other string still leaves no record
  (CC-AUTH-69).
- A Path B `debug_token` `expires_at` outside the recorded range (milliseconds,
  negative, fractional, past year 9999) reads as unknown, as Path A already did,
  instead of a token valid until year 58692 (CC-AUTH-68).
- A blank or relative `HOME` / `USERPROFILE` is refused, naming the variable,
  instead of putting `~/…` and the default config home under the cwd
  (`HOME="   "` wrote `<cwd>/   /instagram-mcp-ai/.env`) (CC-CFG-69).
- **Behaviour change:** a relative `IG_ENV_FILE` now stops the server at
  start-up, as `login` / `refresh` already refused it; it used to be read
  relative to the MCP client's cwd (CC-CFG-70).
- An unexpanded `${user_config.X}` template written as a value inside an env
  file reads as unset, as it already did in the client's environment (CC-CFG-71).
- A symlinked store is resolved again under the write lock, and a link re-pointed
  in between refuses the write (CC-CFG-72); every link in a chain is
  owner-checked, not only the first (CC-CFG-73).
- Every directory on the way to the credentials store — plain, symlinked, or
  the one a link leads to — must be owned by you or by root; one owned by another
  user refuses the write. A `..` in a link target is climbed from where a
  directory link led, as the kernel does, instead of being cancelled as text
  (CC-CFG-74). **Behaviour change:** an `IG_ENV_FILE` inside another user's
  directory is now refused.
- A blank or relative `HOME` / `USERPROFILE` is refused for the default write
  journal too, instead of putting the audit trail under the cwd; the default is
  resolved when read, so importing the settings never fails on it (CC-CFG-75).
- `login` / `refresh` write an `IG_ENV_FILE` with a `..` after a symlinked
  directory to the file the server loads, not to a lexically normalized one
  (CC-CFG-76).
- A Path B `debug_token` `data_access_expires_at` outside the recorded range reads
  as unknown with a warning, as `expires_at` already did, instead of a far-future
  data-access date (CC-AUTH-71).
- A `fetchAll` media or comment listing that hits an expired token, a missing
  permission, a rate limit or a Meta outage after the first page now reports that
  error. It used to return the pages read so far with a "cursor may be stale —
  restart the listing" note. Only an invalid cursor still keeps the partial
  result (CC-DATA-105).
- `instagram_discover_business` answered with a JSON `null` body now returns the
  "no profile" note instead of an internal `TypeError` (CC-DATA-106).
- An own `__proto__` key in a tool result's JSON body is kept, with its value
  redacted, instead of silently vanishing from the result (CC-DATA-107).
- `list_media`, `list_comments`, `list_tagged_media`, `list_linked_accounts` and
  `get_hashtag_media` now read the end of a listing from a missing `paging.next`,
  as Graph documents, instead of from a missing `paging.cursors.after`, which Graph
  still sends on the last page. The last page no longer hands back a resume
  `after`, a `fetchAll` whose cap lands exactly on the final page boundary is no
  longer reported `truncated`, and `fetchAll` no longer spends one extra request
  past the end. A page with `paging.next` and no cursor resumes from the `after`
  in that URL (CC-DATA-115).
- `login`: a token exchange that times out or fails in transport (connection
  refused, DNS, a refused redirect) now rejects as a typed `InstagramError`
  (kind `upstream`, original error on `cause`), like every other exchange
  failure and like `refresh`; the printed `login failed:` line is unchanged
  (CC-AUTH-74).
- `login`: an exchange answering with a whitespace-only `access_token` is
  refused at that exchange with "did not include an access_token", instead of
  being sent on beside the app secret and failing later with a misleading
  persist error (CC-AUTH-75).


- A media URL whose scheme is not followed by exactly `//` (`https:/cdn/a.jpg`,
  `https:cdn/a.jpg`, `https:///cdn/a.jpg`), or that has a backslash before its query,
  is now refused as not a well-formed `https://` URL. The URL parser silently
  repaired these shapes to `https://cdn/…` for the check, while the raw string was
  what Graph received (CC-PUB-58).

- `discover_business` no longer drops the nested media edge's paging, which
  made a capped media list look like the account's complete output. A cursor
  that cannot be sent back is reported as `truncated: true` with the
  unusable-cursor note, never as the end (CC-DATA-116).
- `reply_to_comment` and `create_comment` now refuse a whitespace-only
  `message` before any call, as CC-COM-6 always stated. Previously only an
  empty string was refused, so `"   "` reached Graph as a public write. A
  message with real text is still posted exactly as written, untrimmed
  (CC-COM-18).
- `get_comment` no longer fails the whole read with MCP error -32602 when the
  nested `media` context carries a `media_type` or `permalink` of the wrong
  type (`null`, a number). The mistyped field is dropped, as it already was on
  the comment itself (CC-COM-19).


- `doctor` now reports the Path B data-access window (`data_access_expires_at`), which
  closes independently of the token. It prints `OK` while the window is open, `WARN`
  once it has closed, and `INFO unknown` for a value that is not an instant. It prints
  nothing when Meta reports no window or `0`. Before this, a valid token with a closed
  window showed only OK token lines (CC-AUTH-77).
- `instagram_token_status` now adds a warning when the data-access window has already
  closed, next to any token-expiry warning. Before this, it published the past date
  with no warning, so a token whose data reads all fail looked healthy (CC-AUTH-77).
- The wire-value renderer used by the timestamp guards and `doctor` no longer throws on a value that cannot be turned into a string at all (a circular object with no prototype, a revoked proxy); it renders `[unrenderable]` instead, as its "never throws" contract promises. (CC-DATA-128)

- `instagram_list_media` no longer claims to list stories. Instagram's media edge never returns story media (they live on a separate stories edge), so the description now lists feed posts, reels and albums, says stories are not included, and drops the "counts on stories" wording; `docs/tools.md` and the README tools table follow. (CC-DATA-118)

- `server.json` described `IG_ACCOUNT_ID` as skipping a lookup and disambiguating between reachable accounts; no lookup exists. It now matches `manifest.json`: optional with an Instagram-Login token (calls address `me`), required with a Facebook-Login token.
- `docs/plugin-install.md` and the README Setup paragraph claimed the npm package blocker was fully cleared; the plugin manifest pins `instagram-mcp-ai@0.8.0`, which is not published yet (npm has 0.7.0), so the docs now say the launcher resolves only once the pinned version is published.
- `docs/architecture.md` said 429 is retried on any method; only idempotent calls (GET by default) are retried, and POST/DELETE is never replayed, matching `core/http.ts` and operations.md.
- `docs/index.html` listed the `core` profile as 24 tools (it is 25), omitted the `after` / `mediaAfter` cursor parameters of `list_linked_accounts`, `get_hashtag_media` and `discover_business`, understated the delete gate (`apply: true` or `IG_WRITE_MODE=apply`, plus `IG_ALLOW_DESTRUCTIVE=true`), and described `IG_ENV_FILE` and env loading inaccurately.
- `docs/troubleshooting.md` quoted a paraphrase of the auth-path refusal; it now quotes the real message shape (`Tool '…' is not available on the '…' auth path`).

### Removed

- The unused `text()` result builder in `src/mcp/result.ts`; every tool result is
  JSON (CC-DATA-114).
- The unused `needsRefresh` helper in `core/refresh.ts`; refresh stays
  operator-driven (CC-AUTH-67).

### Security

- A secret redactor that throws while masking a tool result (a JSON body nested
  too deep to walk, for one) now withholds the result like any other unusable
  redaction, instead of letting the exception's own message reach the client
  unredacted (CC-DATA-108).
- A tool result's text block no longer carries invisible characters. Before, it was
  plain `JSON.stringify` of the payload, which leaves DEL, C1 controls, bidi
  overrides, zero-width and tag characters and U+2028/U+2029 raw. So a caption,
  username, id or cursor could reorder what the model reads, hide text, or break the
  line and forge an `Instagram error (…)` frame. Each such character is now a JSON
  `\uXXXX` escape, so the text still parses to `structuredContent`. The escaping is
  applied in the registry after secret masking, on error results too.
  `structuredContent` still carries wire text as received, so emoji ZWJ sequences
  and right-to-left marks are preserved. The rule is documented in
  docs/security.md §7 (CC-DATA-102, CC-DATA-103).
- A tool result's JSON text block is now redacted as a parsed value and
  re-serialized, so key-name masking and a registered secret that contains a
  character JSON escapes both reach the text, not only `structuredContent`. If the
  redacted value cannot be serialized, the result is withheld (CC-DATA-104).
- A container or child id that Graph returns is quoted with visible escapes and a
  64-character cap in publishing errors and acknowledgements unless it matches the
  Graph id grammar, so a forged id cannot break the line and fake a "Published"
  message (CC-PUB-56).
- `login` now masks the app secret, the authorization code and both tokens in
  their form-encoded spelling (`%2B`, `%2F`, `%3D`, `+`) as well as raw, so a
  transport or persist error quoting an encoded request cannot print them
  (CC-AUTH-76).

- `discover_business`: the `mediaAfter` cursor is interpolated into a Graph
  field expression, which has no escaping. Like `username`, it is therefore
  pinned to a strict charset (`^[A-Za-z0-9_+/=-]{1,2048}$`) in the tool
  schema, and re-checked in the api layer. The refusal does not echo the value
  (CC-DATA-116).
- A `paging.next` URL that names `after` more than once is now read as an
  unusable cursor, where the first copy used to be followed silently (CC-DATA-117).
- The secret redactor, and the token stripper applied to Graph error text, no longer take quadratic time on a long identifier-like run that starts with `IG_` and repeats `IG` plus a letter. 200 000 such characters used to block the whole server for about 15 seconds. The same run now takes a few milliseconds. What is masked and what is kept is unchanged. (CC-DATA-121)
- A string wrapped in a `String` object (`new String(token)`) inside a value the redactor copies is now masked as one string. Before, it was copied one character per key, so no secret pattern could match it and the secret reached the log in pieces. Wrapped numbers and booleans now keep their value instead of becoming `{}`. (CC-DATA-122)

- A usage refusal no longer writes a secret into the host's log. `instagram-mcp-ai --access-token=<token>` (or a bare pasted token as the first argument) was refused with the whole token echoed to stderr, which MCP hosts keep in their log files. Both refusals, for an unknown subcommand and for an argument after `doctor` / `refresh`, now cut the echoed token at its first `=` and mask a token-shaped value as `[REDACTED]`. (CC-PROC-208)

## [0.8.0] — 2026-09-24

### Added

- `--help`/`-h` print usage and exit 0; an unknown subcommand or flag exits 2
  instead of starting the stdio server (0.7.0 treated every argument as a start).
- `scripts/build-mcpb.sh` builds a lean MCPB bundle (~3 MB) from the npm tarball
  contents plus production dependencies.
- `scripts/live-qa.mjs` and `docs/live-qa.md`: one-command live verification of
  T-E1–T-E4 and the open `[verify]` probes, read-only unless `--write` is confirmed.
- `server.json` declares `IG_AUTH_MODE`, `IG_WRITE_MODE` and `IG_TOOL_PACKAGES`.
- List, media, comment and insights results report what was left out
  (`omittedWithoutId`, `omittedValues`, `repliesTruncated`, `paging.truncated`)
  instead of dropping it silently.

### Changed

- **Breaking for clients that parsed it:** an error result no longer carries
  `structuredContent.error`. SDK clients validated that envelope against the
  tool's output schema and turned every typed error into `-32602`; the typed
  error is now the text line `Instagram error (<kind>): <message> (code N,
  subcode M)`.
- An unresolved MCPB placeholder (`${user_config.X}`) in an `IG_*` variable is
  treated as unset.
- The MCPB manifest pins `IG_AUTH_MODE` (default `ig-login`), so filling both app
  fields no longer switches a Path-A token to `fb-login`.
- The recorded token expiry is bound to a fingerprint of the token it was written
  for; a record for a different token is ignored.
- The Claude Code plugin moved to `plugins/instagram-mcp-ai/` and the marketplace
  entry now reads `"source": "./plugins/instagram-mcp-ai"`. With `"source": "./"`
  Claude Code copied the whole repo into its plugin cache and ran `npm ci` on the
  root `package.json`, about 88 MB of dev dependencies per install. The plugin
  directory holds no `package.json`, so the cached copy is a few kilobytes.
  `/plugin marketplace add IvanBBaev/instagram-mcp` is unchanged.

### Fixed

- Redaction of the `login` failure line, stray expiry records, and missing
  `quota_usage` no longer read as 0 — see `docs/corner-cases.md` audit waves 5–7.

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

[Unreleased]: https://github.com/IvanBBaev/instagram-mcp/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/IvanBBaev/instagram-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/IvanBBaev/instagram-mcp/releases/tag/v0.7.0
