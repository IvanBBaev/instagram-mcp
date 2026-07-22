# Authentication & Authorization

> Design document. Facts below reflect Meta docs as of 2026-07 (Graph API v25.0
> current since 2026-02-18). Items marked **[verify]** must be re-checked against
> official docs during implementation.

## 0. Hard platform constraint

The Instagram Platform API serves **professional accounts only** (Business or
Creator). Personal accounts must be converted in the Instagram app first. The old
Basic Display API (personal accounts, read-only) was **shut down 2024-12-04** and is
not coming back — this server does not attempt any workaround.

## 1. The two auth paths

Meta offers two distinct ways to reach the same Instagram professional account. The
server supports **both**, selected by which env vars are present (`getAuthMode()`).

### Path A — Instagram API with Instagram Login (`ig-login`)

- User logs in **with their Instagram account** ("Business Login for Instagram").
  **No Facebook Page, no Facebook account link required.**
- API host: **`graph.instagram.com`**.
- Token subject: the Instagram professional account itself; the account ID used in
  paths is the IG-scoped user ID returned at login / via `GET /me`.
- Scopes (granular, post-Dec-2024 names) *[verified 2026-07-21 — platform-api review]*:
  - `instagram_business_basic`
  - `instagram_business_content_publish`
  - `instagram_business_manage_comments`
  - `instagram_business_manage_messages`
  - `instagram_business_manage_insights`
- **Token lifecycle**: browser OAuth yields a short-lived token (~1 h) → exchange
  for a **long-lived token (60 days)**:
  `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=...&access_token=...`
  → refresh before expiry (token must be ≥ 24 h old, unexpired):
  `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=...`
- `appsecret_proof` is **not supported** on `graph.instagram.com` *[verified
  2026-07-21]* — the compensating controls are strict token storage and host
  allowlisting.
- Limitations *[verified 2026-07-21]*: **no hashtag search, no `business_discovery`,
  no product tagging, no partnership ads, no story-insights webhooks, no `total_*`
  aggregate metrics** on this path. Insights themselves are supported (since
  2025-01-21), as is native IG-login messaging.

### Path B — Instagram API with Facebook Login (`fb-login`)

- Classic path: the IG professional account is **linked to a Facebook Page**; auth
  is Facebook Login against a **Business-type Meta app**.
- API host: **`graph.facebook.com/v25.0`**.
- Account resolution: `GET /me/accounts` → pick Page → 
  `GET /{page-id}?fields=instagram_business_account` → the IG user ID.
- Scopes: `instagram_basic`, `instagram_content_publish`,
  `instagram_manage_comments`, `instagram_manage_insights`,
  (`instagram_manage_messages` for DMs), plus Page plumbing:
  `pages_show_list`, `pages_read_engagement`; `business_management` for
  system-user setups.
- **Token lifecycle** (same machinery as facebook-mcp):
  - Preferred for a long-running local server: **admin system-user token from
    Business Manager** — never-expiring by default, no browser re-auth, survives
    password changes. Requires the app claimed into the Business portfolio and the
    IG-linked Page + IG account assigned as assets.
  - Fallback: long-lived user token (60 d) via `fb_exchange_token` → page-scoped
    calls ride the linked Page token where applicable.
- **`appsecret_proof` = HMAC-SHA256(access_token, app_secret)** appended to every
  `graph.facebook.com` call; enable **App Settings → Require App Secret**.

### Path selection guidance (documented for users)

| Situation | Recommended path |
|---|---|
| No Facebook presence, just an IG professional account | **A (ig-login)** — simplest setup |
| Existing Business Manager / facebook-mcp user | **B (fb-login)** — never-expiring system-user token, one app for both servers |
| Needs hashtag search / business discovery / product tags | **B** (confirmed Path-B-only *[verified 2026-07-21]*) |

## 2. App setup (one-time, documented step-by-step in the future README)

1. developers.facebook.com → Create app → **Business type** (type is permanent).
2. Add the **Instagram** product; for Path A configure "Instagram API with Instagram
   login" (Business Login), for Path B configure Facebook Login.
3. **App Review reality (2026)**: with **Standard Access**, every permission works
   for users who hold a role on the app (admin/developer/tester) operating their own
   assets. A solo operator who is admin of the app and owner of the IG account needs
   **no App Review and no Business Verification**. Advanced Access is only for
   serving third parties — permanently out of scope here.
   **Exception found in review:** the hashtag-search endpoints require the
   "Instagram Public Content Access" feature, which may be App-Review-gated even
   for own-app admins — the `discovery` package is gated on an M1 empirical probe.
4. For Path B + system user: claim the app into the Business portfolio, create an
   **admin system user**, assign the Page + IG account as assets, generate a
   never-expiring token with the scopes above.

## 3. Token validation & introspection

- On startup and in `doctor`: 
  - Path B: `GET /debug_token?input_token=...` (app token auth) → `is_valid`,
    `expires_at`, `data_access_expires_at`, `scopes`, `granular_scopes`.
  - Path A: `debug_token` is **not available** — it is a `graph.facebook.com`-only
    endpoint *[verified 2026-07-21]*; use
    `GET graph.instagram.com/me?fields=user_id,username` + tracking `expires_in`
    from the exchange/refresh responses, persisted alongside the token.
- The server persists **token metadata** (obtained-at, expires-at, scopes, path)
  next to the token and surfaces it via an `instagram_token_status` tool, warning
  when < 10 days remain (Path A) so the operator runs `refresh`/`login` in time.
- Auto-refresh policy (Path A): `refresh_access_token` transparently when the token
  is older than `IG_REFRESH_AFTER_DAYS` (default 45) at first use of a session.
- **Known design gate (architecture F-2 / devops F-1):** a token injected via the
  MCP client's `env` always wins over the XDG file, so a refreshed token persisted
  to XDG never takes effect for client-env users — the refresh story per config
  channel (client env vs XDG file vs keychain) must be resolved by design before M2.

## 4. Storage rules

- Tokens live in the XDG env file (`chmod 0600`) or the OS keychain via the MCPB
  `user_config` mechanism — **never** in the repo, never in logs, never echoed back
  through MCP results (redaction layer strips anything token-shaped; see
  [security.md](security.md)).
- The app secret is required only for: token exchange (`login`), `appsecret_proof`
  computation (Path B), and `debug_token`. It is stored with the same rules; the
  server never transmits it except to `graph.facebook.com`/`graph.instagram.com`
  over TLS as protocol parameters.

## 5. Open questions for implementation

**Resolved 2026-07-21** (see [reviews/platform-api-review.md](reviews/platform-api-review.md)):
scope names confirmed; Path A confirmed to lack hashtag search / `business_discovery` /
product tags; `debug_token` confirmed Path-B-only; `graph.instagram.com/v25.0/`
versioned paths confirmed.

Still open:

- "Instagram Public Content Access" feature gating for hashtag endpoints — M1 probe.
- Messaging (Path A `instagram_business_manage_messages` vs Path B via Page): which
  to target for the phase-2 `messaging` package.
- Token-refresh persistence across config channels (see the §3 design gate).
