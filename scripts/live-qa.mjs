/**
 * Live-QA runner (workplan Lane E: T-E2, T-E3, T-E4; corner-cases §9).
 *
 * `scripts/live-probe.mjs` answers the §9 `[verify]` rows at the WIRE: it calls
 * the api layer and the request seam directly, because a mapped domain object is
 * not evidence about what Meta sent. This runner answers the other half of the
 * milestone exit criteria — does the product an operator actually installs work
 * against a live account? It spawns the BUILT server over stdio, speaks MCP to it
 * exactly as a client would (`initialize`, `tools/list`, `tools/call`), and
 * records what came back. Nothing here imports `src/api/*`: every call goes
 * through the registry, the write gate, the output schemas and the transport.
 *
 * Usage (requires a built `dist/`, i.e. `npm run build`):
 *
 *     node scripts/live-qa.mjs --plan                     # probe list, no network
 *     node scripts/live-qa.mjs                            # read-only session
 *     node scripts/live-qa.mjs --with-wire-probes         # + live-probe.mjs, folded in
 *     node scripts/live-qa.mjs --write --image-url https://…/probe.jpg
 *
 * Guarantees:
 *
 *  1. **Read-only unless told otherwise, and then only after a human says yes.**
 *     The read session runs the server with `IG_WRITE_MODE=preview` and
 *     `IG_ALLOW_DESTRUCTIVE=false` forced into its environment, whatever the
 *     operator's env file says. Write probes need `--write`, an interactive
 *     terminal, a typed confirmation before the write session starts, AND a
 *     y/N answer to every MCP elicitation prompt the server sends for each
 *     individual write. No terminal, no writes: they SKIP with that reason.
 *  2. **It cleans up what it creates, where the API allows.** Comments are
 *     deleted after the hide/unhide round-trip (in a `finally`). Stories expire
 *     in 24 h; unpublished containers expire unused. No feed post is ever
 *     published by this runner — that stays behind live-probe's own separate
 *     `--allow-feed-post` flag, run by hand.
 *  3. **No secret reaches the terminal or the report.** Every profile's token,
 *     app secret and `appsecret_proof` are registered with the production
 *     redactor before the server starts. Evidence is recorded as a SHAPE (key
 *     names, types, counts, and a short allowlist of enum-valued fields such as
 *     `mode`, `status`, `kind`) rather than as payload values, so an id, a
 *     caption or a username cannot land in it by construction; the serialized
 *     report is then passed through the redactor, `assertFixtureSafe`, and an
 *     exact-substring check against every registered secret before it is
 *     written.
 *  4. **No credentials is a clean SKIP, not an error.** Every probe is reported
 *     SKIP with the reason and the process exits 0, so the runner can sit in a
 *     checklist on a machine that has never seen a token.
 *
 * Exit codes: 0 = no FAIL (SKIPs allowed), 1 = at least one FAIL, 2 = the runner
 * itself could not start (no `dist/`, bad arguments).
 *
 * A plain ESM script outside `tsconfig` and outside the coverage include set,
 * like the other two harnesses in this directory; it imports the COMPILED
 * modules from `dist/`. Credentials are read the way the server reads them —
 * same variables, same env files — there are no runner-only credential names.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: node scripts/live-qa.mjs [options]

  --plan                   Print the probe plan and exit (no dist/, no network).
  --write                  Also run the write probes (story publish, double publish,
                           caption-cap container, comment round-trip). Needs an
                           interactive terminal and a typed confirmation.
  --image-url <url>        Public JPEG for the story / container write probes.
  --media-id <id>          Own FEED media to comment on (default: newest feed item).
  --discovery-username <u> Business account for business_discovery (default: instagram).
  --profile <name>         Named profile (IG_PROFILE_<NAME>_*) instead of the default.
  --only <probe|task|gate> Run only matching probes (e.g. get-account, T-E3, M4).
  --with-wire-probes       Also run scripts/live-probe.mjs (read-only; with --write it
                           gets --allow-writes) and fold its verdicts into the report.
  --no-cleanup             Keep the comment the round-trip probe creates.
  --out <dir>              Report directory (default: dist/live-qa — gitignored).
  --timeout-ms <n>         Per tool-call timeout (default 120000; writes get 5x).
  --help                   This text.
`;

// --- Arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    plan: false,
    write: false,
    withWireProbes: false,
    cleanup: true,
    timeoutMs: 120_000,
    discoveryUsername: 'instagram',
  };
  const valueOf = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--plan':
        args.plan = true;
        break;
      case '--write':
        args.write = true;
        break;
      case '--with-wire-probes':
        args.withWireProbes = true;
        break;
      case '--no-cleanup':
        args.cleanup = false;
        break;
      case '--image-url':
        args.imageUrl = valueOf(flag, i);
        i += 1;
        break;
      case '--media-id':
        args.mediaId = valueOf(flag, i);
        i += 1;
        break;
      case '--discovery-username':
        args.discoveryUsername = valueOf(flag, i);
        i += 1;
        break;
      case '--profile':
        args.profile = valueOf(flag, i);
        i += 1;
        break;
      case '--only':
        args.only = valueOf(flag, i);
        i += 1;
        break;
      case '--out':
        args.out = valueOf(flag, i);
        i += 1;
        break;
      case '--timeout-ms': {
        const n = Number(valueOf(flag, i));
        if (!Number.isInteger(n) || n <= 0)
          throw new Error('--timeout-ms needs a positive integer');
        args.timeoutMs = n;
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

// --- Evidence ----------------------------------------------------------------

/**
 * Fields whose string VALUE is kept in evidence. Each is an enum or a
 * server-computed label, never operator data. Everything else is reduced to its
 * type, so the evidence cannot carry an id, a caption, a username or a URL.
 */
const SAFE_STRING_KEYS = new Set([
  'mode',
  'status',
  'action',
  'reason',
  'kind',
  'expiryState',
  'authPath',
  'media_type',
  'media_product_type',
  'period',
  'metric_type',
  'breakdown',
  'timeframe',
]);

/** `errorResult`'s typed line: kind, message, optional code and subcode. */
const TYPED_ERROR_LINE =
  /^Instagram error \(([\w-]+)\): ([\s\S]*?)(?: \((?:code (\d+))?(?:, )?(?:subcode (\d+))?\))?$/;

/** Fields whose NUMBER is kept — counters that describe the server, not the person. */
const SAFE_NUMBER_KEYS = new Set(['code', 'subcode', 'daysLeft', 'quota_usage', 'quota_total']);

/** Reduce a payload to its shape. Arrays report their length and their first element. */
function shapeOf(value, key = '', depth = 0) {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.length === 0
      ? { length: 0 }
      : { length: value.length, first: depth < 5 ? shapeOf(value[0], key, depth + 1) : '…' };
  }
  switch (typeof value) {
    case 'object': {
      if (depth >= 5) return '{…}';
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = shapeOf(v, k, depth + 1);
      return out;
    }
    case 'string':
      return SAFE_STRING_KEYS.has(key) && value.length <= 64 ? value : `<string ${value.length}>`;
    case 'number':
      return SAFE_NUMBER_KEYS.has(key) ? value : '<number>';
    case 'boolean':
      return value;
    default:
      return `<${typeof value}>`;
  }
}

/** Every `end_time` string anywhere in a payload (insights buckets). */
function collectEndTimes(value, out = []) {
  if (Array.isArray(value)) for (const v of value) collectEndTimes(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'end_time' && typeof v === 'string') out.push(v);
      else collectEndTimes(v, out);
    }
  }
  return out;
}

/** The time-of-day part of an ISO timestamp — the only part CC-INS-4 is about. */
function timeOfDay(iso) {
  const at = iso.indexOf('T');
  return at === -1 ? '<unparsed>' : iso.slice(at);
}

// --- Probes ------------------------------------------------------------------

/**
 * Each probe states the task (workplan Lane E), the milestone exit gate it is
 * evidence for (roadmap M1-M4), and the corner cases it bears on. `paths`
 * restricts it to one auth path; `write` puts it in the write session.
 *
 * `run` returns `{ status, reason?, evidence?, finding? }` or throws; a throw is
 * a FAIL. `ctx.call(tool, args)` returns `{ ok, data, error }` from the MCP
 * result; `ctx.need(tool)` SKIPs when the tool is not registered.
 */
const PROBES = [
  // ---- T-E1: live fixture capture (its own harness; listed so the report is complete)
  {
    name: 'fixture-capture',
    task: 'T-E1',
    gate: 'M1',
    answers: [],
    describe:
      'Live capture of sanitized Graph fixtures is scripts/capture-fixtures.mjs, run by hand ' +
      'after this report is green; the captured files need a human review before commit.',
    async run() {
      return {
        status: 'SKIP',
        reason: 'manual step: node scripts/capture-fixtures.mjs (see docs/live-qa.md)',
      };
    },
  },
  // ---- T-E2: read path, both auth paths --------------------------------------
  {
    name: 'handshake',
    task: 'T-E2',
    gate: 'M1',
    answers: [],
    describe: 'Server boots on the live profile; initialize + tools/list over stdio.',
    async run(ctx) {
      const names = [...ctx.tools].sort();
      const discovery = names.filter((n) => /hashtag|discover_business/.test(n));
      // D1 registers a Path-B-only tool when ANY configured profile is on Path B.
      const expectDiscovery = ctx.anyFbProfile;
      if (expectDiscovery !== discovery.length > 0) {
        return {
          status: 'FAIL',
          reason: `discovery tools listed: ${discovery.length}; a Path-B profile is configured: ${ctx.anyFbProfile}`,
          evidence: { toolCount: names.length, tools: names },
        };
      }
      return { status: 'PASS', evidence: { toolCount: names.length, tools: names } };
    },
  },
  {
    name: 'get-account',
    task: 'T-E2',
    gate: 'M1',
    answers: ['CC-AUTH-6', 'CC-AUTH-8'],
    describe:
      'instagram_get_account resolves the token to a professional account; ' +
      'with IG_ACCOUNT_ID set, the resolved id must equal it.',
    async run(ctx) {
      const r = await ctx.call('instagram_get_account', {});
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      const id = typeof r.data?.id === 'string' ? r.data.id : undefined;
      if (id === undefined) return { status: 'FAIL', reason: 'no id in the result' };
      ctx.accountId = id;
      const configured = ctx.configuredAccountId;
      const matches = configured === undefined ? null : configured === id;
      if (matches === false) {
        return {
          status: 'FAIL',
          reason: 'resolved id differs from IG_ACCOUNT_ID',
          evidence: { idMatchesConfigured: false },
        };
      }
      return {
        status: 'PASS',
        evidence: { idMatchesConfigured: matches, shape: shapeOf(r.data) },
      };
    },
  },
  {
    name: 'token-status',
    task: 'T-E2',
    gate: 'M1',
    answers: ['CC-AUTH-7', 'CC-AUTH-12'],
    describe:
      'instagram_token_status reports expiry honestly: introspected on fb-login ' +
      '(incl. the data-access window), recorded-or-unknown on ig-login.',
    async run(ctx) {
      const r = await ctx.call('instagram_token_status', {});
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      const state = r.data?.expiryState;
      if (typeof state !== 'string') return { status: 'FAIL', reason: 'no expiryState' };
      if (ctx.authPath === 'fb-login' && r.data?.isValid === false) {
        return { status: 'FAIL', reason: 'debug_token says the token is invalid' };
      }
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },
  {
    name: 'linked-accounts',
    task: 'T-E2',
    gate: 'M1',
    answers: [],
    paths: ['fb-login'],
    describe: 'instagram_list_linked_accounts enumerates the Pages -> IG accounts (Path B only).',
    async run(ctx) {
      const r = await ctx.call('instagram_list_linked_accounts', {});
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },
  {
    name: 'list-media',
    task: 'T-E2',
    gate: 'M1',
    answers: ['CC-DATA-2'],
    describe:
      'instagram_list_media returns a page; evidence records which optional fields ' +
      'Meta actually omitted across the page.',
    async run(ctx) {
      const r = await ctx.call('instagram_list_media', { limit: 10 });
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      const items = Array.isArray(r.data?.items) ? r.data.items : [];
      ctx.media = items;
      const allKeys = new Set(items.flatMap((i) => Object.keys(i)));
      const missing = {};
      for (const key of allKeys) {
        const n = items.filter((i) => !(key in i)).length;
        if (n > 0) missing[key] = n;
      }
      return {
        status: 'PASS',
        evidence: {
          items: items.length,
          productTypes: [...new Set(items.map((i) => i.media_product_type ?? '<absent>'))],
          keysSeen: [...allKeys].sort(),
          omittedPerKey: missing,
          paging: shapeOf(r.data?.paging),
        },
      };
    },
  },
  {
    name: 'get-media',
    task: 'T-E2',
    gate: 'M1',
    answers: ['CC-DATA-2'],
    describe: 'instagram_get_media on the newest item.',
    async run(ctx) {
      const first = ctx.media?.[0];
      if (first === undefined) return { status: 'SKIP', reason: 'the account has no media' };
      const r = await ctx.call('instagram_get_media', { mediaId: first.id });
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },
  {
    name: 'list-comments',
    task: 'T-E2',
    gate: 'M3',
    answers: [],
    describe: 'instagram_list_comments on the newest feed item (read half of M3).',
    async run(ctx) {
      const target = ctx.feedMediaId();
      if (target === undefined) return { status: 'SKIP', reason: 'no feed media to read' };
      const r = await ctx.call('instagram_list_comments', { mediaId: target, limit: 5 });
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },
  {
    name: 'list-tagged-media',
    task: 'T-E2',
    gate: 'M3',
    answers: [],
    describe: 'instagram_list_tagged_media (the account may be tagged nowhere; empty is a PASS).',
    async run(ctx) {
      const r = await ctx.call('instagram_list_tagged_media', { limit: 5 });
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },
  {
    name: 'publishing-limit',
    task: 'T-E2',
    gate: 'M2',
    answers: ['CC-PUB-12'],
    describe: 'instagram_get_publishing_limit reads the 24 h quota the composites re-check.',
    async run(ctx) {
      const r = await ctx.call('instagram_get_publishing_limit', {});
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },
  {
    name: 'account-insights',
    task: 'T-E2',
    gate: 'M4',
    answers: [],
    describe: 'instagram_get_account_insights with the default metric set.',
    async run(ctx) {
      const r = await ctx.call('instagram_get_account_insights', {});
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },
  {
    name: 'insights-time-series',
    task: 'T-E2',
    gate: 'M4',
    answers: ['CC-INS-4'],
    describe:
      'reach/day/time_series across three UTC midnights; evidence is the time-of-day of ' +
      'every bucket end_time — transcribe it into CC-INS-4 (UTC vs account timezone).',
    async run(ctx) {
      const until = Math.floor(ctx.nowMs / 1000);
      const since = until - 3 * 86_400;
      const r = await ctx.call('instagram_get_account_insights', {
        metrics: ['reach'],
        period: 'day',
        metric_type: 'time_series',
        since,
        until,
      });
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      const ends = collectEndTimes(r.data);
      if (ends.length === 0) return { status: 'FAIL', reason: 'no end_time buckets came back' };
      const times = [...new Set(ends.map(timeOfDay))];
      return {
        status: 'PASS',
        evidence: { buckets: ends.length, bucketTimesOfDay: times },
        finding:
          times.length === 1 && /^T00:00:00(\+0000|Z)$/.test(times[0])
            ? 'buckets end at UTC midnight'
            : `buckets end at ${times.join(', ')} — not UTC midnight; record the offset in CC-INS-4`,
      };
    },
  },
  {
    name: 'media-insights',
    task: 'T-E2',
    gate: 'M4',
    answers: ['CC-INS-2'],
    describe: 'instagram_get_media_insights on the newest item, with its own product type.',
    async run(ctx) {
      const first = ctx.media?.[0];
      if (first === undefined) return { status: 'SKIP', reason: 'the account has no media' };
      const args = { media_id: first.id };
      if (typeof first.media_product_type === 'string') {
        args.media_product_type = first.media_product_type;
      }
      const r = await ctx.call('instagram_get_media_insights', args);
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },
  {
    name: 'online-followers',
    task: 'T-E2',
    gate: 'M4',
    answers: [],
    tolerateTypedError: true,
    describe:
      'instagram_get_online_followers. Meta withholds this below a follower threshold; a ' +
      'TYPED error is a PASS (the server mapped it), an untyped one or a crash is a FAIL.',
    async run(ctx) {
      const r = await ctx.call('instagram_get_online_followers', {});
      return ctx.typedOutcome(r);
    },
  },
  {
    name: 'audience-demographics',
    task: 'T-E2',
    gate: 'M4',
    answers: [],
    tolerateTypedError: true,
    describe: 'instagram_get_audience_demographics by country/last_30_days (same tolerance).',
    async run(ctx) {
      const r = await ctx.call('instagram_get_audience_demographics', {
        breakdown: 'country',
        timeframe: 'last_30_days',
      });
      return ctx.typedOutcome(r);
    },
  },
  {
    name: 'preview-by-default',
    task: 'T-E2',
    gate: 'M2',
    answers: [],
    describe:
      'D3 floor, live: instagram_post_story WITHOUT apply returns mode=preview and publishes ' +
      'nothing, even with a real token behind it.',
    async run(ctx) {
      const r = await ctx.call('instagram_post_story', {
        imageUrl: ctx.imageUrl ?? 'https://example.com/live-qa-preview.jpg',
      });
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      if (r.data?.mode !== 'preview') {
        return { status: 'FAIL', reason: `mode is ${String(r.data?.mode)}, not preview` };
      }
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },
  {
    name: 'destructive-blocked',
    task: 'T-E2',
    gate: 'M3',
    answers: [],
    describe:
      'D3 second gate, live: instagram_delete_comment with apply:true and ' +
      'IG_ALLOW_DESTRUCTIVE=false is blocked to a preview; nothing reaches Graph.',
    async run(ctx) {
      const r = await ctx.call('instagram_delete_comment', {
        commentId: '17800000000000000',
        apply: true,
      });
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      if (r.data?.mode !== 'preview') {
        return { status: 'FAIL', reason: `mode is ${String(r.data?.mode)}, not preview` };
      }
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },

  // ---- T-E3: PCA / hashtag (Path B only, read-only) --------------------------
  {
    name: 'hashtag-search',
    task: 'T-E3',
    gate: 'M1',
    answers: ['CC-RATE-4'],
    paths: ['fb-login'],
    describe:
      'The PCA question: does instagram_search_hashtag work for an own-app admin without ' +
      'App Review? PASS confirms keeping `discovery` registered; a permission FAIL is the ' +
      'signal to apply the one-line reversal in roadmap.md.',
    async run(ctx) {
      const r = await ctx.call('instagram_search_hashtag', { hashtag: 'travel' });
      if (!r.ok) {
        return {
          status: 'FAIL',
          reason: 'hashtag search refused',
          evidence: r.error,
          finding: 'T-E3 NO-GO candidate: re-check the PCA feature on the app, then decide.',
        };
      }
      const ids = Array.isArray(r.data?.ids) ? r.data.ids : [];
      ctx.hashtagId = typeof ids[0] === 'string' ? ids[0] : undefined;
      return { status: 'PASS', evidence: shapeOf(r.data), finding: 'T-E3 GO' };
    },
  },
  {
    name: 'hashtag-media',
    task: 'T-E3',
    gate: 'M1',
    answers: [],
    paths: ['fb-login'],
    describe: 'instagram_get_hashtag_media on the id the search returned.',
    async run(ctx) {
      if (ctx.hashtagId === undefined) return { status: 'SKIP', reason: 'no hashtag id' };
      const r = await ctx.call('instagram_get_hashtag_media', {
        hashtagId: ctx.hashtagId,
        edge: 'top',
      });
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },
  {
    name: 'business-discovery',
    task: 'T-E3',
    gate: 'M1',
    answers: [],
    paths: ['fb-login'],
    describe: 'instagram_discover_business on --discovery-username (default: instagram).',
    async run(ctx) {
      const r = await ctx.call('instagram_discover_business', { username: ctx.discoveryUsername });
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      return { status: 'PASS', evidence: shapeOf(r.data) };
    },
  },

  // ---- T-E4: write path (--write + confirmation + per-write elicitation) -----
  {
    name: 'story-publish',
    task: 'T-E4',
    gate: 'M2',
    answers: ['CC-PUB-13'],
    write: true,
    needsImage: true,
    describe:
      'instagram_post_story with apply:true, confirmed at the elicitation prompt; the story ' +
      'self-expires in 24 h. Then get_media + story insights on the new id.',
    async run(ctx) {
      const r = await ctx.call('instagram_post_story', { imageUrl: ctx.imageUrl, apply: true });
      if (!r.ok) return { status: 'FAIL', reason: 'tool returned an error', evidence: r.error };
      if (r.data?.mode === 'refused') return { status: 'SKIP', reason: 'operator declined' };
      if (r.data?.status !== 'published' || typeof r.data?.media_id !== 'string') {
        return { status: 'FAIL', reason: 'not published', evidence: shapeOf(r.data) };
      }
      const media = await ctx.call('instagram_get_media', { mediaId: r.data.media_id });
      const insights = await ctx.call('instagram_get_media_insights', {
        media_id: r.data.media_id,
        media_product_type: 'STORY',
      });
      return {
        status: media.ok && insights.ok ? 'PASS' : 'FAIL',
        reason: media.ok && insights.ok ? undefined : 'read-back of the new story failed',
        evidence: {
          publish: shapeOf(r.data),
          readBack: media.ok ? shapeOf(media.data) : media.error,
          storyInsights: insights.ok ? shapeOf(insights.data) : insights.error,
        },
      };
    },
  },
  {
    name: 'double-publish',
    task: 'T-E4',
    gate: 'M2',
    answers: ['CC-PUB-4'],
    write: true,
    needsImage: true,
    describe:
      'One STORIES container, instagram_publish_media twice with the same creationId. The ' +
      'second call must not create a second story; evidence records what it returned.',
    async run(ctx) {
      const c = await ctx.call('instagram_create_media_container', {
        mediaType: 'STORIES',
        imageUrl: ctx.imageUrl,
        apply: true,
      });
      if (!c.ok) return { status: 'FAIL', reason: 'container refused', evidence: c.error };
      if (c.data?.mode === 'refused') return { status: 'SKIP', reason: 'operator declined' };
      const creationId = c.data?.id ?? c.data?.container_id ?? c.data?.containerId;
      if (typeof creationId !== 'string') {
        return { status: 'FAIL', reason: 'no container id', evidence: shapeOf(c.data) };
      }
      await ctx.waitForContainer(creationId);
      const first = await ctx.call('instagram_publish_media', { creationId, apply: true });
      if (first.ok && first.data?.mode === 'refused') {
        return { status: 'SKIP', reason: 'operator declined' };
      }
      const second = await ctx.call('instagram_publish_media', { creationId, apply: true });
      const firstId = first.ok ? first.data?.media_id : undefined;
      const secondId = second.ok ? second.data?.media_id : undefined;
      const duplicated = typeof secondId === 'string' && secondId !== firstId;
      return {
        status: first.ok && !duplicated ? 'PASS' : 'FAIL',
        reason: duplicated ? 'the second publish created a second story' : undefined,
        evidence: {
          first: first.ok ? shapeOf(first.data) : first.error,
          second: second.ok ? shapeOf(second.data) : second.error,
          sameMediaId: firstId !== undefined && firstId === secondId,
        },
        finding: second.ok
          ? `second publish returned ${String(second.data?.status ?? second.data?.mode)}`
          : `second publish failed as ${String(second.error?.kind)} code ${String(second.error?.code)}`,
      };
    },
  },
  {
    name: 'caption-at-cap',
    task: 'T-E4',
    gate: 'M2',
    answers: ['CC-PUB-11'],
    write: true,
    needsImage: true,
    describe:
      'An IMAGE container (never published) with a 2,200-code-point caption of non-BMP ' +
      'emoji; then 2,201, which the server must refuse before any Graph call.',
    async run(ctx) {
      const caption = (n) => {
        const head = 'live-qa ';
        return head + '\u{1F600}'.repeat(n - [...head].length);
      };
      const atCap = await ctx.call('instagram_create_media_container', {
        imageUrl: ctx.imageUrl,
        caption: caption(2200),
        apply: true,
      });
      if (atCap.ok && atCap.data?.mode === 'refused') {
        return { status: 'SKIP', reason: 'operator declined' };
      }
      const overCap = await ctx.call('instagram_create_media_container', {
        imageUrl: ctx.imageUrl,
        caption: caption(2201),
        apply: false,
      });
      const overRefused = !overCap.ok || overCap.data?.mode !== 'preview';
      return {
        status: atCap.ok && overRefused ? 'PASS' : 'FAIL',
        reason: atCap.ok ? (overRefused ? undefined : '2,201 was accepted') : 'Meta refused 2,200',
        evidence: {
          atCap: atCap.ok ? shapeOf(atCap.data) : atCap.error,
          overCap: overCap.ok ? shapeOf(overCap.data) : overCap.error,
        },
      };
    },
  },
  {
    name: 'comment-round-trip',
    task: 'T-E4',
    gate: 'M3',
    answers: ['CC-COM-3', 'CC-COM-5'],
    write: true,
    describe:
      'create_comment on own feed media -> hide (own comment: stays visible, noted) -> ' +
      'unhide -> delete. The delete always runs unless --no-cleanup.',
    async run(ctx) {
      const target = ctx.mediaIdArg ?? ctx.feedMediaId();
      if (target === undefined) return { status: 'SKIP', reason: 'no feed media (--media-id)' };
      const created = await ctx.call('instagram_create_comment', {
        mediaId: target,
        message: `live-qa probe ${new Date(ctx.nowMs).toISOString()}`,
        apply: true,
      });
      if (!created.ok) {
        return { status: 'FAIL', reason: 'create_comment failed', evidence: created.error };
      }
      if (created.data?.mode === 'refused') return { status: 'SKIP', reason: 'operator declined' };
      const commentId = created.data?.commentId;
      if (typeof commentId !== 'string') {
        return { status: 'FAIL', reason: 'no comment id', evidence: shapeOf(created.data) };
      }
      const steps = { create: shapeOf(created.data) };
      let ok = true;
      try {
        for (const tool of ['instagram_hide_comment', 'instagram_unhide_comment']) {
          const r = await ctx.call(tool, { commentId, apply: true });
          steps[tool] = r.ok ? shapeOf(r.data) : r.error;
          ok &&= r.ok && r.data?.mode !== 'refused';
        }
      } finally {
        if (ctx.cleanup) {
          const d = await ctx.call('instagram_delete_comment', { commentId, apply: true });
          steps.delete = d.ok ? shapeOf(d.data) : d.error;
          ok &&= d.ok && typeof d.data?.deleted === 'string';
        } else {
          steps.delete = 'skipped (--no-cleanup)';
        }
      }
      return { status: ok ? 'PASS' : 'FAIL', evidence: steps };
    },
  },
  {
    name: 'write-journal',
    task: 'T-E4',
    gate: 'M2',
    answers: ['CC-PUB-16', 'CC-PROC-5'],
    write: true,
    describe:
      'Every applied write above left one JSON line in the write journal (a temp file ' +
      'the runner points IG_WRITE_JOURNAL at, deleted afterwards).',
    async run(ctx) {
      if (ctx.appliedWrites === 0) return { status: 'SKIP', reason: 'no write was applied' };
      const lines = existsSync(ctx.journalPath)
        ? readFileSync(ctx.journalPath, 'utf8').split('\n').filter(Boolean)
        : [];
      const parsed = lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      });
      const actions = parsed.map((p) => (p === null ? '<unparsable>' : String(p.action)));
      return {
        status: lines.length > 0 && !parsed.includes(null) ? 'PASS' : 'FAIL',
        reason: lines.length === 0 ? 'the journal is empty' : undefined,
        evidence: { lines: lines.length, actions, appliedWritesSeen: ctx.appliedWrites },
      };
    },
  },
];

/**
 * The §9 `[verify]` register as it stands, and which probe answers each row.
 * `live-probe:` names a wire probe folded in by `--with-wire-probes`.
 */
const VERIFY_REGISTER = [
  { id: 'CC-INS-4', probes: ['insights-time-series', 'live-probe:insights-timezone'] },
  { id: 'CC-PUB-4', probes: ['double-publish', 'live-probe:double-publish'] },
  {
    id: 'CC-PUB-11',
    probes: ['caption-at-cap', 'live-probe:caption-at-cap', 'live-probe:caption-over-cap'],
  },
  { id: 'CC-COM-6', probes: ['live-probe:comment-length-ladder'] },
  { id: 'CC-AUTH-14', probes: ['live-probe:refresh-old-token-fate'] },
  { id: 'T-E3 (PCA)', probes: ['hashtag-search', 'live-probe:hashtag-search'] },
];

function selectProbes(only) {
  if (only === undefined) return PROBES;
  const picked = PROBES.filter((p) => p.name === only || p.task === only || p.gate === only);
  if (picked.length === 0) throw new Error(`--only ${only} matches no probe, task or gate`);
  return picked;
}

function printPlan(args, say) {
  say('live-qa plan (read session first; write session only with --write):\n');
  for (const p of selectProbes(args.only)) {
    const tags = [p.task, p.gate, ...(p.paths ?? []), p.write ? 'WRITE' : 'read'].join(' · ');
    const answers = p.answers.length > 0 ? `  answers ${p.answers.join(', ')}` : '';
    say(`  ${p.name.padEnd(22)} ${tags}${answers}\n      ${p.describe}`);
  }
  say('\n§9 [verify] register -> probes:');
  for (const row of VERIFY_REGISTER) say(`  ${row.id.padEnd(11)} ${row.probes.join(', ')}`);
}

// --- Credentials -------------------------------------------------------------

async function loadDist() {
  if (!existsSync(join(repoRoot, 'dist', 'src', 'index.js'))) {
    throw new Error('dist/ is missing or incomplete — run `npm run build` first.');
  }
  const [config, configWrite, auth, redact, sanitize] = await Promise.all([
    import('../dist/src/core/config.js'),
    import('../dist/src/core/config-write.js'),
    import('../dist/src/core/auth.js'),
    import('../dist/src/core/redact.js'),
    import('../dist/test/helpers/sanitize.js'),
  ]);
  return { config, configWrite, auth, redact, sanitize };
}

/** Same files, same order, same no-override rule as `src/index.ts`. */
async function loadEnvFiles(resolveConfigHome) {
  const { config: dotenvConfig } = await import('dotenv');
  const explicit = process.env.IG_ENV_FILE?.trim();
  const candidates =
    explicit && explicit !== ''
      ? [explicit]
      : [join(resolveConfigHome(), 'instagram-mcp-ai', '.env'), join(process.cwd(), '.env')];
  for (const file of candidates) {
    if (existsSync(file)) dotenvConfig({ path: file, override: false, quiet: true });
  }
}

// --- MCP session -------------------------------------------------------------

/**
 * One server process, one client. `confirm` answers the server's elicitation
 * prompts (write session only); without it the client does not advertise the
 * capability, and the read session never sends apply:true except to the one
 * probe that proves the destructive gate refuses it.
 */
async function openSession({ env, confirm, timeoutMs, redact }) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'dist', 'src', 'index.js')],
    env,
    cwd: repoRoot,
    stderr: 'pipe',
  });
  const stderrTail = [];
  transport.stderr?.on('data', (chunk) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      stderrTail.push(String(redact(line)));
      if (stderrTail.length > 20) stderrTail.shift();
    }
  });

  const client = new Client(
    { name: 'instagram-mcp-live-qa', version: '1' },
    { capabilities: confirm ? { elicitation: { form: {} } } : {} },
  );
  if (confirm) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const approved = await confirm(String(redact(request.params.message ?? '')));
      return approved ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
    });
  }
  try {
    await client.connect(transport);
  } catch (err) {
    const tail = stderrTail.join('\n');
    throw new Error(`server did not start: ${String(redact(err?.message ?? err))}\n${tail}`);
  }
  const listed = await client.listTools();
  const tools = new Set(listed.tools.map((t) => t.name));

  const call = async (name, args, { write = false } = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: write ? timeoutMs * 5 : timeoutMs,
    });
    let data = result.structuredContent;
    if (data === undefined) {
      const text = result.content?.find((c) => c.type === 'text')?.text;
      try {
        data = text === undefined ? undefined : JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (result.isError === true) {
      // The typed error is carried by the text line alone (CC-DATA-61):
      // `Instagram error (<kind>): <message>[ (code N[, subcode M])]`.
      const line = result.content?.find((c) => c.type === 'text')?.text ?? '';
      const m = TYPED_ERROR_LINE.exec(line);
      const e = m
        ? {
            kind: m[1],
            message: m[2],
            code: m[3] === undefined ? undefined : Number(m[3]),
            subcode: m[4] === undefined ? undefined : Number(m[4]),
          }
        : {};
      const message = String(redact(e.message ?? line))
        .replace(/\d{6,}/g, '<n>')
        .slice(0, 300);
      return {
        ok: false,
        error: { kind: e.kind ?? 'untyped', code: e.code, subcode: e.subcode, message },
      };
    }
    return { ok: true, data };
  };

  return { client, tools, call, close: () => client.close(), stderrTail };
}

// --- Report ------------------------------------------------------------------

function skipAll(probes, reason) {
  return probes.map((p) => ({
    name: p.name,
    task: p.task,
    gate: p.gate,
    answers: p.answers,
    status: 'SKIP',
    reason,
  }));
}

function summarize(records) {
  const summary = { pass: 0, fail: 0, skip: 0 };
  for (const r of records) summary[r.status.toLowerCase()] += 1;
  const byGate = {};
  for (const r of records) {
    byGate[r.gate] ??= { pass: 0, fail: 0, skip: 0 };
    byGate[r.gate][r.status.toLowerCase()] += 1;
  }
  return { summary, byGate };
}

function verifyRows(records, wire) {
  const status = (ref) => {
    if (ref.startsWith('live-probe:')) {
      const hit = wire?.probes?.find((p) => p.name === ref.slice('live-probe:'.length));
      return hit ? hit.status : 'NOT RUN';
    }
    return records.find((r) => r.name === ref)?.status ?? 'NOT RUN';
  };
  return VERIFY_REGISTER.map((row) => ({
    id: row.id,
    probes: row.probes.map((ref) => ({ probe: ref, status: status(ref) })),
  }));
}

function toMarkdown(report) {
  const out = [];
  out.push('# Live-QA report', '');
  out.push(`- Generated: ${report.generatedAt}`);
  out.push(`- Auth path: ${report.authPath ?? 'n/a'} · profile: ${report.profile ?? 'n/a'}`);
  out.push(`- Flags: ${JSON.stringify(report.flags)}`);
  const s = report.summary;
  out.push(`- Result: **${s.pass} PASS · ${s.fail} FAIL · ${s.skip} SKIP**`);
  if (report.note) out.push(`- Note: ${report.note}`);
  out.push('', '## By milestone gate', '', '| Gate | PASS | FAIL | SKIP |', '|---|---|---|---|');
  for (const [gate, c] of Object.entries(report.byGate).sort()) {
    out.push(`| ${gate} | ${c.pass} | ${c.fail} | ${c.skip} |`);
  }
  out.push('', '## Probes', '', '| Probe | Task | Gate | Answers | Status | Reason / finding |');
  out.push('|---|---|---|---|---|---|');
  for (const r of report.probes) {
    const note = [r.reason, r.finding].filter(Boolean).join(' — ').replace(/\|/g, '\\|');
    out.push(
      `| ${r.name} | ${r.task} | ${r.gate} | ${r.answers.join(', ')} | ${r.status} | ${note} |`,
    );
  }
  out.push('', '## §9 `[verify]` register', '', '| Case | Probe | Status |', '|---|---|---|');
  for (const row of report.verifyRegister) {
    for (const p of row.probes) out.push(`| ${row.id} | ${p.probe} | ${p.status} |`);
  }
  if (report.wireProbes) {
    const w = report.wireProbes;
    out.push('', '## Wire probes (scripts/live-probe.mjs)', '');
    out.push(`Exit ${w.exitCode}; ${JSON.stringify(w.summary ?? {})}. Full report: \`${w.file}\`.`);
  }
  out.push('', 'Evidence (shapes only, redacted) is in the JSON report beside this file.', '');
  return out.join('\n');
}

function writeReport(report, outDir, { redact, secrets, assertFixtureSafe }) {
  assertFixtureSafe(report, 'live-qa report');
  const json = String(redact(`${JSON.stringify(report, null, 2)}\n`));
  const md = String(redact(toMarkdown(report)));
  for (const secret of secrets) {
    if (json.includes(secret) || md.includes(secret)) {
      throw new Error('Refusing to write the report: it still contains a credential.');
    }
  }
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'live-qa-report.json');
  const mdPath = join(outDir, 'live-qa-report.md');
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, md);
  return { jsonPath, mdPath };
}

// --- Wire probes -------------------------------------------------------------

function runWireProbes(args, outDir) {
  const file = join(outDir, 'live-probe-report.json');
  const argv = [join(repoRoot, 'scripts', 'live-probe.mjs'), '--out', file];
  if (args.profile) argv.push('--profile', args.profile);
  if (args.write) argv.push('--allow-writes');
  if (args.imageUrl) argv.push('--image-url', args.imageUrl);
  if (args.discoveryUsername) argv.push('--discovery-username', args.discoveryUsername);
  if (!args.cleanup) argv.push('--no-cleanup');
  return new Promise((done) => {
    const child = spawn(process.execPath, argv, {
      cwd: repoRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        parsed = undefined;
      }
      done({
        exitCode: code,
        file,
        summary: parsed?.summary,
        probes: (parsed?.probes ?? []).map((p) => ({
          name: p.name,
          answers: p.answers,
          status: p.status,
          reason: p.reason,
        })),
      });
    });
  });
}

// --- Main --------------------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.plan) {
    printPlan(args, (line) => console.log(line));
    return 0;
  }
  const selected = selectProbes(args.only);
  const outDir = resolve(args.out ?? join(repoRoot, 'dist', 'live-qa'));

  const dist = await loadDist();
  const { registerSecret, createRedactor } = dist.redact;
  const { assertFixtureSafe } = dist.sanitize;
  await loadEnvFiles(dist.configWrite.resolveConfigHome);
  const redact = createRedactor();
  const say = (line) => console.log(String(redact(line)));
  const flags = { write: args.write, withWireProbes: args.withWireProbes, only: args.only ?? null };

  const base = {
    harness: 'scripts/live-qa.mjs',
    generatedAt: new Date().toISOString(),
    flags,
  };

  // --- No credentials: a clean, complete SKIP report. -------------------------
  let loaded;
  try {
    loaded = dist.config.loadProfiles();
  } catch (err) {
    const reason = `no credentials: ${String(redact(err?.message ?? err))}`;
    const probes = skipAll(selected, reason);
    const report = {
      ...base,
      authPath: null,
      profile: null,
      note:
        'Nothing ran. Set IG_ACCESS_TOKEN (plus IG_AUTH_MODE, IG_ACCOUNT_ID, IG_APP_ID and ' +
        'IG_APP_SECRET for fb-login), or put them in the XDG env file, then re-run. See ' +
        'docs/live-qa.md.',
      ...summarize(probes),
      probes,
      verifyRegister: verifyRows(probes, undefined),
    };
    const paths = writeReport(report, outDir, { redact, secrets: [], assertFixtureSafe });
    say(`live-qa: SKIP — ${reason}`);
    say(`  ${probes.length} probe(s) reported SKIP.\n  ${paths.mdPath}\n  ${paths.jsonPath}`);
    return 0;
  }

  const profile = dist.config.resolveProfile(loaded.profiles, args.profile ?? loaded.defaultName);

  // Register every profile's secrets, not only the active one's: the server
  // loads them all, and any of them could surface in an error it relays.
  const secrets = [];
  for (const p of loaded.profiles) {
    const provider = dist.auth.createAuthProvider(p);
    const params = await provider.authParams(provider.defaultHost);
    for (const value of [p.accessToken, p.appSecret, ...Object.values(params)]) {
      if (typeof value === 'string' && value.length >= 8) secrets.push(value);
    }
  }
  for (const secret of secrets) registerSecret(secret);

  const records = [];
  const journalDir = mkdtempSync(join(tmpdir(), 'live-qa-'));
  const journalPath = join(journalDir, 'journal.jsonl');
  const ctx = {
    authPath: profile.authPath,
    anyFbProfile: loaded.profiles.some((p) => p.authPath === 'fb-login'),
    configuredAccountId: profile.accountId,
    imageUrl: args.imageUrl,
    mediaIdArg: args.mediaId,
    discoveryUsername: args.discoveryUsername,
    cleanup: args.cleanup,
    nowMs: Date.now(),
    journalPath,
    appliedWrites: 0,
    feedMediaId() {
      const feed = (this.media ?? []).find(
        (m) => m.media_product_type === undefined || m.media_product_type === 'FEED',
      );
      return feed?.id;
    },
    typedOutcome(r) {
      if (r.ok) return { status: 'PASS', evidence: shapeOf(r.data) };
      if (r.error.kind !== 'untyped') {
        return {
          status: 'PASS',
          evidence: r.error,
          finding: `Graph declined; surfaced as a typed ${r.error.kind} error`,
        };
      }
      return { status: 'FAIL', reason: 'untyped error', evidence: r.error };
    },
  };

  const childEnv = (overrides) => {
    const env = { ...process.env, IG_TOOL_PACKAGES: 'all', IG_LOG_LEVEL: 'warn', ...overrides };
    if (args.profile) env.IG_ACTIVE_PROFILE = args.profile;
    // A spawned server under `c8` would otherwise be counted as covered code.
    env.NODE_V8_COVERAGE = '';
    return env;
  };

  const runSession = async (probes, session) => {
    for (const probe of probes) {
      const record = {
        name: probe.name,
        task: probe.task,
        gate: probe.gate,
        answers: probe.answers,
      };
      if (probe.paths && !probe.paths.includes(profile.authPath)) {
        records.push({ ...record, status: 'SKIP', reason: `${probe.paths.join('/')} only` });
        continue;
      }
      if (probe.needsImage && !args.imageUrl) {
        records.push({ ...record, status: 'SKIP', reason: 'needs --image-url' });
        continue;
      }
      const probeCtx = Object.assign(ctx, {
        tools: session.tools,
        call: async (tool, callArgs) => {
          if (!session.tools.has(tool)) {
            throw Object.assign(new Error(`${tool} is not registered`), { skip: true });
          }
          const withAccount = args.profile ? { account: args.profile, ...callArgs } : callArgs;
          const r = await session.call(tool, withAccount, { write: probe.write === true });
          if (probe.write && r.ok && callArgs.apply === true && r.data?.mode !== 'refused') {
            if (r.data?.mode !== 'preview') ctx.appliedWrites += 1;
          }
          return r;
        },
        waitForContainer: async (containerId) => {
          for (let i = 0; i < 20; i += 1) {
            const s = await session.call('instagram_get_container_status', { containerId });
            const code = s.ok ? (s.data?.status_code ?? s.data?.statusCode) : 'ERROR';
            if (code !== 'IN_PROGRESS') return code;
            await new Promise((r) => setTimeout(r, 3000));
          }
          return 'IN_PROGRESS';
        },
      });
      const started = Date.now();
      try {
        const outcome = await probe.run(probeCtx);
        records.push({ ...record, ...outcome, ms: Date.now() - started });
      } catch (err) {
        records.push({
          ...record,
          status: err?.skip ? 'SKIP' : 'FAIL',
          reason: String(redact(err?.message ?? err)).replace(/\d{6,}/g, '<n>'),
          ...(/output schema/.test(String(err?.message))
            ? {
                finding:
                  'the MCP client SDK rejected the result against the tool outputSchema ' +
                  '(a success result whose structuredContent drifted from the published schema)',
              }
            : {}),
          ms: Date.now() - started,
        });
      }
      const last = records.at(-1);
      say(`  ${last.status.padEnd(4)} ${probe.name}${last.reason ? ` — ${last.reason}` : ''}`);
    }
  };

  // --- Read session. ----------------------------------------------------------
  const readProbes = selected.filter((p) => !p.write);
  const writeProbes = selected.filter((p) => p.write);
  say(`live-qa: ${profile.authPath} profile "${profile.name}" — read session`);
  if (readProbes.length > 0) {
    let session;
    try {
      session = await openSession({
        env: childEnv({ IG_WRITE_MODE: 'preview', IG_ALLOW_DESTRUCTIVE: 'false' }),
        timeoutMs: args.timeoutMs,
        redact,
      });
    } catch (err) {
      records.push(
        ...skipAll(readProbes, 'server did not start').map((r) =>
          r.name === 'handshake'
            ? { ...r, status: 'FAIL', reason: String(redact(err.message)).split('\n')[0] }
            : r,
        ),
      );
    }
    if (session) {
      try {
        await runSession(readProbes, session);
      } finally {
        await session.close();
      }
    }
  }

  // --- Write session: --write, a TTY, a typed yes, and a yes per write. -------
  if (writeProbes.length > 0) {
    let refusal;
    if (!args.write) refusal = 'read-only run (pass --write)';
    else if (!process.stdin.isTTY) refusal = 'no interactive terminal to confirm writes';
    let rl;
    if (refusal === undefined) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      say(
        `\nThe write session will, on the account behind profile "${profile.name}":\n` +
          '  - publish up to 2 STORIES (self-expire in 24 h)\n' +
          '  - create up to 2 unpublished IMAGE containers (expire unused)\n' +
          '  - create, hide, unhide and delete 1 comment on your newest feed post\n' +
          'Each write is also confirmed individually at the prompt the server sends.',
      );
      const answer = await rl.question('Type "write" to proceed: ');
      if (answer.trim() !== 'write') refusal = 'operator did not confirm the write session';
    }
    if (refusal !== undefined) {
      rl?.close();
      for (const p of writeProbes) {
        records.push({
          name: p.name,
          task: p.task,
          gate: p.gate,
          answers: p.answers,
          status: 'SKIP',
          reason: refusal,
        });
      }
    } else {
      const confirm = async (message) => {
        const a = await rl.question(`\n[server asks] ${message}\nApprove this write? [y/N] `);
        return /^y(es)?$/i.test(a.trim());
      };
      let session;
      try {
        session = await openSession({
          env: childEnv({
            IG_WRITE_MODE: 'preview',
            IG_ALLOW_DESTRUCTIVE: 'true',
            IG_WRITE_JOURNAL: journalPath,
          }),
          confirm,
          timeoutMs: args.timeoutMs,
          redact,
        });
        say('\nwrite session');
        await runSession(writeProbes, session);
      } catch (err) {
        const done = new Set(records.map((r) => r.name));
        const reason = String(redact(err?.message ?? err)).split('\n')[0];
        records.push(
          ...skipAll(
            writeProbes.filter((p) => !done.has(p.name)),
            reason,
          ),
        );
      } finally {
        await session?.close();
        rl.close();
      }
    }
  }
  rmSync(journalDir, { recursive: true, force: true });

  // --- Wire probes. -------------------------------------------------------------
  let wire;
  if (args.withWireProbes) {
    say('\nscripts/live-probe.mjs');
    mkdirSync(outDir, { recursive: true });
    wire = await runWireProbes(args, outDir);
  }

  const report = {
    ...base,
    authPath: profile.authPath,
    profile: profile.name,
    ...summarize(records),
    probes: records,
    verifyRegister: verifyRows(records, wire),
    ...(wire ? { wireProbes: wire } : {}),
  };
  const paths = writeReport(report, outDir, { redact, secrets, assertFixtureSafe });
  say(
    `\n${report.summary.pass} PASS · ${report.summary.fail} FAIL · ${report.summary.skip} SKIP\n` +
      `  ${paths.mdPath}\n  ${paths.jsonPath}\n` +
      'The report holds shapes, not payloads, but it describes a real account: keep it out of git.',
  );
  const wireFailed = wire !== undefined && wire.exitCode === 1;
  return report.summary.fail > 0 || wireFailed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`live-qa: ${err?.message ?? err}`);
    process.exitCode = 2;
  },
);
