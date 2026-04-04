import type { BuildPipeline } from "@/stores/buildPipelineStore";
import type { Environment } from "@/types";

/**
 * Computes environments that have active (non-complete, non-failed) pipelines
 * but are not currently visible in the main content area. These need to stay
 * mounted so their SSE subscriptions and pipeline advancement effects run.
 */
export function getBackgroundPipelineEnvironments(
  pipelines: Map<string, BuildPipeline>,
  environments: Environment[],
  selectedEnvironmentId: string | null,
  projectEnvironments: Environment[],
): Environment[] {
  const activePipelineEnvIds = new Set<string>();
  for (const pipeline of pipelines.values()) {
    if (pipeline.environmentId && pipeline.phase !== "complete" && pipeline.phase !== "failed") {
      activePipelineEnvIds.add(pipeline.environmentId);
    }
  }
  if (activePipelineEnvIds.size === 0) return [];
  // Exclude environments already rendered in the main content area
  const visibleEnvIds = new Set(
    selectedEnvironmentId ? projectEnvironments.map((e) => e.id) : []
  );
  return environments.filter(
    (env) => activePipelineEnvIds.has(env.id) && !visibleEnvIds.has(env.id)
  );
}
