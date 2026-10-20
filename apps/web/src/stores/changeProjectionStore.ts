import { create } from "zustand";
import type {
  CanonicalToolPresentation,
  ChangeProjection,
} from "@orkestrator/protocol/change-resources";

/**
 * Mirror of backend change projections the UI currently shows.
 *
 * Values are server-prepared; this store only orders deliveries: within one
 * owner generation a lower revision never replaces a higher one, and a new
 * generation replaces whatever was held (the backend restarted or reset).
 */
interface ChangeProjectionState {
  projections: Map<string, ChangeProjection>;
  transportRevision: number;
  resync: () => void;
  retiredOwners: Map<string, string[]>;
  deleted: Set<string>;
  /** Content generation per resource; live bodies refetch when it moves. */
  contentGenerations: Map<
    string,
    { generation: number; pathIds: string[] | null; ownerGeneration?: string }
  >;
  /** Tool presentations by `${environmentId}\0${provider}\0${conversationId}\0${callId}`. */
  toolPresentations: Map<string, CanonicalToolPresentation | null>;
  applyProjection: (projection: ChangeProjection) => void;
  markDeleted: (resourceKey: string) => void;
  applyContentInvalidation: (
    resourceKey: string,
    generation: number,
    pathIds: string[] | null,
    ownerGeneration?: string,
  ) => void;
  applyToolPresentations: (
    entries: ReadonlyArray<[string, CanonicalToolPresentation | null]>,
  ) => void;
}

export function toolPresentationKey(
  environmentId: string,
  provider: string,
  conversationId: string,
  callId: string,
) {
  return `${environmentId}\0${provider}\0${conversationId}\0${callId}`;
}

export const useChangeProjectionStore = create<ChangeProjectionState>()((set) => ({
  projections: new Map(),
  transportRevision: 0,
  resync: () =>
    set((state) => ({
      transportRevision: state.transportRevision + 1,
      toolPresentations: new Map(),
    })),
  retiredOwners: new Map(),
  deleted: new Set(),
  contentGenerations: new Map(),
  toolPresentations: new Map(),
  applyProjection: (projection) =>
    set((state) => {
      if (state.retiredOwners.get(projection.resourceKey)?.includes(projection.ownerGeneration))
        return state;
      const existing = state.projections.get(projection.resourceKey);
      if (
        existing &&
        existing.ownerGeneration === projection.ownerGeneration &&
        existing.revision > projection.revision
      ) {
        return state;
      }
      if (existing === projection) return state;
      // Keep the file page of an equal measurement when an event omits it.
      const next =
        projection.filePage === null &&
        existing?.filePage &&
        existing.measurementId === projection.measurementId &&
        existing.ownerGeneration === projection.ownerGeneration
          ? { ...projection, filePage: existing.filePage }
          : projection;
      const projections = new Map(state.projections);
      projections.set(projection.resourceKey, next);
      const deleted = state.deleted.has(projection.resourceKey)
        ? new Set(state.deleted)
        : state.deleted;
      if (deleted !== state.deleted) deleted.delete(projection.resourceKey);
      const contentGenerations = new Map(state.contentGenerations);
      const retiredOwners = new Map(state.retiredOwners);
      const priorOwner =
        contentGenerations.get(projection.resourceKey)?.ownerGeneration ??
        existing?.ownerGeneration;
      if (priorOwner && priorOwner !== projection.ownerGeneration) {
        retiredOwners.set(
          projection.resourceKey,
          [...(retiredOwners.get(projection.resourceKey) ?? []), priorOwner].slice(-32),
        );
        contentGenerations.set(projection.resourceKey, {
          generation: 0,
          pathIds: null,
          ownerGeneration: projection.ownerGeneration,
        });
      }
      return { projections, deleted, contentGenerations, retiredOwners };
    }),
  markDeleted: (resourceKey) =>
    set((state) => {
      if (state.deleted.has(resourceKey) && !state.projections.has(resourceKey)) return state;
      const projections = new Map(state.projections);
      projections.delete(resourceKey);
      const deleted = new Set(state.deleted);
      deleted.add(resourceKey);
      return { projections, deleted };
    }),
  applyContentInvalidation: (resourceKey, generation, pathIds, ownerGeneration) =>
    set((state) => {
      const existing = state.contentGenerations.get(resourceKey);
      if (ownerGeneration && state.retiredOwners.get(resourceKey)?.includes(ownerGeneration))
        return state;
      const priorOwner =
        existing?.ownerGeneration ?? state.projections.get(resourceKey)?.ownerGeneration;
      const replaced = !!ownerGeneration && !!priorOwner && priorOwner !== ownerGeneration;
      if (!replaced && existing && existing.generation >= generation) return state;
      const contentGenerations = new Map(state.contentGenerations);
      const retiredOwners = new Map(state.retiredOwners);
      if (replaced)
        retiredOwners.set(
          resourceKey,
          [...(retiredOwners.get(resourceKey) ?? []), priorOwner!].slice(-32),
        );
      contentGenerations.set(resourceKey, {
        generation,
        pathIds,
        ...(ownerGeneration ? { ownerGeneration } : {}),
      });
      return { contentGenerations, retiredOwners };
    }),
  applyToolPresentations: (entries) =>
    set((state) => {
      if (entries.length === 0) return state;
      const toolPresentations = new Map(state.toolPresentations);
      for (const [key, value] of entries) {
        const existing = toolPresentations.get(key);
        if (existing && (!value || existing.revision > value.revision)) continue;
        toolPresentations.set(key, value);
      }
      return { toolPresentations };
    }),
}));
