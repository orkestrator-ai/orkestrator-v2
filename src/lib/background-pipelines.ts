import type { BuildPipeline } from "@/stores/buildPipelineStore";
import type { Environment } from "@/types";

/**
 * Computes environments that still need background frontend processing even
 * when they are not currently visible in the main content area.
 *
 * This includes active pipelines and local environments whose setup scripts are
 * still running in a terminal. These must stay mounted so terminal listeners,
 * xterm parser handlers, SSE subscriptions, and pipeline advancement effects
 * continue running.
 */
export function getBackgroundProcessingEnvironments(
  pipelines: Map<string, BuildPipeline>,
  environments: Environment[],
  selectedEnvironmentId: string | null,
  projectEnvironments: Environment[],
  setupRunningEnvironmentIds: Set<string> = new Set(),
): Environment[] {
  const backgroundEnvIds = new Set<string>(setupRunningEnvironmentIds);

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
