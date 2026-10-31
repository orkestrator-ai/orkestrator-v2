import type { CommandContext } from "./commands-context.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import type { Environment } from "./models.js";
import {
  launchPrAgent,
  launchResolveConflictsAgent,
  MULTI_REVIEW_AUTO_PR_EXISTS_MESSAGE,
} from "./multi-review-auto-pr.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";

type Dependencies = Pick<RegistryDependencies, "commands">;

/** A worker of the project that may publish: never the checkout, never one being deleted. */
async function publishableWorker(
  context: CommandContext,
  input: { environmentId: string; projectId: string },
): Promise<Environment> {
  const environment = await context.storage.getEnvironment(input.environmentId);
  if (!environment || environment.projectId !== input.projectId)
    throw new Error("Environment not found in this project");
  if (isProjectHomeEnvironment(environment))
    throw new Error("Coordinator credential cannot act on the project checkout");
  if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting")
    throw new Error("The worker environment is being deleted");
  return environment;
}

/** Refuses a worker whose active build pipeline owns its pull request. */
async function refuseActivePipeline(
  context: CommandContext,
  environment: Environment,
  message: string,
): Promise<void> {
  const pipeline = environment.buildPipelineId
    ? await context.storage.getBuildPipeline(environment.buildPipelineId)
    : null;
  const snapshot = pipeline?.snapshot as { phase?: unknown } | undefined;
  // Forks inherit the pipeline ID but have a different environment. Removed
  // or terminal pipelines cannot publish this worker's branch for it.
  if (
    pipeline?.projectId === environment.projectId &&
    pipeline.environmentId === environment.id &&
    snapshot?.phase !== "failed" &&
    snapshot?.phase !== "complete"
  )
    throw new Error(message);
}

function commandInvoker(context: CommandContext, dependencies: Dependencies) {
  return async <T>(command: string, args?: Record<string, unknown>) => {
    const handler = dependencies.commands.get(command);
    if (!handler) throw new Error(`Backend command is unavailable: ${command}`);
    return (await handler(args ?? {}, context)) as T;
  };
}

/** Runs on the worker's owning node, using its PR defaults and durable job identity. */
export async function launchWorkerPr(
  context: CommandContext,
  dependencies: Dependencies,
  input: { environmentId: string; projectId: string; targetBranch?: string; requestId: string },
): Promise<Record<string, unknown>> {
  const environment = await publishableWorker(context, input);
  if (environment.prUrl)
    return {
      environmentId: environment.id,
      status: "skipped",
      message: MULTI_REVIEW_AUTO_PR_EXISTS_MESSAGE,
      prUrl: environment.prUrl,
    };
  await refuseActivePipeline(
    context,
    environment,
    "This worker belongs to a build pipeline, whose own PR step raises the pull request; follow it with get_build_pipeline",
  );
  const config = await context.storage.loadConfig();
  const base = input.targetBranch ?? (config.repositories[input.projectId]?.prBaseBranch || "main");
  const outcome = await launchPrAgent(commandInvoker(context, dependencies), context.storage, {
    ...input,
    targetBranch: base,
  });
  if (outcome.kind === "launched")
    return {
      environmentId: environment.id,
      status: "launched",
      tabId: outcome.tabId,
      targetBranch: base,
    };
  if (outcome.kind === "skipped")
    return {
      environmentId: environment.id,
      status: "skipped",
      message: outcome.message,
    };
  throw new Error(
    outcome.kind === "pending" ? "The PR agent launch is still pending" : outcome.message,
  );
}

/**
 * The Resolve Conflicts button for a worker, on the worker's owning node.
 *
 * The same precondition as the button (`useActionBarController`'s
 * `canConfigureResolve`): the worker has a pull request that is neither
 * merged nor closed, and GitHub has not reported it free of conflicts (an
 * unknown mergeability still allows a resolve). The target is the PR's own
 * base branch, then the repository's PR base branch, then `main`, as
 * `pr.resolve` does.
 */
export async function launchWorkerResolve(
  context: CommandContext,
  dependencies: Dependencies,
  input: { environmentId: string; projectId: string; targetBranch?: string; requestId: string },
): Promise<Record<string, unknown>> {
  const environment = await publishableWorker(context, input);
  if (!environment.prUrl)
    throw new Error(
      "This worker has no pull request, so there are no conflicts to resolve; raise one with create_pr",
    );
  if (environment.prState === "merged" || environment.prState === "closed")
    throw new Error(
      `This worker's pull request is ${environment.prState}, so there is nothing to resolve`,
    );
  if (environment.hasMergeConflicts === false)
    throw new Error(
      "GitHub reports no merge conflicts on this worker's pull request; read its state with get_environment",
    );
  await refuseActivePipeline(
    context,
    environment,
    "This worker belongs to a build pipeline, whose own steps resolve its pull request's conflicts; follow it with get_build_pipeline",
  );
  const config = await context.storage.loadConfig();
  const base =
    input.targetBranch ??
    (environment.prBaseBranch || config.repositories[input.projectId]?.prBaseBranch || "main");
  const outcome = await launchResolveConflictsAgent(
    commandInvoker(context, dependencies),
    context.storage,
    { environmentId: environment.id, targetBranch: base, requestId: input.requestId },
  );
  if (outcome.kind !== "launched") throw new Error(outcome.message);
  return {
    environmentId: environment.id,
    status: "launched",
    tabId: outcome.tabId,
    targetBranch: base,
    prUrl: environment.prUrl,
    ...(outcome.refreshArmed
      ? {}
      : {
          warning:
            "Conflict resolution started, but the automatic PR refresh was not scheduled; the state may lag until the PR monitor's next check.",
        }),
  };
}
