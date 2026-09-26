# Security Model

> Design document. Threat model: a locally-run, single-operator MCP server holding
> long-lived Meta credentials, driven by an LLM. The prior-art research shows
> security is the #1 weakness of existing Meta MCP servers (leaked tokens in
> callback URLs, SSRF in media upload, 0/100 audit scores) — this design treats it
> as a first-class requirement, not a hardening pass.

## 1. Assets & adversaries

| Asset | Threat |
|---|---|
| Access token (60-day or never-expiring) | Exfiltration via logs, MCP results, error messages, committed files |
| App secret | Same, plus misuse to mint `appsecret_proof`/tokens |
| The IG account itself | Destructive actions (delete comments, unwanted posts) triggered by prompt-injected or mistaken model output |
| Operator's machine/network | SSRF via attacker-influenced URLs; malicious dependency |

## 2. Credential handling

- Tokens + app secret only in: process env (from MCP client config), the XDG env
  file (**`0600`**, atomic comment-preserving writes), or OS keychain (MCPB
  `user_config`). Never in the repo; `.env*` git-ignored in the scaffold from day one.
- **The env-file writer's two 2026-09-01 fixes (CC-CFG-9/10).** `0600` on the file is
  necessary and was not sufficient. (a) The *directory* is now `chmod 0700`-ed
  unconditionally after the `mkdir`, because `mkdir`'s `mode` applies only to
  directories it creates — an inherited or restored store kept whatever mode it had, and
  write permission on the directory is what lets another local account rename our env
  file away and leave its own behind, so the next `login` writes a fresh token into a
  file somebody else controls. Accepted cost: a directory owned by another user now
  raises `EPERM` and `login` fails loudly, which is the correct outcome for a store we
  cannot secure. (b) The merge rewrites **every** occurrence of a key, not just the
  first. dotenv is last-one-wins, so a duplicate `IG_ACCESS_TOKEN=` further down the file
  — ordinary in a hand-edited file — used to keep its revoked value *and beat* the fresh
  one written above it: the token stayed on disk in cleartext and won at read time while
  `login` reported success. Keys that were not found are appended **after** the existing
  content for the same reason.
- **Not reachable from the CLI:** a *relative* `configDir` resolves against the process
  CWD (CC-CFG-11), but only through the programmatic `writeCredentials` option. `login`
  has no `--config-dir` flag and always writes under the config home, and a relative
  `XDG_CONFIG_HOME`/`APPDATA` is ignored rather than resolved against the CWD.
- **Redaction layer (`core/redact.ts`)** runs before any serialization to the model:
  masks the configured token/secret values and anything matching token shapes
  (`EAA…`, `IGQ…`-style prefixes) in results, errors, and logs. The Instagram
  shape requires an alphanumeric character right after `IG` (`IGQ…`, `IGAA…`), so
  the server's own `IG_*` variable names pass through verbatim in the diagnostics
  that must name them (CC-PROC-72); a token that began `IG_` would rely on the
  exact-value pass, where every configured and every minted token is registered. Every serialization
  sink is inside that boundary as an enforced control, not a convention: the log
  stream, the per-call `logFields` payload (routed through the redactor by the
  registry), and the applied-writes journal (redacted in `mcp/write-mode.ts` before
  the entry is appended). Since 2026-08-28 the write gate's three failure paths —
  the elicitation capability probe, the confirmation round trip and the
  journal-append warning — all route their `Error.message` through the same helper,
  so "no sink in the write gate bypasses the redactor" is a property of the module
  rather than of how `src/index.ts` happens to wire the logger. Two passes run in
  order: profile-scoped (masks the active profile's credentials even if they were
  never registered globally) then global (masks every registered secret plus
  anything token-shaped that belongs to no configured profile).
- **The tool-result body is inside the boundary since 2026-08-29.** It was not
  before: the redactor reached the log sinks only, and `result.ts` carried a
  docstring promising masking by a module that had never existed. The control now
  sits in `mcp/registry.ts` as a per-call `redactResult` wrapper on `registerOne`'s
  callback — the single path by which a tool result reaches the client — fed by the
  same injectable seam as the log payload, deliberately one seam for both sinks so
  an embedder cannot replace one and silently keep the other. It **fails closed**:
  if the redactor returns anything that is no longer a well-formed tool result, the
  raw result is withheld and an error is returned in its place. The redacted result
  is a deep copy, so `structuredContent` is no longer the handler's live object.
  The builders in `result.ts` are a convention, not a boundary — a handler can
  return a result literal without calling them — which is exactly why the control
  is at the registry and not in them.
- **The elicitation prompt is inside the boundary since 2026-08-30.** It is a
  second, independent server→client channel — it travels through `elicitInput`,
  not through a tool result, so `redactResult` cannot cover it by construction
  (CC-PROC-20) — and it is the one message a **human reads and approves**, so it
  was the worst place to be running the weakest pass. `buildConfirmPrompt` now
  applies the same two passes as `logSafeError` in the same module: profile-scoped
  first, then a real `core/redact.ts` redactor for globally registered secrets and
  the token-shape backstop. The untrusted-content fence is unaffected — redaction
  runs after `sanitizeLine` has stripped `\p{C}`, so it can only shorten spans.
  Accepted and tested cost: a target id shaped like a credential (64 hex
  characters) is masked. A real Instagram object id is 17–18 digits and matches no
  token shape, so this only ever hides values that look like secrets, and the
  framing line survives so the operator can see the target is unreadable and
  decline.
- **When redaction itself fails, the log sink writes nothing that passed through
  it (CC-PROC-22, since 2026-08-31).** The redactor is an injected seam, so it can
  throw — an embedder's own implementation, or a hostile getter on a caller field.
  Until now that exception propagated out of `emit` into the request that logged
  the line, which is the CC-PROC-12 failure class reached through a different door.
  The record-building region in `core/log.ts` is now guarded as a whole, because
  the redactor is reached at **three** points (the fields object, the message
  string, and the reason text inside the serialization failure path) and one guard
  per call site would have missed the third. What survives the failure is only what
  never touched the redactor: `level`, `time`, a fixed `msg` stand-in, and a marker
  naming the outcome. The caller's fields and the caller's message are both
  dropped — an interpolated message is exactly where a token would be. The detail
  field carries the thrown error's **name only, never its message**: a redactor
  that throws may well have embedded the value it choked on in the text, and that
  value is the one thing just proven unredactable. The marker keys themselves are
  reserved: a caller field named `logError` is re-keyed rather than allowed into
  that slot, so a degraded line cannot be made to look healthy — nor a healthy
  one made to look degraded — by anything a tool passes in (CC-PROC-27).
- **A parameter that cannot be stringified is refused by name, not by value
  (CC-DATA-14, since 2026-08-31).** `core/host.ts` now turns a value with no string
  form into an `InstagramError` of kind `validation` instead of letting a raw
  `TypeError` escape the layer. The message names the offending **key** in quotes
  and carries neither the value nor the underlying error's text: both are
  caller-controlled, and a `toString` that throws is free to put whatever it was
  holding into the message it throws. This is the same rule the log sink follows
  when redaction fails — name the outcome, never quote the input.
- **Where the boundary still does *not* reach**, stated plainly:
  - Key-name masking (`access_token`, `client_secret`, …) reaches a text block only
    when that block is an exact JSON rendering. **Corrected (CC-DATA-104):** this
    bullet used to say key-name masking never reached the text block, and the
    string pass also missed a registered secret whose characters JSON escapes. A text
    block that is byte-for-byte `JSON.stringify(v)` or `JSON.stringify(v, null, 2)`
    (what `json()` emits) is now parsed, redacted as a value and re-serialized with
    the same indent, before the whole-result string pass. A block that is not an
    exact rendering of its own parse (hand-written prose) still gets value- and
    shape-based masking only. If the redacted value cannot be serialized, the result
    is withheld (fail-closed).
  - A **legitimate** string that genuinely has a token's shape is masked;
    `#IGCommunityFeatureAward2026Winners` is the real example. Ordinary captions,
    handles, permalinks, ISO timestamps and 17–18-digit object ids survive, pinned
    by byte-identical assertions.
- Logs are structured JSON on **stderr only** (stdout is the MCP transport channel).
  Graph puts `access_token` in the query string, so **no assembled URL ever reaches a
  log call at all** — the request record is `{ method, host, path }` and the params
  never join it. **Corrected 2026-09-01:** this bullet used to credit a `safeUrl`
  query-stripping helper. No such function exists, and none is needed: the URL that
  `buildUrl` assembles in `core/http.ts` is passed to `fetch` and nowhere else. Two
  independent controls stand behind that anyway — the injected redactor is applied at
  the sink to the merged fields object *and* to the message string, so even an
  interpolated `${url}` in a hand-written message cannot bypass it, and the logger owns
  the `level`/`msg`/`time` slots so a caller field cannot impersonate them.
- `debug_token`/`login` flows keep the app secret server-side; the `login` CLI
  callback binds to loopback and the OAuth `state` parameter is random and checked
  (the prior-art token-in-callback-URL leak class).

## 3. Network policy (SSRF)

- Hard host allowlist: `graph.instagram.com`, `graph.facebook.com` — those two and
  nothing else. Everything else, including redirect targets, is refused in
  `core/host.ts` before the socket opens. No env override widens this in v1.
  `rupload.facebook.com` is deliberately **not** in the list: it joins only when a
  resumable-upload phase ships, so v1 carries no dead allowlist entry.
- `image_url`/`video_url` inputs are **passed to Meta**, not fetched locally — the
  server never retrieves user-supplied URLs itself. Consequence: publish previews
  cannot verify URL reachability, and say so ([tools.md](tools.md)). If a future
  helper uploads local files to operator storage, it will use a separate, explicit
  allowlist.
- The allowlist array is `Object.freeze`d, not merely `readonly`. `readonly` is
  erased at compile time, so without the freeze any importing module could widen
  the process-wide allowlist with a cast and a `push`.
- **The allowlist governs every server-issued Graph request** — `core/http.ts` for
  tool calls, `core/refresh.ts` for the token exchange. There is exactly one
  documented exception: `src/cli/login.ts` builds six OAuth and token-exchange
  URLs from module-level literals without passing through `buildUrl`. No host
  reaches them from an operator, a config or the model, so a runtime gate there
  would guard compile-time constants; instead the six URLs are pinned by test,
  and a second test pins that `www.instagram.com`, `api.instagram.com` and
  `www.facebook.com` are deliberately **not** allowlisted.

### HTTP transport authentication

The default transport is stdio, where the client owns the process and there is
nothing to authenticate. `IG_TRANSPORT=http` is the opt-in that turns the server
into a listener, and everything below is about that mode.

- **`IG_HTTP_TOKEN` unset means the server has no authentication at all.** Not
  weak authentication — none: every local process on the machine can call every
  tool, writes included, by finding the port. It is allowed because a loopback
  listener with no shared secret is a reasonable thing to want on a single-user
  laptop, and refused everywhere else (below). Startup logs it at **error** level
  with that sentence spelled out, so it cannot be mistaken for a default that
  happens to be safe.
- **A non-loopback bind is refused outright, token or not** — the process does not
  start, and no `IG_HTTP_TOKEN` changes that. `IG_HTTP_HOST` accepts only the
  loopback spellings (`127.0.0.0/8`, `localhost`, `::1`, `[::1]`); the check lives in
  `core/settings.ts`, runs before the transport is built, and never reads the token.
  Binding `0.0.0.0` publishes the operator's Instagram account to the network
  segment, and a shared secret is not a substitute for not doing it — to expose the
  transport, put an authenticating reverse proxy in front of a loopback bind.
  `startHttp` carries a second, looser guard that would allow a non-loopback bind
  once a bearer is set; it is defence in depth for a direct caller of that function,
  and no `IG_HTTP_HOST` an operator can set reaches it.
- **A blank token counts as no token, out loud** — it neither authenticates nor
  refuses. `IG_HTTP_TOKEN=` and `IG_HTTP_TOKEN="   "` are what an operator gets from
  an unset shell variable or an empty line in a unit file, and treating either as "a
  token is configured" would authenticate every caller while reporting that it is
  protected. The entry point trims the value and drops it, so the server starts with
  the same **error**-level no-authentication line an unset token produces, and
  serves anonymous requests. `startHttp` would refuse a blank token outright if one
  ever reached it; none does, so that log line is the whole signal — a blank token
  is the one spelling that looks configured and is not.
- **The bearer check runs before the MCP layer, on every verb and every path.**
  `startHttp` routes on nothing — the endpoint is the whole server — and the SDK
  answers the odd verbs itself: stateless mode has no session to end, so it replies
  **200** to a `DELETE`. A check scoped to `POST` would therefore hand the tool
  surface to anybody who found the port, which is why the precedence is asserted
  rather than assumed: each shape is tested twice, once with no credential and once
  with the right one.
- **Comparison is byte-for-byte and constant-time**, and each side is encoded the
  way it arrived — Node decodes header values as latin1, while `process.env` is
  already UTF-8, so comparing both as UTF-8 refuses the one client that sent
  exactly the right non-ASCII credential. A length mismatch runs a
  `timingSafeEqual` against a copy so it costs the same as a value mismatch.
- **DNS rebinding is blocked by a `Host` allowlist** carrying both the bare bound
  address and the `host:port` form, so a browser tricked into resolving an attacker
  domain to `127.0.0.1` cannot reach the tools.
- The refusal body is a constant `Unauthorized` — it never says whether the header
  was missing, malformed, or simply wrong.

### Path injection (distinct from SSRF)

The host cannot be changed by a model-supplied value — dot segments do not escape
the authority, and the scheme is a proven literal. What a hostile **object id**
could do, before 2026-08-28, was change the rest of the URL:

- `#` moves the whole query string — **including `access_token`** — into the
  fragment, so the request goes out **unauthenticated**;
- `?` / `&` inject parameters *ahead* of the auth parameters `core/http.ts` appends;
- `../` lets normalisation collapse `/v25.0/../me` to `/me`, silently dropping the
  pinned Graph API version.

Closed at two independent layers, on purpose — either one alone is a single
mistake away from regressing. The api layer percent-encodes every interpolated id
(**22 call sites across all six api modules — re-measured 2026-09-01**; this
sentence read "21" while `api/discovery.ts` in fact had none, and
`instagram_get_hashtag_media`'s `hashtagId` was still a bare `z.string().min(1)`,
so that one tool was the single place where *neither* layer held. Both halves are
now closed, and the count is derived from the tree rather than from the audit note
that could not see the module it never opened); the tool layer constrains the charset to
`/^[A-Za-z0-9_-]{1,64}$/` on the 16 id-bearing fields (`src/tools/ids.ts`), which
is the exact complement of the three failures above. `.` is excluded
deliberately — a single `..` segment is enough to eat the version pin. Pagination
cursors, hashtag search terms and usernames keep their own rules and are pinned as
*not* carrying the id rule: the first two are query parameters that
`URLSearchParams` already encodes, and a username is interpolated into a Graph
field expression, where percent-encoding is not an available escape. The refusal
message states the rule but never quotes the offending value — an id field is
exactly where a caller may paste a token by mistake.

## 4. Model-driven-mutation safety

- **Plan-and-apply** on every write (see [tools.md](tools.md)): preview by default,
  `apply: true` to execute, `IG_WRITE_MODE=apply` for standing consent; journal of
  applied writes for audit (redacted before it is written — see §2).
- **Honest annotations**: `destructiveHint` on irreversible ops (`delete_comment`),
  `readOnlyHint` on all reads — clients surface these in their permission UX, and
  `IG_PACKAGES_READONLY` / `IG_TOOL_PACKAGES=reader` filter on `readOnlyHint`, so a
  tool mis-annotated as read-only would be both advertised as safe *and* survive
  the filter. Since 2026-08-27 the annotation is bound to real behaviour rather
  than trusted: `test/mcp/tool-metadata-contract.test.ts` **executes** all 28
  handlers against an instrumented write-gate context and derives read-vs-write
  from what each one actually does, under four `IG_WRITE_MODE` ×
  `IG_ALLOW_DESTRUCTIVE` configurations that must all agree. A handler whose
  behaviour cannot be classified fails the test rather than defaulting to "read".
  Current surface: 17 read, 11 write, all axes agreeing. Since 2026-08-29 the hint
  is also **present on all 28** — the six `comments` writes previously omitted it
  and leaned on the MCP default — and its presence is enforced by the same test, so
  a new tool cannot ship with the annotation silently absent. Behaviour did not
  change (the filter tests `!== true`); what changed is that "absent" is no longer
  an accepted state for the weakest review signal in the write surface.
- Irreversible deletion double-gated behind `IG_ALLOW_DESTRUCTIVE=true`.
- **Publishing quota**: `instagram_get_publishing_limit` reads the live quota. Previews
  do not state quota impact and the composite posting tools do not pre-check it; an
  exhausted quota surfaces as Meta's own `rate_limit` error (code 9 / subcode 2207042),
  and no write is ever auto-retried.
- Packages can be force-read-only (`IG_PACKAGES_READONLY`) — e.g. run `publishing`
  dark while testing prompts.

### Design gate D3 — human confirmation (option (a): MCP elicitation) — **implemented**

D3 asked whether write confirmation should be (a) an interactive MCP *elicitation*
prompt or (b) env flags alone. **Option (a) is implemented**, layered on top of (b)
rather than replacing it — the env flags remain the floor.

- **Where.** `src/mcp/write-mode.ts` runs the confirmation as the *third* gate, after
  `apply`/`IG_WRITE_MODE` and after `IG_ALLOW_DESTRUCTIVE` have both already said
  yes. Placing it last is what makes the safety property structural: the step can
  only ever turn an allowed write into a refused one. **It can never permit a write
  the env flags blocked**, and it never prompts for a preview — a call that changes
  nothing does not interrupt a human.
- **The prompt.** A single required boolean, plus a server-built statement of the
  tool verb, the account, the target id and whether the action is destructive. The
  schema deliberately carries **no default**, so a client honouring
  `elicitation.form.applyDefaults` cannot answer on the operator's behalf. Any text
  relayed from Instagram (captions, comments) is rendered inside the standard
  untrusted fence (§7) and announced as data, so upstream content cannot forge the
  facts the human is approving. Since 2026-08-30 the finished message — and
  anything the failure path logs — runs through **both** redaction passes, not just
  the active profile's own credentials (§2, CC-PROC-20).
- **Fail closed.** The *only* outcome that permits the write is `accept` carrying an
  explicit `confirm: true`. Decline, cancel, an accept with the box unchecked or
  with no content, a timeout, a transport error, a protocol error, or a broken
  capability probe all refuse. **A failure to reach the human is never read as
  consent.**
- **Fallback.** The prompt is sent only when the connected client advertises *form*
  elicitation. A client without it — or one advertising only `elicitation.url`,
  which cannot render this form — sees exactly the pre-existing env-flag behaviour,
  unchanged. This is a real limitation, not a formality: against such a client
  `apply: true` is still model-controllable, and `IG_WRITE_MODE`/`IG_ALLOW_DESTRUCTIVE`
  are the whole of the protection.
- **Known gaps** (deliberate, not oversights): the server cannot force a client to
  support elicitation, so the fallback cannot be closed from this side; the request
  is a server→client round trip, so over a stateless HTTP transport a client that
  advertises the capability may be unreachable and its writes will be refused rather
  than performed unconfirmed; and consent is **per call** — there is no "remember
  this for the session", because that would recreate standing consent under a
  different name (`IG_WRITE_MODE=apply` already exists for operators who want it).

## 5. Platform-side hardening

- Path B: `appsecret_proof` on every call + **"Require App Secret"** enabled — a
  stolen bare token is useless against the app.
- Standard Access only, single-operator: no third-party data ever transits the
  server; Data Use Checkup surface is minimal.
- `doctor` surfaces token scope drift so overgranted scopes get trimmed;
  `instagram_token_status` surfaces the data-access window (`dataAccessExpiresAt`,
  from `data_access_expires_at`) on Path B. A value outside the range `expires_at`
  is held to (milliseconds, negative, fractional, past year 9999) reads as unknown
  with a warning instead of a far-future date (CC-AUTH-71).

## 6. Supply chain & code integrity

- **Three runtime dependencies** (MCP SDK, zod, dotenv); every addition needs a
  documented justification. `npm audit` in CI and in the `check` script; Dependabot;
  CodeQL; provenance (`npm publish --provenance`) once public.
- No telemetry, no phone-home, no analytics — the server talks to Meta and to its
  MCP client, nothing else.

## 7. Content & policy boundaries

- Official Graph API only; the server never automates the Instagram app/website,
  never stores other users' data beyond the returned API responses, and respects
  the platform's messaging windows (phase-2 design gate).
- `SECURITY.md` with a disclosure contact ships with the first public release.

### Untrusted text on the two result surfaces

Captions, comments, usernames, bios, ids, URLs, cursors, timestamps, insights labels
and every other string Meta returns reach the model through a tool result, which has
two surfaces. They follow one rule (CC-DATA-102, CC-DATA-103):

- **`structuredContent` is data, published as received.** A wire string is not
  escaped, stripped or cut there; the only transformation is the documented
  `[UNTRUSTED …]` fence around free-text fields ([messaging.md](messaging.md) §6),
  plus secret masking. Faithful data is the point: a ZWJ emoji sequence, a
  right-to-left mark in a Hebrew or Arabic caption, a soft hyphen — all legitimate —
  survive, and an id or cursor round-trips byte for byte. A client that hands
  `structuredContent` to a model, rather than the text block, owns its rendering.
- **The text block is the same value rendered with no invisible character raw.**
  It is the JSON of `structuredContent` in which every control (C0 except the line
  feed, DEL, C1), format (bidi override and isolate, zero-width, BOM, soft hyphen,
  Unicode tag characters) and line/paragraph-separator code point is a JSON
  `\uXXXX` escape — one per UTF-16 unit, so a tag character is a surrogate pair.
  `JSON.parse(text)` therefore still equals `structuredContent`, while nothing in
  the text can reorder what a reader sees, hide instructions in characters a human
  reviewer cannot see, or break the line and forge a frame such as
  `Instagram error (auth): …` of its own. `JSON.stringify` alone does not give this:
  it escapes C0 but leaves DEL, C1, every `\p{Cf}` character and U+2028/U+2029 raw.
- **Prose the server writes around a wire value** — a note, a warning, an error
  message — quotes it with visible `\u{…}` escapes and a length cap
  (`core/untrusted.ts` `quoteUntrusted`, `core/errors.ts` `quoteGraphText`).
  An id that Graph *returns* (a created container id, an album child id) gets the
  same treatment unless it matches the Graph id grammar `^[A-Za-z0-9_-]{1,64}$`:
  `core/errors.ts` `quoteGraphId` prints a well-formed id bare and quotes anything
  else with the same 64-character cap, so a wire id cannot break the line
  and forge a publishing acknowledgement (CC-PUB-56).

The text rendering is enforced where secret masking is — the registry's per-call
wrapper, the one route a result takes to a client (`mcp/registry.ts`
`escapeTextBlocks`) — and runs **after** masking, because the token-shape backstop
`\b[a-f0-9]{64}\b` needs the raw separator in front of a token, not its escape. It
applies to every text block, error results included. `test/tools/untrusted-output.test.ts`
drives every tool with a hostile fixture on both surfaces.

The fence and the escaping are mitigations, not a prompt-injection control: visible
text in a caption can still say anything, and the model must treat it as data.
