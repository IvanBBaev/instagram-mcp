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
| Lint/format | ESLint 9 flat + typescript-eslint 8 (type-checked), Prettier | Layer boundaries enforced by lint |
| Spec target | MCP `2025-11-25` features (annotations, `outputSchema`/`structuredContent`) | Do **not** build on Sampling/Roots/Logging (deprecated in `2026-07-28`) |

## 2. Layered architecture (enforced at lint time)

```
src/
  index.ts        # entry: Node guard → CLI subcommands (login, doctor) → server bootstrap
  core/           # Layer 0: config, settings, auth providers, http client, host/SSRF,
                  #          errors, logging (stderr JSON), rate-limit budget
  api/            # Layer 1: Instagram Graph domain functions (media.ts, publishing.ts,
                  #          comments.ts, insights.ts, discovery.ts, account.ts)
  mcp/            # Layer 2: MCP glue — define.ts (ToolSpec), registry.ts, result.ts,
                  #          redact.ts, transport.ts, write-mode.ts
  tools/          # Layer 3: tool specs as data — one file per package
```

Import rule `core ← api ← mcp ← tools`, enforced via ESLint `no-restricted-imports`:

- `core` imports nothing from the other layers.
- `api` may import `core`, never `mcp`/`tools`.
- `tools` may import `api` + `mcp/define`, **never `core/http` directly** — every
  network call goes through the `api/` layer, which owns policy and envelope handling.

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
| `media` | list/get own media, children (read-only) | yes |
| `publishing` | container create/status/publish, publishing-limit check | yes |
| `comments` | list/reply/hide/delete comments, mentions, toggle comments on a media | yes |
| `insights` | account + media insights, demographics | yes |
| `discovery` | hashtag search/top/recent, business discovery | no (`all`) |
| `messaging` | IG DMs via Messenger Platform | no (phase 2, `all`) |

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
- **Retry matrix**: `429`/rate-limit errors retried with exponential backoff
  `min(500·2^n, 8000) + jitter` on any method (Graph rejects pre-processing);
  `5xx`/transport errors retried only on idempotent `GET`. `Retry-After` honored,
  capped at 60 s. Per-host concurrency semaphore (`IG_MAX_CONCURRENT`, default 4).
- **Rate-limit budget**: parse `X-App-Usage` / `X-Business-Use-Case-Usage` response
  headers on every call; expose them via a status tool and proactively throttle when
  usage > 90 % (see [operations.md](operations.md)).
- Version pinned in every URL: `https://graph.facebook.com/v25.0/...` — never a
  versionless call.

## 6. Configuration (`core/config.ts`)

- `dotenv` with `override: false` — **env passed by the MCP client always wins** over
  the env file.
- Env-file resolution: `IG_ENV_FILE` → XDG `~/.config/instagram-mcp-ai/.env` →
  project `.env`; runtime writes go to the XDG path, atomically (temp + `rename`),
  comment-preserving, **`chmod 0600`**. On Windows the XDG tier maps to
  `%APPDATA%\instagram-mcp-ai\.env` (`chmod` is a no-op there — NTFS ACLs apply;
  the CI Windows leg exercises this path).
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
  `fetchAll: true` pages up to a hard item cap and always surfaces
  **`truncated: true`** when capped — a capped read is never presented as complete.
- Responses are compact JSON by default (pretty only via `IG_PRETTY_JSON`); a
  character-budget truncation loop protects the model context.
- Errors map to a single `InstagramError(message, kind, status?, fbtraceId?, code?, subcode?)`
  with `kind ∈ auth | permission | rate_limit | validation | upstream` — one class
  with a discriminant (not a subclass hierarchy), so handlers and the model branch
  on `kind`. Full taxonomy in [operations.md](operations.md).

## 8. Transports

- **stdio** default. All logging is JSON to **stderr** (stdout is the protocol channel).
- **Streamable HTTP** opt-in via `IG_TRANSPORT=http`: binds `127.0.0.1` only
  (`IG_HTTP_HOST`/`IG_PORT`), constant-time bearer check when `IG_HTTP_TOKEN` set.
  Designed stateless-friendly (the `2026-07-28` spec removes session handshake).

## 9. Entry point & CLI subcommands

`index.ts` handles subcommands before starting the server:

- `login` — interactive browser OAuth to obtain and persist a long-lived token
  (both auth paths; see [auth.md](auth.md)).
- `doctor` — health check: token validity (`debug_token` / `/me`), account
  resolution, scope inventory, rate-limit snapshot, publishing quota.
- `refresh` — force-refresh the long-lived token (IG-login path).

## 10. Testing strategy

- `node:test` against **built** output (`npm test` after `npm run build`;
  `test:full` chains them).
- `withFetch()` helper swaps `globalThis.fetch` with a recording mock; tests assert
  both the outgoing request (URL, pinned version, `appsecret_proof` presence) and
  behavior (e.g. "no network call for a denied package", "publish tool refuses
  without `apply: true`").
- **Manifest snapshot test** over the entire tool surface; README/env-docs sync tests
  keep generated docs in lockstep.
- `fast-check` property tests for truncation, redaction, and cursor handling.
- Coverage gate via `c8` (ratchet slightly below actuals), non-blocking Codecov upload.

## 11. Distribution

- npm package with `.cjs` bin launcher (Node-guard, then `import()` of the ESM entry).
- `server.json` MCP-registry manifest (`mcpName: io.github.IvanBBaev/instagram-mcp-ai`),
  generated and kept in sync by script.
- **MCPB bundle** (`.mcpb`) with `user_config` secrets in OS keychain — one-click
  Claude Desktop install for non-technical operators.
- CI: lint, format check, build, test matrix (Node 22/24, ubuntu + macOS +
  Windows leg), `npm audit`, CodeQL; `prepublishOnly` runs the full gate.

## 12. Environment variable catalog (canonical)

Single source of truth for every `IG_*` knob; `.env.example`, `server.json`, and
the MCPB `user_config` are generated from this list and sync-tested against it.

| Variable | Default | Purpose |
|---|---|---|
| `IG_AUTH_MODE` | inferred | `ig-login` \| `fb-login`; inferred as `fb-login` when `IG_APP_ID` + `IG_APP_SECRET` are set (alias: `IG_AUTH_PATH`) |
| `IG_ACCESS_TOKEN` | — | The account's long-lived token for **either** path — IG-login token on Path A, Page / system-user token on Path B (**secret**) |
| `IG_ACCOUNT_ID` | auto-resolved | IG professional-account ID (skip a lookup / disambiguate) |
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
| `IG_REFRESH_AFTER_DAYS` | `45` | Path-A auto-refresh threshold (range 1–60) |
| `IG_TIMEOUT_MS` | `30000` | Per-request timeout for Graph calls (range 1–600000) |
| `IG_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (stderr JSON logger) |
| `IG_PRETTY_JSON` | `false` | Pretty-print JSON results |

Secrets (`IG_ACCESS_TOKEN`, `IG_APP_SECRET`, `IG_HTTP_TOKEN`)
are marked `isSecret` in `server.json` and keychain-backed in the MCPB bundle; the
redaction layer masks their values in every serialization path.
