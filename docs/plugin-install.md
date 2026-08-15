# Installing the Instagram MCP as a Claude Code plugin (`.claude-plugin`)

> **Audience:** **Claude Code** users who want this server present in every session
> without hand-editing `.mcp.json` in each repo, and who are comfortable supplying the
> access token through a file or their shell environment rather than a GUI form. If you
> want a GUI form, you want the **Claude Desktop** bundle instead —
> [`mcpb-install.md`](mcpb-install.md).
>
> **Status: `[not shipped]`.** Both manifests
> ([`../.claude-plugin/plugin.json`](../.claude-plugin/plugin.json) and
> [`../.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)) are authored
> in-tree, validate against their published JSON schemas, and are locked by the
> four-channel version-drift test
> ([`../test/release/version-consistency.test.ts`](../test/release/version-consistency.test.ts))
> plus a manifest-contract test
> ([`../test/release/plugin-manifest.test.ts`](../test/release/plugin-manifest.test.ts)).
> **One blocker remains, and it is the only one:**
>
> - **No npm package.** The manifest launches the server with
>   `npx -y instagram-mcp-ai@<version>`, and `instagram-mcp-ai` **is not on the npm
>   registry** — `npm view instagram-mcp-ai` returns **404**. A plugin install would
>   succeed and then fail the moment Claude Code tried to start the server.
>
> (An earlier revision of this page also listed "no marketplace" as a blocker. That is
> fixed: `.claude-plugin/marketplace.json` now exists and lists this plugin with
> `"source": "./"`, so the repo is its own single-plugin marketplace.)
>
> The npm publish is tracked as an outstanding human step in
> [`release-checklist.md`](release-checklist.md) (step 8, then step 11).
> Treat everything below as the intended flow, **not** a verified transcript.
>
> For the complete Meta-app walkthrough (creating the app, adding the Instagram product,
> roles/testers, scopes, App Review reality) and for how to obtain a token at all, see
> **[`setup-guide.md`](setup-guide.md)** — this page does not repeat it. This document
> covers only what is specific to the plugin channel: **how it installs**, and **how the
> token reaches the server when the manifest carries no credential fields.**

## Which channel is this? (the ten-second version)

The project ships four install channels off the same code. They differ mainly in **who
launches the server** and **where the token comes from**:

| Channel | Manifest | Client | Token supplied via |
| --- | --- | --- | --- |
| npm / `npx` | `package.json` | any MCP client | the `env` block **you** write in `claude_desktop_config.json` / `.mcp.json`, or the env file |
| MCP registry | `server.json` | registry-aware clients | the client's own config |
| MCPB bundle | `manifest.json` | Claude **Desktop** | a **GUI form** (`user_config`), stored in the OS keychain |
| **Claude Code plugin** | **`.claude-plugin/plugin.json`** | Claude **Code** | **a prompt at install time (`userConfig`), stored in the OS keychain — with the env file as a fallback (Step 2)** |

Pick this channel if: you use Claude Code, you want the server enabled across projects
with a single install, and you want the token prompted for once and kept in the keychain
rather than pasted into every project's `.mcp.json`. Pick **npm/`npx`** instead if you
want per-project control over the token or you are not on Claude Code. Pick **MCPB** if
you are on Claude **Desktop**.

## What the plugin manifest declares

The whole manifest is metadata, one prompted credential, and one stdio server:

```jsonc
{
  "name": "instagram-mcp-ai",
  // …displayName / author / homepage / repository / license / keywords…
  "userConfig": {
    "IG_ACCESS_TOKEN": {
      "type": "string",
      "title": "Instagram access token",
      "description": "…",
      "sensitive": true,   // → OS keychain, never settings.json
      "required": true     // → the install prompts, and will not skip
    }
  },
  "mcpServers": {
    "instagram": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "instagram-mcp-ai@<version>"],
      "env": { "IG_ACCESS_TOKEN": "${user_config.IG_ACCESS_TOKEN}" }
    }
  }
}
```

Four consequences worth internalizing before you go further:

- **The plugin is a launcher, not a copy of the server.** It carries no `dist/`, no
  `node_modules`; it just tells Claude Code to run the published npm package. The
  `@<version>` pin is deliberate and is kept in lockstep with `package.json` by the
  drift test — a plugin release always serves one exact npm version.
- **Installing prompts you for the token.** `userConfig` is the plugin-channel
  counterpart of MCPB's `user_config`. `sensitive: true` routes the value to the OS
  keychain rather than `settings.json`; `required: true` means the install will not
  complete without it. So, like the MCPB bundle and unlike a bare `npx` config, this
  channel *does* have a form.
- **`env` is the wire between the two.** `"${user_config.IG_ACCESS_TOKEN}"` interpolates
  the prompted value into the server's process environment at launch. The key on the left
  is the variable the server reads; the key inside `${user_config.…}` is the `userConfig`
  entry it comes from. They match here on purpose — a test asserts every `env` mapping
  interpolates *its own* `userConfig` key rather than a neighbour's, because a
  copy-paste slip there silently ships the wrong credential.
- **One token variable, both auth paths.** `IG_ACCESS_TOKEN` is the *only* token variable
  the server reads, whether you authenticated via Instagram Login or Facebook Login.
  There is no second `IG_FB_ACCESS_TOKEN`; a manifest or doc that names one is describing
  a variable no code reads, and `plugin-manifest.test.ts` fails the build over it.

Step 2 is therefore no longer the only thing that makes the server start — but it is still
worth reading, because the env file is what makes the token survive across reinstalls and
what the `login`/`refresh` commands actually write.

## Step 1 — install the plugin

Claude Code loads plugins in two ways: **installed from a marketplace** (persistent), or
**loaded for the duration of one session** from a local directory.

### 1a. From a marketplace — the intended route

Installing is a two-step flow: register the catalog, then install a plugin out of it.
This repo **is** its own catalog, so both names below are known and fixed:

```
/plugin marketplace add IvanBBaev/instagram-mcp
/plugin install instagram-mcp-ai@instagram-mcp
/reload-plugins
```

There are non-interactive equivalents for scripting, which install to user scope unless
`--scope user|project|local` says otherwise:

```bash
claude plugin marketplace add IvanBBaev/instagram-mcp
claude plugin install instagram-mcp-ai@instagram-mcp
```

The two names are **not** the same string and are easy to swap by accident:
`instagram-mcp-ai` is the plugin's `name` in `plugin.json`, while `instagram-mcp` is the
marketplace's `name` in `marketplace.json` — the catalog, not the plugin. The install
prompts for `IG_ACCESS_TOKEN` at this point, per `userConfig`.

> **The install will succeed and the server will still fail to start**, until
> `instagram-mcp-ai` exists on npm at the pinned version — see the status banner. There
> is nothing wrong with the marketplace; the launcher just has nothing to launch yet.

### 1b. From a local clone — for trying it before it ships

Claude Code can also load a plugin directly from a directory for the duration of a
session, without any marketplace, via the `--plugin-dir` command-line flag (there is a
`--plugin-url` sibling). A session-loaded plugin shows up in the `/plugin` interface but
has no installed record, so a plain `claude plugin list` will not show it.

> **`[unverified]`** — the Claude Code CLI was not available in the environment this page
> was written in, so the flag's exact argument shape (whether it takes the plugin
> directory itself or a parent directory containing plugins, and whether it may be
> repeated) **was not confirmed against `claude --help`**. Check
> `claude --help` on your machine before relying on it. What *is* confirmed from this
> repo is the layout the flag would be pointed at: the manifest is at
> `<repo>/.claude-plugin/plugin.json`, i.e. the plugin root is the repo root.

Either way, remember the manifest still runs `npx -y instagram-mcp-ai@<version>`. Until
that version exists on npm, a local plugin load gets you a registered-but-broken server.
To exercise the code before publication, skip the plugin channel entirely and point an
MCP client at your build (`node dist/src/index.js`) — see
[`setup-guide.md`](setup-guide.md) §9.

## Step 2 — get `IG_ACCESS_TOKEN` to the server

The manifest's `userConfig` prompt is the primary route and covers the normal case: you
paste the token once at install time and Claude Code injects it through `env` on every
launch. This section is for everything *around* that — where the token comes from in the
first place, and what happens when you would rather not retype it.

The important mechanical detail: the manifest's `env` block puts `IG_ACCESS_TOKEN` into
the **real process environment**, which is row #1 below. So a token supplied through the
install prompt **outranks every env file**. The env-file routes matter when you have no
prompted value (a session-loaded plugin, a re-install, a CI-ish setup), or when you want
the credential managed by `login`/`refresh` in one place instead of pasted per install.

The server's entry point resolves configuration in a fixed order before it builds any
account profile:

| # | Source | Notes |
| --- | --- | --- |
| 1 | **The real process environment** | Always wins — and this is where the plugin's `userConfig` → `env` injection lands. Claude Code otherwise gives plugin MCP servers "access to the same environment variables as manually configured servers", i.e. the server also sees the environment Claude Code itself was launched with. Env-file loading uses `override: false`, so nothing below can overwrite a variable that is already set. |
| 2 | **`IG_ENV_FILE`**, if set and non-blank | **Exclusive.** When this points at a file, that file is the *only* env file loaded — both defaults below are skipped. It must itself come from the real environment (it is read before any file is opened), so you cannot set it *inside* an env file. |
| 3 | **`<config home>/instagram-mcp-ai/.env`** | The canonical token home, and the file the `login` / `refresh` commands write. Config home is `$XDG_CONFIG_HOME` (default `~/.config`) on macOS/Linux and `%APPDATA%` (default `<home>\AppData\Roaming`) on Windows. |
| 4 | **`<cwd>/.env`** | The project fallback, resolved against the server process's working directory. Loaded *after* #3, so with `override: false` **the config-home file wins** for any key both define. |

Files at #3 and #4 are only read if they exist; both are loaded when both exist. If, after
all of that, `IG_ACCESS_TOKEN` is still unset, the server refuses to start with
`No default profile configured; set IG_ACCESS_TOKEN (the default account token).`

> **`[unverified]`** — what working directory Claude Code hands a plugin-launched stdio
> server (row #4) was not confirmed. Do not rely on a project `.env` being picked up on
> this channel; use row #3, which is an absolute path and therefore cwd-independent.

### Where the token comes from: the config-home env file

Before you can paste anything into the install prompt you have to *have* a token, and
`login` is what mints one. It writes to `~/.config/instagram-mcp-ai/.env` (or
`%APPDATA%\instagram-mcp-ai\.env` on Windows) — which is also a perfectly good place to
leave it: every project's Claude Code session picks it up, no prompt needed, and
`refresh` keeps it current in that one file rather than in a keychain entry you would
have to re-paste by hand every ~60 days.

Normally you would not write it by hand — `instagram-mcp-ai login` performs the browser
OAuth, exchanges the code for a long-lived (~60-day) token and writes that file
atomically with `chmod 0600` on POSIX, printing no secret. Since the npm package is not
published, run it from a clone instead:

```bash
git clone https://github.com/IvanBBaev/instagram-mcp.git
cd instagram-mcp
npm install && npm run build
IG_APP_ID=... IG_APP_SECRET=... node dist/src/index.js login --path ig
```

Or write the file yourself — plain `KEY=value` lines, and **restrict the permissions
yourself** (`chmod 600`), because nothing else will:

```bash
# ~/.config/instagram-mcp-ai/.env      (chmod 600 — never commit this)
IG_ACCESS_TOKEN=<long-lived ig-login token>
IG_ACCOUNT_ID=<ig professional-account id>   # optional: skips a lookup
```

That is Path A (Instagram Login). Path B (Facebook Login) puts its token in the **same**
`IG_ACCESS_TOKEN` variable and adds `IG_APP_ID` + `IG_APP_SECRET`; the full catalog with
inline comments is [`../.env.example`](../.env.example), and the path choice is explained
in [`../README.md`](../README.md#configure-credentials) and
[`setup-guide.md`](setup-guide.md) §6.

### The other route: export it before launching Claude Code

Because row #1 outranks everything, exporting the variable in the shell you start Claude
Code from also works, and is handy for a one-off check:

```bash
export IG_ACCESS_TOKEN='<long-lived ig-login token>'
claude
```

This is a **worse** default than the env file: it dies with the shell, it does not reach a
Claude Code started from a desktop launcher rather than a terminal, and it puts a
long-lived credential in your shell history or profile. Prefer the env file; keep this for
debugging.

## Step 3 — writes are `preview` by default

`IG_WRITE_MODE` defaults to **`preview`**. A mutating tool call returns a non-mutating
plan of exactly what *would* change and sends nothing to Meta. **This is not a broken
publish path — it is the write gate doing its job.** To actually execute a write, either:

- pass `apply: true` on the individual tool call (per-call consent), or
- set `IG_WRITE_MODE=apply` for standing consent.

Irreversible operations (e.g. `instagram_delete_comment`) are double-gated and
additionally require `IG_ALLOW_DESTRUCTIVE=true`. Applied writes are appended to a local
JSONL journal for auditing. Details in [`security.md`](security.md) and
[`../README.md`](../README.md#write-safety).

**The install prompt does not cover these.** `userConfig` declares exactly one entry,
`IG_ACCESS_TOKEN`, so on this channel the write knobs live only in the config-home env
file or the exported environment, per Step 2 — there is no per-plugin form to flip them
in. That asymmetry is deliberate: a credential is worth a keychain-backed prompt, while
turning off the write gate should require editing a file on purpose.

## Step 4 — verify

The server ships a read-only health check that resolves config, checks the token and
performs exactly one reachability GET, exiting `0` when healthy:

```bash
instagram-mcp-ai doctor        # or, from a clone: node dist/src/index.js doctor
```

Run it in the same environment Claude Code will run in — if `doctor` cannot find the
token, neither will the plugin. Inside Claude Code, `/mcp` lists MCP servers including
plugin-provided ones. Failure symptoms and fixes are tabulated in
[`troubleshooting.md`](troubleshooting.md).

## Why the plugin is not inside the npm package

`package.json`'s `files` field is an **allowlist**, and `.claude-plugin/` is deliberately
left out of it — a packaging test asserts that exclusion
([`../test/release/packaging.test.ts`](../test/release/packaging.test.ts)).

That is intentional, not an oversight. The plugin channel is served **from git** (a
marketplace clones the repo); it is never resolved out of `node_modules`. Shipping
`.claude-plugin/` inside the tarball would add a manifest nothing reads to every `npx`
run, and would create a second, stale copy of the version pin the moment a tarball lagged
the repo. The two channels stay cleanly separated: npm ships the runtime, git ships the
plugin that launches it.

## What has to happen before this page loses its status banner

1. ~~The repo gains a `.claude-plugin/marketplace.json` listing this plugin.~~ **Done** —
   the catalog exists, validates against its schema, and names the pair
   `instagram-mcp-ai@instagram-mcp`.
2. `instagram-mcp-ai` is published to npm at the version the manifest pins. **This is the
   only remaining blocker.**
3. The verified `--plugin-dir` invocation is filled into Step 1b, replacing the
   `[unverified]` note.
4. A clean-machine install test is run: `/plugin marketplace add`, `/plugin install`,
   answer the `IG_ACCESS_TOKEN` prompt, start Claude Code, confirm the server connects and
   a read tool returns real data. In particular, confirm the prompted value really does
   reach the server through `${user_config.IG_ACCESS_TOKEN}` — that interpolation is
   schema-valid and unit-asserted in-tree, but it has never been executed by a real client.

Until then, use the **npm/`npx` client-config route** in
[`../README.md`](../README.md#quickstart) — same server, same tools, credentials in your
own `.mcp.json`.
