import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import type { DesignCanvas, DesignFrame } from "@orkestrator/protocol/design-canvas";
import type {
  DesignFailure,
  DesignOperationDescriptor,
  DesignOperationResult,
  DesignOperationState,
  DesignRecordProblem,
  DesignTombstone,
  DesignWorkspaceMeta,
} from "@orkestrator/protocol/design-operations";

export type DesignSnapshotState =
  "absent" | "loading" | "current" | "stale" | "deleted" | "missing" | "invalid";
export type DesignConnectionState = "connected" | "reconnecting" | "offline" | "unauthorized";
export type DesignIntentPhase =
  "draft" | "preparing" | "prepared" | "submitting" | "admitted" | "settled";

/** A user's intent. Only committed snapshots are authoritative; this is a projection. */
export interface DesignIntent {
  id: string;
  environmentId: string;
  canvasId: string;
  /** Frame id, or "canvas" for canvas-scoped operations. */
  lane: string;
  descriptor: DesignOperationDescriptor;
  label: string;
  createdAt: number;
  phase: DesignIntentPhase;
  token?: string;
  outcome?: DesignOperationState;
  failure?: DesignFailure;
  result?: DesignOperationResult;
  /** Optimistic geometry preview, removed once the committed revision is installed. */
  preview?: {
    frameId: string;
    patch: Partial<Pick<DesignFrame, "x" | "y" | "width" | "height" | "name">>;
  };
  /** `${gestureId}:${kind}`: unsent samples of one gesture collapse to the newest. */
  gestureKey?: string;
  /** Restored from a previous session: never runs without an explicit Resume. */
  restored?: boolean;
  /** A preceding intent in the same lane failed; this waits for review. */
  blocked?: boolean;
  /** Snapshot revision that must be installed before the preview can be dropped. */
  awaitRevision?: number;
}

export interface DesignProjection {
  key: string;
  environmentId: string;
  canvasId: string;
  snapshot: DesignSnapshotState;
  connection: DesignConnectionState;
  canvas: DesignCanvas | null;
  workspace: DesignWorkspaceMeta | null;
  tombstone?: DesignTombstone;
  problem?: DesignRecordProblem;
  generation?: string;
  revision: number;
  statusVersion: number;
  intents: DesignIntent[];
  /** Read/sync failure, separate from per-operation failures. */
  readError?: DesignFailure;
  lastSyncedAt?: number;
  busy: { export: boolean; import: boolean; history: boolean };
  notice?: { id: number; text: string; tone: "info" | "success" | "warning" };
}

export function emptyProjection(
  key: string,
  environmentId: string,
  canvasId: string,
): DesignProjection {
  return {
    key,
    environmentId,
    canvasId,
    snapshot: "absent",
    connection: "connected",
    canvas: null,
    workspace: null,
    revision: 0,
    statusVersion: -1,
    intents: [],
    busy: { export: false, import: false, history: false },
  };
}

export interface DesignStoreState {
  projections: Map<string, DesignProjection>;
  update: (key: string, update: (projection: DesignProjection) => DesignProjection) => void;
  put: (projection: DesignProjection) => void;
  remove: (key: string) => void;
}

/**
 * Per node (plan item 3012): an environment's canvases belong to its node, and
 * each node scope's canvas controllers (`design-controller.ts`) project into
 * that scope's instance.
 */
export const designStore = defineScopedStore<DesignStoreState>("design", () => (set) => ({
  projections: new Map(),
  update: (key, update) =>
    set((state) => {
      const current = state.projections.get(key);
      if (!current) return state;
      const next = update(current);
      if (next === current) return state;
      const projections = new Map(state.projections);
      projections.set(key, next);
      return { projections };
    }),
  put: (projection) =>
    set((state) => {
      const projections = new Map(state.projections);
      projections.set(projection.key, projection);
      return { projections };
    }),
  remove: (key) =>
    set((state) => {
      if (!state.projections.has(key)) return state;
      const projections = new Map(state.projections);
      projections.delete(key);
      return { projections };
    }),
}));

/**
 * Reads the nearest node scope's canvas projections; other code uses
 * `scope.store(designStore)`.
 */
export const useDesignStore = scopedStoreHook(designStore);

/** Frames with optimistic previews applied, preserving unchanged frame identities. */
export function projectedFrames(projection: DesignProjection | undefined): DesignFrame[] {
  if (!projection?.canvas) return [];
  const previews = new Map<string, DesignIntent["preview"]>();
  for (const intent of projection.intents) {
    if (!intent.preview || intent.failure || intent.outcome === "rejected") continue;
    const existing = previews.get(intent.preview.frameId);
    previews.set(intent.preview.frameId, {
      frameId: intent.preview.frameId,
      patch: { ...existing?.patch, ...intent.preview.patch },
    });
  }
  if (!previews.size) return projection.canvas.frames;
  return projection.canvas.frames.map((frame) => {
    const preview = previews.get(frame.id);
    return preview ? { ...frame, ...preview.patch } : frame;
  });
}

export function pendingPreviewFrames(projection: DesignProjection | undefined): Set<string> {
  const result = new Set<string>();
  for (const intent of projection?.intents ?? []) {
    if (intent.preview && !intent.failure && intent.outcome !== "rejected")
      result.add(intent.preview.frameId);
  }
  return result;
}
