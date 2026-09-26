# Authentication & Authorization

> Design document. Facts below reflect Meta docs as of 2026-07 (Graph API v25.0
> current since 2026-02-18). Every factual claim below carries a *[verified
> &lt;date&gt; — source]* stamp; the last bare **[verify]** in this file was cleared in
> the 2026-07-30 documentation-verification pass. What is genuinely still unknown
> lives in §5 as a named open question with the probe that would answer it — never
> as an unexplained marker.

## 0. Hard platform constraint

The Instagram Platform API serves **professional accounts only** (Business or
Creator). Personal accounts must be converted in the Instagram app first. The old
Basic Display API (personal accounts, read-only) was **shut down 2024-12-04** and is
not coming back — this server does not attempt any workaround.

## 1. The two auth paths

Meta offers two distinct ways to reach the same Instagram professional account. The
server supports **both**, selected by which env vars are present (`resolveAuthPath()`
in `src/core/config.ts`).

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
  - `instagram_business_manage_insights`
  - `instagram_business_manage_messages` — supported by the path, **not requested
    by `login`** (no messaging tool ships; M6 is DEFER — see
    [messaging.md](messaging.md)). Pass it via `login --scopes` if you need it.
- **Token lifecycle**: browser OAuth yields a short-lived token (~1 h) → exchange
  for a **long-lived token (60 days)**. The code exchange on `api.instagram.com`
  answers either flat (`{access_token, user_id, …}`) or wrapped as
  `{data: [{…}]}`; `login` accepts exactly one wrapped entry and refuses (nothing
  stored) a `data` list with several entries, or one beside a top-level
  `access_token`, rather than guess which token was authorized:
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
  (`instagram_manage_messages` for DMs — supported, but **not requested by
  `login`**; M6 is DEFER), plus Page plumbing:
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

## 2. App setup (one-time; the step-by-step walkthrough is [setup-guide.md](setup-guide.md))

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

- In `doctor` and the `instagram_token_status` tool (not at startup — the server
  makes no introspection call before serving):
  - Path B: `GET /debug_token?input_token=...`, authenticated with the profile's own
    token + `appsecret_proof` → `is_valid`, `expires_at`, `data_access_expires_at`,
    `scopes`. `expires_at` and `data_access_expires_at` are held to the same
    recordable range (whole seconds, 0 through 9999-12-31T23:59:59Z); a value outside
    it reads as unknown (CC-AUTH-68, CC-AUTH-71).
  - Path A: `debug_token` is **not available** — it is a `graph.facebook.com`-only
    endpoint *[verified 2026-07-21]*; validity is proven only by `doctor`'s
    reachability `GET /{IG_ACCOUNT_ID or me}`, and expiry comes from the record
    below.
- `login`/`refresh` persist the path (`IG_AUTH_PATH`) and the token's **expiry**
  (`IG_TOKEN_EXPIRES_AT`, Unix seconds, `0` = never, followed by `:` and a
  12-hex SHA-256 fingerprint of the token — never the token itself) next to
  the token. `login` and `refresh` turn the exchange's `expires_in` into the
  record through one rule (`expiryFromLifetime` in `src/core/time.ts`):

  | `expires_in` | Recorded as | Reads back as |
  |---|---|---|
  | absent, `null`, any other non-number, or a string that is not a canonical non-negative integer (`"-60"`, `"60.0"`, `" 60"`, `"060"`, `"6e1"`, `""`) | no record (an old one is removed) | unknown |
  | a canonical non-negative integer string (`"5184000"`, `"0"`) — Meta has quoted `expires_in` on some endpoints | read as that number, then as below | as below |
  | exactly `0` | `0` | never expires |
  | any other finite number | `floor(now + expires_in)`, in whole seconds | valid / expiring soon / expired |
  | a negative number | the past instant it names | expired, never "never expires" |
  | a sum at or before 1970-01-01 (a pre-1970 clock), past 9999-12-31T23:59:59Z, `NaN` or `±Infinity` | no record | unknown |

  The reader accepts exactly what the writers can produce: `0`, or a whole
  number of seconds from `1` to `253402300799` (the last second of year 9999).
  A record in **milliseconds** (a 13-digit `Date.now()` pasted by hand) is
  therefore refused and reads as unknown, rather than as a token valid until
  year 58692. `instagram_token_status` and
  `doctor` read it back as the Path A expiry (unknown when absent or malformed)
  and warn with `expiring_soon` once `IG_REFRESH_AFTER_DAYS` (default 45) or
  fewer days remain, so the operator runs `refresh`/`login` in time. The record
  describes the token that was written with it: a record whose fingerprint does
  not match the token in use (a token pasted by hand over it) reads as unknown
  rather than lending that token a foreign expiry (CC-AUTH-59); a record that
  reached the server from a different source than its token (the client passed
  the token, a file supplied the record) is dropped at startup and reads as
  unknown too; a bare record set by hand beside its token (`<seconds>` with no
  fingerprint — what the unknown-expiry warning tells an operator to set, and
  what records from before the fingerprint look like) is still read, but it is
  bound to nothing, so `token_status` and `doctor` report it as **unverified**:
  every dated state, `valid` and `never` included, carries a `warning` saying the
  expiry was set by hand and not checked against the token, and to run
  `refresh`/`login` to record a bound one (CC-AUTH-70). On Path A
  `doctor` reports a lapsed record as a warning and leaves the verdict to the
  reachability check. Path B's `debug_token` `expires_at` is held to the same
  range: a negative, a fraction, a value in milliseconds or anything past
  9999-12-31T23:59:59Z reads as **unknown** with a warning naming the value,
  never as a token dated in year 58692 or as one that "expired" in 1969
  (CC-AUTH-68).
- Refresh is **operator-driven**: nothing calls `refresh_access_token`
  automatically. `IG_REFRESH_AFTER_DAYS` is only the warning threshold above;
  the server has no refresh-decision helper at all (CC-AUTH-67).
- **Design gate D2 (architecture F-2 / devops F-1) — RESOLVED, option (a).** A
  token injected via the MCP client's `env` always wins over the XDG file, so a
  refreshed token persisted to XDG would never take effect for client-env users.
  Resolution: the **XDG env file is the only token home** — or, when
  `IG_ENV_FILE` names a file, that file, since it is then the only env file the
  server loads (`login` and `refresh` write it; see §4). `core/refresh.ts`
  performs the exchange and deliberately does not persist; only the `login` /
  `refresh` CLI writes, via `core/config-write.ts`. Tokens injected through the
  client `env` are treated as **static** — the server never pretends to rotate
  them in place, and says so instead (see [stability.md](stability.md)).

## 4. Storage rules

- Tokens live in the XDG env file (`chmod 0600`) or the OS keychain via the MCPB
  `user_config` mechanism — **never** in the repo, never in logs, never echoed back
  through MCP results (redaction layer strips anything token-shaped; see
  [security.md](security.md)).
- **Write target.** `login` and `refresh` write the config-home store
  (`<XDG_CONFIG_HOME | ~/.config>/instagram-mcp-ai/.env`, `%APPDATA%\instagram-mcp-ai\.env`
  on Windows) unless `IG_ENV_FILE` is set and non-blank: the server then reads
  that file **alone**, so that is the file they update — writing the config-home
  store instead would leave the server on the old token. The value must be an
  absolute file name: a relative one would resolve against whichever process's
  working directory reads it, so it stops the server at start-up and refuses the
  write, both with the same `kind: validation` error, before anything is touched
  (CC-CFG-70). A leading `~` is the home directory, for the read
  and the write alike; `~user`, `$VAR` and `%VAR%` spellings stop the start (and
  any write) with a `kind: validation` error naming `IG_ENV_FILE`. The named file
  is merged in place and left at `0600`, with its `.lock` and temp siblings
  beside it; its directory is the operator's and is neither created nor
  re-permissioned (a missing one fails the write). A `~` (or the default
  `~/.config` / `%USERPROFILE%\AppData\Roaming`) needs an absolute home: a
  blank or relative `HOME` / `USERPROFILE` is refused with a `kind: validation`
  error naming the variable, never resolved against the cwd (CC-CFG-69).
- **A symlinked store is written through the link**, for the config-home store
  and an `IG_ENV_FILE` alike: the link is resolved first, and the temp sibling,
  the `.lock` and the rename land beside its target, so the link survives and two
  links to one file share one lock. The write is still a fresh `0600` file
  renamed into place, never an in-place write. The target's directory is not
  created or re-permissioned. A chain of links is followed hop by hop, and a
  dangling hop, or ANY link in the chain owned by another user (whoever planted
  it would otherwise choose which of your files is rewritten), is refused before
  anything is touched (CC-CFG-73). The link is resolved again once the write
  holds the lock; if it was re-pointed in between, nothing is written and the
  command asks to be run again (CC-CFG-72).
- The app secret is required only for: token exchange (`login`), `appsecret_proof`
  computation (Path B), and `debug_token`. It is stored with the same rules; the
  server never transmits it except to `graph.facebook.com`/`graph.instagram.com`
  over TLS as protocol parameters.
- The env file is safe to `source` from a POSIX shell (`set -a; . <file>`) as well
  as to read with dotenv: every value is written bare, single-quoted or — only for
  a value holding `'` or a line break — double-quoted, and a value that would also
  need a `$`, `` ` ``, `"` or `\` inside those double quotes is refused with a
  `kind: validation` error naming the key (see
  [troubleshooting.md](troubleshooting.md)). A line break is stored as the escape
  `\n`, which dotenv turns back into a newline and a shell keeps as two characters.
- Writes are serialised by a `.env.lock` sibling that records the writer's pid,
  host and a random nonce; a waiting writer clears it only when that pid has
  exited on this host, or — for a lock with no record or from another host — once
  it is older than 30 s. A writer removes a lock (its own on release, or a stale
  one) only while it still carries the record that was judged, so it never
  deletes a lock another writer has since taken.

## 5. Open questions for implementation

**Resolved 2026-07-21** (see [reviews/platform-api-review.md](reviews/platform-api-review.md)):
scope names confirmed; Path A confirmed to lack hashtag search / `business_discovery` /
product tags; `debug_token` confirmed Path-B-only; `graph.instagram.com/v25.0/`
versioned paths confirmed.

**Resolved 2026-07-29:** token-refresh persistence across config channels — gate
D2, option (a); the XDG env file is the sole token home (see §3). The single
token variable question is settled too: `IG_ACCESS_TOKEN` carries the token on
**both** paths, and the path is inferred from `IG_APP_ID` + `IG_APP_SECRET`
unless `IG_AUTH_MODE` pins it. `login` and `refresh` store the path as
`IG_AUTH_PATH`, which wins over `IG_AUTH_MODE` when both are set, so once a store
exists it is `IG_AUTH_PATH` that pins the path.

Still open:

- "Instagram Public Content Access" feature gating for hashtag endpoints —
  the probe itself is **blocked on live credentials** (workplan T-E3), so its
  consequence was decided without it on 2026-07-29: the `discovery` package
  **stays registered** in the `reader` and `all` profiles. It is double-gated
  (non-default profile + Path-B capability filtering), every tool description
  carries the App-Review caveat, and a missing feature surfaces as a mapped
  `kind: 'permission'` error rather than a crash. Running the probe later can
  only confirm or reverse that call — see [roadmap.md](roadmap.md) for the
  one-line reversal.
- Messaging (Path A `instagram_business_manage_messages` vs Path B via Page): which
  to target for the phase-2 `messaging` package.
