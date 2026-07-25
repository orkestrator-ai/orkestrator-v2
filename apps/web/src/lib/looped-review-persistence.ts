import * as backend from "@/lib/backend";
import {
  isLoopedReviewWorkflow,
  LOOPED_REVIEW_WORKFLOW_VERSION,
  useLoopedReviewStore,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";

export { isLoopedReviewWorkflow } from "@/stores/loopedReviewStore";

interface PendingWrite {
  workflow: LoopedReviewWorkflow;
  fingerprint: string;
}

function workflowFingerprint(workflow: LoopedReviewWorkflow): string {
  const { backendRevision: _backendRevision, ...durable } = workflow;
  return JSON.stringify(durable);
}

/**
 * Rehydrates one workflow from the backend authority. A local snapshot is kept
 * only when it has already observed a newer backend revision.
 */
export async function hydrateLoopedReviewWorkflow(
  workflowId: string,
): Promise<LoopedReviewWorkflow | null> {
  const persisted = await backend.getLoopedReviewWorkflow(workflowId);
  if (
    !persisted
    || persisted.id !== workflowId
    || !isLoopedReviewWorkflow(persisted.snapshot)
    || persisted.snapshot.id !== persisted.id
    || persisted.snapshot.environmentId !== persisted.environmentId
  ) {
    return null;
  }
  const snapshot = {
    ...persisted.snapshot,
    backendRevision: persisted.revision,
  };
  const local = useLoopedReviewStore.getState().workflows.get(workflowId);
  if (local && local.backendRevision > persisted.revision) return local;
  useLoopedReviewStore.getState().replaceWorkflow(snapshot);
  return snapshot;
}

/** Restores every authoritative workflow for an environment after app restart. */
export async function hydrateLoopedReviewWorkflowsForEnvironment(
  environmentId: string,
): Promise<LoopedReviewWorkflow[]> {
  if (typeof backend.listLoopedReviewWorkflows !== "function") return [];
  const persisted = await backend.listLoopedReviewWorkflows(environmentId);
  if (!Array.isArray(persisted)) return [];
  const restored: LoopedReviewWorkflow[] = [];
  for (const entry of persisted) {
    if (
      entry.environmentId !== environmentId
      || !isLoopedReviewWorkflow(entry.snapshot)
      || entry.snapshot.id !== entry.id
      || entry.snapshot.environmentId !== environmentId
    ) {
      continue;
    }
    const snapshot = {
      ...entry.snapshot,
      backendRevision: entry.revision,
    };
    const local = useLoopedReviewStore.getState().workflows.get(entry.id);
    if (!local || local.backendRevision <= entry.revision) {
      useLoopedReviewStore.getState().replaceWorkflow(snapshot);
      restored.push(snapshot);
    } else {
      restored.push(local);
    }
  }
  return restored;
}

/** Durably records a dispatch lease before any provider request is written. */
export async function persistLoopedReviewWorkflowNow(
  workflowId: string,
): Promise<LoopedReviewWorkflow> {
  const workflow = useLoopedReviewStore.getState().workflows.get(workflowId);
  if (!workflow) throw new Error(`Looped review workflow not found: ${workflowId}`);
  let saved;
  try {
    saved = await backend.saveLoopedReviewWorkflow(
      workflow.id,
      workflow.environmentId,
      LOOPED_REVIEW_WORKFLOW_VERSION,
      workflow,
      workflow.backendRevision,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("revision conflict")) {
      const winner = await hydrateLoopedReviewWorkflow(workflowId);
      if (winner) return winner;
    }
    throw error;
  }
  useLoopedReviewStore.getState().setBackendRevision(workflowId, saved.revision);
  return useLoopedReviewStore.getState().workflows.get(workflowId)!;
}

export interface LoopedReviewPersistenceOptions {
  debounceMs?: number;
  save?: typeof backend.saveLoopedReviewWorkflow;
  load?: typeof backend.getLoopedReviewWorkflow;
}

/**
 * Mirrors every workflow transition into the revisioned backend store.
 *
 * Writes are serialized per workflow and use compare-and-swap revisions. A
 * conflict rehydrates the backend winner instead of allowing two mounted
 * renderers to dispatch the same phase independently.
 */
export function startLoopedReviewPersistence(
  options: LoopedReviewPersistenceOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 250;
  const save = options.save ?? backend.saveLoopedReviewWorkflow;
  const load = options.load ?? backend.getLoopedReviewWorkflow;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, PendingWrite>();
  const chains = new Map<string, Promise<void>>();
  const lastSavedFingerprint = new Map<string, string>();

  const cancelTimer = (workflowId: string) => {
    const timer = timers.get(workflowId);
    if (timer) clearTimeout(timer);
    timers.delete(workflowId);
  };

  const enqueue = (workflowId: string): Promise<void> => {
    const previous = chains.get(workflowId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const current = useLoopedReviewStore.getState().workflows.get(workflowId);
      if (!current) return;
      try {
        const saved = await save(
          workflowId,
          current.environmentId,
          LOOPED_REVIEW_WORKFLOW_VERSION,
          current,
          current.backendRevision,
        );
        lastSavedFingerprint.set(workflowId, workflowFingerprint(current));
        useLoopedReviewStore.getState().setBackendRevision(
          workflowId,
          saved.revision,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("revision conflict")) {
          const winner = await load(workflowId);
          if (winner && isLoopedReviewWorkflow(winner.snapshot)) {
            useLoopedReviewStore.getState().replaceWorkflow({
              ...winner.snapshot,
              backendRevision: winner.revision,
            });
            lastSavedFingerprint.set(
              workflowId,
              workflowFingerprint(winner.snapshot),
            );
            return;
          }
        }
        const latest = useLoopedReviewStore.getState().workflows.get(workflowId);
        if (latest && latest.phase !== "completed" && latest.phase !== "cancelled") {
          useLoopedReviewStore.getState().failWorkflow(workflowId, {
            code: "persistence",
            message: `Failed to persist looped review state: ${message}`,
            retryPhase:
              latest.phase === "failed"
                ? latest.failure?.retryPhase ?? "preparing"
                : latest.phase === "paused"
                  ? latest.pausedFromPhase ?? "preparing"
                  : latest.phase,
          });
        }
      }
    });
    chains.set(workflowId, next);
    void next.finally(() => {
      if (chains.get(workflowId) === next) chains.delete(workflowId);
    });
    return next;
  };

  const flush = (workflowId: string): Promise<void> | undefined => {
    const write = pending.get(workflowId);
    if (!write) return undefined;
    cancelTimer(workflowId);
    pending.delete(workflowId);
    return enqueue(workflowId);
  };

  const flushAll = () => Promise.all(
    [...pending.keys()].map((id) => flush(id) ?? Promise.resolve()),
  ).then(() => undefined);

  const unsubscribe = useLoopedReviewStore.subscribe((state, previous) => {
    const ids = new Set([...state.workflows.keys(), ...previous.workflows.keys()]);
    for (const id of ids) {
      const workflow = state.workflows.get(id);
      if (!workflow) {
        cancelTimer(id);
        pending.delete(id);
        lastSavedFingerprint.delete(id);
        continue;
      }
      if (workflow === previous.workflows.get(id)) continue;
      const fingerprint = workflowFingerprint(workflow);
      if (
        fingerprint === lastSavedFingerprint.get(id)
        || fingerprint === pending.get(id)?.fingerprint
      ) {
        continue;
      }
      pending.set(id, { workflow, fingerprint });
      cancelTimer(id);
      timers.set(id, setTimeout(() => {
        void flush(id);
      }, debounceMs));
    }
  });

  // Workflows restored from local persistence predate this subscription, so
  // seed them immediately into the backend if necessary.
  for (const [id, workflow] of useLoopedReviewStore.getState().workflows) {
    const fingerprint = workflowFingerprint(workflow);
    pending.set(id, { workflow, fingerprint });
    timers.set(id, setTimeout(() => {
      void flush(id);
    }, debounceMs));
  }

  const onPageHide = () => {
    void flushAll();
  };
  window.addEventListener("pagehide", onPageHide);

  return () => {
    unsubscribe();
    window.removeEventListener("pagehide", onPageHide);
    void flushAll();
  };
}
