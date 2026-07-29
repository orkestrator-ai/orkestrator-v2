import * as backend from "@/lib/backend";
import {
  createDraftRevisionState,
  DraftRevisionConflictError,
  type DraftRevisionState,
  isDraftRevisionConflict,
} from "@/lib/draft-conflict";

const writeChains = new Map<string, Promise<void>>();
const defaultRevisionStates = new Map<string, DraftRevisionState>();

export { createDraftRevisionState, DraftRevisionConflictError };
export type { DraftRevisionState };

function revisionStateFor(
  draftKey: string,
  state?: DraftRevisionState,
): DraftRevisionState {
  if (state) return state;
  const existing = defaultRevisionStates.get(draftKey);
  if (existing) return existing;
  const created = createDraftRevisionState();
  defaultRevisionStates.set(draftKey, created);
  return created;
}

/**
 * Synchronize the renderer's optimistic-concurrency cursor after another
 * backend operation creates or replaces this draft.
 */
export function recordComposeDraftRevision(
  draftKey: string,
  revision: number,
  revisionState?: DraftRevisionState,
): void {
  const state = revisionStateFor(draftKey, revisionState);
  state.revision = revision;
  state.conflictRevision = null;
}

async function recordComposeConflict(
  draftKey: string,
  state: DraftRevisionState,
  error: unknown,
): Promise<never> {
  if (!isDraftRevisionConflict(error)) throw error;
  const current = await backend.getComposeDraft(draftKey);
  state.conflictRevision = current?.revision ?? 0;
  throw new DraftRevisionConflictError(
    draftKey,
    state.conflictRevision,
    { cause: error },
  );
}

export function composeDraftKey(
  namespace: string,
  environmentId: string,
  localKey: string,
): string {
  return `${namespace}:${environmentId}:${encodeURIComponent(localKey)}`;
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

/**
 * Read a draft after every save/delete already queued for the same key.
 *
 * This matters when a tab is closed and immediately reopened: the new mount
 * must not hydrate the value that the close path has already queued to delete.
 */
export async function loadComposeDraft<T>(
  draftKey: string,
  revisionState?: DraftRevisionState,
): Promise<Awaited<ReturnType<typeof backend.getComposeDraft<T>>>> {
  await (writeChains.get(draftKey) ?? Promise.resolve()).catch(() => undefined);
  const draft = await backend.getComposeDraft<T>(draftKey);
  const state = revisionStateFor(draftKey, revisionState);
  state.revision = draft?.revision ?? 0;
  state.conflictRevision = null;
  return draft;
}

export function persistComposeDraft<T>(
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  value: T,
  revisionState?: DraftRevisionState,
): Promise<void> {
  const state = revisionStateFor(draftKey, revisionState);
  return enqueue(
    draftKey,
    async () => {
      if (state.conflictRevision !== null) {
        throw new DraftRevisionConflictError(
          draftKey,
          state.conflictRevision,
        );
      }
      try {
        const saved = await backend.saveComposeDraft(
          draftKey,
          ownerType,
          ownerId,
          value,
          state.revision,
        );
        if (saved && typeof saved.revision === "number") {
          state.revision = saved.revision;
        }
      } catch (error) {
        await recordComposeConflict(draftKey, state, error);
      }
    },
  );
}

export function discardComposeDraft(
  draftKey: string,
  revisionState?: DraftRevisionState,
): Promise<void> {
  const state = revisionStateFor(draftKey, revisionState);
  return enqueue(draftKey, async () => {
    if (state.conflictRevision !== null) {
      throw new DraftRevisionConflictError(
        draftKey,
        state.conflictRevision,
      );
    }
    try {
      await backend.deleteComposeDraft(draftKey, state.revision);
      state.revision = 0;
    } catch (error) {
      await recordComposeConflict(draftKey, state, error);
    }
  });
}

export function resolveComposeDraftSaveConflict<T>(
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  value: T,
  revisionState?: DraftRevisionState,
): Promise<void> {
  const state = revisionStateFor(draftKey, revisionState);
  if (state.conflictRevision !== null) {
    state.revision = state.conflictRevision;
    state.conflictRevision = null;
  }
  return persistComposeDraft(
    draftKey,
    ownerType,
    ownerId,
    value,
    state,
  );
}

export function resolveComposeDraftDiscardConflict(
  draftKey: string,
  revisionState?: DraftRevisionState,
): Promise<void> {
  const state = revisionStateFor(draftKey, revisionState);
  if (state.conflictRevision !== null) {
    state.revision = state.conflictRevision;
    state.conflictRevision = null;
  }
  return discardComposeDraft(draftKey, state);
}
