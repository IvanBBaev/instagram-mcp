# Corner-Case Catalog

> Design document (2026-07-22). Every case has an ID (`CC-<area>-<n>`), the
> expected server behavior, and a **When** column tying it to the roadmap phase
> whose exit gate must cover it (test, design decision, or live probe).
> [roadmap.md](roadmap.md) references these IDs; a phase does not exit while one
> of its cases is unhandled. `[verify]` marks behavior that needs an empirical
> probe against the live API — Meta's docs do not answer it.

Legend for **How covered**: `unit` = deterministic test with mocked fetch/clock ·
`design` = must be decided in the design, then unit-tested · `live` = live-API
probe protocol (junk account) · `docs` = documented behavior/limitation.

## 1. Auth & tokens (CC-AUTH)

| ID | Scenario | Expected behavior | When / how |
|---|---|---|---|
| CC-AUTH-1 | Token expires mid-session (day 60 passes while the server is running) | Next call maps 190 → `kind: auth` with remediation ("run `refresh` / `login`"); no retry storm | M1 · unit |
| CC-AUTH-2 | Path-A refresh called on a token < 24 h old | Meta rejects it; server knows the obtained-at timestamp and refuses locally with a clear "too new to refresh" message instead of burning a call | M2 · unit |
| CC-AUTH-3 | Path-A refresh attempted on an already-expired token | Refresh cannot resurrect it; error says a full `login` is required | M2 · unit |
| CC-AUTH-4 | Token supplied via client `env`, auto-refresh persists to XDG — refreshed token never takes effect (the refresh-persistence trap) | **Design gate D2** (see roadmap): resolved before M2; until then auto-refresh is disabled for client-env tokens and `token_status` warns | M2 · design |
| CC-AUTH-5 | Both `IG_ACCESS_TOKEN` and `IG_FB_ACCESS_TOKEN` set, no `IG_AUTH_MODE` | Hard startup error naming both vars — never guess an auth path | M1 · unit |
| CC-AUTH-6 | `IG_ACCOUNT_ID` does not match the account the token resolves to (`/me`) | `doctor` flags the mismatch; tools fail fast with both IDs in the message | M1 · unit |
| CC-AUTH-7 | Token pasted manually (never went through `login`) — no exchange metadata, and Path A has no `debug_token` to recover expiry | `token_status` reports expiry **unknown** honestly, recommends re-acquiring via `login`; never invents a date | M1 · unit |
| CC-AUTH-8 | IG account converted professional → personal while the server holds a token | Graph starts erroring (100/190-class); mapped error explains the account-type requirement, points at the conversion doc | M1 · docs + unit |
| CC-AUTH-9 | Path-A user changes Instagram password / revokes the app | Token dies before expiry date; same handling as CC-AUTH-1 — metadata-based expiry is a hint, not a guarantee | M1 · docs |
| CC-AUTH-10 | Token granted before a scope was added to the app (scope drift) | 10/200-series → `kind: permission` naming the missing scope **and** the fix (re-run `login` to re-consent) | M1 · unit |
| CC-AUTH-11 | Path-B system-user token whose Business assets don't include the target Page/IG account | Permission error names the asset-assignment step, not just the scope | M1 · docs + unit |
| CC-AUTH-12 | Path B: `data_access_expires_at` (90-day data-access window) expires independently of token validity | `doctor`/`token_status` surface it separately; nearing expiry produces its own warning | M1 · unit |
| CC-AUTH-13 | Local clock wrong / DST shift → "days left" and refresh-threshold math skewed | All time math goes through the injectable clock; warnings state the absolute expiry timestamp, not only "N days left" | M1 · unit |
| CC-AUTH-14 | Two server instances (e.g. two Claude windows) both trigger Path-A auto-refresh concurrently | Refresh is guarded: re-read the env file before refreshing (another instance may have already rotated it); atomic write prevents interleaved corruption. Whether Meta invalidates the old token on refresh: `[verify]` | M2 · design + live |

## 2. Publishing & container state machine (CC-PUB)

| ID | Scenario | Expected behavior | When / how |
|---|---|---|---|
| CC-PUB-1 | Container reaches `FINISHED`, but `media_publish` fails (quota, 5xx, integrity) | Error carries the container ID; composite returns a **resumable** result; `media_publish` is never auto-retried | M2 · unit |
| CC-PUB-2 | Composite hits the 60 s poll cap while the container is still `IN_PROGRESS` | Returns in-progress result + container ID + instruction to resume; composites accept `resume_container_id` to continue without re-creating | M2 · design + unit |
| CC-PUB-3 | Container expired (code 24 / subcode 2207008 — 24 h passed unpublished) | Actionable error: re-create; the write journal shows the original creation for reference | M2 · unit |
| CC-PUB-4 | `media_publish` called twice for the same container (model retry) | Second call fails Meta-side; server detects the already-`PUBLISHED` status and reports success-idempotently with the existing media ID rather than a raw error `[verify exact error shape]` | M2 · unit + live |
| CC-PUB-5 | Carousel: one child container fails / times out while siblings finish | Composite reports which child failed and returns all sibling container IDs; no parent container is created on partial failure | M2 · unit |
| CC-PUB-6 | Carousel bounds: < 2 or > 10 children; mixing image and video children | zod rejects bounds client-side; mixed media is allowed by Meta — do not over-restrict `[verify current rules]` | M2 · unit + live |
| CC-PUB-7 | `image_url` unreachable by Meta (404, auth-walled, redirects, slow origin) | Container goes `ERROR`; server enriches with the container `status` detail and reminds that the URL must be publicly fetchable by Meta's crawlers | M2 · unit |
| CC-PUB-8 | Pre-signed URL (S3-style) expires between container creation and Meta's fetch/retry | Documented pitfall: recommend ≥ 1 h validity; error path same as CC-PUB-7 | M2 · docs |
| CC-PUB-9 | PNG/WebP/HEIC supplied (Meta accepts JPEG only for feed images) | zod/extension+content-type heuristic warns in preview; Meta's rejection mapped to `kind: validation` naming the JPEG-only rule | M2 · unit |
| CC-PUB-10 | Aspect ratio outside 0.8–1.91, image > 8 MB, reel > 300 MB, story video > 60 s | Client-side validation refuses **before** any container is created (no quota burn); message states the exact limit violated | M2 · unit |
| CC-PUB-11 | Caption edge: exactly 2,200 chars with emoji (UTF-16 surrogates), > 30 hashtags, > 20 @tags | Count in **code points**, not UTF-16 units `[verify Meta's counting unit]`; limits validated client-side with precise counts in the error | M2 · unit + live |
| CC-PUB-12 | Publishing-quota race: `quota_usage` shows 1 slot left, two posts run concurrently | Second gets code 9 / subcode 2207042 → refuse with reset info; composites re-check quota at apply time, not only at preview time | M2 · unit |
| CC-PUB-13 | Story specifics: no like/comment counts, self-expires in 24 h | `get_media` on an expired story returns a Graph error → mapped with "stories expire after 24 h" context; insights on expired stories degrade gracefully | M2/M4 · docs + unit |
| CC-PUB-14 | Integrity restriction (subcode 2207051) on publish or comment | Never auto-retried; Meta's `error_user_msg` surfaced verbatim; journal records the refusal | M2 · unit |
| CC-PUB-15 | `location_id` invalid or the place was deleted | Graph 100-class → `kind: validation`; documented that location tagging is best-effort | M2 · docs |
| CC-PUB-16 | Client disconnects / process killed between container creation and publish | Write journal records the container ID at creation time, so the operator can resume after restart | M2 · design + unit |

## 3. Rate limits & quotas (CC-RATE)

| ID | Scenario | Expected behavior | When / how |
|---|---|---|---|
| CC-RATE-1 | Usage headers absent on a response (Meta sends them inconsistently) | Budget snapshot keeps the last-seen value with its timestamp; `token_status` marks it "as of \<time\>", never crashes | M1 · unit |
| CC-RATE-2 | Malformed / unparseable usage-header JSON | Swallowed with a debug log; never breaks the actual response path | M1 · unit |
| CC-RATE-3 | `Retry-After` absurdly large (or absent) on 429 | Cap wait at 60 s; if the reset is hours away (BUC 24 h window), **fail fast with the estimate** instead of blocking the MCP call | M1 · unit |
| CC-RATE-4 | Hashtag 30-unique/7-days local counter: file corrupted, or same account used from two machines | Counter is advisory only — self-heals on parse failure (reset + warn); docs state it cannot see other machines' queries; Meta's own rejection remains the hard signal | M4 · unit + docs |
| CC-RATE-5 | Proactive throttle (> 90 % usage) triggering during a composite mid-flow | Composite completes its current step but refuses to start new quota-consuming steps; partial-progress result explains why | M2 · unit |
| CC-RATE-6 | Semaphore saturation: > `IG_MAX_CONCURRENT` parallel tool calls | Queued fairly (FIFO); a queue-wait timeout produces a clear "server busy" error rather than hanging the MCP call indefinitely | M1 · unit |

## 4. Pagination, data shape & truncation (CC-DATA)

| ID | Scenario | Expected behavior | When / how |
|---|---|---|---|
| CC-DATA-1 | Cursor invalidated (media deleted between page 1 and page 2) | Graph error mapped with "cursor may be stale — restart the listing"; `fetchAll` returns what it got + `truncated: true` + the error note | M1 · unit |
| CC-DATA-2 | Fields silently missing (Meta omits rather than nulls): `like_count` hidden by author, `media_url` absent on copyright-muted media, stories lacking counts | Output schemas mark such fields optional; text rendering says "unavailable", never `undefined`/crash | M1 · unit |
| CC-DATA-3 | Character-budget truncation landing mid-emoji / mid-surrogate-pair in a caption | Truncation is code-point-safe (never splits a surrogate pair or ZWJ sequence mid-way); property-tested with `fast-check` | M1 · unit |
| CC-DATA-4 | `fetchAll` hits `IG_MAX_ITEMS` exactly at a page boundary | `truncated: true` iff more data exists — off-by-one covered by tests | M1 · unit |
| CC-DATA-5 | Media ID valid but object deleted / expired story | 100-class with subcode → mapped "object no longer exists" rather than generic invalid-parameter | M1 · unit |
| CC-DATA-6 | Unexpected `media_product_type` values (new types Meta adds, e.g. ad-linked media) | Enums for Meta-owned vocabularies are **open** (string with known values documented), so new values pass through instead of failing validation | M1 · design + unit |
| CC-DATA-7 | Graph adds new fields to a response with `outputSchema` declared | Output schemas are non-strict (passthrough) — additive Meta changes never break structured output | M1 · design + unit |

## 5. Comments & moderation (CC-COM)

| ID | Scenario | Expected behavior | When / how |
|---|---|---|---|
| CC-COM-1 | Reply to a comment that was just deleted | Graph error → "comment no longer exists"; no retry | M3 · unit |
| CC-COM-2 | Reply to a reply (Instagram supports only one threading level) | Client-side check where detectable; otherwise map Meta's rejection with the one-level rule stated | M3 · docs + unit |
| CC-COM-3 | Commenting on media with comments disabled | Graph rejection mapped; `create_comment` preview warns if `comments_enabled=false` is already known from a prior read | M3 · unit |
| CC-COM-4 | Comment-spam heuristic block (e.g. code 368 temporarily blocked, or 2207051-class) | `kind: upstream`-with-policy-context, never auto-retried; message tells the operator to slow down | M3 · unit |
| CC-COM-5 | Hide/unhide on a comment type that cannot be hidden (e.g. own comment) `[verify rules]` | Live probe in M3; behavior documented from evidence | M3 · live |
| CC-COM-6 | Empty message, whitespace-only, or > max length reply | zod rejects client-side; length limit `[verify exact comment length cap]` | M3 · unit + live |
| CC-COM-7 | `delete_comment` without `IG_ALLOW_DESTRUCTIVE` | Refused even with `apply: true` — double gate holds; error names both required flags | M3 · unit |

## 6. Insights (CC-INS)

| ID | Scenario | Expected behavior | When / how |
|---|---|---|---|
| CC-INS-1 | Account < 100 followers requesting demographics | Meta errors; mapped with the ≥ 100-followers rule named — not a generic permission error | M4 · unit |
| CC-INS-2 | Metric not valid for the media type (story metric on feed post, `navigation` on a reel) | Per-`media_product_type` metric matrix in `api/insights.ts`; invalid combos refused client-side with the valid set listed | M4 · design + unit |
| CC-INS-3 | `since`/`until` older than the 90-day retention | Refused client-side with the retention rule; partially-in-window ranges clamped + flagged in the result | M4 · unit |
| CC-INS-4 | Timezone semantics of `since`/`until` (UTC vs account timezone) `[verify]` | Live probe; whichever it is gets documented in the tool description so the model formats correctly | M4 · live + docs |
| CC-INS-5 | Insights on media created before the account became professional | Meta returns empty/error; mapped with that explanation | M4 · docs |
| CC-INS-6 | `online_followers` disappears (it is on the deprecation watch-list) | Tool degrades to an explicit "metric no longer available" error; watch item in the version-upgrade checklist | M4 · docs |
| CC-INS-7 | Legacy metric names (`impressions`, `profile_views`) requested by the model out of habit | Input enum only contains the post-2025 set; the error for unknown metrics lists valid ones — the model self-corrects | M4 · unit |

## 7. Config, profiles & env (CC-CFG)

| ID | Scenario | Expected behavior | When / how |
|---|---|---|---|
| CC-CFG-1 | `account` argument names an undefined profile | Error lists the configured profile names (names only — never token values) | M1 · unit |
| CC-CFG-2 | Mixed auth paths across profiles (default = Path A, `IG_PROFILE_BRAND_*` = Path B) | Supported: auth mode resolved **per profile**; capability differences follow the profile's path | M1 · design + unit |
| CC-CFG-3 | Env file present but world-readable (not `0600`) | Startup warning (not fatal) naming the file and the fix; server-written files always get `0600` | M1 · unit |
| CC-CFG-4 | CRLF line endings / quoted values / `=` inside token values in the env file | dotenv semantics tested explicitly; atomic rewrite preserves comments and does not mangle quoting | M2 · unit |
| CC-CFG-5 | `IG_ENV_FILE` points to a nonexistent path | Clear startup error (explicit intent), while a missing *default* XDG file is fine (env-only config) | M1 · unit |
| CC-CFG-6 | Unknown tool arguments (model hallucinates a param) | `.strict()` zod → validation error naming the unknown key and the valid keys | M1 · unit |
| CC-CFG-7 | Package profile math: `IG_TOOL_PACKAGES=all` + `IG_PACKAGES_DENY=discovery` + `IG_PACKAGES_READONLY=publishing` | Deterministic resolution order (profile → deny → readonly), snapshot-tested; denied packages produce **no network calls** ever | M1 · unit |
| CC-CFG-8 | Windows: no XDG — config/state paths and `0600` semantics undefined | Per-platform path resolution (`%APPDATA%\instagram-mcp-ai\`); `chmod` skipped on win32; covered by the CI Windows leg | M1 · unit |

## 8. Process, transports & MCP layer (CC-PROC)

| ID | Scenario | Expected behavior | When / how |
|---|---|---|---|
| CC-PROC-1 | Anything writes to stdout in stdio mode (stray `console.log`) | Protocol corruption — banned by lint rule (`no-console`) + a test asserting the logger targets stderr only | M0 · unit |
| CC-PROC-2 | Client disconnects mid-request (long poll, big fetchAll) | AbortSignal wired through `igRequest`; in-flight Graph calls aborted; no orphaned timers | M1 · unit |
| CC-PROC-3 | SIGINT/SIGTERM between container create and publish | Journal already holds the container ID (written at creation); shutdown is otherwise graceful | M2 · unit |
| CC-PROC-4 | HTTP transport: port in use, or `IG_HTTP_TOKEN` unset | Port conflict → clear startup error; missing bearer token → refuse to start HTTP transport (loopback alone is not auth) | M1 · unit |
| CC-PROC-5 | Two server instances appending to the write journal concurrently | Append-only writes with `O_APPEND` single-line JSON records — interleaving-safe by construction | M2 · design + unit |
| CC-PROC-6 | Tool result larger than the client can render | Character-budget halving loop guarantees a bounded payload; `truncated: true` in structured content | M1 · unit |

## 9. Live-probe protocol (cases marked `live`)

Live cases run against a **dedicated junk professional account** during the phase
that owns them, following the QA review's protocol: stories-first smoke tests
(stories self-expire in 24 h — no cleanup problem), feed posts kept to a minimum
(published feed media **cannot be deleted via the API** — only `comment_enabled`
can be toggled), findings recorded back into this file replacing the `[verify]`
markers with `[verified <date>]` + observed behavior.

Open `[verify]` register: CC-AUTH-14 (refresh invalidates old token?),
CC-PUB-4 (double-publish error shape), CC-PUB-6 (mixed carousel rules),
CC-PUB-11 (caption counting unit), CC-COM-5 (hide rules), CC-COM-6 (comment
length cap), CC-INS-4 (insights timezone), plus the M1 hashtag/PCA probe from
[auth.md](auth.md) §5.
