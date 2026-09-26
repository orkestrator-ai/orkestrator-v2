import type { PublicActionName } from "@orkestrator/protocol/public-api";
import type { Environment } from "../models.js";
import { boundedMessage } from "./errors.js";
import { isSetupReady } from "./actions-environments.js";
import type { PublicOperationRecord } from "./operation-ledger.js";
import { publicEnvironmentSummary } from "./summaries.js";
import type { OperationPatch, PublicActionContext } from "./types.js";

/**
 * Backend-owned completion and recovery of public operations.
 *
 * Operations whose work outlives their request (environment setup, deletion,
 * prompt runs, exec workers) are advanced here from authoritative state —
 * storage, lifecycle records, dispatch journals — whether or not any client
 * is observing. After a backend restart, work that was in flight is settled
 * from positive evidence where it exists; otherwise it is marked
 * `interrupted` (or left `unknown` for prompts) and is never re-executed.
 */

export type ReconcileFunction = (
  record: PublicOperationRecord,
  context: PublicActionContext,
) => Promise<OperationPatch | null>;

const reconcilers = new Map<PublicActionName, ReconcileFunction>();

export function registerReconciler(action: PublicActionName, reconcile: ReconcileFunction): void {
  reconcilers.set(action, reconcile);
}

const STALE_ADMISSION_MS = 24 * 60 * 60 * 1000;

function interrupted(reason: string): OperationPatch {
  return { state: "interrupted", error: { code: "run-interrupted", message: reason } };
}

function fromPreviousGeneration(
  record: PublicOperationRecord,
  context: PublicActionContext,
): boolean {
  return record.generation !== context.generation;
}

async function environmentOf(
  record: PublicOperationRecord,
  context: PublicActionContext,
): Promise<Environment | null> {
  const id = record.resources.environmentId;
  return id ? context.command.storage.getEnvironment(id) : null;
}

/** Start/recreate: finished when setup is ready or failed. */
const reconcileStart: ReconcileFunction = async (record, context) => {
  const environment = await environmentOf(record, context);
  if (!environment) {
    return {
      state: "failed",
      error: { code: "not-found", message: "The environment was deleted before setup finished" },
    };
  }
  if (record.stage === "setup") {
    if (isSetupReady(environment)) {
      return {
        state: "succeeded",
        stage: "completed",
        result: {
          environmentId: environment.id,
          setup: environment.setupOverride ? "overridden" : "ready",
          environment: publicEnvironmentSummary(environment),
        },
      };
    }
    if (environment.setupPhase === "failed" || environment.status === "error") {
      return {
        state: "failed",
        error: {
          code: "setup-failed",
          message: environment.lifecycleError ?? "Environment setup failed",
        },
      };
    }
    if (fromPreviousGeneration(record, context) && environment.status !== "running") {
      return interrupted("The backend restarted during setup; start the environment again");
    }
    return null;
  }
  if (fromPreviousGeneration(record, context)) {
    if (isSetupReady(environment)) {
      return { state: "succeeded", stage: "completed", result: { environmentId: environment.id } };
    }
    return interrupted("The backend restarted while the environment was starting; start it again");
  }
  return null;
};

const reconcileStop: ReconcileFunction = async (record, context) => {
  if (!fromPreviousGeneration(record, context)) return null;
  const environment = await environmentOf(record, context);
  if (environment?.status === "stopped") {
    return { state: "succeeded", stage: "completed", result: { environmentId: environment.id } };
  }
  return interrupted("The backend restarted before the stop finished; stop the environment again");
};

const reconcileDelete: ReconcileFunction = async (record, context) => {
  const environment = await environmentOf(record, context);
  if (!environment) {
    return {
      state: "succeeded",
      stage: "completed",
      result: { environmentId: record.resources.environmentId ?? null },
    };
  }
  if (!fromPreviousGeneration(record, context)) return null;
  // The backend re-admits recorded deletions at startup; keep observing while
  // the environment still carries its deletion tombstone.
  if (environment.lifecycleOperation === "deleting" || environment.deletionRequestedAt) return null;
  return interrupted("The backend restarted before cleanup finished; delete the environment again");
};

const reconcileCreate: ReconcileFunction = async (record, context) => {
  if (!fromPreviousGeneration(record, context)) return null;
  const projectId = record.resources.projectId;
  const environment = projectId
    ? (await context.command.storage.getEnvironmentsByProject(projectId)).find(
        (candidate) => candidate.controlRequestId === `public:${record.requestKey}`,
      )
    : undefined;
  if (environment) {
    return {
      state: "succeeded",
      stage: "completed",
      resources: { environmentId: environment.id },
      result: { environment: publicEnvironmentSummary(environment) },
    };
  }
  return interrupted(
    "The backend restarted before the environment record was written; nothing was created",
  );
};

const reconcileGenericInFlight: ReconcileFunction = async (record, context) => {
  if (!fromPreviousGeneration(record, context)) return null;
  return interrupted(
    "The backend restarted while this operation was in progress; its effect is not confirmed",
  );
};

registerReconciler("environment.start", reconcileStart);
registerReconciler("environment.recreate", reconcileStart);
registerReconciler("environment.stop", reconcileStop);
registerReconciler("environment.delete", reconcileDelete);
registerReconciler("environment.create", reconcileCreate);
for (const action of [
  "environment.fork",
  "environment.rename",
  "project.add",
  "project.create",
  "project.update",
  "project.remove",
  "project.config.set",
  "environment.config.set",
  "session.config.set",
  "session.resume",
  "session.fork",
  "session.steer",
  "session.stop",
  "session.interaction.resolve",
  "run.discard",
  "run.cancel",
] as const) {
  registerReconciler(action, reconcileGenericInFlight);
}

/** Reconcile one active record; returns the updated record when it changed. */
export async function reconcileOperation(
  record: PublicOperationRecord,
  context: PublicActionContext,
): Promise<PublicOperationRecord> {
  if (!["admitted", "running", "unknown"].includes(record.state)) return record;
  if (record.state === "admitted") {
    // Nothing ran for an admitted record. A replay of its key in a later
    // generation runs it; one left unclaimed for a day is closed out so it
    // cannot pin its namespace forever.
    if (
      fromPreviousGeneration(record, context) &&
      context.now() - Date.parse(record.createdAt) > STALE_ADMISSION_MS
    ) {
      const updated = await context.command.storage.updatePublicOperation(
        record.operationId,
        (current) =>
          current.state === "admitted"
            ? {
                ...current,
                state: "interrupted",
                error: {
                  code: "run-interrupted",
                  message: "Admitted but never started; nothing was executed",
                },
                completedAt: new Date(context.now()).toISOString(),
              }
            : null,
      );
      return updated ?? record;
    }
    return record;
  }
  const reconcile = reconcilers.get(record.action);
  if (!reconcile) return record;
  let patch: OperationPatch | null;
  try {
    patch = await reconcile(record, context);
  } catch (error) {
    console.warn(`[public-api] Reconciling ${record.operationId} failed: ${boundedMessage(error)}`);
    return record;
  }
  if (!patch) return record;
  const updated = await context.command.storage.updatePublicOperation(
    record.operationId,
    (current) => {
      if (!["admitted", "running", "unknown"].includes(current.state)) return null;
      return {
        ...current,
        ...patch,
        resources: { ...current.resources, ...patch.resources },
        generation: context.generation,
        ...(patch.state && !["admitted", "running", "unknown"].includes(patch.state)
          ? { completedAt: new Date(context.now()).toISOString() }
          : {}),
      };
    },
  );
  return updated ?? record;
}

const RECONCILE_INTERVAL_MS = 15_000;

/**
 * One reconciler per storage instance: a startup pass, a pass whenever an
 * environment changes, and a bounded periodic sweep. Collection of retired
 * namespaces runs on the same timer at the retention cadence.
 */
export class PublicOperationReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private pendingEnvironments = new Set<string>();
  private lastCollection = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private context: PublicActionContext) {}

  updateContext(context: PublicActionContext): void {
    this.context = context;
  }

  start(): void {
    if (this.timer) return;
    this.unsubscribe = this.context.command.storage.addResourceChangeListener((change) => {
      if (change.resource !== "environment") return;
      this.pendingEnvironments.add(change.id);
      this.schedule();
    });
    this.timer = setInterval(() => this.schedule(true), RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
    this.schedule(true);
  }

  /** Stop scheduling and wait for an in-flight pass to finish. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingEnvironments.clear();
    await this.running?.catch(() => undefined);
  }

  private schedule(all = false): void {
    if (!this.timer) return;
    if (this.running) {
      if (all) this.pendingEnvironments.add("*");
      return;
    }
    const environments = all ? null : new Set(this.pendingEnvironments);
    this.pendingEnvironments.clear();
    this.running = this.pass(environments)
      .catch((error: unknown) => {
        console.warn(`[public-api] Operation reconciliation failed: ${boundedMessage(error)}`);
      })
      .finally(() => {
        this.running = null;
        if (this.pendingEnvironments.size > 0) {
          const everything = this.pendingEnvironments.has("*");
          this.schedule(everything);
        }
      });
  }

  async pass(environments: Set<string> | null = null): Promise<void> {
    const context = this.context;
    const active = await context.command.storage.listActivePublicOperations();
    for (const record of active) {
      if (
        environments &&
        !(record.resources.environmentId && environments.has(record.resources.environmentId))
      ) {
        continue;
      }
      await reconcileOperation(record, context);
    }
    if (context.now() - this.lastCollection > 60 * 60 * 1000) {
      this.lastCollection = context.now();
      await context.command.storage.collectPublicOperations(context.now());
    }
  }
}

const reconcilersByStorage = new WeakMap<object, PublicOperationReconciler>();

export function ensureReconciler(context: PublicActionContext): PublicOperationReconciler {
  const storage = context.command.storage;
  let reconciler = reconcilersByStorage.get(storage);
  if (!reconciler) {
    reconciler = new PublicOperationReconciler(context);
    reconcilersByStorage.set(storage, reconciler);
    reconciler.start();
  } else {
    reconciler.updateContext(context);
  }
  return reconciler;
}

/** Stop and forget the reconciler of one storage instance (tests, shutdown). */
export async function stopReconciler(storage: object): Promise<void> {
  const reconciler = reconcilersByStorage.get(storage);
  reconcilersByStorage.delete(storage);
  await reconciler?.stop();
}
