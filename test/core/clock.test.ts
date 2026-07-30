/**
 * Unit tests for the real (system) clock — `src/core/clock.ts`.
 *
 * Everything else in the repo runs on `test/helpers/fake-clock.ts`, so the ONE
 * place the production timer behaviour is exercised is here. What matters is not
 * that `sleep` resolves, but that it is abortable and that aborting actually
 * *cancels the timer*: `core/http.ts` awaits `clock.sleep(backoffMs, signal)`
 * between retries, so a leaked timer keeps a cancelled request's backoff pinned
 * in the event loop long after the caller gave up.
 *
 * A rejected promise alone does NOT prove the timer went away — it stays armed
 * and simply resolves into nothing — so the mid-flight abort test counts the
 * process's live timer handles instead of taking the rejection as evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { systemClock } from '../../src/core/clock.js';

/** Long enough that a leaked timer would be a real leak; never waited out. */
const NEVER_MS = 60_000;

/** Live `setTimeout` handles in this process — the only direct evidence of a leak. */
function armedTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

test('systemClock.now returns the wall clock in epoch milliseconds', () => {
  const before = Date.now();
  const observed = systemClock.now();
  const after = Date.now();

  assert.ok(Number.isInteger(observed), `expected epoch ms, got ${observed}`);
  assert.ok(
    observed >= before && observed <= after,
    `now() (${observed}) must fall inside [${before}, ${after}]`,
  );
});

test('systemClock.sleep resolves only after the requested delay has elapsed', async () => {
  const delay = 30;
  const started = Date.now();
  await systemClock.sleep(delay);
  const elapsed = Date.now() - started;

  // Node's timer may fire a hair early on some platforms; a 5 ms tolerance keeps
  // the test honest about "waited roughly this long" without being flaky.
  assert.ok(elapsed >= delay - 5, `sleep(${delay}) returned after only ${elapsed} ms`);
});

test('systemClock.sleep(0) resolves without waiting for a signal', async () => {
  await systemClock.sleep(0);
});

test('systemClock.sleep rejects immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  const reason = new Error('caller gave up before sleeping');
  controller.abort(reason);

  await assert.rejects(
    () => systemClock.sleep(NEVER_MS, controller.signal),
    (err: unknown) => {
      // The caller's own reason is propagated untouched, so `toInstagramError`
      // upstream can classify it (timeout vs. explicit abort).
      assert.equal(err, reason);
      return true;
    },
  );
});

test('systemClock.sleep clears its pending timer when the signal aborts mid-flight', async () => {
  // This is the case `core/http.ts` depends on: when a request is cancelled, the
  // backoff it was waiting on must release the event loop immediately. Dropping
  // `clearTimeout` still rejects the promise, so only the handle count catches it.
  const controller = new AbortController();
  const reason = new Error('aborted while sleeping');
  const before = armedTimers();

  const pending = systemClock.sleep(NEVER_MS, controller.signal);
  assert.equal(armedTimers(), before + 1, 'sleep must arm exactly one timer');

  controller.abort(reason);
  await assert.rejects(pending, (err: unknown) => err === reason);
  assert.equal(armedTimers(), before, 'the pending timer must be cleared, not left to fire');
});

test('systemClock.sleep wraps a non-Error abort reason in an Error, keeping it as the cause', async () => {
  // `AbortController.abort()` with no argument produces a DOMException, and a
  // caller may abort with any value at all. Callers (`core/http.ts`) treat the
  // rejection as an Error, so a bare string must never be thrown as-is.
  const controller = new AbortController();
  const pending = systemClock.sleep(NEVER_MS, controller.signal);
  controller.abort('shutting down');

  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof Error, `expected an Error, got ${typeof err}`);
    assert.equal(err.message, 'Aborted');
    assert.equal(err.cause, 'shutting down');
    return true;
  });
});

test('systemClock.sleep propagates the default DOMException reason unchanged', async () => {
  // `abort()` with no reason yields a DOMException, which IS an Error — it must
  // be passed through rather than re-wrapped, so the AbortError name survives.
  const controller = new AbortController();
  const pending = systemClock.sleep(NEVER_MS, controller.signal);
  controller.abort();

  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'AbortError');
    return true;
  });
});
