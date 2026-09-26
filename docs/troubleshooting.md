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
| "No default profile configured; set `IG_ACCESS_TOKEN`" | (startup) | No token in the environment — or the token was put in a variable the server does not read | **Both** auth paths read `IG_ACCESS_TOKEN`; there is no separate Path-B token var. |
| "uses fb-login but is missing `IG_APP_ID` / `IG_APP_SECRET`" | (startup) | Path B selected (explicitly or inferred) without app credentials | Set both, or select Path A with `IG_AUTH_MODE=ig-login`. |
| Error names a missing scope | `permission` · **10 / 200–299** | Token minted before the scope was granted (scope drift), or insufficient permission | Re-run `login` to re-consent with the scope from [setup-guide.md](setup-guide.md) §5. |
| "restricting activity" / spam block | `upstream` · subcode **2207051** | Integrity / spam restriction | **Not retried.** Surface Meta's `error_user_msg` verbatim; slow down; wait it out. |
| Throttled / HTTP 429 | `rate_limit` · **4 / 17 / 32 / 613 / 80002** | App-, user-, or Instagram-BUC rate limit hit | **Reads** are auto-retried with backoff (`Retry-After`, capped 60 s); **writes are never replayed**. After the last retry the error is returned — wait before retrying. |
| Publish refused: quota exhausted | `rate_limit` · **9 / 2207042** | 24 h publishing quota spent | Check usage with `instagram_get_publishing_limit` and wait for the rolling window to free a slot; do not retry. |
| Container goes `ERROR`, publish never happens | `validation` · **100** at creation, or `upstream` from the status poll | Media URL unreachable by Meta / bad format | Host the media at a **public** URL; re-create the container. |
| "container expired — re-create" | `validation` · **24 / 2207008** | Container not published within 24 h | Re-create the container and publish promptly. |
| "still processing — keep polling" | `upstream` · **9007 / 2207027** | Video container not `FINISHED` yet | Keep polling status; **do not** re-create. |
| Comment/publish fails on one media | `validation` · **100** | Comments disabled on that media | Enable via `instagram_set_comments_enabled`, or skip. |
| Discovery tools missing or denied | `permission` (or not registered) | Wrong auth path / package not enabled / PCA feature missing | Use **Path B**, enable the package, obtain "Instagram Public Content Access". |
| HTTP transport: **401 Unauthorized** | (transport) | Bearer missing or wrong | Send `Authorization: Bearer <IG_HTTP_TOKEN>`. |
| `doctor`: "Reachability FAILED — … the answer carries no usable account id" | `upstream` | `GET /{ig-id}` answered, but with no `id` (or a blank / non-string one) — typically a proxy or gateway answering in Meta's place, or a transient Graph fault | Retry; if it persists, check `IG_ACCOUNT_ID` and the token. `doctor` deliberately fails here rather than printing `id=undefined` under an OK line. |
| `doctor`: "Account identity MISMATCH — IG_ACCOUNT_ID is X, but GET /X answered for account Y" | (doctor `WARN`) | Graph answered the reachability GET with another id than the configured one — the id is an alias or copy of another account's, a proxy answers in Meta's place, or (Instagram Login) the configured id is the professional-account `user_id` while Graph answers with the app-scoped `id` | Check which account Y is. If it is not the account you mean to operate, every tool is addressing the wrong one: set `IG_ACCOUNT_ID` (or the profile's `IG_PROFILE_<NAME>_ACCOUNT_ID`) to the id of the account the token belongs to, or use a token for X. |
| `doctor` output shows `\u{1b}` or similar escapes in a profile name, account id, package list or journal path | (display) | The value from the environment carries a control, bidi or line-separator character — often a stray paste | Deliberate: `doctor` escapes such characters instead of letting them repaint the terminal or forge a report line. Retype the variable. |
| An error message, trace id, container status or `Authorization was denied:` reason shows `\u{a}`, `\u{202e}` or similar escapes, or ends `… (N characters in all)` | (any) | The text came from Meta, a proxy or the OAuth redirect and carried a control, bidi or line-separator character, or was longer than the cap | Deliberate: upstream text is escaped and bounded before it reaches a terminal, a log line or a tool result, so it cannot forge a line or flood the output. The escapes are the original characters; decode them if Meta support asks for the exact text. |
| "Tool '…' is not available on the '…' auth path" | `permission` | Tool needs a path the profile isn't on | Switch the profile's path (Path B for discovery). |
| "Cannot read/write the credential store at `<path>` (`<code>`)" | `validation` · `EACCES` / `ENOSPC` / `EISDIR` | `login` could not read or replace the env file it writes | Act on the `code`: free space, or fix the permissions on the file and the directory the message names. |
| A knob you set has no effect, and startup says nothing about it | (startup `warn`) | The variable name is not one the server reads — a typo, or a name from another tool | Read the startup warn record `ignoring unrecognised IG_* environment variables`; it lists the names verbatim. Check the spelling against `.env.example`. |
| `DOTENV_CONFIG_DEBUG=1` or `DOTENV_CONFIG_QUIET=false` produces no dotenv output | (no output) | Deliberate — the server withdraws both switches for the length of the env-file load | dotenv resolves them from the environment AHEAD of the options passed in code, and writes through `console.log` to **stdout** — the stream the stdio transport frames as JSON-RPC, where a banner is a parse error for the client and a disclosure of the config-home path. Read the env file directly instead. |

## Details

### Token expired / invalid / revoked — code 190 (`kind: auth`)

Any `graph.*` call returns code **190** once the token dies — at the expiry date,
or **earlier** if the user changed their Instagram password or revoked the app
(metadata-based expiry is a hint, not a guarantee). The server maps it to
`kind: auth` with remediation text and does **not** retry-storm.

- **Refreshable?** Run `npx instagram-mcp-ai refresh`. Path A needs the token to
  be **≥ 24 h old and unexpired**; an already-expired token cannot be resurrected.
- **Not refreshable** (expired, revoked, or never went through `login`): run
  `npx instagram-mcp-ai login --path <ig|fb>` to obtain a fresh long-lived token.
- If the token was injected via the client `env`, the server cannot rotate it in
  place — see the token-rotation note in [stability.md](stability.md) §3.
- **Expiry reported as unknown on Path A** (`token_status` / `doctor`): the
  `IG_TOKEN_EXPIRES_AT` record is absent, belongs to a different token, or is not
  whole Unix **seconds** from `1` to `253402300799` (`0` means never). The usual
  hand-edit mistake is a millisecond value (13 digits): divide it by 1000. A
  `login`/`refresh` whose response carried no usable `expires_in` also leaves it
  unknown — see [auth.md](auth.md) §3 for the full table.

### No token found (startup failure)

There is **one** token variable, `IG_ACCESS_TOKEN`, for both auth paths — the
path only decides which host the token is sent to and whether an
`appsecret_proof` HMAC is attached. A Path-B (Facebook Login) Page or
system-user token goes in `IG_ACCESS_TOKEN` too. If it is missing or blank the
server fails at startup with:

```
No default profile configured; set IG_ACCESS_TOKEN (the default account token).
```

The path itself is never guessed from the token: it is `fb-login` when both
`IG_APP_ID` and `IG_APP_SECRET` are set, otherwise `ig-login`, and
`IG_AUTH_MODE` (alias `IG_AUTH_PATH`) overrides the inference. Selecting
`fb-login` without app credentials is a separate hard startup error, because
`appsecret_proof` cannot be computed without the secret.

### `login` cannot read or write the credential store

Every `node:fs` failure from the credential store is surfaced as an
`InstagramError` (`kind: validation`) that names the file, the `code`, and the
remedy — never the random `.tmp` sibling the atomic write uses:

```
Cannot write the credential store at /Users/you/.config/instagram-mcp-ai/.env (EACCES): check free space and the permissions on its directory
Cannot read the credential store at /Users/you/.config/instagram-mcp-ai/.env (EISDIR): check the permissions on the file and its directory
```

The `code` is the diagnosis: `ENOSPC` is a full disk, `EACCES` a directory the
account cannot write, `EISDIR` a directory where the file should be, `ELOOP` a
broken symlink chain. A store that is a symlink is written through it (the
target is replaced, the link stays); a link whose target is missing, or one owned
by another user, is refused with a message saying so. A store that simply does not exist yet is **not** an error
— the first `login` creates it, with the directory at `0700` and the file at
`0600` (an `IG_ENV_FILE` target's directory is the exception: see below). A failed write leaves the store exactly as it was.

Two refusals are not `node:fs` failures and carry no `code`:

```
Cannot write the credential store at /Users/you/.config/instagram-mcp-ai/.env: its lock /Users/you/.config/instagram-mcp-ai/.env.lock is held by another writer and was not released within 10000 ms; retry once any other login or refresh has finished, or delete the lock file if none is running
Cannot write the credential store at /Users/you/.config/instagram-mcp-ai/.env: IG_APP_SECRET holds a single quote or a line break together with one of $ ` " \, which no env-file quoting keeps literal for both dotenv and a shell that sources the file, so nothing was written
```

**The lock.** Every write takes `.env.lock` beside the store, so a `login` and a
`refresh` for different profiles cannot undo each other. The lock records the
writer's pid, host and a random nonce (`<pid>@<host>@<nonce>`; older versions
wrote `<pid>@<host>`, which is still understood). A waiting writer clears it at once when
that pid is no longer running on this host, and otherwise waits — however long
the holder takes — for up to 10 s. A lock with no record (from an older version),
or one recorded on another host, is cleared once it is older than 30 s. If the
timeout names the lock and no `login`/`refresh` is running, delete the file: the
recorded pid may have been reused by an unrelated process. A writer only ever
removes a lock that still holds the record it judged, so a lock another writer
took in the meantime is left alone. A version older than the nonce judges a
nonced lock by its age alone, so do not run an old and a new `login` at once.

**The value refusal.** The store is written so that both dotenv and a POSIX shell
(`set -a; . ~/.config/instagram-mcp-ai/.env`) read every value literally. A value
holding a `'` or a line break can only go in double quotes, where a shell still
acts on `$`, `` ` ``, `"` and `\`, so a value that also holds one of those is
refused rather than written in a form that would run or change on `source`. Only
the key is named. Meta ids, tokens and app secrets never contain these
characters; check the value you passed for a stray paste.

### `login` / `refresh` with `IG_ENV_FILE` set

When `IG_ENV_FILE` is set and non-blank the server loads that file **alone**, so
`login` and `refresh` write the token there instead of the config-home store —
run them with the same `IG_ENV_FILE` the MCP client passes, and the success line
names the file that was written. The value must be an absolute file name (a
leading `~` counts as the home directory). A relative one would be resolved
against the working directory of whichever process reads it — the server's
client, or your shell — so it is refused by both: the server does not start, and
`login` / `refresh` write nothing:

```
instagram-mcp-ai failed to start: IG_ENV_FILE is set to "secrets.env", which is not an absolute file name. A relative name is resolved against the working directory of whichever process reads it — for the server, the directory its MCP client starts it in — so the server and login / refresh could each use a different file; set IG_ENV_FILE to an absolute file name (a leading "~" is the home directory) and try again.
```

An env file that holds an unexpanded MCPB template as a value
(`IG_ACCOUNT_ID=${user_config.IG_ACCOUNT_ID}`) is treated as not setting that
key, exactly as the same value in the client's environment is, so the next env
file can still supply it.

A spelling only a shell can expand stops the server itself from starting, since
it is also the file the server would read:

```
instagram-mcp-ai failed to start: IG_ENV_FILE is "$HOME/ig.env", which only a shell can expand — it is not a path this server can use to find the credential store; set it to an absolute path
```

The file's directory must already exist — it is yours, so it is neither created
nor re-permissioned (a missing one fails with the `ENOENT` store error above).
The file itself is left at `0600`. Setting `IG_ENV_FILE` *inside* an env file has
no effect on which file the server reads; set it in the real environment.

### The config home is a `~` or `$HOME` path

An MCP client's JSON `env` block is not a shell: `"XDG_CONFIG_HOME": "~/cfg"`
reaches the server unexpanded, while the same line in a terminal reaches `login`
expanded. So both sides find the same store, the server expands a leading `~`
(`~` or `~/…`, and `~\…` on Windows) in `XDG_CONFIG_HOME` / `%APPDATA%` to your
home directory. Any other spelling only a shell understands — `~user/…`, `$HOME/…`,
`${HOME}/…`, `%APPDATA%…` — is refused at startup (and by `login`), because
guessing would read one store and write another:

```
instagram-mcp-ai failed to start: XDG_CONFIG_HOME is "$HOME/cfg", which only a shell can expand — it is not a path this server can use to find the credential store; set it to an absolute path
```

Write the absolute path instead. Any other relative value is still ignored in
favour of the default, as the XDG spec requires.

The home directory itself must be absolute. `HOME` (`USERPROFILE` on Windows) is
used exactly as set, so a blank or relative value — `HOME="   "` — would put
`~/…` and the default config home under whatever directory the process started
in. It is refused instead:

```
login failed: the home directory is "   " (from HOME), which is not an absolute path, so a file under it would be looked for in whatever directory the process was started from; set HOME to an absolute path
```

A directory with a blank-looking name holding `instagram-mcp-ai/.env` in a
project folder is what an older build left behind in this situation; it holds a
live token, so delete it (`ls -la` shows it as a name made of spaces).

The write journal follows the same rule. A leading `~` in `XDG_STATE_HOME` or
`IG_WRITE_JOURNAL` is your home directory, and a `~user/…`, `$HOME/…`,
`${HOME}/…` or `%VAR%…` spelling in either stops the start with
`XDG_STATE_HOME is "$HOME/state", which only a shell can expand — it is not a
path this server can use for the write journal; set it to an absolute path`
(or the same line naming `IG_WRITE_JOURNAL`). Before, the first was silently
replaced by `~/.local/state` and the second became a folder named `~` or `$HOME`
under whatever directory the client started the server in — either way the audit
trail was not where you looked for it.

### An `IG_*` variable the server does not read

At startup the server lists, in one `warn` record, every `IG_*` name in the
environment that nothing reads:

```json
{ "level": "warn", "msg": "ignoring unrecognised IG_* environment variables",
  "names": ["IG_<the misspelt name>"],
  "hint": "nothing reads these; check the spelling against .env.example" }
```

Names only — never values, because a mistyped profile key carries a live token.
The record is written **before** profiles are loaded, so it is visible even when
a misspelt token variable is the reason the server then refuses to start.

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
on every response and proactively slows past 90 %; it does not refuse calls at
100 %. Throttle errors are **retryable on reads** with exponential backoff
`min(500·2^n, 8000) ms + jitter` (max 3), honoring `Retry-After` capped at 60 s;
after the last retry the error is returned — just wait. **No write is auto-retried**,
even on 429: Meta can throttle a request after accepting it, so replaying a
`POST`/`DELETE` risks a duplicate post or comment. The usage snapshot is not exposed
through any tool yet (`instagram_token_status` reports `rateLimitBudget.available:
false`).

> **Not a throttle:** subcode **2207051** is a spam/integrity restriction
> ("restricting certain activity"), mapped to `kind: upstream` and **never
> auto-retried** — Meta's `error_user_msg` is surfaced verbatim. Slow your
> activity down; retrying makes it worse.

### Media URL unreachable by Meta — code 100 (`kind: validation`)

The **single most common publish failure.** Meta's servers fetch your
`image_url` / `video_url`; the server never fetches it and so **cannot pre-verify**
it in a preview. If the URL 404s, is auth-walled, IP-restricted, redirects oddly,
or the origin is too slow, the **container goes `ERROR`** and the composite tools
fail with `kind: upstream`, the container `status` detail, and an instruction to
re-create the container.

Fix: host the media at a **public** `https://` URL (no localhost, no `file://`, no
auth wall). For pre-signed (S3-style) URLs, use **≥ 1 h validity** so the fetch
and any retry land inside the window. Format rules are enforced by Meta at fetch
time (JPEG-only still images — feed, story and reel cover — ≤ 8 MB, aspect
0.8–1.91, reels ≤ 300 MB, story video ≤ 60 s) — the server checks only what is
structurally visible (caption length, carousel bounds, well-formed `https://`),
because it never sees the bytes.

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
`kind: validation`. `instagram_create_comment`'s preview does not check whether
comments are enabled. To allow comments,
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
discovery and `instagram_list_linked_accounts`). Per-profile auth is supported, so a
`fb-login` profile can coexist with a default `ig-login` one — select it with the
`account` argument.

### Writes that "do nothing" (not a bug)

Every mutating tool **previews by default** and performs **no** write. If a
publish/comment/hide call returns a `mode: preview` payload, that is the safety
gate working:

- Re-run with **`apply: true`**, or set **`IG_WRITE_MODE=apply`** for standing
  consent (an explicit `apply: false` always forces preview).
- `instagram_delete_comment` is **double-gated**: it needs an applied call
  (`apply: true`, or `IG_WRITE_MODE=apply` without `apply: false`) **and**
  `IG_ALLOW_DESTRUCTIVE=true` — the refusal names both flags when one is missing.
- Applied writes are recorded to a local append-only journal (by default
  `~/.local/state/instagram-mcp-ai/writes.jsonl`; `IG_WRITE_JOURNAL` or an absolute
  `XDG_STATE_HOME` moves it, and a leading `~` in either is your home directory —
  see [The config home is a `~` or `$HOME` path](#the-config-home-is-a--or-home-path)).
