import {
  restartControllerBuildPipelineStepCommand,
  restartCoordinatorBuildPipelineStepCommand,
} from "@orkestrator/protocol/contract/domains/coordinator";
import { createHash } from "node:crypto";
import {
  isBuildPipelineRestartSelection,
  type BuildPipelineRestartSelection,
} from "@orkestrator/protocol/build-pipeline-restart-selection";
import { pipelineWorkerSessionKey } from "@orkestrator/protocol/pipeline-worker-mail";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import {
  coordinatorNodeTarget,
  RETRY_SAME_REQUEST,
  withRetryAdvice,
  type CoordinatorNodeTarget,
} from "./commands-registry-coordinator-nodes.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  coordinatorCaller,
  withCoordinatorReceipt,
  type CoordinatorCaller,
} from "./coordinator-action-scope.js";
import { assertCoordinatorMayControlWorkflow } from "./coordinator-environment-scope.js";
import { optionalText, surfaceRecord as record } from "./worker-surface-runs.js";

/**
 * Backend commands behind the coordinator's `restart_build_pipeline_step`:
 * restart the step a build pipeline failed in (or its current step, or one
 * named step), keeping every earlier round, as the UI's Restart and
 * "Restart in…" do. Code rewind and skipping a step stay user actions.
 *
 * `restart_coordinator_build_pipeline_step` takes the authenticated `scope`
 * and keeps the coordinator's receipt, so the same `requestId` never restarts
 * twice. With `nodeId` the pipeline is on a connected node, which restarts it
 * through its node-link-only `restart_controller_build_pipeline_step` under
 * its own receipt, keyed from this one, so a retry after a lost answer
 * replays there too. A node too old to have that command is refused with an
 * "update it" message by the node target.
 */

type JsonRecord = Record<string, unknown>;

/** The receipt replays this result; keep it far below its byte cap. */
const MAX_ERROR_CHARS = 1_000;

function requestKey(caller: CoordinatorCaller, requestId: string): string {
  return createHash("sha256")
    .update(`${caller.coordinatorId}\0${requestId}`)
    .digest("hex")
    .slice(0, 24);
}

/** The connected node `nodeId` names; none for this node, even by its own ID. */
async function remoteNode(
  context: CommandContext,
  caller: CoordinatorCaller,
  nodeId: string | undefined,
): Promise<CoordinatorNodeTarget | undefined> {
  return nodeId && (await context.nodes?.status())?.nodeId !== nodeId
    ? coordinatorNodeTarget(context, caller.projectId, nodeId)
    : undefined;
}

interface RestartInput {
  pipelineId: string;
  /** A session key, provider session ID, `validation:` or `review-package:` stage ID. */
  stageId?: string;
  selection?: BuildPipelineRestartSelection;
}

function restartInput(input: JsonRecord): RestartInput {
  const pipelineId = asNonBlankString(input.pipelineId, "pipelineId").trim();
  const step = optionalText(input.stepId, "stepId", 300);
  // A worker address names its session key; any other form is a stage ID.
  const stageId = step ? (pipelineWorkerSessionKey(step) ?? step) : undefined;
  if (input.selection !== undefined && !isBuildPipelineRestartSelection(input.selection)) {
    throw new Error(
      "Invalid selection: give agent and model, and optionally reasoningEffort and fastMode.",
    );
  }
  return {
    pipelineId,
    ...(stageId ? { stageId } : {}),
    ...(input.selection ? { selection: input.selection as BuildPipelineRestartSelection } : {}),
  };
}

/** Refuses a pipeline that does not exist or belongs to another project. */
async function requireProjectPipeline(
  context: CommandContext,
  projectId: string,
  pipelineId: string,
): Promise<void> {
  const persisted = await context.storage.getBuildPipeline(pipelineId);
  if (persisted?.projectId !== projectId) {
    throw new Error("Build pipeline not found in this project");
  }
}

/** Restart on this node, after the project check. Content-free, bounded result. */
async function restartHere(
  context: CommandContext,
  projectId: string,
  input: RestartInput,
  requestId: string,
): Promise<JsonRecord> {
  if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
  await requireProjectPipeline(context, projectId, input.pipelineId);
  const { pipeline, step, alreadyRestarted } = await context.buildPipelines.restartForCoordinator(
    input.pipelineId,
    input.stageId,
    input.selection,
    requestId,
  );
  return {
    pipelineId: pipeline.id,
    restarted: !alreadyRestarted,
    ...(alreadyRestarted ? { alreadyRestarted: true } : {}),
    step,
    ...(input.selection ? { selection: input.selection } : {}),
    // The supervisor has already run once: a step that fails again at once
    // (the same usage limit, say) shows here rather than only in a later wake.
    phase: pipeline.phase,
    ...(pipeline.phase === "failed" && pipeline.error
      ? { error: pipeline.error.slice(0, MAX_ERROR_CHARS) }
      : {}),
  };
}

/**
 * A failed pipeline's follow already sent its terminal notice and stopped
 * observing. Reopen this coordinator's follows of the pipeline, so its next
 * outcome (completion, another failure, a pause that needs a decision) wakes
 * the coordinator as the first one did. Returns whether any follow exists.
 */
async function reopenPipelineFollows(
  context: CommandContext,
  caller: CoordinatorCaller,
  pipelineId: string,
  nodeId: string | undefined,
  episode: string,
): Promise<boolean> {
  const follows = (
    await context.storage.coordinators.listCoordinatorWorkflowAssociations(caller.projectId)
  ).filter(
    (association) =>
      association.kind === "build-pipeline" &&
      association.resourceId === pipelineId &&
      association.coordinatorId === caller.coordinatorId &&
      association.nodeId === nodeId &&
      !association.pending,
  );
  for (const follow of follows) {
    await context.storage.coordinators.updateCoordinatorWorkflowAssociation(
      follow.id,
      (association) => {
        if (association.statusWakeEpisode === episode) return false;
        association.statusWakeEpisode = episode;
        delete association.terminalNotifiedAt;
        delete association.environmentCreationSettledAt;
        delete association.lastNotifiedRevision;
        delete association.statusNotice;
        return true;
      },
    );
  }
  if (follows.length > 0) {
    await context.coordinators?.statusWakes
      .observeWorkflow("build-pipeline", pipelineId, nodeId)
      .catch(() => undefined);
  }
  return follows.length > 0;
}

export function registerCoordinatorPipelineStepActions(register: CommandRegistrar): void {
  register(restartCoordinatorBuildPipelineStepCommand, async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the restart input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const restart = restartInput(input);
    const remote = await remoteNode(context, caller, optionalText(input.nodeId, "nodeId", 200));
    const saved = remote
      ? await remote.call<{ snapshot?: { projectId?: string; environmentId?: string } }>(
          "get_build_pipeline",
          { pipelineId: restart.pipelineId },
        )
      : await context.storage.getBuildPipeline(restart.pipelineId);
    const snapshot = saved?.snapshot as { projectId?: string; environmentId?: string } | undefined;
    if (snapshot?.projectId !== (remote?.projectId ?? caller.projectId))
      throw new Error("Build pipeline not found in this project");
    await assertCoordinatorMayControlWorkflow(
      context,
      caller,
      {
        kind: "build-pipeline",
        resourceId: restart.pipelineId,
        environmentId: snapshot.environmentId,
      },
      remote,
    );
    return withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "restart-pipeline-step",
        payload: { ...restart, ...(remote ? { nodeId: remote.nodeId } : {}) },
      },
      async () => {
        let result: JsonRecord;
        if (remote) {
          const launch = {
            projectId: remote.projectId,
            pipelineId: restart.pipelineId,
            stepId: restart.stageId,
            selection: restart.selection,
            requestId: `coordinator-restart:${requestKey(caller, requestId)}`,
          };
          result = {
            ...(await withRetryAdvice(RETRY_SAME_REQUEST, () =>
              remote.call<JsonRecord>(
                "restart_controller_build_pipeline_step",
                launch,
                launch.requestId,
              ),
            )),
            nodeId: remote.nodeId,
          };
        } else {
          result = await restartHere(
            context,
            caller.projectId,
            restart,
            requestKey(caller, requestId),
          );
        }
        const followed = await reopenPipelineFollows(
          context,
          caller,
          restart.pipelineId,
          remote?.nodeId,
          requestKey(caller, requestId),
        );
        return { ...result, followed };
      },
    );
  });

  /**
   * The same restart on the node that owns the pipeline, for a command node's
   * coordinator. Node-link only (never a workspace grant); the command node
   * checks its scope and keeps the coordinator's receipt, and this receipt
   * makes a resent request replay instead of restarting again.
   */
  register(restartControllerBuildPipelineStepCommand, async (args, context) => {
    const projectId = asNonBlankString(args.projectId, "projectId");
    const requestId = asNonBlankString(args.requestId, "requestId");
    const restart = restartInput(args);
    await requireProjectPipeline(context, projectId, restart.pipelineId);
    return withCoordinatorReceipt(
      context,
      {
        projectId,
        coordinatorId: `pipeline:${restart.pipelineId}`,
        conversationId: "controller",
      },
      { requestId, action: "restart-pipeline-step", payload: restart },
      () => restartHere(context, projectId, restart, requestId),
    );
  });
}
