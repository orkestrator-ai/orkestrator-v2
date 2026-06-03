import type { BuildPipeline } from "@/stores/buildPipelineStore";
import type { Environment } from "@/types";

/**
 * Computes environments that still need background frontend processing even
 * when they are not currently visible in the main content area.
 *
 * This includes active pipelines, environments whose setup scripts are still
 * running, native agent tabs that have not yet dispatched their initial prompt,
 * native agent sessions that are still loading, and native tabs with queued
 * prompts waiting to drain. These must stay mounted so terminal listeners,
 * xterm parser handlers, SSE subscriptions, and pending native prompt effects
 * continue running.
 */
export function getBackgroundProcessingEnvironments(
  pipelines: Map<string, BuildPipeline>,
  environments: Environment[],
  selectedEnvironmentId: string | null,
  projectEnvironments: Environment[],
  setupRunningEnvironmentIds: Set<string> = new Set(),
  pendingNativeLaunchEnvironmentIds: Iterable<string> = [],
  pendingInitialPromptEnvironmentIds: Iterable<string> = [],
  loadingNativeSessionEnvironmentIds: Iterable<string> = [],
  queuedNativePromptEnvironmentIds: Iterable<string> = [],
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
  for (const environmentId of queuedNativePromptEnvironmentIds) {
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

  // Exclude environments already rendered in the main content area
  const visibleEnvIds = new Set(
    selectedEnvironmentId ? projectEnvironments.map((e) => e.id) : []
  );
  return environments.filter(
    (env) => backgroundEnvIds.has(env.id) && !visibleEnvIds.has(env.id)
  );
}
