# QA Review — Testability & Quality Strategy

## 1. Reviewer & scope

- **Role**: Senior QA engineer — testability and quality-strategy review.
- **Date**: 2026-07-21.
- **Scope**: The full design-documentation set of `instagram-mcp` (README.md,
  docs/architecture.md — §10 as primary focus, docs/tools.md, docs/operations.md,
  docs/auth.md, docs/security.md, docs/roadmap.md). No code exists; this review
  judges whether the *planned* testing strategy is adequate for the Instagram
  Graph API domain and whether the roadmap's exit criteria are objectively
  verifiable.
- **Reference baseline**: §4 of `facebook-mcp/docs/ai/research/servicenow-mcp-architecture.md`
  and the live test suite of `servicenow-mcp` (helpers: `withEnv`, `withFetch`,
  `jsonResponse`; manifest snapshot; readme/env-docs sync; write-mode; http-retry;
  property tests). The review assumes that pattern is the floor being replicated.
- **Out of scope**: security posture per se (separate review), product/market fit,
  Meta policy compliance beyond its testability implications.

## 2. Executive summary

**Verdict: CONDITIONAL GO** (conditions in §7).

The strategy in architecture.md §10 replicates a proven, genuinely good pattern:
recording fetch mock, request+behavior assertions, manifest snapshot, docs-sync
tests, property tests, coverage ratchet. For the parts of this server that look
like the ServiceNow reference (HTTP client, registry, write gate, pagination),
the plan is adequate and the reference suite shows it works in practice.

What §10 does **not** yet cover is precisely what makes Instagram *different*
from ServiceNow, and those are the highest-risk areas:

1. **No time-control strategy.** Polling "with backoff, ≤ 5 min", token-age
   rules (≥ 24 h before refresh, auto-refresh after 45 days), a "< 10 days left"
   expiry warning, and a 7-day rolling hashtag budget are all clock-driven.
   Without an injectable clock / `node:test` mock timers named in the strategy,
   the core publish loop is untestable as specified. (Finding F1, Critical)
2. **The container state machine has no test plan.** IN_PROGRESS → FINISHED →
   PUBLISHED plus ERROR / EXPIRED / timeout / resume-with-container-ID is the
   heart of the product and its most failure-prone protocol; §10 never mentions
   it. (F2, High)
3. **The live-verification gap is unmanaged.** Meta has no IG-publishing
   sandbox, M2's exit criterion is "a real image post + reel", and — crucially —
   **the Instagram API cannot delete published media**, so test posts are
   permanent until removed by hand. No test-account, cleanup, or quota-burn plan
   exists. (F3, High)
4. **A latent double-post assumption.** "429 is rejected pre-processing → safe
   to replay POST" is stated as fact but is a [verify]-class claim; if it is ever
   wrong for `media_publish`, the retry logic itself causes duplicate posts.
   (F4, High)
5. **Spec contradictions that block testability**: preview mode "performs no
   request" vs. previews that must read the publishing quota; "> 90 % slow down"
   with no defined observable behavior. Ambiguous specs cannot be asserted.
   (F5/F7, Medium–High)

None of these invalidate the architecture; all are fixable in the documents
before M0/M1. With the conditions below, the quality strategy is sound.

## 3. Test-strategy assessment (areas a–k)

Proposed test cases are named as real test titles, grouped by the suite they
would live in (see §5 for the suite layout).

### (a) Two-phase publish flow with polling — state machines, EXPIRED/ERROR, quota

**Assessment: the single biggest gap in §10.** The strategy names truncation,
redaction, and cursors, but not the container lifecycle — the domain's core
protocol and the reason the composite tools exist at all ("the model otherwise
gets it wrong", tools.md §Tool-count budget). The `withFetch` scripted-sequence
pattern (respond per `callNo`) from the reference is *exactly* the right
mechanism — it just needs to be pointed at this state machine, plus mock timers
so the ≤ 5 min poll loop runs in milliseconds.

The composites must be tested as small state machines with a scripted Graph on
the other side. Minimum path coverage:

- `post_image happy path: container → status FINISHED → publish, in order, one POST each`
- `post_image: image container that returns FINISHED immediately skips the poll loop`
- `post_reel: polls with backoff while IN_PROGRESS, publishes on FINISHED (mock timers, asserts the backoff schedule)`
- `post_reel: container ERROR surfaces the enriched status detail and never calls media_publish`
- `post_reel: poll timeout at 5 min aborts with the container ID in the error (resumable)`
- `publish_media: container EXPIRED maps to the actionable "re-create container" error`
- `publish_media: unknown/new status_code value fails safe (treated as not-ready, not as FINISHED)` — forward-compat guard for Meta adding states
- `post_image: quota check runs BEFORE container creation; exhausted quota refuses without creating a container` — ordering matters: a container created against an exhausted quota is a wasted, orphaned container
- `post_image preview: reports quota impact and full step plan; performs GETs only, zero POSTs`
- `publish_media: publishing-limit read failing does not silently allow the publish` — behavior (fail-closed vs. warn-and-proceed) must first be *specified*; see F8
- `two concurrent composites racing one remaining quota slot: exactly one publishes` — concurrency + semaphore interaction
- `carousel: child container in ERROR aborts before the parent container is created`
- `carousel: 1 child and 11 children rejected by zod before any network call`

The convenience composites and the primitives share the state machine — test the
machine once at the `api/publishing.ts` level with exhaustive transitions, then
the composites for orchestration/preview/journal behavior only.

### (b) Retry matrix — incl. no-retry-on-POST and resume-with-container-ID

**Assessment: well specified in operations.md §2, and the reference
`http-retry.test.js` proves the pattern is testable — but §10 doesn't mention
the retry suite, and two Instagram-specific wrinkles are missing.**

Wrinkle 1: Graph often signals throttling with **HTTP 400 + error code 4/17/32/613**,
not only HTTP 429. Retry classification must key on the parsed error envelope,
not just the status line — the matrix table implies this but no test enforces it.

Wrinkle 2: the resume path. Operations.md promises "the error carries the
container ID so the operator/model can resume" — that is a contract worth
pinning hard, because it is the only thing standing between a transient publish
failure and a re-created (duplicate) container.

Proposed:

- `429 on GET and on POST is retried with backoff (Graph rejects pre-processing)`
- `HTTP 400 with error code 4 (app throttled) is classified retryable; 400 with code 100 is not`
- `5xx/transport error on GET retried; on POST surfaces immediately with call count 1`
- `media_publish 5xx: error carries the container ID; a follow-up publish_media with that ID succeeds without re-creating the container`
- `media_publish retry exhaustion: the write journal records the orphaned container ID` (journal is the audit trail — a maybe-published container must be findable later)
- `publishing an already-published container maps to a distinct "already published" error, not a retry` — this is the natural idempotency check for blind resumes; the exact Graph error must be captured live first (see area i)
- `190 never retried; error text names the CLI remediation (login/refresh)`
- `10/200-series never retried; error names the missing scope`
- `Retry-After of 3600 s is capped at 60 s` / `unparseable Retry-After falls back to backoff and still retries`
- `backoff delays follow min(500·2^n, 8000) + jitter, n ≤ 3 (mock timers, jitter bounds asserted)`
- `per-host semaphore caps concurrent requests at IG_MAX_CONCURRENT` (port of the reference test)

The doc's claim that 429 replay is safe on POST is carried as **F4** — it must
be validated live once and encoded as a contract fixture, because the failure
mode of being wrong is a duplicate public post.

### (c) Rate-limit header parsing and throttle behavior

**Assessment: parsing is specified ("parse on every response"), throttling is
not testable as written.** `X-App-Usage` and `X-Business-Use-Case-Usage` are
JSON-in-a-header with different shapes (the BUC header is keyed by business ID
and carries `estimated_time_to_regain_access`); "proactively slow down > 90 %"
names no observable behavior — no delay function, no error, nothing an assertion
can grab. Specify the mechanism first (F7), then:

- `X-App-Usage JSON is parsed and the snapshot exposed via instagram_token_status`
- `X-Business-Use-Case-Usage (keyed by business id, array values) is parsed; highest usage wins`
- `both headers present: the more constrained value drives throttling`
- `malformed/absent usage header: call succeeds, last-good snapshot retained, no crash`
- `header lookup is case-insensitive`
- `usage > 90 %: the defined slowdown (e.g. injected inter-call delay) is observable under mock timers`
- `usage ≥ 100 %: write calls refused with the "resets within the hour" message; reads still pass`
- `estimated_time_to_regain_access feeds the RateLimitError reset hint`

### (d) Both auth paths — exchange/refresh, expiry warnings, appsecret_proof

**Assessment: auth.md is detailed and §10 explicitly names the
`appsecret_proof` assertion — good — but the flows are clock-dependent and the
strongest available test (a whole-surface invariant) is not named.**

The `appsecret_proof` rule is a perfect *invariant test*: iterate every
registered tool under a recording mock, once per auth path:

- `invariant: every graph.facebook.com request carries appsecret_proof; every graph.instagram.com request carries none` (all-tools sweep, both env configurations)
- `appsecret_proof is HMAC-SHA256(access_token, app_secret) — known-answer vector`

Flows:

- `ig_exchange_token: URL, params, and pinned version asserted; expires_in persisted as token metadata; client_secret never logged`
- `refresh_access_token: refused/deferred for a token younger than 24 h`
- `auto-refresh triggers at first use when the token is older than IG_REFRESH_AFTER_DAYS (fake clock)`
- `refresh receiving 190 (revoked) yields the actionable login remediation, no refresh loop`
- `token_status warns at 9 d 23 h remaining and not at 10 d 1 h (boundary, fake clock)`
- `getAuthMode(): Path A env only → ig-login; Path B only → fb-login; BOTH present → defined, documented outcome` — currently unspecified (F9); ambiguity here selects the wrong host and the wrong token
- `Path B account resolution: /me/accounts → page → instagram_business_account chain (multi-call script); a Page with no linked IG account yields an actionable error`
- `Path A doctor falls back to /me when debug_token is unsupported`
- `Path A: discovery tools are absent from the registry (or fail fast without network) when capabilities say so` — the M4 capability matrix must be registry-enforced and snapshot-visible

### (e) Redaction — property tests for token shapes

**Assessment: §10 names redaction property tests; the design (mask configured
values + `EAA…`/`IGQ…` shapes) is right but the shape list will rot** — Meta has
already shifted IG token prefixes over time. Two defenses: property tests for
the shapes you know, plus a *configured-value canary* that is shape-agnostic.

- `property: any JSON with an EAA-/IGQ-shaped token embedded at any depth/position serializes with the token absent` (fast-check: token generator × nesting generator, over results, error messages, and log fields)
- `property: redaction is idempotent (redact(redact(x)) === redact(x))`
- `property: input containing no secrets passes through byte-identical` (metamorphic; guards against over-redaction mangling captions/URLs)
- `canary invariant: the literal configured IG_ACCESS_TOKEN/app secret never appears in any tool result, error, log line, or journal entry across an all-tools mocked sweep` — this catches unknown future token shapes, because it keys on the value, not the shape
- `InstagramError carrying a full Graph URL: query string (access_token=…) is stripped by safeUrl before the message reaches the model`
- `the write journal is redacted with the same rules` — currently unstated (F6): the journal is a serialization sink like any other
- `logFields output is passed through redaction even though it is "documented to never carry secrets"` — defense in depth over convention

### (f) Write safety — preview vs apply, destructive double gate, journal

**Assessment: the gate design is proven (reference `write-mode.test.js` is
504 lines of exactly this), but the spec contradicts itself for this domain.**
Tools.md says a preview "performs no request", while the publish preview
"reports quota impact" — which requires a `content_publishing_limit` GET. The
reference could assert `calls.length === 0`; this server cannot, for publishing.
The rule must be rewritten as: *preview may perform read-only GETs, never
POST/DELETE* (F5). Then:

- `every non-RO tool without apply:true returns mode:"preview" and issues zero POST/DELETE requests` (all-write-tools sweep — the mock throws on any mutating method)
- `create_media_container preview shows endpoint, payload, and quota statement without creating anything`
- `IG_WRITE_MODE=apply grants standing consent; explicit apply:false still previews`
- `IG_PACKAGES_READONLY=publishing: publish refuses even with apply:true, before any network call`
- `delete_comment with apply:true but without IG_ALLOW_DESTRUCTIVE: refused, zero requests`
- `delete_comment with both gates: DELETE issued once, journal entry appended`
- `composite preview shows the full multi-step plan; a single apply:true covers the whole chain (documented consent scope)`
- `journal entries are append-only, timestamped, redacted, and written under a test-overridable state dir (XDG_STATE_HOME)` — the journal path must be injectable or tests will write into the operator's real `~/.local/state` (F10)
- `annotations honesty check: every tool whose handler can issue POST/DELETE lacks readOnlyHint, and vice versa` — registry invariant tying annotations to behavior

### (g) Pagination / truncation invariants

**Assessment: §10 covers this well (property tests named; reference has
`fetchall`/`result` precedent). Add the security-relevant cursor rule and the
insights window math.**

- `property: truncated === true iff the item cap was hit; a capped read is never presented as complete`
- `paging.next pointing at an unlisted host is never fetched; the next request is re-built from cursors against the allowlisted host with the pinned version` — this is the "never follow paging.next blindly" rule from operations.md §4; it is an SSRF test as much as a pagination test
- `fetchAll stops at IG_MAX_ITEMS across pages; after-cursor round-trips verbatim`
- `property: the character-budget halving loop terminates, stays under budget, and always emits valid JSON`
- `insights since/until wider than the API window: split into sequential windows only with fetchAll:true; boundary arithmetic exact at UTC day edges` — the 30-day window is itself [verify]; encode it as a single constant so the test and the code drift together

### (h) Manifest snapshot + README/env-docs sync

**Assessment: directly inherited from the reference and already proven there
(`manifest-snapshot`, `readme-sync`, `env-docs-sync` tests reviewed). Adopt
wholesale, with three Instagram-specific extensions:**

- The manifest fixture must include **annotations and input JSON schemas** (via
  zod introspection), not just names — a flipped `destructiveHint` or a loosened
  input schema must show up in the fixture diff, because annotations drive
  client permission UX (security.md §4 depends on them).
- The **auth-path capability matrix** (which tools exist on Path A vs B, M4)
  belongs in the manifest fixture so a capability regression is a visible diff.
- The env scan must cover the `IG_PROFILE_<NAME>_*` indirection the same way the
  reference's `authEnv("SUFFIX")` scan does — profile-scoped vars never appear
  literally in source.

Proposed: `tool manifest (names, packages, annotations, schemas, path capabilities) matches the checked-in fixture`;
`every IG_* var readable in src/ is documented in README and .env.example (scan floor + sentinels)`;
`README generated tool table matches the live registry`;
`server.json matches gen:manifest output`;
`package.json description states the real tool and package counts`.

### (i) What mocked tests cannot cover — the live-smoke problem

**Assessment: this is the least-developed area and it backs M2's exit criteria
directly.** Facts that shape the design:

- Meta has **no sandbox** for IG publishing; FB "test users" have no Instagram
  accounts. The only way to exercise the publish path is a **real IG
  professional account**.
- **The Instagram Platform API cannot delete or archive published media.** Only
  comments are deletable. Every live feed/reel test post is permanent until
  removed manually in the app. There is no API cleanup strategy — only an
  account strategy.
- Business accounts are public; test posts are publicly visible.
- Publishing quota is 100/24 h, and dev-mode apps may have tighter platform
  limits **[verify]** — a careless scheduled suite burns real quota.

Recommended protocol (should be added to the docs as `docs/testing.md` or an
operations subsection):

1. **Dedicated junk account**: one IG professional account created solely for
   this project (obscure handle, no followers, bio saying "API test account"),
   linked to a dedicated test Page for Path B. Two env profiles (`IG_PROFILE_LIVE_A_*`,
   `IG_PROFILE_LIVE_B_*`) so both paths are exercised.
2. **Stories-first publishing smoke**: stories expire after 24 h — they are the
   only self-cleaning publishable media type. The routine live smoke publishes a
   STORY; feed image + reel are published only for milestone acceptance (M2
   exit) and cleaned up manually.
3. **Tiered live suites**, all gated behind `IG_LIVE=1` and never on PR:
   - `live:read` — token status, get_account, list_media, insights, header
     shapes. Cheap, safe, can run on demand or weekly `workflow_dispatch`.
   - `live:publish` — story publish end-to-end (container → poll → publish →
     read back). Quota cost 1. Manual trigger only.
   - `live:destructive` — create a comment on own media, then delete it: the
     only write path with a real cleanup, and it exercises the double gate.
   - `live:acceptance-m2` — the scripted M2 exit: feed image + reel via
     preview → apply, quota read before/after asserting the decrement.
4. **Contract-fixture capture**: a `scripts/capture-fixtures.mjs` run against
   the live account records *sanitized* real Graph responses (error envelopes,
   usage headers, container status sequences, the already-published-container
   error, the EXPIRED code) into `test/fixtures/graph/`. Mocked tests replay
   these fixtures. This is the mechanism that keeps mocks honest and retires the
   docs' many **[verify]** items into pinned test data — including the
   double-post-risk claim (F4) and the exact 9007/EXPIRED and 2207051 subcodes.
5. **Stable media hosting for tests**: ingestion is URL-based, so live publish
   tests need a small, stable, public test JPEG/MP4 — host them on the
   operator's GitHub Pages and pin the URLs in the live-test env.

What only live can validate (and mocks must therefore import from fixtures, not
imagination): real header shapes per host, post-Dec-2024 scope names, whether
`graph.instagram.com` accepts `/v25.0/`, container processing timings, the
pre-processing-rejection replay-safety claim, aspect-ratio enforcement drift,
hashtag 30/7d behavior, Path-A capability gaps.

### (j) Risks of testing built output vs source

**Assessment: keep the reference's built-output approach — it tests the shipped
artifact (ESM resolution, `.js` extensions, launcher) — but name its three risks
and their mitigations, which §10 currently doesn't:**

1. **Stale-build hazard**: `npm test` after editing src silently tests old
   code. Mitigation: `test:full` is the only documented entry point in CI *and*
   a build-freshness drift gate (the reference has `drift-gate.test.js` for
   precisely this) comparing src vs build.
2. **Coverage mapping**: c8 measures the generated JS unless source maps are on;
   the ratchet numbers then track compiled-code line geometry and shift on
   TS/compiler upgrades. Mitigation: `sourceMap: true` in tsconfig, c8 excludes
   for the `.cjs` launcher and generated scaffolding.
3. **The fetch seam**: `withFetch` only works if `core/http.ts` reads
   `globalThis.fetch` **at call time**. A well-meaning `const f = fetch` at
   module top level breaks every mocked test at once. This is an architectural
   test-seam requirement and belongs in architecture.md §5 as a stated
   constraint (same for `Date.now()`/timers → injectable clock, F1).

Residual: TS type errors are caught by `tsc` in the gate, not by tests — fine;
debugging through built JS is mildly worse — acceptable, the reference lives
with it.

### (k) Missing failure-mode tests the docs don't anticipate

Beyond the areas above, the docs are silent on:

- **Non-JSON upstream responses**: HTML 502 pages from proxies, empty bodies,
  Graph's occasional bare `false`/`{"success":true}` — the envelope parser needs
  a malformed-body guard and tests.
- **Wrong-account publication via profiles**: an unknown `account` argument must
  hard-fail, never silently fall back to the default profile — the failure mode
  is *posting to the wrong Instagram account*. Plus an AsyncLocalStorage
  bleed test: two concurrent tool calls with different `account` values must
  each see their own token (`concurrent calls with different profiles never
  cross tokens`).
- **stdout purity**: one stray `console.log` corrupts the stdio protocol. A
  process-level test must spawn the built server, complete an MCP initialize
  handshake, and assert stdout carries only protocol frames while logs land on
  stderr.
- **OAuth `login` CLI edge cases**: `state` mismatch rejected; callback port in
  use; user denies consent (`error=access_denied`); token never printed to the
  terminal.
- **190 subcode variants** (expired vs password-changed vs revoked) mapping to
  distinct remediation texts — operations.md collapses them.
- **Caption boundary semantics**: 2,200 "characters" with emoji/astral-plane
  content — code units vs grapheme clusters; property-test the boundary against
  whatever counting Graph actually uses (capture live).
- **Hashtag counting rules**: 30-hashtag client-side validation — duplicates,
  `#` inside URLs, case sensitivity.
- **Local hashtag-budget persistence**: corrupt counter file recovers; 7-day
  rolling expiry (fake clock); counter survives restarts.
- **Allowlist content drift**: `rupload.facebook.com` is allowlisted but no v1
  tool uses it (video is URL-ingested). An exact-contents allowlist test plus
  removing the unused host until needed (F11).
- **Interrupted composite**: process killed between container creation and
  publish — on restart, is the orphaned container discoverable (journal)?

### Roadmap exit-criteria verifiability

- **Preamble gate** ("`npm run check` green + manifest snapshot reviewed") —
  objective except "reviewed", which names no reviewer or artifact; make it "the
  fixture diff is committed in a PR" to be checkable.
- **M0** — verifiable (name availability, pins are yes/no checks).
- **M1** — verifiable but *manual ×2*: "works on both auth paths against a real
  account" needs both path setups; should be restated as "`doctor` passes on
  both paths" plus the `live:read` suite green, so the criterion is a command,
  not a vibe.
- **M2** — verifiable in principle ("real image post + reel … quota correctly
  decremented") but currently has no *procedure*; the `live:acceptance-m2`
  script (area i) is what makes it objective, including the before/after quota
  read. "Kill-switch verified" is objective (a mocked test does it).
- **M3–M6** — **no exit criteria at all**, only content lists (F12). Each needs
  at least one objective check (e.g. M3: "live comment create+delete round-trip
  passes; delete refused without both gates in the mocked suite"; M4: "capability
  matrix encoded in the manifest fixture"; M5: "npx from the published tarball
  completes an MCP handshake on Node 20/22/24").

## 4. Findings

| # | Severity | Where | Finding & recommendation |
|---|---|---|---|
| **F1** | **Critical** | architecture.md §10; tools.md (poll ≤ 5 min); auth.md §1/§3 (24 h, 45 d, 10 d); operations.md §1 (7-day budget) | **No deterministic time-control strategy.** Polling, backoff, token-age refresh rules, expiry warnings, and the rolling hashtag budget are all clock-driven; §10 names no injectable clock or mock timers, making the core flows untestable or minutes-slow. **Recommendation**: mandate `node:test` mock timers plus an injectable clock (`core/settings.ts` time source) as an architectural test seam; state it in §10 and in architecture.md §5. |
| **F2** | **High** | architecture.md §10 vs tools.md `publishing` | **Container state machine has no test plan.** ERROR, EXPIRED, timeout, unknown-status, resume-with-ID, and quota-before-container ordering are unmentioned in §10 despite being the product's core risk. **Recommendation**: add the state-machine suite from §3(a) explicitly to §10; test transitions at the `api/` layer, orchestration at the tool layer. |
| **F3** | **High** | roadmap.md M2; (absent) testing docs | **Live-verification gap.** No sandbox exists; the API cannot delete published media, so there is no API cleanup; M2's exit needs real posts with real quota. **Recommendation**: adopt the live-smoke protocol of §3(i) — dedicated junk account, stories-first smoke, tiered manual suites, contract-fixture capture, pinned test-media URLs — and document it. |
| **F4** | **High** | operations.md §2 | **"429 rejected pre-processing → safe to replay POST" is an unverified assumption with double-post consequences** if wrong for `media_publish`. **Recommendation**: mark it [verify]; validate live once, capture the evidence as a contract fixture; until verified, consider exempting `media_publish` from automatic 429 replay (surface the container ID for manual resume instead). |
| **F5** | **High** | tools.md §Write safety vs `publishing` rows | **Spec contradiction**: preview "performs no request" vs previews that must GET the publishing quota. Ambiguity blocks assertion design. **Recommendation**: restate the rule as "preview may perform read-only GETs, never POST/DELETE", and have the all-write-tools sweep enforce exactly that. |
| **F6** | Medium | security.md §2; tools.md §Write safety | **Journal and `logFields` are not explicitly inside the redaction boundary.** The journal is a serialization sink; "documented to never carry secrets" is a convention, not a control. **Recommendation**: route journal entries and `logFields` output through `mcp/redact.ts`; add the configured-value canary test over all sinks. |
| **F7** | Medium | operations.md §1; architecture.md §5 | **"Proactively slow down > 90 %" names no observable behavior** — untestable. **Recommendation**: specify the mechanism (e.g. inter-call delay as a function of usage; refuse writes at ≥ 100 % with the reset message) and test it under mock timers. |
| **F8** | Medium | security.md §4; tools.md `publishing` | **Quota-check failure behavior unspecified**: if `content_publishing_limit` itself errors, do composites proceed or refuse? **Recommendation**: specify (suggest: refuse with a clear message for `apply`, warn in preview) and test both branches. |
| **F9** | Medium | auth.md §1 | **`getAuthMode()` with both paths' env present is undefined.** Wrong resolution selects the wrong host/token/capability set. **Recommendation**: define precedence (or hard-fail with a message) and pin it with tests. |
| **F10** | Medium | tools.md §Write safety; architecture.md §6 | **Journal/state paths are not test-overridable** in the design (`~/.local/state/...` hardcoded in prose). Tests would write to the operator's real state dir. **Recommendation**: honor `XDG_STATE_HOME` (and an `IG_STATE_DIR` override) so suites run in temp dirs. |
| **F11** | Low | architecture.md §5; security.md §3 | **`rupload.facebook.com` allowlisted but unused in v1** (video is URL-ingested). Widest-by-default allowlists rot. **Recommendation**: drop it until a tool needs it; add an exact-contents allowlist test. |
| **F12** | Medium | roadmap.md M3–M6 | **M3–M6 have no exit criteria**, and the generic gate's "snapshot reviewed" names no checkable artifact. **Recommendation**: one objective, command-shaped criterion per phase (examples in §3, roadmap subsection). |
| **F13** | Medium | operations.md §3 | **Error-taxonomy mapping has no fixture strategy.** Codes/subcodes (9007, 2207051, 190 subcode variants) are [verify] guesses; hand-written mock envelopes would test the guess, not Graph. **Recommendation**: drive `InstagramError` mapping tests from captured live fixtures (`test/fixtures/graph/errors/*.json`). |
| **F14** | Medium | architecture.md §10/§5 | **Built-output testing risks unstated**: stale-build hazard, coverage mapping, and the call-time `globalThis.fetch` seam requirement. **Recommendation**: document the seam constraints (fetch + clock), add a build-freshness drift gate, enable source maps for c8. |
| **F15** | Low | architecture.md §8; §10 | **No stdout-purity/process-level test planned.** A stray stdout write corrupts stdio MCP. **Recommendation**: spawn-the-binary smoke test asserting protocol-only stdout, logs on stderr. |
| **F16** | Low | architecture.md §6; tools.md (account arg) | **No profile-isolation tests planned** for the AsyncLocalStorage multi-account mechanism; unknown-profile fallback behavior unspecified. **Recommendation**: hard-fail unknown profiles; add the concurrent-profiles no-bleed test. |

## 5. Proposed test plan skeleton

Layout mirrors the reference: flat `test/*.test.js` over built output,
`test/helpers.js` (`baselineEnv` — seeds fake `IG_*` creds for both paths,
`withEnv`, `withFetch`, `jsonResponse`, plus **`withClock`** for mock timers and
**`graphError(code, subcode, msg)`** / fixture loaders), `test/fixtures/`
(manifest snapshot + captured Graph envelopes).

| Suite (files) | Contents | Runs in |
|---|---|---|
| `config`, `settings`, `profiles` | env resolution, XDG paths, atomic 0600 writes, profile selection, ALS isolation (F16) | CI |
| `host` | exact allowlist contents, redirect refusal, loopback/private refusal, paging.next host rule | CI |
| `http-retry`, `http-headers` | full retry matrix (§3b), semaphore, backoff schedule under mock timers, usage-header parsing + throttle (§3c) | CI |
| `auth`, `token-lifecycle` | providers, appsecret_proof invariant sweep + known-answer, exchange/refresh/expiry with fake clock, getAuthMode precedence | CI |
| `publishing-state` | container state machine at api layer — all transitions, EXPIRED/ERROR/timeout/unknown, resume-with-ID, quota ordering (§3a) | CI |
| `write-mode`, `write-journal` | preview sweep (GET-only rule), apply, standing consent, READONLY kill-switch, destructive double gate, journal redaction + XDG_STATE_HOME | CI |
| `tools-<package>` (×6) | per-tool request shape (URL, pinned v25.0, params) + behavior, composites' orchestration/preview | CI |
| `errors` | fixture-driven `InstagramError` mapping (F13), non-JSON/malformed bodies, fbtrace preservation | CI |
| `redact`, `property` | fast-check: redaction properties + canary, truncation halving loop, cursor round-trip, caption boundaries | CI |
| `manifest-snapshot`, `readme-sync`, `env-docs-sync`, `server-json-sync` | surface + docs lockstep incl. annotations, schemas, capability matrix (§3h) | CI |
| `all-tools-smoke` | every tool callable under mock; token-canary over all outputs | CI |
| `mcp-process-smoke` | spawn built binary, initialize handshake, stdout purity (F15) | CI |
| `drift-gate` | build freshness vs src (F14) | CI |
| `live:read` | doctor, reads, header shapes — both paths | manual / opt-in scheduled |
| `live:publish` | story publish end-to-end (self-expiring) | manual only |
| `live:destructive` | comment create → delete round-trip | manual only |
| `live:acceptance-m2` | scripted M2 exit: image + reel, preview → apply, quota before/after | manual, once per milestone |
| `scripts/capture-fixtures.mjs` | records sanitized live envelopes into `test/fixtures/graph/` | manual, on Graph-version bumps |

**CI**: mocked suites on the full matrix (Node 20/22/24 × 3 OS) via `test:full`
(build + test); live suites are never PR-triggered — `workflow_dispatch` with
repo-secret credentials at most, `live:publish` and beyond local-only.

**Coverage gate**: c8 with source maps; start the gate after M1 at a modest
floor (e.g. lines 85 / branches 75), then ratchet to just-below-actuals per the
reference (~94/82/97 there); exclude the `.cjs` launcher; Codecov upload
non-blocking. Do not chase 100 % — spend the margin on the state-machine and
property suites instead.

## 6. Recommendations summary (prioritized)

1. **(F1)** Add time control to the strategy: injectable clock + `node:test`
   mock timers, named in architecture.md §5 and §10. Blocking for M1.
2. **(F2)** Write the container-state-machine test plan into §10 (the suite in
   §3a). Blocking for M2.
3. **(F3)** Document the live-smoke protocol: dedicated junk IG account,
   stories-first smoke, tiered manual suites, contract-fixture capture, pinned
   test-media URLs; wire M1/M2 exit criteria to those scripts. Blocking for M2.
4. **(F4)** Treat 429-replay-on-`media_publish` as unverified; exempt it from
   auto-retry until a live fixture proves pre-processing rejection.
5. **(F5, F7, F8, F9)** Resolve the four spec ambiguities (preview GET-only
   rule; > 90 % throttle mechanism; quota-check failure policy; getAuthMode
   precedence) — each is a one-paragraph doc fix that unblocks assertions.
6. **(F6, F16)** Pull journal + logFields inside the redaction boundary; add the
   configured-value canary over every sink; hard-fail unknown profiles.
7. **(F13)** Adopt fixture-driven error-taxonomy tests fed by the capture
   script; retire [verify] codes into pinned fixtures.
8. **(F10, F11, F14, F15)** Smaller hardening: XDG_STATE_HOME/test-overridable
   journal path; trim `rupload.facebook.com` from the v1 allowlist; document the
   fetch/clock test seams + drift gate + source maps; add the stdout-purity
   process smoke.
9. **(F12)** Give M3–M6 command-shaped exit criteria; replace "snapshot
   reviewed" with "fixture diff committed".

## 7. Verdict

**CONDITIONAL GO** on quality-strategy grounds.

The inherited reference pattern is strong, demonstrably practiced (the
servicenow-mcp suite is real evidence, not aspiration), and §10 adopts its best
parts: recording mocks asserting both request and behavior, the manifest
snapshot over the whole surface, docs-sync tests, property tests, and a coverage
ratchet. For everything ServiceNow-shaped, this will work.

Conditions to convert to GO — all documentation-level, all feasible before the
phases they block:

1. **Before M0/M1**: F1 (time-control seams) and the spec-ambiguity fixes
   (F5, F7, F8, F9) land in the docs; §10 is expanded with the retry,
   state-machine, and invariant suites by name.
2. **Before M2**: the live-smoke protocol (F3) is documented, the dedicated test
   account exists, and M2's exit criterion points at the `live:acceptance-m2`
   script; F4's replay exemption is in place until disproven.
3. **Before M5 (first publish)**: the canary redaction invariant (F6) and the
   process-level stdout smoke (F15) are green in CI.

With those conditions met, the testing strategy is adequate for this domain —
including its genuinely awkward corner, the sandbox-less, undeletable-media
publishing path, which the tiered live protocol reduces to a controlled,
quota-bounded, mostly self-cleaning manual procedure.
