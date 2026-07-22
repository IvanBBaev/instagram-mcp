# Architecture Review — instagram-mcp design documentation

## 1. Reviewer & scope

Senior software architect review of the complete design documentation set for
`instagram-mcp` (planned npm package `instagram-mcp-ai`), performed **2026-07-21**.
Reviewed: `README.md`, `docs/architecture.md` (primary focus), `docs/auth.md`,
`docs/tools.md`, `docs/security.md`, `docs/operations.md`, `docs/roadmap.md`.
Consulted for calibration: the architectural reference map
(`facebook-mcp/docs/ai/research/servicenow-mcp-architecture.md`), the actual
reference implementation at `~/Development/servicenow-mcp` (read-only inspection of
`src/mcp/registry.ts`, `src/mcp/define.ts`, `src/mcp/write-mode.ts`,
`src/core/config.ts`, `src/core/request-context.ts`, `src/mcp/transport.ts`), and
the ecosystem research (`facebook-mcp/docs/ai/research/mcp-prior-art-ecosystem.md`).
The project is at design phase — documentation only, no code — so this review
evaluates the design's internal consistency, its fidelity to the reference, its fit
for the Instagram Platform's actual constraints, and its readiness to enter the M0
scaffold phase.

## 2. Executive summary

**Verdict: CONDITIONAL GO** for M0. This is an unusually mature design document set
for a pre-code project: the reference architecture is ported faithfully and
critically (not cargo-culted), security is genuinely first-class, and uncertainty
is honestly marked with `[verify]` tags instead of asserted. The conditions attach
to one structural gap and three lifecycle traps that are cheaper to fix on paper
now than in code at M2–M4.

Top 5 points:

1. **(Critical)** The **dual auth-path capability matrix collides with the
   registration model**. Tool registration is static (startup-time, per process),
   auth path is per-profile, and profile selection is per-request via
   `AsyncLocalStorage`. Tools that exist on only one path (`discovery` package,
   `instagram_list_linked_accounts`) make the tool surface a function of a
   request-time variable. The roadmap defers the capability matrix to M4, but the
   registry and `ToolSpec` shape it must live in are built in M1. Resolve the model
   before M1, not at M4.
2. **(High)** **Path-A auto-refresh contradicts env-first config precedence.** The
   README quickstart puts `IG_ACCESS_TOKEN` in the MCP client's `env` block, and
   `dotenv { override: false }` makes process env always win — so a refreshed token
   persisted to the XDG file is silently shadowed by the stale env token on next
   boot. This is a guaranteed day-60 breakage for the documented default setup.
3. **(High)** **Composite publishing tools poll for up to 5 minutes inside one MCP
   tool call**, which exceeds many clients' tool-call timeouts; a client-side
   timeout followed by a model retry can double-publish and burn the 100/24 h
   quota. No idempotency defense is specified.
4. **(High)** **Host/path duality will leak into the `api/` layer** unless the
   host-resolution rule and a per-endpoint parity table are specified. Today the
   docs say "host depends on auth path" without saying who decides it, and both
   hosts' field/versioning parity is `[verify]`.
5. **(Medium)** **The error taxonomy contradicts itself across documents** (single
   `InstagramError` in architecture.md §7 vs. five subclasses in operations.md §3),
   and the SDK v2/spec-2026-07-28 timing (GA expected in ~7 days) deserves an
   explicit decision gate at M5 rather than an open-ended "when GA settles".

## 3. Strengths

- **Faithful, critical adaptation of a proven reference.** The four-layer
  lint-enforced architecture (`core ← api ← mcp ← tools`), tools-as-data with a
  central `PACKAGES` manifest, `.strict()` zod schemas, manifest snapshot testing,
  plan-and-apply write gating, and the stderr-only JSON logging discipline are all
  ported from a production server where they demonstrably work (67 tools, 94 %+
  line coverage). Crucially, the adaptation is *selective*: the reference's own
  cautions were absorbed (clean `IG_` prefix from day one instead of the
  "historical" `SN_` sprawl; no `SN_ALLOWED_HOSTS`-style allowlist widening in v1;
  the Graph-specific swaps in §8 of the reference map are all reflected).
- **Security as a design input, not a hardening pass.** The threat model in
  security.md §1 is derived directly from the prior-art failure catalog (token in
  OAuth callback URL, SSRF in media upload, 0/100 audit scores) and each documented
  failure class has a named countermeasure: redaction before serialization, query
  strings never logged, loopback-bound login callback with checked `state`,
  `appsecret_proof` + "Require App Secret", plan-and-apply plus a destructive
  double-gate. This is exactly the differentiation the ecosystem research says the
  niche rewards.
- **Honest uncertainty management.** The `[verify]` convention (scope names, Path-A
  capability gaps, media specs, error subcodes, insights windows) with each item
  mapped to the roadmap phase where it blocks is a professional pattern that most
  design docs lack. The design never asserts something the 2026-07 Meta docs don't
  clearly support.
- **Platform reality is absorbed, not abstracted away.** The two-phase container
  publish flow, URL-based ingestion (with the local-file constraint documented
  honestly rather than papered over with a tunnel hack), the 100/24 h publishing
  quota as a *safety rail*, the 30-unique-hashtags/7-days budget with a local
  counter, the post-2025-01-08 `views`-based metric set, and the retry matrix that
  exploits Graph's reject-before-processing behavior on 429s — all show real API
  literacy. "Never follow `paging.next` blindly — rebuild from cursors so the host
  allowlist and version pin stay authoritative" (operations.md §4) is a genuinely
  good rule the reference did not need and this platform does.
- **Deliberate scope discipline.** ~25 tools across 6 packages, composites justified
  by a concrete failure mode (models getting the multi-step container protocol
  wrong) while primitives stay exposed; ads, unofficial APIs, personal accounts and
  multi-tenant hosting are crisply excluded; messaging is deferred behind its own
  design review. The tool-count budget framing ("every tool earns its
  context-window cost") is the right mindset.
- **Forward-compatible spec posture.** Targeting `2025-11-25` features
  (annotations, `outputSchema`/`structuredContent`) while explicitly refusing to
  build on Sampling/Roots/Logging (deprecated in `2026-07-28`) is exactly right,
  and notably *better* than the reference, which still declares
  `capabilities: { logging: {} }` and mirrors logs to the client.

## 4. Findings

### F-1 (Critical) — Auth-path capability differences vs. static tool registration
**Affected**: architecture.md §3/§6, auth.md §1, tools.md (`discovery` package,
`instagram_list_linked_accounts`), roadmap.md M4.

Three design decisions are individually sound but mutually inconsistent:

1. Tools are registered once at startup from the `PACKAGES` manifest
   (architecture.md §3), following the reference's `registerAllTools()`.
2. The auth path (`ig-login` vs `fb-login`) is a property of credentials —
   "selected by which env vars are present (`getAuthMode()`)" (auth.md §1) — and
   credentials are per-*profile* (architecture.md §6).
3. The profile is chosen per-*request* via the auto-injected `account` argument and
   `AsyncLocalStorage`.

Consequence: with two profiles on different paths (explicitly supported — the
path-selection table in auth.md §1 anticipates users on either), the correct tool
surface differs *per request*, but MCP tool registration is per session. The design
acknowledges the problem exists ("availability depends on auth path", tools.md;
"Path B only", `instagram_list_linked_accounts`) but defers the resolution to M4
("auth-path capability matrix finalized … and enforced in the registry",
roadmap.md), while the registry, `ToolSpec` interface, and tool schemas — the
artifacts the matrix must be expressed in — are all built in M1. If the matrix
arrives at M4 as an afterthought, `ToolSpec`, the manifest invariants, the snapshot
fixture, and possibly every tool's description get reworked mid-project.

**Recommendation**: Decide the model now, in architecture.md, before M0:

- Add a capability field to `ToolSpec` (e.g. `paths: ("ig-login" | "fb-login")[]`,
  default both), assert it in the manifest invariant loop, include it in the
  snapshot and in generated docs from M1.
- Registration policy: register the **union** of tools available to any configured
  profile; enforce at **call time** in `runSpec()` — a Path-A request hitting a
  Path-B-only tool returns a `PermissionError` that names the path and the fix
  ("this tool requires the Facebook-Login path; profile 'x' uses Instagram Login").
  Never let it surface as a raw Graph 400.
- Strongly consider a **v1 simplification: all profiles in one server process must
  share one auth path** (validated at startup). This collapses the matrix to a
  startup-time registration filter — exactly the reference's model — and can be
  relaxed later. Given the README's own positioning ("single operator, one or few
  accounts"), this costs almost nothing.

### F-2 (High) — Path-A auto-refresh is defeated by env-first precedence
**Affected**: architecture.md §6, auth.md §3, README.md quickstart, security.md §2.

`core/config.ts` is specified as env-first: `dotenv { override: false }`, "env
passed by the MCP client always wins over the env file". The README quickstart —
the documented happy path — passes `IG_ACCESS_TOKEN` in the MCP client's `env`
block. Meanwhile auth.md §3 specifies transparent auto-refresh of the Path-A
long-lived token, with runtime writes going "to the XDG path". These three facts
compose into a trap: the server refreshes the token, persists the new one to the
XDG env file, and on every subsequent boot the *old* token from the client config
shadows it. Day 60: hard failure, and `doctor` output will be confusing because
the XDG file holds a perfectly valid token. The MCPB keychain path (`user_config`
→ env) has the same property. The reference never hit this because ServiceNow
basic-auth passwords don't rotate themselves; Path-A tokens do. Note also that the
reference's refreshed-credential flow updates `process.env` *and* the file
together (`saveCredentials`), which only works because nothing re-injects a stale
value at next boot — here the MCP client does, every time.

**Recommendation**: Specify the interaction explicitly in architecture.md §6 and
auth.md §3: (a) for Path A, the *recommended* token home is the XDG file/keychain
populated by `login`, not client-config env — change the README quickstart for
Path A accordingly (env-token quickstart stays fine for Path B system-user tokens,
which never expire); (b) when the active token *did* come from process env, either
disable silent auto-refresh and have `token_status`/`doctor` warn loudly
("token is env-pinned; refresh cannot persist; expires in N days"), or document
that the freshest of (env, XDG) wins for Path A tokens by comparing persisted
metadata. Either rule is fine; an unspecified rule is not.

### F-3 (High) — Composite tools: unbounded call duration, no idempotency defense
**Affected**: tools.md (`publishing` package, composites), operations.md §2.

`instagram_post_image` / `post_reel` / `post_story` run container-create → poll
("with backoff, ≤ 5 min") → publish inside a single tool call. Two problems:

1. **Client timeouts.** Many MCP clients time out tool calls well under 5 minutes.
   A timeout mid-composite leaves a created (possibly `FINISHED`) container with
   the client believing the call failed. The natural model behavior — retry the
   composite — creates a *second* container and, if the first publish actually
   landed before the timeout, a duplicate post. Each duplicate burns the 100/24 h
   quota the design elsewhere treats as precious.
2. **No dedup.** The write journal exists (tools.md, "applied writes append to a
   local write journal") but nothing specifies consulting it. The retry matrix
   correctly refuses to retry a failed `media_publish` and surfaces the container
   ID for resume (operations.md §2) — good — but that only covers *server-side*
   failures, not client-side timeout + model-initiated re-invocation.

**Recommendation**: (a) Cap the *composite's* in-call poll at a modest budget
(e.g. 45–60 s); on expiry return a **structured "in progress" result** carrying the
container ID and instruct the model to continue with
`instagram_get_container_status` + `instagram_publish_media` (the primitives exist
precisely for this). (b) Before an applied composite publish, check the journal for
a recent (e.g. < 10 min) applied publish with identical container-or-content
fingerprint and refuse with a pointer to the journal entry unless a `force`-style
argument is passed. (c) Document in each composite's description that it may hand
back a resumable state — models handle this well when told. Do not reach for MCP
"tasks" (experimental in 2025-11-25, an extension in 2026-07-28) for v1 — the
resumable-primitives design is the right, spec-stable answer.

### F-4 (High) — Dual-host resolution is under-specified and will leak into `api/`
**Affected**: architecture.md §5, auth.md §1, tools.md (header note), operations.md §5.

`igRequest` takes `host?`, the auth provider knows the path, and tools.md says
"host depends on auth path" — but no document states *who decides the host for a
given call*. If `api/` functions pass hosts explicitly, every domain function
branches on auth mode and the dual-path abstraction has leaked into Layer 1 — the
exact failure the layered design exists to prevent. There are also known and
suspected asymmetries: `appsecret_proof` only on `graph.facebook.com`;
`/v25.0/` path-segment support on `graph.instagram.com` is `[verify]`; Path-A
availability of `business_discovery`/hashtag search is `[verify]`; and endpoints
like `/me/accounts` exist only on Path B. Left unspecified, this becomes ad-hoc
per-function `if (mode === ...)` code by M2.

**Recommendation**: Specify in architecture.md §5: *the default host is derived
from the active profile's auth mode inside `core/http.ts`* (via the auth
provider); `api/` functions never name a host except for the rare
endpoint that is inherently single-host (e.g. `list_linked_accounts` →
`graph.facebook.com`), which should be expressed declaratively (the same
`paths`/host capability metadata as F-1, checked before the call). Add a
per-endpoint **parity table** (endpoint × path A/B × notes) to auth.md as `[verify]`
items get resolved in M1/M4 — it doubles as the capability matrix source of truth.
Extend the testing strategy (architecture.md §10) with an explicit dual-mode
matrix: a `withAuthMode(mode, fn)` helper so every `api/` function is exercised
under both providers, asserting host, version pin, and `appsecret_proof`
presence/absence.

### F-5 (Medium) — Error taxonomy: internal contradiction between documents
**Affected**: architecture.md §7 vs. operations.md §3.

architecture.md: "Errors map to a **single** `InstagramError(message, status?,
fbtraceId?, code?, subcode?)`". operations.md maps codes to **five classes**
(`AuthError`, `PermissionError`, `RateLimitError`, `ValidationError`,
`UpstreamError`). These are different designs with different consequences for
`fail()` mapping, retry-matrix dispatch, and what the model sees. The reference
uses a single class (`ServiceNowError`) with preserved detail, which has proven
sufficient.

**Recommendation**: Reconcile now; prefer the reference's shape — one
`InstagramError` carrying a `kind: "auth" | "permission" | "rate_limit" |
"validation" | "upstream"` discriminant plus the preserved Graph fields
(`code`, `error_subcode`, `fbtrace_id`, `error_user_msg`). Update operations.md §3
to present the table as *kind mapping*, not class hierarchy. A class hierarchy
adds `instanceof` coupling across layers for zero expressive gain here.

### F-6 (Medium) — Carousel child-container flow is unspecified
**Affected**: tools.md (`publishing` package).

`instagram_create_media_container` documents `children` ("carousel: 2–10 container
IDs") and `instagram_post_image` claims to handle "a single image/carousel in one
call", but nowhere is the *child* container creation specified: carousel children
are separate `POST /{ig-id}/media` calls with `is_carousel_item=true` (no caption),
then the `CAROUSEL` parent references them, then one publish. That is up to 12 API
calls, distinct validation rules for children vs. parent, and partial-failure
states the composite must handle (2 of 5 children created, then failure). The
quota note ("carousel = 1") is correct for the publish but the call-count and
container-expiry (24 h) interactions are not addressed.

**Recommendation**: In tools.md, either add `is_carousel_item` to the container
primitive's documented inputs and specify the child→parent→publish sequence in the
composite's plan preview, or restrict v1 composites to single-image and make
carousels a documented primitive-only flow. Decide before M2; the plan-preview
format for a carousel (showing N child creations) needs design either way.

### F-7 (Medium) — Truncation loop vs. `outputSchema` conformance
**Affected**: architecture.md §7/§10, tools.md "Structured output", operations.md §4.

The character-budget halving loop truncates serialized results; several tools also
declare `outputSchema` and return `structuredContent`. The interaction is
unspecified: truncating `structuredContent` can produce output that violates the
declared schema (SDK-side validation may then fail the call), and truncating only
the text half desynchronizes the two representations. The reference sidesteps this
mostly because its structured outputs are small; the insights tools here can be
large (per-day breakdowns over 30-day windows × metrics).

**Recommendation**: Specify the rule in architecture.md §7: the truncation loop
operates on `items`-style arrays *before* serialization (drop tail items, set
`truncated: true` — which the declared `{ items, paging: { truncated } }` shape
already accommodates), never on an already-serialized structured payload; if a
structured result cannot fit even so, drop `structuredContent` and return text
with an explicit truncation notice. Add this exact property to the `fast-check`
suite ("truncated structured output always validates against its schema").

### F-8 (Medium) — Per-profile state is not scoped in the design
**Affected**: architecture.md §5 (rate budget), operations.md §1 (hashtag counter),
tools.md (`token_status`).

Rate-limit budgets (`X-App-Usage` / `X-Business-Use-Case-Usage`) are scoped by Meta
to app+account pairs; the hashtag budget is per IG account; token metadata is per
token. The design describes all three as singletons ("cache last snapshot", "local
persistent counter"). With multi-profile support in v1, unkeyed state gives wrong
answers: profile B's `token_status` showing profile A's usage snapshot, or one
account's hashtag budget throttling another's.

**Recommendation**: One sentence per mechanism in the respective docs: budget
snapshots, hashtag counters, and token metadata are keyed by profile (and host
where relevant); `token_status` reports the *active request profile's* state.
Cheap now, annoying to retrofit.

### F-9 (Medium) — Missed reference pattern: immutable credential snapshot store
**Affected**: architecture.md §6, auth.md §3.

The reference's `core/config.ts` keeps an in-memory, immutable per-profile
credential snapshot, swapped in a single assignment, precisely so a mid-request
credential change can't produce a torn read. The instagram design *introduces* the
scenario that pattern guards against — Path-A auto-refresh rewrites the token at
runtime ("at first use of a session"), potentially while other requests are in
flight under the concurrency semaphore — but does not port the pattern; config.ts
§6 mentions only file-write atomicity, which is a different property.

**Recommendation**: Port the snapshot-swap store explicitly (architecture.md §6):
credential reads return an immutable snapshot; refresh builds a new snapshot and
swaps it atomically; in-flight requests finish on the old token (valid — Meta
refresh does not invalidate the prior token immediately). Also decide and document
whether a 190 on a Path-A call triggers exactly one transparent refresh-and-retry
(the reference's "one forced re-auth on 401" analog) or always surfaces the
actionable error; either is defensible.

### F-10 (Medium) — Annotation defaults are load-bearing and unstated
**Affected**: tools.md (legend and all package tables).

The catalog marks RO/D/I explicitly but leaves most write tools unmarked ("—").
Under the MCP spec, *absent* `destructiveHint` defaults to **true** for
non-read-only tools — so `instagram_create_media_container`, `publish_media`,
`reply_to_comment` etc. will be treated as destructive by well-behaved clients
unless `destructiveHint: false` is set explicitly. That may be intended
(conservative) or not (extra confirmation friction on every additive write), but
the design should choose knowingly. The reference snapshots the *full* annotation
set per tool for exactly this reason.

**Recommendation**: State the policy in tools.md: every spec sets all four hints
explicitly (no reliance on spec defaults); additive writes (`create_comment`,
`reply_to_comment`, container/publish) get `destructiveHint: false`,
reversible moderation (`hide`/`unhide`, `set_comments_enabled`)
`destructiveHint: false, idempotentHint: true`, `delete_comment`
`destructiveHint: true`. Snapshot the full annotation object per tool (as the
reference does) so changes are diff-reviewed.

### F-11 (Medium) — SDK v2 / spec-2026-07-28 timing lacks a decision gate
**Affected**: README.md (identity table), architecture.md §1/§8, roadmap.md "Later".

The v1-now/codemod-later choice is right (v2 is `2.0.0-beta.5` as of 2026-07-21;
GA expected around the spec finalization on **2026-07-28 — seven days from this
review**). But the roadmap's "once GA settles" is open-ended, and two concrete
couplings deserve pinning: (a) zod v3 vs. v4 — the codemod migrates SDK API calls,
not zod idioms; v2 uses Standard Schema with zod v4, so the zod major bump is a
*separate* migration the docs don't mention; (b) "designed stateless-friendly"
(architecture.md §8) has no concrete mechanism named — the v1
`StreamableHTTPServerTransport` is sessionful by default (the reference passes
`sessionIdGenerator: () => randomUUID()`), and v1's stateless mode
(`sessionIdGenerator: undefined`) is an explicit configuration choice.

**Recommendation**: (a) Add a hard re-evaluation gate at the **M5 boundary**
(before first npm publish): if v2 has been GA ≥ ~6–8 weeks with a stable minor,
migrate before publishing; otherwise publish on v1 and schedule the migration as
an internal minor. (b) Pin the exact v1 minor at M0 (roadmap already says so) and
keep *all* SDK imports confined to `mcp/` (the layering already implies this —
state it as a rule, it is the property that makes the codemod cheap). (c) In
architecture.md §8, name the concrete stateless mechanism
(`sessionIdGenerator: undefined`) so the intent survives contact with the SDK. (d)
Note the zod v3→v4 bump as its own roadmap line item coupled to the v2 migration.

### F-12 (Low) — `rupload.facebook.com` in the v1 SSRF allowlist is dead surface
**Affected**: architecture.md §5, security.md §3 vs. tools.md (design note).

tools.md is explicit that v1 ingestion is URL-based and "the server never uploads
local bytes"; Reels take `video_url`. Nothing in the v1 tool catalog calls
`rupload.facebook.com`, yet both the architecture and security docs allowlist it.
Every allowlisted host is SSRF surface; the design's own principle is minimalism.

**Recommendation**: Drop `rupload.facebook.com` from the v1 allowlist; add it in
the phase that introduces resumable/local video upload, alongside its own tests.

### F-13 (Low) — M1 "read-only media package" depends on registry gating semantics
**Affected**: roadmap.md M1, architecture.md §3, tools.md (`media`).

`media` contains a write tool (`instagram_set_comments_enabled`), but M1 ships
"packages `account` + `media` (read-only)" while the write gate
(`mcp/write-mode.ts`) arrives in M2. This is coherent *only if* the registry's
read-only filtering (`IG_PACKAGES_READONLY`, skipping non-RO specs at
registration, as the reference does) exists in M1 — or if the write tool is simply
not authored until M2/M3.

**Recommendation**: One clarifying line in roadmap.md M1: either "registry
read-only filtering ships in M1; `set_comments_enabled` is authored in M3 with the
comments work" or "the M1 media package contains only the RO tools". Avoid
shipping any write tool before `write-mode.ts` exists.

### F-14 (Low) — Auto-injected `account` argument: collision rule and semantics
**Affected**: architecture.md §6, tools.md (legend).

The reference auto-injects `instance` and skips tools whose schema already uses
that name (`hasAutoInstanceParam`); the instagram docs specify the injection but
not the collision rule. Also, `account` is semantically overloaded here: models
may pass an IG user ID or @handle rather than a profile name (the package is
literally called `account`, and `instagram_get_account` exists).

**Recommendation**: Document the skip rule; validate the argument against
`listProfiles()` with an error that enumerates valid profile names (the reference's
exact pattern). Consider naming the argument `profile` to avoid the collision with
IG-account semantics — decide before M1 since it appears in every tool schema and
therefore in the snapshot.

### F-15 (Low) — `login` CLI: OAuth redirect-URI constraints not in open questions
**Affected**: auth.md §5, security.md §2, roadmap M2.

The `login` flow binds a loopback callback. Meta's OAuth clients have historically
constrained redirect URIs (HTTPS-only outside dev-mode contexts; localhost
exceptions differ between Facebook Login and Business Login for Instagram). If
`http://localhost:<port>/callback` is not accepted for the app type/mode used,
the M2 `login` design changes shape (manual copy-paste code flow instead of
loopback callback). This belongs on the `[verify]` list and is absent.

**Recommendation**: Add to auth.md §5: "loopback `http://localhost` redirect URI
acceptance for both login products **[verify]** — fallback design: manual
code-paste flow". Verify in M1 (cheap to check in the app dashboard) even though
it blocks only M2.

### F-16 (Low) — `get_container_status` conflates a single GET with a 5-minute poll
**Affected**: tools.md (`publishing` table).

The row describes a RO status read but embeds "poll with backoff, ≤ 5 min" —
polling is composite behavior, not primitive behavior. As written, an implementer
could make the *primitive* block for minutes, which breaks its RO/I cheap-read
contract and the model's ability to do its own polling loop.

**Recommendation**: The primitive is a single GET, always fast. Move the polling
guidance to the composites (with the F-3 in-call budget) and to the tool
*description* as advice to the model ("re-check every N seconds; video may take
minutes").

### F-17 (Low) — Windows leg vs. POSIX-only assumptions
**Affected**: architecture.md §6/§11, security.md §2.

CI includes a Windows leg, but the config design assumes `chmod 0600` and XDG
paths (`~/.config`, `~/.local/state`) — POSIX semantics that are no-ops or wrong
on Windows. The reference has the same tension; inheriting it knowingly is fine,
silently is not.

**Recommendation**: One line in architecture.md §6: Windows resolution
(`%APPDATA%`-based path or documented "XDG-style path under the user profile";
`0600` best-effort, skipped on win32) — and make the Windows CI leg assert the
launcher + stdio handshake rather than file-permission behavior.

### F-18 (Low) — Resources and prompts: silent omission vs. the reference
**Affected**: architecture.md (whole), vs. reference `registerResources` /
`registerPrompts` and per-package `resources` in `PackageSpec`.

The reference registers MCP resources (package-scoped) and prompts alongside
tools; the instagram design never mentions either. Omitting them for v1 is a
defensible YAGNI call — but it should be *stated*, and `PackageSpec` should keep
the optional `resources?` slot so adding, e.g., a cached account-profile resource
or a "publish checklist" prompt later doesn't disturb the manifest shape.

**Recommendation**: Add a sentence to architecture.md §3: "Resources and prompts
are deliberately out of scope for v1; `PackageSpec` reserves the extension point."

### F-19 (Low) — Diagnostics surface can be configured away
**Affected**: architecture.md §3/§4, tools.md (`account`), operations.md §6.

The reference keeps an always-on `admin` package outside the profile/deny
mechanism, guaranteeing a status/diagnostics surface exists in every
configuration. Here, `instagram_token_status` and the debug/telemetry tool live in
the `account` package, which `IG_PACKAGES_DENY` can remove — leaving a server with
no in-band way to report token expiry or rate-budget state.

**Recommendation**: Either exempt a minimal status tool from deny (reference
pattern), or document that denying `account` forfeits in-band diagnostics and
`doctor` becomes the only window. The former is one `if` in the registry and worth
it.

## 5. Architecture-specific deep dives

### 5.1 The dual auth-path abstraction

The decision to support both paths is *strategically* right — Path A serves the
"no Facebook presence" user the README targets, Path B serves the
facebook-mcp-adjacent user with never-expiring system-user tokens — and the
`AuthProvider` seam inherited from the reference is the correct place to hide
token injection and `appsecret_proof`. What the documents underestimate is that on
this platform the two paths differ in more than headers: **host, URL versioning
(`[verify]`), endpoint availability, scope vocabulary, token lifecycle, and
introspection support all vary**. The reference's auth modes
(basic/oauth/apikey/token) were five ways to authenticate against *one* API; here
there are two *APIs* that happen to serve one account. That is why F-1/F-2/F-4
cluster here: capability filtering, refresh persistence, and host resolution are
all consequences of the same underlying fact, and all three need their rules
written down before M1 code fixes them accidentally. The v1
one-path-per-process constraint proposed in F-1 is the single highest-leverage
simplification available: it turns a request-time capability problem back into
the startup-time problem the reference already solved, without closing the door
on per-profile paths later.

### 5.2 Registry and capability matrix

The registry design (manifest as single source of truth; invariant loop; snapshot
test; README generation) is the reference's best idea and is ported intact —
verified against the actual `src/mcp/registry.ts`, the port is faithful including
`.strict()` schemas and the auto-injected profile parameter. The gap is that the
manifest currently encodes exactly one dimension (package membership) plus one
filter (read-only), while this domain has a second dimension (auth path). The fix
is small *if done now*: capability metadata on `ToolSpec`, surfaced in
`describeAllTools()` and the snapshot fixture, enforced in `runSpec()`. Done at
M4, it invalidates the M1 snapshot fixture, the generated README tool table, and
any client configurations users have built. Roadmap M4's "enforced in the
registry" should be re-scoped to "capability matrix *data* verified" — the
*mechanism* belongs in M1.

### 5.3 Composite tools vs. primitives

Exposing both is the right call and well-argued (tools.md's "the container flow is
a multi-step protocol the model otherwise gets wrong" matches the prior-art
complaint record). The design also gets partial-failure recovery right at the
operations level (error carries the container ID; no container re-creation on
publish failure). The weak point is *duration and re-entry* (F-3): a composite
that can run 5 minutes is effectively a long-running job smuggled into a
request/response protocol. The resumable-result design — composite returns
structured "in progress + container ID + next step" when its in-call budget
expires — keeps composites useful for the 90 % case (images publish in seconds)
while making the video case robust, and it composes with the plan-and-apply gate
naturally (the preview already describes the multi-step plan; the in-progress
result is the same plan with a cursor). The journal-based duplicate check closes
the remaining client-retry hole. None of this requires new tools or spec features.

### 5.4 SDK and spec timing

The v1-stable choice is correct today, and the design's spec posture (target
2025-11-25 features; avoid the 2026-07-28 deprecations; stateless-friendly HTTP)
is more forward-compatible than the reference implementation it copies. The
residual risks are concrete rather than existential: the zod v3→v4 major hiding
behind the "codemod" framing (F-11a); the unstated stateless mechanism (F-11c);
and schedule coupling — M0 starts within days of the spec finalizing and the v2
GA window. Because M0–M1 work is dominated by `core/` and `api/` (SDK-free by
construction), the timing risk to the roadmap is genuinely low *provided* the
SDK-only-in-`mcp/` rule is enforced by the same `no-restricted-imports` machinery
as the layer boundaries. The one date that matters is first npm publish (M5):
migrating before any user exists is free; after, it is merely internal churn — so
the M5 gate proposed in F-11 is a cheap insurance policy, not a blocker.

## 6. Recommendations summary (prioritized)

1. **Before M0 sign-off (blocking conditions):**
   1. Resolve F-1: capability model in `ToolSpec` + call-time enforcement; adopt
      the one-auth-path-per-process constraint for v1 (or explicitly reject it
      with the per-request design fully specified). Re-scope roadmap M4
      accordingly.
   2. Resolve F-2: specify token-source precedence vs. auto-refresh; fix the
      README Path-A quickstart guidance.
   3. Resolve F-5: one error class with a `kind` discriminant; align
      architecture.md §7 and operations.md §3.
   4. Resolve F-3 at design level: composite in-call poll budget + resumable
      in-progress result + journal dedup rule.
2. **Before M1 exit:** F-4 (host-resolution rule + parity table + `withAuthMode`
   test matrix), F-8 (per-profile state keying), F-9 (credential snapshot store),
   F-14 (`account`/`profile` argument name + collision rule), F-19 (always-on
   status surface), F-13 (M1 read-only wording).
3. **Before M2 exit:** F-6 (carousel child-container flow), F-15 (redirect-URI
   verification), F-16 (primitive vs. composite polling split).
4. **Before M4/M5:** F-7 (truncation × outputSchema property test), F-10 (explicit
   annotation policy + full-annotation snapshot), F-11 (SDK v2 gate at M5; zod v4
   as its own line item), F-12 (drop `rupload` from allowlist until needed), F-17
   (Windows config semantics), F-18 (state the resources/prompts non-goal).

## 7. Verdict

**CONDITIONAL GO** for proceeding to M0 scaffold.

The design is fundamentally sound: it adapts a proven production architecture with
judgment rather than imitation, treats the platform's real constraints and the
ecosystem's documented failure modes as first-class inputs, and phases delivery so
that safety machinery precedes the features that need it. No finding invalidates
the layered architecture, the tools-as-data model, the transport design, the
pagination/truncation strategy, or the roadmap's overall shape.

**Conditions (must be reflected in the docs before M1 implementation begins; items
1–2 before M0 sign-off):**

1. The auth-path capability model is decided and documented (F-1), including the
   accept-or-reject decision on the one-path-per-process v1 constraint, with
   roadmap M4 re-scoped.
2. The Path-A token refresh vs. env-precedence rule is specified and the README
   quickstart amended (F-2).
3. The error taxonomy contradiction is reconciled (F-5).
4. The composite duration/idempotency design (poll budget, resumable result,
   journal dedup) is specified (F-3).
5. The host-resolution rule and dual-mode test matrix are added to
   architecture.md before M1 exit (F-4).

With these addressed, the project should proceed; the remaining Medium/Low
findings can be absorbed in their listed phases without schedule impact.
