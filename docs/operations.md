# Operations: Rate Limits, Errors, Pagination, Versioning

> Design document. Numbers reflect Meta docs as of 2026-07. Every claim carries
> either a *[verified &lt;date&gt; — source]* stamp or a `[verify — needs a live call: …]`
> marker naming the call that would settle it. No bare `[verify]` remains in this
> file after the 2026-07-30 documentation-verification pass.

## 1. Rate limits — the layered reality

| Limit | Scope | Number | Server behavior |
|---|---|---|---|
| Platform / BUC rate limit | per app+account; Instagram BUC uses a **rolling 24 h window** *[verified 2026-07-21]* | Instagram BUC: `4800 × impressions` calls/24 h; reported in `X-App-Usage` / `X-Business-Use-Case-Usage` headers | Parse on **every** response; proactively slow down (1 s pause) above 90 %. **Not implemented:** `instagram_token_status` reports `rateLimitBudget.available: false` (the snapshot is not exposed), and nothing refuses calls at 100 % |
| Content publishing | per IG account, rolling 24 h | `config.quota_total` read at **runtime** — Meta's own docs conflict (100 in the guide vs 50 in the reference), so never hardcode *[verified 2026-07-21]*; carousel counts as 1 | Read on demand with `instagram_get_publishing_limit` (`GET /{ig-id}/content_publishing_limit`); composite posts do not pre-check it and previews do not show quota impact |
| Hashtag search | per IG account, rolling 7 days | **30 unique hashtags** | **Corrected 2026-07-30 — a usage endpoint does exist.** `GET /{ig-user-id}/recently_searched_hashtags` returns the hashtag IDs the account queried inside the rolling 7-day window ("IG Users can query a maximum of 30 unique hashtags within a rolling, 7 day period"), Facebook-Login only, `instagram_basic` *[verified 2026-07-30 — IG User `recently_searched_hashtags` reference, https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/recently_searched_hashtags]*. The local counter stays as a free pre-check, but it is **advisory**: the endpoint is authoritative, but the server does not call it, so nothing reconciles the counter yet (CC-RATE-4). Budget surfaced in every `search_hashtag` result |
| `/tags`, business_discovery etc. | folded into BUC | — | Nothing special beyond BUC handling |

Error codes signaling throttling: **4** (app-level), **17** (user-level), **32**
(page/user call count), **613** (custom-object/other), **80002** (Instagram BUC),
plus HTTP 429. All map to `kind: rate_limit`, retryable, with the reset hint when
derivable. **Not a throttle:** subcode `2207051` is a spam/integrity restriction
("restricting certain activity") — surfaced verbatim and **never auto-retried**
*[verified 2026-07-21]*.

## 2. Retry / backoff matrix

| Condition | GET | POST/DELETE |
|---|---|---|
| 429 / rate-limit codes (4, 17, 32, 613, 80002) | retry | **no retry** (a throttled write may already have landed upstream) |
| 5xx / network error / timeout | retry | **no retry** (non-idempotent; a publish may have landed) |
| 190 (invalid/expired token) | no retry → actionable error ("run `login`/`refresh`") | same |
| 10 / 200-series (permission) | no retry → names the missing scope | same |

Backoff: `min(500·2^n, 8000) ms + jitter`, max 3 retries; `Retry-After` honored,
capped 60 s. Per-host concurrency semaphore (default 4).
**No non-idempotent write is auto-retried — not even on 429**, and not only
`media_publish`. Meta can throttle a request *after* accepting it, so replaying a
`POST`/`DELETE` risks a duplicate post or comment: publicly visible and costly in
quota, worse than asking the operator to retry. Retry on 429 requires the caller to
mark the request `idempotent` explicitly; `GET` is idempotent by default. A failed
`media_publish` after a created container **does not** re-create the container —
the error carries the container ID so the operator/model can resume with
`instagram_publish_media`.

## 3. Error taxonomy (`InstagramError`)

Graph error envelope: `{ error: { message, type, code, error_subcode, fbtrace_id, error_user_msg } }`.
One `InstagramError` class with a **`kind` discriminant**
(`auth | permission | rate_limit | validation | upstream`) — not a subclass
hierarchy; handlers and the model branch on `kind`.

| code | Meaning | Server mapping |
|---|---|---|
| 190 | Token expired/invalid/revoked | `kind: auth` + remediation text (which CLI command fixes it) |
| 10, 200–299 | Permission/scope missing | `kind: permission`, names the scope and auth-path caveat |
| 4 / 17 / 32 / 613 / 80002 / 429 | Throttled | `kind: rate_limit`, retryable, reset hint |
| 100 | Invalid parameter (incl. bad media URL, unsupported aspect ratio) | `kind: validation`; container errors enriched from `status_code=ERROR` detail |
| 24 / subcode 2207008 | Container expired — not published within 24 h *[verified 2026-07-21]* | Actionable: re-create container |
| 9007 / subcode 2207027 | Media not ready for publish yet | Keep polling container status — do **not** re-create |
| 9 / subcode 2207042 | Publishing quota exceeded | Surfaces as a `rate_limit` error; a write is never retried. No quota-reset info is fetched |
| — / subcode 2207051 | Spam/integrity restriction | **Never auto-retry**; surface Meta's `error_user_msg` verbatim |
| 2 / 1 / 500-class | Transient Meta-side | retry per matrix, then `kind: upstream` with `fbtrace_id` |
| *(no recognised code)* + `type: OAuthException` | Authentication failure Meta marked but did not number | `kind: auth` — tie-breaker, never retried |

The last rung is a **tie-breaker, not a rule**: `error.type` is read only after the
subcode and code ladders have both declined, and the match is exact and
case-sensitive. Meta stamps `OAuthException` on throttles (4, 17, 32) and on
permission failures (10, 200–299) as well, and those numbered codes are the more
specific signal, so they keep their own kind. Without the tie-breaker a dead token
whose envelope carried no recognised code fell through to the HTTP-status fallback,
became `upstream`, and was replayed the full three times on any GET (CC-AUTH-23).

`error_user_msg`, `code`, `error_subcode`, and `fbtrace_id` are always preserved
onto the mapped error — thin-wrapper error laundering is a documented prior-art
complaint. What reaches the model is the single error line
`Instagram error (<kind>): <message> (code N, subcode M)`, where `<message>` is
Meta's `error_user_msg` when present, else `error.message`. "Present" means it has
at least one visible character: a field made only of whitespace, zero-width or bidi
characters counts as absent, so it cannot win over a useful `error.message` and
surface as a row of escapes (CC-DATA-96). The `fbtrace_id` is kept on the mapped
`InstagramError` object only; it is not rendered into that line and not written to
the log. It is escaped like the message and capped at 128 code points — a real one
is a few dozen characters — whether it came from the body or the `x-fb-trace-id`
header (CC-DATA-98). A code or subcode that is a number but not an integer is
still carried onto the error as sent, but the classification ladder ignores it:
`250.5` is not in the 200–299 permission band (CC-DATA-97).

"Verbatim" has two deliberate exceptions, because Meta's text is untrusted and
unbounded (CC-DATA-91). Every control, format (bidi override, zero-width) and
line/paragraph-separator character is rendered as a visible `\u{…}` escape, so the
text cannot forge a second line or repaint a terminal. And a message past 1000 code
points is cut and ends `… (N characters in all)`; a real Graph message is a sentence
or two and never reaches the cap. The cut falls only between words (CC-DATA-92):
a secret with no token shape is masked downstream by its exact value, which a
half-kept secret would slip past. The `login` token exchange applies the same rule
to Meta's refusal text (CC-DATA-93), and so does the `Authorization was denied:`
line, whose reason comes from the redirect's query string — anything that can reach
the loopback port writes it (CC-DATA-100). A transport failure wrapped by
`toInstagramError` (a socket error, a thrown string) is bounded and escaped the
same way (CC-DATA-99).

What the model receives for a failed call is `isError: true` and one text line,
`Instagram error (<kind>): <message>`, followed by ` (code N)`, ` (subcode M)` or
` (code N, subcode M)` when Graph supplied them — and no `structuredContent`, because
the MCP SDK client validates it against the tool's `outputSchema` even on an error
and would reject an `{ error }` object as `-32602` (CC-DATA-61).

## 4. Pagination & response budget

- Graph cursor pagination (`paging.cursors.after` / `paging.next`): list tools take
  `after?` + `limit?` (no default: an omitted `limit` is not forwarded, so
  Instagram picks the page size; hard cap `IG_MAX_ITEMS`, default 200 with
  `fetchAll: true`). A read returns `truncated: true` whenever more remained —
  which is the usual outcome of hitting the cap, but not a synonym for it: filling
  the cap exactly on a final page is a complete read, and stopping early on a
  cursor that cannot be replayed is a truncated one that was never capped. When a
  listing stops for a reason the cursor alone does not explain, it carries an
  optional `note` saying so.
- **Never follow `paging.next` URLs blindly** — re-build requests from cursors so the
  host allowlist and version pin stay authoritative.
- Compact JSON by default (`IG_PRETTY_JSON` indents it). No character-budget
  truncation is applied to serialized results.
- Every Graph response body is capped at **16 MiB** as it is read — more than 3×
  a worst-case 150-item page. A larger body is discarded and the call fails with
  an `upstream` error that is not retried; request a smaller `limit` or fewer
  fields, or check any proxy in front of Meta.
- Insights time ranges *[verified 2026-07-21]*: there is **no documented per-request
  window cap** — the real bounds are the **90-day retention** for account metrics,
  the default 24 h lookback when `since`/`until` are omitted, and `online_followers`
  covering only the last 30 days. Windowing logic sizes to the 90-day retention;
  demographics take `timeframe` (not `since`/`until`).

## 5. API versioning

- Pin `v25.0` (current, released 2026-02-18) in every URL, both hosts. Versions live
  ~2 years; v26 expected ~H2 2026 — upgrading is a deliberate, changelog-reviewed
  PR that bumps one constant (`GRAPH_VERSION` in `core/host.ts`) and re-runs the
  manifest snapshot.
- Known deprecations already absorbed into this design: 2025-01-08 insights metric
  purge (`views`-based set only); v25 media-view metric renames on the Facebook
  side (irrelevant here but tracked); `metadata=1` introspection removed 2026-05-19
  — never used.
- Watch item: Meta's docs-tree migration (`/documentation/...` vs legacy `/docs/...`) —
  keep doc links canonical at implementation time.

## 6. Observability & diagnostics

- Structured JSON logs on stderr: a `tool invoked` and a `graph request` record at
  `debug` level, and a `warn` when usage crosses the throttle threshold — never tokens,
  never full URLs. There is no per-tool done/error record, duration, or call count.
- One `warn` record at startup, `ignoring unrecognised IG_* environment variables`,
  when the environment carries an `IG_*` name nothing reads — a transposed knob
  (`IG_WRITEMODE`), a token filed under the reserved `default` profile name. It
  lists the names, sorted, and never a value; the server starts regardless, and
  the record is written before profile loading so it also reaches an operator
  whose misspelt token key stops the start (CC-CFG-13).
- The applied-write journal defaults to
  `~/.local/state/instagram-mcp-ai/writes.jsonl`. An absolute `XDG_STATE_HOME`
  moves its base and `IG_WRITE_JOURNAL` names the file outright (a relative
  `IG_WRITE_JOURNAL` is used as given, so it follows the server's cwd; a relative
  `XDG_STATE_HOME` is ignored). A leading `~` / `~/…` in either is expanded to the
  home directory, because an MCP client's JSON `env` passes it unexpanded; a
  `~user`, `$VAR`, `${VAR}` or `%VAR%` spelling stops the start with a
  `kind: validation` error naming the variable, as it does for the config home
  (CC-CFG-61). `doctor`'s Configuration section prints the resolved path.
- A blank or relative `HOME` (`USERPROFILE` on Windows) stops `~` expansion and
  the default config home with a `kind: validation` error naming the variable,
  rather than resolving them against the cwd (CC-CFG-69). A relative
  `IG_ENV_FILE` stops the start (CC-CFG-70); an unexpanded
  `${user_config.X}` template inside an env file reads as unset (CC-CFG-71).
- `doctor` CLI — five sections, matching `src/cli/doctor.ts` (which cites this
  section as its spec, so the two must not drift):
  1. **Configuration** — profile, auth path, transport, write mode, destructive
     flag, applied-write journal, active packages, refresh window. No secrets.
  2. **Token & authentication** — Path B introspects via `debug_token` (validity,
     scopes, expiry, and the data-access window, which closes independently of
     the token: `OK` while open, a `WARN` once closed, `INFO unknown` for a value
     that is not an instant, and no line when Meta reports none or `0` —
     CC-AUTH-12, CC-AUTH-77). Path A has no `debug_token`, so on that path validity is
     established only by the reachability check (CC-AUTH-7), and the expiry line
     shows the `IG_TOKEN_EXPIRES_AT` record `login`/`refresh` wrote, labelled with
     that variable, or `unknown` without one — or when the record's token
     fingerprint does not match the token in use (CC-AUTH-59).
  3. **Reachability** — one cheap `GET /{ig-id}` proving the token actually works.
     An answer that names no usable account id (`{}`, a `null`, numeric or blank
     `id`) is a **failure**, not an `OK … id=undefined` line: it proves the host
     answered, not that the profile can address its account. With an account
     id configured, an answer that names a **different** id is an
     `Account identity MISMATCH` **warning** naming both ids (CC-AUTH-6): every
     tool addresses the configured id, and the answer may be for another
     account. It warns rather than fails because the evidence is not conclusive:
     Instagram Login knows an account by two ids (the app-scoped `id` and the
     professional-account `user_id`), and whether `GET /{id}` echoes the id it
     was asked for is not yet verified live for both. The check reads the same
     answer and issues no call of its own; with no id configured the GET
     addresses `me`, so there is nothing to compare. On Path A a token for
     another account is expected (not verified) to be refused by Graph
     outright, so that case would show as `Reachability FAILED` instead.
  4. **Meta app Development-vs-Live mode** — not exposed by introspection, so the
     line points the operator at the App Dashboard; dev-mode apps face lower rate
     limits and can act only on app roles/testers.
  5. **Summary** — `exitCode` 0 when healthy, non-zero when the token is
     invalid/expired or the reachability GET fails. Near-expiry, a closed
     data-access window and an account identity mismatch warn, never fail.

  The journal line reports mode context and writability, because an unwritable
  journal is the one failure `mcp/write-mode.ts` deliberately swallows (it warns
  and lets the write succeed un-audited) — `doctor` is where an operator can find
  that out before trusting the trail.

  Text the report quotes from the wire — a Graph error message, the username,
  the app id, scope names, an unreadable `expires_at` — is redacted, then has
  every control, format (bidi, zero-width) and line-separator character shown
  as a visible `\u{…}` escape, so it cannot repaint the terminal or forge a
  report line. Error messages are cut at 300 characters and identifiers at 64,
  with the full length stated; the `[kind=…, code=…]` bracket is kept whole
  after the cut. A `debug_token` scope list that is not a list of names is a
  WARN (`Granted scopes: unreadable`), never a failed run.

  Text the report takes from the environment is escaped the same way, because
  nothing validates it before `doctor` prints it: the profile name (the
  `<NAME>` of `IG_PROFILE_<NAME>_*` accepts any character) and every variable
  name built from it, the configured account id, and `IG_TOOL_PACKAGES`,
  `IG_PACKAGES_DENY` and `IG_PACKAGES_READONLY` (`doctor` never builds the
  registry that would reject them). The profile name and account id are cut at
  64 characters, the package values at 300. The journal path, and a reason that
  names it, is escaped but never cut: a truncated path names a different file.

> **Not implemented (v1).** Earlier drafts of this section promised `doctor` would
> also report publishing quota, one cheap read per enabled package, and rate-limit
> headroom, and that a debug tool in the `account` package would expose per-host
> telemetry counters (calls, retries, throttles). None of that shipped: `account`
> has exactly three tools, and the per-host counters in `core/http.ts` are the
> concurrency semaphore's, not telemetry, and are exposed nowhere. The claims are
> recorded here as unbuilt rather than deleted, so the idea survives the
> correction — a diagnostic that quietly overstates its own coverage is worse than
> one that admits a gap.

## 7. Webhooks — explicit non-goal (v1)

Real-time comment/mention/DM notifications require a public HTTPS webhook endpoint —
incompatible with a loopback-only local server. v1 is pull-only; a phase-3 option is
documented in [roadmap.md](roadmap.md) (tunnel or small hosted receiver, opt-in).
