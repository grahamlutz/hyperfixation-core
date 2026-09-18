import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { RecordTable } from "@hyperfixation/db";
import {
  reconcile,
  runsStart,
  decide as decideApprovals,
  type ActionChannel,
  type DecideOptions,
  type DecideResult,
  type Flow,
  type ReconcileOptions,
  type ReconcileReport,
  type RunsStartOptions,
  type StartedRun,
} from "@hyperfixation/workflows";
import type { Pool } from "pg";
import { pauseApp, resumeApp, type PauseOptions, type PauseResult, type ResumeResult } from "./pause.js";
import { archiveRecord, type ArchiveOptions, type ArchiveResult } from "./records.js";
import { createRegistry, UnknownRegistration, type Registry } from "./registry.js";
import { createStatusHandler, STATUS_TOKEN_ACTOR } from "./status-route.js";
import { appStatus, type StatusReport } from "./status.js";

/**
 * A flow of any shape. `Flow<never, unknown>` is the bottom of the family: its input is
 * contravariant, so every `Flow<I, O>` is one of these.
 */
export type AnyFlow = Flow<never, unknown>;

export interface SourceDefinition {
  readonly name: string;
  /** What `defineRecord` calls the records this source produces. */
  readonly recordType?: string;
}

export interface ResolverDefinition {
  readonly name: string;
  readonly recordType?: string;
}

export interface ScorerDefinition {
  readonly name: string;
  readonly recordType?: string;
}

export interface ApprovalTypeDefinition {
  readonly name: string;
  /** Phase 2 resolves this to the Zod schema an edited draft is validated against. */
  readonly schema?: unknown;
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
  approvalTypes?: readonly ApprovalTypeDefinition[];
  channels?: readonly ActionChannel[];
  records?: readonly RecordTable[];
}

export interface AppRecords {
  /** Registered record types, keyed by the `record_type` machinery rows carry. */
  readonly types: Registry<RecordTable>;
  archive(options: ArchiveOptions): Promise<ArchiveResult>;
}

export interface App {
  readonly name: string;
  readonly applicationVersion: string | undefined;
  readonly flows: Registry<AnyFlow>;
  readonly sources: Registry<SourceDefinition>;
  readonly resolvers: Registry<ResolverDefinition>;
  readonly scorers: Registry<ScorerDefinition>;
  readonly approvalTypes: Registry<ApprovalTypeDefinition>;
  readonly channels: Registry<ActionChannel>;
  readonly records: AppRecords;

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
  const approvalTypes = createRegistry<ApprovalTypeDefinition>("approval type");
  const channels = createRegistry<ActionChannel>("channel");
  const recordTypes = createRegistry<RecordTable>("record type", (entry) => entry.recordType);

  for (const flow of options.flows ?? []) flows.register(flow);
  for (const source of options.sources ?? []) sources.register(source);
  for (const resolver of options.resolvers ?? []) resolvers.register(resolver);
  for (const scorer of options.scorers ?? []) scorers.register(scorer);
  for (const type of options.approvalTypes ?? []) approvalTypes.register(type);
  for (const channel of options.channels ?? []) channels.register(channel);
  for (const record of options.records ?? []) recordTypes.register(record);

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
    approvalTypes,
    channels,
    records: {
      types: recordTypes,
      async archive(archiveOptions) {
        const { pool, client } = controlPlane("records.archive");
        return archiveRecord(pool, client, recordTypes, archiveOptions);
      },
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
        return decideApprovals(pool, client, decideOptions);
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
