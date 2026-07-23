---
name: Bug report
about: Something in the MCP server or a tool behaves incorrectly
title: ''
labels: bug
assignees: ''
---

**Describe the bug**
A clear and concise description of what went wrong.

**To reproduce**
The exact tool call or steps that trigger it:

1. Tool: `instagram_...`
2. Arguments (redact anything you'd rather not share): ...
3. Preview or apply: `apply: false` / `apply: true`
4. Observed result: ...

**Expected behaviour**
What you expected to happen instead.

**Redacted logs**
Paste the relevant stderr JSON log lines. **Remove any access tokens, the app
secret, and account ids first** — the redactor masks token-shaped strings, but
double-check before pasting.

```
<logs here>
```

**Environment**

- instagram-mcp-ai version: <!-- e.g. 0.0.1, or a commit SHA -->
- Node.js version (`node -v`): <!-- must be >= 22 -->
- OS:
- MCP client: <!-- Claude Desktop / VS Code / Cursor / stdio CLI / ... -->
- Auth path: <!-- A (ig-login) / B (fb-login) -->
- Transport: <!-- stdio / http -->

**Additional context**
Anything else that helps — redacted `doctor` output, the active tool package
profile, etc.
