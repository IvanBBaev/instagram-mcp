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
- **Redaction layer (`mcp/redact.ts`)** runs before any serialization to the model:
  masks the configured token/secret values and anything matching token shapes
  (`EAA…`, `IGQ…`-style prefixes) in results, errors, and logs. `logFields` is
  documented and reviewed to never carry secrets.
- Logs are structured JSON on **stderr only**; URLs are logged with query strings
  stripped (`safeUrl`) — Graph puts `access_token` in the query, so raw URLs are
  never logged.
- `debug_token`/`login` flows keep the app secret server-side; the `login` CLI
  callback binds to loopback and the OAuth `state` parameter is random and checked
  (the prior-art token-in-callback-URL leak class).

## 3. Network policy (SSRF)

- Hard host allowlist: `graph.instagram.com`, `graph.facebook.com`,
  `rupload.facebook.com`. Everything else — including redirect targets — is refused
  in `core/host.ts` before the socket opens. No env override widens this in v1.
- `image_url`/`video_url` inputs are **passed to Meta**, not fetched locally — the
  server never retrieves user-supplied URLs itself. Consequence: publish previews
  cannot verify URL reachability, and say so ([tools.md](tools.md)). If a future
  helper uploads local files to operator storage, it will use a separate, explicit
  allowlist.
- HTTP transport binds loopback only; bearer token compared with `timingSafeEqual`.

## 4. Model-driven-mutation safety

- **Plan-and-apply** on every write (see [tools.md](tools.md)): preview by default,
  `apply: true` to execute, `IG_WRITE_MODE=apply` for standing consent; journal of
  applied writes for audit.
- **Honest annotations**: `destructiveHint` on irreversible ops (`delete_comment`),
  `readOnlyHint` on all reads — clients surface these in their permission UX.
- Irreversible deletion double-gated behind `IG_ALLOW_DESTRUCTIVE=true`.
- **Publishing quota as a safety rail**: previews state quota impact; the composite
  posting tools refuse when `content_publishing_limit` reports the quota exhausted,
  rather than burning the last slots on retries.
- Packages can be force-read-only (`IG_PACKAGES_READONLY`) — e.g. run `publishing`
  dark while testing prompts.

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
