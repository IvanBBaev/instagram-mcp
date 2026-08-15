/**
 * Contract tests for `ToolSpec.logFields` across every tool package.
 *
 * `logFields` is declared in `mcp/define.ts` as "fields safe to log — never
 * secrets", and docs/security.md §2 relies on that property: whatever a spec
 * returns here is destined for a log sink, so it must stay low-cardinality
 * metadata and must never echo the free text or media URLs the caller passed in
 * (a caption, a comment body, a signed CDN URL). These tests pin the exact
 * payload each spec declares and then sweep it for canary values planted in the
 * sensitive arguments, so a future edit that "helpfully" logs the message body
 * fails here instead of shipping.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult, ToolSpec } from '../../src/mcp/define.js';
import { registerTools } from '../../src/mcp/registry.js';
import { REDACTED, registerSecret } from '../../src/core/redact.js';
import type { Logger, ResolvedProfile } from '../../src/core/types.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { testSettings } from '../helpers/settings.js';
import { allTools } from '../../src/tools/index.js';

/**
 * The live-path tests below drive real write specs with `apply: true`, and an
 * applied write appends to `settings.writeJournal`. Point it at a temp file so
 * the suite never touches the operator's real audit log at
 * ~/.local/state/instagram-mcp-ai/writes.jsonl.
 */
const journalDir = mkdtempSync(join(tmpdir(), 'ig-log-fields-journal-'));
const journalPath = join(journalDir, 'writes.jsonl');
after(() => rmSync(journalDir, { recursive: true, force: true }));

type RegisterCb = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

/**
 * Values planted in arguments that must never reach a log line. Each is unique
 * so the sweep can name the offender.
 */
const CANARIES = {
  message: 'CANARY-MESSAGE-BODY',
  caption: 'CANARY-CAPTION-BODY',
  imageUrl: 'https://cdn.example.com/CANARY-IMAGE-URL.jpg',
  imageUrl2: 'https://cdn.example.com/CANARY-IMAGE-URL-2.jpg',
  videoUrl: 'https://cdn.example.com/CANARY-VIDEO-URL.mp4',
  coverUrl: 'https://cdn.example.com/CANARY-COVER-URL.jpg',
} as const;

const ALL_CANARIES = Object.values(CANARIES);

interface LogCase {
  /** Tool name. */
  name: string;
  /** Args handed to `logFields` — sensitive fields carry canary values. */
  args: Record<string, unknown>;
  /** The exact record the spec must produce. */
  expect: Record<string, unknown>;
}

/**
 * One row per tool that declares `logFields`. `expect` is a deepEqual target:
 * adding a field to a spec's log payload must be a deliberate edit here too.
 */
const CASES: LogCase[] = [
  // --- account -------------------------------------------------------------
  {
    name: 'instagram_get_account',
    args: { account: 'brand' },
    expect: { account: 'brand' },
  },
  {
    name: 'instagram_list_linked_accounts',
    args: { account: 'brand' },
    expect: { account: 'brand' },
  },
  {
    name: 'instagram_token_status',
    args: { account: 'brand' },
    expect: { account: 'brand' },
  },

  // --- media ---------------------------------------------------------------
  {
    name: 'instagram_list_media',
    args: { limit: 25, fetchAll: true, after: 'CURSOR' },
    expect: { limit: 25, fetchAll: true, hasCursor: true },
  },
  {
    name: 'instagram_get_media',
    args: { mediaId: 'M1' },
    expect: { mediaId: 'M1' },
  },

  // --- insights ------------------------------------------------------------
  {
    name: 'instagram_get_account_insights',
    args: { period: 'day', metric_type: 'total_value', since: 1, until: 2 },
    expect: {
      metrics: 'default',
      period: 'day',
      metric_type: 'total_value',
      since: 1,
      until: 2,
    },
  },
  {
    name: 'instagram_get_media_insights',
    args: { media_id: 'M1', metrics: ['views'], media_product_type: 'REELS' },
    expect: { media_id: 'M1', metrics: ['views'], media_product_type: 'REELS' },
  },
  {
    name: 'instagram_get_audience_demographics',
    args: { breakdown: 'city', timeframe: 'this_month' },
    expect: { metrics: 'default', breakdown: 'city', timeframe: 'this_month' },
  },

  // --- publishing ----------------------------------------------------------
  {
    name: 'instagram_create_media_container',
    args: { imageUrl: CANARIES.imageUrl, caption: CANARIES.caption, apply: true },
    expect: {
      mediaType: '(feed-image)',
      hasImage: true,
      hasVideo: false,
      children: 0,
      apply: true,
    },
  },
  {
    name: 'instagram_get_container_status',
    args: { containerId: 'C1' },
    expect: { containerId: 'C1' },
  },
  {
    name: 'instagram_publish_media',
    args: { creationId: 'C1' },
    expect: { creationId: 'C1', apply: false },
  },
  {
    name: 'instagram_post_image',
    args: {
      imageUrls: [CANARIES.imageUrl, CANARIES.imageUrl2],
      caption: CANARIES.caption,
      apply: true,
    },
    expect: { images: 2, resume: false, apply: true },
  },
  {
    name: 'instagram_post_reel',
    args: {
      videoUrl: CANARIES.videoUrl,
      coverUrl: CANARIES.coverUrl,
      caption: CANARIES.caption,
      resumeContainerId: 'C7',
    },
    expect: { hasVideo: true, resume: true, apply: false },
  },
  {
    name: 'instagram_post_story',
    args: { videoUrl: CANARIES.videoUrl },
    expect: { source: 'video', resume: false, apply: false },
  },

  // --- comments ------------------------------------------------------------
  {
    name: 'instagram_list_comments',
    args: { mediaId: 'M1', limit: 10 },
    expect: { mediaId: 'M1', limit: 10, fetchAll: false, hasCursor: false },
  },
  {
    name: 'instagram_get_comment',
    args: { commentId: 'C1' },
    expect: { commentId: 'C1' },
  },
  {
    name: 'instagram_list_tagged_media',
    args: { fetchAll: true, after: 'CURSOR' },
    expect: { limit: undefined, fetchAll: true, hasCursor: true },
  },
  {
    name: 'instagram_reply_to_comment',
    args: { commentId: 'C1', message: CANARIES.message, apply: true },
    expect: { commentId: 'C1', apply: true },
  },
  {
    name: 'instagram_create_comment',
    args: { mediaId: 'M1', message: CANARIES.message },
    expect: { mediaId: 'M1', apply: false },
  },
  {
    name: 'instagram_hide_comment',
    args: { commentId: 'C1', apply: true },
    expect: { commentId: 'C1', apply: true },
  },
  {
    name: 'instagram_unhide_comment',
    args: { commentId: 'C1' },
    expect: { commentId: 'C1', apply: false },
  },
  {
    name: 'instagram_delete_comment',
    args: { commentId: 'C1', apply: true },
    expect: { commentId: 'C1', apply: true },
  },
  {
    name: 'instagram_set_comments_enabled',
    args: { mediaId: 'M1', enabled: false, apply: true },
    expect: { mediaId: 'M1', enabled: false, apply: true },
  },

  // --- discovery -----------------------------------------------------------
  {
    name: 'instagram_search_hashtag',
    args: { hashtag: '#nofilter' },
    expect: { hashtag: '#nofilter' },
  },
  {
    name: 'instagram_get_hashtag_media',
    args: { hashtagId: 'H1', edge: 'recent', limit: 50, after: 'CURSOR' },
    expect: { hashtagId: 'H1', edge: 'recent', limit: 50 },
  },
  {
    name: 'instagram_discover_business',
    args: { username: 'competitor', mediaLimit: 5 },
    expect: { username: 'competitor', mediaLimit: 5 },
  },
];

/** Tools that deliberately declare no `logFields` (their input carries nothing worth logging). */
const NO_LOG_FIELDS = ['instagram_get_online_followers', 'instagram_get_publishing_limit'];

function spec(name: string): ToolSpec {
  const found = allTools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

test('every tool either declares logFields and is pinned here, or is a known opt-out', () => {
  const pinned = new Set(CASES.map((c) => c.name));
  for (const t of allTools) {
    if (t.logFields === undefined) {
      assert.ok(
        NO_LOG_FIELDS.includes(t.name),
        `${t.name} declares no logFields — add it to NO_LOG_FIELDS deliberately`,
      );
    } else {
      assert.ok(pinned.has(t.name), `${t.name} declares logFields but is not pinned by a case`);
    }
  }
  // No stale rows: every pinned name still exists and still declares logFields.
  for (const c of CASES) {
    assert.ok(spec(c.name).logFields, `${c.name} no longer declares logFields`);
  }
});

test('logFields produces exactly the declared payload for every tool', () => {
  for (const c of CASES) {
    const fn = spec(c.name).logFields;
    assert.ok(fn, `${c.name} declares logFields`);
    assert.deepEqual(fn(c.args), c.expect, `${c.name} log payload`);
  }
});

test('logFields never echoes message bodies, captions, or media URLs', () => {
  for (const c of CASES) {
    const fn = spec(c.name).logFields;
    assert.ok(fn);
    const serialized = JSON.stringify(fn(c.args));
    for (const canary of ALL_CANARIES) {
      assert.equal(
        serialized.includes(canary),
        false,
        `${c.name} leaked "${canary}" into its log fields`,
      );
    }
  }
});

test('logFields is a pure read of args — it never mutates them and never calls out', () => {
  for (const c of CASES) {
    const fn = spec(c.name).logFields;
    assert.ok(fn);
    const before = JSON.stringify(c.args);
    fn(c.args);
    assert.equal(JSON.stringify(c.args), before, `${c.name} mutated its args`);
  }
});

test('every write tool records the resolved apply flag so an audit log can tell preview from apply', () => {
  for (const c of CASES) {
    const t = spec(c.name);
    if (t.annotations.readOnlyHint === true) continue;
    const fn = t.logFields;
    assert.ok(fn, `${c.name} declares logFields`);
    assert.equal(typeof fn(c.args).apply, 'boolean', `${c.name} must log a resolved apply boolean`);
    // Omitted `apply` must be logged as false, never as undefined.
    const withoutApply = { ...c.args };
    delete withoutApply.apply;
    assert.equal(fn(withoutApply).apply, false, `${c.name} must default apply to false`);
  }
});

test('post_story logs which of the three sources it was given, never a URL', () => {
  // The table above pins the video row; the other two arms of the discriminator
  // are the ones an audit reader needs to tell "photo story" from "resume", and
  // a collapsed ternary would silently relabel one as the other.
  const fn = spec('instagram_post_story').logFields;
  assert.ok(fn);
  assert.equal(fn({ imageUrl: CANARIES.imageUrl }).source, 'image');
  assert.equal(fn({ videoUrl: CANARIES.videoUrl }).source, 'video');
  // A resume carries neither URL — it must say so rather than guess 'video'.
  const resumed = fn({ resumeContainerId: 'C7', apply: true });
  assert.equal(resumed.source, 'none');
  assert.equal(resumed.resume, true);
});

test('media counters are logged as real counts and as 0 when the field is absent', () => {
  // Both counters are `?.length ?? 0`. The table pins one side of each; an audit
  // reader distinguishing a 3-child carousel from a resume needs the other.
  const container = spec('instagram_create_media_container').logFields;
  const postImage = spec('instagram_post_image').logFields;
  assert.ok(container && postImage);
  assert.equal(container({ children: ['A', 'B', 'C'], mediaType: 'CAROUSEL' }).children, 3);
  assert.equal(container({ imageUrl: CANARIES.imageUrl }).children, 0);
  assert.equal(postImage({ imageUrls: [CANARIES.imageUrl] }).images, 1);
  // A resume carries no imageUrls at all — 0, never undefined.
  assert.equal(postImage({ resumeContainerId: 'C7' }).images, 0);
});

// --- the live path: logFields as the registry actually emits it ------------

/**
 * Everything above pins what each spec *declares*. These tests drive the same
 * specs through `mcp/registry.ts`, which is what actually calls `logFields` and
 * writes the line, so the canary sweep covers the real sink rather than a
 * function nobody invoked (QA finding F6).
 */

interface Emitted {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

function recordingLog(bound: Record<string, unknown> = {}, records: Emitted[] = []): Logger {
  const push =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      records.push({ level, msg, fields: { ...fields, ...bound } });
    };
  return {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: (extra) => recordingLog({ ...bound, ...extra }, records),
  };
}

/** Register the whole real tool surface against a stub server; return the callbacks. */
function registerAll(records: Emitted[]): Map<string, RegisterCb> {
  const cbs = new Map<string, RegisterCb>();
  const server = {
    registerTool(name: string, _config: unknown, cb: RegisterCb) {
      cbs.set(name, cb);
      return {};
    },
  } as unknown as McpServer;

  const igProfile: ResolvedProfile = { name: 'default', authPath: 'ig-login', accessToken: 'tok' };
  const fbProfile: ResolvedProfile = {
    name: 'fb',
    authPath: 'fb-login',
    accessToken: 'tok',
    appId: 'app',
    appSecret: 'secret',
  };
  const brand: ResolvedProfile = { name: 'brand', authPath: 'ig-login', accessToken: 'tok' };

  registerTools({
    server,
    tools: allTools,
    profiles: [igProfile, fbProfile, brand],
    defaultProfileName: 'default',
    settings: testSettings({ logLevel: 'debug', writeJournal: journalPath }),
    clock: fakeClock(1_700_000_000_000),
    log: recordingLog({}, records),
    // No network in this suite: any handler that gets as far as a request fails
    // loudly. The invocation line is emitted before the handler runs, so every
    // case still produces exactly the line under test.
    makeRequest: () => () => Promise.reject(new Error('no network in this test')),
    env: { IG_TOOL_PACKAGES: 'all' },
    confirm: { isSupported: () => false, ask: () => Promise.reject(new Error('unused')) },
  });
  return cbs;
}

test('the registry emits one debug line per invocation carrying the spec logFields payload', async () => {
  const records: Emitted[] = [];
  const cbs = registerAll(records);

  for (const c of CASES) {
    records.length = 0;
    const cb = cbs.get(c.name);
    assert.ok(cb, `${c.name} is registered`);
    await cb(c.args);

    const lines = records.filter((r) => r.msg === 'tool invoked');
    assert.equal(lines.length, 1, `${c.name} must log exactly one invocation line`);
    assert.equal(lines[0]!.level, 'debug', `${c.name} logs at debug`);
    assert.equal(lines[0]!.fields.tool, c.name, `${c.name} line names the tool`);
    // The declared payload rides on the line, unchanged by the wiring.
    for (const [key, value] of Object.entries(c.expect)) {
      assert.deepEqual(lines[0]!.fields[key], value, `${c.name} field '${key}'`);
    }
  }
});

test('no caption, message body, or media URL reaches the log sink through the live path', async () => {
  const records: Emitted[] = [];
  const cbs = registerAll(records);

  for (const c of CASES) {
    records.length = 0;
    await cbs.get(c.name)!(c.args);
    // Sweep EVERYTHING the sink saw for this call, not just the invocation line.
    const serialized = JSON.stringify(records);
    for (const canary of ALL_CANARIES) {
      assert.equal(serialized.includes(canary), false, `${c.name} leaked "${canary}" to the log`);
    }
  }
});

test('a registered secret planted in a logged argument is masked on the way to the sink', async () => {
  // The configured-value canary F6 asks for: a real secret value in an argument
  // that the spec DOES log must come out masked, not because the tool authors
  // were careful but because the sink path redacts.
  const secret = 'LIVE-PATH-F6-SECRET-VALUE-9876543210';
  registerSecret(secret);
  const records: Emitted[] = [];
  const cbs = registerAll(records);

  await cbs.get('instagram_get_media')!({ mediaId: secret });
  const line = records.find((r) => r.msg === 'tool invoked');
  assert.ok(line, 'the invocation was logged');
  assert.equal(
    JSON.stringify(line.fields).includes(secret),
    false,
    'the secret never reaches the sink',
  );
  assert.equal(line.fields.mediaId, REDACTED);
});
