/**
 * Restart and code rewind of graph runs (plan P2.10, D8, report §8.5).
 *
 * **Restart** a node's activation: it, every activation that transitively
 * consumed its artifacts (or read its position: gate consumers, skipped
 * nodes, later loop iterations) and those artifacts are superseded, in one
 * compare-and-swap save of the record that also marks the artifacts
 * (`graphRestartScope`, `applyGraphRewind`, `saveGraphRun(…, {supersede})`).
 * Admitted activations in that set are stopped first through their
 * executor's `cancel` (`restarted`). The next pass's ready set recreates the
 * superseded positions with the next attempt, so the node reruns on the
 * same inputs (its upstream is untouched) with a fresh session; inside a loop
 * the counter rewinds to the node's iteration and carried inputs come from
 * the previous iteration's live artifacts. Independent branches are kept.
 *
 * **Code rewind** resets the worktree to the commit of the node's input
 * `workspace@1` artifact, then restarts the node. It reuses the pipeline's
 * Git side (`workspace-code-rewind.ts`): the preview of what the reset drops,
 * its refusals, the backup ref and the reset. The rewind is journaled with
 * `GraphRewind.code {headRef, from, backupRef, upstream,
 * upstreamCommitsDropped, pending}` before Git changes, so the next push of
 * the run's branch knows to force with lease once (`graphForcePushRewind`,
 * item 207), and a crash between the save and the reset is finished before
 * the run plans again ({@link GraphRunRewinds.finishPending}).
 *
 * ## Rules
 *
 * - A repeated request is a no-op: the same `requestId` (the rewind's id),
 *   or, without one, a request naming the activation the newest rewind of the
 *   same kind superseded (a double click). Restarting any other superseded
 *   activation, or an attempt a later attempt replaced, is refused.
 * - Run status, as the pipeline's restart: a running, waiting or paused run
 *   restarts and runs (a restart is an explicit instruction to keep going);
 *   a complete, failed or cancelled run reopens to `running` (its finish
 *   time, error and cancel request are cleared); a run provisioning or
 *   `cancelling` refuses.
 * - A code rewind also needs a quiet workspace: the run paused or finished,
 *   no admitted activation, no other pipeline or graph run writing to the
 *   environment, a clean worktree whose HEAD is the one the preview showed,
 *   a target that is an ancestor of HEAD, and no commit of a node outside the
 *   restart among the commits it drops. A mock run never changes code.
 * - Both refuse once the run's pull request was merged, and after
 *   {@link GRAPH_RUN_BOUNDS.maxRewinds} rewinds.
 *
 * Logs carry run ids, codes and counts only.
 */
import { randomUUID } from "node:crypto";
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_COMMIT_PATTERN,
  GRAPH_RUN_BOUNDS,
  GRAPH_RUN_ID_PATTERN,
  GRAPH_RUN_INPUT_PRODUCER,
  applyGraphRewind,
  graphBranchBinding,
  graphActivationBranch,
  graphRunActivation,
  type GraphArtifact,
  type GraphRewind,
  type GraphRewindCode,
  type GraphRewindKind,
  type GraphRewindRequester,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import {
  GRAPH_CODE_REWIND_PREVIEW_PATHS,
  GRAPH_REWIND_PREVIEW_NODES,
  graphRestartScope,
  graphRunCodeRewindBlocker,
  graphRunRestartBlocker,
  type GraphRestartScope,
  type GraphRunCodeRewindPreview,
  type GraphRunRestartResult,
} from "@orkestrator/protocol/graphs/run-rewind";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import {
  GraphActivationJournalFenceError,
  type GraphActivationReport,
  type GraphExecutorContext,
  type GraphNodeExecutorRegistry,
} from "./graph-run-executors.js";
import {
  applyGraphActivationReport,
  isGraphActivationAdmitted,
  settleGraphActivation,
  transitionGraphRun,
} from "./graph-run-transitions.js";
import type { Environment } from "./models.js";
import type { GraphRunsStorage } from "./storage-graph-runs.js";
import {
  codeRewindRefComponent,
  inspectCodeRewind,
  readWorktreeForRewind,
  resetWorktreeToCommit,
  type EnvironmentGit,
} from "./workspace-code-rewind.js";

/** Cancel calls per admitted activation before a restart supersedes it regardless. */
export const GRAPH_RESTART_CANCEL_ATTEMPTS = 3;
/** Wait between unconfirmed cancel calls. */
const CANCEL_RETRY_MS = 250;
/** Commits of nodes outside the restart a code rewind checks it would not drop. */
const MAX_INDEPENDENT_COMMIT_CHECKS = 16;

export type GraphRunRewindErrorCode =
  | "not-found"
  /** The request is malformed, or a request id was used for another rewind. */
  | "invalid-request"
  /** The run, the activation or the workspace does not allow it now (the message says why). */
  | "invalid-state"
  /** The run reached a bound (50 rewinds). */
  | "limit"
  /** Graph runs or code rewinds are not available on this backend. */
  | "unavailable";

export class GraphRunRewindError extends Error {
  constructor(
    readonly code: GraphRunRewindErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GraphRunRewindError";
  }
}

export interface GraphRewindOptions {
  /** The rewind's id; repeating it is a no-op. Defaults to a fresh UUID. */
  requestId?: string;
  requestedBy?: GraphRewindRequester;
}

export interface GraphRunRewindDependencies {
  storage: Pick<GraphRunsStorage, "getGraphRun" | "saveGraphRun" | "listGraphArtifacts">;
  artifacts: GraphArtifactStore;
  executors: GraphNodeExecutorRegistry;
  clock(): Date;
  /** Runs `operation` under the run's lock (the service's, shared with passes). */
  locked<T>(runId: string, operation: () => Promise<T>): Promise<T>;
  /** Aborted when the backend stops. */
  signal(): AbortSignal;
  wake(runId: string): void;
  /** The environment, for its pull request state. */
  environment?(environmentId: string): Promise<Environment | null>;
  /** Git in the environment's worktree; absent: code rewinds are unavailable. */
  git?: EnvironmentGit;
  /**
   * Holds the environment exclusively while a reset commits and refuses when
   * another workflow may write to it (`withWorkspaceCodeRewindReservation`).
   * Absent: the operation runs as is (tests).
   */
  reserve?<T>(run: GraphRun, operation: () => Promise<T>): Promise<T>;
  /** Wait between unconfirmed cancel calls (tests pass 0). */
  cancelRetryMs?: number;
}

/** The ref that keeps a graph run's pre-rewind tip reachable. */
export function graphCodeRewindBackupRef(runId: string, rewindId: string): string {
  const component = (value: string) => codeRewindRefComponent(value, "run");
  return `refs/orkestrator/graph-run-rewinds/${component(runId)}/${component(rewindId)}`;
}

/** The newest rewind's code when its reset is still to be confirmed. */
export function graphRunPendingCodeRewind(
  run: Pick<GraphRun, "rewinds">,
): (GraphRewindCode & { rewindId: string }) | null {
  const latest = run.rewinds.at(-1);
  return latest?.code?.pending ? { ...latest.code, rewindId: latest.id } : null;
}

/**
 * The run as it continues after a rewind: running. A finished run reopens
 * (finish time, error and cancel request cleared); this is the one move out
 * of a terminal status, and only a rewind makes it.
 */
export function reopenGraphRunForRewind(run: GraphRun, at: string): GraphRun {
  if (run.status === "running") return run;
  if (run.status === "waiting" || run.status === "paused") {
    return transitionGraphRun(run, "running", at);
  }
  if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
    const {
      finishedAt: _finishedAt,
      error: _error,
      errorCause: _errorCause,
      cancelRequestedAt: _cancelRequestedAt,
      ...rest
    } = run;
    return { ...rest, status: "running", startedAt: run.startedAt ?? at };
  }
  throw new GraphRunRewindError("invalid-state", `A ${run.status} run cannot be restarted`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function invalidState(message: string): GraphRunRewindError {
  return new GraphRunRewindError("invalid-state", message);
}

function workspaceHead(artifact: GraphArtifact | null): string | undefined {
  if (!artifact) return undefined;
  const body = artifact.body as { value?: unknown };
  const value = body.value as { headRef?: unknown } | undefined;
  const head = typeof value?.headRef === "string" ? value.headRef : artifact.workspace?.headRef;
  return head !== undefined && GRAPH_COMMIT_PATTERN.test(head) ? head : undefined;
}

export class GraphRunRewinds {
  constructor(private readonly deps: GraphRunRewindDependencies) {}

  // ------------------------------------------------------------ restart

  /** Restarts one activation (see the module comment). Returns the stored run and the rewind. */
  async restart(
    runId: string,
    activationKey: string,
    options: GraphRewindOptions = {},
  ): Promise<GraphRunRestartResult> {
    const requestId = this.requestId(options.requestId);
    return this.deps.locked(runId, async () => {
      const run = await this.finishPending(await this.load(runId), { strict: true });
      const repeated = this.repeated(run, "restart", activationKey, options.requestId);
      if (repeated) return { run, rewind: repeated, repeated: true };
      const blocker = graphRunRestartBlocker(run, activationKey);
      if (blocker) {
        throw new GraphRunRewindError(
          graphRunActivation(run, activationKey) ? "invalid-state" : "not-found",
          blocker,
        );
      }
      await this.assertPullRequestOpen(run);
      const scope = this.scope(
        run,
        await this.deps.storage.listGraphArtifacts(runId),
        activationKey,
      );
      const rewind = this.rewindRecord(run, "restart", activationKey, scope, requestId, options);
      this.checkApplicable(run, rewind);
      const stopped = await this.stopAdmitted(run, scope.activations);
      const saved = await this.deps.storage.saveGraphRun(
        this.applyRewind(stopped, rewind, scope),
        run.revision,
        { supersede: { rewindId: rewind.id, artifactIds: scope.artifacts } },
      );
      this.log("restart", saved, scope);
      return { run: saved, rewind, repeated: false };
    });
  }

  // ------------------------------------------------------------ code rewind

  /**
   * What "Rewind code to here" on `activationKey` would do: the target
   * commit, the commits it drops, the upstream they reach, what reruns, and
   * why it cannot run now, if it cannot. Reads only.
   */
  async previewCodeRewind(
    runId: string,
    activationKey: string,
  ): Promise<GraphRunCodeRewindPreview> {
    const run = await this.load(runId);
    const activation = graphRunActivation(run, activationKey);
    if (!activation) throw new GraphRunRewindError("not-found", "The run has no such activation");
    const preview: GraphRunCodeRewindPreview = {
      runId,
      activationKey,
      nodeId: activation.nodeId,
      iteration: activation.iteration,
      commits: [],
      commitCount: 0,
      supersedes: { activations: 0, artifacts: 0, nodes: [] },
    };
    const blockers: string[] = [];
    const block = (reason: string | undefined) => {
      if (reason) blockers.push(reason);
    };
    if (graphRunPendingCodeRewind(run)) {
      block("The run's previous code rewind has not finished yet.");
    }
    block(graphRunCodeRewindBlocker(run, activationKey));
    const pullRequest = await this.pullRequest(run);
    if (pullRequest) {
      preview.pullRequest = { url: pullRequest.url, state: pullRequest.state };
      if (pullRequest.state === "merged") block(this.mergedMessage());
    }
    const git = this.deps.git;
    if (!git) block("Rewinding code is not available on this backend.");
    const target = await this.targetCommit(run, activation);
    if (typeof target === "string") preview.targetCommit = target;
    else block(target.error);
    const artifacts = await this.deps.storage.listGraphArtifacts(runId);
    const scope =
      activation.state === "superseded" ? null : graphRestartScope(run, artifacts, activationKey);
    if (scope) {
      const rerun = new Set(
        scope.activations.map((key) => graphRunActivation(run, key)?.nodeId ?? ""),
      );
      preview.supersedes = {
        activations: scope.activations.length,
        artifacts: scope.artifacts.length,
        nodes: run.plan.nodes
          .map((node) => node.id)
          .filter((id) => rerun.has(id))
          .slice(0, GRAPH_REWIND_PREVIEW_NODES),
      };
    }
    if (git && run.environmentId && typeof target === "string") {
      try {
        const worktree = await readWorktreeForRewind(
          git,
          run.environmentId,
          GRAPH_CODE_REWIND_PREVIEW_PATHS,
        );
        preview.head = worktree.head;
        if (worktree.dirty) {
          preview.uncommittedPaths = worktree.paths;
          block(
            "The worktree has uncommitted changes, which a reset would destroy. Commit or discard them first.",
          );
        }
        try {
          Object.assign(preview, await inspectCodeRewind(git, run.environmentId, target));
          if (scope) {
            block(await this.droppedIndependentWork(git, run, artifacts, scope, target));
          }
        } catch (error) {
          block(errorText(error));
        }
      } catch (error) {
        block(`The worktree could not be read: ${errorText(error)}.`);
      }
    }
    return blockers.length > 0 ? { ...preview, blocked: blockers[0] } : preview;
  }

  /**
   * Resets the worktree to the commit of `activationKey`'s input
   * `workspace@1` artifact and restarts the activation. Refused unless every
   * rule of the module comment holds and HEAD is still `expectedHead`, the
   * one the user's confirmed preview showed. The old tip stays reachable at
   * {@link graphCodeRewindBackupRef}.
   */
  async rewindCode(
    runId: string,
    activationKey: string,
    expectedHead: string,
    options: GraphRewindOptions = {},
  ): Promise<GraphRunRestartResult> {
    if (!GRAPH_COMMIT_PATTERN.test(expectedHead)) {
      throw new GraphRunRewindError("invalid-request", "expectedHead must be a full commit SHA");
    }
    const requestId = this.requestId(options.requestId);
    const git = this.deps.git;
    if (!git) {
      throw new GraphRunRewindError(
        "unavailable",
        "Rewinding code is not available on this backend.",
      );
    }
    return this.deps.locked(runId, async () => {
      const run = await this.finishPending(await this.load(runId), { strict: true });
      const repeated = this.repeated(
        run,
        "rewind-code",
        activationKey,
        options.requestId,
        expectedHead,
      );
      if (repeated) return { run, rewind: repeated, repeated: true };
      const blocker = graphRunCodeRewindBlocker(run, activationKey);
      if (blocker) {
        throw new GraphRunRewindError(
          graphRunActivation(run, activationKey) ? "invalid-state" : "not-found",
          blocker,
        );
      }
      await this.assertPullRequestOpen(run);
      const environmentId = run.environmentId;
      if (!environmentId) throw invalidState("The run has no environment.");
      const activation = graphRunActivation(run, activationKey)!;
      const target = await this.targetCommit(run, activation);
      if (typeof target !== "string") throw invalidState(target.error);
      const artifacts = await this.deps.storage.listGraphArtifacts(runId);
      const scope = this.scope(run, artifacts, activationKey);
      const base = this.rewindRecord(run, "rewind-code", activationKey, scope, requestId, options);
      this.checkApplicable(run, base);
      return this.reserve(run, async () => {
        const worktree = await readWorktreeForRewind(git, environmentId, 0);
        if (worktree.head !== expectedHead) {
          throw invalidState(
            "The branch moved since the rewind was previewed. Review the commits it drops again.",
          );
        }
        if (worktree.dirty) {
          throw invalidState(
            "The worktree has uncommitted changes, which a reset would destroy. Commit or discard them first.",
          );
        }
        let inspection;
        try {
          inspection = await inspectCodeRewind(git, environmentId, target);
        } catch (error) {
          throw invalidState(`The code could not be rewound: ${errorText(error)}`);
        }
        const dropped = await this.droppedIndependentWork(git, run, artifacts, scope, target);
        if (dropped) throw invalidState(dropped);
        const code: GraphRewindCode = {
          headRef: target,
          from: worktree.head,
          backupRef: graphCodeRewindBackupRef(run.id, base.id),
          ...(inspection.upstream
            ? {
                upstream: inspection.upstream.ref,
                upstreamCommitsDropped: inspection.upstream.droppedCommits,
              }
            : {}),
          pending: true,
        };
        const rewind: GraphRewind = { ...base, code };
        // The journal point: the rewind (with what the next push needs) is
        // durable before Git changes; a crash from here is finished later.
        const journaled = await this.deps.storage.saveGraphRun(
          this.applyRewind(run, rewind, scope),
          run.revision,
          { supersede: { rewindId: rewind.id, artifactIds: scope.artifacts } },
        );
        const saved = await this.completeReset(git, journaled, environmentId);
        this.log("rewind-code", saved, scope);
        return { run: saved, rewind: saved.rewinds.at(-1)!, repeated: false };
      });
    });
  }

  /**
   * Finishes the newest rewind's journaled reset, if one is pending, and
   * returns the stored run. The caller holds the run's lock. Without
   * `strict`, a run that cannot finish now is returned unchanged; with it,
   * that refuses.
   */
  async finishPending(run: GraphRun, options: { strict?: boolean } = {}): Promise<GraphRun> {
    const pending = graphRunPendingCodeRewind(run);
    if (!pending) return run;
    const git = this.deps.git;
    if (!git || !run.environmentId || !pending.from || !pending.backupRef) {
      if (!options.strict) return run;
      throw new GraphRunRewindError(
        "unavailable",
        "The run's previous code rewind cannot be finished on this backend.",
      );
    }
    const environmentId = run.environmentId;
    return this.reserve(run, () => this.completeReset(git, run, environmentId));
  }

  /** Resets to the journaled rewind's target, then clears `pending`. Under the reservation. */
  private async completeReset(
    git: EnvironmentGit,
    run: GraphRun,
    environmentId: string,
  ): Promise<GraphRun> {
    const latest = run.rewinds.at(-1)!;
    const code = latest.code!;
    try {
      await resetWorktreeToCommit(git, environmentId, {
        from: code.from!,
        to: code.headRef,
        backupRef: code.backupRef!,
      });
    } catch (error) {
      console.warn(`[graph-runs] Code rewind ${latest.id} of run ${run.id} is pending`);
      throw invalidState(
        `The rewind is recorded, but the reset did not finish: ${errorText(error)} It is retried before the run continues.`,
      );
    }
    const { pending: _pending, ...settled } = code;
    return this.deps.storage.saveGraphRun(
      { ...run, rewinds: [...run.rewinds.slice(0, -1), { ...latest, code: settled }] },
      run.revision,
    );
  }

  // ------------------------------------------------------------ internals

  private async load(runId: string): Promise<GraphRun> {
    const run = await this.deps.storage.getGraphRun(runId);
    if (!run) throw new GraphRunRewindError("not-found", "The graph run does not exist");
    return run;
  }

  private requestId(requestId: string | undefined): string {
    if (requestId === undefined) return randomUUID();
    if (!GRAPH_RUN_ID_PATTERN.test(requestId)) {
      throw new GraphRunRewindError(
        "invalid-request",
        "requestId must be 1 to 128 letters, digits, '-' or '_'",
      );
    }
    return requestId;
  }

  /** The rewind an identical earlier request recorded, or null (see "Rules"). */
  private repeated(
    run: GraphRun,
    kind: GraphRewindKind,
    activationKey: string,
    requestId: string | undefined,
    expectedHead?: string,
  ): GraphRewind | null {
    if (requestId !== undefined) {
      const existing = run.rewinds.find((rewind) => rewind.id === requestId);
      if (existing) {
        if (existing.kind !== kind || existing.activation !== activationKey) {
          throw new GraphRunRewindError(
            "invalid-request",
            "This request id was already used for another rewind",
          );
        }
        return existing;
      }
    }
    const activation = graphRunActivation(run, activationKey);
    const latest = run.rewinds.at(-1);
    if (
      activation?.state === "superseded" &&
      latest !== undefined &&
      activation.supersededBy === latest.id &&
      latest.activation === activationKey &&
      latest.kind === kind &&
      (kind !== "rewind-code" || latest.code?.from === expectedHead)
    ) {
      return latest;
    }
    return null;
  }

  private scope(
    run: GraphRun,
    artifacts: readonly GraphArtifact[],
    activationKey: string,
  ): GraphRestartScope {
    const scope = graphRestartScope(run, artifacts, activationKey);
    if (!scope) throw invalidState("The activation cannot be restarted");
    return scope;
  }

  private rewindRecord(
    run: GraphRun,
    kind: GraphRewindKind,
    activationKey: string,
    scope: GraphRestartScope,
    id: string,
    options: GraphRewindOptions,
  ): GraphRewind {
    const activation = graphRunActivation(run, activationKey)!;
    return {
      id,
      kind,
      nodeId: activation.nodeId,
      activation: activationKey,
      iteration: activation.iteration,
      requestedAt: this.deps.clock().toISOString(),
      requestedBy: options.requestedBy ?? "user",
      superseded: { activations: [...scope.activations], artifacts: [...scope.artifacts] },
    };
  }

  /** Refuses before anything is stopped or reset: the 51st rewind, a duplicate id. */
  private checkApplicable(run: GraphRun, rewind: GraphRewind): void {
    const applied = applyGraphRewind(run, rewind);
    if (applied.ok) return;
    if (applied.code === "rewinds") {
      throw new GraphRunRewindError(
        "limit",
        `A run allows at most ${GRAPH_RUN_BOUNDS.maxRewinds} restarts and rewinds`,
      );
    }
    throw invalidState(applied.message);
  }

  private applyRewind(run: GraphRun, rewind: GraphRewind, scope: GraphRestartScope): GraphRun {
    const applied = applyGraphRewind(run, rewind);
    if (!applied.ok) throw invalidState(applied.message);
    const loopIterations = { ...applied.run.loopIterations };
    for (const [loop, iteration] of Object.entries(scope.loopIterations)) {
      loopIterations[loop] = Math.min(loopIterations[loop] ?? 1, iteration);
    }
    return reopenGraphRunForRewind(
      { ...applied.run, loopIterations },
      this.deps.clock().toISOString(),
    );
  }

  private async reserve<T>(run: GraphRun, operation: () => Promise<T>): Promise<T> {
    if (!this.deps.reserve) return operation();
    try {
      return await this.deps.reserve(run, operation);
    } catch (error) {
      if (error instanceof GraphRunRewindError) throw error;
      throw invalidState(errorText(error));
    }
  }

  /**
   * Stops the admitted activations among `keys` through their executors'
   * `cancel` (`restarted`) and applies the reports. One that does not
   * confirm after {@link GRAPH_RESTART_CANCEL_ATTEMPTS} calls is settled
   * `cancelled` regardless, as the pass does: the new attempt is
   * authoritative, and a late report of the old one is never applied.
   */
  private async stopAdmitted(run: GraphRun, keys: readonly string[]): Promise<GraphRun> {
    const targets = keys
      .map((key) => graphRunActivation(run, key))
      .filter(
        (activation): activation is NodeActivation =>
          activation !== undefined && isGraphActivationAdmitted(activation.state),
      );
    if (targets.length === 0) return run;
    const reports = await Promise.all(
      targets.map(async (activation) => ({
        activation,
        report: await this.cancel(run, activation),
      })),
    );
    let next = run;
    const at = this.deps.clock().toISOString();
    for (const { activation, report } of reports) {
      const outcome = report ? applyGraphActivationReport(next, activation.key, report, at) : null;
      if (outcome?.ok && !isGraphActivationAdmitted(outcome.activation.state)) {
        next = outcome.run;
        continue;
      }
      next = settleGraphActivation(next, activation.key, "cancelled", at, {
        error: "Stopping the activation for a restart could not be confirmed",
        cause: "system-error",
      });
    }
    return next;
  }

  /** The executor's terminal report for a restart's cancel, or null when unconfirmed. */
  private async cancel(
    run: GraphRun,
    activation: NodeActivation,
  ): Promise<GraphActivationReport | null> {
    const node = run.plan.nodes.find((candidate) => candidate.id === activation.nodeId);
    if (!node) return null;
    const executor = this.deps.executors.resolve(node.kind, { mock: run.mock });
    if (!executor) return { state: "cancelled" };
    const binding = this.binding(run, node, activation);
    const context: GraphExecutorContext = {
      operation: "cancel",
      run,
      node,
      activation,
      ...(binding ? { binding } : {}),
      environmentId: run.environmentId!,
      artifacts: this.deps.artifacts,
      signal: this.deps.signal(),
      wake: () => this.deps.wake(run.id),
      journal: () =>
        Promise.reject(new GraphActivationJournalFenceError("A restart's cancel does not journal")),
      now: () => this.deps.clock(),
    };
    const wait = this.deps.cancelRetryMs ?? CANCEL_RETRY_MS;
    for (let attempt = 0; attempt < GRAPH_RESTART_CANCEL_ATTEMPTS; attempt++) {
      if (attempt > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      let report: GraphActivationReport;
      try {
        report = await executor.cancel(context, "restarted");
      } catch {
        continue;
      }
      if (
        report.state !== "unchanged" &&
        report.state !== "running" &&
        report.state !== "awaiting-human"
      ) {
        return report;
      }
    }
    return null;
  }

  private binding(run: GraphRun, node: GraphPlanNode, activation: NodeActivation) {
    if (node.kind !== "agent") return undefined;
    const branch = graphActivationBranch(run, node, activation);
    return graphBranchBinding(run.bindings.roles, branch?.role ?? node.role, branch);
  }

  /** The commit of the activation's input `workspace@1` artifact, or why there is none. */
  private async targetCommit(
    run: GraphRun,
    activation: NodeActivation,
  ): Promise<string | { error: string }> {
    const node = run.plan.nodes.find((candidate) => candidate.id === activation.nodeId);
    const ids = (node?.inputs ?? [])
      .filter((port) => port.type === "workspace@1" || port.type === "list<workspace@1>")
      .flatMap((port) => {
        const bound = activation.inputs[port.name];
        return bound === undefined ? [] : Array.isArray(bound) ? bound : [bound];
      });
    if (ids.length === 0) {
      return {
        error: "This node had no input commit (workspace@1), so its code cannot be rewound.",
      };
    }
    const heads = new Set<string>();
    for (const id of ids.slice(0, GRAPH_RUN_BOUNDS.maxPortArtifacts)) {
      const artifact = await this.deps.artifacts.get(run.id, id).catch(() => null);
      const head = workspaceHead(artifact);
      if (!head) return { error: "This node's input commit could not be read." };
      heads.add(head);
    }
    if (heads.size > 1) {
      return {
        error: "This node read more than one commit, so there is no single commit to rewind to.",
      };
    }
    return [...heads][0]!;
  }

  /**
   * Why the reset would drop work it must keep, or undefined: a commit a
   * node outside the restart produced (its live `workspace@1` artifact) that
   * HEAD contains and the target does not. Its activation would stay done
   * while its code disappeared.
   */
  private async droppedIndependentWork(
    git: EnvironmentGit,
    run: GraphRun,
    artifacts: readonly GraphArtifact[],
    scope: GraphRestartScope,
    target: string,
  ): Promise<string | undefined> {
    const superseded = new Set(scope.artifacts);
    const heads = new Map<string, string>();
    for (const artifact of artifacts) {
      if (
        artifact.state !== "live" ||
        artifact.type !== "workspace@1" ||
        superseded.has(artifact.id) ||
        artifact.producer.nodeId === GRAPH_RUN_INPUT_PRODUCER
      ) {
        continue;
      }
      const head = workspaceHead(artifact);
      if (head && head !== target && !heads.has(head)) heads.set(head, artifact.producer.nodeId);
    }
    const environmentId = run.environmentId!;
    const count = async (range: string) =>
      Number.parseInt((await git(environmentId, ["rev-list", "--count", range])).trim(), 10);
    for (const [head, nodeId] of [...heads].slice(0, MAX_INDEPENDENT_COMMIT_CHECKS)) {
      try {
        if ((await count(`HEAD..${head}`)) !== 0) continue;
        if ((await count(`${target}..${head}`)) === 0) continue;
      } catch {
        continue;
      }
      return `The reset would drop commits of node ${nodeId}, which does not depend on this node. Rewind to a node both depend on instead.`;
    }
    return undefined;
  }

  /** The pull request this run opened (an `open-pull-request` node that produced one). */
  private async pullRequest(run: GraphRun): Promise<{ url: string; state: string } | null> {
    if (!run.environmentId || !this.deps.environment) return null;
    const opened = run.activations.some((activation) => {
      const node = run.plan.nodes.find((candidate) => candidate.id === activation.nodeId);
      return (
        node?.kind === "system" &&
        node.action === "open-pull-request" &&
        Object.keys(activation.outputs).length > 0
      );
    });
    if (!opened) return null;
    const environment = await this.deps.environment(run.environmentId).catch(() => null);
    if (!environment?.prUrl) return null;
    return { url: environment.prUrl, state: environment.prState ?? "unknown" };
  }

  private mergedMessage(): string {
    return "This run's pull request has been merged. Start a new run for further changes.";
  }

  private async assertPullRequestOpen(run: GraphRun): Promise<void> {
    // Shipping again would open a second pull request for merged work.
    if ((await this.pullRequest(run))?.state === "merged") throw invalidState(this.mergedMessage());
  }

  private log(kind: GraphRewindKind, run: GraphRun, scope: GraphRestartScope): void {
    console.info(
      `[graph-runs] ${kind} of run ${run.id}: ${scope.activations.length} activations, ${scope.artifacts.length} artifacts superseded`,
    );
  }
}
