# Operations: Rate Limits, Errors, Pagination, Versioning

> Design document. Numbers reflect Meta docs as of 2026-07; **[verify]** items get
> re-checked during implementation.

## 1. Rate limits — the layered reality

| Limit | Scope | Number | Server behavior |
|---|---|---|---|
| Platform / BUC rate limit | per app+account; Instagram BUC uses a **rolling 24 h window** *[verified 2026-07-21]* | Instagram BUC: `4800 × impressions` calls/24 h; reported in `X-App-Usage` / `X-Business-Use-Case-Usage` headers | Parse on **every** response; cache last snapshot; expose in `instagram_token_status`; proactively slow down > 90 %, refuse non-read calls at 100 % with the reset estimate (`estimated_time_to_regain_access` when present) |
| Content publishing | per IG account, rolling 24 h | `config.quota_total` read at **runtime** — Meta's own docs conflict (100 in the guide vs 50 in the reference), so never hardcode *[verified 2026-07-21]*; carousel counts as 1 | Checked via `GET /{ig-id}/content_publishing_limit` before composite posts; quota impact shown in every publish preview |
| Hashtag search | per IG account, rolling 7 days | **30 unique hashtags** | Local persistent counter of queried hashtags (the API gives no usage endpoint **[verify]**); surfaced in every `search_hashtag` result |
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
| 429 / rate-limit codes (4, 17, 32, 613, 80002) | retry | retry (Graph rejects pre-processing → safe to replay) — **except `media_publish`, never auto-retried** |
| 5xx / network error / timeout | retry | **no retry** (non-idempotent; a publish may have landed) |
| 190 (invalid/expired token) | no retry → actionable error ("run `login`/`refresh`") | same |
| 10 / 200-series (permission) | no retry → names the missing scope | same |

Backoff: `min(500·2^n, 8000) ms + jitter`, max 3 retries; `Retry-After` honored,
capped 60 s. Per-host concurrency semaphore (default 4).
**`media_publish` is excluded from automatic retry entirely** (even on 429) until
live evidence proves replay safety — a duplicate post costs quota and is publicly
visible, worse than asking the operator to retry. A failed
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
| 9 / subcode 2207042 | Publishing quota exceeded | Refuse with quota-reset info from `content_publishing_limit` |
| — / subcode 2207051 | Spam/integrity restriction | **Never auto-retry**; surface Meta's `error_user_msg` verbatim |
| 2 / 1 / 500-class | Transient Meta-side | retry per matrix, then `kind: upstream` with `fbtrace_id` |

`error_user_msg`, `code`, `error_subcode`, and `fbtrace_id` are always preserved
onto the mapped error (and shown to the model) — thin-wrapper error laundering is a
documented prior-art complaint.

## 4. Pagination & response budget

- Graph cursor pagination (`paging.cursors.after` / `paging.next`): list tools take
  `after?` + `limit?` (server default 25, hard cap `IG_MAX_ITEMS`, default 200 with
  `fetchAll: true`). Capped reads always return `truncated: true`.
- **Never follow `paging.next` URLs blindly** — re-build requests from cursors so the
  host allowlist and version pin stay authoritative.
- Character-budget truncation (halving loop) on result serialization; compact JSON
  by default.
- Insights time ranges *[verified 2026-07-21]*: there is **no documented per-request
  window cap** — the real bounds are the **90-day retention** for account metrics,
  the default 24 h lookback when `since`/`until` are omitted, and `online_followers`
  covering only the last 30 days. Windowing logic sizes to the 90-day retention;
  demographics take `timeframe` (not `since`/`until`).

## 5. API versioning

- Pin `v25.0` (current, released 2026-02-18) in every URL, both hosts. Versions live
  ~2 years; v26 expected ~H2 2026 — upgrading is a deliberate, changelog-reviewed
  PR that bumps one constant in `core/settings.ts` and re-runs the manifest snapshot.
- Known deprecations already absorbed into this design: 2025-01-08 insights metric
  purge (`views`-based set only); v25 media-view metric renames on the Facebook
  side (irrelevant here but tracked); `metadata=1` introspection removed 2026-05-19
  — never used.
- Watch item: Meta's docs-tree migration (`/documentation/...` vs legacy `/docs/...`) —
  keep doc links canonical at implementation time.

## 6. Observability & diagnostics

- Structured JSON logs on stderr: tool start/done/error with duration, Graph call
  count, usage-header snapshot — never tokens, never full URLs.
- `doctor` CLI: token validity + expiry, account resolution, scope inventory,
  publishing quota, one cheap read per enabled package, rate-limit headroom.
- Per-host telemetry counters (calls, retries, throttles) exposed via a debug tool
  in the `account` package.

## 7. Webhooks — explicit non-goal (v1)

Real-time comment/mention/DM notifications require a public HTTPS webhook endpoint —
incompatible with a loopback-only local server. v1 is pull-only; a phase-3 option is
documented in [roadmap.md](roadmap.md) (tunnel or small hosted receiver, opt-in).
