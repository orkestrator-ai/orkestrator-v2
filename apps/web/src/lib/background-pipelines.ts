import type { BuildPipeline } from "@/stores/buildPipelineStore";
import type { Environment } from "@/types";

/**
 * Computes environments that still need background frontend processing even
 * when they are not currently visible in the main content area.
 *
 * This includes active pipelines, environments whose setup scripts are still
 * running, native agent tabs that have not yet dispatched their initial prompt,
 * native agent sessions that are still loading, and agent tabs with queued
 * prompts waiting to drain. These must stay mounted so terminal listeners,
 * xterm parser handlers, SSE subscriptions, and pending prompt effects continue
 * running.
 */
export function getBackgroundProcessingEnvironments(
  pipelines: Map<string, BuildPipeline>,
  environments: Environment[],
  selectedEnvironmentId: string | null,
  setupRunningEnvironmentIds: Set<string> = new Set(),
  pendingNativeLaunchEnvironmentIds: Iterable<string> = [],
  pendingInitialPromptEnvironmentIds: Iterable<string> = [],
  loadingNativeSessionEnvironmentIds: Iterable<string> = [],
  queuedAgentPromptEnvironmentIds: Iterable<string> = [],
  pendingSetupEnvironmentIds: Iterable<string> = [],
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
  for (const environmentId of queuedAgentPromptEnvironmentIds) {
    if (environmentId) {
      backgroundEnvIds.add(environmentId);
    }
  }
  for (const environmentId of pendingSetupEnvironmentIds) {
    if (environmentId) {
      backgroundEnvIds.add(environmentId);
    }
  }

  for (const pipeline of pipelines.values()) {
    if (pipeline.environmentId && pipeline.phase !== "complete" && pipeline.phase !== "failed") {
      backgroundEnvIds.add(pipeline.environmentId);
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
