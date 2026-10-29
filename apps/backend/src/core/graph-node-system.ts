/**
 * The `system` node executor (plan P2.7, D12, D20; report §6.6): side
 * effects run in the backend, idempotently, so no agent node needs push or
 * GitHub access. One module per action (`graph-system-*.ts`); the action
 * table (ports, parameters, `sideEffect`) is the protocol's
 * `graphs/system-actions.ts`, which the compiler also checks.
 *
 * ## How an activation runs
 *
 * - **Jobs** (every action but `wait-for-checks`): `start` launches the
 *   action as a background job in this process and waits up to 2 s for it;
 *   a job still running is reported `running`, and when it settles the job
 *   flags its activation for observation (`requestObservation`), so the next
 *   pass reports the outcome. `observe` and `recover` report a settled job,
 *   or launch it again when this process has none (after a restart).
 * - **Waits** (`wait-for-checks`): every call re-evaluates the action, which
 *   only reads in-memory monitor state; a subscription to the PR monitor's
 *   events flags the activation when the monitor announces a change.
 * - **Idempotency** is the effect journal's (`graph-system-action.ts`,
 *   `storage-graph-effects.ts`): launching a job again, after a crash, a lost
 *   save, a retry or a restart of the node, never repeats a recorded effect.
 * - **Cancel** aborts the job (its commands get the signal), asks the action
 *   to stop work it left in the environment (a validation run), and reports
 *   `cancelled` once the job has settled.
 *
 * System nodes never use agent sessions. Logs carry ids, actions and counts
 * only; errors are the actions' own bounded, content-free lines.
 */
import type { GraphPlanSystemNode } from "@orkestrator/protocol/graphs/compile";
import type { GraphSystemAction } from "@orkestrator/protocol/graphs/template";
import type { GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import type {
  GraphActivationReport,
  GraphCancelReason,
  GraphExecutorContext,
  GraphNodeExecutor,
} from "./graph-run-executors.js";
import {
  GraphSystemActionContext,
  GraphSystemActionError,
  type GraphSystemActionHandler,
  type GraphSystemDependencies,
} from "./graph-system-action.js";
import { waitForChecksAction } from "./graph-system-checks.js";
import { notifyAction } from "./graph-system-notify.js";
import { prepareEnvironmentAction } from "./graph-system-prepare.js";
import { openPullRequestAction } from "./graph-system-pull-request.js";
import { pushBranchAction } from "./graph-system-push.js";
import { updateTicketAction } from "./graph-system-ticket.js";
import { selectWorkspaceAction } from "./graph-system-select.js";
import { runValidationAction, runValidationAndSealAction } from "./graph-system-validation.js";

/** Every action, by name (`select-workspace` is item 403's). */
export const GRAPH_SYSTEM_ACTION_HANDLERS: Readonly<
  Record<GraphSystemAction, GraphSystemActionHandler>
> = Object.freeze({
  "prepare-environment": prepareEnvironmentAction,
  "run-validation": runValidationAction,
  "run-validation-and-seal": runValidationAndSealAction,
  "push-branch": pushBranchAction,
  "open-pull-request": openPullRequestAction,
  "wait-for-checks": waitForChecksAction,
  "update-ticket": updateTicketAction,
  notify: notifyAction,
  "select-workspace": selectWorkspaceAction,
});

/** How soon a running job is looked at without a wake (a safety net; settling wakes it). */
export const GRAPH_SYSTEM_JOB_OBSERVE_MS = 30_000;
const DEFAULT_INLINE_WAIT_MS = 2_000;

type JobOutcome =
  | { state: "complete"; outputs: Record<string, string> }
  | { state: "failed"; error: string; cause: GraphErrorCause };

interface SystemJob {
  promise: Promise<void>;
  abort: AbortController;
  outcome?: JobOutcome;
}

function jobKey(runId: string, activationKey: string): string {
  return `${runId}\0${activationKey}`;
}

function failure(error: unknown): JobOutcome {
  if (error instanceof GraphSystemActionError) {
    return { state: "failed", error: error.message, cause: error.failureCause };
  }
  return {
    state: "failed",
    error: error instanceof Error && error.message ? error.message : "The system action failed",
    cause: "system-error",
  };
}

export class GraphNodeSystemExecutor implements GraphNodeExecutor {
  readonly kind = "system" as const;
  private readonly jobs = new Map<string, SystemJob>();
  private readonly watches = new Map<string, { environmentId: string; stop: () => void }>();
  private readonly stopController = new AbortController();

  constructor(
    private readonly deps: GraphSystemDependencies,
    private readonly handlers: Readonly<
      Record<GraphSystemAction, GraphSystemActionHandler>
    > = GRAPH_SYSTEM_ACTION_HANDLERS,
  ) {}

  start(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return this.drive(context);
  }

  observe(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return this.drive(context);
  }

  recover(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return this.drive(context);
  }

  async cancel(
    context: GraphExecutorContext,
    _reason: GraphCancelReason,
  ): Promise<GraphActivationReport> {
    const key = jobKey(context.run.id, context.activation.key);
    this.unwatch(key);
    const node = this.systemNode(context);
    const handler = this.handlers[node.action];
    const job = this.jobs.get(key);
    if (job && !job.outcome) {
      job.abort.abort();
      return { state: "unchanged" };
    }
    this.jobs.delete(key);
    if (handler.cancel) {
      const actionContext = this.actionContext(context, this.stopController.signal);
      await handler.cancel(actionContext).catch((error: unknown) => {
        console.warn("[graph-system] Could not stop the action's work", {
          runId: context.run.id,
          nodeId: node.id,
          action: node.action,
          error: error instanceof Error ? error.name : "unknown",
        });
      });
    }
    return { state: "cancelled" };
  }

  /** Stops every job (backend shutdown); their activations recover in the next process. */
  shutdown(): void {
    this.stopController.abort();
    for (const job of this.jobs.values()) job.abort.abort();
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
  }

  /** Jobs this process is running (tests, diagnostics). */
  runningJobs(): number {
    return [...this.jobs.values()].filter((job) => !job.outcome).length;
  }

  private systemNode(context: GraphExecutorContext): GraphPlanSystemNode {
    if (context.node.kind !== "system") {
      throw new GraphSystemActionError("The system executor received a non-system node");
    }
    return context.node;
  }

  private actionContext(context: GraphExecutorContext, signal: AbortSignal) {
    return new GraphSystemActionContext(
      {
        run: context.run,
        node: this.systemNode(context),
        activation: context.activation,
        environmentId: context.environmentId,
        artifacts: context.artifacts,
        now: () => context.now(),
      },
      this.deps,
      signal,
    );
  }

  private progress(context: GraphExecutorContext, observeAfterMs: number | null) {
    return context.activation.state === "admitting"
      ? ({ state: "running", observeAfterMs } as const)
      : ({ state: "unchanged", observeAfterMs } as const);
  }

  private report(outcome: JobOutcome): GraphActivationReport {
    return outcome.state === "complete"
      ? { state: "complete", outputs: outcome.outputs }
      : { state: "failed", error: outcome.error, cause: outcome.cause };
  }

  private async drive(context: GraphExecutorContext): Promise<GraphActivationReport> {
    const node = this.systemNode(context);
    const handler = this.handlers[node.action];
    const key = jobKey(context.run.id, context.activation.key);
    if (handler.wait) return this.driveWait(context, handler, key);
    if (!handler.run) throw new GraphSystemActionError(`${node.action} cannot run`);

    let job = this.jobs.get(key);
    if (!job) job = this.launch(context, handler, key);
    if (!job.outcome) {
      const inline = this.deps.inlineWaitMs ?? DEFAULT_INLINE_WAIT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        job.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, inline);
        }),
      ]);
      clearTimeout(timer);
    }
    if (!job.outcome) return this.progress(context, GRAPH_SYSTEM_JOB_OBSERVE_MS);
    this.jobs.delete(key);
    return this.report(job.outcome);
  }

  private launch(
    context: GraphExecutorContext,
    handler: GraphSystemActionHandler,
    key: string,
  ): SystemJob {
    const abort = new AbortController();
    const stop = () => abort.abort();
    this.stopController.signal.addEventListener("abort", stop, { once: true });
    const actionContext = this.actionContext(context, abort.signal);
    const job: SystemJob = { abort, promise: Promise.resolve() };
    job.promise = (async () => {
      try {
        await handler.run!(actionContext);
        actionContext.throwIfAborted();
        job.outcome = { state: "complete", outputs: { ...actionContext.outputs } };
      } catch (error) {
        job.outcome = failure(error);
        console.warn("[graph-system] Action failed", {
          runId: context.run.id,
          nodeId: actionContext.node.id,
          action: actionContext.node.action,
          cause: job.outcome.state === "failed" ? job.outcome.cause : undefined,
        });
      } finally {
        this.stopController.signal.removeEventListener("abort", stop);
        if (!this.stopController.signal.aborted) {
          this.deps.requestObservation(context.run.id, context.activation.key);
        }
      }
    })();
    this.jobs.set(key, job);
    return job;
  }

  private async driveWait(
    context: GraphExecutorContext,
    handler: GraphSystemActionHandler,
    key: string,
  ): Promise<GraphActivationReport> {
    const actionContext = this.actionContext(context, this.stopController.signal);
    let result;
    try {
      result = await handler.wait!(actionContext);
    } catch (error) {
      this.unwatch(key);
      return this.report(failure(error));
    }
    if (result.state === "complete") {
      this.unwatch(key);
      return { state: "complete", outputs: { ...actionContext.outputs } };
    }
    if (result.watchEnvironment) this.watch(context, key, result.watchEnvironment);
    return this.progress(context, result.observeAfterMs);
  }

  private watch(context: GraphExecutorContext, key: string, environmentId: string): void {
    const existing = this.watches.get(key);
    if (existing?.environmentId === environmentId) return;
    existing?.stop();
    const runId = context.run.id;
    const activationKey = context.activation.key;
    const stop = this.deps.prMonitor.subscribe((changed) => {
      if (changed === environmentId) this.deps.requestObservation(runId, activationKey);
    });
    this.watches.set(key, { environmentId, stop });
  }

  private unwatch(key: string): void {
    this.watches.get(key)?.stop();
    this.watches.delete(key);
  }
}
