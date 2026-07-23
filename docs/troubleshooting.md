# Troubleshooting

> Symptom → cause → fix, for the failures an operator actually hits. The error
> model behind this table is the `InstagramError` taxonomy in
> [operations.md](operations.md) §3 (a single class with a `kind` discriminant:
> `auth | permission | rate_limit | validation | upstream`) and the Graph code /
> subcode mapping in [`core/errors.ts`](../src/core/errors.ts). Every mapped error
> preserves Meta's `error_user_msg`, `code`, `error_subcode`, and `fbtrace_id` —
> so the exact code below shows up in the message you see.

Run **`doctor`** first for anything auth- or reachability-shaped — it names the
failing check. Reads are the cheapest reproduction; writes preview by default, so
a preview that "does nothing" is usually working as designed (see the last rows).

## Quick reference

| Symptom | `kind` · code/subcode | Likely cause | Fix |
|---|---|---|---|
| "run `login`/`refresh`" on every call | `auth` · **190** | Token expired, revoked, or password changed | Re-acquire: `refresh` (if refreshable) else `login`. |
| Startup error naming both token vars | (startup) | `IG_ACCESS_TOKEN` **and** `IG_FB_ACCESS_TOKEN` set, no `IG_AUTH_MODE` | Set `IG_AUTH_MODE=ig-login\|fb-login`, or unset one token. |
| Error names a missing scope | `permission` · **10 / 200–299** | Token minted before the scope was granted (scope drift), or insufficient permission | Re-run `login` to re-consent with the scope from [setup-guide.md](setup-guide.md) §5. |
| "restricting activity" / spam block | `upstream` · subcode **2207051** | Integrity / spam restriction | **Not retried.** Surface Meta's `error_user_msg` verbatim; slow down; wait it out. |
| Throttled / HTTP 429 | `rate_limit` · **4 / 17 / 32 / 613 / 80002** | App-, user-, or Instagram-BUC rate limit hit | Auto-retried with backoff (`Retry-After`, capped 60 s); if the reset is hours away it fails fast with the estimate — wait. |
| Publish refused: quota exhausted | `rate_limit` · **9 / 2207042** | 24 h publishing quota spent | Wait for the reset from `instagram_get_publishing_limit`; do not retry. |
| Container goes `ERROR`, publish never happens | `validation` · **100** | Media URL unreachable by Meta / bad format | Host the media at a **public** URL; re-create the container. |
| "container expired — re-create" | `validation` · **24 / 2207008** | Container not published within 24 h | Re-create the container and publish promptly. |
| "still processing — keep polling" | `upstream` · **9007 / 2207027** | Video container not `FINISHED` yet | Keep polling status; **do not** re-create. |
| Comment/publish fails on one media | `validation` · **100** | Comments disabled on that media | Enable via `instagram_set_comments_enabled`, or skip. |
| Discovery tools missing or denied | `permission` (or not registered) | Wrong auth path / package not enabled / PCA feature missing | Use **Path B**, enable the package, obtain "Instagram Public Content Access". |
| HTTP transport: **401 Unauthorized** | (transport) | Bearer missing or wrong | Send `Authorization: Bearer <IG_HTTP_TOKEN>`. |
| "tool not available on this auth path" | `permission` | Tool needs a path the profile isn't on | Switch the profile's path (Path B for discovery). |

## Details

### Token expired / invalid / revoked — code 190 (`kind: auth`)

Any `graph.*` call returns code **190** once the token dies — at the expiry date,
or **earlier** if the user changed their Instagram password or revoked the app
(metadata-based expiry is a hint, not a guarantee). The server maps it to
`kind: auth` with remediation text and does **not** retry-storm.

- **Refreshable?** Run `npx instagram-mcp-ai refresh`. Path A needs the token to
  be **≥ 24 h old and unexpired**; an already-expired token cannot be resurrected.
- **Not refreshable** (expired, revoked, or never went through `login`): run
  `npx instagram-mcp-ai login` to obtain a fresh long-lived token.
- If the token was injected via the client `env`, the server cannot rotate it in
  place — see the auto-refresh note in [stability.md](stability.md).

### Both tokens set, no auth mode (startup failure)

Setting both `IG_ACCESS_TOKEN` and `IG_FB_ACCESS_TOKEN` without `IG_AUTH_MODE` is
a **hard startup error** naming both variables — the server never guesses a path.
Set `IG_AUTH_MODE=ig-login` or `fb-login`, or remove one token. (With only one
token set, the path is auto-detected.)

### Missing / insufficient scope — codes 10, 200–299 (`kind: permission`)

Mapped to `kind: permission` with the **missing scope named**. The usual cause is
**scope drift**: the token was granted before a scope was added to the app. Re-run
`login` to re-consent. On **Path B** with a system-user token, a permission error
may instead mean the Business **assets** (Page / IG account) are not assigned to
the system user — assign them, don't just widen scopes. `doctor` lists the granted
scopes (Path B) so you can compare against [setup-guide.md](setup-guide.md) §5.

### Rate limiting + backoff — codes 4, 17, 32, 613, 80002, HTTP 429 (`kind: rate_limit`)

Instagram enforces app-, user-, and **Business-Use-Case** limits (BUC uses a
rolling 24 h window). The server parses `X-App-Usage` / `X-Business-Use-Case-Usage`
on every response, proactively slows past 90 %, and refuses non-read calls at
100 % with the reset estimate. Throttle errors are **retryable** with exponential
backoff `min(500·2^n, 8000) ms + jitter` (max 3), honoring `Retry-After` capped at
60 s. If the reset is hours away, it **fails fast with the estimate** rather than
blocking the MCP call — just wait. **`media_publish` is never auto-retried**, even
on 429 (duplicate-post risk). Check headroom any time via
`instagram_token_status`.

> **Not a throttle:** subcode **2207051** is a spam/integrity restriction
> ("restricting certain activity"), mapped to `kind: upstream` and **never
> auto-retried** — Meta's `error_user_msg` is surfaced verbatim. Slow your
> activity down; retrying makes it worse.

### Media URL unreachable by Meta — code 100 (`kind: validation`)

The **single most common publish failure.** Meta's servers fetch your
`image_url` / `video_url`; the server never fetches it and so **cannot pre-verify**
it in a preview. If the URL 404s, is auth-walled, IP-restricted, redirects oddly,
or the origin is too slow, the **container goes `ERROR`** and the server enriches
the error with the container `status` detail plus the reminder that the URL must
be publicly fetchable by Meta's crawlers.

Fix: host the media at a **public** `https://` URL (no localhost, no `file://`, no
auth wall). For pre-signed (S3-style) URLs, use **≥ 1 h validity** so the fetch
and any retry land inside the window. Format rules are enforced by Meta at fetch
time (JPEG-only feed images, ≤ 8 MB, aspect 0.8–1.91, reels ≤ 300 MB, story video
≤ 60 s) — the server checks only what is structurally visible (caption length,
carousel bounds, well-formed `https://`), because it never sees the bytes.

### Container status during the publish poll — `ERROR` / `EXPIRED` vs `FINISHED`

The publish flow is two-phase: create a container, poll its `status_code`, then
publish. During the poll:

- **`IN_PROGRESS`** → keep polling. A video container **must** reach `FINISHED`
  before publish. Subcode **2207027** (code 9007) means "still processing" —
  **keep polling, never re-create** (mapped `kind: upstream`).
- **`FINISHED`** → publish with `instagram_publish_media`.
- **`ERROR`** → the media could not be processed (usually the URL/format problem
  above). Fix the source and **re-create** the container.
- **`EXPIRED`** (code **24** / subcode **2207008**) → 24 h passed unpublished.
  **Re-create** and publish promptly; the write journal keeps the original
  container id for reference.

Composites (`instagram_post_image` / `_reel` / `_story`) cap internal polling at
**60 s**; if still processing, they return a **resumable** result carrying the
container id — resume rather than restarting to avoid a duplicate post. A
`media_publish` that fails after a `FINISHED` container likewise returns the
container id so you can resume with `instagram_publish_media`.

### Comments disabled on a media

Commenting on media with comments turned off is rejected by Meta and mapped to
`kind: validation`. `instagram_create_comment`'s preview warns when
`comments_enabled=false` is already known from a prior read. To allow comments,
toggle with `instagram_set_comments_enabled`. Related: replying to a **deleted**
comment ("comment no longer exists"), and Instagram's **one-level** threading —
you can reply to a top-level comment but not to a reply.

### Discovery: permission / App-Review gaps

`instagram_search_hashtag`, `instagram_get_hashtag_media`, and
`instagram_discover_business` are **Path B (`fb-login`) only**. If you don't see
them, check, in order:

1. **Auth path** — on Path A they are **not registered at all** (capability
   filtering). Switch the profile to `fb-login`.
2. **Package selection** — `discovery` is **not** in the default `core` profile.
   Enable it with `IG_TOOL_PACKAGES=reader` or `all` (or an explicit list
   including `discovery`).
3. **"Instagram Public Content Access"** — the hashtag endpoints require this Meta
   feature, which may be App-Review-gated even for your own app. Without it, calls
   return `kind: permission`. Business discovery may work before the hashtag
   endpoints do.

Also note the hashtag budget: **30 unique hashtags / 7 days** per account. The
server tracks an in-process, best-effort counter (not persisted, not shared across
machines) and surfaces it in results; Meta's own rejection is the hard signal.

### HTTP-transport bearer auth failures — 401 Unauthorized

The Streamable HTTP transport (`IG_TRANSPORT=http`) binds **loopback only** and,
when `IG_HTTP_TOKEN` is set, requires a constant-time-checked bearer on **every**
request. A missing or wrong bearer returns **`401 Unauthorized`**. Send:

```
Authorization: Bearer <IG_HTTP_TOKEN>
```

Other HTTP-transport gotchas: a **port already in use** (`IG_PORT`, default 3000)
is a clear startup error; DNS-rebinding protection restricts the accepted
`Host`/`Origin` to the bound loopback address, so reaching it via a non-loopback
hostname is refused. Always set `IG_HTTP_TOKEN` — loopback binding alone is not
authentication.

### Wrong auth path for a tool (capability filtering)

Tools that a given auth path cannot serve are **filtered out at registration** for
that profile, so they simply don't appear. As defense in depth, a call that still
reaches a path-incompatible tool is refused with
`kind: permission`: *"Tool '…' is not available on the '…' auth path … it requires
fb-login"*. The fix is to operate the profile on the required path (Path B for
discovery and pull-based `@mention` lookup). Per-profile auth is supported, so a
`fb-login` profile can coexist with a default `ig-login` one — select it with the
`account` argument.

### Writes that "do nothing" (not a bug)

Every mutating tool **previews by default** and performs **no** write. If a
publish/comment/hide call returns a `mode: preview` payload, that is the safety
gate working:

- Re-run with **`apply: true`**, or set **`IG_WRITE_MODE=apply`** for standing
  consent (an explicit `apply: false` always forces preview).
- `instagram_delete_comment` is **double-gated**: it needs `apply: true` **and**
  `IG_ALLOW_DESTRUCTIVE=true` — a preview message names both flags when one is
  missing.
- Applied writes are recorded to a local append-only journal
  (`~/.local/state/instagram-mcp-ai/writes.jsonl`).
