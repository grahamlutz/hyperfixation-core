import { ControlPlaneInWorkflow, UnfencedWrite } from "@hyperfixation/db";

/**
 * A production refusal, flattened to something that survives a line of a child process's
 * stdout. `detail` is the refused statement for `UnfencedWrite` and the operation name for
 * `ControlPlaneInWorkflow` — the field that says *what* was refused in each case.
 */
export interface FencingFailure {
  name: "UnfencedWrite" | "ControlPlaneInWorkflow";
  detail: string;
  message: string;
}

/**
 * The one rule this package enforces: a fencing refusal raised anywhere during a test fails
 * it. Nothing here detects an unfenced write — the step pool and the control-plane helpers
 * refuse in production — so the chain is walked for the real classes rather than matched on
 * a message. Drizzle rethrows a driver error as `DrizzleQueryError`, so a refusal that came
 * back through a Drizzle handle is somewhere down `cause`.
 */
export function fencingFailureOf(error: unknown): FencingFailure | undefined {
  let current = error;
  while (current instanceof Error) {
    if (current instanceof UnfencedWrite) {
      return { name: "UnfencedWrite", detail: current.statement, message: current.message };
    }
    if (current instanceof ControlPlaneInWorkflow) {
      return {
        name: "ControlPlaneInWorkflow",
        detail: current.operation,
        message: current.message,
      };
    }
    current = current.cause;
  }
  return undefined;
}

export class FencingFailureInTest extends Error {
  readonly failures: readonly FencingFailure[];

  constructor(where: string, failures: readonly FencingFailure[]) {
    super(
      `FencingFailureInTest: ${where} raised ${failures.length} fencing refusal` +
        `${failures.length === 1 ? "" : "s"}:\n` +
        failures.map((failure) => `  ${failure.message}`).join("\n"),
    );
    this.name = "FencingFailureInTest";
    this.failures = failures;
  }
}
