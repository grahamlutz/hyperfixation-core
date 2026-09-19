import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { RecordTable } from "@hyperfixation/db";
import {
  reconcile,
  runsStart,
  decide as decideApprovals,
  type ActionChannel,
  type ApprovalDraftSchema,
  type DecideOptions,
  type DecideResult,
  type Flow,
  type ReconcileOptions,
  type ReconcileReport,
  type RunsStartOptions,
  type StartedRun,
  type StepContext,
} from "@hyperfixation/workflows";
import type { Pool } from "pg";
import {
  listActivity,
  recordActivity,
  type ActivityListOptions,
  type ActivityRecordOptions,
  type ActivityRecorded,
  type ActivityRow,
} from "./activity.js";
import {
  addLabel,
  listLabels,
  type LabelAddOptions,
  type LabelListOptions,
  type LabelRow,
} from "./labels.js";
import {
  listOutcomes,
  recordOutcome,
  type OutcomeListOptions,
  type OutcomeRecordOptions,
  type OutcomeRow,
} from "./outcomes.js";
import type { PageDefinition } from "./pages.js";
import { pauseApp, resumeApp, type PauseOptions, type PauseResult, type ResumeResult } from "./pause.js";
import { archiveRecord, type ArchiveOptions, type ArchiveResult } from "./records.js";
import { createRegistry, UnknownRegistration, type Registry } from "./registry.js";
import type { ResolverDefinition } from "./resolvers.js";
import {
  fireSchedule,
  schedulesDue,
  type AnySchedule,
  type ScheduleFired,
} from "./schedules.js";
import type { ScorerDefinition } from "./scorers.js";
import { writeStepScore, type ScoreWritten, type StepWriteScoreOptions } from "./scores.js";
import type { SourceDefinition } from "./sources.js";
import type { SpecDefinition } from "./specs.js";
import { createStatusHandler, STATUS_TOKEN_ACTOR } from "./status-route.js";
import { appStatus, type StatusReport } from "./status.js";
import {
  cancelTask,
  completeTask,
  createManualTask,
  createTask,
  listTasks,
  type TaskCloseOptions,
  type TaskClosed,
  type TaskCreateManualOptions,
  type TaskCreateOptions,
  type TaskCreated,
  type TaskListOptions,
  type TaskRow,
} from "./tasks.js";

/**
 * A flow of any shape. `Flow<never, unknown>` is the bottom of the family: its input is
 * contravariant, so every `Flow<I, O>` is one of these.
 */
export type AnyFlow = Flow<never, unknown>;

export interface ApprovalTypeDefinition {
  readonly name: string;
  /** The Zod schema an edited draft is parsed against; a type without one refuses every edit. */
  readonly schema?: ApprovalDraftSchema;
}

/**
 * The pool and client every control-plane operation runs on. In the worker this is the control
 * pool `startWorker()` built and the worker's own `DBOSClient`; in the web it is the web's
 * ordinary pool and `getClient()`. Neither is fenced, and neither has to be: a control-plane
 * operation's fence is a predicate, and `assertNotInWorkflow()` is what keeps it out of a run.
 */
export interface ControlPlane {
  pool: Pool;
  client: DBOSClient;
}

export class AppNotAttached extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(
      `AppNotAttached: ${operation} needs the app's control plane; call app.attach({ pool, client }) ` +
        "with startWorker()'s control pool in the worker, or the web's pool and getClient() in the web",
    );
    this.name = "AppNotAttached";
    this.operation = operation;
  }
}

export class NoApplicationVersion extends Error {
  constructor(operation: string) {
    super(
      `NoApplicationVersion: ${operation} needs the version this deploy runs; defineApp() reads ` +
        "HF_BUILD_SHA, which is unset here",
    );
    this.name = "NoApplicationVersion";
  }
}

export interface DefineAppOptions {
  name: string;
  /** Defaults to `HF_BUILD_SHA`, the one source of a version in every process. */
  applicationVersion?: string;
  flows?: readonly AnyFlow[];
  sources?: readonly SourceDefinition[];
  resolvers?: readonly ResolverDefinition[];
  scorers?: readonly ScorerDefinition[];
  specs?: readonly SpecDefinition[];
  approvalTypes?: readonly ApprovalTypeDefinition[];
  channels?: readonly ActionChannel[];
  records?: readonly RecordTable[];
  pages?: readonly PageDefinition[];
  schedules?: readonly AnySchedule[];
}

export interface AppRecords {
  /** Registered record types, keyed by the `record_type` machinery rows carry. */
  readonly types: Registry<RecordTable>;
  archive(options: ArchiveOptions): Promise<ArchiveResult>;
}

/**
 * The write helpers split by where they run, not by what they write: `record` takes the step's
 * context and writes inside `ctx.tx`, `list` is a control-plane read. There is no one entry point
 * that sniffs the handle — a flow and the web reach different functions on purpose.
 */
export interface AppActivity {
  record(ctx: StepContext, options: ActivityRecordOptions): Promise<ActivityRecorded>;
  list(options: ActivityListOptions): Promise<ActivityRow[]>;
}

export interface AppTasks {
  /** A flow's follow-up, keyed by the step so a replay finds its own task. */
  create(ctx: StepContext, options: TaskCreateOptions): Promise<TaskCreated>;
  createManual(options: TaskCreateManualOptions): Promise<TaskCreated>;
  complete(options: TaskCloseOptions): Promise<TaskClosed>;
  cancel(options: TaskCloseOptions): Promise<TaskClosed>;
  list(options?: TaskListOptions): Promise<TaskRow[]>;
}

export interface AppLabels {
  add(options: LabelAddOptions): Promise<{ id: number }>;
  list(options: LabelListOptions): Promise<LabelRow[]>;
}

export interface AppOutcomes {
  record(options: OutcomeRecordOptions): Promise<{ id: number }>;
  list(options: OutcomeListOptions): Promise<OutcomeRow[]>;
}

export interface AppScores {
  /** The `hf_score` row, the record's mixin columns and the timeline entry, in one transaction. */
  write(ctx: StepContext, options: StepWriteScoreOptions): Promise<ScoreWritten>;
}

export interface AppSchedules extends Registry<AnySchedule> {
  /** Starts the schedule's flow now, unless the app is paused. */
  fire(name: string): Promise<ScheduleFired>;
  due(now: Date, lastFired: ReadonlyMap<string, Date>): string[];
}

export interface App {
  readonly name: string;
  readonly applicationVersion: string | undefined;
  readonly flows: Registry<AnyFlow>;
  readonly sources: Registry<SourceDefinition>;
  readonly resolvers: Registry<ResolverDefinition>;
  readonly scorers: Registry<ScorerDefinition>;
  readonly specs: Registry<SpecDefinition>;
  readonly approvalTypes: Registry<ApprovalTypeDefinition>;
  readonly channels: Registry<ActionChannel>;
  readonly records: AppRecords;
  readonly activity: AppActivity;
  readonly tasks: AppTasks;
  readonly labels: AppLabels;
  readonly outcomes: AppOutcomes;
  readonly scores: AppScores;
  /** Keyed by `path`, not by a name: the path is what a workspace link points at. */
  readonly pages: Registry<PageDefinition>;
  readonly schedules: AppSchedules;

  /** Hands the app the handles every control-plane operation below runs on. */
  attach(controlPlane: ControlPlane): void;
  /** For a process that is tearing its pool down; the next call refuses rather than using it. */
  detach(): void;
  controlPlane(operation?: string): ControlPlane;

  runs: {
    start<I>(flow: Flow<I, unknown>, input: I, options?: RunsStartOptions): Promise<StartedRun>;
  };
  approvals: { decide(options: DecideOptions): Promise<DecideResult> };
  reconcile(options?: Partial<ReconcileOptions>): Promise<ReconcileReport>;
  pause(options?: PauseOptions): Promise<PauseResult>;
  resume(options?: PauseOptions): Promise<ResumeResult>;
  status(): Promise<StatusReport>;
  /** A `fetch` handler: the template's `app/api/status/[[...route]]/route.ts` is one line. */
  statusHandler(request: Request): Promise<Response>;
}

/**
 * The app object, and the thing that finally owns the pool and the `DBOSClient` that
 * `reconcile()`, the bump path and `decide()` have taken as bare parameters until now. Every
 * control-plane operation on it is the same function those chunks shipped, with the handles
 * closed over — there is no second implementation of any of them here.
 *
 * Registration is module-level and the handles are not: `src/hyperfixation.ts` is imported by
 * the web and by `worker.ts` alike, and only one of those has a control pool at import time.
 * So `attach()` is a separate call, made once the process knows which shape it is.
 */
export function defineApp(options: DefineAppOptions): App {
  const applicationVersion = options.applicationVersion ?? process.env.HF_BUILD_SHA;

  const flows = createRegistry<AnyFlow>("flow");
  const sources = createRegistry<SourceDefinition>("source");
  const resolvers = createRegistry<ResolverDefinition>("resolver");
  const scorers = createRegistry<ScorerDefinition>("scorer");
  const specs = createRegistry<SpecDefinition>("spec");
  const approvalTypes = createRegistry<ApprovalTypeDefinition>("approval type");
  const channels = createRegistry<ActionChannel>("channel");
  const recordTypes = createRegistry<RecordTable>("record type", (entry) => entry.recordType);
  const pages = createRegistry<PageDefinition>("page", (entry) => entry.path);
  // `Object.assign` rather than a spread: the registry's `size` is a getter, and a spread would
  // copy today's count instead of it.
  const schedules: AppSchedules = Object.assign(createRegistry<AnySchedule>("schedule"), {
    async fire(name: string): Promise<ScheduleFired> {
      const { pool } = controlPlane("schedules.fire");
      return fireSchedule(pool, schedules.require(name), (flow, input) =>
        app.runs.start(flow, input),
      );
    },
    due(now: Date, lastFired: ReadonlyMap<string, Date>): string[] {
      return schedulesDue(schedules.all(), now, lastFired);
    },
  });

  for (const flow of options.flows ?? []) flows.register(flow);
  for (const source of options.sources ?? []) sources.register(source);
  for (const resolver of options.resolvers ?? []) resolvers.register(resolver);
  for (const spec of options.specs ?? []) specs.register(spec);
  for (const scorer of options.scorers ?? []) scorers.register(scorer);
  for (const type of options.approvalTypes ?? []) approvalTypes.register(type);
  for (const channel of options.channels ?? []) channels.register(channel);
  for (const record of options.records ?? []) recordTypes.register(record);
  for (const page of options.pages ?? []) pages.register(page);
  for (const schedule of options.schedules ?? []) schedules.register(schedule);

  // Cross-registry, so after every registration: a scorer whose spec is unregistered would
  // write `spec_version` rows nothing can explain, and a schedule whose flow is unregistered
  // would refuse at its first firing rather than at boot.
  for (const scorer of scorers.all()) {
    if (!specs.has(scorer.spec.name)) {
      throw new UnknownRegistration("spec", scorer.spec.name, specs.names());
    }
  }
  for (const schedule of schedules.all()) {
    if (!flows.has(schedule.flow.name)) {
      throw new UnknownRegistration("flow", schedule.flow.name, flows.names());
    }
  }

  let attached: ControlPlane | undefined;
  const controlPlane = (operation = "this operation"): ControlPlane => {
    if (attached === undefined) throw new AppNotAttached(operation);
    return attached;
  };
  const versionFor = (operation: string): string => {
    if (applicationVersion === undefined) throw new NoApplicationVersion(operation);
    return applicationVersion;
  };

  const app: App = {
    name: options.name,
    applicationVersion,
    flows,
    sources,
    resolvers,
    scorers,
    specs,
    approvalTypes,
    channels,
    pages,
    schedules,
    records: {
      types: recordTypes,
      async archive(archiveOptions) {
        const { pool, client } = controlPlane("records.archive");
        return archiveRecord(pool, client, recordTypes, archiveOptions);
      },
    },
    activity: {
      // No `controlPlane()`: a step-side write runs on the step pool `ctx.tx` already holds.
      record: (ctx, recordOptions) => recordActivity(ctx, recordOptions),
      async list(listOptions) {
        const { pool } = controlPlane("activity.list");
        return listActivity(pool, listOptions);
      },
    },
    tasks: {
      create: (ctx, createOptions) => createTask(ctx, recordTypes, createOptions),
      async createManual(createOptions) {
        const { pool } = controlPlane("tasks.createManual");
        return createManualTask(pool, recordTypes, createOptions);
      },
      async complete(closeOptions) {
        const { pool } = controlPlane("tasks.complete");
        return completeTask(pool, closeOptions);
      },
      async cancel(closeOptions) {
        const { pool } = controlPlane("tasks.cancel");
        return cancelTask(pool, closeOptions);
      },
      async list(listOptions = {}) {
        const { pool } = controlPlane("tasks.list");
        return listTasks(pool, listOptions);
      },
    },
    labels: {
      async add(addOptions) {
        const { pool } = controlPlane("labels.add");
        return addLabel(pool, recordTypes, addOptions);
      },
      async list(listOptions) {
        const { pool } = controlPlane("labels.list");
        return listLabels(pool, listOptions);
      },
    },
    outcomes: {
      async record(outcomeOptions) {
        const { pool } = controlPlane("outcomes.record");
        return recordOutcome(pool, recordTypes, outcomeOptions);
      },
      async list(listOptions) {
        const { pool } = controlPlane("outcomes.list");
        return listOutcomes(pool, listOptions);
      },
    },
    scores: {
      write: (ctx, writeOptions) => writeStepScore(ctx, recordTypes, writeOptions),
    },

    attach(next) {
      attached = next;
    },
    detach() {
      attached = undefined;
    },
    controlPlane,

    runs: {
      async start(flow, input, startOptions) {
        const { pool, client } = controlPlane("runs.start");
        // A flow the app never registered has no queue on this worker and would strand its run
        // at the first bump, where the registry is the only source of a queue name.
        if (!flows.has(flow.name)) {
          throw new UnknownRegistration("flow", flow.name, flows.names());
        }
        return runsStart(pool, client, flow, input, startOptions);
      },
    },
    approvals: {
      async decide(decideOptions) {
        const { pool, client } = controlPlane("approvals.decide");
        return decideApprovals(pool, client, {
          schemaFor: (type) => approvalTypes.get(type)?.schema,
          ...decideOptions,
        });
      },
    },
    async reconcile(reconcileOptions = {}) {
      const { pool, client } = controlPlane("reconcile");
      return reconcile(pool, client, {
        applicationVersion: reconcileOptions.applicationVersion ?? versionFor("reconcile"),
        ...(reconcileOptions.lockTimeout === undefined
          ? {}
          : { lockTimeout: reconcileOptions.lockTimeout }),
      });
    },
    async pause(pauseOptions = {}) {
      const { pool, client } = controlPlane("app.pause");
      return pauseApp(pool, client, pauseOptions);
    },
    async resume(resumeOptions = {}) {
      const { pool, client } = controlPlane("app.resume");
      return resumeApp(pool, client, {
        ...resumeOptions,
        applicationVersion: versionFor("app.resume"),
      });
    },
    async status() {
      const { pool } = controlPlane("app.status");
      return appStatus(pool, { app: options.name, applicationVersion: applicationVersion ?? null });
    },
    async statusHandler(request) {
      const { pool } = controlPlane("app.statusHandler");
      return createStatusHandler({
        pool,
        app: options.name,
        applicationVersion: applicationVersion ?? null,
        handlers: {
          status: () => app.status(),
          // The actor is the write token, not a session: nothing else authenticated the call.
          pause: () => app.pause({ userId: STATUS_TOKEN_ACTOR }),
          resume: () => app.resume({ userId: STATUS_TOKEN_ACTOR }),
        },
      })(request);
    },
  };

  return app;
}
