/**
 * What one system action sees while it runs (item 207): its node, resolved
 * parameters, typed inputs and outputs, and the effect journal.
 *
 * - **Inputs and outputs bind by type** (`system-actions.ts`): `input("workspace@1")`
 *   reads the activation's input of that type after verifying the artifact,
 *   and `output("workspace@1", value)` stores the value on every output port
 *   of that type (none declared: nothing is stored). Outputs carry the
 *   activation's inputs as their lineage.
 * - **Effects** (`effect(key, perform)`) are journaled in the run's effect
 *   rows (`storage-graph-effects.ts`) before they happen: a key already
 *   `done` replays its recorded data and does nothing; an intent left
 *   unsettled by a crash or a stop, or a failed attempt, first asks the
 *   action's probe whether the effect happened. Keys are per run, plus node and iteration
 *   where the effect belongs to one activation slot ({@link slotKey}); never
 *   per attempt, so a retry or a restart of the node finds the same key.
 *   Within one process, effects with the same key run one at a time.
 */
import type { GraphPlanSystemNode } from "@orkestrator/protocol/graphs/compile";
import {
  graphActivationSlot,
  type GraphArtifact,
  type GraphArtifactWorkspace,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import {
  graphSystemActionParams,
  type GraphSystemResolvedParams,
} from "@orkestrator/protocol/graphs/system-actions";
import type { GraphSystemAction } from "@orkestrator/protocol/graphs/template";
import type { GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import type { AgentMailMessage, AgentMailSendInput } from "@orkestrator/protocol/agent-mail";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import type { GraphBranchWorktrees } from "./graph-branch-worktrees.js";
import type { GraphEnvironmentShell } from "./graph-system-environment.js";
import { graphCommandErrorLine } from "./graph-system-environment.js";
import type { Environment, Project } from "./models.js";
import type { AgentMailSender } from "./storage-agent-mail-store.js";
import type { GraphEffectRecord, GraphEffectsStorage } from "./storage-graph-effects.js";
import type { KanbanStorage, StorageService } from "./storage.js";

/** A failure an action reports on purpose, with the cause retries match on. */
export class GraphSystemActionError extends Error {
  constructor(
    message: string,
    readonly failureCause: GraphErrorCause = "system-error",
  ) {
    super(message);
    this.name = "GraphSystemActionError";
  }
}

/** A failure of git, gh or GitHub: retryable as `provider-error`. */
export function graphProviderError(what: string, error: unknown, redact?: readonly string[]) {
  return new GraphSystemActionError(
    `${what}: ${graphCommandErrorLine(error, redact)}`,
    "provider-error",
  );
}

/** Runs backend commands, as the Build Pipeline's `ctx.invoke` does. */
export type GraphSystemInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The slice of the PR monitor `wait-for-checks` and `open-pull-request` use. */
export interface GraphPrMonitorPort {
  /** The monitor's state for an environment; null when it does not monitor it. */
  state(environmentId: string): PrMonitorEnvironmentState | null;
  /** Calls `listener` with the environment id of every announced monitor event. */
  subscribe(listener: (environmentId: string) => void): () => void;
  /** Monitors the environment's stored pull request (`pr_monitor_watch`, normal mode). */
  watch(environmentId: string): Promise<void>;
}

export interface GraphSystemStorage {
  getEnvironment(environmentId: string): Promise<Environment | null>;
  getProject(projectId: string): Promise<Project | null>;
  getRepositoryConfig(projectId: string): Promise<{ prBaseBranch?: string | null }>;
  updateEnvironment: StorageService["updateEnvironment"];
  graphEffects: GraphEffectsStorage;
  kanban: Pick<
    KanbanStorage,
    "getKanbanTasks" | "updateKanbanTask" | "addKanbanComment" | "recordKanbanCriteriaChecks"
  >;
  sendAgentMail(sender: AgentMailSender, input: AgentMailSendInput): Promise<AgentMailMessage>;
}

export interface GraphSystemDependencies {
  storage: GraphSystemStorage;
  invoke: GraphSystemInvoke;
  shell: GraphEnvironmentShell;
  prMonitor: GraphPrMonitorPort;
  /** Flags an activation for observation and wakes its run (`GraphRunService.requestObservation`). */
  requestObservation(runId: string, activationKey: string): void;
  /** This backend process, recorded on every effect intent. */
  owner: string;
  /** How long `start` waits for a job before reporting it running (default 2 s). */
  inlineWaitMs?: number;
  /** Waits between bounded re-reads (mergeability); tests pass an instant one. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Removes isolated branches' worktrees and branches (`select-workspace`, item 403). */
  branchWorktrees?: Pick<GraphBranchWorktrees, "removeWorktrees" | "deleteBranches">;
}

export interface GraphSystemEffectOptions<T> {
  /** Recorded with the intent: what a recovery needs (a run id, a deadline). */
  data?: Record<string, unknown>;
  /**
   * Called when an earlier intent never settled (a crash) or failed: report
   * the effect's data when it already happened, or undefined to act again.
   */
  probe?: (intent: GraphEffectRecord) => Promise<T | undefined>;
}

const effectLocks = new Map<string, Promise<unknown>>();

async function withEffectLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = effectLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  effectLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (effectLocks.get(key) === next) effectLocks.delete(key);
  }
}

export interface GraphSystemActionScope {
  run: Readonly<GraphRun>;
  node: GraphPlanSystemNode;
  activation: Readonly<NodeActivation>;
  environmentId: string;
  artifacts: GraphArtifactStore;
  now(): Date;
}

export class GraphSystemActionContext {
  readonly run: Readonly<GraphRun>;
  readonly node: GraphPlanSystemNode;
  readonly activation: Readonly<NodeActivation>;
  readonly environmentId: string;
  readonly params: GraphSystemResolvedParams;
  /** `node#iter=N[#branch=K]`: the activation without its attempt. */
  readonly slot: string;
  readonly now: () => Date;
  /** Output port → stored artifact id. */
  readonly outputs: Record<string, string> = {};
  private readonly artifacts: GraphArtifactStore;
  private readonly values = new Map<string, unknown>();

  constructor(
    scope: GraphSystemActionScope,
    readonly deps: GraphSystemDependencies,
    readonly signal: AbortSignal,
  ) {
    this.run = scope.run;
    this.node = scope.node;
    this.activation = scope.activation;
    this.environmentId = scope.environmentId;
    this.artifacts = scope.artifacts;
    this.now = scope.now;
    this.params = graphSystemActionParams(scope.node.action, scope.node.params);
    this.slot = graphActivationSlot({
      nodeId: scope.activation.nodeId,
      iteration: scope.activation.iteration,
      ...(scope.activation.branchKey === undefined
        ? {}
        : { branchKey: scope.activation.branchKey }),
    });
  }

  /** An effect key for this activation slot: `<action>:<slot>[:<suffix>]`. */
  slotKey(suffix?: string): string {
    return `${this.node.action}:${this.slot}${suffix === undefined ? "" : `:${suffix}`}`;
  }

  async environment(): Promise<Environment> {
    const environment = await this.deps.storage.getEnvironment(this.environmentId);
    if (!environment) throw new GraphSystemActionError("The run's environment no longer exists");
    if (environment.deletionRequestedAt) {
      throw new GraphSystemActionError("The run's environment is being deleted");
    }
    return environment;
  }

  private inputPort(type: string): string | undefined {
    return this.node.inputs.find((port) => port.type === type)?.name;
  }

  /** Every input artifact id: the lineage of what this action stores. */
  inputArtifactIds(): string[] {
    return Object.values(this.activation.inputs).flatMap((ids) =>
      Array.isArray(ids) ? ids : [ids],
    );
  }

  /** The input of `type`, verified; undefined when the node has none or it was absent. */
  async input<T>(type: string): Promise<T | undefined> {
    const port = this.inputPort(type);
    if (port === undefined) return undefined;
    if (this.values.has(port)) return this.values.get(port) as T;
    const id = this.activation.inputs[port];
    if (id === undefined || Array.isArray(id)) return undefined;
    const artifact = await this.artifacts.requireVerified(this.run.id, id);
    const value = "value" in artifact.body ? artifact.body.value : undefined;
    this.values.set(port, value);
    return value as T | undefined;
  }

  /**
   * The artifacts of a list input of `type` (a fan-in), each verified, in
   * port order; empty when the node has none.
   */
  async inputList(type: string): Promise<GraphArtifact[]> {
    const port = this.inputPort(type);
    if (port === undefined) return [];
    const ids = this.activation.inputs[port];
    const list = ids === undefined ? [] : Array.isArray(ids) ? ids : [ids];
    const artifacts: GraphArtifact[] = [];
    for (const id of list) artifacts.push(await this.artifacts.requireVerified(this.run.id, id));
    return artifacts;
  }

  async requireInput<T>(type: string): Promise<T> {
    const value = await this.input<T>(type);
    if (value === undefined) {
      throw new GraphSystemActionError(`${this.node.id} has no ${type} input`);
    }
    return value;
  }

  /** Whether some output port carries `type`. */
  produces(type: string): boolean {
    return this.node.outputs.some((port) => port.type === type && port.name !== "error");
  }

  /** Stores `value` on every output port of `type`. */
  async output(
    type: string,
    value: unknown,
    options: { workspace?: GraphArtifactWorkspace; itemIds?: readonly string[] } = {},
  ): Promise<void> {
    for (const port of this.node.outputs) {
      if (port.type !== type || port.name === "error") continue;
      const artifact = await this.artifacts.putValue({
        runId: this.run.id,
        type,
        producer: { nodeId: this.node.id, activation: this.activation.key, port: port.name },
        inputs: this.inputArtifactIds(),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(options.itemIds ? { itemIds: options.itemIds } : {}),
        value,
      });
      this.outputs[port.name] = artifact.id;
    }
  }

  /** Seals `contents` as a reference artifact on every output port of `type`. */
  async outputFile(
    type: string,
    contents: Buffer,
    value: unknown,
    options: { extension?: string; workspace?: GraphArtifactWorkspace } = {},
  ): Promise<void> {
    for (const port of this.node.outputs) {
      if (port.type !== type || port.name === "error") continue;
      const artifact = await this.artifacts.putFile({
        runId: this.run.id,
        type,
        producer: { nodeId: this.node.id, activation: this.activation.key, port: port.name },
        inputs: this.inputArtifactIds(),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(options.extension ? { extension: options.extension } : {}),
        contents,
        value,
      });
      this.outputs[port.name] = artifact.id;
    }
  }

  /** The effect journal row of `key`, if any. */
  effectRecord(key: string): Promise<GraphEffectRecord | null> {
    return this.deps.storage.graphEffects.getGraphEffect(this.run.id, key);
  }

  /**
   * Performs a side effect at most once per run and key: records the intent,
   * performs it, records it done with the data `perform` returns, and on a
   * later call replays that data instead (see the module comment).
   */
  async effect<T extends Record<string, unknown>>(
    key: string,
    perform: (intent: GraphEffectRecord) => Promise<T>,
    options: GraphSystemEffectOptions<T> = {},
  ): Promise<T> {
    const journal = this.deps.storage.graphEffects;
    return withEffectLock(`${this.run.id}\0${key}`, async () => {
      const begun = await journal.beginGraphEffect({
        runId: this.run.id,
        key,
        action: this.node.action,
        nodeId: this.node.id,
        activation: this.activation.key,
        owner: this.deps.owner,
        ...(options.data ? { data: options.data } : {}),
      });
      if (begun.previous === "done") return (begun.record.data ?? {}) as T;
      if ((begun.previous === "intended" || begun.previous === "failed") && options.probe) {
        const probed = await options.probe(begun.record);
        if (probed !== undefined) {
          await journal.settleGraphEffect(this.run.id, key, { state: "done", data: probed });
          return probed;
        }
      }
      let result: T;
      try {
        result = await perform(begun.record);
      } catch (error) {
        // Stopped (cancel or shutdown): whether it happened is unknown, so the
        // intent stays open and the next attempt probes or joins it.
        if (this.signal.aborted) throw error;
        await journal
          .settleGraphEffect(this.run.id, key, {
            state: "failed",
            error: error instanceof Error ? error.message : "The effect failed",
          })
          .catch(() => undefined);
        throw error;
      }
      await journal.settleGraphEffect(this.run.id, key, { state: "done", data: result });
      return result;
    });
  }

  /** Waits `ms` unless aborted. */
  sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms, this.signal);
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  throwIfAborted(): void {
    if (this.signal.aborted) throw new GraphSystemActionError("The activation was stopped");
  }
}

/** A waiting action's verdict on one call. */
export type GraphSystemWaitResult =
  | { state: "complete" }
  | {
      state: "waiting";
      /** When to look again without being woken; null: only when woken. */
      observeAfterMs: number | null;
      /** Wake the activation on every PR monitor event for this environment. */
      watchEnvironment?: string;
    };

/** One system action (`graph-node-system.ts` runs it). */
export interface GraphSystemActionHandler {
  readonly action: GraphSystemAction;
  /**
   * Work that runs once as a background job: `start` launches it, `observe`
   * reports it when it settles. Outputs go through `ctx.output`; a thrown
   * {@link GraphSystemActionError} fails the activation with its cause.
   */
  run?(ctx: GraphSystemActionContext): Promise<void>;
  /** Work re-evaluated on every call until it completes (`wait-for-checks`). */
  wait?(ctx: GraphSystemActionContext): Promise<GraphSystemWaitResult>;
  /** Best-effort stop of work the action left running in the environment. */
  cancel?(ctx: GraphSystemActionContext): Promise<void>;
}
