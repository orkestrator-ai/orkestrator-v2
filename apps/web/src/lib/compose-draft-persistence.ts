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

/**
 * Serialize one operation per draft key and hand back its result.
 *
 * Everything that reads or writes `DraftRevisionState.revision` has to go
 * through here. The revision is a compare-and-swap cursor, so two operations
 * interleaving on it produce a swap against a revision the backend has already
 * moved past.
 */
function enqueue<TResult>(
  draftKey: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const previous = writeChains.get(draftKey) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(operation);
  // The chain itself must never reject, or one failure would skip every
  // operation queued behind it. Callers still see `result`'s rejection.
  const settled = result.then(() => undefined, () => undefined);
  writeChains.set(draftKey, settled);
  void settled.then(() => {
    if (writeChains.get(draftKey) === settled) writeChains.delete(draftKey);
  });
  return result;
}

/**
 * Settle everything already queued for one draft key.
 *
 * Callers that mutate a draft through some *other* backend command have to wait
 * for this first: an in-flight save makes that command see an occupied draft,
 * and an in-flight delete makes it see one that the composer has already
 * discarded. Do not call this from inside a queued operation — it waits on the
 * chain that operation is a member of.
 */
export async function awaitComposeDraftWrites(draftKey: string): Promise<void> {
  await (writeChains.get(draftKey) ?? Promise.resolve()).catch(() => undefined);
}

/**
 * Read a draft, ordered against every save and delete for the same key.
 *
 * Ordering matters twice over. A tab closed and immediately reopened must not
 * hydrate the value the close path has queued to delete. And because this read
 * publishes the revision cursor every later compare-and-swap uses, it cannot be
 * allowed to overlap a save: a read that started first but resolved second used
 * to overwrite the revision that save had just advanced, leaving the cursor
 * behind the backend. The next save then failed as a phantom conflict, and a
 * discard-on-submit failed too — so a submitted draft survived to resurface.
 */
export function loadComposeDraft<T>(
  draftKey: string,
  revisionState?: DraftRevisionState,
): Promise<Awaited<ReturnType<typeof backend.getComposeDraft<T>>>> {
  return enqueue(draftKey, async () => {
    const draft = await backend.getComposeDraft<T>(draftKey);
    const state = revisionStateFor(draftKey, revisionState);
    state.revision = draft?.revision ?? 0;
    state.conflictRevision = null;
    return draft;
  });
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
