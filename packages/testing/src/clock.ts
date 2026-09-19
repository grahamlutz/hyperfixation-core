/**
 * A clock a test owns, for the one production seam that takes one: `createLlm({ clock })`.
 * Nothing in production constructs one, and no database time is overridden — the money gate
 * still writes `finished_at = now()` and every other `now()` in the system stays real.
 */

/**
 * A live `() => Date`, never a captured instant: the gate calls it at the moment it stamps a
 * row, so `set()` between two calls is what a month boundary mid-run looks like.
 */
export type TestClock = (() => Date) & {
  /** Re-pins the clock; the next read sees it. */
  set(at: string | Date): void;
};

export function withClock(at: string | Date): TestClock {
  let pinned = parseClock(at);
  const clock = ((): Date => new Date(pinned)) as TestClock;
  clock.set = (to: string | Date): void => {
    pinned = parseClock(to);
  };
  return clock;
}

export function parseClock(at: string | Date): number {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  if (Number.isNaN(ms)) throw new Error(`not a parseable timestamp: ${String(at)}`);
  return ms;
}
