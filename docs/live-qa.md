# Live QA runbook

This page is for the owner. It explains how to run the live-QA runner against a real
Instagram account and how to turn a green report into milestone statuses. The
milestones are M1–M4 in [roadmap.md](roadmap.md) and Lane E (`T-E1`–`T-E4`) in
[workplan.md](workplan.md). As of 2026-09-23 nothing on this page has been run
against Meta, because this environment has no live credentials. The runner has
been verified only against a local fake of the Graph API.

## Two harnesses and what each proves

| Harness | How it talks to Instagram | What a PASS proves |
|---|---|---|
| `scripts/live-qa.mjs` | Spawns the **built** server (`dist/src/index.js`) and drives it over stdio as an MCP client: `initialize`, `tools/list`, `tools/call`. It does not import `src/api/*`. | The product works on this account. The registry, input and output schemas, write gate, elicitation prompt, redaction, journal and transport all behave correctly against live Graph responses. This is the evidence the M1–M4 exit gates ask for. |
| `scripts/live-probe.mjs` | Calls the api layer and the request seam directly. | What Meta actually sends on the wire for the open rows of [corner-cases.md](corner-cases.md) §9. A mapped domain object is not evidence of that, so these rows need the wire view. |

You need both, and `live-qa.mjs --with-wire-probes` runs both and merges the results
into one report.

## What the owner must provide

1. **A throwaway professional Instagram account** (Business or Creator) that you are
   happy to post stories and comments on. It needs at least one feed post, because
   the comment round-trip is run against the newest feed item. It should not be a
   real brand account.
2. **Path A (ig-login) credentials**, which exercise the default path:
   - `IG_ACCESS_TOKEN`: a long-lived Instagram-Login token, which `npx instagram-mcp-ai login --path ig`
     can mint.
   - Optional: `IG_ACCOUNT_ID`. If it is set, the `get-account` probe also checks
     that it matches the account the token resolves to.
   - Scopes: `instagram_business_basic`, `instagram_business_content_publish`,
     `instagram_business_manage_comments`, `instagram_business_manage_insights`.
3. **Path B (fb-login) credentials**, which exercise the discovery tools and
   token introspection:
   - `IG_AUTH_MODE=fb-login`
   - `IG_ACCESS_TOKEN`: a Facebook user or page token.
   - `IG_ACCOUNT_ID`
   - `IG_APP_ID` and `IG_APP_SECRET`
   - Scopes: `instagram_basic`, `instagram_content_publish`,
     `instagram_manage_comments`, `instagram_manage_insights`, `pages_show_list`,
     `pages_read_engagement`, `business_management`.
   - For T-E3 the app should be in Development mode, with you as an admin, so the
     hashtag probes test the own-app-admin case.
   - The simplest setup is a named profile (`IG_PROFILE_FB_*`) next to the Path-A
     default. See [setup-guide.md](setup-guide.md).
4. **For the write probes only:** a public HTTPS URL to a JPEG. Meta fetches it
   server-side, so it must not require authentication. It is used for the story
   and the unpublished containers.

Credentials are read exactly as the server reads them:

- process env first;
- then `IG_ENV_FILE`, or the XDG env file (`~/.config/instagram-mcp-ai/.env`);
- then `./.env`.

The runner has no credential variables of its own.

## Commands

Build first, because the runner drives `dist/`:

```sh
npm run build
node scripts/live-qa.mjs --plan          # the probe list; no network, no credentials
```

**Read-only runs.** These are safe on any account. The server is started with
`IG_WRITE_MODE=preview` and `IG_ALLOW_DESTRUCTIVE=false`, whatever your env file says.

```sh
node scripts/live-qa.mjs                                 # Path A (default profile)
node scripts/live-qa.mjs --profile fb                    # Path B via a named profile
node scripts/live-qa.mjs --profile fb --with-wire-probes # + live-probe.mjs, read-only lanes
```

**Write runs.** These need an interactive terminal:

```sh
node scripts/live-qa.mjs --write --image-url https://example.com/probe.jpg
node scripts/live-qa.mjs --write --image-url https://example.com/probe.jpg --with-wire-probes
```

`--write` does four things:

1. It lists what will be created.
2. It asks you to type `write`.
3. It starts a second server session with elicitation enabled. The server then asks
   for confirmation before **each** write, and the runner shows you each prompt with
   a `y/N` answer.
4. It points `IG_WRITE_JOURNAL` at a temp file, which the runner reads and then
   deletes.

With no terminal, the write probes are reported as SKIP and nothing is written.
`--with-wire-probes` combined with `--write` passes `--allow-writes` to
`live-probe.mjs`. The two irreversible live-probe lanes are never started from
here:

- `--allow-feed-post` publishes a feed post, which cannot be deleted through the API.
- `--allow-token-refresh` rotates the credential.

Run those by hand, last, as [workplan.md](workplan.md) §6 describes.

Other flags:

| Flag | Effect |
|---|---|
| `--only <probe \| T-E2 \| M4>` | Narrows the run. |
| `--media-id <id>` | Picks the post to comment on. |
| `--discovery-username <name>` | Sets the `business_discovery` target. |
| `--no-cleanup` | Keeps the probe comment. |
| `--out <dir>` | Sets the report directory. The default is `dist/live-qa/`, which is gitignored. |
| `--timeout-ms <n>` | Sets the per-call timeout. |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | No FAIL. SKIPs are allowed. |
| 1 | At least one FAIL, or a failing wire-probe run. |
| 2 | The runner could not start: no `dist/`, or a bad argument. |

With no credentials at all, the runner writes an all-SKIP report and exits 0.

## The report

The runner writes `live-qa-report.md` and `live-qa-report.json` to the out directory.
Each probe row shows:

- its task (`T-E1`–`T-E4`);
- its milestone gate (M1–M4);
- the corner cases it bears on;
- PASS, FAIL or SKIP, with a reason or finding.

The report also has a per-gate summary and a table mapping each open §9 `[verify]`
row to the probes that answer it.

Evidence is recorded as a **shape**, not as a payload:

- **Kept:** key names, types and counts, plus a short allowlist of enum-valued
  fields such as `mode`, `status`, `kind`, `expiryState`, `media_product_type`,
  and error `code` and `subcode`.
- **Replaced:** ids, captions, usernames and URLs become `<string N>`.
- **Before writing:** the whole report goes through the production redactor,
  `assertFixtureSafe`, and an exact-substring check against every token, app
  secret and `appsecret_proof` of every profile.

The report still describes a real account, so keep it out of git.

## What each probe proves

| Probe | Task · gate | What PASS means |
|---|---|---|
| `fixture-capture` | T-E1 · M1 | Always SKIP. Live fixture capture is `node scripts/capture-fixtures.mjs`, run by hand after a green read run. Review the captured files before committing them. |
| `handshake` | T-E2 · M1 | The server boots on the live profile and lists the right tool set for the auth path. The discovery tools are listed on Path B only. |
| `get-account` | T-E2 · M1 | The token resolves to a professional account, whose id matches `IG_ACCOUNT_ID` when that is set (CC-AUTH-6). |
| `token-status` | T-E2 · M1 | Expiry is reported honestly. On Path B that means introspected, including the data-access window. On Path A it means recorded, or else unknown (CC-AUTH-7, CC-AUTH-12). |
| `linked-accounts` | T-E2 · M1 | Path B only: the Page to IG-account enumeration works. |
| `list-media`, `get-media` | T-E2 · M1 | Reads work. The evidence lists which optional fields Meta omitted and on how many items (CC-DATA-2). |
| `list-comments`, `list-tagged-media` | T-E2 · M3 | The read half of moderation works. An empty list is a PASS. |
| `publishing-limit` | T-E2 · M2 | The 24-hour quota read works (CC-PUB-12). |
| `account-insights`, `media-insights` | T-E2 · M4 | Insights come back and conform to the published output schema. |
| `insights-time-series` | T-E2 · M4 | Daily `reach` over three days. The evidence is the time of day of every bucket `end_time`, which is the answer to CC-INS-4. |
| `online-followers`, `audience-demographics` | T-E2 · M4 | Meta withholds these below a follower threshold. A **typed** error is a PASS. An untyped error, or a result the MCP client rejects, is a FAIL. |
| `preview-by-default` | T-E2 · M2 | A composite write without `apply` returns `mode: preview` against the live account, and nothing is published. |
| `destructive-blocked` | T-E2 · M3 | `delete_comment` with `apply: true` but without `IG_ALLOW_DESTRUCTIVE` is blocked as a preview. |
| `hashtag-search`, `hashtag-media`, `business-discovery` | T-E3 · M1 | Path B only. This is the PCA question: does hashtag search work for an own-app admin without App Review? A PASS confirms that `discovery` stays registered. A permission FAIL is the signal to apply the one-line reversal in [roadmap.md](roadmap.md). |
| `story-publish` | T-E4 · M2 | A story is published through the composite, after an elicitation yes, then read back, and its story insights are fetched. The story expires in 24 hours. |
| `double-publish` | T-E4 · M2 | Publishing one STORIES container twice does not create a second story. The finding records what the second call returned (CC-PUB-4). |
| `caption-at-cap` | T-E4 · M2 | Meta accepts a container with a 2,200-code-point caption made of non-BMP emoji. The container is never published. At 2,201, the server refuses before any Graph call (CC-PUB-11). |
| `comment-round-trip` | T-E4 · M3 | Create, hide, unhide, then delete a comment on your own post. The delete always runs, unless you pass `--no-cleanup`. |
| `write-journal` | T-E4 · M2 | Every applied write left one parseable journal line (CC-PUB-16, CC-PROC-5). |

Two open §9 rows are answered only by the wire harness, so they report `NOT RUN`
unless you pass `--with-wire-probes`:

- CC-COM-6, the comment-length ladder.
- CC-AUTH-14, the fate of the old token after a refresh. `live-qa.mjs` never runs
  this one, because it rotates the credential.

## After a run: flipping the statuses

A status changes only on evidence from a real account. A fake-Graph run never counts.

1. **Transcribe the findings first.** For each §9 row that the report answers, write
   the observed behaviour into [corner-cases.md](corner-cases.md) §9, with the date
   and auth path, and close its `[verify]` marker. Record the T-E3 verdict in
   [auth.md](auth.md) §5.
2. **Flip a milestone only when all of its gate's probes PASS on both auth paths,
   where the probe applies to both.** SKIP does not count as PASS, except for
   probes restricted to the other path.
   - **M1:** all M1 probes on Path A and Path B, plus `T-E3` answered either way.
   - **M2:** all M2 probes, including the write probes, on at least one path.
   - **M3:** all M3 probes, including `comment-round-trip`, on at least one path.
   - **M4:** all M4 probes on both paths. A typed-error PASS for the
     follower-threshold probes is acceptable. Note it in the row.
3. **Update both documents in the same change.**
   - The milestone row in [roadmap.md](roadmap.md) §"Current state" goes from
     **PARTIAL** to **DONE**, with the run date.
   - The matching `T-E*` rows in [workplan.md](workplan.md) go from
     **HARNESS DONE · EXECUTION BLOCKED** to **DONE**.
   - A FAIL is not a status change. File it as a corner case, and keep the
     milestone PARTIAL until the fix passes a re-run.
4. Delete the local report once its content has been transcribed.
