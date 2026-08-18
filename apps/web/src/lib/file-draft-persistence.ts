import * as backend from "@/lib/backend";
import {
  createDraftRevisionState,
  DraftRevisionConflictError,
  type DraftRevisionState,
  isDraftRevisionConflict,
} from "@/lib/draft-conflict";

const writeChains = new Map<string, Promise<void>>();
const defaultRevisionStates = new Map<string, DraftRevisionState>();
const clientRevisionStates = new Map<string, DraftRevisionState>();

export { createDraftRevisionState };
export type { DraftRevisionState };

function revisionStateFor(draftKey: string, state?: DraftRevisionState): DraftRevisionState {
  if (state) return state;
  const existing = defaultRevisionStates.get(draftKey);
  if (existing) return existing;
  const created = createDraftRevisionState();
  defaultRevisionStates.set(draftKey, created);
  return created;
}

export function getFileDraftRevisionState(clientId: string): DraftRevisionState {
  const existing = clientRevisionStates.get(clientId);
  if (existing) return existing;
  const created = createDraftRevisionState();
  clientRevisionStates.set(clientId, created);
  return created;
}

export function releaseFileDraftRevisionState(clientId: string): void {
  clientRevisionStates.delete(clientId);
}

async function recordFileConflict(
  draftKey: string,
  state: DraftRevisionState,
  error: unknown,
): Promise<never> {
  if (!isDraftRevisionConflict(error)) throw error;
  const current = await backend.getFileDraft(draftKey);
  state.conflictRevision = current?.revision ?? 0;
  throw new DraftRevisionConflictError(draftKey, state.conflictRevision, { cause: error });
}

export function fileDraftKey(environmentId: string, filePath: string): string {
  return `file:${environmentId}:${encodeURIComponent(filePath)}`;
}

function enqueue(draftKey: string, operation: () => Promise<unknown>): Promise<void> {
  const previous = writeChains.get(draftKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .then(() => undefined);
  writeChains.set(draftKey, next);
  void next.then(
    () => {
      if (writeChains.get(draftKey) === next) writeChains.delete(draftKey);
    },
    () => {
      if (writeChains.get(draftKey) === next) writeChains.delete(draftKey);
    },
  );
  return next;
}

/** Read only after every queued write for this file has settled. */
export async function loadFileDraft(
  environmentId: string,
  filePath: string,
  revisionState?: DraftRevisionState,
): Promise<Awaited<ReturnType<typeof backend.getFileDraft>> | null> {
  const draftKey = fileDraftKey(environmentId, filePath);
  await (writeChains.get(draftKey) ?? Promise.resolve()).catch(() => undefined);
  const draft = await backend.getFileDraft(draftKey);
  const state = revisionStateFor(draftKey, revisionState);
  state.revision = draft?.revision ?? 0;
  state.conflictRevision = null;
  return draft;
}

export function persistFileDraft(
  environmentId: string,
  filePath: string,
  content: string,
  originalContent: string,
  revisionState?: DraftRevisionState,
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
  const state = revisionStateFor(draftKey, revisionState);
  return enqueue(draftKey, async () => {
    if (state.conflictRevision !== null) {
      throw new DraftRevisionConflictError(draftKey, state.conflictRevision);
    }
    try {
      const saved = await backend.saveFileDraft(
        draftKey,
        environmentId,
        filePath,
        content,
        originalContent,
        state.revision,
      );
      if (saved && typeof saved.revision === "number") {
        state.revision = saved.revision;
      }
    } catch (error) {
      await recordFileConflict(draftKey, state, error);
    }
  });
}

export function discardFileDraft(
  environmentId: string,
  filePath: string,
  revisionState?: DraftRevisionState,
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
  const state = revisionStateFor(draftKey, revisionState);
  return enqueue(draftKey, async () => {
    if (state.conflictRevision !== null) {
      throw new DraftRevisionConflictError(draftKey, state.conflictRevision);
    }
    try {
      await backend.deleteFileDraft(draftKey, state.revision);
      state.revision = 0;
    } catch (error) {
      await recordFileConflict(draftKey, state, error);
    }
  });
}

export function resolveFileDraftSaveConflict(
  environmentId: string,
  filePath: string,
  content: string,
  originalContent: string,
  revisionState?: DraftRevisionState,
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
  const state = revisionStateFor(draftKey, revisionState);
  if (state.conflictRevision !== null) {
    state.revision = state.conflictRevision;
    state.conflictRevision = null;
  }
  return persistFileDraft(environmentId, filePath, content, originalContent, state);
}

export function resolveFileDraftDiscardConflict(
  environmentId: string,
  filePath: string,
  revisionState?: DraftRevisionState,
): Promise<void> {
  const draftKey = fileDraftKey(environmentId, filePath);
  const state = revisionStateFor(draftKey, revisionState);
  if (state.conflictRevision !== null) {
    state.revision = state.conflictRevision;
    state.conflictRevision = null;
  }
  return discardFileDraft(environmentId, filePath, state);
}
