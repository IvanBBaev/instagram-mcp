/**
 * Fixture capture harness (workplan T-E1).
 *
 * Records a small set of **read-only** Graph responses from a live account,
 * sanitizes each one, and writes the result to `test/fixtures/<name>.json` so
 * mocked unit tests can replay real wire shapes without the repository ever
 * holding a token, a real ID, a handle, a CDN URL or a line of user text.
 *
 * Usage (requires a built `dist/` and live credentials in the environment):
 *
 *     npm run build
 *     node scripts/capture-fixtures.mjs --dry-run      # plan only, no network
 *     node scripts/capture-fixtures.mjs                # capture + write
 *     node scripts/capture-fixtures.mjs --profile brand --only account,media-list
 *
 * Guarantees, in order of how much they matter:
 *
 *  1. **Read-only.** The Graph seam is wrapped in a guard that throws on any
 *     method other than GET, so this script cannot publish, comment, hide or
 *     delete even if a future edit asks it to.
 *  2. **Nothing unsanitized reaches disk.** Every response goes through
 *     `test/helpers/sanitize.ts` (default-deny allowlist + the production
 *     redactor), then through `assertFixtureSafe()`, then through an exact
 *     substring check against the live credentials. A fixture that trips any of
 *     the three is not written.
 *  3. **No secret is ever printed.** The live token, the app secret and the
 *     computed `appsecret_proof` are registered with the redactor before the
 *     first call, and every line this script prints is passed through it.
 *
 * Credentials are read exactly the way the server reads them — same env files
 * (`IG_ENV_FILE`, the config home, then the project `.env`, `override: false`),
 * same variables (`IG_ACCESS_TOKEN`, `IG_AUTH_PATH`/`IG_AUTH_MODE`,
 * `IG_ACCOUNT_ID`, `IG_APP_ID`, `IG_APP_SECRET`, `IG_PROFILE_<NAME>_*`,
 * `IG_ACTIVE_PROFILE`) — by calling `core/config.js` rather than re-implementing
 * it. There are deliberately no capture-only env var names.
 *
 * A plain ESM script outside `tsconfig` (`scripts/**` is not compiled), so it
 * imports the COMPILED modules from `dist/`.
 *
 * FIELD LISTS: the `*_FIELDS` constants below duplicate module-private constants
 * in `src/api/*.ts`, because fixtures must capture the RAW wire shape (the api
 * layer returns mapped domain objects, which is not what a wire fixture is for)
 * and those constants are not exported. When a field set changes in `src/api/`,
 * update it here and re-capture — a stale field list yields a fixture that no
 * longer matches what the server actually asks Graph for.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Field sets (mirrors of src/api/*.ts — see the header note) -------------

const ACCOUNT_FIELDS =
  'username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count';

const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,' +
  'like_count,comments_count';

const CHILD_FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,timestamp';

const MEDIA_DETAIL_FIELDS = `${MEDIA_FIELDS},children{${CHILD_FIELDS}}`;

const COMMENT_FIELDS =
  'id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}';

const COMMENT_DETAIL_FIELDS =
  'id,text,username,timestamp,like_count,hidden,parent_id,media{id,media_type,permalink},' +
  'replies{id,text,username,timestamp,like_count}';

const TAGGED_MEDIA_FIELDS = 'id,caption,media_type,media_url,permalink,timestamp,username';

/** Small page size: a fixture needs shape, not volume, and calls cost quota. */
const PAGE_LIMIT = 5;

/** Insights fields carry Meta's own metric vocabulary in `name`. */
const INSIGHTS_OVERRIDES = { name: 'keep' };

// --- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false, profile: undefined, only: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--profile') args.profile = argv[++i];
    else if (arg === '--only') args.only = new Set((argv[++i] ?? '').split(',').filter(Boolean));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const USAGE = `Usage: node scripts/capture-fixtures.mjs [options]

  --dry-run            List what would be captured; make no network call, write nothing.
  --profile <name>     Account profile to capture from (default: IG_ACTIVE_PROFILE).
  --only <a,b,c>       Capture only these fixture names.
  -h, --help           Show this help.

Requires a built dist/ (npm run build) and live credentials in the environment.
Every call is a GET; the script cannot write to Instagram.`;

// --- dist loading -----------------------------------------------------------

/**
 * Import the compiled modules. Dynamic so a missing build produces an
 * instruction instead of an unhandled module-resolution stack trace.
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
    import('../dist/src/core/config-write.js'),
    import('../dist/src/core/types.js'),
    import('../dist/src/api/insights.js'),
    import('../dist/test/helpers/sanitize.js'),
    import('../dist/test/helpers/fixtures.js'),
  ]);
  const keys = [
    'config',
    'settings',
    'auth',
    'http',
    'clock',
    'log',
    'redact',
    'configWrite',
    'types',
    'insights',
    'sanitize',
    'fixtures',
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
    // successful load prints the loaded env-file path to stdout, which would
    // both pollute this script's output and disclose the config-home location.
    if (existsSync(file)) dotenvConfig({ path: file, override: false, quiet: true });
  }
}

// --- The capture plan -------------------------------------------------------

/**
 * Each entry is one read-only Graph call. `needs` gates on what the profile can
 * do; `build` may depend on IDs discovered by an earlier capture (`ctx`), which
 * is why the plan is ordered and runs sequentially.
 */
const CAPTURES = [
  {
    name: 'account',
    describe: 'GET /{ig-id} — profile of the operated account',
    build: (ctx) => ({ method: 'GET', path: `/${ctx.igId}`, params: { fields: ACCOUNT_FIELDS } }),
  },
  {
    name: 'media-list',
    describe: 'GET /{ig-id}/media — one page of own media',
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.igId}/media`,
      params: { fields: MEDIA_FIELDS, limit: PAGE_LIMIT },
    }),
    // Everything below hangs off the first media object this page returns.
    collect: (raw, ctx) => {
      const items = Array.isArray(raw?.data) ? raw.data : [];
      ctx.mediaId = items.find((m) => typeof m?.id === 'string')?.id;
      ctx.albumId = items.find((m) => m?.media_type === 'CAROUSEL_ALBUM')?.id;
    },
  },
  {
    name: 'media-detail',
    describe: 'GET /{media-id} — single media with children expanded',
    needs: (ctx) => (ctx.mediaId ? undefined : 'no media found on the account'),
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.mediaId}`,
      params: { fields: MEDIA_DETAIL_FIELDS },
    }),
  },
  {
    name: 'media-children',
    describe: 'GET /{media-id}/children — carousel children edge',
    needs: (ctx) => (ctx.albumId ? undefined : 'no carousel album in the first media page'),
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.albumId}/children`,
      params: { fields: CHILD_FIELDS },
    }),
  },
  {
    name: 'comments',
    describe: 'GET /{media-id}/comments — one page of comments',
    needs: (ctx) => (ctx.mediaId ? undefined : 'no media found on the account'),
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.mediaId}/comments`,
      params: { fields: COMMENT_FIELDS, limit: PAGE_LIMIT },
    }),
    collect: (raw, ctx) => {
      const items = Array.isArray(raw?.data) ? raw.data : [];
      ctx.commentId = items.find((c) => typeof c?.id === 'string')?.id;
    },
  },
  {
    name: 'comment-detail',
    describe: 'GET /{comment-id} — comment with moderation state',
    needs: (ctx) => (ctx.commentId ? undefined : 'no comment found on the first media'),
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.commentId}`,
      params: { fields: COMMENT_DETAIL_FIELDS },
    }),
  },
  {
    name: 'tags',
    describe: 'GET /{ig-id}/tags — media the account is tagged in',
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.igId}/tags`,
      params: { fields: TAGGED_MEDIA_FIELDS, limit: PAGE_LIMIT },
    }),
  },
  {
    name: 'insights-account',
    describe: 'GET /{ig-id}/insights — account metrics (total_value)',
    overrides: INSIGHTS_OVERRIDES,
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.igId}/insights`,
      params: {
        metric: ctx.accountMetrics.join(','),
        period: 'day',
        metric_type: 'total_value',
      },
    }),
  },
  {
    name: 'insights-account-timeseries',
    describe: 'GET /{ig-id}/insights — time series (carries `end_time`, CC-INS-4)',
    overrides: INSIGHTS_OVERRIDES,
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.igId}/insights`,
      params: {
        metric: 'reach',
        period: 'day',
        metric_type: 'time_series',
        since: ctx.sinceSec,
        until: ctx.untilSec,
      },
    }),
  },
  {
    name: 'insights-media',
    describe: 'GET /{media-id}/insights — media metrics',
    overrides: INSIGHTS_OVERRIDES,
    needs: (ctx) => (ctx.mediaId ? undefined : 'no media found on the account'),
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.mediaId}/insights`,
      params: { metric: ctx.mediaMetrics.join(',') },
    }),
  },
  {
    name: 'content-publishing-limit',
    describe: 'GET /{ig-id}/content_publishing_limit — publishing quota (read-only)',
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.igId}/content_publishing_limit`,
      params: { fields: 'config,quota_usage' },
    }),
  },
  {
    name: 'linked-accounts',
    describe: 'GET /me/accounts — Pages and their linked IG accounts',
    needs: (ctx) => (ctx.authPath === 'fb-login' ? undefined : 'fb-login only'),
    build: () => ({
      method: 'GET',
      path: '/me/accounts',
      params: { fields: 'name,instagram_business_account{id,username}' },
      host: 'graph.facebook.com',
    }),
  },
  {
    name: 'debug-token',
    describe: 'GET /debug_token — token introspection envelope',
    needs: (ctx) => (ctx.authPath === 'fb-login' ? undefined : 'fb-login only (Path B)'),
    build: (ctx) => ({
      method: 'GET',
      path: '/debug_token',
      params: { input_token: ctx.accessToken },
      host: 'graph.facebook.com',
    }),
  },
  {
    // Fixture-driven error taxonomy (QA review F13): the ONE deliberately failing
    // call, so the mapped-error tests have a real Graph envelope to work from.
    // Still a GET, and still cheaper than guessing what Meta returns.
    name: 'error-invalid-metric',
    describe: 'GET /{ig-id}/insights with an unknown metric — real Graph error envelope',
    expectError: true,
    build: (ctx) => ({
      method: 'GET',
      path: `/${ctx.igId}/insights`,
      params: { metric: 'not_a_real_metric', period: 'day' },
    }),
  },
];

// --- Runner -----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
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
      'No credentials found. capture-fixtures needs a live, read-capable Instagram\n' +
        'token in the environment (the same variables the server reads):\n' +
        '  IG_ACCESS_TOKEN   — required\n' +
        '  IG_AUTH_PATH      — ig-login | fb-login (inferred when app id+secret are set)\n' +
        '  IG_ACCOUNT_ID     — required for fb-login\n' +
        '  IG_APP_ID / IG_APP_SECRET — required for fb-login\n' +
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

  const nowSec = Math.floor(Date.now() / 1000);
  const ctx = {
    igId,
    authPath: profile.authPath,
    accessToken: profile.accessToken,
    accountMetrics: [...dist.insights.ACCOUNT_METRICS],
    mediaMetrics: [...dist.insights.DEFAULT_MEDIA_METRICS],
    sinceSec: nowSec - 7 * 24 * 60 * 60,
    untilSec: nowSec,
  };

  const selected = CAPTURES.filter((c) => args.only === undefined || args.only.has(c.name));
  if (args.only !== undefined) {
    for (const name of args.only) {
      if (!CAPTURES.some((c) => c.name === name)) throw new Error(`Unknown fixture name: ${name}`);
    }
  }

  const outDir = dist.fixtures.fixturesDirFor(repoRoot);
  say(`Profile '${profile.name}' (${profile.authPath}) -> ${outDir}`);
  say(args.dryRun ? 'DRY RUN — no network call, nothing written.\n' : '');

  if (args.dryRun) {
    for (const capture of selected) say(`  ${capture.name.padEnd(28)} ${capture.describe}`);
    say('\nRun without --dry-run to capture. Skips depend on live data (a carousel');
    say("album, a comment) and on the profile's auth path, so the real run may");
    say('produce fewer fixtures than this plan.');
    return 0;
  }

  // The one network seam, exactly as the server builds it — plus a read-only
  // guard. `warn` keeps the logger quiet unless something actually goes wrong.
  const log = dist.log.createLogger({ level: 'warn', clock: dist.clock.systemClock, redact });
  const rawRequest = dist.http.createIgRequest({
    auth: authProvider,
    settings: dist.settings.loadSettings(),
    clock: dist.clock.systemClock,
    log,
  });
  /** Read-only guard: this harness must never be able to change the account. */
  const req = (opts) => {
    if (opts.method !== 'GET') {
      throw new Error(`capture-fixtures is read-only; refusing a ${opts.method} request.`);
    }
    return rawRequest(opts);
  };

  // ONE sanitizer for the whole run: that is what makes a media id in
  // `media-list.json` the same synthetic id as in `media-detail.json`.
  const sanitizer = createSanitizer({ extraSecrets: secrets });
  mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const capture of selected) {
    const skip = capture.needs?.(ctx);
    if (skip !== undefined) {
      results.push({ name: capture.name, status: `skipped (${skip})` });
      continue;
    }

    let raw;
    try {
      raw = await req(capture.build(ctx));
      if (capture.expectError) {
        results.push({ name: capture.name, status: 'skipped (call unexpectedly succeeded)' });
        continue;
      }
    } catch (err) {
      // An expected error IS the fixture: Meta's raw envelope rides on `cause`.
      if (capture.expectError && isInstagramError(err) && err.cause !== undefined) {
        raw = err.cause;
      } else {
        const kind = isInstagramError(err) ? err.kind : 'transport';
        results.push({
          name: capture.name,
          status: `failed (${kind}: ${String(redact(err?.message ?? err))})`,
        });
        continue;
      }
    }

    capture.collect?.(raw, ctx);

    // One shared sanitizer (stable IDs across fixtures), per-endpoint policy.
    const value = sanitizer.sanitize(raw, capture.overrides);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;

    // Gate 1: would the production redactor still change anything?
    assertFixtureSafe(value, capture.name);
    // Gate 2: exact substring check against the live credentials, independent of
    // the redactor's patterns. Belt and braces, because this is the failure that
    // cannot be undone once it is in git history.
    for (const secret of secrets) {
      if (serialized.includes(secret)) {
        throw new Error(`Refusing to write ${capture.name}.json: it still contains a credential.`);
      }
    }

    writeFileSync(join(outDir, `${capture.name}.json`), serialized);
    results.push({ name: capture.name, status: `written (${serialized.length} bytes)` });
  }

  say('');
  for (const result of results) say(`  ${result.name.padEnd(28)} ${result.status}`);

  const dropped = sanitizer.droppedKeys;
  say(`\n${dropped.length} field path(s) dropped as unrecognised (default deny):`);
  for (const path of dropped) say(`  ${path}`);
  say(
    '\nA dropped path that a test genuinely needs is a policy change in\n' +
      'test/helpers/sanitize.ts (DEFAULT_FIELD_POLICY) — reviewed like any code.\n' +
      'Read the fixture diff before committing it.',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Nothing here may print a raw value: the message is scrubbed by the
    // redactor when one exists, and is a fixed string otherwise.
    console.error(`capture-fixtures failed: ${err?.message ?? String(err)}`);
    process.exit(1);
  });
