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
type LegacyPipelineImporter = (
  projectId: string,
  snapshots: unknown[],
) => Promise<{ importedIds: string[]; skipped: number }>;

let hydrationGeneration = 0;
const pipelineHydrationGenerations = new Map<string, number>();
const projectHydrationGenerations = new Map<string, number>();
const pipelineDeletionGenerations = new Map<string, number>();
const MAX_PIPELINE_HYDRATION_MARKERS = 2_048;
const MAX_PROJECT_HYDRATION_MARKERS = 512;

function nextHydrationGeneration(): number {
  hydrationGeneration += 1;
  return hydrationGeneration;
}

function setBoundedGeneration(
  generations: Map<string, number>,
  key: string,
  value: number,
  limit: number,
): void {
  generations.delete(key);
  generations.set(key, value);
  while (generations.size > limit) {
    const oldest = generations.keys().next().value;
    if (oldest === undefined) break;
    generations.delete(oldest);
  }
}

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
    || typeof persisted.updatedAt !== "string"
    || !Number.isFinite(Date.parse(persisted.updatedAt))
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
  const generation = nextHydrationGeneration();
  setBoundedGeneration(
    pipelineHydrationGenerations,
    pipelineId,
    generation,
    MAX_PIPELINE_HYDRATION_MARKERS,
  );
  const persisted = await load(pipelineId);
  if (pipelineHydrationGenerations.get(pipelineId) !== generation) {
    return useBuildPipelineStore.getState().pipelines.get(pipelineId) ?? null;
  }
  if (!persisted || persisted.id !== pipelineId) {
    setBoundedGeneration(
      pipelineDeletionGenerations,
      pipelineId,
      generation,
      MAX_PIPELINE_HYDRATION_MARKERS,
    );
    return null;
  }
  const snapshot = toSnapshot(persisted);
  if (!snapshot) {
    setBoundedGeneration(
      pipelineDeletionGenerations,
      pipelineId,
      generation,
      MAX_PIPELINE_HYDRATION_MARKERS,
    );
    return null;
  }
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
  const generation = nextHydrationGeneration();
  setBoundedGeneration(
    projectHydrationGenerations,
    projectId,
    generation,
    MAX_PROJECT_HYDRATION_MARKERS,
  );
  const persisted = await list(projectId);
  if (projectHydrationGenerations.get(projectId) !== generation) {
    return Array.from(useBuildPipelineStore.getState().pipelines.values())
      .filter((pipeline) => pipeline.projectId === projectId);
  }
  if (!Array.isArray(persisted)) return [];
  const restored: BuildPipeline[] = [];
  for (const entry of persisted) {
    if (entry.projectId !== projectId) continue;
    // A point read that observed this record missing after the list request
    // began is newer authority. Skipping the stale list entry prevents a slow
    // project hydration from resurrecting a pipeline deleted in the meantime.
    if ((pipelineDeletionGenerations.get(entry.id) ?? 0) > generation) continue;
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

/** Storage key used by the pre-backend Zustand pipeline controller. */
export const LEGACY_BUILD_PIPELINE_STORAGE_KEY = "orkestrator-build-pipelines";
const LEGACY_BUILD_PIPELINE_MAX_VERSION = 1;
const MAX_LEGACY_PIPELINES = 100;
const MAX_LEGACY_STORAGE_BYTES = 5 * 1024 * 1024;

export interface LegacyBuildPipelineMigrationResult {
  importedIds: string[];
  skipped: number;
  unsupportedVersion?: number;
}

/**
 * Imports the pre-backend renderer store through the backend supervisor.
 *
 * The renderer deliberately does not install or rewrite these snapshots: the
 * backend validates ownership and becomes their first authoritative writer.
 * The legacy key is removed only after every project import succeeds, so a
 * transient backend failure is safely retried on the next launch.
 */
export async function migrateLegacyBuildPipelines(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined =
    typeof localStorage === "undefined" ? undefined : localStorage,
  importLegacy: LegacyPipelineImporter = backend.importLegacyBuildPipelines,
  load: PipelineLoader = backend.getBuildPipeline,
): Promise<LegacyBuildPipelineMigrationResult> {
  const empty = { importedIds: [], skipped: 0 };
  if (!storage) return empty;

  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_BUILD_PIPELINE_STORAGE_KEY);
  } catch {
    return empty;
  }
  if (!raw) return empty;
  if (raw.length > MAX_LEGACY_STORAGE_BYTES) {
    console.warn("[BuildPipeline] Legacy pipeline state exceeds the migration limit");
    return { ...empty, skipped: 1 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      storage.removeItem(LEGACY_BUILD_PIPELINE_STORAGE_KEY);
    } catch {
      // A blocked storage implementation may reject cleanup as well.
    }
    return { ...empty, skipped: 1 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...empty, skipped: 1 };
  }

  const legacyVersion = (parsed as { version?: unknown }).version;
  if (
    legacyVersion !== undefined
    && (
      !Number.isSafeInteger(legacyVersion)
      || (legacyVersion as number) < 0
      || (legacyVersion as number) > LEGACY_BUILD_PIPELINE_MAX_VERSION
    )
  ) {
    return {
      ...empty,
      skipped: 1,
      ...(typeof legacyVersion === "number"
        ? { unsupportedVersion: legacyVersion }
        : {}),
    };
  }

  const entries = (parsed as { state?: { pipelines?: unknown } }).state?.pipelines;
  if (!Array.isArray(entries)) return { ...empty, skipped: 1 };

  const byProject = new Map<string, unknown[]>();
  let skipped = 0;
  for (const entry of entries.slice(0, MAX_LEGACY_PIPELINES)) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      skipped += 1;
      continue;
    }
    const [id, value] = entry;
    if (
      typeof id !== "string"
      || id.length === 0
      || !value
      || typeof value !== "object"
      || Array.isArray(value)
      || (value as { id?: unknown }).id !== id
      || typeof (value as { projectId?: unknown }).projectId !== "string"
      || (value as { projectId: string }).projectId.length === 0
    ) {
      skipped += 1;
      continue;
    }
    const projectId = (value as { projectId: string }).projectId;
    const projectSnapshots = byProject.get(projectId) ?? [];
    projectSnapshots.push(value);
    byProject.set(projectId, projectSnapshots);
  }
  skipped += Math.max(0, entries.length - MAX_LEGACY_PIPELINES);

  const importedIds: string[] = [];
  for (const [projectId, snapshots] of byProject) {
    const result = await importLegacy(projectId, snapshots);
    importedIds.push(...result.importedIds);
    skipped += result.skipped;
  }

  try {
    storage.removeItem(LEGACY_BUILD_PIPELINE_STORAGE_KEY);
  } catch {
    // Repeating the migration is safe because the backend never overwrites IDs.
  }

  await Promise.all(importedIds.map((id) => hydrateBuildPipeline(id, load)));
  return { importedIds, skipped };
}
