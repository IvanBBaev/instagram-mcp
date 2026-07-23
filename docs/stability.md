# Stability & Compatibility

> What an operator or an integrating client can rely on across releases: the
> **semver contract for the tool surface**, and a **config-tier matrix** of what
> works, degrades, or is unavailable at each level of configuration. Pairs with
> [operations.md](operations.md) §5 (API versioning) and [auth.md](auth.md) (the
> two auth paths). The Instagram Platform is pinned to Graph API **v25.0**.

## 1. Semver policy for the tool surface

The **tool surface** — tool names, their required inputs, and their observable
result contract — is the public API of this server. It is versioned by the npm
package (`instagram-mcp-ai`) under semver. The **PACKAGES manifest** in
[`mcp/registry.ts`](../src/mcp/registry.ts) is the single source of truth and is
snapshot-tested, so any change to the surface shows up in a diff and is classified
before release.

| Change | Bump | Notes |
|---|---|---|
| **Rename or remove** a tool | **major** (breaking) | Callers referencing the old name break. |
| **Remove or rename a required input**, or **add a new required input** | **major** (breaking) | Existing valid calls stop validating. Inputs are `.strict()` — unknown args are already rejected, so tightening is breaking. |
| **Narrow** an input (drop an accepted enum value, tighten a bound) | **major** (breaking) | Previously valid calls would now be refused. |
| Change a tool's **`kind`/error contract** or an output field's meaning | **major** (breaking) | Clients branch on `kind` and read structured output. |
| **Add a new tool** or a new package | **minor** (additive) | Existing calls unaffected. |
| **Add an optional input** (with a safe default) | **minor** (additive) | Omitting it preserves prior behavior. |
| **Widen** an open enum / add an output field | **minor** (additive) | Output schemas are non-strict passthrough — additive Meta fields never break structured output. |
| Bug fix, doc, perf, internal refactor with no surface change | **patch** | No manifest diff. |

### Deprecation via dual registration

A tool is **never** renamed or removed in a single step. Deprecation runs one full
**minor cycle** of **dual registration**:

1. **Minor N** — register the new tool **alongside** the old one. Both work; the
   old tool's description and title are marked deprecated and point at the
   replacement. This is additive → a **minor** bump.
2. **Minor N+1 (or later)** — the old tool is removed. That removal is the
   **breaking** step and rides a **major** bump; the release notes name the
   replacement.

The same pattern covers input renames (accept both the old and new field for one
minor cycle, old marked deprecated) and Graph-version moves — a `v25.0 → v26`
upgrade is a deliberate, changelog-reviewed PR that bumps one constant in
`core/settings.ts` and re-runs the manifest snapshot ([operations.md](operations.md)
§5). Meta-driven removals that are outside our control (e.g. a metric Meta retires,
like the `online_followers` watch-item) degrade to an explicit "metric no longer
available" error rather than a silent change, and are documented in the upgrade
checklist.

## 2. Config-tier matrix

The server runs at different levels of configuration. Higher tiers **add**
capability; nothing in a lower tier is taken away. The two axes that matter are the
**auth path** (A `ig-login` vs B `fb-login`) and **which credentials** are present
(`IG_APP_ID` / `IG_APP_SECRET`, `IG_ACCOUNT_ID`).

### Tier 1 — Token-only (`ig-login`, minimal)

`IG_ACCESS_TOKEN` set (optionally `IG_ACCOUNT_ID`); **no** app id/secret.

- **Works fully:** account reads, media list/get + comment toggle, insights,
  comment moderation (list/reply/create/hide/unhide), and **publishing** —
  provided the media is at a **publicly reachable URL** (Meta fetches it;
  [security.md](security.md) §3). Reads and previews are unconditional.
- **Degrades:** token expiry is tracked only from exchange metadata; a
  hand-pasted token reports expiry **unknown** honestly (Path A has no
  `debug_token`, so `doctor`/`token_status` cannot introspect validity — the
  reachability check is the only validity signal). `delete_comment` still needs
  `IG_ALLOW_DESTRUCTIVE=true` **and** `apply:true`.
- **Unavailable:** the `discovery` package (Path-B-only, capability-filtered out);
  `appsecret_proof` (not supported on `graph.instagram.com`, by design);
  pull-based `@mention` lookup and `total_*` aggregate metrics (Path-B-only);
  `debug_token` introspection.

### Tier 2 — Token + app credentials (`ig-login`, refreshable)

Tier 1 **plus** `IG_APP_ID` / `IG_APP_SECRET`.

- **Adds:** `login` can mint/re-mint a long-lived token (the `ig_exchange_token`
  exchange needs the app secret). Note the ongoing **`refresh`** (`ig_refresh_token`)
  needs only the existing long-lived token — **no app secret** — but it must be
  **≥ 24 h old and unexpired** to refresh.
- **Still unavailable:** discovery, `appsecret_proof`, and the other Path-B-only
  capabilities above — those are a function of the **path**, not the credentials.
  To get them you must switch to Tier 3.

### Tier 3 — Full config (`fb-login`)

`IG_FB_ACCESS_TOKEN` (Page / system-user token), `IG_ACCOUNT_ID`, `IG_APP_ID`,
`IG_APP_SECRET`; the IG account linked to a Facebook Page.

- **Works fully:** everything in Tier 1/2, plus **discovery** (hashtag search,
  business discovery) once `IG_TOOL_PACKAGES` enables the package **and** the app
  holds "Instagram Public Content Access" (may be App-Review-gated).
- **Adds:** `appsecret_proof` (HMAC-SHA256) on **every** `graph.facebook.com`
  call — enable "Require App Secret" so a stolen bare token is useless;
  `debug_token` introspection (validity, scopes, expiry surfaced by `doctor`);
  a **never-expiring** system-user token option (no browser re-auth).
- **Refresh:** the Path-B `refresh` (`fb_exchange_token`) **requires both
  `IG_APP_ID` and `IG_APP_SECRET`** — it fails validation without them. A
  never-expiring system-user token needs no refresh at all.
- **Requires:** a linked Facebook Page and the Business assets (Page + IG account)
  assigned to the token's system user; a missing assignment surfaces as a
  permission error naming the assignment step, not just a scope.

### Capability summary

| Capability | Tier 1 (token-only A) | Tier 2 (A + app) | Tier 3 (full B) |
|---|---|---|---|
| Account / media / insights reads | Yes | Yes | Yes |
| Comment moderation | Yes | Yes | Yes |
| Publishing (public media URL) | Yes | Yes | Yes |
| Token refresh | No (needs re-`login`) | **Yes** (no secret; token ≥ 24 h) | **Yes** (needs app id + secret) |
| `debug_token` introspection | No | No | **Yes** |
| `appsecret_proof` hardening | n/a (unsupported on Path A) | n/a | **Yes** |
| Pull `@mention` / `total_*` metrics | No | No | **Yes** |
| Discovery (hashtag / business) | No | No | **Yes** (+ package enabled + PCA) |

## 3. Token auto-refresh behavior — **[verify — live]**

The design intent (Path A) is transparent auto-refresh when a token is older than
`IG_REFRESH_AFTER_DAYS` (default 45) at first use of a session. In the current
implementation this is **gated by the persistence trap** (D2,
[auth.md](auth.md) §3): a token injected via the MCP client's `env` is **static**
and cannot be rotated in place, so `instagram_token_status` **warns** rather than
auto-refreshing. The **`refresh` CLI is the sole writer** — it exchanges and
atomically persists the new token to the **XDG env file** (`chmod 0600`). For
hands-off rotation, manage the token through `login`/`refresh` against the XDG file
and keep it out of the client `env`.

Whether transparent auto-refresh is enabled for XDG-file tokens, and whether Meta
invalidates the old token on refresh, is **pending live-credential validation**
and marked **[verify — live]** here and in the corner-case register (CC-AUTH-4 /
CC-AUTH-14). Until verified, treat rotation as **operator-driven** via `refresh`,
and rely on the `token_status` warning (< 10 days remaining on Path A) as the
prompt to run it.
