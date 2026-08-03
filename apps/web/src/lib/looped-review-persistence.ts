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

function authoritativeSnapshot(
  entry: PersistedLoopedReviewWorkflow<LoopedReviewWorkflow>,
): LoopedReviewWorkflow | null {
  if (
    !isLoopedReviewWorkflow(entry.snapshot)
    || entry.snapshot.id !== entry.id
    || entry.snapshot.environmentId !== entry.environmentId
  ) {
    return null;
  }
  return { ...entry.snapshot, backendRevision: entry.revision };
}
/** Rehydrate one backend-owned workflow after a resource event or tab mount. */
export async function hydrateLoopedReviewWorkflow(
  workflowId: string,
  load: WorkflowLoader = backend.getLoopedReviewWorkflow,
): Promise<LoopedReviewWorkflow | null> {
  const persisted = await load(workflowId);
  if (!persisted || persisted.id !== workflowId) return null;
  const snapshot = authoritativeSnapshot(persisted);
  if (!snapshot) return null;

  const local = useLoopedReviewStore.getState().workflows.get(workflowId);
  if (local && local.backendRevision > snapshot.backendRevision) return local;
  useLoopedReviewStore.getState().replaceWorkflow(snapshot);
  return snapshot;
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
