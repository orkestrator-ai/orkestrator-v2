import * as backend from "@/lib/backend";
import {
  BUILD_PIPELINE_VERSION,
  isBuildPipeline,
  useBuildPipelineStore,
  type BuildPipeline,
} from "@/stores/buildPipelineStore";
import type { PersistedBuildPipeline } from "@/types";
import { parseStructuredReviewReport } from "@orkestrator/protocol/structured-review";

export { isBuildPipeline } from "@/stores/buildPipelineStore";

type PipelineLoader = (
  pipelineId: string,
) => Promise<PersistedBuildPipeline<BuildPipeline> | null>;
type PipelineListLoader = (
  projectId: string,
) => Promise<Array<PersistedBuildPipeline<BuildPipeline>>>;

function normalizeStructuredReview(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const pipeline = value as Record<string, unknown>;
  if (pipeline.structuredReview === undefined) return value;
  try {
    return {
      ...pipeline,
      structuredReview: parseStructuredReviewReport(
        pipeline.structuredReview,
        { allowLegacyTestResults: true },
      ),
    };
  } catch {
    return value;
  }
}

function toSnapshot(
  persisted: PersistedBuildPipeline<BuildPipeline>,
): BuildPipeline | null {
  const snapshot = normalizeStructuredReview(persisted.snapshot);
  if (
    persisted.version !== BUILD_PIPELINE_VERSION
    || !Number.isSafeInteger(persisted.revision)
    || persisted.revision < 1
    || !isBuildPipeline(snapshot)
    || snapshot.id !== persisted.id
    || snapshot.projectId !== persisted.projectId
    || snapshot.environmentId !== persisted.environmentId
  ) {
    return null;
  }
  return {
    ...snapshot,
    backendRevision: persisted.revision,
    controller: "backend",
  };
}

/** Installs one authoritative backend read model into the renderer cache. */
export async function hydrateBuildPipeline(
  pipelineId: string,
  load: PipelineLoader = backend.getBuildPipeline,
): Promise<BuildPipeline | null> {
  const persisted = await load(pipelineId);
  if (!persisted || persisted.id !== pipelineId) return null;
  const snapshot = toSnapshot(persisted);
  if (!snapshot) return null;
  const local = useBuildPipelineStore.getState().pipelines.get(pipelineId);
  if (local && local.backendRevision > snapshot.backendRevision) return local;
  useBuildPipelineStore.getState().replacePipeline(snapshot);
  return snapshot;
}

/** Replaces the project projection with backend snapshots. */
export async function hydrateBuildPipelinesForProject(
  projectId: string,
  list: PipelineListLoader = backend.listBuildPipelines,
): Promise<BuildPipeline[]> {
  const persisted = await list(projectId);
  if (!Array.isArray(persisted)) return [];
  const restored: BuildPipeline[] = [];
  for (const entry of persisted) {
    if (entry.projectId !== projectId) continue;
    const snapshot = toSnapshot(entry);
    if (!snapshot) continue;
    const local = useBuildPipelineStore.getState().pipelines.get(entry.id);
    if (!local || local.backendRevision <= snapshot.backendRevision) {
      useBuildPipelineStore.getState().replacePipeline(snapshot);
      restored.push(snapshot);
    } else {
      restored.push(local);
    }
  }
  return restored;
}
