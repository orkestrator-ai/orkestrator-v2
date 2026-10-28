import type { CommandContext } from "./commands-context.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import { launchPrAgent, MULTI_REVIEW_AUTO_PR_EXISTS_MESSAGE } from "./multi-review-auto-pr.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";

/** Runs on the worker's owning node, using its PR defaults and durable job identity. */
export async function launchWorkerPr(
  context: CommandContext,
  dependencies: Pick<RegistryDependencies, "commands">,
  input: { environmentId: string; projectId: string; targetBranch?: string; requestId: string },
): Promise<Record<string, unknown>> {
  const environment = await context.storage.getEnvironment(input.environmentId);
  if (!environment || environment.projectId !== input.projectId)
    throw new Error("Environment not found in this project");
  if (isProjectHomeEnvironment(environment))
    throw new Error("Coordinator credential cannot act on the project checkout");
  if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting")
    throw new Error("The worker environment is being deleted");
  if (environment.prUrl)
    return {
      environmentId: environment.id,
      status: "skipped",
      message: MULTI_REVIEW_AUTO_PR_EXISTS_MESSAGE,
      prUrl: environment.prUrl,
    };
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
    throw new Error(
      "This worker belongs to a build pipeline, whose own PR step raises the pull request; follow it with get_build_pipeline",
    );
  const config = await context.storage.loadConfig();
  const base = input.targetBranch ?? (config.repositories[input.projectId]?.prBaseBranch || "main");
  const outcome = await launchPrAgent(
    async <T>(command: string, args?: Record<string, unknown>) => {
      const handler = dependencies.commands.get(command);
      if (!handler) throw new Error(`Backend command is unavailable: ${command}`);
      return (await handler(args ?? {}, context)) as T;
    },
    context.storage,
    { ...input, targetBranch: base },
  );
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
