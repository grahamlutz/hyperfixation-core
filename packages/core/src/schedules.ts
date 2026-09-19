import { appPaused } from "@hyperfixation/db";
import type { Flow, StartedRun } from "@hyperfixation/workflows";
import type { Pool } from "pg";
import { InvalidDefinition } from "./registry.js";

export interface ScheduleDefinition<I = unknown> {
  readonly name: string;
  readonly flow: Flow<I, unknown>;
  /** An interval in milliseconds, not a cron expression. */
  readonly every: number;
  /** The flow's input, built per firing; a flow taking `undefined` needs none. */
  input?(): I;
}

/**
 * A schedule of any shape, as `AnyFlow` is a flow of any shape: the registry holds these, so
 * what it holds says nothing about any one flow's input type.
 */
export interface AnySchedule {
  readonly name: string;
  readonly flow: Flow<never, unknown>;
  readonly every: number;
  input?(): unknown;
}

export type ScheduleFired =
  | { started: false; reason: "paused" }
  | { started: true; run: StartedRun };

export function defineSchedule<I>(definition: ScheduleDefinition<I>): ScheduleDefinition<I> {
  if (!(definition.every > 0)) {
    throw new InvalidDefinition(
      "schedule",
      definition.name,
      `fires every ${definition.every}ms, which is not a positive interval`,
    );
  }
  return definition;
}

/**
 * One firing: a schedule starts a run and never sleeps durably, which is why this is a plain
 * call a timer outside DBOS makes — `runs.start` is a control-plane operation that
 * `assertNotInWorkflow()` refuses from inside a run, the same reason `startReconciler` is a
 * `setInterval`.
 *
 * A paused app starts nothing. The flag is read before the run row is written rather than left
 * to the step gate, so a pause does not accumulate runs that suspend at their first step.
 */
export async function fireSchedule(
  pool: Pool,
  schedule: AnySchedule,
  start: (flow: Flow<unknown, unknown>, input: unknown) => Promise<StartedRun>,
): Promise<ScheduleFired> {
  if (await appPaused(pool)) return { started: false, reason: "paused" };
  const run = await start(schedule.flow as Flow<unknown, unknown>, schedule.input?.());
  return { started: true, run };
}

/** The names due at `now`: never fired, or last fired at least `every` ms ago. */
export function schedulesDue(
  schedules: readonly AnySchedule[],
  now: Date,
  lastFired: ReadonlyMap<string, Date>,
): string[] {
  return schedules
    .filter((schedule) => {
      const last = lastFired.get(schedule.name);
      return last === undefined || now.getTime() - last.getTime() >= schedule.every;
    })
    .map((schedule) => schedule.name);
}
