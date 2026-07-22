/**
 * Deterministic {@link Clock} for tests. Time only moves via `advance`/`set`;
 * pending `sleep`s resolve when their deadline is reached. FROZEN test seam.
 */
import type { Clock } from '../../src/core/clock.js';

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(epochMs: number): void;
}

export function fakeClock(startMs = 0): FakeClock {
  let current = startMs;
  let pending: Array<{ at: number; resolve: () => void }> = [];

  const flush = (): void => {
    const ready = pending.filter((p) => p.at <= current);
    pending = pending.filter((p) => p.at > current);
    for (const p of ready) p.resolve();
  };

  return {
    now: () => current,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        pending.push({ at: current + ms, resolve });
        if (ms <= 0) flush();
      }),
    advance(ms: number) {
      current += ms;
      flush();
    },
    set(epochMs: number) {
      current = epochMs;
      flush();
    },
  };
}
