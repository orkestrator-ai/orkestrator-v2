import * as backend from "@/lib/backend";
import {
  isLoopedReviewWorkflow,
  useLoopedReviewStore,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";
import type { PersistedLoopedReviewWorkflow } from "@/types";

export { isLoopedReviewWorkflow } from "@/stores/loopedReviewStore";

type WorkflowLoader = (
  workflowId: string,
) => Promise<PersistedLoopedReviewWorkflow<LoopedReviewWorkflow> | null>;

type WorkflowListLoader = (
  environmentId: string,
) => Promise<Array<PersistedLoopedReviewWorkflow<LoopedReviewWorkflow>>>;

/**
 * "The backend has no such record" and "the record exists but this build cannot
 * read it" are different facts, and only the first one justifies deleting the
 * renderer's projection. Collapsing them into `null` meant a snapshot this
 * bundle failed to validate — a newer backend, an added field — silently
 * removed a live workflow from the store, which in turn removed the user's tab
 * via the authoritative pane-layout reconciliation.
 */
export type LoopedReviewHydration =
  | { status: "hydrated"; workflow: LoopedReviewWorkflow }
  | { status: "missing" }
  | { status: "unreadable" };

function authoritativeSnapshot(
  entry: PersistedLoopedReviewWorkflow<LoopedReviewWorkflow>,
): LoopedReviewWorkflow | null {
  if (
    !isLoopedReviewWorkflow(entry.snapshot) ||
    entry.snapshot.id !== entry.id ||
    entry.snapshot.environmentId !== entry.environmentId
  ) {
    return null;
  }
  return { ...entry.snapshot, backendRevision: entry.revision };
}

/**
 * Rehydrate one backend-owned workflow, reporting *why* it could not be
 * hydrated. Callers that delete projections must branch on `missing`.
 */
export async function resolveLoopedReviewWorkflow(
  workflowId: string,
  load: WorkflowLoader = backend.getLoopedReviewWorkflow,
): Promise<LoopedReviewHydration> {
  const persisted = await load(workflowId);
  if (!persisted) return { status: "missing" };
  // A record answering to a different id is not this workflow's record, so it
  // is no evidence either way about whether this workflow still exists.
  if (persisted.id !== workflowId) return { status: "unreadable" };
  const snapshot = authoritativeSnapshot(persisted);
  if (!snapshot) return { status: "unreadable" };

  const local = useLoopedReviewStore.getState().workflows.get(workflowId);
  if (local && local.backendRevision > snapshot.backendRevision) {
    return { status: "hydrated", workflow: local };
  }
  useLoopedReviewStore.getState().replaceWorkflow(snapshot);
  return { status: "hydrated", workflow: snapshot };
}

/** Rehydrate one backend-owned workflow after a resource event or tab mount. */
export async function hydrateLoopedReviewWorkflow(
  workflowId: string,
  load: WorkflowLoader = backend.getLoopedReviewWorkflow,
): Promise<LoopedReviewWorkflow | null> {
  const result = await resolveLoopedReviewWorkflow(workflowId, load);
  return result.status === "hydrated" ? result.workflow : null;
}

/** Restore every authoritative workflow for an environment after remount/restart. */
export async function hydrateLoopedReviewWorkflowsForEnvironment(
  environmentId: string,
  list: WorkflowListLoader = backend.listLoopedReviewWorkflows,
): Promise<LoopedReviewWorkflow[]> {
  const persisted = await list(environmentId);
  if (!Array.isArray(persisted)) return [];

  const restored: LoopedReviewWorkflow[] = [];
  for (const entry of persisted) {
    if (entry.environmentId !== environmentId) continue;
    const snapshot = authoritativeSnapshot(entry);
    if (!snapshot) continue;
    const local = useLoopedReviewStore.getState().workflows.get(entry.id);
    if (local && local.backendRevision > snapshot.backendRevision) {
      restored.push(local);
      continue;
    }
    useLoopedReviewStore.getState().replaceWorkflow(snapshot);
    restored.push(snapshot);
  }
  return restored;
}

export interface LoopedReviewControllerFence {
  ownerId: string;
  token: string;
}

/**
 * Compatibility shim for extensions compiled against renderer-owned v1.
 * Version-2 workflows are backend-owned, so renderer fences are never active.
 */
export function registerLoopedReviewControllerFence(
  _workflowId: string,
  _fence: LoopedReviewControllerFence,
): () => void {
  return () => undefined;
}

/** @deprecated Version-2 workflow transitions must use backend commands. */
export async function persistLoopedReviewWorkflowNow(
  _workflowId: string,
): Promise<LoopedReviewWorkflow> {
  throw new Error("Backend-owned looped reviews cannot be persisted by the renderer");
}

export interface LoopedReviewPersistenceOptions {
  debounceMs?: number;
}

/**
 * @deprecated The backend service persists every transition. Retained as a
 * no-op compatibility boundary so older renderer bundles cannot regain write
 * authority during a rolling upgrade.
 */
export function startLoopedReviewPersistence(
  _options: LoopedReviewPersistenceOptions = {},
): () => void {
  return () => undefined;
}
