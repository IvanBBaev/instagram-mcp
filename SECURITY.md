# Security Policy

`instagram-mcp-ai` is a locally-run, single-operator MCP server that holds
long-lived Meta credentials and is driven by an LLM. Security is treated as a
first-class requirement of the design, not a late hardening pass. The full threat
model and controls live in [docs/security.md](docs/security.md); this file is the
public disclosure policy and a summary.

## Supported versions

The project follows [Semantic Versioning](https://semver.org/). Only the latest
published release receives security fixes until the API stabilizes at `1.0.0`.

| Version | Supported |
|---|---|
| Latest published `0.x` release | Yes |
| Older `0.x` releases | No — upgrade to the latest |
| `0.0.1` name-reservation stub (no functionality) | No |

Nothing beyond the `0.0.1` stub is published yet; this table becomes active with
the first functional release.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub Security Advisories:

- <https://github.com/IvanBBaev/instagram-mcp/security/advisories/new>

This opens a private advisory visible only to you and the maintainer. There is no
public security email — GitHub Security Advisories is the only supported channel.

When reporting, please include:

- the affected version (and platform / Node.js version),
- a description of the issue and its impact,
- steps to reproduce or a proof of concept, and
- any suggested remediation, if you have one.

Expectations: an initial acknowledgement within a few days and a good-faith effort
to assess, fix, and coordinate disclosure. Because this is a single-maintainer
project, timelines are best-effort. Please give a reasonable window to ship a fix
before any public disclosure.

## Security model (summary)

See [docs/security.md](docs/security.md) for the authoritative treatment.

- **Credential handling & redaction.** Access tokens and the app secret live only
  in the process environment, a `0600` XDG env file, or the OS keychain (MCPB
  `user_config`) — never in the repo. A redaction layer masks configured secret
  values and token-shaped strings (`EAA…`, `IGQ…`) before anything is serialized to
  the model, into errors, or into logs. Logs are structured JSON on stderr only,
  with query strings stripped from URLs (Graph puts `access_token` in the query).
- **Network policy (SSRF).** A hard host allowlist admits only the official Meta
  Graph hosts — `graph.instagram.com` and `graph.facebook.com` (plus the
  resumable-upload host; see [docs/security.md](docs/security.md) §3) — and refuses
  everything else, including redirect targets, before the socket opens. No
  environment override widens this in v1. User-supplied `image_url` / `video_url`
  values are passed to Meta for ingestion; the server never fetches them itself.
- **Model-driven-mutation safety (write gate).** Every write is **preview by
  default** and requires `apply: true` (or standing `IG_WRITE_MODE=apply`) to
  execute — previews perform read-only GETs. Irreversible operations
  (`delete_comment`) are **double-gated** behind `IG_ALLOW_DESTRUCTIVE=true` and
  annotated with `destructiveHint`. Applied writes are journaled for audit, and
  `media_publish` is never auto-retried so one instruction can never post twice.
- **Platform-side hardening.** On the Facebook-login path, every call carries an
  `appsecret_proof` and the app runs with "Require App Secret" enabled, so a stolen
  bare token is useless against the app. Standard Access, single-operator: no
  third-party data transits the server; there is no telemetry or phone-home.

## Out of scope

- **No unofficial APIs.** No `instagram-private-api`-style clients, no cookie or
  session reuse, no automation of the Instagram app or website. Official Meta Graph
  API only.
- **No scraping.** The server never harvests data outside documented Graph
  responses.
- **Single-operator, local server.** This is a personally-run server for one or a
  few of your own professional accounts. It is not multi-tenant SaaS; the
  Streamable HTTP transport stays loopback-bound. Hardening assumptions that hold
  for a hosted, internet-exposed deployment are out of scope.
