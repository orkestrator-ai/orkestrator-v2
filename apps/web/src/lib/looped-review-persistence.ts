import * as backend from "@/lib/backend";
import {
  isLoopedReviewWorkflow,
  LOOPED_REVIEW_WORKFLOW_VERSION,
  useLoopedReviewStore,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";
import type { PersistedLoopedReviewWorkflow } from "@/types";

export { isLoopedReviewWorkflow } from "@/stores/loopedReviewStore";

interface PendingWrite {
  workflow: LoopedReviewWorkflow;
  fingerprint: string;
}

type WorkflowLoader = (
  workflowId: string,
) => Promise<PersistedLoopedReviewWorkflow<LoopedReviewWorkflow> | null>;
type WorkflowListLoader = (
  environmentId: string,
) => Promise<Array<PersistedLoopedReviewWorkflow<LoopedReviewWorkflow>>>;
type WorkflowSaver = (
  workflowId: string,
  environmentId: string,
  version: number,
  snapshot: LoopedReviewWorkflow,
  expectedRevision?: number,
) => Promise<PersistedLoopedReviewWorkflow<LoopedReviewWorkflow>>;

/**
 * Process-local dirty markers prevent an equal-revision backend hydration from
 * replacing a transition which has happened since the renderer started. They
 * deliberately do not mark snapshots restored from localStorage: on startup
 * the backend remains authoritative for equal revisions.
 */
const dirtyWorkflowFingerprints = new Map<string, string>();

function workflowFingerprint(workflow: LoopedReviewWorkflow): string {
  const { backendRevision: _backendRevision, ...durable } = workflow;
  return JSON.stringify(durable);
}

function isUnsavedLocalWorkflow(workflow: LoopedReviewWorkflow): boolean {
  return dirtyWorkflowFingerprints.get(workflow.id) === workflowFingerprint(workflow);
}

function markWorkflowClean(workflowId: string, fingerprint: string): void {
  if (dirtyWorkflowFingerprints.get(workflowId) === fingerprint) {
    dirtyWorkflowFingerprints.delete(workflowId);
  }
}

/**
 * Rehydrates one workflow from the backend authority. A local snapshot is kept
 * only when it has already observed a newer backend revision.
 */
export async function hydrateLoopedReviewWorkflow(
  workflowId: string,
  load: WorkflowLoader = backend.getLoopedReviewWorkflow,
): Promise<LoopedReviewWorkflow | null> {
  const persisted = await load(workflowId);
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
  if (
    local
    && local.backendRevision === persisted.revision
    && isUnsavedLocalWorkflow(local)
  ) {
    return local;
  }
  useLoopedReviewStore.getState().replaceWorkflow(snapshot);
  dirtyWorkflowFingerprints.delete(workflowId);
  return snapshot;
}

/** Restores every authoritative workflow for an environment after app restart. */
export async function hydrateLoopedReviewWorkflowsForEnvironment(
  environmentId: string,
  list: WorkflowListLoader = backend.listLoopedReviewWorkflows,
): Promise<LoopedReviewWorkflow[]> {
  if (typeof list !== "function") return [];
  const persisted = await list(environmentId);
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
    const keepDirtyEqualRevision =
      local
      && local.backendRevision === entry.revision
      && isUnsavedLocalWorkflow(local);
    if (
      !local
      || (
        local.backendRevision <= entry.revision
        && !keepDirtyEqualRevision
      )
    ) {
      useLoopedReviewStore.getState().replaceWorkflow(snapshot);
      dirtyWorkflowFingerprints.delete(entry.id);
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
  options: Pick<LoopedReviewPersistenceOptions, "save" | "load"> = {},
): Promise<LoopedReviewWorkflow> {
  const save = options.save ?? backend.saveLoopedReviewWorkflow;
  const load = options.load ?? backend.getLoopedReviewWorkflow;
  const workflow = useLoopedReviewStore.getState().workflows.get(workflowId);
  if (!workflow) throw new Error(`Looped review workflow not found: ${workflowId}`);
  const fingerprint = workflowFingerprint(workflow);
  let saved;
  try {
    saved = await save(
      workflow.id,
      workflow.environmentId,
      LOOPED_REVIEW_WORKFLOW_VERSION,
      workflow,
      workflow.backendRevision,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("revision conflict")) {
      const winner = await hydrateLoopedReviewWorkflow(workflowId, load);
      if (winner) return winner;
    }
    throw error;
  }
  markWorkflowClean(workflowId, fingerprint);
  useLoopedReviewStore.getState().setBackendRevision(workflowId, saved.revision);
  return useLoopedReviewStore.getState().workflows.get(workflowId)!;
}

export interface LoopedReviewPersistenceOptions {
  debounceMs?: number;
  save?: WorkflowSaver;
  load?: WorkflowLoader;
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
        const savedFingerprint = workflowFingerprint(current);
        lastSavedFingerprint.set(workflowId, savedFingerprint);
        markWorkflowClean(workflowId, savedFingerprint);
        useLoopedReviewStore.getState().setBackendRevision(
          workflowId,
          saved.revision,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("revision conflict")) {
          const winner = await load(workflowId).catch(() => null);
          if (winner && isLoopedReviewWorkflow(winner.snapshot)) {
            useLoopedReviewStore.getState().replaceWorkflow({
              ...winner.snapshot,
              backendRevision: winner.revision,
            });
            lastSavedFingerprint.set(
              workflowId,
              workflowFingerprint(winner.snapshot),
            );
            dirtyWorkflowFingerprints.delete(workflowId);
            return;
          }
        }
        const latest = useLoopedReviewStore.getState().workflows.get(workflowId);
        const failureMessage = `Failed to persist looped review state: ${message}`;
        const alreadyReported =
          latest?.phase === "failed"
          && latest.failure?.code === "persistence"
          && latest.failure.message === failureMessage;
        if (
          latest
          && latest.phase !== "completed"
          && latest.phase !== "cancelled"
          && !alreadyReported
        ) {
          useLoopedReviewStore.getState().failWorkflow(workflowId, {
            code: "persistence",
            message: failureMessage,
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
        dirtyWorkflowFingerprints.delete(id);
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
      dirtyWorkflowFingerprints.set(id, fingerprint);
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
