# Contributing

A personal project, but the bar is the same as for a team one: every change
lands with its tests, behind the full gate, with the generated docs in sync.

## Dev setup

```bash
nvm use            # Node from .nvmrc (22); engines require Node >= 22
npm install
npm run build      # tsc -> dist/
```

Credentials live in a git-ignored `.env` (copy [`.env.example`](.env.example));
see the [README](README.md#configuration) and [docs/auth.md](docs/auth.md) for
the two Instagram auth paths and the credential resolution order.

## Quality gate

```bash
npm run check        # the full gate: lint + format:check + build + test
npm run lint         # eslint . (type-checked)
npm run format:check # prettier --check .
npm test             # node --test over dist (needs a prior build)
npm run test:full    # build + test in one step
npm run coverage     # c8 text + lcov
```

`prepublishOnly` runs `npm run check`, so a publish cannot bypass the gate. CI
runs the same chain on the Node 22/24 × ubuntu/macOS/Windows matrix, plus
`npm audit` and CodeQL.

## Architecture: the four layers

Imports only ever point inward: **`core` ← `api` ← `mcp` ← `tools`**. The
boundaries are enforced at lint time by `no-restricted-imports` in
[`eslint.config.js`](eslint.config.js) — a violating import fails `npm run lint`
(and therefore CI):

- **`core`** (Layer 0) — must not import from `api`/`mcp`/`tools`.
- **`api`** (Layer 1) — must not import from `mcp`/`tools`.
- **`tools`** — must not reach into `core/http*` or `core/host*`; every network
  call goes through the `api/` layer.

See [docs/architecture.md](docs/architecture.md) for the full layer model, the
tool registry and the request lifecycle.

## Tests

Tests live under [`test/`](test/), mirroring the `src/` tree, as `*.test.ts`
files. They compile to `dist/` and run from there via `node --test`
(`dist/**/*.test.js`), so **build before you test**. Every behavioural change
ships with a test in the same commit. Two guards are automatic: the
generated-docs drift test ([`test/docs-sync.test.ts`](test/docs-sync.test.ts))
and the version-consistency drift test
([`test/release/version-consistency.test.ts`](test/release/version-consistency.test.ts)).

The README tool + env tables are **generated** — edit the tool/env sources, then
run `npm run gen:readme`; the drift test fails CI when they are stale.

## Running it locally

```bash
npm run build
node dist/src/index.js          # start the MCP server on the stdio transport
node dist/src/index.js login    # interactive browser OAuth -> persist a token
node dist/src/index.js doctor   # diagnose the active profile's credential
node dist/src/index.js refresh  # refresh the active profile's token
```

The published binary (`npx instagram-mcp-ai`) wraps the same entry; the
`bin/instagram-mcp-ai.cjs` launcher enforces the Node >= 22 floor before it loads
the ESM graph. See the [README](README.md) for a full MCP-client config block.

The server talks **only** to official Meta Graph hosts, and it is safe by
default: every write tool is **preview by default**. A preview performs a
read-only GET and returns what _would_ change; a real mutation requires
`apply: true` on the call (or the standing `IG_WRITE_MODE=apply`). Irreversible
operations (`instagram_delete_comment`) are double-gated behind
`IG_ALLOW_DESTRUCTIVE=true`. See [SECURITY.md](SECURITY.md) for the full model.

## Conventions

- One commit per task; English, imperative subject, a body that explains
  what + why. Conventional-ish prefixes (`feat:`, `fix:`, `docs:`, …) are
  welcome but not enforced.
- **No AI attribution** in the git history — no `Co-Authored-By` /
  "Generated with …" trailers in commits or PRs.
- Docs move with the code: update the [`CHANGELOG.md`](CHANGELOG.md)
  `Unreleased` section, and re-run `npm run gen:readme` when the tool/env
  surface changes.

## Releasing

`package.json` is the **single source of truth** for the version; `server.json`
and the MCPB `manifest.json` are derived from it and kept in lockstep by the
version-consistency drift test. Publishing happens **from CI on a version tag**
(npm publish with provenance / OIDC), never from a laptop. The full ordered
procedure — including the steps blocked on live credentials and maintainer
publish rights — is in
[docs/release-checklist.md](docs/release-checklist.md).

## Security

Please **do not** open a public issue for a vulnerability. Report privately via
GitHub Security Advisories — see [SECURITY.md](SECURITY.md) for the channel and
what to include.
