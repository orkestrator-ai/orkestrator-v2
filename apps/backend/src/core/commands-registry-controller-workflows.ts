import {
  isStartBuildPipelineInput,
  type StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import {
  isLaunchMultiReviewActionInput,
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  isStartMultiReviewInput,
  type MultiReviewActionResult,
  type StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import { COORDINATOR_DELEGATION_PRESENTATION } from "@orkestrator/protocol/review-evidence-frames";

import type { CommandContext } from "./commands-context.js";
import { conciseError } from "./commands-error-text.js";
import { asNonBlankString, stripWorkflowSnapshotSecrets } from "./commands-helpers.js";
import { assertContainerDelegationCommitPublished } from "./commands-registry-coordinator.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  buildPipelineInputWithDefaults,
  multiReviewInputWithDefaults,
  readLaunchModelCatalog,
  savedLaunchSettings,
} from "./coordinator-launch-defaults.js";
import {
  multiReviewButtonStart,
  runMultiReviewSurface,
  startMultiReviewAt,
} from "./coordinator-review-actions.js";
import { launchWorkerPr } from "./coordinator-pr.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { openMultiReviewTab } from "./workflow-tab-actions.js";

/**
 * Workflow actions a command node's coordinator runs on this node.
 *
 * The coordinator, its delegations and its workflow associations live on the
 * command node; these run the work here with this node's saved defaults (its
 * own settings under the command node's inherited ones) and this node's model
 * catalogue, exactly as the button or a local coordinator would. Each one is
 * idempotent for a retried request: an environment by its control request ID,
 * a build by its admission key, a review by the ID the command node reserved.
 *
 * The command node calls them through the node link, which only an attached
 * command node can use.
 */

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function environmentOf(context: CommandContext, environmentId: unknown) {
  const environment = await context.storage.getEnvironment(
    asNonBlankString(environmentId, "environmentId"),
  );
  if (!environment) throw new Error("That environment does not exist on this node.");
  if (isProjectHomeEnvironment(environment)) {
    throw new Error("The project checkout is not a worker environment.");
  }
  return environment;
}

function actionResult(
  workflow: MultiReviewActionResult["workflow"],
  reused: boolean,
  ui: MultiReviewActionResult["ui"],
  recovery?: string,
): MultiReviewActionResult {
  return {
    workflow: stripWorkflowSnapshotSecrets(workflow),
    reused,
    outcome: ui.status === "opened" ? "opened" : "partial",
    ui,
    ...(recovery ? { recovery } : {}),
  };
}

export function registerControllerWorkflowCommands(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "commands">,
): void {
  const running = new Map<string, Promise<unknown>>();
  const serialize = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const prior = running.get(key);
    const next = (prior ?? Promise.resolve()).catch(() => undefined).then(action);
    running.set(key, next);
    try {
      return await next;
    } finally {
      if (running.get(key) === next) running.delete(key);
    }
  };

  register("create_controller_pr", async (args, context) => {
    const targetBranch = args.targetBranch;
    if (
      targetBranch !== undefined &&
      (typeof targetBranch !== "string" || !targetBranch.trim() || targetBranch.length > 500)
    )
      throw new Error("Expected targetBranch of 1-500 characters");
    return launchWorkerPr(context, dependencies, {
      projectId: asNonBlankString(args.projectId, "projectId"),
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      requestId: asNonBlankString(args.requestId, "requestId"),
      ...(typeof targetBranch === "string" ? { targetBranch: targetBranch.trim() } : {}),
    });
  });

  /** A worker environment whose first prompt is shown as the coordinator's delegation. */
  register("create_controller_environment", async (args, context) => {
    if (!record(args.input)) throw new Error("Expected input.");
    const controlRequestId = asNonBlankString(args.controlRequestId, "controlRequestId");
    const input = args.input;
    // A container is made from the remote: its base commit must be published,
    // as for a coordinator's container worker on its own node.
    if (
      input.environmentType === "containerized" &&
      typeof input.projectId === "string" &&
      typeof input.delegationBaseCommit === "string"
    ) {
      await assertContainerDelegationCommitPublished(
        context,
        input.projectId,
        input.delegationBaseCommit,
      );
    }
    const create = dependencies.commands.get("create_environment");
    if (!create) throw new Error("Environment creation is unavailable.");
    const created = await create({ ...args.input, controlRequestId }, context);
    if (!record(created) || typeof created.id !== "string") {
      throw new Error("Environment creation returned no environment.");
    }
    const presentation = args.presentation;
    if (
      record(presentation) &&
      presentation.kind === COORDINATOR_DELEGATION_PRESENTATION &&
      typeof presentation.frame === "string"
    ) {
      return context.storage.updateEnvironment(created.id, {
        initialPromptPresentation: {
          kind: COORDINATOR_DELEGATION_PRESENTATION,
          frame: presentation.frame,
        },
      });
    }
    return created;
  });

  register("start_controller_build_pipeline", async (args, context) => {
    if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");
    if (!record(args.input) || typeof args.input.projectId !== "string") {
      throw new Error("Invalid build pipeline request");
    }
    const projectId = args.input.projectId;
    if (!(await context.storage.getProject(projectId))) {
      throw new Error("That project does not exist on this node.");
    }
    // Choices the coordinator left out run this node's Build button defaults.
    const input = buildPipelineInputWithDefaults(
      args.input,
      savedLaunchSettings(await context.storage.loadConfig(), projectId),
    );
    if (!isStartBuildPipelineInput(input) || input.projectId !== projectId) {
      throw new Error("Invalid build pipeline request");
    }
    if (!input.delegationBaseBranch || !input.delegationBaseCommit) {
      throw new Error("Coordinator build pipelines require an explicit base branch and commit");
    }
    if (input.existingEnvironmentId) {
      const environment = await context.storage.getEnvironment(input.existingEnvironmentId);
      if (
        !environment ||
        environment.projectId !== projectId ||
        environment.createdFromCommit?.toLowerCase() !== input.delegationBaseCommit.toLowerCase()
      ) {
        throw new Error(
          "The existing worker environment was not created from the requested delegation commit",
        );
      }
    } else if (input.environmentType === "containerized") {
      await assertContainerDelegationCommitPublished(
        context,
        projectId,
        input.delegationBaseCommit,
      );
    }
    // The pipeline's admission key makes a retried start return the first one.
    return context.buildPipelines.start(input as StartBuildPipelineInput);
  });

  /** The Multi Review button, under an ID the command node reserved for this request. */
  register("launch_controller_multi_review", async (args, context) => {
    if (!context.multiReviews) throw new Error("Multi Review supervisor is unavailable");
    const service = context.multiReviews;
    if (!isLaunchMultiReviewActionInput(args.input)) {
      throw new Error("Invalid Multi Review button action");
    }
    const input = args.input;
    const reservedId = asNonBlankString(args.reservedId, "reservedId");
    const environment = await environmentOf(context, input.environmentId);
    const start = await multiReviewButtonStart(
      context,
      dependencies,
      environment.projectId,
      environment,
      input,
    );
    return serialize(environment.id, async () => {
      let saved = await context.storage.getMultiReviewWorkflow(reservedId);
      let reused = Boolean(saved);
      if (!saved) {
        // An active review is reused, as the button reuses it.
        const active = (await context.storage.listMultiReviewWorkflows(environment.id)).find(
          (entry) =>
            isMultiReviewWorkflow(entry.snapshot) &&
            !isMultiReviewTerminalPhase(entry.snapshot.phase),
        );
        if (active) {
          saved = active;
          reused = true;
        } else {
          const started = await startMultiReviewAt(context, service, start, reservedId);
          saved = started.saved;
          reused = started.reused;
        }
      }
      if (!saved || !isMultiReviewWorkflow(saved.snapshot)) {
        throw new Error(
          "Multi Review did not produce a valid durable snapshot; retry the same requestId",
        );
      }
      let workflow = { ...saved.snapshot, backendRevision: saved.revision };
      try {
        return actionResult(workflow, reused, await openMultiReviewTab(context.storage, workflow));
      } catch (error) {
        let recovery = `The review is saved but its tab could not be opened: ${conciseError(error)} Start the environment, close a tab if needed, then use open_multi_review with this workflow ID.`;
        if (!reused && !isMultiReviewTerminalPhase(workflow.phase)) {
          try {
            workflow = await service.cancel(workflow.id);
            recovery +=
              workflow.phase === "cancelled"
                ? " The new review was cancelled; its record is retained for recovery."
                : " Cancellation is still in progress; the saved review is retained for recovery.";
          } catch {
            recovery +=
              " Cancellation could not be confirmed. The review may still be running; inspect it and use cancel_multi_review before launching another.";
          }
        }
        return actionResult(workflow, reused, { status: "unavailable" }, recovery);
      }
    });
  });

  /** Open a saved review's root or Fix tab, or address its findings. */
  register("controller_multi_review_surface", async (args, context) => {
    const surface = args.surface;
    if (surface !== "root" && surface !== "fix" && surface !== "address") {
      throw new Error("Expected surface root, fix or address.");
    }
    const id = asNonBlankString(args.workflowId, "workflowId");
    const saved = await context.storage.getMultiReviewWorkflow(id);
    if (!saved || !isMultiReviewWorkflow(saved.snapshot)) {
      throw new Error("Multi Review not found on this node");
    }
    if (surface === "address") {
      const environment = await context.storage.getEnvironment(saved.snapshot.environmentId);
      if (isProjectHomeEnvironment(environment)) {
        throw new Error("The project checkout is not a worker environment.");
      }
    }
    return runMultiReviewSurface(
      context,
      { snapshot: saved.snapshot, revision: saved.revision },
      surface,
    );
  });

  /** The low-level start after a successful build, under a reserved ID. */
  register("start_controller_multi_review", async (args, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    const reservedId = asNonBlankString(args.reservedId, "reservedId");
    const buildPipelineId = asNonBlankString(args.buildPipelineId, "buildPipelineId");
    if (!record(args.input) || typeof args.input.environmentId !== "string") {
      throw new Error("Invalid multi-review request");
    }
    const existing = await context.storage.getMultiReviewWorkflow(reservedId);
    if (existing) return existing.snapshot;
    const environment = await environmentOf(context, args.input.environmentId);
    const build = (await context.storage.getBuildPipeline(buildPipelineId))?.snapshot;
    if (
      !record(build) ||
      build.projectId !== environment.projectId ||
      build.environmentId !== environment.id ||
      build.phase !== "complete"
    ) {
      throw new Error(
        "Multi-review can start only after the associated build pipeline completed successfully",
      );
    }
    const input = await multiReviewInputWithDefaults(
      { ...args.input, projectId: environment.projectId },
      savedLaunchSettings(await context.storage.loadConfig(), environment.projectId, environment),
      () =>
        readLaunchModelCatalog(
          dependencies.commands.get("get_native_agent_model_catalog"),
          environment.id,
          context,
        ),
    );
    if (!isStartMultiReviewInput(input)) throw new Error("Invalid multi-review request");
    return context.multiReviews.start(input as StartMultiReviewInput, reservedId);
  });
}
