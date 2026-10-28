# Instagram MCP (Claude Code plugin)

This plugin connects Claude Code to one Instagram professional account (Business
or Creator) through Meta's official Instagram Graph API. It adds tools to read
your profile, media, comments, insights and hashtag results, and, after you
approve each one, to publish posts and reply to or moderate comments.

## What the plugin runs

Enabling the plugin starts one local MCP server over stdio:
`npx -y instagram-mcp-ai@<pinned version>`, where the version is fixed in
`.claude-plugin/plugin.json`. npm downloads that package from the npm registry
the first time. The plugin ships no hooks, commands, agents or skills.

## What it asks for

When you enable the plugin, Claude Code asks for one value, the Instagram access
token (`IG_ACCESS_TOKEN`). It is marked sensitive, so Claude Code stores it in
your OS keychain rather than in `settings.json`. Get a token with
`npx instagram-mcp-ai login`; see
[docs/plugin-install.md](https://github.com/IvanBBaev/instagram-mcp/blob/main/docs/plugin-install.md).

## What it sends and stores

The server sends requests only to Meta's Graph API hosts, `graph.instagram.com`
and `graph.facebook.com`, and refuses every other host. It has no telemetry. It
returns tool results to Claude Code, keeps no copy of the Instagram data it
reads, and writes one local file: a journal of the writes you applied, holding
no captions or comment text. Writes preview by default, and deletes need a
second explicit opt-in.

## Privacy Policy

See the [Privacy Policy](https://github.com/IvanBBaev/instagram-mcp/blob/main/docs/privacy.md)
for what data the server handles, where it goes, what it stores on your machine
and how to delete it.

## More

Source, full tool reference and security model:
<https://github.com/IvanBBaev/instagram-mcp>. License: MIT.
