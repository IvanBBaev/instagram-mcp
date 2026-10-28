# Privacy Policy

> Applies to `instagram-mcp-ai`: the npm package, the Claude Code plugin
> (`plugins/instagram-mcp-ai`) and the Claude Desktop bundle (`manifest.json`).
> Last updated 2026-10-28. Changes to this policy are made in this file, so its
> git history is the full record of every change. The controls behind each
> statement are described in [security.md](security.md) and [auth.md](auth.md).

## Summary

`instagram-mcp-ai` is a local program. It runs on your own machine, started by
your MCP client (Claude Desktop, Claude Code or another client), and acts on the
one Instagram professional account you configure. The project has no server,
no account system and no database of its own. **The author receives no data from
it**: there is no telemetry, no analytics, no crash reporting and no phone-home.
The server talks to Meta's Graph API and to the MCP client that started it, and
to nothing else.

## Who processes your data

| Party | What it receives | Whose policy applies |
|---|---|---|
| This server, on your machine | Your credentials and the Graph API responses for the calls you make | This document |
| Meta (Instagram / Facebook) | The Graph API requests the server sends on your behalf, with your access token | [Meta Privacy Policy](https://www.facebook.com/privacy/policy/) |
| Your MCP client, and the model provider behind it | Every tool result the server returns, and the confirmation prompts it shows | The client's and the model provider's own policies |

Meta is the source of all the Instagram data the server handles. The server
does not add data from any other source and does not send data to any party
other than Meta and your MCP client.

## Data the server handles

When a tool is called, the server requests the matching data from the Graph API
and returns it to the MCP client. Depending on the tools you use, that is:

- your account's profile (username, name, biography, website, profile picture
  URL, follower, following and media counts) and the Facebook Pages linked to
  your token;
- your media, stories, captions and the comments on your media, including the
  usernames and text of the people who wrote them;
- media and comments in which your account is tagged or mentioned;
- account and media insights, and audience demographics as Meta reports them
  (aggregated, never per person);
- public media for a hashtag you search, and the public profile and media of
  another business or creator account you look up;
- for writes you approve: the caption, media URLs and comment text you supply.
  Media URLs are passed to Meta, which fetches them; the server never downloads
  a URL itself.

This data passes through the server in memory and is returned to your MCP client.
The server does not store Graph API responses on disk. The one thing it keeps
in memory for the life of the process is the hashtags already searched and when,
so it can count them against Meta's limit of 30 unique hashtags per 7 days.

Before any result leaves the server, a redaction layer masks your configured
tokens and secrets, and anything shaped like a Meta token, in results, errors,
confirmation prompts and logs ([security.md](security.md) §2).

## Where your data goes over the network

- **Graph API calls** go only to `graph.instagram.com` and `graph.facebook.com`,
  over HTTPS. A hard host allowlist refuses every other host, including
  redirect targets ([security.md](security.md) §3).
- **The `login` command** (optional, run by you) opens Meta's authorization page
  on `www.instagram.com` or `www.facebook.com` in your browser, exchanges the
  returned code with Meta's OAuth endpoints, and receives the redirect on a
  listener bound to your own machine (`127.0.0.1` or `localhost`).
- **The MCP connection** runs over stdio by default. The optional HTTP transport
  (`IG_TRANSPORT=http`) refuses to bind anything but a loopback address, so it
  is never reachable from the network ([security.md](security.md) §3).
- **Installation** through the plugin runs `npx` with a pinned
  `instagram-mcp-ai` version, so npm downloads the package from the npm
  registry. That download is npm's traffic; the server itself does not contact
  npm.

## Data stored on your machine

| What | Where | Contents |
|---|---|---|
| Credentials | Your MCP client's configuration, the OS keychain (Claude Desktop and Claude Code store the token prompt there), or the env file written by `login` / `refresh` (`<XDG_CONFIG_HOME or ~/.config>/instagram-mcp-ai/.env`, `%APPDATA%\instagram-mcp-ai\.env` on Windows, or the file `IG_ENV_FILE` names) | Access token, account id and, if you configure them, app id and app secret. The env file is written with mode `0600` ([auth.md](auth.md) §4) |
| Write journal | `$XDG_STATE_HOME/instagram-mcp-ai/writes.jsonl` (default `~/.local/state/instagram-mcp-ai/writes.jsonl`), or the path `IG_WRITE_JOURNAL` names | One line per write you applied: time, action, profile name, auth path, a one-line summary, the target object id, the outcome and whether it was destructive. It holds no captions and no comment text, and it is redacted before it is written. File mode `0600`, directory `0700` |
| Logs | Standard error of the server process | Structured JSON: request method, host and path, plus per-tool fields chosen to be safe to log. Request URLs and bodies are never logged, and secrets are redacted. What happens to the stream afterwards is up to your MCP client |

Apart from these files, and the short-lived `.lock` and temporary files `login` /
`refresh` use while they rewrite the env file, nothing is written to disk.

## Retention and deletion

The server keeps no data beyond the files listed above, and it never deletes or
rotates them on its own: they stay until you remove them.

- Delete the write journal or the env file at any time; the server recreates the
  journal on the next applied write.
- Remove the token from your MCP client or keychain to stop all access.
- Revoke the app's access in your Instagram or Facebook settings to invalidate
  the token at Meta.
- Data you published or changed on Instagram through the server lives on
  Instagram and is governed by Meta's policy. Deleting it is done through
  Instagram (or the server's delete tools).

## Sharing and sale

The project does not sell, rent or share your data. The author never receives
it, so there is nothing to share. The only parties that receive data are the
ones in the table above, and only because you call the tools that reach them.

## Contact

Questions about this policy: open an issue at
<https://github.com/IvanBBaev/instagram-mcp/issues>. Security reports go through
the private channel described in
[SECURITY.md](https://github.com/IvanBBaev/instagram-mcp/blob/main/SECURITY.md).
