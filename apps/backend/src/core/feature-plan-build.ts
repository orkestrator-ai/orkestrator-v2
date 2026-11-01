/**
 * Building a planned feature: claim the plan, create its ticket, start the
 * pipeline and record the link, in one backend command.
 *
 * The Features view used to run these as a renderer sequence (add task, claim,
 * start, read the pipeline back from its own store, write the plan) with
 * client-side rollbacks. A renderer that went away mid-sequence left a plan
 * stuck in "building" or an orphan ticket, and its rollback could overwrite
 * the link the build supervisor had already written. Here every step and every
 * compensation runs where the state lives:
 *
 * - A per-plan lock keeps two clicks (or two clients) from creating two tickets.
 * - A plan already linked to a pipeline returns that pipeline.
 * - A plan claimed by an earlier launch that never linked a pipeline (the
 *   backend stopped mid-launch) reuses that claim's ticket; the pipeline's
 *   admission key makes the restart return any build that did start.
 * - When the start fails, the claim is released only while no pipeline is
 *   linked, and the new ticket is deleted only while no pipeline record holds
 *   it.
 *
 * The build runs on Codex unless the caller names another agent: the story
 * prompt (`formatFeatureStoriesForBuild`) tells the agent to use Codex threads
 * and sub-agents, and the build reuses the plan's Codex planning environment
 * (`codexEnvironmentId`). Every other step takes the saved Build defaults.
 */
import { kanbanTaskBuildTicket } from "@orkestrator/protocol/build-pipeline-tickets";
import { isBuildPipeline, type BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  isStartFeaturePlanBuildInput,
  type StartFeaturePlanBuildResult,
} from "@orkestrator/protocol/feature-build";
import { formatFeatureStoriesForBuild } from "@orkestrator/protocol/feature-planning";
import { launchBuildPipeline } from "./build-pipeline-launch.js";
import type { CommandContext } from "./commands-context.js";
import type { FeaturePlan, KanbanTask } from "./storage-shared.js";

type FeaturePlanBuildContext = Pick<CommandContext, "storage" | "buildPipelines">;

/** The agent a feature-plan build runs when the caller names none. */
export const FEATURE_PLAN_BUILD_AGENT = "codex";

export class FeaturePlanBuildConflictError extends Error {
  constructor() {
    super("This feature already has an active build");
    this.name = "FeaturePlanBuildConflictError";
  }
}

const inFlight = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const prior = inFlight.get(key);
  const next = (prior ?? Promise.resolve()).catch(() => undefined).then(action);
  inFlight.set(key, next);
  try {
    return await next;
  } finally {
    if (inFlight.get(key) === next) inFlight.delete(key);
  }
}

async function pipelineSnapshot(
  context: FeaturePlanBuildContext,
  pipelineId: string,
): Promise<BuildPipeline | null> {
  const record = await context.storage.getBuildPipeline(pipelineId);
  if (!record || !isBuildPipeline(record.snapshot)) return null;
  return { ...record.snapshot, backendRevision: record.revision };
}

async function pipelineHoldsTask(
  context: FeaturePlanBuildContext,
  projectId: string,
  taskId: string,
): Promise<boolean> {
  const records = await context.storage.listBuildPipelines(projectId);
  return records.some(
    (record) => (record.snapshot as { taskId?: unknown } | undefined)?.taskId === taskId,
  );
}

async function defaultEnvironmentType(
  context: FeaturePlanBuildContext,
  projectId: string,
): Promise<"local" | "containerized"> {
  const config = await context.storage.loadConfig();
  const project = await context.storage.getProject(projectId);
  return (
    config.repositories[projectId]?.lastEnvironmentType ??
    (project?.localPath ? "local" : "containerized")
  );
}

/** The plan's planning environment, when a build can still reuse it. */
async function reusableEnvironmentId(
  context: FeaturePlanBuildContext,
  plan: FeaturePlan,
): Promise<string | undefined> {
  if (!plan.codexEnvironmentId) return undefined;
  const environment = await context.storage.getEnvironment(plan.codexEnvironmentId);
  return environment &&
    environment.projectId === plan.projectId &&
    !environment.deletionRequestedAt &&
    environment.lifecycleOperation !== "deleting"
    ? environment.id
    : undefined;
}

export async function startFeaturePlanBuild(
  args: unknown,
  context: FeaturePlanBuildContext,
): Promise<StartFeaturePlanBuildResult> {
  if (!isStartFeaturePlanBuildInput(args)) throw new Error("Invalid feature plan build request");
  if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
  const featureId = args.featureId.trim();
  return serialized(featureId, async () => {
    const plan = await context.storage.kanban.getFeaturePlan(featureId);
    if (!plan) throw new Error(`Feature plan not found: ${featureId}`);

    if (plan.buildPipelineId) {
      const existing = await pipelineSnapshot(context, plan.buildPipelineId);
      if (!existing) throw new FeaturePlanBuildConflictError();
      return { featureId, taskId: existing.taskId, pipeline: existing, reused: true };
    }

    // One planning turn at a time per project, and a failed one still needs its
    // retry or dismissal: building now would freeze stories it may yet revise.
    const projectPlans = await context.storage.kanban.getFeaturePlans(plan.projectId);
    if (projectPlans.some((other) => other.planning && other.planning.phase !== "complete")) {
      throw new Error("Finish the project's feature planning before building");
    }

    let task: KanbanTask | null = null;
    let createdTask = false;
    let staleClaim = false;
    if (plan.buildTaskId) {
      // An earlier launch claimed the plan and stopped before linking a
      // pipeline. Its ticket is ours to finish; the admission key returns a
      // pipeline that did start.
      task = await context.storage.kanban.getKanbanTask(plan.buildTaskId);
      if (!task) {
        // The ticket was deleted since, so nothing can finish that claim. Only a
        // pipeline already holding the ticket keeps the plan out of a new build.
        const held = await pipelineHoldsTask(context, plan.projectId, plan.buildTaskId).catch(
          () => true,
        );
        if (held) throw new FeaturePlanBuildConflictError();
        await context.storage.kanban.releaseFeaturePlanBuildClaim(
          featureId,
          plan.buildTaskId,
          "stories",
        );
        staleClaim = true;
      }
    }
    if (!task) {
      if (plan.status === "building" && !staleClaim) throw new FeaturePlanBuildConflictError();
      if (plan.stories.length === 0) throw new Error("The feature has no stories to build");
      const details = formatFeatureStoriesForBuild(plan);
      task = await context.storage.kanban.addKanbanTask(
        plan.projectId,
        details.title,
        details.description,
      );
      createdTask = true;
      const claim = await context.storage.kanban.claimFeaturePlanBuild(featureId, task.id);
      if (!claim.claimed) {
        await context.storage.kanban.deleteKanbanTask(task.id);
        throw new FeaturePlanBuildConflictError();
      }
    }
    // A resume that finds its pipeline already started is the only reuse: one it
    // starts here is a new build, whichever launch made the ticket.
    const alreadyStarted =
      !createdTask &&
      (await pipelineHoldsTask(context, plan.projectId, task.id).catch(() => false));

    try {
      const ticket = kanbanTaskBuildTicket(task);
      const existingEnvironmentId = await reusableEnvironmentId(context, plan);
      const pipeline = await launchBuildPipeline(
        {
          taskId: ticket.id,
          projectId: ticket.projectId,
          environmentType:
            args.environmentType ?? (await defaultEnvironmentType(context, plan.projectId)),
          agentType: args.agentType ?? FEATURE_PLAN_BUILD_AGENT,
          taskTitle: ticket.title,
          taskSnapshot: ticket.taskSnapshot,
          source: ticket.source,
          namingPrompt: ticket.namingPrompt,
          ...(existingEnvironmentId ? { existingEnvironmentId } : {}),
          featurePlanId: featureId,
        },
        context,
      );
      // The supervisor links the plan when it links the source; this records
      // the same values for a pipeline admission returned without relinking.
      await context.storage.kanban.linkFeaturePlanBuild(featureId, task.id, {
        buildPipelineId: pipeline.id,
        ...(pipeline.environmentId ? { environmentId: pipeline.environmentId } : {}),
      });
      return { featureId, taskId: task.id, pipeline, reused: alreadyStarted };
    } catch (error) {
      // A resumed claim stays: its ticket is already on the board, and letting
      // go of it would make the next Build create a second one.
      if (!createdTask) throw error;
      const released = await context.storage.kanban
        .releaseFeaturePlanBuildClaim(featureId, task.id, "stories")
        .catch(() => ({ released: false }));
      if (
        released.released &&
        !(await pipelineHoldsTask(context, plan.projectId, task.id).catch(() => true))
      ) {
        await context.storage.kanban.deleteKanbanTask(task.id).catch(() => undefined);
      }
      throw error;
    }
  });
}
