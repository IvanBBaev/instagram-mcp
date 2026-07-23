# Setup Guide

> Operator onboarding, end to end: from a Meta app to a working MCP server.
> This guide is the practical companion to the design docs — [auth.md](auth.md)
> explains the two auth paths in depth, [tools.md](tools.md) is the tool catalog,
> and [operations.md](operations.md) covers rate limits and errors. Facts here
> reflect the Instagram Platform (Graph API **v25.0**) as of 2026-07.

Everything you configure is done once. Budget ~20 minutes for a first-time setup;
most of it is clicking through the Meta App Dashboard.

## 0. The one constraint to internalize first

**Instagram ingests media by public URL.** When you publish, you pass an
`image_url` / `video_url` and **Meta's servers fetch it** — this server never
uploads local bytes and never fetches the URL itself (SSRF policy,
[security.md](security.md) §3). Consequences:

- The URL must be **publicly reachable by Meta's crawlers** — no localhost, no
  `file://`, no auth-walled or IP-allowlisted origins, no links that only work
  from your machine.
- v1 accepts **URLs only**. Publishing a local file means hosting it somewhere
  public first (your own bucket/CDN). Use a validity window of **≥ 1 h** for
  pre-signed URLs — the container fetch and any retry must land inside it.
- A preview **cannot** prove reachability (the server never touches the URL);
  reachability is only proven when Meta fetches it at container creation. A bad
  URL surfaces as a container `ERROR` — see [troubleshooting.md](troubleshooting.md).

## 1. Prerequisites: a professional account

The Instagram Platform API serves **professional accounts only** (Business or
Creator). A personal account must be converted first, inside the Instagram app
(Settings → Account type). The old Basic Display API (personal, read-only) was
shut down 2024-12-04 and has no replacement — there is no workaround, and this
server does not attempt one.

| Auth path | Facebook Page required? |
|---|---|
| **A — Instagram Login** (`ig-login`) | **No.** Just the IG professional account. |
| **B — Facebook Login** (`fb-login`) | **Yes.** The IG account must be linked to a Facebook Page you administer. |

Decide the path now (§4) — it shapes the rest of the setup.

## 2. Create a Meta app

1. Go to **developers.facebook.com → My Apps → Create App**.
2. Choose the **Business** app type. **The type is permanent** — it cannot be
   changed later, and both auth paths need Business.
3. Give it a name and create it. Note the **App ID** and **App Secret**
   (App Dashboard → App settings → Basic). The secret is a credential — treat it
   like a password ([security.md](security.md) §2).

## 3. Add the Instagram product

In the app's left nav, **Add Product → Instagram → Set up**, then configure the
half that matches your path:

- **Path A** — configure **"Instagram API with Instagram login"** (Business Login
  for Instagram). Under its settings, add the OAuth **redirect URI** you will use
  for `login` (default `http://localhost:8723/callback`, see §5).
- **Path B** — configure **Facebook Login** and the **Instagram** product; make
  sure the IG professional account is linked to a Facebook Page you administer,
  and (for a never-expiring token) claim the app into a Business portfolio and
  assign the Page + IG account as system-user assets (see [auth.md](auth.md) §1).

> **Path B hardening:** enable **App settings → Advanced → Require App Secret**.
> Every `graph.facebook.com` call then carries an `appsecret_proof`
> (HMAC-SHA256), so a stolen bare token is useless. This server computes the
> proof automatically on Path B; `appsecret_proof` is **not supported** on
> `graph.instagram.com` (Path A), by design.

## 4. Development vs Live app mode

New apps start in **Development mode** — and for a **solo operator that is fine**.

- With **Standard Access** (the default), every permission this server uses works
  for a person who holds a **role on the app** (admin / developer / tester)
  operating **their own** assets. If you are the app admin and the account owner,
  you need **no App Review and no Business Verification**.
- **Development-mode apps may face lower rate limits** and can only act on app
  roles/testers — which is exactly the single-operator model here. You do **not**
  need to flip the app to Live for personal use.
- **Advanced Access** (serving third parties) and full App Review are permanently
  out of scope for this server.
- **One exception — discovery:** the hashtag-search endpoints require the
  **"Instagram Public Content Access"** feature, which may be App-Review-gated
  even for your own app. Until it is granted, the `discovery` package stays dark.
  Everything else works without review.

The `doctor` command prints a reminder to check Development vs Live in the App
Dashboard, because token introspection does not expose the app mode (§6).

## 5. Required scopes

Request exactly the scopes the server needs — over-granted scopes are flagged by
`doctor` so you can trim them. The `login` CLI requests these defaults per path
(override with `--scopes`):

**Path A — `ig-login`** (granular, post-Dec-2024 names):

- `instagram_business_basic`
- `instagram_business_content_publish`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`
- `instagram_business_manage_insights`

**Path B — `fb-login`** (classic names + Page plumbing):

- `instagram_basic`
- `instagram_content_publish`
- `instagram_manage_comments`
- `instagram_manage_insights`
- `instagram_manage_messages`
- `pages_show_list`
- `pages_read_engagement`
- `business_management` *(system-user / Business-portfolio setups)*

## 6. Choosing an auth path

Both paths reach the **same** IG professional account; pick by your situation.

| Situation | Path |
|---|---|
| No Facebook presence, just an IG professional account | **A (`ig-login`)** — simplest setup |
| Existing Business Manager / `facebook-mcp` user | **B (`fb-login`)** — one app for both, never-expiring system-user token |
| Needs **hashtag search / business discovery** | **B (`fb-login`)** — those are **Path-B-only**, and additionally need "Instagram Public Content Access" |

The auth path is auto-detected from which token var you set; set `IG_AUTH_MODE`
explicitly only when **both** `IG_ACCESS_TOKEN` and `IG_FB_ACCESS_TOKEN` are
present (otherwise startup fails rather than guessing — see
[troubleshooting.md](troubleshooting.md)). Capability differences (e.g. discovery
tools are hidden on Path A) are handled automatically: tools that a path cannot
serve are not registered for that profile.

## 7. Get a long-lived token, two ways

You need a **long-lived** token (Path A: ~60 days; Path B: 60 days, or
never-expiring for a system-user token). Either let the CLI do the OAuth dance, or
mint one by hand.

### (a) The built-in `login` CLI (recommended)

`login` runs the browser OAuth flow and **persists** a long-lived token to the
XDG/APPDATA env file (`chmod 0600` on POSIX). It needs a **registered Meta app**
(App ID + Secret) and a redirect URI whitelisted in the app's OAuth settings —
there is no offline login.

```bash
# Path A (Instagram Login)
npx instagram-mcp-ai login --path ig \
  --app-id <APP_ID> --app-secret <APP_SECRET>

# Path B (Facebook Login)
npx instagram-mcp-ai login --path fb \
  --app-id <APP_ID> --app-secret <APP_SECRET>
```

What happens: the command **prints an authorization URL to stderr** — open it in a
browser, approve the scopes, and the loopback redirect
(`http://localhost:8723/callback` by default) captures the code. The CLI then does
both token exchanges and writes the long-lived token. **No token or secret is ever
printed.**

Useful flags (`login --help` for the full list):

| Flag | Purpose |
|---|---|
| `--path <ig\|fb>` | Auth path. **Required.** |
| `--app-id` / `--app-secret` | App credentials (or env `IG_APP_ID` / `IG_APP_SECRET`). |
| `--redirect-uri <uri>` | OAuth redirect (default `http://localhost:8723/callback`) — must match an entry whitelisted in the app. |
| `--account-id <id>` | Pre-set the IG professional-account id (skips a lookup). |
| `--profile <name>` | Which account profile to write (default `default`). |
| `--scopes <csv>` | Override the per-path scope defaults. |

Then refresh before expiry with `npx instagram-mcp-ai refresh` (see
[operations.md](operations.md) and [stability.md](stability.md)).

### (b) Manually via Graph API Explorer / the App Dashboard

If you prefer to mint a token by hand (e.g. a system-user token that never
expires):

- **Path B, system-user (never-expiring):** App Dashboard / Business settings →
  create an **admin system user**, assign the Page + IG account as assets, and
  **Generate Token** with the Path-B scopes from §5. Put it in
  `IG_FB_ACCESS_TOKEN`. This survives password changes and needs no browser
  re-auth.
- **Path B, user token:** in the **Graph API Explorer**, select your app and the
  Path-B scopes, generate a user token, then exchange it for a long-lived one
  (`fb_exchange_token`). Put the long-lived token in `IG_FB_ACCESS_TOKEN`.
- **Path A:** generate a short-lived token in the Instagram login flow, then
  exchange it for a long-lived one (`ig_exchange_token`). Put it in
  `IG_ACCESS_TOKEN`.

> A hand-pasted token has **no exchange metadata**, and Path A has no
> `debug_token`, so `instagram_token_status` reports its expiry as **unknown**
> (it never invents a date). Re-acquiring via `login` is the way to get accurate
> expiry tracking.

## 8. Verify with `doctor`

Before wiring the server into a client, run the health check against your active
profile:

```bash
npx instagram-mcp-ai doctor
```

`doctor` reports (redacted — never a secret):

1. **Configuration** — profile, auth path, transport, write mode, destructive
   flag, active packages, refresh window.
2. **Token & authentication** — Path B introspects via `debug_token` (validity,
   scopes, expiry); Path A has no `debug_token`, so validity is proven by the
   reachability check.
3. **Reachability** — one cheap `GET /{ig-id}` that resolves your account.
4. **Meta app mode** — a reminder to confirm Development vs Live in the Dashboard
   (not exposed by introspection).

Exit code **0** = healthy; **non-zero** = the token is invalid/expired or the
reachability call failed. Near-expiry is a **warning**, not a failure. If a check
fails, fix the reported issue and re-run — [troubleshooting.md](troubleshooting.md)
maps every failure to a cause and a fix.

## 9. Configure the server

### Via environment variables

The full catalog is [.env.example](../.env.example) (canonical:
[architecture.md](architecture.md) §12). The minimum per path:

```bash
# Path A — Instagram Login (token only)
IG_ACCESS_TOKEN=<long-lived ig-login token>
IG_ACCOUNT_ID=<ig professional-account id>   # optional: skips a lookup

# Path B — Facebook Login (adds app id/secret for appsecret_proof + refresh)
IG_FB_ACCESS_TOKEN=<page / system-user token>
IG_ACCOUNT_ID=<ig professional-account id>
IG_APP_ID=<meta app id>
IG_APP_SECRET=<meta app secret>
```

Other knobs you may want early: `IG_TOOL_PACKAGES` (package selection —
default `core`; use `reader` or `all` to enable `discovery`), `IG_WRITE_MODE`
(`preview` default — writes are previewed unless `apply:true`),
`IG_ALLOW_DESTRUCTIVE` (second gate for `delete_comment`), and `IG_TRANSPORT`
(`stdio` default, `http` opt-in and loopback-only). Tiers are laid out in
[stability.md](stability.md).

### Via an MCP client

Add the server to your client config (`claude_desktop_config.json` / `.mcp.json`).
The token/secret env vars passed here **always win** over the XDG env file
(`override: false` on file load).

**Path A — Instagram Login (token only):**

```jsonc
// claude_desktop_config.json / .mcp.json
{
  "mcpServers": {
    "instagram": {
      "command": "npx",
      "args": ["-y", "instagram-mcp-ai"],
      "env": {
        "IG_ACCESS_TOKEN": "<long-lived token>",
        "IG_ACCOUNT_ID": "<ig professional account id>"
      }
    }
  }
}
```

**Path B — Facebook Login (discovery-capable):**

```jsonc
{
  "mcpServers": {
    "instagram": {
      "command": "npx",
      "args": ["-y", "instagram-mcp-ai"],
      "env": {
        "IG_FB_ACCESS_TOKEN": "<page / system-user token>",
        "IG_ACCOUNT_ID": "<ig professional account id>",
        "IG_APP_ID": "<meta app id>",
        "IG_APP_SECRET": "<meta app secret>",
        "IG_TOOL_PACKAGES": "all"
      }
    }
  }
}
```

> **Token-in-`env` vs auto-refresh:** a token injected through the client `env`
> is static — the server cannot rotate it in place, so it warns via
> `instagram_token_status` instead of auto-refreshing (the D2 persistence gate,
> [auth.md](auth.md) §3). For hands-off rotation, let `login`/`refresh` manage the
> **XDG env file** and omit the token from the client `env`. See
> [stability.md](stability.md).

Restart the client, and the Instagram tools appear. Reads are safe to try first
(`instagram_get_account`, `instagram_list_media`); writes preview by default.
