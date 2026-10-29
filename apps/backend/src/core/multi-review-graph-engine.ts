/**
 * Multi Review on the graph runtime (item 301, plan Phase 3, D5).
 *
 * `MultiReviewService` stays the one owner of Multi Review records and the
 * one entry point every launch surface calls (the launch dialog, the
 * coordinator's `launch_multi_review` and start tools, the CLI's `review
 * launch`). When the engine setting selects `graph`, the service records an
 * `engine: "graph"` workflow and hands it here: this module launches a graph
 * run of the built-in Multi Review template (`multi-review-graph-template.ts`)
 * bound from the workflow's own launch input, and projects that run back
 * onto the record (`multi-review-graph-projection.ts`) on every pass.
 *
 * Bindings follow the bespoke engine's sessions:
 *
 * | Role | Bound to |
 * | --- | --- |
 * | `preparer` | `reviewModel`, else `fixModel` (the bespoke preparation session) |
 * | `reviewer` | the reviewers, in order, each with its lens |
 * | `consolidator` | `consolidationModel`, else the preparer |
 * | `fixer` | `fixModel` |
 * | `describer` | the saved pull request default (the bespoke PR tab's) |
 *
 * Parameters: `autoFix`, `autoPr`, `targetBranch` and `reviewInstruction`.
 * The run id is derived from the workflow id (`multi-review-<id>`), so a
 * launch retried after a crash finds the run it created.
 *
 * Logs carry ids and codes only.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { GraphLaunchResult } from "@orkestrator/protocol/graphs/launch";
import type { GraphModelBinding, GraphRun } from "@orkestrator/protocol/graphs/run";
import {
  MULTI_REVIEW_ENGINE_ENV,
  resolveMultiReviewEngine,
  type MultiReviewEngine,
  type MultiReviewModelSelection,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { GraphRunLaunchService } from "./graph-run-launch.js";
import type { GraphRunService } from "./graph-run-service.js";
import {
  MULTI_REVIEW_GRAPH_INSTRUCTION_PARAM,
  MULTI_REVIEW_GRAPH_TARGET_BRANCH_PARAM,
  multiReviewGraphEngineTemplate,
} from "./multi-review-graph-template.js";
import { projectMultiReviewGraphRun } from "./multi-review-graph-projection.js";
import type { GraphRunsStorage } from "./storage-graph-runs.js";

/** Prefix of every graph run a Multi Review launches; the rest is the workflow id. */
export const MULTI_REVIEW_GRAPH_RUN_PREFIX = "multi-review-";

export function multiReviewGraphRunId(workflowId: string): string {
  return `${MULTI_REVIEW_GRAPH_RUN_PREFIX}${workflowId}`;
}

/** The workflow a graph run belongs to, or undefined for any other run. */
export function multiReviewWorkflowIdOfRun(runId: string): string | undefined {
  return runId.startsWith(MULTI_REVIEW_GRAPH_RUN_PREFIX) &&
    runId.length > MULTI_REVIEW_GRAPH_RUN_PREFIX.length
    ? runId.slice(MULTI_REVIEW_GRAPH_RUN_PREFIX.length)
    : undefined;
}

/**
 * The engine a new review starts on: `ORKESTRATOR_MULTI_REVIEW_ENGINE` when
 * it names one (testing), else the app setting `multiReviewEngine`, else
 * bespoke.
 */
export function configuredMultiReviewEngine(
  setting: unknown,
  env: Record<string, string | undefined> = process.env,
): MultiReviewEngine {
  return resolveMultiReviewEngine(setting, env[MULTI_REVIEW_ENGINE_ENV]);
}

/** A refused or failed graph launch; the message carries no content. */
export class MultiReviewGraphEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiReviewGraphEngineError";
  }
}

export interface MultiReviewGraphEngineDependencies {
  launches: Pick<GraphRunLaunchService, "launchInline">;
  runs: Pick<GraphRunService, "get" | "cancel">;
  storage: { graphRuns: Pick<GraphRunsStorage, "getGraphArtifact"> };
}

function binding(selection: MultiReviewModelSelection): GraphModelBinding {
  return {
    platform: selection.agent as AgentPlatform,
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.reasoningEffort !== undefined
      ? { reasoningEffort: selection.reasoningEffort }
      : {}),
    ...(selection.fastMode !== undefined ? { fastMode: selection.fastMode } : {}),
    ...(selection.lens
      ? { lens: { label: selection.lens.label, instruction: selection.lens.instruction } }
      : {}),
  };
}

/** The role bindings a workflow's launch input gives the template. */
export function multiReviewGraphRoles(
  workflow: Pick<
    MultiReviewWorkflow,
    "reviewers" | "reviewModel" | "consolidationModel" | "fixModel"
  >,
): Record<string, GraphModelBinding | GraphModelBinding[]> {
  const preparer = workflow.reviewModel ?? workflow.fixModel;
  return {
    preparer: binding(preparer),
    reviewer: workflow.reviewers.map((reviewer) => binding(reviewer)),
    consolidator: binding(workflow.consolidationModel ?? preparer),
    fixer: binding(workflow.fixModel),
  };
}

/** The parameter values a workflow's launch input gives the template. */
export function multiReviewGraphParams(
  workflow: Pick<MultiReviewWorkflow, "autoFix" | "autoPr" | "targetBranch" | "reviewInstruction">,
): Record<string, string | boolean> {
  return {
    autoFix: workflow.autoFix === true,
    autoPr: workflow.autoPr === true,
    [MULTI_REVIEW_GRAPH_TARGET_BRANCH_PARAM]: workflow.targetBranch,
    [MULTI_REVIEW_GRAPH_INSTRUCTION_PARAM]: workflow.reviewInstruction ?? "",
  };
}

export class MultiReviewGraphEngine {
  constructor(private readonly deps: MultiReviewGraphEngineDependencies) {}

  /**
   * Launches (or finds) the workflow's graph run on its own environment.
   * Throws {@link MultiReviewGraphEngineError} with the launch's own reason
   * when the run cannot start (a provider below a floor, a disabled provider,
   * an environment without a readable HEAD).
   */
  async launch(workflow: MultiReviewWorkflow): Promise<GraphLaunchResult> {
    try {
      return await this.deps.launches.launchInline(
        {
          ref: { scope: "builtin", id: "multi-review" },
          projectId: workflow.projectId,
          environment: { kind: "existing", environmentId: workflow.environmentId },
          roles: multiReviewGraphRoles(workflow),
          params: multiReviewGraphParams(workflow),
        },
        multiReviewGraphEngineTemplate({ targetBranch: workflow.targetBranch }),
        workflow.graphRun?.runId ?? multiReviewGraphRunId(workflow.id),
        { requestedBy: "user" },
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw new MultiReviewGraphEngineError(
        `The graph runtime could not start this Multi Review${typeof code === "string" ? ` (${code})` : ""}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  run(runId: string): Promise<GraphRun | null> {
    return this.deps.runs.get(runId);
  }

  async cancel(runId: string): Promise<void> {
    await this.deps.runs.cancel(runId);
  }

  /** The record for the run's current revision (`multi-review-graph-projection.ts`). */
  project(workflow: MultiReviewWorkflow, run: GraphRun): Promise<MultiReviewWorkflow> {
    return projectMultiReviewGraphRun(workflow, run, (artifactId) =>
      this.deps.storage.graphRuns.getGraphArtifact(run.id, artifactId),
    );
  }
}

// ---------------------------------------------------------------- passes

/** What a graph pass borrows from `MultiReviewService`: its lease, save and release. */
export interface MultiReviewGraphPassHost {
  engine(): MultiReviewGraphEngine | null;
  loadControlled(
    workflowId: string,
  ): Promise<{ workflow: MultiReviewWorkflow; token: string } | null>;
  save(workflow: MultiReviewWorkflow, token: string): Promise<MultiReviewWorkflow>;
  release(workflow: MultiReviewWorkflow, token: string): Promise<void>;
  /**
   * Run id → the revision this process last projected with nothing to save.
   * Process-local: a restart re-projects once.
   */
  projected: Map<string, number>;
}

/** Fields a projection never decides: bookkeeping the service owns. */
const UNPROJECTED_FIELDS = ["updatedAt", "backendRevision", "controllerFence"] as const;

function projectionKey(workflow: MultiReviewWorkflow): string {
  const copy: Partial<MultiReviewWorkflow> = { ...workflow };
  for (const field of UNPROJECTED_FIELDS) delete copy[field];
  if (copy.graphRun) copy.graphRun = { ...copy.graphRun, projectedRevision: 0 };
  return JSON.stringify(copy);
}

/**
 * One supervision pass over a graph-engine review whose run has not settled.
 *
 * Reads the run by id (never the whole store). A run at the revision the
 * record was projected from costs that one read: no lease, no artifact read,
 * no save. Otherwise the record is projected under the controller lease and
 * saved once, only when something it shows changed. A record whose run does
 * not exist yet (a crash between the record and the launch) launches it under
 * the same run id; a launch that is refused fails the review with the
 * launch's reason and settles it.
 */
export async function advanceMultiReviewGraph(
  host: MultiReviewGraphPassHost,
  stored: MultiReviewWorkflow,
): Promise<void> {
  const engine = host.engine();
  const runId = stored.graphRun?.runId;
  if (!engine || !runId) return;
  let run = await engine.run(runId);
  if (
    run &&
    (run.revision === stored.graphRun?.projectedRevision ||
      run.revision === host.projected.get(runId))
  ) {
    return;
  }
  const controlled = await host.loadControlled(stored.id);
  if (!controlled) return;
  const { workflow, token } = controlled;
  if (workflow.engine !== "graph" || workflow.graphRun?.settled) return;
  if (!run) {
    if (workflow.phase === "cancelling") {
      // Cancelled before its run existed: nothing to stop.
      workflow.phase = "cancelled";
      delete workflow.cancellingSince;
      workflow.graphRun = { runId, settled: true };
      await host.save(workflow, token);
      await host.release(workflow, token);
      return;
    }
    try {
      await engine.launch(workflow);
    } catch (error) {
      workflow.phase = "failed";
      workflow.error = (
        error instanceof Error ? error.message : "The graph run did not start"
      ).slice(0, 4_096);
      workflow.graphRun = { runId, settled: true };
      console.warn(`[multi-review] Graph run ${runId} did not start for workflow ${workflow.id}`);
      await host.save(workflow, token);
      await host.release(workflow, token);
      return;
    }
    run = await engine.run(runId);
    if (!run) return;
  }
  const next = await engine.project(workflow, run);
  if (projectionKey(next) === projectionKey(workflow)) {
    // Nothing the record shows changed; remember the revision only when that
    // ends the projection, so an unchanged run costs one read per pass.
    if (!next.graphRun?.settled) {
      host.projected.set(runId, run.revision);
      return;
    }
  }
  host.projected.delete(runId);
  const saved = await host.save(next, token);
  if (saved.graphRun?.settled) await host.release(saved, token);
}
