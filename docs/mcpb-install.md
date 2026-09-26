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
tokens) puts its token in the **same** `IG_ACCESS_TOKEN` field. The bundle does expose
`IG_APP_ID` and `IG_APP_SECRET` as optional GUI fields, and pins the auth path with the
**Auth path** field (`IG_AUTH_MODE`), which defaults to `ig-login`. Without that pin,
filling **both** app fields would make the server infer a Path-B (`fb-login`) token; with
it, a Path-A token stays Path A whatever the app fields hold. For a Path-B token, set
**Auth path** to `fb-login` and fill both app fields (see `setup-guide.md`).

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
> expects — so use it for Path B setups (JSON/CLI install) and as
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
> The server never refreshes a token by itself, and the `refresh` CLI rewrites the
> credentials file, not the token Claude Desktop passes in: after refreshing, paste the new
> token into the GUI field. A Path-A refresh needs neither `IG_APP_ID` nor
> `IG_APP_SECRET`; if you fill them anyway, keep **Auth path** at `ig-login`.

## Step 2 — obtain `IG_ACCOUNT_ID` (optional)

`IG_ACCOUNT_ID` is optional on Path A — left unset, every call addresses `me`, which an
Instagram-Login token resolves to its own account (no lookup is made). Set it on Path B,
where `me` is the Page or user behind the token rather than the Instagram account. For a
Path-A token, the account ID is the **IG-scoped user id**:

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
| **Instagram account ID** | `IG_ACCOUNT_ID` | The `user_id` from Step 2. Leave blank on Path A to address `me`; set it on Path B. | No |
| **Meta app ID** | `IG_APP_ID` | Your app's ID. Path B only (with the secret: token refresh, `debug_token`, discovery); leave blank for a Path-A token. | No |
| **Auth path** | `IG_AUTH_MODE` | `ig-login` (default — Instagram Login, Path A) or `fb-login` (Facebook Login, Path B; also fill both app fields). | No |
| **Meta app secret** | `IG_APP_SECRET` | Your app secret. Path B only (token refresh + `appsecret_proof`); leave blank for a Path-A token. Stored in the keychain (`sensitive`). | No |
| **Write mode** | `IG_WRITE_MODE` | `preview` (default — plan only) or `apply` (execute writes). | No |
| **Tool packages** | `IG_TOOL_PACKAGES` | `core` (default), `reader` (forced read-only — no write tool is registered), `publisher`, `all`, or an explicit comma-separated list. | No |

`sensitive: true` fields (**access token**, **app secret**) are written to the OS keychain
by Claude Desktop, never to a plaintext config file. Leaving an optional field blank means
the server falls back to its default / auto-resolution.

## Step 4 — install the `.mcpb` into Claude Desktop

1. Obtain the packaged bundle **`instagram-mcp-ai-<version>.mcpb`** (see the build step below; at
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

The archive is produced with the official **MCPB CLI** (`@anthropic-ai/mcpb`), run via
`npx` by `scripts/build-mcpb.sh` — **do not install it globally**, and do not run a bare
`mcpb pack` from the repo root: that archives the whole working directory (`src/`,
`test/`, `.github/`, dev `node_modules`, local AI-harness files) into a ~16 MB bundle.

```bash
# from the repo root; publishes nothing
scripts/build-mcpb.sh . ./out          # -> out/instagram-mcp-ai-<version>.mcpb
```

The script builds `dist/`, stages the exact npm tarball contents (`npm pack`), adds
`manifest.json`, installs production dependencies only (`npm ci --omit=dev` inside the
staging directory, never in your checkout), checks that the manifest version matches
`package.json`, then runs `mcpb validate` and `mcpb pack` on the staging directory. The
result is ~3 MB. A live install into Claude Desktop is the part still marked
**`[verify — live]`** above.
