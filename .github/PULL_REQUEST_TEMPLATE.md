## What & why

<!-- What this changes and the reason. Link any issue: Closes #123. -->

## Type of change

- [ ] Fix
- [ ] New tool / feature
- [ ] Refactor / internal
- [ ] Docs only

## Checklist

- [ ] `npm run check` passes locally (lint + format:check + build + test)
- [ ] Behavioural changes ship with tests in the same commit
- [ ] Layer boundaries respected (`core ← api ← mcp ← tools`)
- [ ] Docs regenerated if the tool/env surface changed (`npm run gen:readme`)
- [ ] `CHANGELOG.md` `Unreleased` section updated
- [ ] No AI-attribution trailers in the commits

## Tool / behaviour notes

<!-- If this touches a tool, fill these in. -->

- Tool(s): `instagram_...`
- Access: Read / Write
- Auth path: A (ig-login) / B (fb-login) / both
- Write model: preview-by-default preserved? destructive ops still double-gated?

## Testing

<!-- How you verified this. Paste redacted logs if relevant. -->

- Node version:
- MCP client:
- Exercised: preview / apply
