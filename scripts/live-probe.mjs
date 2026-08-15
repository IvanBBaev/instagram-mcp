/**
 * Live-probe harness (workplan T-E2 / T-E3 / T-E4, corner-cases §9).
 *
 * The executable form of the §9 protocol. Every probe here answers a specific
 * `[verify]` row in [docs/corner-cases.md](../docs/corner-cases.md) (or a
 * `[verify — live probe]` in the workplan), records PASS / FAIL / SKIP with a
 * reason and the **sanitized** Graph response, and writes the lot to one report
 * file. The point is that a token arriving on a Tuesday turns into evidence on
 * the same Tuesday, instead of into a day of hand-executed protocol.
 *
 * Usage (requires a built `dist/`; only `--dry-run` works without credentials):
 *
 *     node scripts/live-probe.mjs --dry-run              # full plan, no network
 *     node scripts/live-probe.mjs                        # read-only lanes
 *     node scripts/live-probe.mjs --allow-writes --image-url https://…/probe.jpg
 *     node scripts/live-probe.mjs --only insights-timezone
 *
 * Guarantees, in order of how much they matter:
 *
 *  1. **Safety is ordered, not assumed.** Lanes run read-only first, then the
 *     read-only PCA/hashtag lane (T-E3), then — only behind `--allow-writes` —
 *     containers that are never published, then a **story** (self-expiring),
 *     then comments, then (behind a second flag) a feed post, and finally
 *     (behind a third) the token refresh that rotates the operator's credential.
 *     Without the flags the write lanes SKIP; they are never merely "not run".
 *  2. **Nothing is deleted that this harness did not create.** The comment lane
 *     removes its own comments and replies (disable with `--no-cleanup`) and
 *     touches nothing else. Published feed media cannot be deleted through the
 *     API at all, which is exactly why the feed lane has its own flag.
 *  3. **No secret is ever printed or written.** The token, the app secret and
 *     the computed `appsecret_proof` are registered with the redactor before the
 *     first call; every printed line goes through it; every recorded response
 *     goes through `test/helpers/sanitize.ts` and then through the same three
 *     gates `capture-fixtures.mjs` uses. Calls are recorded as
 *     `{ method, host, path, paramKeys }` — parameter NAMES only, never values
 *     and never a query string.
 *  4. **A probe that could not run SKIPs with a cause.** Missing scope, wrong
 *     auth path, no media on the account, missing flag, missing `--image-url` —
 *     each produces a stated reason. A SKIP never counts as a pass, and never
 *     counts as a failure either: the exit code is non-zero only on FAIL.
 *
 * Credentials are read exactly the way the server reads them — same env files,
 * same variables — by calling `core/config.js` rather than re-implementing it.
 * There are deliberately no probe-only env var names.
 *
 * A plain ESM script outside `tsconfig` (`scripts/**` is not compiled), so it
 * imports the COMPILED modules from `dist/`.
 *
 * WHICH SEAM A PROBE USES: a probe that exercises a **write path** calls the
 * real `src/api/*.ts` function, so the probe tests the code that ships. A probe
 * that needs **wire fidelity** (raw `end_time` buckets, an unknown-field error,
 * `debug_token`'s envelope) calls the `IgRequestFn` seam directly, because the
 * api layer returns mapped domain objects and a mapped object is not evidence
 * about the wire. Where a path/field list is duplicated from `src/api/`, it is
 * marked; a stale duplicate yields evidence about a call the server no longer
 * makes.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Probe constants --------------------------------------------------------

/** Small page size: a probe needs shape, not volume, and calls cost quota. */
const PAGE_LIMIT = 5;

/** Media fields the read lane needs to pick substrate for the later lanes. */
const MEDIA_FIELDS = 'id,media_type,media_product_type,timestamp,comments_count,is_comment_enabled';

/**
 * CC-PUB-11: the caption cap Meta documents (2,200) with no counting unit named.
 * The probe brackets it — one caption AT the cap and one ONE OVER it — in code
 * points, using a non-BMP emoji so each code point costs two UTF-16 units. If
 * the 2,200-code-point caption is accepted, the unit is code points; if it is
 * rejected while a 1,100-code-point one is accepted, the unit is UTF-16 units.
 */
const CAPTION_CAP_CODEPOINTS = 2200;
/** Non-BMP filler: 1 code point, 2 UTF-16 units, 4 UTF-8 bytes. */
const NON_BMP_FILL = '\u{1F642}';

/**
 * CC-COM-6: the comment length cap is undocumented, so the probe brackets it
 * with a ladder instead of bisecting. A bisect would be more precise and would
 * also be a dozen comment writes in a row, which is how you meet code 368
 * (CC-COM-4) instead of the answer. Widen the ladder if the bracket is too
 * loose to be useful.
 */
const COMMENT_LENGTH_LADDER = [500, 1000, 2200, 2201, 8000];
/** Pause between comment writes — spam heuristics, not politeness (CC-COM-4). */
const COMMENT_PAUSE_MS = 3000;

/** Container status poll budget for the story/feed lanes. */
const POLL_INTERVAL_MS = 3000;
const POLL_BUDGET_MS = 90_000;

/** Hashtag used by the T-E3 probe. Spends one of the account's 30-per-7-days. */
const PROBE_HASHTAG = 'coffee';

/** Days of daily buckets requested by the CC-INS-4 timezone probe. */
const TIMEZONE_PROBE_DAYS = 3;

/** Per-endpoint sanitizer policy widenings (see test/helpers/sanitize.ts). */
const INSIGHTS_OVERRIDES = { name: 'keep' };
const ALT_TEXT_OVERRIDES = { alt_text: 'text' };
const IDENTITY_OVERRIDES = { account_type: 'keep' };
const TOKEN_OVERRIDES = { expires_in: 'keep', token_type: 'keep' };

// --- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    dryRun: false,
    help: false,
    profile: undefined,
    only: undefined,
    out: undefined,
    imageUrl: undefined,
    videoUrl: undefined,
    discoveryUsername: undefined,
    authPath: undefined,
    allowWrites: false,
    allowFeedPost: false,
    allowTokenRefresh: false,
    cleanup: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--allow-writes') args.allowWrites = true;
    else if (arg === '--allow-feed-post') args.allowFeedPost = true;
    else if (arg === '--allow-token-refresh') args.allowTokenRefresh = true;
    else if (arg === '--no-cleanup') args.cleanup = false;
    else if (arg === '--profile') args.profile = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--image-url') args.imageUrl = argv[++i];
    else if (arg === '--video-url') args.videoUrl = argv[++i];
    else if (arg === '--discovery-username') args.discoveryUsername = argv[++i];
    else if (arg === '--auth-path') args.authPath = argv[++i];
    else if (arg === '--only') args.only = new Set((argv[++i] ?? '').split(',').filter(Boolean));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  // The stronger flags are meaningless on their own; saying so beats silently
  // running a read-only pass while the operator believes a post went out.
  if (args.allowFeedPost) args.allowWrites = true;
  if (args.allowTokenRefresh) args.allowWrites = true;
  if (args.authPath !== undefined && !['ig-login', 'fb-login'].includes(args.authPath)) {
    throw new Error(`--auth-path must be ig-login or fb-login (got: ${args.authPath})`);
  }
  return args;
}

const USAGE = `Usage: node scripts/live-probe.mjs [options]

  --dry-run                 List every probe in run order with its gates. No
                            network, no dist/, no credentials required.
  --profile <name>          Account profile to probe (default: IG_ACTIVE_PROFILE).
  --only <a,b,c>            Run only these probe names or lane ids.
  --out <file>              Report path (default: ./live-probe-report.json).

  --allow-writes            Enable the write lanes. Without it every write probe
                            SKIPs. Creates containers, publishes ONE story, and
                            comments on existing media.
  --allow-feed-post         Additionally publish ONE feed image. Implies
                            --allow-writes. A published feed post CANNOT be
                            deleted through the API — only its comments toggled.
  --allow-token-refresh     Additionally run the CC-AUTH-14 refresh probe, which
                            ROTATES the profile's token and persists the new one
                            to the XDG env file. Implies --allow-writes.
  --no-cleanup              Keep the comments this harness created (default is
                            to delete them — and only them).

  --image-url <https url>   Publicly fetchable JPEG for the publishing probes.
  --video-url <https url>   Publicly fetchable MP4 for the mixed-carousel probe.
  --discovery-username <h>  Public professional handle for business_discovery.
  --auth-path <p>           --dry-run only: resolve the path gates as if the
                            profile were ig-login | fb-login.
  -h, --help                Show this help.

Exit code: 0 when no probe FAILed (SKIPs are fine), 1 when one did, 2 when the
harness could not start. The report holds sanitized evidence only — no token, no
appsecret_proof, no query strings, parameter NAMES only.

Requires a built dist/ (npm run build) for everything except --dry-run.`;

// --- dist loading -----------------------------------------------------------

/**
 * Import the compiled modules. Dynamic so a missing build produces an
 * instruction instead of an unhandled module-resolution stack trace — and so
 * `--dry-run` can return the plan on a tree that has never been built.
 */
async function loadDist() {
  const entry = join(repoRoot, 'dist', 'src', 'core', 'config.js');
  if (!existsSync(entry)) {
    throw new Error('dist/ is missing or incomplete — run `npm run build` first.');
  }
  const modules = await Promise.all([
    import('../dist/src/core/config.js'),
    import('../dist/src/core/settings.js'),
    import('../dist/src/core/auth.js'),
    import('../dist/src/core/http.js'),
    import('../dist/src/core/clock.js'),
    import('../dist/src/core/log.js'),
    import('../dist/src/core/redact.js'),
    import('../dist/src/core/refresh.js'),
    import('../dist/src/core/config-write.js'),
    import('../dist/src/core/types.js'),
    import('../dist/src/api/publishing.js'),
    import('../dist/src/api/comments.js'),
    import('../dist/src/api/discovery.js'),
    import('../dist/src/api/insights.js'),
    import('../dist/test/helpers/sanitize.js'),
  ]);
  const keys = [
    'config',
    'settings',
    'auth',
    'http',
    'clock',
    'log',
    'redact',
    'refresh',
    'configWrite',
    'types',
    'publishing',
    'comments',
    'discovery',
    'insights',
    'sanitize',
  ];
  return Object.fromEntries(keys.map((key, i) => [key, modules[i]]));
}

/**
 * Load env files the way `src/index.ts` does: an explicit `IG_ENV_FILE`, else the
 * config home then the project `.env`, never overriding what is already set.
 */
async function loadEnvFiles(resolveConfigHome) {
  const { config: dotenvConfig } = await import('dotenv');
  const explicit = process.env.IG_ENV_FILE?.trim();
  const candidates =
    explicit && explicit !== ''
      ? [explicit]
      : [join(resolveConfigHome(), 'instagram-mcp-ai', '.env'), join(process.cwd(), '.env')];
  for (const file of candidates) {
    // `quiet: true` for the same reason as `src/index.ts`: from dotenv 17 a
    // successful load prints the loaded path to stdout, and this harness's
    // report is the only thing allowed on that stream.
    if (existsSync(file)) dotenvConfig({ path: file, override: false, quiet: true });
  }
}

// --- Small helpers ----------------------------------------------------------

/** A string of exactly `n` code points, marked so it is recognisable in the UI. */
function captionOfCodePoints(n) {
  const marker = 'live-probe CC-PUB-11 ';
  const markerLen = [...marker].length;
  const caption = marker + NON_BMP_FILL.repeat(Math.max(0, n - markerLen));
  const actual = [...caption].length;
  if (actual !== n) throw new Error(`caption builder produced ${actual} code points, wanted ${n}`);
  return caption;
}

/** An ASCII message of exactly `n` characters, for the comment-length ladder. */
function messageOfLength(n) {
  const marker = 'live-probe CC-COM-6 ';
  return (marker + 'x'.repeat(Math.max(0, n - marker.length))).slice(0, n);
}

/** Most recent UTC midnight as unix seconds. */
function utcMidnightSec(nowMs) {
  const d = new Date(nowMs);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/** Run `fn`, returning a discriminated result instead of throwing. */
async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, err };
  }
}

/** Sleep without pulling in the injectable clock — this is wall time, not logic. */
function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Lanes ------------------------------------------------------------------

/**
 * Run order IS the safety story, so it lives in one list rather than in the
 * probe entries. `gate` returns the SKIP cause for the whole lane, or undefined
 * when it may run. Read-only lanes have no gate; every lane that can change the
 * account has one, and the lanes are ordered by how hard the change is to undo:
 * nothing → a container nobody sees → a story that expires in 24 h → comments we
 * delete ourselves → a feed post that can never be deleted → the token itself.
 */
const LANES = [
  {
    id: 'read',
    title: 'Read path (T-E2)',
    why: 'Read-only. Establishes the account, the substrate for later lanes, and answers the read-side [verify] rows.',
  },
  {
    id: 'discovery',
    title: 'Hashtag / PCA (T-E3)',
    why: 'Read-only, Path-B only. Spends one of the 30-per-7-days hashtag budget. Decides whether `discovery` stays registered.',
  },
  {
    id: 'container',
    title: 'Containers, never published (T-E4)',
    why: 'POSTs that create a container and stop. Nothing becomes visible, nothing costs publishing quota, and an unpublished container expires by itself in 24 h.',
    gate: (a) => (a.allowWrites ? undefined : 'write lanes need --allow-writes'),
  },
  {
    id: 'story',
    title: 'Story publish (T-E4)',
    why: 'The cheapest real publish: a story self-expires in 24 h, so there is no cleanup problem. Runs before anything touches the feed.',
    gate: (a) => (a.allowWrites ? undefined : 'write lanes need --allow-writes'),
  },
  {
    id: 'feed',
    title: 'Feed publish (T-E4)',
    why: 'A permanent post — published feed media CANNOT be deleted through the API. Exists only to give the comment lane something to comment on when the account has no media yet.',
    gate: (a) =>
      a.allowFeedPost ? undefined : 'a feed post is permanent; needs --allow-feed-post',
  },
  {
    id: 'comment',
    title: 'Comments & moderation (T-E4)',
    why: 'Writes comments on the account’s own media and deletes exactly the ones it wrote. Runs last of the content lanes because it needs feed media to exist.',
    gate: (a) => (a.allowWrites ? undefined : 'write lanes need --allow-writes'),
  },
  {
    id: 'auth',
    title: 'Token refresh (CC-AUTH-14)',
    why: 'ROTATES the profile token and persists the new one, then replays the OLD token. Last, because if Meta does invalidate the old token every probe after it would fail for the wrong reason.',
    gate: (a) =>
      a.allowTokenRefresh ? undefined : 'rotates the live token; needs --allow-token-refresh',
  },
];

// --- The probe plan ---------------------------------------------------------

/**
 * One entry per question. `answers` names the corner-case row(s) or workplan
 * `[verify]` the probe discharges — a probe that answers nothing does not belong
 * here. Gates, in the order they are evaluated:
 *
 *   `paths`    — auth paths the probe can run on at all (with `pathReason`).
 *   `requires` — CLI arguments it cannot run without.
 *   `needs`    — runtime facts (an existing media, a scope, a hashtag id).
 *
 * `run(ctx, io)` returns `{ finding, evidence, status? }`. `status` defaults to
 * PASS: a probe that reached Meta and came back with an answer has done its job,
 * even when the answer is an error — for several rows the error IS the evidence.
 */
const PROBES = [
  // --- Lane: read -----------------------------------------------------------
  {
    name: 'identity',
    lane: 'read',
    answers: ['CC-AUTH-6', 'architecture-review: /v25.0/ on graph.instagram.com'],
    describe: 'GET /me or /{ig-id} — resolve the operated account through the pinned URL builder',
    // Deliberately the whole run's first call: if the version segment the URL
    // builder pins is not accepted on this host, everything below is noise.
    run: async (ctx, io) => {
      const path = ctx.authPath === 'ig-login' ? '/me' : `/${ctx.igId}`;
      const fields = ctx.authPath === 'ig-login' ? 'id,user_id,username' : 'id,username';
      const raw = await io.req({ method: 'GET', path, params: { fields } });
      const resolved = String(raw.user_id ?? raw.id ?? '');
      ctx.resolvedId = resolved;
      const configured = ctx.configuredAccountId;
      const match =
        configured === undefined
          ? 'no IG_ACCOUNT_ID configured to compare against'
          : configured === resolved
            ? 'IG_ACCOUNT_ID matches the id the token resolves to'
            : 'MISMATCH: IG_ACCOUNT_ID differs from the id the token resolves to (CC-AUTH-6)';
      return {
        finding: `Version-pinned path accepted on ${ctx.host}. ${match}.`,
        evidence: raw,
      };
    },
  },
  {
    name: 'account-type',
    lane: 'read',
    answers: ['CC-AUTH-8'],
    describe: 'GET …?fields=account_type — is the professional-account type readable at all',
    overrides: IDENTITY_OVERRIDES,
    // Its own call because `account_type` is exactly the kind of field that
    // disappears between API generations; folding it into `identity` would let
    // one unknown field take the whole run down.
    run: async (ctx, io) => {
      const path = ctx.authPath === 'ig-login' ? '/me' : `/${ctx.igId}`;
      const r = await attempt(() =>
        io.req({ method: 'GET', path, params: { fields: 'account_type' } }),
      );
      if (!r.ok) {
        return {
          finding: `account_type is NOT readable on ${ctx.authPath}: ${io.errorLabel(r.err)}`,
          evidence: io.errorEvidence(r.err),
        };
      }
      return {
        finding: `account_type readable; value recorded in the evidence.`,
        evidence: r.value,
      };
    },
  },
  {
    name: 'token-introspection',
    lane: 'read',
    answers: ['CC-AUTH-12', 'CC-AUTH-7'],
    describe: 'GET /debug_token — expiry, data-access window and the granted scope list',
    paths: ['fb-login'],
    pathReason: 'debug_token exists only on graph.facebook.com (auth.md §3) — Path A cannot ask',
    overrides: TOKEN_OVERRIDES,
    // The scope list feeds later SKIP causes: "no instagram_manage_comments" is
    // a far better reason to skip the comment lane than a 200-series error.
    run: async (ctx, io) => {
      const raw = await io.req({
        method: 'GET',
        path: '/debug_token',
        params: { input_token: ctx.accessToken },
        host: 'graph.facebook.com',
      });
      const data = raw?.data ?? {};
      ctx.scopes = Array.isArray(data.scopes) ? data.scopes : undefined;
      const dataAccess = data.data_access_expires_at;
      const expires = data.expires_at;
      return {
        finding:
          `Scopes: ${ctx.scopes ? ctx.scopes.length : 'unreported'}. ` +
          `expires_at ${expires === undefined ? 'absent' : expires === 0 ? 'never' : 'set'}, ` +
          `data_access_expires_at ${dataAccess === undefined ? 'absent' : 'set'} ` +
          '(CC-AUTH-12 wants these to move independently).',
        evidence: raw,
      };
    },
  },
  {
    name: 'path-a-appsecret-proof',
    lane: 'read',
    answers: ['security-review: Path-A appsecret_proof support'],
    describe:
      'GET /me with an appsecret_proof param — does graph.instagram.com accept or reject it',
    paths: ['ig-login'],
    pathReason: 'Path B already sends appsecret_proof on every call; the question is Path-A only',
    needs: (ctx) =>
      ctx.appSecretProof === undefined
        ? 'this ig-login profile has no IG_APP_SECRET, so no proof can be computed'
        : undefined,
    // auth.md §1 says the proof is "not supported" on graph.instagram.com. That
    // is a claim about a param nobody has ever sent there; a rejection would
    // make it a fact, an acceptance would make it a free hardening win.
    run: async (ctx, io) => {
      const r = await attempt(() =>
        io.req({
          method: 'GET',
          path: '/me',
          params: { fields: 'user_id', appsecret_proof: ctx.appSecretProof },
        }),
      );
      if (!r.ok) {
        return {
          finding: `graph.instagram.com REJECTED an appsecret_proof param: ${io.errorLabel(r.err)}. auth.md §1 stands.`,
          evidence: io.errorEvidence(r.err),
        };
      }
      return {
        finding:
          'graph.instagram.com accepted a call carrying appsecret_proof. That is tolerance, not ' +
          'proof of enforcement — a second run with a DELIBERATELY WRONG proof must be rejected ' +
          'before auth.md may claim Path-A support.',
        evidence: r.value,
      };
    },
  },
  {
    name: 'media-page',
    lane: 'read',
    answers: ['CC-DATA-2', 'T-E2 read-path smoke'],
    describe: 'GET /{ig-id}/media — one page; picks the substrate every later lane needs',
    // Mirrors the field set in src/api/media.ts closely enough to answer
    // "which fields does Meta actually omit"; it is not a fixture capture.
    run: async (ctx, io) => {
      const raw = await io.req({
        method: 'GET',
        path: `/${ctx.igId}/media`,
        params: { fields: MEDIA_FIELDS, limit: PAGE_LIMIT },
      });
      const items = Array.isArray(raw?.data) ? raw.data : [];
      ctx.mediaId = items.find((m) => typeof m?.id === 'string')?.id;
      ctx.commentableMediaId = items.find(
        (m) => typeof m?.id === 'string' && m?.is_comment_enabled !== false,
      )?.id;
      const missing = ['comments_count', 'is_comment_enabled', 'media_product_type'].filter(
        (f) => items.length > 0 && items.every((m) => m?.[f] === undefined),
      );
      return {
        finding:
          `${items.length} media on the first page. ` +
          (missing.length > 0
            ? `Fields omitted by Meta across the whole page (CC-DATA-2): ${missing.join(', ')}.`
            : 'Every requested field came back on at least one item.'),
        evidence: raw,
      };
    },
  },
  {
    name: 'alt-text-read',
    lane: 'read',
    answers: ['T-D3a alt_text (read side)'],
    describe: 'GET /{media-id}?fields=alt_text — does the field exist on the read side',
    overrides: ALT_TEXT_OVERRIDES,
    needs: (ctx) => (ctx.mediaId ? undefined : 'no media on the account to read alt_text from'),
    // An "unknown field" error is a complete answer, so it is a PASS.
    run: async (ctx, io) => {
      const r = await attempt(() =>
        io.req({ method: 'GET', path: `/${ctx.mediaId}`, params: { fields: 'id,alt_text' } }),
      );
      if (!r.ok) {
        return {
          finding: `alt_text is NOT a readable field: ${io.errorLabel(r.err)}. The write side (alt-text-container) still decides whether it can be SET.`,
          evidence: io.errorEvidence(r.err),
        };
      }
      const present = r.value?.alt_text !== undefined;
      return {
        finding: present
          ? 'alt_text is readable and populated on this media.'
          : 'alt_text is an accepted field but came back empty (Meta omits rather than nulls — CC-DATA-2). The field exists.',
        evidence: r.value,
      };
    },
  },
  {
    name: 'insights-metric-vocabulary',
    lane: 'read',
    answers: ['roadmap: post-2025 account-metric enum'],
    describe:
      'GET /{ig-id}/insights with the full ACCOUNT_METRICS set — which names Meta still knows',
    overrides: INSIGHTS_OVERRIDES,
    // One call, not one per metric: Meta names the offending metric in the error
    // message, so a rejection localises itself and costs a single request.
    run: async (ctx, io) => {
      const r = await attempt(() =>
        io.req({
          method: 'GET',
          path: `/${ctx.igId}/insights`,
          params: {
            metric: ctx.accountMetrics.join(','),
            period: 'day',
            metric_type: 'total_value',
          },
        }),
      );
      if (!r.ok) {
        return {
          finding:
            `Meta rejected the shipped ACCOUNT_METRICS set: ${io.errorLabel(r.err)}. ` +
            'The error names the offending metric — remove it from src/api/insights.ts and re-run.',
          evidence: io.errorEvidence(r.err),
        };
      }
      const returned = (r.value?.data ?? []).map((m) => m?.name).filter(Boolean);
      const absent = ctx.accountMetrics.filter((m) => !returned.includes(m));
      return {
        finding:
          `${returned.length}/${ctx.accountMetrics.length} shipped account metrics returned data. ` +
          (absent.length > 0
            ? `Accepted but silently absent from the response: ${absent.join(', ')}.`
            : 'Every shipped metric came back.'),
        evidence: r.value,
      };
    },
  },
  {
    name: 'insights-follower-count',
    lane: 'read',
    answers: ['T-D5 follower_count [verify — live probe]'],
    describe: 'GET /{ig-id}/insights?metric=follower_count — is it a real post-2025 metric',
    overrides: INSIGHTS_OVERRIDES,
    // src/api/insights.ts deliberately withholds `follower_count` from the enum
    // pending this answer. Either outcome closes the note above ACCOUNT_METRICS.
    run: async (ctx, io) => {
      const r = await attempt(() =>
        io.req({
          method: 'GET',
          path: `/${ctx.igId}/insights`,
          params: { metric: 'follower_count', period: 'day' },
        }),
      );
      if (!r.ok) {
        return {
          finding: `follower_count is NOT accepted: ${io.errorLabel(r.err)}. Keep it out of ACCOUNT_METRICS.`,
          evidence: io.errorEvidence(r.err),
        };
      }
      return {
        finding:
          'follower_count IS accepted as an account metric — add it to ACCOUNT_METRICS and drop the NOTE in src/api/insights.ts.',
        evidence: r.value,
      };
    },
  },
  {
    name: 'insights-timezone',
    lane: 'read',
    answers: ['CC-INS-4'],
    describe:
      'GET /{ig-id}/insights time_series across UTC midnight — which timezone cuts the daily buckets',
    overrides: INSIGHTS_OVERRIDES,
    // Raw seam on purpose: getAccountInsights() clamps the window to the 90-day
    // retention and maps the result, and this probe is precisely about the
    // untouched `end_time` values on either side of a pinned boundary.
    run: async (ctx, io) => {
      const until = utcMidnightSec(ctx.nowMs);
      const since = until - TIMEZONE_PROBE_DAYS * 24 * 60 * 60;
      const raw = await io.req({
        method: 'GET',
        path: `/${ctx.igId}/insights`,
        params: { metric: 'reach', period: 'day', metric_type: 'time_series', since, until },
      });
      const values = (raw?.data ?? []).flatMap((m) => m?.values ?? []);
      const offsets = values
        .map((v) => v?.end_time)
        .filter((t) => typeof t === 'string')
        .map((t) => {
          const d = new Date(t);
          return Number.isNaN(d.getTime())
            ? undefined
            : (d.getUTCHours() * 60 + d.getUTCMinutes()) % (24 * 60);
        })
        .filter((n) => n !== undefined);
      const unique = [...new Set(offsets)];
      let verdict;
      if (unique.length === 0) {
        verdict =
          'no end_time values came back (the account may have no data in the window) — INCONCLUSIVE, re-run on an account with traffic';
      } else if (unique.length === 1 && unique[0] === 0) {
        verdict = 'every bucket ends exactly at UTC midnight ⇒ buckets are cut in UTC';
      } else if (unique.length === 1) {
        verdict = `every bucket ends ${unique[0]} minutes after UTC midnight ⇒ buckets are cut in the ACCOUNT's local timezone (UTC+${(unique[0] / 60).toFixed(2)}h)`;
      } else {
        verdict = `bucket boundaries are not constant (${unique.join(', ')} minutes past UTC midnight) — record the raw evidence and re-read before documenting anything`;
      }
      return {
        finding: `${values.length} daily bucket(s) over ${TIMEZONE_PROBE_DAYS} days: ${verdict}.`,
        evidence: raw,
      };
    },
  },
  {
    name: 'publishing-limit',
    lane: 'read',
    answers: ['CC-PUB-12'],
    describe: 'GET /{ig-id}/content_publishing_limit — runtime quota, and the write lanes’ guard',
    // Read-only, and a precondition: the write lanes refuse to start with no
    // slot left rather than discovering it as a code 9 halfway through.
    run: async (ctx, io) => {
      const limit = await io.api.publishing.getPublishingLimit(io.req, { igId: ctx.igId });
      ctx.quotaRemaining = limit.remaining;
      return {
        finding:
          `quota_usage=${limit.quotaUsage}` +
          (limit.quotaTotal === undefined
            ? ', quota_total not reported by Meta (never hardcode it)'
            : `, quota_total=${limit.quotaTotal}, remaining=${limit.remaining}`) +
          (limit.quotaDuration === undefined ? '' : `, window=${limit.quotaDuration}s`),
        evidence: limit,
      };
    },
  },

  // --- Lane: discovery (T-E3) ----------------------------------------------
  {
    name: 'hashtag-search',
    lane: 'discovery',
    answers: ['T-E3 PCA gate', 'auth.md §5'],
    describe: 'GET /ig_hashtag_search — does hashtag search work without App Review / PCA',
    paths: ['fb-login'],
    pathReason:
      'Path A has no hashtag search — confirmed from docs (auth.md §5, platform-api-review), so there is nothing to probe',
    // THE T-E3 question. `discovery` currently ships registered in `reader`/`all`
    // on a decision taken without this answer; a permission error here is the
    // one-line reversal in src/mcp/registry.ts.
    run: async (ctx, io) => {
      const r = await attempt(() =>
        io.api.discovery.searchHashtag(io.req, { igId: ctx.igId, query: PROBE_HASHTAG }),
      );
      if (!r.ok) {
        const kind = io.errorKind(r.err);
        return {
          finding:
            `Hashtag search FAILED (${io.errorLabel(r.err)}). ` +
            (kind === 'permission'
              ? 'This is the NO-GO signal for T-E3: the app lacks Instagram Public Content Access. Reverse the discovery gate per roadmap.md.'
              : 'Not a permission error — read the evidence before treating it as the PCA answer.'),
          evidence: io.errorEvidence(r.err),
        };
      }
      ctx.hashtagId = r.value[0]?.id;
      return {
        finding:
          'Hashtag search SUCCEEDED for an own-app admin — T-E3 is a GO and the standing decision to keep `discovery` registered is confirmed. One of the 30-per-7-days budget has been spent.',
        evidence: r.value,
      };
    },
  },
  {
    name: 'hashtag-media',
    lane: 'discovery',
    answers: ['T-E3 PCA gate (edge half)'],
    describe: 'GET /{hashtag-id}/top_media — the edge, not just the id lookup',
    paths: ['fb-login'],
    pathReason: 'Path A has no hashtag endpoints at all',
    needs: (ctx) => (ctx.hashtagId ? undefined : 'hashtag-search returned no id to read'),
    // Resolution and reading are separately gated in Meta's permission model,
    // so a GO on the search alone is not a GO on the package.
    run: async (ctx, io) => {
      const r = await attempt(() =>
        io.api.discovery.getHashtagMedia(io.req, {
          hashtagId: ctx.hashtagId,
          igId: ctx.igId,
          edge: 'top',
          maxItems: PAGE_LIMIT,
          limit: PAGE_LIMIT,
        }),
      );
      if (!r.ok) {
        return {
          finding: `Hashtag id resolved but the top_media edge FAILED: ${io.errorLabel(r.err)}. Search access and edge access are gated separately.`,
          evidence: io.errorEvidence(r.err),
        };
      }
      return {
        finding: `top_media returned ${r.value.items.length} item(s) — the discovery read path works end to end.`,
        evidence: r.value,
      };
    },
  },
  {
    name: 'recently-searched-hashtags',
    lane: 'discovery',
    answers: ['CC-RATE-4'],
    describe: 'GET /{ig-id}/recently_searched_hashtags — the authoritative 7-day budget',
    paths: ['fb-login'],
    pathReason: 'Facebook-Login only per the IG User reference',
    // operations.md §1 promises the local 30/7d counter can be reconciled against
    // this endpoint. That promise has never been tested against a real account.
    run: async (ctx, io) => {
      const raw = await io.req({
        method: 'GET',
        path: `/${ctx.igId}/recently_searched_hashtags`,
        params: { limit: 30 },
        host: 'graph.facebook.com',
      });
      const count = Array.isArray(raw?.data) ? raw.data.length : 0;
      return {
        finding: `Endpoint readable; ${count} hashtag(s) inside the rolling 7-day window. The local advisory counter can be reconciled against this (CC-RATE-4).`,
        evidence: raw,
      };
    },
  },
  {
    name: 'business-discovery',
    lane: 'discovery',
    answers: ['T-E3 PCA gate (business_discovery half)'],
    describe: 'GET /{ig-id}?fields=business_discovery.username(…) — public profile lookup',
    paths: ['fb-login'],
    pathReason: 'Path A has no business_discovery (auth.md §5)',
    requires: ['discoveryUsername'],
    run: async (ctx, io) => {
      const r = await attempt(() =>
        io.api.discovery.discoverBusiness(io.req, {
          igId: ctx.igId,
          username: ctx.discoveryUsername,
          mediaLimit: PAGE_LIMIT,
        }),
      );
      if (!r.ok) {
        return {
          finding: `business_discovery FAILED: ${io.errorLabel(r.err)}. It is PCA-gated alongside hashtag search — treat search and discovery as one verdict.`,
          evidence: io.errorEvidence(r.err),
        };
      }
      return {
        finding:
          'business_discovery resolved a public professional profile — the second half of the PCA gate is open too.',
        evidence: r.value,
      };
    },
  },

  // --- Lane: container (write, nothing visible) ----------------------------
  {
    name: 'caption-at-cap',
    lane: 'container',
    answers: ['CC-PUB-11'],
    describe: `POST /{ig-id}/media with a caption of exactly ${CAPTION_CAP_CODEPOINTS} CODE POINTS of non-BMP emoji`,
    requires: ['imageUrl'],
    // Calls the api layer directly and bypasses assertCaptionWithinLimits on
    // purpose: the client-side bound is OUR guess at Meta's unit, and a probe
    // that asks our own validator instead of Meta learns nothing.
    run: async (ctx, io) => {
      const caption = captionOfCodePoints(CAPTION_CAP_CODEPOINTS);
      const r = await attempt(() =>
        io.api.publishing.createMediaContainer(io.req, {
          igId: ctx.igId,
          imageUrl: ctx.imageUrl,
          caption,
        }),
      );
      if (!r.ok) {
        return {
          finding:
            `${CAPTION_CAP_CODEPOINTS} code points (${caption.length} UTF-16 units) was REJECTED: ${io.errorLabel(r.err)}. ` +
            'Meta is NOT counting code points — src/api/media-spec.ts counts the wrong unit.',
          evidence: io.errorEvidence(r.err),
        };
      }
      ctx.capContainerId = r.value.id;
      return {
        finding:
          `${CAPTION_CAP_CODEPOINTS} code points (${caption.length} UTF-16 units) was ACCEPTED ⇒ Meta counts CODE POINTS, ` +
          'which is what src/api/media-spec.ts already does. Container left unpublished; it expires in 24 h.',
        evidence: r.value,
      };
    },
  },
  {
    name: 'caption-over-cap',
    lane: 'container',
    answers: ['CC-PUB-11'],
    describe: `POST /{ig-id}/media with ${CAPTION_CAP_CODEPOINTS + 1} code points — the other side of the bracket`,
    requires: ['imageUrl'],
    // Acceptance at cap only means "at least this much". The pair is what turns
    // an observation into a bound.
    run: async (ctx, io) => {
      const caption = captionOfCodePoints(CAPTION_CAP_CODEPOINTS + 1);
      const r = await attempt(() =>
        io.api.publishing.createMediaContainer(io.req, {
          igId: ctx.igId,
          imageUrl: ctx.imageUrl,
          caption,
        }),
      );
      if (!r.ok) {
        return {
          finding: `${CAPTION_CAP_CODEPOINTS + 1} code points was REJECTED: ${io.errorLabel(r.err)}. Together with caption-at-cap this brackets the cap at exactly ${CAPTION_CAP_CODEPOINTS} code points.`,
          evidence: io.errorEvidence(r.err),
        };
      }
      return {
        finding: `${CAPTION_CAP_CODEPOINTS + 1} code points was ACCEPTED — the documented 2,200 cap is NOT enforced at container creation. Our client-side bound is stricter than Meta's; say so rather than claiming Meta enforces it.`,
        evidence: r.value,
      };
    },
  },
  {
    name: 'alt-text-container',
    lane: 'container',
    answers: ['T-D3a alt_text (write side)'],
    describe: 'POST /{ig-id}/media with an alt_text param — is it accepted at container creation',
    requires: ['imageUrl'],
    overrides: ALT_TEXT_OVERRIDES,
    // `alt_text` is NOT in CreateContainerParams, so this goes through the raw
    // seam. If Meta accepts it, adding it to src/api/publishing.ts is trivial;
    // if it 100s, the workplan row can be closed as "unsupported".
    run: async (ctx, io) => {
      const r = await attempt(() =>
        io.req({
          method: 'POST',
          path: `/${ctx.igId}/media`,
          params: { image_url: ctx.imageUrl, alt_text: 'live-probe alt text' },
        }),
      );
      if (!r.ok) {
        return {
          finding: `alt_text was REJECTED at container creation: ${io.errorLabel(r.err)}. Close T-D3a as unsupported on this endpoint.`,
          evidence: io.errorEvidence(r.err),
        };
      }
      return {
        finding:
          'alt_text was ACCEPTED at container creation. Acceptance is not the same as effect — Graph tolerates unknown params on some endpoints, so confirm by publishing this container and reading alt_text back before adding it to CreateContainerParams.',
        evidence: r.value,
      };
    },
  },
  {
    name: 'mixed-carousel-container',
    lane: 'container',
    answers: ['CC-PUB-6 (docs-closed — confirmation only)'],
    describe: 'POST image child + video child + CAROUSEL album — confirm mixing is allowed',
    requires: ['imageUrl', 'videoUrl'],
    // §9 closed CC-PUB-6 from official docs; this only confirms it, and the
    // album container is never published. Kept because "the docs say so" and
    // "the API accepted it" are different classes of evidence and the cost here
    // is three unpublished containers.
    run: async (ctx, io) => {
      const image = await io.api.publishing.createMediaContainer(io.req, {
        igId: ctx.igId,
        imageUrl: ctx.imageUrl,
        isCarouselItem: true,
      });
      const video = await io.api.publishing.createMediaContainer(io.req, {
        igId: ctx.igId,
        videoUrl: ctx.videoUrl,
        isCarouselItem: true,
      });
      const r = await attempt(() =>
        io.api.publishing.createMediaContainer(io.req, {
          igId: ctx.igId,
          mediaType: 'CAROUSEL',
          children: [image.id, video.id],
        }),
      );
      if (!r.ok) {
        return {
          finding: `A mixed image+video album container was REJECTED: ${io.errorLabel(r.err)}. This CONTRADICTS the documentation cited in corner-cases §9 — re-read the row before trusting either.`,
          evidence: io.errorEvidence(r.err),
        };
      }
      return {
        finding: 'Mixed image+video album container accepted, as the docs say. Left unpublished.',
        evidence: { album: r.value, children: [image, video] },
      };
    },
  },

  // --- Lane: story (write, self-expiring) ----------------------------------
  {
    name: 'story-publish',
    lane: 'story',
    answers: ['CC-PUB-13', 'T-E4 publish-path smoke'],
    describe: 'Create a STORIES container, poll to FINISHED, publish — the cheapest real publish',
    requires: ['imageUrl'],
    needs: (ctx) =>
      ctx.quotaRemaining === 0
        ? 'publishing quota exhausted (content_publishing_limit)'
        : undefined,
    // Every publish-side row below needs a container that has actually been
    // published. A story is the only one that cleans itself up.
    run: async (ctx, io) => {
      const container = await io.api.publishing.createMediaContainer(io.req, {
        igId: ctx.igId,
        mediaType: 'STORIES',
        imageUrl: ctx.imageUrl,
      });
      const status = await io.pollUntilFinished(container.id);
      if (status.statusCode !== 'FINISHED') {
        return {
          status: 'FAIL',
          reason: `container never reached FINISHED (last status: ${status.statusCode ?? 'unknown'})`,
          finding:
            'The container did not finish inside the poll budget, so nothing was published. Container id is in the evidence — resume rather than re-create (CC-PUB-2).',
          evidence: { container, status },
        };
      }
      const published = await io.api.publishing.publishMedia(io.req, {
        igId: ctx.igId,
        creationId: container.id,
      });
      ctx.storyContainerId = container.id;
      ctx.storyMediaId = published.id;
      return {
        finding:
          'Story published. It self-expires in 24 h, so no cleanup is owed. The container id is retained for the double-publish probe.',
        evidence: { container, status, published },
      };
    },
  },
  {
    name: 'double-publish',
    lane: 'story',
    answers: ['CC-PUB-4'],
    describe: 'POST /{ig-id}/media_publish a SECOND time with the same creation_id',
    needs: (ctx) =>
      ctx.storyContainerId ? undefined : 'no container was published by this run to re-publish',
    // The model-retry scenario. src/api/publishing.ts claims it can recognise an
    // already-PUBLISHED container and report idempotent success; the official
    // error reference lists no already-published subcode, so the shape it must
    // recognise is currently a guess.
    run: async (ctx, io) => {
      const r = await attempt(() =>
        io.api.publishing.publishMedia(io.req, {
          igId: ctx.igId,
          creationId: ctx.storyContainerId,
        }),
      );
      if (!r.ok) {
        return {
          finding:
            `The second publish was REJECTED: ${io.errorLabel(r.err)}. This code/subcode pair is what runPublishFlow must ` +
            'recognise as "already published" — pin it as a fixture and stop guessing.',
          evidence: io.errorEvidence(r.err),
        };
      }
      return {
        status: 'FAIL',
        reason: 'the same creation_id published TWICE without an error',
        finding:
          'Meta accepted a duplicate publish for one creation_id. That is a duplicate public post and it means a model retry can double-post — the "never auto-retry media_publish" rule in operations.md §2 is load-bearing, not belt-and-braces.',
        evidence: r.value,
      };
    },
  },
  {
    name: 'story-metrics',
    lane: 'story',
    answers: ['CC-INS-2 (STORY row of the metric matrix)'],
    describe: 'GET /{story-media-id}/insights with the STORY metric set',
    overrides: INSIGHTS_OVERRIDES,
    needs: (ctx) => (ctx.storyMediaId ? undefined : 'no story was published by this run'),
    // MEDIA_METRIC_MATRIX.STORY has never met a story.
    run: async (ctx, io) => {
      const metrics = ctx.storyMetrics.join(',');
      const r = await attempt(() =>
        io.req({
          method: 'GET',
          path: `/${ctx.storyMediaId}/insights`,
          params: { metric: metrics },
        }),
      );
      if (!r.ok) {
        return {
          finding: `The shipped STORY metric row was rejected: ${io.errorLabel(r.err)}. The error names the offending metric — fix MEDIA_METRIC_MATRIX.STORY.`,
          evidence: io.errorEvidence(r.err),
        };
      }
      const returned = (r.value?.data ?? []).map((m) => m?.name).filter(Boolean);
      return {
        finding: `${returned.length}/${ctx.storyMetrics.length} STORY metrics returned data. A freshly published story usually has near-zero values; presence, not magnitude, is the evidence.`,
        evidence: r.value,
      };
    },
  },

  // --- Lane: feed (write, permanent) ---------------------------------------
  {
    name: 'feed-publish',
    lane: 'feed',
    answers: ['T-E4 feed substrate'],
    describe: 'Publish ONE feed image — only to give the comment lane something to comment on',
    requires: ['imageUrl'],
    needs: (ctx) =>
      ctx.commentableMediaId !== undefined
        ? 'the account already has commentable media — no new feed post is needed'
        : ctx.quotaRemaining === 0
          ? 'publishing quota exhausted (content_publishing_limit)'
          : undefined,
    // Deliberately skips itself when the account already has media. A permanent,
    // undeletable post is not something to publish for tidiness.
    run: async (ctx, io) => {
      const container = await io.api.publishing.createMediaContainer(io.req, {
        igId: ctx.igId,
        imageUrl: ctx.imageUrl,
        caption: 'live-probe substrate — safe to delete from the app',
      });
      const status = await io.pollUntilFinished(container.id);
      if (status.statusCode !== 'FINISHED') {
        return {
          status: 'FAIL',
          reason: `container never reached FINISHED (last status: ${status.statusCode ?? 'unknown'})`,
          finding:
            'Nothing was published; the container id is in the evidence for a manual resume.',
          evidence: { container, status },
        };
      }
      const published = await io.api.publishing.publishMedia(io.req, {
        igId: ctx.igId,
        creationId: container.id,
      });
      ctx.commentableMediaId = published.id;
      ctx.feedMediaId = published.id;
      return {
        finding:
          'Feed image published. It CANNOT be deleted through the API — remove it from the Instagram app if the junk account is being kept clean.',
        evidence: { container, status, published },
      };
    },
  },

  // --- Lane: comment (write, self-cleaning) --------------------------------
  {
    name: 'own-comment',
    lane: 'comment',
    answers: ['CC-COM-3', 'CC-COM-5 substrate'],
    describe: 'POST /{media-id}/comments — the comment the moderation probes operate on',
    needs: (ctx) =>
      ctx.commentableMediaId
        ? undefined
        : 'no commentable media on the account — publish one by hand or pass --allow-feed-post',
    run: async (ctx, io) => {
      const r = await io.api.comments.createComment(io.req, {
        mediaId: ctx.commentableMediaId,
        message: 'live-probe substrate comment',
      });
      ctx.ownCommentId = r.id;
      io.trackCreatedComment(r.id);
      return {
        finding: 'Comment created on the account’s own media; scheduled for cleanup by this run.',
        evidence: r,
      };
    },
  },
  {
    name: 'hide-own-comment',
    lane: 'comment',
    answers: ['CC-COM-5 (docs-closed — confirmation only)'],
    describe: 'POST /{comment-id}?hide=true then read `hidden` back — the owner-comment no-op',
    needs: (ctx) => (ctx.ownCommentId ? undefined : 'no comment of ours to hide'),
    // The docs say an owner's own comment on their own media stays visible even
    // with hide=true — the call succeeds and does nothing. The tool must SAY so
    // rather than report a hidden comment, and that claim is worth confirming
    // because it is the difference between an honest tool and a lying one.
    run: async (ctx, io) => {
      const ack = await io.api.comments.setCommentHidden(io.req, {
        commentId: ctx.ownCommentId,
        hide: true,
      });
      const after = await io.req({
        method: 'GET',
        path: `/${ctx.ownCommentId}`,
        params: { fields: 'id,hidden' },
      });
      // Leave no state behind that the operator did not ask for.
      await attempt(() =>
        io.api.comments.setCommentHidden(io.req, { commentId: ctx.ownCommentId, hide: false }),
      );
      const hidden = after?.hidden;
      return {
        finding:
          `hide=true acknowledged (${JSON.stringify(ack)}); reading back, hidden=${String(hidden)}. ` +
          (hidden === true
            ? 'The flag DID stick on an owner comment — the documented "always displayed" rule may be about rendering, not the field. Say exactly that in the tool text.'
            : 'The flag did not stick, matching the documented no-op. get_comment/hide must report "accepted but not applied" rather than "hidden".'),
        evidence: { ack, after },
      };
    },
  },
  {
    name: 'comment-length-ladder',
    lane: 'comment',
    answers: ['CC-COM-6'],
    describe: `POST /{comment-id}/replies at lengths ${COMMENT_LENGTH_LADDER.join('/')} — bracket the undocumented cap`,
    needs: (ctx) => (ctx.ownCommentId ? undefined : 'no comment of ours to reply to'),
    // A ladder rather than a bisect, on purpose (see COMMENT_LENGTH_LADDER).
    // Every reply that succeeds is deleted at the end of the run — we created
    // it, so we may remove it; nothing else is ever touched.
    run: async (ctx, io) => {
      const rungs = [];
      for (const length of COMMENT_LENGTH_LADDER) {
        const r = await attempt(() =>
          io.api.comments.replyToComment(io.req, {
            commentId: ctx.ownCommentId,
            message: messageOfLength(length),
          }),
        );
        if (r.ok) {
          io.trackCreatedComment(r.value.id);
          rungs.push({ length, accepted: true });
        } else {
          rungs.push({ length, accepted: false, error: io.errorEvidence(r.err) });
          // A spam block (CC-COM-4) is not a length answer; stop rather than
          // record four more rejections and mistake them for a cap.
          if (io.errorKind(r.err) === 'rate_limit' || io.errorCode(r.err) === 368) break;
        }
        await pause(COMMENT_PAUSE_MS);
      }
      const accepted = rungs.filter((x) => x.accepted).map((x) => x.length);
      const rejected = rungs.filter((x) => !x.accepted).map((x) => x.length);
      const maxOk = accepted.length > 0 ? Math.max(...accepted) : undefined;
      const minBad = rejected.length > 0 ? Math.min(...rejected) : undefined;
      return {
        finding:
          maxOk === undefined
            ? 'Every rung was rejected — read the error evidence; this is more likely a permission or spam block than a length cap.'
            : minBad === undefined
              ? `Every rung up to ${maxOk} characters was accepted — the cap (if any) is above ${maxOk}. Widen COMMENT_LENGTH_LADDER and re-run.`
              : `The comment length cap lies in (${maxOk}, ${minBad}]. Replace the client-side guess in src/api/comments.ts with a bound derived from this.`,
        evidence: { rungs },
      };
    },
  },

  // --- Lane: auth (rotates the credential) ---------------------------------
  {
    name: 'refresh-old-token-fate',
    lane: 'auth',
    answers: ['CC-AUTH-14'],
    describe: 'Refresh the Path-A token, persist it, then replay a read with the OLD token',
    paths: ['ig-login'],
    pathReason:
      'CC-AUTH-14 is about the ig_refresh_token grant; Path B refreshes via fb_exchange_token, a different grant with a different answer',
    // The concurrency guard in core/refresh.ts assumes it matters whether the
    // old token survives a rotation, and Meta's reference is silent on it. The
    // new token is persisted through the SAME writer the `refresh` subcommand
    // uses, BEFORE the old token is replayed — otherwise a probe that proves the
    // old token dies would also lock the operator out.
    run: async (ctx, io) => {
      const oldToken = ctx.accessToken;
      const refreshed = await io.refreshAndPersist();
      const replay = await attempt(() =>
        io.reqWithToken(oldToken)({ method: 'GET', path: '/me', params: { fields: 'user_id' } }),
      );
      return {
        finding: replay.ok
          ? 'The OLD token still authenticates a read after a refresh ⇒ refresh does NOT invalidate the previous token. The re-read-before-write guard is about file corruption, not token death.'
          : `The OLD token FAILED after the refresh (${io.errorLabel(replay.err)}) ⇒ a rotation kills the previous token. Two concurrent instances refreshing is a real outage, and CC-AUTH-14's guard is load-bearing.`,
        evidence: {
          persistedTo: refreshed.persistedKeys,
          replay: replay.ok ? replay.value : io.errorEvidence(replay.err),
        },
      };
    },
  },
];

// --- Runner -----------------------------------------------------------------

/** Static gate evaluation — used by --dry-run and by the live runner alike. */
function staticGate(probe, args, authPath) {
  const lane = LANES.find((l) => l.id === probe.lane);
  const laneSkip = lane?.gate?.(args);
  if (laneSkip !== undefined) return laneSkip;
  if (probe.paths && authPath !== undefined && !probe.paths.includes(authPath)) {
    return probe.pathReason ?? `${probe.paths.join('/')} only`;
  }
  for (const requirement of probe.requires ?? []) {
    if (args[requirement] === undefined) {
      const flag = `--${requirement.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      return `needs ${flag}`;
    }
  }
  return undefined;
}

function selected(args) {
  if (args.only === undefined) return PROBES;
  const unknown = [...args.only].filter(
    (n) => !PROBES.some((p) => p.name === n) && !LANES.some((l) => l.id === n),
  );
  if (unknown.length > 0) throw new Error(`Unknown probe or lane: ${unknown.join(', ')}`);
  return PROBES.filter((p) => args.only.has(p.name) || args.only.has(p.lane));
}

/**
 * The plan, printed without touching dist/, the network or a credential. This is
 * the mode that is verifiable on a machine that will never have a token, so it
 * carries the full reasoning: lane order, why each lane sits where it does, what
 * every probe answers, and the exact gate keeping it from running.
 */
function printPlan(args, say) {
  const authPath = args.authPath;
  say('DRY RUN — no network call, no credential read, nothing written.\n');
  say(
    authPath === undefined
      ? 'Auth path unknown (pass --auth-path ig-login|fb-login to resolve the path gates).\n'
      : `Resolving path gates as: ${authPath}\n`,
  );
  const chosen = selected(args);
  let willRun = 0;
  for (const lane of LANES) {
    const probes = chosen.filter((p) => p.lane === lane.id);
    if (probes.length === 0) continue;
    say(`${lane.title}`);
    say(`  ${lane.why}`);
    for (const probe of probes) {
      const skip = staticGate(probe, args, authPath);
      const mark = skip === undefined ? 'RUN ' : 'SKIP';
      if (skip === undefined) willRun++;
      say(`  [${mark}] ${probe.name}`);
      say(`         answers : ${probe.answers.join(', ')}`);
      say(`         call    : ${probe.describe}`);
      if (skip !== undefined) say(`         skipped : ${skip}`);
      else if (probe.needs) say('         note    : may still SKIP on live data (see `needs`)');
    }
    say('');
  }
  say(
    `${willRun} probe(s) would run now; the rest are gated as shown. Runtime SKIPs are\n` +
      'decided against live data (an account with no media, a missing scope, an\n' +
      'exhausted quota) and cannot be predicted here.',
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // --dry-run stays above every import of dist/: the plan must be readable on a
  // tree that has never been built and in an environment with no credentials.
  if (args.dryRun) {
    printPlan(args, (line) => console.log(line));
    return 0;
  }

  const dist = await loadDist();
  const { registerSecret, createRedactor } = dist.redact;
  const { isInstagramError } = dist.types;
  const { createSanitizer, assertFixtureSafe } = dist.sanitize;

  await loadEnvFiles(dist.configWrite.resolveConfigHome);

  // Every line this script prints goes through the redactor, so a token cannot
  // reach the terminal even via an error message we did not anticipate.
  const redact = createRedactor();
  const say = (line) => console.log(String(redact(line)));

  let profiles;
  try {
    profiles = dist.config.loadProfiles();
  } catch (err) {
    console.error(
      'No credentials found. live-probe needs a live Instagram token in the\n' +
        'environment (the same variables the server reads):\n' +
        '  IG_ACCESS_TOKEN   — required\n' +
        '  IG_AUTH_PATH      — ig-login | fb-login (inferred when app id+secret are set)\n' +
        '  IG_ACCOUNT_ID     — required for fb-login\n' +
        '  IG_APP_ID / IG_APP_SECRET — required for fb-login\n' +
        'Run with --dry-run to see the plan without credentials.\n' +
        `Underlying error: ${String(redact(err?.message ?? err))}`,
    );
    return 2;
  }

  const profile = dist.config.resolveProfile(
    profiles.profiles,
    args.profile ?? profiles.defaultName,
  );

  // Register every secret BEFORE the first call, so redaction is exact-value
  // based (the primary mechanism) rather than pattern based. `authParams` also
  // yields the computed `appsecret_proof` — reusing the production HMAC rather
  // than recomputing it here means the registered proof is the real one.
  const authProvider = dist.auth.createAuthProvider(profile);
  const authParams = await authProvider.authParams(authProvider.defaultHost);
  const secrets = [profile.accessToken, profile.appSecret, ...Object.values(authParams)].filter(
    (value) => typeof value === 'string' && value.length >= 8,
  );
  for (const secret of secrets) registerSecret(secret);

  const igId = profile.accountId ?? (profile.authPath === 'ig-login' ? 'me' : undefined);
  if (igId === undefined) {
    console.error(
      'This fb-login profile has no IG_ACCOUNT_ID. Path B addresses the IG\n' +
        'professional account by id (`me` resolves to the Facebook user), so the\n' +
        'account id is required. Run `instagram-mcp doctor` to discover it.',
    );
    return 2;
  }

  const settings = dist.settings.loadSettings();
  const log = dist.log.createLogger({ level: 'warn', clock: dist.clock.systemClock, redact });

  // Usage headers are the only evidence we have for the roadmap's open question
  // about Development-mode apps facing lower limits, so keep the last snapshot
  // per host rather than throwing them away.
  const usageByHost = new Map();
  const makeRequest = (p) =>
    dist.http.createIgRequest({
      auth: dist.auth.createAuthProvider(p),
      settings,
      clock: dist.clock.systemClock,
      log,
      onUsage: (host, usage) => usageByHost.set(host, usage),
    });
  const req = makeRequest(profile);

  // ONE sanitizer for the whole run: that is what makes an id in one probe's
  // evidence the same synthetic id as in another's.
  const sanitizer = createSanitizer({ extraSecrets: secrets });

  const createdComments = [];
  const ctx = {
    igId,
    authPath: profile.authPath,
    host: authProvider.defaultHost,
    accessToken: profile.accessToken,
    configuredAccountId: profile.accountId,
    appSecretProof: authParams.appsecret_proof,
    accountMetrics: [...dist.insights.ACCOUNT_METRICS],
    storyMetrics: [...(dist.insights.MEDIA_METRIC_MATRIX.STORY ?? [])],
    imageUrl: args.imageUrl,
    videoUrl: args.videoUrl,
    discoveryUsername: args.discoveryUsername,
    nowMs: Date.now(),
  };

  // Path A cannot compute a proof unless the profile carries an app secret; the
  // provider only mints one for fb-login, so derive it here for that one probe.
  if (ctx.appSecretProof === undefined && profile.appSecret && profile.authPath === 'ig-login') {
    const { createHmac } = await import('node:crypto');
    ctx.appSecretProof = createHmac('sha256', profile.appSecret)
      .update(profile.accessToken)
      .digest('hex');
    registerSecret(ctx.appSecretProof);
    secrets.push(ctx.appSecretProof);
  }

  const errorLabel = (err) => {
    if (!isInstagramError(err)) return String(redact(err?.message ?? err));
    const bits = [err.kind];
    if (err.code !== undefined) bits.push(`code ${err.code}`);
    if (err.subcode !== undefined) bits.push(`subcode ${err.subcode}`);
    return `${bits.join(' / ')}: ${String(redact(err.message))}`;
  };

  const io = {
    req,
    api: { publishing: dist.publishing, comments: dist.comments, discovery: dist.discovery },
    errorLabel,
    errorKind: (err) => (isInstagramError(err) ? err.kind : 'transport'),
    errorCode: (err) => (isInstagramError(err) ? err.code : undefined),
    /** Meta's raw envelope rides on `cause`; without one, keep the mapped shape. */
    errorEvidence: (err) => {
      if (isInstagramError(err) && err.cause !== undefined) return err.cause;
      return { error: { message: String(redact(err?.message ?? err)) } };
    },
    trackCreatedComment: (id) => {
      if (typeof id === 'string') createdComments.push(id);
    },
    /** Poll a container to a terminal state, bounded — mirrors runPublishFlow. */
    pollUntilFinished: async (containerId) => {
      const deadline = Date.now() + POLL_BUDGET_MS;
      let status = await dist.publishing.getContainerStatus(req, { containerId });
      while (status.statusCode === 'IN_PROGRESS' && Date.now() < deadline) {
        await pause(POLL_INTERVAL_MS);
        status = await dist.publishing.getContainerStatus(req, { containerId });
      }
      return status;
    },
    /** A one-off seam bound to a specific token — only the CC-AUTH-14 replay. */
    reqWithToken: (token) => makeRequest({ ...profile, accessToken: token }),
    /** Refresh through the production path and persist exactly as `refresh` does. */
    refreshAndPersist: async () => {
      const refreshed = await dist.refresh.refreshToken({
        authPath: profile.authPath,
        accessToken: profile.accessToken,
        appId: profile.appId,
        appSecret: profile.appSecret,
        nowMs: Date.now(),
      });
      registerSecret(refreshed.accessToken);
      secrets.push(refreshed.accessToken);
      const written = await dist.configWrite.writeCredentials(profile.name, {
        accessToken: refreshed.accessToken,
        authPath: profile.authPath,
        accountId: profile.accountId,
        appId: profile.appId,
        appSecret: profile.appSecret,
        expiresAtSec: refreshed.expiresAtSec,
      });
      return { persistedKeys: written.keys };
    },
  };

  const chosen = selected(args);
  say(`Profile '${profile.name}' (${profile.authPath}) against ${ctx.host}`);
  say(
    args.allowWrites
      ? 'WRITES ENABLED — containers, one story' +
          (args.allowFeedPost ? ', ONE PERMANENT FEED POST' : '') +
          (args.allowTokenRefresh ? ', and a TOKEN ROTATION' : '') +
          '.\n'
      : 'Read-only run. Pass --allow-writes to enable the publishing/moderation lanes.\n',
  );

  const results = [];
  let failed = 0;

  for (const lane of LANES) {
    const probes = chosen.filter((p) => p.lane === lane.id);
    if (probes.length === 0) continue;
    say(`--- ${lane.title}`);

    for (const probe of probes) {
      const record = {
        name: probe.name,
        lane: probe.lane,
        answers: probe.answers,
        describe: probe.describe,
      };

      const gated = staticGate(probe, args, profile.authPath) ?? probe.needs?.(ctx);
      if (gated !== undefined) {
        record.status = 'SKIP';
        record.reason = gated;
        results.push(record);
        say(`  SKIP ${probe.name.padEnd(28)} ${gated}`);
        continue;
      }

      let outcome;
      try {
        outcome = await probe.run(ctx, io);
      } catch (err) {
        // An unexpected throw means the probe learned nothing — that is a FAIL,
        // distinct from a probe whose answer happens to be a Graph error.
        record.status = 'FAIL';
        record.reason = errorLabel(err);
        record.evidence = sanitizer.sanitize(io.errorEvidence(err), probe.overrides);
        results.push(record);
        failed++;
        say(`  FAIL ${probe.name.padEnd(28)} ${record.reason}`);
        continue;
      }

      record.status = outcome.status ?? 'PASS';
      if (outcome.reason !== undefined) record.reason = outcome.reason;
      record.finding = outcome.finding;
      if (outcome.evidence !== undefined) {
        record.evidence = sanitizer.sanitize(outcome.evidence, probe.overrides);
      }
      if (record.status === 'FAIL') failed++;
      results.push(record);
      say(`  ${record.status} ${probe.name.padEnd(28)} ${outcome.finding}`);
    }
    say('');
  }

  // Cleanup: exactly the comments this run created, newest first so a reply is
  // removed before the comment it hangs off.
  if (args.cleanup && createdComments.length > 0) {
    say(`Cleaning up ${createdComments.length} comment(s) this run created…`);
    for (const id of [...createdComments].reverse()) {
      const r = await attempt(() => dist.comments.deleteComment(req, { commentId: id }));
      if (!r.ok) say(`  could not delete one comment: ${errorLabel(r.err)}`);
    }
  } else if (createdComments.length > 0) {
    say(`--no-cleanup: ${createdComments.length} comment(s) left in place deliberately.`);
  }

  const report = {
    harness: 'scripts/live-probe.mjs',
    generatedAt: new Date().toISOString(),
    profile: profile.name,
    authPath: profile.authPath,
    flags: {
      allowWrites: args.allowWrites,
      allowFeedPost: args.allowFeedPost,
      allowTokenRefresh: args.allowTokenRefresh,
      cleanup: args.cleanup,
    },
    summary: {
      pass: results.filter((r) => r.status === 'PASS').length,
      fail: results.filter((r) => r.status === 'FAIL').length,
      skip: results.filter((r) => r.status === 'SKIP').length,
    },
    // Evidence for the roadmap's open question about Development-mode limits.
    usageHeaders: Object.fromEntries(usageByHost),
    probes: results,
    droppedKeys: sanitizer.droppedKeys,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  // The same three gates capture-fixtures uses, in the same order, for the same
  // reason: this is the failure that cannot be undone once it has been shared.
  assertFixtureSafe(report, 'live-probe report');
  for (const secret of secrets) {
    if (serialized.includes(secret)) {
      throw new Error('Refusing to write the report: it still contains a credential.');
    }
  }

  const outPath = resolve(args.out ?? join(process.cwd(), 'live-probe-report.json'));
  writeFileSync(outPath, serialized);

  say(`Report: ${outPath}`);
  say(
    `  ${report.summary.pass} PASS · ${report.summary.fail} FAIL · ${report.summary.skip} SKIP\n` +
      '\nEvidence, not a verdict: read the findings, then replace the matching\n' +
      '[verify] markers in docs/corner-cases.md with [verified <date>] and the\n' +
      'observed behavior. The report holds sanitized responses only, but it is not\n' +
      'a repository artefact — transcribe what matters and delete it, or point\n' +
      '--out outside the working tree.',
  );
  if (sanitizer.droppedKeys.length > 0) {
    say(
      `\n${sanitizer.droppedKeys.length} field path(s) were dropped as unrecognised (default deny).\n` +
        'A dropped path that a finding genuinely needs is a policy change in\n' +
        'test/helpers/sanitize.ts (DEFAULT_FIELD_POLICY) — reviewed like any code.',
    );
  }

  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Nothing here may print a raw value: the message is scrubbed by the
    // redactor when one exists, and is a fixed string otherwise.
    console.error(`live-probe failed: ${err?.message ?? String(err)}`);
    process.exit(1);
  });
