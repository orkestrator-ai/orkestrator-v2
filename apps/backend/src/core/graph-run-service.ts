/**
 * Graph runs: launch from a compiled plan, read, cancel, pause and resume,
 * driven by the keyed `graph-run` supervisor (plan P2.2, P2.3).
 *
 * The run record is the authority (invariant 1). Every pass reads its run
 * from storage under the run's lock and saves with compare-and-swap; nothing
 * a pass needs lives only in memory except observation timing, which a
 * restart rebuilds (every admitted activation is recovered once). The view,
 * the CLI and the coordinator rehydrate from the stored record; closing a
 * view never cancels a run.
 *
 * Bounded: one key per run with an obligation (`maxKeys` of the supervisor),
 * at most 8 passes at once sharing the `workflow-provider` admission pool,
 * per-run limits from the plan, the 200 live-activation cap and the record's
 * own bounds (item 201). Logs carry run ids, codes and counts only.
 *
 * Launch surfaces (item 214) compile a template against the launch
 * environment, resolve role bindings and parameters, and call {@link
 * GraphRunService.create}. Executors for each node kind (204–208) register on
 * {@link GraphRunService.executors}. Restart and code rewind (item 210) are
 * {@link GraphRunService.restart}, {@link GraphRunService.previewCodeRewind}
 * and {@link GraphRunService.rewindCode} (`graph-run-rewind.ts`).
 */
import { randomUUID } from "node:crypto";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  GRAPH_RUN_INPUT_PRODUCER,
  graphNodeBranches,
  isGraphRunTerminal,
  replaceGraphActivation,
  type GraphRun,
  type GraphRunBindings,
  type GraphRunLaunchInfo,
  type GraphRunTemplateRef,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import { GraphTypeLibrary, validateGraphArtifactValue } from "@orkestrator/protocol/graphs/types";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import { GraphStorageError, isGraphStorageError } from "./graph-run-errors.js";
import { GraphNodeExecutorRegistry } from "./graph-run-executors.js";
import {
  GRAPH_RUN_HUMAN_WAIT_MS,
  GRAPH_RUN_OBSERVATION_MS,
  GRAPH_RUN_PROGRESS_MS,
  GraphRunMemory,
  GraphRunPassFencedError,
  runGraphRunPass,
  type GraphRunPassDependencies,
  type GraphRunPassOptions,
  type GraphRunPassStats,
  type GraphRunProvisioner,
} from "./graph-run-pass.js";
import { GraphWorkspaceLocks, graphRunWorkspaceHold } from "./graph-run-scheduling.js";
import {
  GraphRunResultKeys,
  createGraphRunSupervisor,
  discoverGraphRuns,
  graphRunObligation,
  graphRunTarget,
  type GraphRunObligation,
} from "./graph-run-supervisor.js";
import { isGraphActivationAdmitted, transitionGraphRun } from "./graph-run-transitions.js";
import { planGraphRunRetry, planGraphRunSkip } from "./graph-run-user-actions.js";
import {
  GraphRunRewindError,
  GraphRunRewinds,
  graphRunPendingCodeRewind,
  type GraphRewindOptions,
} from "./graph-run-rewind.js";
import type {
  GraphRunCodeRewindPreview,
  GraphRunRestartResult,
} from "@orkestrator/protocol/graphs/run-rewind";
import type { Environment } from "./models.js";
import type { EnvironmentGit } from "./workspace-code-rewind.js";
import {
  reviewFanoutConcurrency,
  type ReviewFanoutConcurrency,
} from "./review-fanout-scheduler.js";
import type { ResourceChangeListener } from "./storage-shared.js";
import type { GraphRunsStorage } from "./storage-graph-runs.js";
import type { WorkflowResultAcceptance } from "./workflow-result-service.js";
import {
  keyedSchedulingEnabled,
  type KeyedWorkflowOwner,
  type KeyedWorkflowServiceOptions,
  type KeyedWorkflowSupervisor,
  type WorkflowPass,
  type WorkflowReconcileReport,
  type WorkflowSupervisorStatus,
  type WorkflowWakeReason,
} from "./workflow-supervisor.js";

/** Runs whose latest pass counts are kept for diagnostics and the benchmark. */
const MAX_RETAINED_PASS_STATS = 256;

export type GraphRunServiceErrorCode =
  /** The `graph-run` domain is rolled back (`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK`). */
  | "disabled"
  /** The launch request does not fit the plan (inputs, roles, parameters). */
  | "invalid-launch"
  | "not-found"
  /** The run's status does not allow the action. */
  | "invalid-state"
  /** A command's arguments are malformed (the run view's commands, item 211). */
  | "invalid-request";

export class GraphRunServiceError extends Error {
  constructor(
    readonly code: GraphRunServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GraphRunServiceError";
  }
}

/** What a launch surface hands over (item 214 builds it). */
export interface GraphRunLaunch {
  /** Defaults to a fresh UUID. */
  id?: string;
  projectId: string;
  /** Absent: the run provisions its environment first (D7, `provisioning`). */
  environmentId?: string;
  template: GraphRunTemplateRef;
  /** A plan compiled for this launch; frozen into the run. */
  plan: CompiledGraphPlan;
  roles: GraphRunBindings["roles"];
  /** Parameter values; missing ones take the plan's defaults. */
  params?: GraphRunBindings["params"];
  /** Run input values by name, stored as `$input` value artifacts. */
  inputs?: Record<string, unknown>;
  /** A mock run (item 213): mock executors only, no sessions, no side effects. */
  mock?: boolean;
  /** Who launched it and how (item 214): ids only. */
  launch?: GraphRunLaunchInfo;
}

export interface GraphRunServiceOptions extends KeyedWorkflowServiceOptions {
  /** Stores and verifies run inputs and node outputs. */
  artifacts: GraphArtifactStore;
  executors?: GraphNodeExecutorRegistry;
  /** Creates the environment of a run launched without one (207/214). */
  provisioner?: GraphRunProvisioner | null;
  /** Per-pass executor-call caps; defaults 4 starting, 8 observing, 4 per provider. */
  concurrency?: Partial<ReviewFanoutConcurrency>;
  observationIntervalMs?: number;
  progressIntervalMs?: number;
  /** Git in a run's worktree, for code rewinds (item 210); absent: unavailable. */
  environmentGit?: EnvironmentGit;
  /**
   * Holds a run's environment exclusively while a code rewind's reset commits
   * and refuses while another workflow may write to it (item 210).
   */
  codeRewindReservation?: <T>(run: GraphRun, operation: () => Promise<T>) => Promise<T>;
  /** False: no supervisor; callers drive passes with `advanceNow` (tests). */
  autoAdvance?: boolean;
  clock?: () => Date;
}

type GraphRunStorage = {
  graphRuns: GraphRunsStorage;
  addResourceChangeListener?(listener: ResourceChangeListener): () => void;
  /** A run's environment, for its pull request state (restart refusals). */
  getEnvironment?(id: string): Promise<Environment | null>;
};

function launchError(message: string): GraphRunServiceError {
  return new GraphRunServiceError("invalid-launch", message);
}

export class GraphRunService implements KeyedWorkflowOwner {
  readonly executors: GraphNodeExecutorRegistry;
  /** Whether the `graph-run` domain is enabled (not rolled back). */
  readonly enabled: boolean;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly memories = new Map<string, GraphRunMemory>();
  private readonly workspaceLocks = new GraphWorkspaceLocks();
  private readonly resultKeys = new GraphRunResultKeys();
  private readonly passDeps: GraphRunPassDependencies;
  private supervisor: KeyedWorkflowSupervisor<GraphRunObligation> | null = null;
  private unsubscribeStorage: (() => void) | null = null;
  private stopController = new AbortController();
  private stopped = false;
  /** Startup recovery seeded every stored run's workspace holds. */
  private workspaceSeeded = false;
  /** Runs a pass has touched since start; recovery seeding never overwrites them. */
  private readonly passed = new Set<string>();
  /** Counts of the latest pass per run (the efficiency benchmark reads them). */
  private readonly lastStats = new Map<string, GraphRunPassStats>();
  /** Restarts and code rewinds (item 210). */
  private readonly rewinds: GraphRunRewinds;

  constructor(
    private readonly storage: GraphRunStorage,
    private readonly options: GraphRunServiceOptions,
  ) {
    this.executors = options.executors ?? new GraphNodeExecutorRegistry();
    this.enabled = options.keyedScheduling ?? keyedSchedulingEnabled("graph-run");
    const schedulerNow = options.schedulerClock?.now ?? (() => performance.now());
    this.passDeps = {
      storage: storage.graphRuns,
      artifacts: options.artifacts,
      executors: this.executors,
      locks: this.workspaceLocks,
      workspaceKnown: () => this.workspaceSeeded,
      provisioner: options.provisioner ?? null,
      concurrency: reviewFanoutConcurrency(options.concurrency),
      observationIntervalMs: options.observationIntervalMs ?? GRAPH_RUN_OBSERVATION_MS,
      progressIntervalMs: options.progressIntervalMs ?? GRAPH_RUN_PROGRESS_MS,
      monotonic: schedulerNow,
      clock: options.clock ?? (() => new Date()),
      memory: (runId) => this.memory(runId),
      wake: (runId) => this.wake(runId, "explicit"),
      // A released lock lets another run's ready work in: wake the runs that may have some.
      released: (environmentId) =>
        this.supervisor?.wakeTarget(
          environmentId,
          "explicit",
          (obligation) => obligation === "advance" || obligation === "observe",
        ),
      prepare: (run) => this.finishPendingCodeRewind(run),
    };
    this.rewinds = new GraphRunRewinds({
      storage: storage.graphRuns,
      artifacts: options.artifacts,
      executors: this.executors,
      clock: this.passDeps.clock,
      locked: (runId, operation) => this.withLock(runId, operation),
      signal: () => this.stopController.signal,
      wake: (runId) => this.wake(runId, "explicit"),
      ...(storage.getEnvironment
        ? { environment: (id: string) => storage.getEnvironment!(id) }
        : {}),
      ...(options.environmentGit ? { git: options.environmentGit } : {}),
      ...(options.codeRewindReservation ? { reserve: options.codeRewindReservation } : {}),
    });
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Starts the keyed driver. Non-blocking: the first discovery runs on the
   * scheduler, recovers every run with an obligation and seeds the workspace
   * locks. Disabled (rolled back) or `autoAdvance: false`: nothing runs.
   */
  async init(): Promise<void> {
    this.stopped = false;
    this.stopController = new AbortController();
    if (!this.enabled || this.options.autoAdvance === false || this.supervisor) {
      // Driven by hand: there is no recovery pass to wait for.
      if (this.options.autoAdvance === false) this.workspaceSeeded = true;
      return;
    }
    this.supervisor = createGraphRunSupervisor({
      discover: () => this.discover(),
      advance: (pass) => this.advancePass(pass),
      nextDelayMs: (key) => this.memories.get(key)?.nextDelayMs,
      progressIntervalMs: this.passDeps.progressIntervalMs,
      ...(this.options.discoveryIntervalMs !== undefined
        ? { discoveryIntervalMs: this.options.discoveryIntervalMs }
        : {}),
      admission: this.options.workflowAdmission ?? null,
      ...(this.options.schedulerClock ? { schedulerClock: this.options.schedulerClock } : {}),
    });
    this.unsubscribeStorage =
      this.storage.addResourceChangeListener?.((change) => {
        if (change.resource === "graph-run" && change.deleted) this.forgetRun(change.id);
      }) ?? null;
    this.supervisor.start();
  }

  /** Stops scheduling, aborts executor calls in flight and waits for running passes. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.supervisor?.stop();
    this.supervisor = null;
    this.unsubscribeStorage?.();
    this.unsubscribeStorage = null;
    this.stopController.abort();
    while (this.locks.size > 0) {
      await Promise.allSettled(this.locks.values());
    }
  }

  private async discover() {
    const result = await discoverGraphRuns(this.storage.graphRuns, (run) => {
      if (isGraphRunTerminal(run.status)) return;
      this.resultKeys.note(run);
      // Seed only runs no pass has touched: a pass's own view is newer.
      if (!this.workspaceSeeded && !this.passed.has(run.id)) {
        this.workspaceLocks.set(run.id, run.environmentId, graphRunWorkspaceHold(run));
      }
    });
    this.workspaceSeeded = true;
    this.passed.clear();
    return result;
  }

  // ------------------------------------------------------------ KeyedWorkflowOwner

  /**
   * Scoped wakeup for an environment's runs. `result-accepted` is ignored
   * here: {@link resultAccepted} wakes exactly the owning run.
   */
  wakeEnvironment(environmentId: string, reason: WorkflowWakeReason): void {
    if (reason === "result-accepted") return;
    this.supervisor?.wakeTarget(environmentId, reason);
  }

  schedulingStatus(): WorkflowSupervisorStatus | null {
    return this.supervisor?.status() ?? null;
  }

  async reconcileScheduling(): Promise<WorkflowReconcileReport | null> {
    return this.supervisor ? this.supervisor.reconcileNow() : null;
  }

  /** Wakes one run. */
  wake(runId: string, reason: WorkflowWakeReason = "explicit"): void {
    this.supervisor?.wake(runId, reason);
  }

  /**
   * Observes one activation at the run's next pass and wakes the run: a
   * human answer arrived (208), or an executor learned that its work moved.
   */
  requestObservation(runId: string, activationKey: string): void {
    this.memory(runId).flagged.add(activationKey);
    this.wake(runId, "explicit");
  }

  /**
   * A workflow result slot was accepted. Wakes only the run whose admitted
   * activation owns the slot, and marks that activation for observation.
   */
  resultAccepted(event: WorkflowResultAcceptance): void {
    if (!this.supervisor) return;
    const owner = this.resultKeys.owner(event.resultKey);
    if (owner) {
      this.memory(owner.runId).flagged.add(owner.activationKey);
      this.supervisor.wake(owner.runId, "result-accepted", event.environmentId);
      return;
    }
    // Not indexed (recorded by another process, or before this process saw
    // the run): look in the environment's stored runs. Most slots are not
    // graph slots at all, and then nothing is woken.
    void this.storage.graphRuns
      .listGraphRuns(event.environmentId)
      .then((runs) => {
        for (const run of runs) {
          const found = GraphRunResultKeys.find(run, event.resultKey);
          if (!found) continue;
          this.resultKeys.note(run);
          this.memory(found.runId).flagged.add(found.activationKey);
          this.supervisor?.wake(found.runId, "result-accepted", event.environmentId);
          return;
        }
      })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------ reads

  /**
   * The run and admitted activation whose current request owns a result slot
   * key, from the stored record (an activation's tools resolve their
   * activation this way; item 204). Null when no admitted activation of a run
   * in the environment owns it.
   */
  async activationForResultKey(
    environmentId: string,
    resultKey: string,
  ): Promise<{ run: GraphRun; activation: NodeActivation } | null> {
    const owner = this.resultKeys.owner(resultKey);
    const indexed = owner ? await this.storage.graphRuns.getGraphRun(owner.runId) : null;
    const candidates =
      indexed && GraphRunResultKeys.find(indexed, resultKey)
        ? [indexed]
        : await this.storage.graphRuns.listGraphRuns(environmentId);
    for (const run of candidates) {
      if (run.environmentId !== environmentId) continue;
      const found = GraphRunResultKeys.find(run, resultKey);
      if (!found) continue;
      const activation = run.activations.find((entry) => entry.key === found.activationKey);
      if (activation) return { run, activation };
    }
    return null;
  }

  async get(runId: string): Promise<GraphRun | null> {
    const run = await this.storage.graphRuns.getGraphRun(runId);
    if (run) this.noteRecord(run);
    return run;
  }

  async list(environmentId: string): Promise<GraphRun[]> {
    return this.storage.graphRuns.listGraphRuns(environmentId);
  }

  /** Counts of the latest pass over a run in this process (content-free). */
  passStats(runId: string): GraphRunPassStats | undefined {
    return this.lastStats.get(runId);
  }

  // ------------------------------------------------------------ commands

  /**
   * Creates a run from a compiled plan and its bindings, stores its inputs
   * and wakes it. Refuses a launch that does not fit the plan, and every
   * launch while the domain is rolled back.
   */
  async create(launch: GraphRunLaunch): Promise<GraphRun> {
    if (!this.enabled) {
      throw new GraphRunServiceError(
        "disabled",
        "Graph runs are disabled (ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK)",
      );
    }
    const plan = launch.plan;
    const inputs = this.checkLaunch(launch);
    const params = { ...launch.params };
    for (const parameter of plan.parameters) {
      if (params[parameter.key] === undefined && parameter.default !== undefined) {
        params[parameter.key] = parameter.default;
      }
    }
    const id = launch.id ?? randomUUID();
    const at = this.passDeps.clock().toISOString();
    const running = launch.environmentId !== undefined;
    const draft: GraphRun = {
      format: GRAPH_RUN_FORMAT,
      formatVersion: GRAPH_RUN_FORMAT_VERSION,
      id,
      projectId: launch.projectId,
      ...(launch.environmentId !== undefined ? { environmentId: launch.environmentId } : {}),
      template: { ...launch.template },
      plan,
      bindings: { roles: structuredClone(launch.roles), params, inputs: {} },
      ...(launch.launch ? { launch: structuredClone(launch.launch) } : {}),
      status: running ? "running" : "provisioning",
      mock: launch.mock ?? false,
      activations: [],
      rewinds: [],
      loopIterations: Object.fromEntries(plan.loops.map((loop) => [loop.id, 1])),
      usage: { agentSessions: 0, tokens: 0 },
      revision: 0,
      createdAt: at,
      updatedAt: at,
      ...(running ? { startedAt: at } : {}),
    };
    const created = await this.withLock(id, async () => {
      let run = await this.storage.graphRuns.createGraphRun(draft);
      if (inputs.length === 0) return run;
      const ids: Record<string, string> = {};
      try {
        for (const input of inputs) {
          const artifact = await this.options.artifacts.putValue({
            runId: id,
            type: input.type,
            producer: {
              nodeId: GRAPH_RUN_INPUT_PRODUCER,
              activation: GRAPH_RUN_INPUT_PRODUCER,
              port: input.name,
            },
            value: input.value,
          });
          ids[input.name] = artifact.id;
        }
      } catch (error) {
        const code = isGraphStorageError(error) ? error.code : "invalid-artifact";
        run = await this.storage.graphRuns.saveGraphRun(
          transitionGraphRun(run, "failed", this.passDeps.clock().toISOString(), {
            error: `A run input was refused (${code})`,
            cause: "system-error",
          }),
          run.revision,
        );
        this.noteRecord(run);
        throw launchError(`A run input was refused (${code})`);
      }
      return this.storage.graphRuns.saveGraphRun(
        { ...run, bindings: { ...run.bindings, inputs: ids } },
        run.revision,
      );
    });
    this.noteRecord(created);
    this.wake(created.id, "start");
    return created;
  }

  /** Validates a launch against its plan; returns the inputs to store. */
  private checkLaunch(launch: GraphRunLaunch): { name: string; type: string; value: unknown }[] {
    const plan = launch.plan;
    const library = new GraphTypeLibrary(plan.types);
    const given = launch.inputs ?? {};
    const declared = new Set(plan.inputs.map((input) => input.name));
    for (const name of Object.keys(given)) {
      if (!declared.has(name)) throw launchError(`The plan has no run input ${name}`);
    }
    const inputs: { name: string; type: string; value: unknown }[] = [];
    for (const input of plan.inputs) {
      if (!(input.name in given)) {
        // A run that creates its environment stores its empty `workspace@1`
        // inputs from that environment's HEAD once it exists (item 214).
        const deferred = launch.environmentId === undefined && input.type === "workspace@1";
        if (input.required && !deferred) {
          throw launchError(`The run input ${input.name} is required`);
        }
        continue;
      }
      const resolution = library.resolve(input.type);
      if (!resolution.ok || resolution.type.kind !== "named") {
        throw launchError(`The run input ${input.name} has a type the plan does not resolve`);
      }
      const definition = resolution.type.definition;
      if (definition.storage !== "value") {
        throw launchError(`The run input ${input.name} needs a reference artifact`);
      }
      const issues = validateGraphArtifactValue(definition, given[input.name]);
      if (issues.length > 0) {
        throw launchError(
          `The run input ${input.name} fails its type: ${issues
            .slice(0, 4)
            .map((issue) => `${issue.path}:${issue.code}`)
            .join(", ")}`,
        );
      }
      inputs.push({ name: input.name, type: input.type, value: given[input.name] });
    }
    for (const node of plan.nodes) {
      if (node.kind !== "agent") continue;
      let branches;
      try {
        branches = graphNodeBranches(node, launch.roles);
      } catch (error) {
        throw launchError(error instanceof Error ? error.message : "Unsupported replication");
      }
      const roles = branches ? branches.map((branch) => branch.role) : [node.role];
      for (const role of roles) {
        if (launch.roles[role] === undefined) throw launchError(`The role ${role} is not bound`);
      }
      if (branches && branches.length === 0 && node.fanOut.min > 0) {
        throw launchError(`The node ${node.id} has no branches to run`);
      }
    }
    return inputs;
  }

  /** Requests cancellation: admitted work is stopped by its executors on the next pass. */
  async cancel(runId: string): Promise<GraphRun> {
    const run = await this.mutate(runId, (current, at) => {
      if (isGraphRunTerminal(current.status) || current.status === "cancelling") return null;
      return transitionGraphRun(current, "cancelling", at);
    });
    this.wake(runId, "cancel");
    // Rolled back: no driver will pass over it, so stop it now.
    if (!this.supervisor && this.enabled === false) await this.advanceNow(runId);
    return run;
  }

  /** Stops admitting new work; admitted activations keep being observed until they settle. */
  async pause(runId: string): Promise<GraphRun> {
    return this.mutate(runId, (current, at) => {
      if (current.status === "paused") return null;
      if (current.status !== "running" && current.status !== "waiting") {
        throw new GraphRunServiceError("invalid-state", `A ${current.status} run cannot be paused`);
      }
      return transitionGraphRun(current, "paused", at);
    });
  }

  async resume(runId: string): Promise<GraphRun> {
    const run = await this.mutate(runId, (current, at) => {
      if (current.status !== "paused") {
        if (current.status === "running" || current.status === "waiting") return null;
        throw new GraphRunServiceError(
          "invalid-state",
          `A ${current.status} run cannot be resumed`,
        );
      }
      return transitionGraphRun(current, "running", at);
    });
    this.wake(runId, "resume");
    return run;
  }

  /**
   * Reruns one failed node position as a new attempt (item 211; see
   * `graph-run-user-actions.ts`): a `restart` rewind the user requested,
   * saved with its artifact marks in one transaction, then the run is woken.
   */
  async retry(runId: string, activationKey: string): Promise<GraphRun> {
    const artifacts = await this.options.artifacts.list(runId);
    const run = await this.withLock(runId, async () => {
      const current = await this.storage.graphRuns.getGraphRun(runId);
      if (!current) throw new GraphRunServiceError("not-found", "The graph run does not exist");
      const planned = planGraphRunRetry(current, artifacts, activationKey, {
        rewindId: randomUUID(),
        at: this.passDeps.clock().toISOString(),
      });
      if (!planned.ok) throw new GraphRunServiceError(planned.code, planned.message);
      return this.storage.graphRuns.saveGraphRun(planned.run, current.revision, {
        supersede: {
          rewindId: planned.rewind.id,
          artifactIds: planned.rewind.superseded.artifacts,
        },
      });
    });
    this.noteRecord(run);
    this.wake(runId, "explicit");
    return run;
  }

  /** Settles a `waiting` or `ready` activation as `skipped` (item 211) and wakes the run. */
  async skip(runId: string, activationKey: string): Promise<GraphRun> {
    const run = await this.mutate(runId, (current, at) => {
      const planned = planGraphRunSkip(current, activationKey, at);
      if (!planned.ok) throw new GraphRunServiceError(planned.code, planned.message);
      return planned.run;
    });
    this.wake(runId, "explicit");
    return run;
  }

  /**
   * A locked read-modify-write of one admitted activation from outside a pass:
   * an agent's `ask_human` question and its answer (item 204; 208 shares the
   * answer path). `change` returns the next activation, or null for nothing to
   * do; it may not move the activation's state, outputs or identity, and an
   * activation that is no longer admitted is refused. The run is then woken to
   * observe the activation. Returns the stored activation.
   */
  async updateActivation(
    runId: string,
    activationKey: string,
    change: (activation: NodeActivation, run: GraphRun) => NodeActivation | null,
  ): Promise<NodeActivation> {
    let updated: NodeActivation | undefined;
    await this.mutate(runId, (current) => {
      const activation = current.activations.find((entry) => entry.key === activationKey);
      if (!activation) {
        throw new GraphRunServiceError("not-found", "The run has no such activation");
      }
      if (!isGraphActivationAdmitted(activation.state)) {
        throw new GraphRunServiceError(
          "invalid-state",
          `A ${activation.state} activation cannot be changed`,
        );
      }
      const next = change(activation, current);
      if (!next) {
        updated = activation;
        return null;
      }
      if (
        next.key !== activation.key ||
        next.state !== activation.state ||
        JSON.stringify(next.outputs) !== JSON.stringify(activation.outputs)
      ) {
        throw new GraphRunServiceError(
          "invalid-state",
          "Only a pass moves an activation or records its outputs",
        );
      }
      const replaced = replaceGraphActivation(current, activationKey, () => next);
      if (!replaced.ok) throw new GraphRunServiceError("invalid-state", replaced.message);
      updated = next;
      return replaced.run;
    });
    this.requestObservation(runId, activationKey);
    return updated!;
  }

  /**
   * Restarts one activation (item 210): it, everything that depended on it
   * and their artifacts are superseded, and the next pass reruns it with the
   * same inputs as a new attempt. A finished run reopens. A repeated request
   * is a no-op; see `graph-run-rewind.ts` for every rule. Throws a
   * `GraphRunRewindError`.
   */
  async restart(
    runId: string,
    activationKey: string,
    options: GraphRewindOptions = {},
  ): Promise<GraphRunRestartResult> {
    this.requireEnabled();
    return this.afterRewind(await this.rewinds.restart(runId, activationKey, options));
  }

  /** What "Rewind code to here" on an activation would do, and why it cannot now (item 210). */
  async previewCodeRewind(
    runId: string,
    activationKey: string,
  ): Promise<GraphRunCodeRewindPreview> {
    return this.rewinds.previewCodeRewind(runId, activationKey);
  }

  /**
   * Resets the run's worktree to the activation's input commit and restarts
   * it (item 210). `expectedHead` is the HEAD the confirmed preview showed.
   */
  async rewindCode(
    runId: string,
    activationKey: string,
    expectedHead: string,
    options: GraphRewindOptions = {},
  ): Promise<GraphRunRestartResult> {
    this.requireEnabled();
    try {
      return this.afterRewind(
        await this.rewinds.rewindCode(runId, activationKey, expectedHead, options),
      );
    } catch (error) {
      // A journaled rewind whose reset did not finish is stored: schedule it,
      // so the next pass finishes the reset.
      const stored = await this.get(runId).catch(() => null);
      if (stored && graphRunPendingCodeRewind(stored)) this.wake(runId, "explicit");
      throw error;
    }
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new GraphRunRewindError(
        "unavailable",
        "Graph runs are disabled (ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK)",
      );
    }
  }

  private afterRewind(result: GraphRunRestartResult): GraphRunRestartResult {
    this.noteRecord(result.run);
    if (!result.repeated) {
      // Superseded activations hold nothing any more: let waiting work in.
      const environmentId = result.run.environmentId;
      const released = this.workspaceLocks.set(
        result.run.id,
        environmentId,
        graphRunWorkspaceHold(result.run),
      );
      if (released && environmentId) this.passDeps.released(environmentId, result.run.id);
      this.wake(result.run.id, "explicit");
    }
    return result;
  }

  /**
   * Before a pass: finishes a code rewind whose reset a crash interrupted,
   * before a running run plans again. Null (skip the pass; retried in 30 s)
   * while it cannot finish. A paused or stopping run passes as usual.
   */
  private async finishPendingCodeRewind(run: GraphRun): Promise<GraphRun | null> {
    if (!graphRunPendingCodeRewind(run)) return run;
    if (run.status !== "running" && run.status !== "waiting") return run;
    try {
      return await this.rewinds.finishPending(run, { strict: true });
    } catch (error) {
      const code = error instanceof GraphRunRewindError ? error.code : "error";
      console.warn(`[graph-runs] Run ${run.id} waits for its code rewind to finish (${code})`);
      this.memory(run.id).nextDelayMs = GRAPH_RUN_HUMAN_WAIT_MS;
      return null;
    }
  }

  /** Runs a pass now, under the run's lock (explicit commands, tests and benchmarks). */
  async advanceNow(runId: string): Promise<GraphRun | null> {
    return this.pass(runId, { signal: this.stopController.signal });
  }

  // ------------------------------------------------------------ internals

  private memory(runId: string): GraphRunMemory {
    let memory = this.memories.get(runId);
    if (!memory) {
      memory = new GraphRunMemory();
      this.memories.set(runId, memory);
    }
    return memory;
  }

  private forgetRun(runId: string): void {
    this.supervisor?.forget(runId);
    this.memories.delete(runId);
    this.resultKeys.forget(runId);
    this.workspaceLocks.release(runId);
    this.lastStats.delete(runId);
  }

  /** Keeps the keyed index, the result-key index and the locks current after a read or write. */
  private noteRecord(run: GraphRun): void {
    this.resultKeys.note(run);
    if (isGraphRunTerminal(run.status)) {
      this.memories.delete(run.id);
      this.workspaceLocks.release(run.id);
      this.supervisor?.note(run.id, null);
      return;
    }
    this.supervisor?.note(run.id, graphRunObligation(run), graphRunTarget(run));
  }

  private withLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.catch(() => undefined);
    this.locks.set(runId, tail);
    void tail.then(() => {
      if (this.locks.get(runId) === tail) this.locks.delete(runId);
    });
    return run;
  }

  /** A locked read-modify-write of one run; `change` returns null for "nothing to do". */
  private async mutate(
    runId: string,
    change: (run: GraphRun, at: string) => GraphRun | null,
  ): Promise<GraphRun> {
    const run = await this.withLock(runId, async () => {
      const current = await this.storage.graphRuns.getGraphRun(runId);
      if (!current) throw new GraphRunServiceError("not-found", "The graph run does not exist");
      const next = change(current, this.passDeps.clock().toISOString());
      if (!next) return current;
      return this.storage.graphRuns.saveGraphRun(next, current.revision);
    });
    this.noteRecord(run);
    return run;
  }

  private async advancePass(pass: WorkflowPass<GraphRunObligation>): Promise<void> {
    if (this.stopped) return;
    await this.pass(pass.key, {
      signal: pass.signal,
      ...(pass.lease ? { lease: pass.lease } : {}),
      isCurrent: () => pass.isCurrent() && !this.stopped,
    });
  }

  private pass(runId: string, options: GraphRunPassOptions): Promise<GraphRun | null> {
    return this.withLock(runId, async () => {
      if (!this.workspaceSeeded) this.passed.add(runId);
      try {
        const { run, stats } = await runGraphRunPass(this.passDeps, runId, options);
        if (stats) {
          this.lastStats.delete(runId);
          this.lastStats.set(runId, stats);
          // Bounded: the oldest run's counts go first.
          if (this.lastStats.size > MAX_RETAINED_PASS_STATS) {
            this.lastStats.delete(this.lastStats.keys().next().value!);
          }
        }
        if (run) this.noteRecord(run);
        else this.forgetRun(runId);
        return run;
      } catch (error) {
        return this.passFailed(runId, error);
      }
    });
  }

  /**
   * A pass that could not finish. A conflicting save or a fence leaves the
   * key on its cadence; an unreadable record is dropped from scheduling; a
   * record that reached a storage bound fails the run with that bound named.
   */
  private async passFailed(runId: string, error: unknown): Promise<GraphRun | null> {
    if (error instanceof GraphRunPassFencedError) return null;
    if (isGraphStorageError(error, "invalid-run") || isGraphStorageError(error, "newer-format")) {
      console.warn(`[graph-runs] Run ${runId} is unreadable (${error.code}); not scheduled`);
      this.supervisor?.note(runId, null);
      return null;
    }
    if (isGraphStorageError(error, "run-not-found")) {
      this.forgetRun(runId);
      return null;
    }
    const code = error instanceof GraphStorageError ? error.code : "error";
    // A revision conflict carries the revisions as limit/actual, but it is a
    // lost race, not a bound: the next pass starts from the stored record.
    if (
      error instanceof GraphStorageError &&
      error.limit !== undefined &&
      error.code !== "revision-conflict"
    ) {
      const failed = await this.failOnBound(runId, error).catch(() => null);
      if (failed) return failed;
    }
    console.warn(`[graph-runs] Pass over run ${runId} failed (${code})`);
    throw error;
  }

  private async failOnBound(runId: string, error: GraphStorageError): Promise<GraphRun | null> {
    const current = await this.storage.graphRuns.getGraphRun(runId);
    if (!current || isGraphRunTerminal(current.status) || current.status === "cancelling") {
      return current;
    }
    const admitted = current.activations.some((activation) =>
      isGraphActivationAdmitted(activation.state),
    );
    const next = transitionGraphRun(
      current,
      admitted ? "cancelling" : "failed",
      this.passDeps.clock().toISOString(),
      { error: `The run reached its ${error.code} bound`, cause: "budget-exceeded" },
    );
    const saved = await this.storage.graphRuns.saveGraphRun(next, current.revision);
    this.noteRecord(saved);
    return saved;
  }
}
