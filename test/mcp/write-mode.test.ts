/**
 * Unit tests for the write gate (src/mcp/write-mode.ts). Pure gate logic is
 * exercised directly; the journal side-effect is verified against a temp file
 * (set via IG_WRITE_JOURNAL) and its best-effort I/O tolerance is checked by
 * pointing the journal at an unwritable path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withWriteGate, type WriteIntent } from '../../src/mcp/write-mode.js';
import type { ToolContext, ToolResult } from '../../src/mcp/define.js';
import { json } from '../../src/mcp/result.js';
import type { Logger, ResolvedProfile, Settings } from '../../src/core/types.js';
import { fakeClock } from '../helpers/fake-clock.js';

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

const baseSettings: Settings = {
  maxConcurrent: 4,
  maxItems: 200,
  refreshAfterDays: 45,
  timeoutMs: 30_000,
  logLevel: 'info',
  prettyJson: false,
  writeMode: 'preview',
  allowDestructive: false,
  transport: 'stdio',
  httpHost: '127.0.0.1',
  httpPort: 3000,
};

const profile: ResolvedProfile = { name: 'default', authPath: 'ig-login', accessToken: 'tok' };

function ctxWith(over: { settings?: Partial<Settings> } = {}): ToolContext {
  return {
    req: async () => ({}) as never,
    settings: { ...baseSettings, ...over.settings },
    profile,
    clock: fakeClock(1_700_000_000_000),
    log: noopLog,
  };
}

const intent: WriteIntent = {
  action: 'publish_media',
  summary: 'Publish container 42',
  details: { id: '42' },
};

function performOk(id = 'new-id'): () => Promise<{ result: ToolResult; targetId?: string }> {
  return async () => ({ result: json({ published: id }), targetId: id });
}

test('preview: no apply flag and preview mode returns a non-error preview, never runs perform', async () => {
  let ran = false;
  const res = await withWriteGate(intent, {}, ctxWith(), async () => {
    ran = true;
    return { result: json({ published: 'x' }) };
  });
  assert.equal(ran, false, 'perform must not run in preview');
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent?.mode, 'preview');
  assert.equal(res.structuredContent?.action, 'publish_media');
});

test('apply via args.apply=true runs perform and returns its result', async () => {
  const res = await withWriteGate(intent, { apply: true }, ctxWith(), performOk('pub-1'));
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent?.published, 'pub-1');
});

test('apply via settings.writeMode=apply runs perform', async () => {
  let ran = false;
  await withWriteGate(intent, {}, ctxWith({ settings: { writeMode: 'apply' } }), async () => {
    ran = true;
    return { result: json({ published: 'y' }) };
  });
  assert.equal(ran, true);
});

test('explicit apply:false forces preview even under a global apply default', async () => {
  let ran = false;
  const res = await withWriteGate(
    intent,
    { apply: false },
    ctxWith({ settings: { writeMode: 'apply' } }),
    async () => {
      ran = true;
      return { result: json({ published: 'z' }) };
    },
  );
  assert.equal(ran, false);
  assert.equal(res.structuredContent?.mode, 'preview');
});

test('destructive intent is blocked without allowDestructive even with apply:true', async () => {
  const del: WriteIntent = {
    action: 'delete_comment',
    summary: 'Delete comment 9',
    destructive: true,
  };
  let ran = false;
  const res = await withWriteGate(del, { apply: true }, ctxWith(), async () => {
    ran = true;
    return { result: json({ ok: true }) };
  });
  assert.equal(ran, false);
  assert.equal(res.structuredContent?.mode, 'preview');
  assert.ok(String(res.content[0]?.text).includes('IG_ALLOW_DESTRUCTIVE'));
});

test('destructive intent proceeds with apply:true + allowDestructive', async () => {
  const del: WriteIntent = {
    action: 'delete_comment',
    summary: 'Delete comment 9',
    destructive: true,
  };
  const res = await withWriteGate(
    del,
    { apply: true },
    ctxWith({ settings: { allowDestructive: true } }),
    performOk('deleted'),
  );
  assert.equal(res.structuredContent?.published, 'deleted');
});

test('an applied write appends a journal line; a preview does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-journal-'));
  const path = join(dir, 'writes.jsonl');
  const prev = process.env.IG_WRITE_JOURNAL;
  process.env.IG_WRITE_JOURNAL = path;
  try {
    // preview: no file
    await withWriteGate(intent, {}, ctxWith(), performOk());
    assert.equal(existsSync(path), false, 'preview must not journal');

    // apply: one line
    await withWriteGate(intent, { apply: true }, ctxWith(), performOk('pub-42'));
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(rec.action, 'publish_media');
    assert.equal(rec.targetId, 'pub-42');
    assert.equal(rec.account, 'default');
  } finally {
    if (prev === undefined) delete process.env.IG_WRITE_JOURNAL;
    else process.env.IG_WRITE_JOURNAL = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed perform result is not journaled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-journal-'));
  const path = join(dir, 'writes.jsonl');
  const prev = process.env.IG_WRITE_JOURNAL;
  process.env.IG_WRITE_JOURNAL = path;
  try {
    await withWriteGate(intent, { apply: true }, ctxWith(), async () => ({
      result: { isError: true, content: [{ type: 'text', text: 'boom' }] },
    }));
    assert.equal(existsSync(path), false, 'error results are not journaled');
  } finally {
    if (prev === undefined) delete process.env.IG_WRITE_JOURNAL;
    else process.env.IG_WRITE_JOURNAL = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable journal path does not fail the applied write (best-effort)', async () => {
  const prev = process.env.IG_WRITE_JOURNAL;
  // A path whose parent is a file, so mkdir/append cannot succeed.
  const dir = mkdtempSync(join(tmpdir(), 'ig-journal-'));
  const filePath = join(dir, 'not-a-dir');
  writeFileSync(filePath, 'x');
  process.env.IG_WRITE_JOURNAL = join(filePath, 'writes.jsonl');
  try {
    const res = await withWriteGate(intent, { apply: true }, ctxWith(), performOk('still-ok'));
    assert.equal(
      res.structuredContent?.published,
      'still-ok',
      'write result survives a broken journal',
    );
  } finally {
    if (prev === undefined) delete process.env.IG_WRITE_JOURNAL;
    else process.env.IG_WRITE_JOURNAL = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
