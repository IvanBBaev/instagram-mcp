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
- **Redaction layer (`core/redact.ts`)** runs before any serialization to the model:
  masks the configured token/secret values and anything matching token shapes
  (`EAA…`, `IGQ…`-style prefixes) in results, errors, and logs. Every serialization
  sink is inside that boundary as an enforced control, not a convention: the log
  stream, the per-call `logFields` payload (routed through the redactor by the
  registry), and the applied-writes journal (redacted in `mcp/write-mode.ts` before
  the entry is appended).
- Logs are structured JSON on **stderr only**; URLs are logged with query strings
  stripped (`safeUrl`) — Graph puts `access_token` in the query, so raw URLs are
  never logged.
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
- HTTP transport binds loopback only; bearer token compared with `timingSafeEqual`.

## 4. Model-driven-mutation safety

- **Plan-and-apply** on every write (see [tools.md](tools.md)): preview by default,
  `apply: true` to execute, `IG_WRITE_MODE=apply` for standing consent; journal of
  applied writes for audit (redacted before it is written — see §2).
- **Honest annotations**: `destructiveHint` on irreversible ops (`delete_comment`),
  `readOnlyHint` on all reads — clients surface these in their permission UX.
- Irreversible deletion double-gated behind `IG_ALLOW_DESTRUCTIVE=true`.
- **Publishing quota as a safety rail**: previews state quota impact; the composite
  posting tools refuse when `content_publishing_limit` reports the quota exhausted,
  rather than burning the last slots on retries.
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
  facts the human is approving. The access token and app secret are stripped from
  the finished message and from anything the failure path logs.
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
- `doctor` surfaces `data_access_expires_at` and token scope drift so overgranted
  scopes get trimmed.

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
