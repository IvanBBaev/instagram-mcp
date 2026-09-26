# Architecture

> Design document — describes the intended implementation. The architectural
> reference is the production `servicenow-mcp-ai` server (see
> `facebook-mcp/docs/ai/research/servicenow-mcp-architecture.md` for the full map);
> this document adapts that shape to the Instagram Platform.

## 1. Stack

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript, **ESM**, `module: Node16` | House standard; `.js` import extensions |
| Runtime | **Node ≥ 22**, `.nvmrc` = 22, `engine-strict` | Node 20 hit EOL 2026-04-30 — a ≥ 22 floor keeps the "no EOL Node" claim true |
| MCP SDK | `@modelcontextprotocol/sdk` **v1 stable** (`registerTool` + zod v3) | v2 is beta with API churn; codemod path exists (`v1-to-v2`) |
| Runtime deps | SDK + `zod` + `dotenv` — **exactly three** | Minimal supply-chain surface, mirrors reference |
| Tests | built-in `node:test` + `c8` coverage + `fast-check` | No test-runner dependency |
| Lint/format | ESLint 10 flat + typescript-eslint 8 (type-checked), Prettier | Layer boundaries enforced by lint |
| Spec target | MCP `2025-11-25` features (annotations, `outputSchema`/`structuredContent`) | Do **not** build on Sampling/Roots/Logging (deprecated in `2026-07-28`) |

## 2. Layered architecture (enforced at lint time)

```
src/
  index.ts        # entry: Node guard → CLI subcommands (login, doctor, refresh) → server bootstrap
  core/           # Layer 0: config, settings, auth providers, token refresh, http client,
                  #          host/SSRF, errors, logging (stderr JSON) and its redactor,
                  #          rate-limit budget, the clock and time seams
  api/            # Layer 1: Instagram Graph domain functions (media.ts, media-spec.ts,
                  #          publishing.ts, comments.ts, insights.ts, discovery.ts,
                  #          account.ts)
  mcp/            # Layer 2: MCP glue — define.ts (ToolSpec), registry.ts, result.ts,
                  #          transport.ts, write-mode.ts
  tools/          # Layer 3: tool specs as data — one file per package, plus ids.ts
                  #          (the shared object-id charset rule)
```

Import rule `core ← api ← mcp ← tools`, enforced via ESLint `no-restricted-imports`:

- `core` imports nothing from the other layers.
- `api` may import `core`, never `mcp`/`tools`.
- `tools` may import `api` + `mcp/define`, **never `core/http` or `core/host`
  directly** — every network call goes through the `api/` layer, which owns policy
  and envelope handling.
- `mcp` may import `core` for its own needs but **never `core/http`, `core/auth` or
  `tools/*`** — the glue layer must not reach across into either the network or the
  tool catalogue it is being handed.
- `src/index.ts` and `src/cli/**` are unrestricted: they are the composition root,
  and wiring the layers together is precisely their job.

## 3. Tools as data

Every tool is a `ToolSpec` object (not an imperative registration):

```ts
export interface ToolSpec<S extends z.ZodRawShape> {
  name: string;                 // instagram_<verb>_<noun>
  title: string;
  description: string;          // model-facing; states Graph semantics honestly
  package: string;              // registry package tag
  annotations: ToolAnnotationSet; // readOnlyHint / destructiveHint / idempotentHint / openWorldHint
  input: S;                     // zod raw shape, every field .describe()d
  output?: z.ZodRawShape;       // structuredContent schema where the shape is stable
  logFields?: (args) => Record<string, unknown>;  // never secrets
  handler: (args) => ToolResult | Promise<ToolResult>;
}
```

- Registered as **built `.strict()` zod objects**, not raw shapes — unknown
  arguments are validation errors, never silently dropped (CC-CFG-6). The
  distinction is load-bearing: the MCP SDK validates arguments itself before the
  tool callback runs, and a raw `ZodRawShape` is re-wrapped as a *non-strict*
  `z.object(shape)` (`server/zod-compat.js` `normalizeObjectSchema` →
  `objectFromShape`), which strips unknown keys instead of rejecting them. An
  already-built `ZodObject` is passed through untouched, so `.strict()` survives
  and the SDK enforces it. `registerOne` therefore hands the server the closed
  object and keeps its own `.strict()` re-parse only as a second line of defense
  for callers that drive the callback directly. Rejections are raised by the SDK
  as `Input validation error: Invalid arguments for tool <name>: …`; a
  schema-bound zod `errorMap` supplies the tail of that message so it still names
  the offending keys *and* the valid ones.
- A central **PACKAGES manifest** in `mcp/registry.ts` is the single source of truth:
  `{ name, tools }` per package; an invariant loop asserts every spec's `package` tag
  matches. The manifest feeds registration, README generation, and a snapshot test,
  so any change to the tool surface shows up in diffs.
- Package selection at runtime: `IG_TOOL_PACKAGES` (profiles: `core` default,
  `reader`, `publisher`, `all`), `IG_PACKAGES_DENY`, `IG_PACKAGES_READONLY`.
  `reader` is a read-only *boundary*, not a package list: every package it selects
  is forced read-only, so no write tool is registered under it. An explicit list
  naming the same packages is **not** equivalent — it registers their writes.

## 4. Planned packages

| Package | Contents | In `core` profile |
|---|---|---|
| `account` | profile info, linked-account resolution, token status | yes |
| `media` | list/get own media, children (read-only), **toggle commenting on a media** | yes |
| `publishing` | container create/status/publish, publishing-limit check | yes |
| `comments` | list/reply/hide/delete comments, mentions | yes |
| `insights` | account + media insights, demographics | yes |
| `discovery` | hashtag search/top/recent, business discovery | no (`reader`, `all`) |
| `messaging` | IG DMs via Messenger Platform | no (phase 2, `all`) |

**Where `instagram_set_comments_enabled` lives, and why it matters.** It is
implemented in `src/tools/comments.ts` but tagged `media`, because the call it
makes is `POST /{media-id}?comment_enabled=…` — it edits the media object, not a
comment. The table above follows the **tag**, since the tag is what
`IG_TOOL_PACKAGES` / `IG_PACKAGES_DENY` / `IG_PACKAGES_READONLY` filter on: an
operator who denies `comments` to stop comment moderation still keeps this tool,
and one who makes `media` read-only loses it. The `media` spellings do reach it,
but `IG_PACKAGES_DENY=media` also removes the two genuine media reads — so **no
env setting isolates just this one write**. The two that do neutralise it are
`IG_PACKAGES_READONLY=media` and `IG_TOOL_PACKAGES=reader` (the latter via
`READONLY_PROFILES` plus the absent `readOnlyHint: true`). That is a defensible
split, but the
mismatch between the defining file and the tag is a trap for maintainers reading
the source — recorded as **CC-PROC-9** in
[corner-cases.md](corner-cases.md). The tag is pinned by
`test/tools/index.test.ts` ("allTools carries the pinned package tag for every
position"); changing it would be a surface change under the
[stability.md](stability.md) §1 semver policy, not a cleanup.

## 5. HTTP client (`core/http.ts`)

Single entry `igRequest<T>({ method, path, params, body, host?, ... })`:

- **Host allowlist before any call** (SSRF guard): only `graph.instagram.com` and
  `graph.facebook.com` are reachable in v1. `rupload.facebook.com` joins the list
  only if/when a resumable-upload phase ships — no dead allowlist entries. No
  user-supplied hosts, no redirects followed cross-host. Loopback/private ranges
  always refused.
- **Auth provider** interface (see [auth.md](auth.md)): injects `access_token` and —
  on `graph.facebook.com` only — `appsecret_proof`. Providers: `ig-login` (token for
  `graph.instagram.com`) and `fb-login` (page/system-user token for `graph.facebook.com`).
- **Retry matrix**: `429`/rate-limit, `5xx` and transport errors are retried with
  exponential backoff `min(500·2^n, 8000) + jitter` (max 3 retries) only on an
  idempotent call — `GET` by default. A `POST`/`DELETE` is never replayed, not even
  on `429`: Meta can throttle a request after accepting it (see
  [operations.md](operations.md) §2). `Retry-After` (delta-seconds or an
  IMF-fixdate) is honored, capped at 60 s. Per-host concurrency semaphore (`IG_MAX_CONCURRENT`, default 4).
- **Rate-limit budget**: parse `X-App-Usage` / `X-Business-Use-Case-Usage` response
  headers on every call and proactively throttle when usage > 90 % (see
  [operations.md](operations.md)). The last-seen snapshot is not exposed yet:
  `instagram_token_status` reports `rateLimitBudget.available: false`.
- **Response-body cap**: a body is read as a counted stream and refused past
  16 MiB (a declared unencoded `Content-Length` over it is refused before any
  byte is read) with an `upstream` error naming the cap and the remedy; the
  refusal is never retried. A fixed constant, not a knob.
- Version pinned in every URL: `https://graph.facebook.com/v25.0/...` — never a
  versionless call.

## 6. Configuration (`core/config.ts`)

- `dotenv` with `override: false` — **env passed by the MCP client always wins** over
  the env file, variable by variable. It does not win across two spellings of one
  setting: `login` stores `IG_AUTH_PATH`, which beats `IG_AUTH_MODE` wherever each
  comes from, so a client overrides a stored path with `IG_AUTH_PATH`.
- An `IG_*` value that is exactly an unexpanded MCPB template (`${user_config.X}`,
  what a host may pass for an optional field the user left empty) is deleted before
  the env files load, so it reads as unset and a file can still supply the key
  (CC-CFG-46).
- Env-file resolution: an explicit `IG_ENV_FILE` is loaded **alone** (unreadable →
  startup error); otherwise XDG `~/.config/instagram-mcp-ai/.env`, then project
  `.env` (first file to set a key wins); runtime writes go to the XDG path — or to an
  absolute `IG_ENV_FILE` when one is set, since that is then the only file read (a
  relative one is refused) — atomically (temp + `rename`),
  comment-preserving, **`chmod 0600`**. A symlinked store is written through the
  link: temp, lock and rename sit beside the resolved target; a dangling link or
  one owned by another user is refused. On Windows the XDG tier maps to
  `%APPDATA%\instagram-mcp-ai\.env` (`chmod` is a no-op there — NTFS ACLs apply;
  the CI Windows leg exercises this path).
- `$XDG_CONFIG_HOME` / `%APPDATA%` / `$XDG_STATE_HOME` are honoured only when they
  hold an **absolute** path. A relative value is ignored in favour of the documented
  default, as the XDG base-directory spec requires: an MCP client starts the server
  in a directory of its own choosing, so a relative base would write credentials (or
  the write journal) beside whatever project happened to be open and read a different
  file on the next start (CC-CFG-24). A leading `~` in `$XDG_CONFIG_HOME` /
  `%APPDATA%` (or a `configDir`) is the home directory, since an MCP client's JSON
  env hands it over unexpanded while a terminal `login` sees it expanded
  (CC-CFG-60); `~user`, `$VAR` and `%VAR%` spellings are refused with a
  `kind: validation` error rather than ignored (CC-CFG-61). `$XDG_STATE_HOME` and
  `IG_WRITE_JOURNAL` follow the same `~` and shell-spelling rule
  (`core/home-path.ts`), and so does `IG_ENV_FILE`, through one reader
  (`namedEnvFile`) shared by the entry's load and the `login` / `refresh` write
  target. An explicit `IG_ENV_FILE` / `IG_WRITE_JOURNAL` names one file rather
  than a base directory; a relative `IG_WRITE_JOURNAL` is used as given, while a
  relative `IG_ENV_FILE` is refused by `namedEnvFile` for the read and the write
  alike (CC-CFG-70). A `~` or home-derived default needs an absolute `HOME` /
  `USERPROFILE` (`homeDirectory`, CC-CFG-69). Only a LEADING `~`, `$` or `%` is
  a shell spelling: one further in is part of an absolute name (`\\host\C$\…`,
  `C:\$Recycle.Bin`) and is used as written.
- **Profiles** for multiple IG accounts: default profile from bare `IG_*` vars;
  additional under `IG_PROFILE_<NAME>_*`; a per-request `account` argument
  (auto-injected into every tool schema) selects the profile via `AsyncLocalStorage`.
- Every runtime knob in §12 that is not a credential is read in `core/settings.ts`,
  each a small documented env-reading function, and **all** of them — the
  numeric/enum/boolean ones (timeouts, retries, caps, truncation budgets,
  `IG_WRITE_MODE`, `IG_TRANSPORT`, …) and the write-journal path
  (`IG_WRITE_JOURNAL`) alike — resolve into the `Settings` contract via
  `loadSettings`. `writeJournal` is the one derived entry: its default is built
  from the state home at load time rather than being a literal. Consumers never
  read `process.env` themselves; blank means "use the default" uniformly.

## 7. Results, pagination, truncation

- Cursor-based pagination (Graph `paging.cursors.after`): single page by default;
  `fetchAll: true` pages up to a hard item cap. **`truncated: true`** means "there
  was more than you are holding", which is not the same as "the cap was hit": a
  read that fills the cap exactly on a final page is complete and says so, while a
  walk that stops early on a broken cursor is *not* capped and still says
  `truncated: true`. A capped read is never presented as complete.
- A cursor is handed back only when it can actually be sent again — a `null` or
  empty `after` is not a position in the edge, and the same predicate decides both
  whether the walk follows a cursor and whether the result publishes one
  (CC-DATA-11). So `truncated: true` with **no** `after` is a real combination, and
  wherever it has a cause worth stating, an optional `note` carries it.
- Responses are compact JSON by default (pretty only via `IG_PRETTY_JSON`); a
  character-budget truncation loop protects the model context.
- Errors map to a single `InstagramError(message, kind, status?, fbtraceId?, code?, subcode?)`
  with `kind ∈ auth | permission | rate_limit | validation | upstream` — one class
  with a discriminant (not a subclass hierarchy), so handlers and the model branch
  on `kind`. Full taxonomy in [operations.md](operations.md).

## 8. Transports

- **stdio** default. All logging is JSON to **stderr** (stdout is the protocol channel).
- **The log record shape is a contract an operator can grep.** The logger owns
  `level`, `msg`, `time` and the two `logError` slots; a caller field colliding
  with any of them is **re-keyed, never dropped**, so those keys are never
  caller-controlled and a field named `logError` cannot forge the health of a line
  (CC-PROC-27). Everything the caller supplies is a sibling of them in the same
  flat object, already redacted.
- **A `logError` key means the line is degraded, and says how.** Three outcomes are
  distinguishable on purpose: the fields could not be serialized (the record
  survives, its fields do not), the record could not be made safe to write at all
  (only the framing survives — CC-PROC-22), and the clock threw (`time: null`, the
  record otherwise intact — CC-PROC-26). `logErrorDetail` carries the thrown
  value's **class name only**, never its message.
- **A sink that goes away does not take the process with it.** Both the
  synchronous throw and the asynchronous `'error'` event — the one a piped `stderr`
  actually delivers — are classified against a strict whitelist of stream-lifecycle
  codes and latch the sink as gone; every later write is a no-op. Anything outside
  that whitelist is rethrown and reaches Node untouched, so a full disk still stops
  the server (CC-PROC-24). Consequence worth stating: because the listener is on
  the stream, a foreign `console.error` racing the same dead pipe becomes
  non-fatal too — a deliberate trade for a stdio server whose client may exit
  first.
- **stdio ends when the client leaves, by either door.** stdin EOF and a
  closed stdout (`EPIPE`) both close the transport, once — the SDK
  transport listens for neither, so `startStdio` does. The close rejects every
  pending server→client request at once, so a write waiting at the confirmation
  prompt is **refused, not performed and not journaled**, instead of holding the
  process for the 120 s prompt budget (CC-PROC-206). A call already past its
  gate is not cut off: it finishes, journals, and the process exits when the event
  loop drains. That includes a composite publish in its status poll, which can
  keep the process up to its 60 s poll budget and journals `in_progress` with the
  container id so the run can be resumed (CC-PROC-207).
- **Streamable HTTP** opt-in via `IG_TRANSPORT=http` (`IG_HTTP_HOST`/`IG_PORT`).
  It binds loopback unless a bearer token is configured: a **non-loopback** bind
  with no `IG_HTTP_TOKEN` is refused at startup, a loopback bind without one starts
  and logs at **error** level that there is no authentication, and a **blank** token
  is refused either way. When a token is set, the constant-time bearer check runs
  ahead of the MCP layer on every verb and path — stateless mode answers a `DELETE`
  itself, so a check scoped to `POST` would serve the tool surface to anyone who
  found the port. A `Host` allowlist (bare address and `host:port`) blocks DNS
  rebinding. Full rules in [security.md](security.md) §3. Designed
  stateless-friendly (the `2026-07-28` spec removes session handshake).

## 9. Entry point & CLI subcommands

`index.ts` handles subcommands before starting the server:

- `login` — interactive browser OAuth to obtain and persist a long-lived token
  (both auth paths; see [auth.md](auth.md)).
- `doctor` — health check: resolved configuration, token validity (`debug_token` on
  Path B, `GET /{ig-id}` or `/me` on Path A), scope inventory and drift (Path B),
  reachability, Meta app mode; exits 1 when unhealthy.
- `refresh` — force-refresh the long-lived token (both paths: `ig_refresh_token` on
  Path A, `fb_exchange_token` on Path B) and persist it to the XDG env file.

## 10. Testing strategy

- `node:test` against **built** output (`npm test` after `npm run build`;
  `test:full` chains them, with the `test:corpus` floor in between so an
  uncompiled suite cannot be reported as a passing one).
- `withFetch()` helper swaps `globalThis.fetch` with a recording mock; tests assert
  both the outgoing request (URL, pinned version, `appsecret_proof` presence) and
  behavior (e.g. "no network call for a denied package", "publish tool refuses
  without `apply: true`").
- **Manifest snapshot test** over the entire tool surface; README/env-docs sync tests
  keep generated docs in lockstep.
- `fast-check` property tests for truncation, redaction, and cursor handling.
- Coverage gate via `c8` (100 % statements/branches/functions/lines, `--all`), non-blocking Codecov upload.

## 11. Distribution

- npm package with `.cjs` bin launcher (Node-guard, then `import()` of the ESM entry).
- `server.json` MCP-registry manifest (`mcpName: io.github.IvanBBaev/instagram-mcp-ai`),
  hand-maintained and kept in sync by tests (`test/release/version-consistency.test.ts`).
- **MCPB bundle** (`.mcpb`) with `user_config` secrets in OS keychain — one-click
  Claude Desktop install for non-technical operators.
- CI: lint, format check, build, test matrix (Node 22/24, ubuntu + macOS +
  Windows leg), `npm audit`, CodeQL; `prepublishOnly` runs the full gate.

## 12. Environment variable catalog (canonical)

Single source of truth for every `IG_*` knob. `.env.example` (the full catalog),
`server.json` and the MCPB `user_config` (a credential/common subset each) are
hand-maintained and sync-tested against the source (`test/env-catalog.test.ts`,
`test/release/mcpb-manifest.test.ts`).

| Variable | Default | Purpose |
|---|---|---|
| `IG_AUTH_MODE` | inferred | `ig-login` \| `fb-login`; inferred as `fb-login` when `IG_APP_ID` + `IG_APP_SECRET` are set (alias: `IG_AUTH_PATH`) |
| `IG_ACCESS_TOKEN` | — | The account's long-lived token for **either** path — IG-login token on Path A, Page / system-user token on Path B (**secret**) |
| `IG_ACCOUNT_ID` | `me` | IG professional-account ID; unset, calls address `me` (no lookup is made) |
| `IG_APP_ID` / `IG_APP_SECRET` | — | Meta app credentials: token exchange, refresh, `appsecret_proof`, `debug_token` (`IG_APP_SECRET` is a **secret**) |
| `IG_ENV_FILE` | XDG path | Env-file location override |
| `IG_PROFILE_<NAME>_*` | — | Additional account profiles (same keys, prefixed) |
| `IG_ACTIVE_PROFILE` | `default` | Profile used when a tool call passes no `account` |
| `IG_TOOL_PACKAGES` | `core` | Package profile `core` \| `reader` \| `publisher` \| `all`, or explicit list |
| `IG_PACKAGES_DENY` | — | Packages to remove after profile resolution |
| `IG_PACKAGES_READONLY` | — | Packages forced read-only |
| `IG_WRITE_MODE` | `preview` | `preview` \| `apply` (standing consent for writes) |
| `IG_ALLOW_DESTRUCTIVE` | `false` | Second gate for irreversible ops (`delete_comment`) |
| `IG_WRITE_JOURNAL` | `$XDG_STATE_HOME/instagram-mcp-ai/writes.jsonl` | Append-only JSONL audit log of applied writes |
| `IG_TRANSPORT` | `stdio` | `stdio` \| `http` |
| `IG_HTTP_HOST` / `IG_PORT` | `127.0.0.1` / `3000` | HTTP transport binding (`IG_PORT` range 1–65535) |
| `IG_HTTP_TOKEN` | — | HTTP bearer token (**secret**; constant-time compare) |
| `IG_MAX_CONCURRENT` | `4` | Per-host concurrency semaphore (range 1–64) |
| `IG_MAX_ITEMS` | `200` | `fetchAll` hard item cap (range 1–100000) |
| `IG_REFRESH_AFTER_DAYS` | `45` | Days-left threshold at which `token_status` and `doctor` report `expiring_soon` (range 1–60). Nothing refreshes automatically; run the `refresh` CLI |
| `IG_TIMEOUT_MS` | `30000` | Timeout per Graph HTTP attempt (response headers and body), not per call: an idempotent call makes up to 4 attempts with backoff or `Retry-After` waits between them, none of which this bounds (range 1–600000) |
| `IG_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (stderr JSON logger) |
| `IG_PRETTY_JSON` | `false` | Pretty-print JSON results |

Secrets (`IG_ACCESS_TOKEN`, `IG_APP_SECRET`, `IG_HTTP_TOKEN`): the first two are
marked `isSecret` in `server.json` and `sensitive` (keychain-backed) in the MCPB
bundle — neither manifest exposes `IG_HTTP_TOKEN`; the redaction layer masks all
three values in every serialization path.

Parsing rules, since 2026-09-19 (CC-CFG-13): **values** of the boolean and enum
knobs are case-insensitive and trimmed (`IG_TRANSPORT=HTTP`, `Http` and ` http `
are one value, and the canonical lower-case spelling is what the settings carry);
**names** are exact. Any `IG_*` name in the environment that nothing reads is
reported once at startup as a `warn` record listing the names — never the values,
because a mistyped profile key carries a live token — and the server keeps
starting. The recognised set is the union of what `core/settings.ts`,
`core/config.ts` (the profile scheme, plus the `TOKEN_EXPIRES_AT` metadata that
`login` and `refresh` write back into the env file) and `mcp/registry.ts` each
publish and pin, joined in `src/index.ts`.
