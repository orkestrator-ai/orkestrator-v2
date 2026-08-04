import type { BuildPipeline } from "@/stores/buildPipelineStore";
import type { LoopedReviewWorkflow } from "@/stores/loopedReviewStore";
import type { Environment } from "@/types";

/**
 * Computes environments that still need background frontend processing even
 * when they are not currently visible in the main content area.
 *
 * Build pipelines are deliberately not included: their complete state machine
 * is supervised by the backend. Neither are queued prompts — `NativeAgentService`
 * and `PromptQueueDrainer` dispatch them server-side, so a queue no longer needs
 * a mounted React tree and force-mounting one for it kept an environment alive
 * for work the renderer was not doing.
 *
 * What remains are environments whose setup scripts are still running, native
 * agent tabs that have not yet dispatched their initial prompt, and native agent
 * sessions that are still loading. These must stay mounted so terminal
 * listeners, xterm parser handlers, SSE subscriptions, and pending prompt
 * effects continue running.
 */
export function getBackgroundProcessingEnvironments(
  pipelines: Map<string, BuildPipeline>,
  environments: Environment[],
  selectedEnvironmentId: string | null,
  setupRunningEnvironmentIds: Set<string> = new Set(),
  pendingNativeLaunchEnvironmentIds: Iterable<string> = [],
  pendingInitialPromptEnvironmentIds: Iterable<string> = [],
  loadingNativeSessionEnvironmentIds: Iterable<string> = [],
  pendingSetupEnvironmentIds: Iterable<string> = [],
  loopedReviews: Iterable<LoopedReviewWorkflow> = [],
  durablePendingAgentLaunchEnvironmentIds: Iterable<string> = [],
): Environment[] {
  const backgroundEnvIds = new Set<string>(setupRunningEnvironmentIds);
  for (const environmentId of pendingNativeLaunchEnvironmentIds) {
    if (environmentId) {
      backgroundEnvIds.add(environmentId);
    }
  }
  for (const environmentId of pendingInitialPromptEnvironmentIds) {
    if (environmentId) {
      backgroundEnvIds.add(environmentId);
    }
  }
  for (const environmentId of loadingNativeSessionEnvironmentIds) {
    if (environmentId) {
      backgroundEnvIds.add(environmentId);
    }
  }
  for (const environmentId of pendingSetupEnvironmentIds) {
    if (environmentId) {
      backgroundEnvIds.add(environmentId);
    }
  }
  for (const environmentId of durablePendingAgentLaunchEnvironmentIds) {
    if (environmentId) {
      backgroundEnvIds.add(environmentId);
    }
  }

  void pipelines;
  for (const workflow of loopedReviews) {
    if (
      workflow.environmentId
      && workflow.phase !== "completed"
      && workflow.phase !== "cancelled"
    ) {
      backgroundEnvIds.add(workflow.environmentId);
    }
  }

  if (backgroundEnvIds.size === 0) return [];

  // Exclude only the environment rendered in the foreground terminal area.
  // Sibling environments in the selected project are not mounted unless they
  // have one of the explicit background-processing signals above.
  const visibleEnvIds = new Set(
    selectedEnvironmentId ? [selectedEnvironmentId] : []
  );
  return environments.filter(
    (env) => backgroundEnvIds.has(env.id) && !visibleEnvIds.has(env.id)
  );
}
