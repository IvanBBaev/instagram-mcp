/**
 * Contract test for `IG_PRETTY_JSON` (`Settings.prettyJson`) across every tool.
 *
 * `mcp/result.ts` renders a tool body as `JSON.stringify(data, null, pretty ? 2
 * : 0)`, and `pretty` is an argument of each individual `json()` call: nothing
 * in the type system, the registry or the lint rules makes a call site pass it.
 * Before CC-DATA-30 was closed that was measurable — three of the twenty-eight
 * tools honoured the setting and twenty-five emitted compact JSON whatever the
 * operator set, while `README.md`, `docs/architecture.md` and `docs/index.html`
 * promised "Pretty-print JSON results" without qualification.
 *
 * The owner decision (docs/corner-cases.md §10, CC-DATA-30) was to thread the
 * flag through, so **this file pins that every registered tool honours it** —
 * in both directions, in every arm a handler can return from, including the
 * write gate's own preview, destructive-block and refusal results, which are
 * rendered by `mcp/write-mode.ts` rather than by the tool. It enumerates
 * `allTools` rather than naming tools, so a tool added tomorrow is measured the
 * moment it is registered and fails here if its `json()` call forgets the flag.
 *
 * Why the flag is threaded per call site rather than applied centrally: the two
 * central seams are both pinned as identity on purpose — `defineTool` returns
 * the very spec it was given (`test/mcp/define.test.ts`, Gate G1) and `allTools`
 * holds the very objects each package exported (`test/tools/index.test.ts`) —
 * and a re-render after the fact would have to re-parse the text block. This
 * file is the guard that makes the per-call-site form safe.
 *
 * Offline by construction: `ctx.req` is a stub and `globalThis.fetch` is
 * poisoned, so a handler that reached the network would die here rather than
 * send the operator's live credential to Meta from a test run. Restored in
 * `after()` so nothing leaks into another test file.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IgRequestFn, Logger, ResolvedProfile } from '../../src/core/types.js';
import type { ToolResult, ToolSpec } from '../../src/mcp/define.js';
import type { WriteConfirmer, WriteGateContext } from '../../src/mcp/write-mode.js';
import { allTools } from '../../src/tools/index.js';
import { fakeClock } from '../helpers/fake-clock.js';
import { testSettings } from '../helpers/settings.js';

const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('the prettyJson contract test must never touch the network');
};
after(() => {
  globalThis.fetch = realFetch;
});

/**
 * The applied pass below drives every write tool with `apply: true`, and an
 * applied write appends to `settings.writeJournal`. Point it at a temp file so
 * the suite never touches the operator's real audit log at
 * ~/.local/state/instagram-mcp-ai/writes.jsonl.
 */
const journalDir = mkdtempSync(join(tmpdir(), 'ig-pretty-json-journal-'));
const journalPath = join(journalDir, 'writes.jsonl');
after(() => rmSync(journalDir, { recursive: true, force: true }));

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

const profile: ResolvedProfile = {
  name: 'default',
  authPath: 'fb-login',
  accessToken: 'token-abc',
  accountId: '17841400000000000',
  appId: 'app',
  appSecret: 'secret',
};

/**
 * One upstream payload for every tool.
 *
 * Deliberately over-wide: it carries every field the twenty-eight handlers
 * reach for, so each one reaches its `json(...)` call rather than throwing
 * short of the line under test. What the body *says* is irrelevant here — only
 * how it is rendered is.
 */
const RESPONSE = {
  id: 'X1',
  username: 'u',
  caption: 'c',
  // `quota_usage` lives on the `data[0]` row, where the quota read looks for it
  // and refuses the call when it is missing.
  data: [{ id: '1', quota_usage: 1 }],
  status_code: 'FINISHED',
  quota_usage: 1,
  // `instagram_discover_business` reads its whole result out of this nested
  // edge. Without it the tool returns `{}`, which renders identically at both
  // indents and would have counted as "compact" on a body that proves nothing.
  business_discovery: {
    id: 'B1',
    username: 'biz',
    followers_count: 2,
    media: { data: [{ id: 'm1' }] },
  },
};

const req = (() => Promise.resolve(RESPONSE)) as unknown as IgRequestFn;

/**
 * Every arm a handler can return from.
 *
 * A write handler branches before it renders: the write gate answers a preview,
 * a destructive-write block or a refusal at the confirmation prompt itself (in
 * `mcp/write-mode.ts`), and only the applied arm reaches the tool's own
 * `json(...)` call sites — which differ from the preview's. Driving one arm
 * would leave the others unmeasured: before the applied pass existed, a mutant
 * that changed `publishing.ts` inside the applied arm survived this file. Read
 * tools ignore all of this and simply run once per mode.
 */
const declining: WriteConfirmer = {
  isSupported: () => true,
  ask: () => Promise.resolve({ action: 'decline' }),
};
const probeFails: WriteConfirmer = {
  isSupported: () => {
    throw new Error('probe failed');
  },
  ask: () => Promise.resolve({ action: 'decline' }),
};

const MODES = [
  { label: 'preview', writeMode: 'preview' as const, apply: false, allowDestructive: true },
  { label: 'applied', writeMode: 'apply' as const, apply: true, allowDestructive: true },
  { label: 'blocked', writeMode: 'apply' as const, apply: true, allowDestructive: false },
  {
    label: 'declined',
    writeMode: 'apply' as const,
    apply: true,
    allowDestructive: true,
    confirm: declining,
  },
  {
    label: 'unavailable',
    writeMode: 'apply' as const,
    apply: true,
    allowDestructive: true,
    confirm: probeFails,
  },
];

/** Arguments wide enough to drive any handler; `apply` is set per mode. */
const BASE_ARGS: Record<string, unknown> = {
  mediaId: 'M1',
  commentId: 'C1',
  userId: 'U1',
  q: 'x',
  containerId: 'K1',
  creationId: 'K1',
  imageUrls: ['https://cdn.example.com/a.jpg'],
  imageUrl: 'https://cdn.example.com/a.jpg',
  videoUrl: 'https://cdn.example.com/v.mp4',
  message: 'hi',
  caption: 'c',
  enabled: true,
  apply: false,
  hashtagId: 'H1',
  hashtag: 'x',
  username: 'u',
  metric: ['impressions'],
  period: 'day',
  since: '2026-01-01',
  until: '2026-01-02',
};

type Mode = (typeof MODES)[number];

function argsFor(name: string, mode: Mode): Record<string, unknown> {
  const args: Record<string, unknown> = { ...BASE_ARGS, apply: mode.apply };
  // `instagram_post_story` refuses a call carrying more than one media source,
  // so the shared bag has to lose one of them for this tool alone.
  if (name === 'instagram_post_story') delete args.videoUrl;
  return args;
}

function ctxWith(prettyJson: boolean, mode: Mode): WriteGateContext {
  return {
    req,
    settings: testSettings({
      prettyJson,
      writeMode: mode.writeMode,
      allowDestructive: mode.allowDestructive,
      writeJournal: journalPath,
    }),
    profile,
    clock: fakeClock(1_700_000_000_000),
    log: noopLog,
    ...('confirm' in mode ? { confirm: mode.confirm } : {}),
  };
}

async function textOf(spec: ToolSpec, prettyJson: boolean, mode: Mode): Promise<string> {
  const res: ToolResult = await spec.handler(argsFor(spec.name, mode), ctxWith(prettyJson, mode));
  const block = res.content[0];
  assert.ok(block && block.type === 'text', `${spec.name} (${mode.label}) returns a text block`);
  return block.text;
}

/**
 * Classify one rendered body against the two renderings of its own payload.
 *
 * Stronger than looking for a newline: a body is called compact only when it is
 * byte-for-byte `JSON.stringify(parsed)` and pretty only when it is byte-for-
 * byte `JSON.stringify(parsed, null, 2)`. A third shape — an indent of 4, a
 * trailing newline, a hand-assembled body — is neither, and says so.
 */
function rendering(name: string, text: string): 'pretty' | 'compact' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    assert.fail(`${name} does not return a JSON body: ${text.slice(0, 80)}`);
  }
  const compact = JSON.stringify(parsed);
  const pretty = JSON.stringify(parsed, null, 2);
  assert.notEqual(
    compact,
    pretty,
    `${name}: the probe payload renders identically either way, so it measures nothing — widen RESPONSE`,
  );
  if (text === pretty) return 'pretty';
  if (text === compact) return 'compact';
  return assert.fail(`${name} renders neither compactly nor at indent 2: ${text.slice(0, 80)}`);
}

test('every tool can be driven to a JSON body whose two renderings differ', async () => {
  // The measurement instrument before the measurement: if a handler throws
  // short of its `json(...)` call, or returns a payload that pretty-prints to
  // itself, it would silently count as "compact" and the split below would be
  // an artifact of the probe rather than a fact about the code.
  for (const mode of MODES) {
    for (const spec of allTools) {
      rendering(`${spec.name} (${mode.label})`, await textOf(spec, true, mode));
    }
  }
});

test('IG_PRETTY_JSON reaches every registered tool, in every arm', async () => {
  // Enumerates `allTools`, never a hand-written list: a tool registered later is
  // measured here the moment it exists, so a `json(...)` call that forgets the
  // flag fails this test instead of quietly shipping compact output.
  const ignoring: string[] = [];
  for (const mode of MODES) {
    for (const spec of allTools) {
      const label = `${spec.name} (${mode.label})`;
      if (rendering(label, await textOf(spec, true, mode)) !== 'pretty') ignoring.push(label);
    }
  }
  assert.deepEqual(ignoring, [], 'these tool arms ignore IG_PRETTY_JSON=true');
});

test('nothing pretty-prints when IG_PRETTY_JSON is off, in any arm', async () => {
  // Half a contract is the dangerous half: a call site hard-coded to
  // `pretty: true` would pass the test above while ignoring the operator exactly
  // as badly as one hard-coded the other way.
  for (const mode of MODES) {
    for (const spec of allTools) {
      const label = `${spec.name} (${mode.label})`;
      assert.equal(
        rendering(label, await textOf(spec, false, mode)),
        'compact',
        `${label} pretty-prints with IG_PRETTY_JSON off`,
      );
    }
  }
});

test('the probe reaches every write-gate outcome it claims to', async () => {
  // The instrument again: if a mode stopped reaching the arm it is named for
  // (a confirmer the gate never consults, a block that never fires), the two
  // tests above would measure the same arm five times and call it coverage.
  const deleteTool = allTools.find((t) => t.name === 'instagram_delete_comment');
  assert.ok(deleteTool, 'instagram_delete_comment is still a registered tool');
  const seen: Record<string, unknown> = {};
  for (const mode of MODES) {
    const parsed = JSON.parse(await textOf(deleteTool, false, mode)) as Record<string, unknown>;
    seen[mode.label] = parsed.mode ?? parsed.reason ?? 'applied';
  }
  assert.deepEqual(seen, {
    preview: 'preview',
    applied: 'applied',
    blocked: 'preview',
    declined: 'refused',
    unavailable: 'refused',
  });
});

test('the composite post tools honour IG_PRETTY_JSON in their resume and timeout arms too', async () => {
  // `executePublish` in `tools/publishing.ts` has three applied outcomes, each
  // with its own `json(...)` call, and the shared probe payload above reaches
  // only `published` (its container reads FINISHED). `already_published` needs a
  // resumed container Graph reports as PUBLISHED, and `in_progress` needs a
  // container still processing when the poll budget runs out — so both are
  // driven here, for every tool that accepts `resumeContainerId`.
  const composite = allTools.filter((t) => 'resumeContainerId' in (t.input as object));
  assert.ok(composite.length >= 3, 'the composite post tools are still registered');
  const arms = [
    { expect: 'already_published', status: 'PUBLISHED', resume: true },
    { expect: 'in_progress', status: 'IN_PROGRESS', resume: false },
  ];
  // Time moves only when the flow sleeps, so the poll budget runs out without
  // the test waiting on a real timer.
  let nowMs = 1_700_000_000_000;
  const autoClock = {
    now: () => nowMs,
    sleep: (ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    },
  };
  const mode = MODES[1] as Mode;
  for (const spec of composite) {
    for (const arm of arms) {
      for (const prettyJson of [true, false]) {
        const armReq = (() =>
          Promise.resolve({ ...RESPONSE, status_code: arm.status })) as unknown as IgRequestFn;
        const args = argsFor(spec.name, mode);
        if (arm.resume) args.resumeContainerId = 'K9';
        const res = await spec.handler(args, {
          ...ctxWith(prettyJson, mode),
          req: armReq,
          clock: autoClock,
        });
        const block = res.content[0];
        assert.ok(block && block.type === 'text', `${spec.name} (${arm.expect}) returns text`);
        const label = `${spec.name} (${arm.expect}, prettyJson=${String(prettyJson)})`;
        assert.equal(
          (JSON.parse(block.text) as Record<string, unknown>).status,
          arm.expect,
          `${label} reaches the arm it is named for`,
        );
        assert.equal(rendering(label, block.text), prettyJson ? 'pretty' : 'compact', label);
      }
    }
  }
});
