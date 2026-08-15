/**
 * A `Settings` builder for tests.
 *
 * Every test that constructs a `ToolContext` needs a full {@link Settings}, and
 * hand-rolling the literal in each file made the object drift: adding one field
 * to the Gate-G1 contract broke ten test files at once, and each of them had its
 * own idea of the defaults. {@link testSettings} builds from the real
 * `DEFAULT_SETTINGS`, so a new knob costs nothing here and tests exercise the
 * shipped defaults rather than a copy that slowly diverges from them.
 *
 * **Journal isolation is the point of the `writeJournal` override.** The applied
 * -write journal defaults to `~/.local/state/instagram-mcp-ai/writes.jsonl` —
 * the operator's REAL audit trail. A test that applies a write and forgets to
 * redirect it appends to that file, which is exactly what happened before this
 * helper existed (a live journal had accumulated hundreds of lines of test
 * records). Defaulting to a per-process temp path makes the isolation
 * structural: forgetting is no longer possible, because there is nothing to
 * remember.
 */
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_SETTINGS } from '../../src/core/settings.js';
import type { Settings } from '../../src/core/types.js';

/**
 * A throwaway journal path, unique per test process.
 *
 * Not created on disk — the write gate creates the directory on first append,
 * so a test that never applies a write leaves nothing behind. The pid keeps
 * concurrent test processes from sharing one file and reading each other's
 * records.
 */
export function tempJournalPath(): string {
  return path.join(tmpdir(), `instagram-mcp-test-${process.pid}`, 'writes.jsonl');
}

/**
 * Full {@link Settings} for a test context: the shipped defaults, a journal
 * pointed at a temp path, and whatever `overrides` the test cares about.
 *
 * A test that asserts on journal *contents* passes its own
 * `writeJournal` override; `process.env.IG_WRITE_JOURNAL` is deliberately not
 * consulted here, because the write gate no longer reads it either — the path
 * travels on `Settings` like every other knob.
 */
export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, writeJournal: tempJournalPath(), ...overrides };
}
