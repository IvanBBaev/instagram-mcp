# Design Review — Consolidated Summary

> Six independent senior-role reviews of the instagram-mcp design documentation,
> conducted 2026-07-21. Full reviews live in this directory. This file aggregates
> verdicts, cross-cutting themes, and the prioritized action list.
> **Factual corrections from the platform-api review have already been applied**
> to the design docs (marked `[verified 2026-07-21]`); design-level recommendations
> below are pending decisions, not yet incorporated.

## Verdicts

| Review | Verdict | Focus of conditions |
|---|---|---|
| [architecture-review.md](architecture-review.md) | CONDITIONAL GO | Auth-path capability model vs static registry; refresh-vs-env precedence; composite polling |
| [security-review.md](security-review.md) | CONDITIONAL GO (read-only M1: clean GO) | Human-in-the-loop for writes; injection fencing; redaction of minted secrets |
| [platform-api-review.md](platform-api-review.md) | CONDITIONAL GO | 9 factual corrections (applied); runtime quota read; discovery App-Review gate |
| [qa-review.md](qa-review.md) | CONDITIONAL GO | Injectable clock; container state-machine test plan; live-verification protocol |
| [devops-review.md](devops-review.md) | CONDITIONAL GO | Token-refresh persistence trap; MCPB channel design; canonical env catalog |
| [product-dx-review.md](product-dx-review.md) | CONDITIONAL GO | Competitive claim accuracy; public-URL constraint visibility; auth env vars |

## Cross-cutting themes (found independently by ≥2 reviewers)

1. **Client-env vs refresh-persistence trap** (architecture F-2, devops F-1): env
   injected by the MCP client always wins over the XDG file, but Path-A auto-refresh
   persists to the XDG file → a client-configured token silently expires at day 60.
   Must be resolved by design before M2 (options: token indirection/reference,
   refresh-in-place guidance per channel, or making the XDG file the only token home).
2. **Dual-auth capability matrix is load-bearing and under-designed** (architecture
   F-1, platform-api, qa): capability differences (hashtag/business_discovery/product
   tags = Path B only) must live in ToolSpec metadata with call-time enforcement,
   designed in M1 — not deferred to M4. Simplification option for v1: one auth path
   per process.
3. **Model-controlled write gate is not human consent** (security F-1/F-3, qa F5):
   `apply: true` can be supplied by a prompt-injected model; standing env flags
   disable the gate silently. Adopt MCP elicitation for apply/destructive confirms;
   redefine preview as "read-only GETs only" (done in tools.md).
4. **Composite publish polling is a duplicate-post risk** (architecture F-3, qa F2/F4):
   long polls → client timeout → model retry → double post + quota burn. Applied to
   tools.md: poll budget ≤ 60 s, resumable in-progress result carrying the container
   ID; `media_publish` excluded from automatic retry until live evidence proves
   replay safety.
5. **No canonical env-var catalog** (devops F-3, product-dx): added as an appendix
   to architecture.md, including previously undefined auth-path selection vars.

## Prioritized action list

**Pre-M0 (design sign-off):**
- [ ] Reserve the npm name `instagram-mcp-ai` with a stub (verified available
      2026-07-21; adjacent names are squatted).
- [ ] Decide capability-matrix mechanism (ToolSpec metadata + call-time enforcement
      vs one-path-per-process v1).
- [ ] Resolve the token-refresh persistence trap by design.
- [ ] Adopt the error-model decision: single `InstagramError` with `kind`
      discriminant (applied to docs).
- [ ] Raise Node floor to 22 (applied to docs; Node 20 is EOL).

**Pre-M1:**
- [ ] Injectable clock + fetch seams in the test harness (qa F1).
- [ ] Host-resolution rule for the two Graph hosts specified in core/http (arch F-4).
- [ ] Empirically probe hashtag-search availability: the "Instagram Public Content
      Access" feature may be App-Review-gated even for own-app admins (platform-api
      F; discovery package may need to move behind a documented gate).

**Pre-M2 (before any write ships):**
- [ ] MCP elicitation (human confirm) for apply/destructive; injection-fencing for
      untrusted tool-result text; redaction of runtime-minted tokens and
      `appsecret_proof` HMACs (security C1–C4).
- [ ] Container state-machine test plan + live-verification protocol (dedicated junk
      account, stories-first smoke — stories self-expire; published feed media
      cannot be deleted via API).
- [ ] Runtime quota from `content_publishing_limit.config.quota_total` — never
      hardcode 100 vs 50 (applied to docs).

**Pre-M5:**
- [ ] MCPB channel design (build workflow, `user_config` mapping, token-acquisition
      story for non-CLI users — consider URL elicitation).
- [ ] Release checklist, tagging strategy, three-channel version-drift test,
      npm trusted publishing (OIDC).

## Notable market facts (live checks, 2026-07-21)

- npm: `instagram-mcp-ai` free; `instagram-mcp` (v1.1.7) and `instagram-mcp-server`
  (v1.6.6, same squatter as `facebook-mcp-server`) taken.
- Two TypeScript competitors exist (`@mikusnuz/meta-mcp` — stale; `@mcpware/instagram-mcp`
  — no annotations/security/tests); Meta's official MCP remains ads-only. The
  positioning holds, but README now names the prior art instead of claiming a vacuum.
