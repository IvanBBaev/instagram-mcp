# Installing the Instagram MCP as a Claude Desktop extension (`.mcpb`)

> **Audience:** non-CLI users who want to install this server from Claude Desktop's
> **Extensions** UI and provide credentials through a GUI form, rather than editing
> `claude_desktop_config.json` / `.mcp.json` by hand or running the `login` CLI.
>
> **Status: `[verify — live]`.** The MCPB manifest ([`../manifest.json`](../manifest.json))
> is authored and validated **offline** (it parses, is Prettier-clean, and conforms to
> MCPB manifest schema `0.3`). Live end-to-end **token acquisition** and the **packaged
> `.mcpb` install** into Claude Desktop are **pending real-credential validation** and
> have not yet been run against a real Instagram professional account. Treat the token
> steps below as the intended flow, not a verified transcript.
>
> For the complete Meta-app walkthrough (creating the app, adding the Instagram product,
> roles/testers, scopes, App Review reality), see **[`setup-guide.md`](setup-guide.md)**
> (authored in parallel). This document covers only the **GUI install** and the
> **token-without-CLI** shortcut.

## What the bundle expects

Claude Desktop launches the bundled server with `node ${__dirname}/dist/src/index.js`
and passes your GUI answers in as `IG_*` environment variables. The bundle is
**Path A (Instagram Login)** oriented: the one required field, `IG_ACCESS_TOKEN`, is a
**long-lived `graph.instagram.com` token** for an Instagram professional (Business or
Creator) account — no Facebook Page required. Path B (Facebook-Login / system-user
tokens, `IG_FB_ACCESS_TOKEN`) is **not exposed as a GUI field** in this bundle; Path-B
operators should install via JSON config / the CLI instead (see `setup-guide.md`).

Prerequisites (one-time, detailed in `setup-guide.md`):

- An Instagram **professional** account (personal accounts are not supported).
- A Meta app (**Business** type) with the **Instagram** product configured for
  "Instagram API with Instagram login", and your IG account holding a role
  (admin/developer/tester) on the app — **Standard Access**, no App Review needed for a
  solo operator on their own account.

## Step 1 — obtain `IG_ACCESS_TOKEN` (long-lived, Path A) without the CLI

You need a **long-lived (60-day)** Instagram-Login token. Getting one is a two-hop
process: mint a short-lived token, then exchange it for the long-lived one.

### 1a. Mint a short-lived token from the App Dashboard

1. Go to **developers.facebook.com → your app → Instagram → API setup with Instagram
   login**.
2. In the token generator, **add/select your Instagram professional account** and
   grant the scopes the server uses:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_comments`
   - `instagram_business_manage_insights`
   - `instagram_business_manage_messages` _(only if you plan to use messaging)_
3. **Generate the token.** The dashboard hands you a **short-lived (~1 hour)** token.

> **Graph API Explorer note.** The classic **Graph API Explorer**
> (`developers.facebook.com/tools/explorer`) issues **`graph.facebook.com` (Path B)**
> user tokens, **not** the `graph.instagram.com` (Path A) token that `IG_ACCESS_TOKEN`
> expects — so use it for Path B setups (`IG_FB_ACCESS_TOKEN`, JSON/CLI install) and as
> a convenient console for running the raw Graph calls in Steps 1b and 2. For the
> Path-A bundle, the **App Dashboard token generator above is the correct source.**

### 1b. Exchange it for a long-lived (60-day) token

Call the exchange endpoint once (in a browser address bar, `curl`, or the Explorer),
substituting your app secret and the short-lived token:

```
GET https://graph.instagram.com/access_token
      ?grant_type=ig_exchange_token
      &client_secret=<IG_APP_SECRET>
      &access_token=<SHORT_LIVED_TOKEN>
```

The response contains the **long-lived** `access_token` (valid ~60 days) — **this is the
value you paste into the `IG_ACCESS_TOKEN` prompt.**

> **Refreshing later.** A long-lived Path-A token can be refreshed (once it is ≥ 24 h old
> and not yet expired) via
> `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<LONG_LIVED_TOKEN>`.
> If you supply `IG_APP_ID` + `IG_APP_SECRET` in the GUI, the server's `refresh` path can
> do this for you before expiry.

## Step 2 — obtain `IG_ACCOUNT_ID` (optional)

`IG_ACCOUNT_ID` is optional — the server can resolve it — but providing it skips a lookup
and disambiguates multiple accounts. For a Path-A token, the account ID is the
**IG-scoped user id**:

```
GET https://graph.instagram.com/me?fields=user_id,username&access_token=<LONG_LIVED_TOKEN>
```

`user_id` in the response is your `IG_ACCOUNT_ID`.

_(Path B, for reference/`setup-guide.md`: `GET https://graph.facebook.com/v25.0/me/accounts`
→ pick the Page → `GET https://graph.facebook.com/v25.0/<page-id>?fields=instagram_business_account`
→ the `instagram_business_account.id`.)_

## Step 3 — map your values to the GUI prompts

When you install the extension, Claude Desktop renders one form field per `user_config`
entry in the manifest. Fill them as follows:

| GUI prompt (`user_config`) | Env var passed to the server | What to enter | Required |
| --- | --- | --- | --- |
| **Instagram access token** | `IG_ACCESS_TOKEN` | The long-lived token from Step 1b. Stored in the OS keychain (`sensitive`). | **Yes** |
| **Instagram account ID** | `IG_ACCOUNT_ID` | The `user_id` from Step 2. Leave blank to auto-resolve. | No |
| **Meta app ID** | `IG_APP_ID` | Your app's ID. Needed only for token refresh / `debug_token` / discovery. | No |
| **Meta app secret** | `IG_APP_SECRET` | Your app secret. Needed only for token exchange/refresh + `appsecret_proof`. Stored in the keychain (`sensitive`). | No |
| **Write mode** | `IG_WRITE_MODE` | `preview` (default — plan only) or `apply` (execute writes). | No |
| **Tool packages** | `IG_TOOL_PACKAGES` | `core` (default), `reader`, `publisher`, `all`, or an explicit comma-separated list. | No |

`sensitive: true` fields (**access token**, **app secret**) are written to the OS keychain
by Claude Desktop, never to a plaintext config file. Leaving an optional field blank means
the server falls back to its default / auto-resolution.

## Step 4 — install the `.mcpb` into Claude Desktop

1. Obtain the packaged bundle **`instagram-mcp-ai.mcpb`** (see the build step below; at
   release it will be attached to the GitHub release).
2. In **Claude Desktop → Settings → Extensions**, either **drag the `.mcpb` file** onto
   the Extensions pane or use **Install extension…** and select the file.
3. Claude Desktop shows the extension details and the **configuration form** from
   Step 3. Fill in at least **Instagram access token**, then **Install / Enable**.
4. The server appears in your MCP tool list. Because `IG_WRITE_MODE` defaults to
   `preview`, write tools return a plan first; switch to `apply` (per call or via the
   Write mode field) when you are ready to execute.

To change credentials later, reopen the extension's settings and edit the fields — no
file editing required.

## Building the `.mcpb` (release-time step, not required to use this doc)

The archive is produced with the official **MCPB CLI** (`@anthropic-ai/mcpb`), a dev
tool. **Do not install it globally** — run it via `npx` at release time only:

```bash
# from the repo root
npm run build                          # produce dist/
npm ci --omit=dev                      # (optional) ship only the 3 runtime deps in node_modules
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack            # -> instagram-mcp-ai.mcpb
```

`pack` archives the working directory (manifest + `dist/` + `node_modules` + `docs/`) into
a single `.mcpb`. Add a `.mcpbignore` to exclude non-runtime files (`src/`, `test/`,
`.github/`, coverage, AI-harness files) before shipping. This build/pack + a live install
are the parts still marked **`[verify — live]`** above.
