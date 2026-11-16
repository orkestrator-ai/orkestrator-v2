import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
// The factory from its own module: suites replace the barrel with partial mocks.
import { createWorkflowsApi } from "@/lib/backend/workflows";
import {
  createDraftRevisionState,
  DraftRevisionConflictError,
  type DraftRevisionState,
  isDraftRevisionConflict,
} from "@/lib/draft-conflict";
import { DraftWriteRetries } from "@/lib/compose-draft-retry";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import { getNodeConnectivity, onNodeReconnected } from "@/lib/transport-connectivity";

/*
 * Compose drafts live on the node that owns the environment, so the write
 * chains and revision cursors are per node scope (plan item 3009): the same
 * draft key on two nodes is two drafts, and one node's compare-and-swap
 * cursor must never be replayed against another's. Every export takes an
 * optional trailing `scope`, the app's command scope when omitted.
 */

interface ComposeDraftWrites {
  readonly writeChains: Map<string, Promise<void>>;
  readonly defaultRevisionStates: Map<string, DraftRevisionState>;
  readonly api: Pick<
    ReturnType<typeof createWorkflowsApi>,
    "getComposeDraft" | "saveComposeDraft" | "deleteComposeDraft"
  >;
  /** Failed saves and discards awaiting retry; see `compose-draft-retry.ts`. */
  readonly retries: DraftWriteRetries;
}

function isRetryableDraftWriteError(error: unknown): boolean {
  return !(error instanceof DraftRevisionConflictError) && !isDraftRevisionConflict(error);
}

const composeDraftWrites = defineScopedSlot<ComposeDraftWrites>("compose-draft-writes", (scope) => {
  const writeChains = new Map<string, Promise<void>>();
  const retries = new DraftWriteRetries({
    enqueue: (draftKey, operation) => enqueueOnChain(writeChains, draftKey, operation),
    isRetryable: isRetryableDraftWriteError,
    isDisconnected: () => getNodeConnectivity(scope).disconnected,
  });
  // A write that failed while the node was unreachable lands as soon as it
  // is back, not on the next edit to that draft (which may never come).
  const stopListening = onNodeReconnected(scope, () => retries.retryNow());
  scope.onDispose("compose-draft-writes", () => {
    stopListening();
    retries.dispose();
  });
  return {
    writeChains,
    defaultRevisionStates: new Map(),
    api: backendApiForScope(scope, createWorkflowsApi, backend),
    retries,
  };
});

export { createDraftRevisionState, DraftRevisionConflictError };
export type { DraftRevisionState };

function revisionStateFor(
  writes: ComposeDraftWrites,
  draftKey: string,
  state?: DraftRevisionState,
): DraftRevisionState {
  if (state) return state;
  const existing = writes.defaultRevisionStates.get(draftKey);
  if (existing) return existing;
  const created = createDraftRevisionState();
  writes.defaultRevisionStates.set(draftKey, created);
  return created;
}

async function recordComposeConflict(
  writes: ComposeDraftWrites,
  draftKey: string,
  state: DraftRevisionState,
  error: unknown,
): Promise<never> {
  if (!isDraftRevisionConflict(error)) throw error;
  const current = await writes.api.getComposeDraft(draftKey);
  state.conflictRevision = current?.revision ?? 0;
  throw new DraftRevisionConflictError(draftKey, state.conflictRevision, { cause: error });
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
  writes: ComposeDraftWrites,
  draftKey: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  return enqueueOnChain(writes.writeChains, draftKey, operation);
}

function enqueueOnChain<TResult>(
  writeChains: Map<string, Promise<void>>,
  draftKey: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const previous = writeChains.get(draftKey) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  // The chain itself must never reject, or one failure would skip every
  // operation queued behind it. Callers still see `result`'s rejection.
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(draftKey, settled);
  void settled.then(() => {
    if (writeChains.get(draftKey) === settled) writeChains.delete(draftKey);
  });
  return result;
}

/**
 * Queue a save or discard that is retried if it fails.
 *
 * The caller still receives the first attempt's outcome and reports it as
 * before. A retryable failure is then repeated in the background until it
 * lands, unless a newer write for the key overtakes it (see
 * `DraftWriteRetries`). Without this a discard that failed during an outage
 * left a stale draft behind, and a stale draft holds the backend's queue.
 */
function enqueueRetriedWrite<TResult>(
  writes: ComposeDraftWrites,
  draftKey: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const seq = writes.retries.begin(draftKey);
  const result = enqueue(writes, draftKey, operation);
  const repeat = async (): Promise<void> => {
    await operation();
  };
  void result.then(
    () => writes.retries.settled(draftKey, seq, null, repeat),
    (error: unknown) => writes.retries.settled(draftKey, seq, { error }, repeat),
  );
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
export async function awaitComposeDraftWrites(
  draftKey: string,
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const { writeChains } = composeDraftWrites(scope);
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
  scope: NodeScope = appCommandScope(),
): Promise<Awaited<ReturnType<typeof backend.getComposeDraft<T>>>> {
  const writes = composeDraftWrites(scope);
  return enqueue(writes, draftKey, async () => {
    // A save or discard that failed earlier goes first, so a reopened tab does
    // not hydrate the draft it already submitted. A failure leaves it pending.
    await writes.retries.flushInline(draftKey).catch(() => undefined);
    const draft = await writes.api.getComposeDraft<T>(draftKey);
    const state = revisionStateFor(writes, draftKey, revisionState);
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
  scope: NodeScope = appCommandScope(),
): Promise<SavedComposeDraft<T> | undefined> {
  const writes = composeDraftWrites(scope);
  const state = revisionStateFor(writes, draftKey, revisionState);
  return enqueueRetriedWrite(writes, draftKey, async () => {
    if (state.conflictRevision !== null) {
      throw new DraftRevisionConflictError(draftKey, state.conflictRevision);
    }
    try {
      const saved = await writes.api.saveComposeDraft(
        draftKey,
        ownerType,
        ownerId,
        value,
        state.revision,
      );
      if (saved && typeof saved.revision === "number") {
        state.revision = saved.revision;
      }
      return saved ?? undefined;
    } catch (error) {
      return recordComposeConflict(writes, draftKey, state, error);
    }
  });
}

/** A saved draft; the backend may report legacy browser notes it mapped to threads. */
export type SavedComposeDraft<T> = Awaited<ReturnType<typeof backend.saveComposeDraft<T>>>;

export function discardComposeDraft(
  draftKey: string,
  revisionState?: DraftRevisionState,
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const writes = composeDraftWrites(scope);
  const state = revisionStateFor(writes, draftKey, revisionState);
  return enqueueRetriedWrite(writes, draftKey, async () => {
    if (state.conflictRevision !== null) {
      throw new DraftRevisionConflictError(draftKey, state.conflictRevision);
    }
    try {
      await writes.api.deleteComposeDraft(draftKey, state.revision);
      state.revision = 0;
    } catch (error) {
      await recordComposeConflict(writes, draftKey, state, error);
    }
  });
}

export function resolveComposeDraftSaveConflict<T>(
  draftKey: string,
  ownerType: "environment" | "project",
  ownerId: string,
  value: T,
  revisionState?: DraftRevisionState,
  scope: NodeScope = appCommandScope(),
): Promise<SavedComposeDraft<T> | undefined> {
  const state = revisionStateFor(composeDraftWrites(scope), draftKey, revisionState);
  if (state.conflictRevision !== null) {
    state.revision = state.conflictRevision;
    state.conflictRevision = null;
  }
  return persistComposeDraft(draftKey, ownerType, ownerId, value, state, scope);
}

export function resolveComposeDraftDiscardConflict(
  draftKey: string,
  revisionState?: DraftRevisionState,
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const state = revisionStateFor(composeDraftWrites(scope), draftKey, revisionState);
  if (state.conflictRevision !== null) {
    state.revision = state.conflictRevision;
    state.conflictRevision = null;
  }
  return discardComposeDraft(draftKey, state, scope);
}

/** Modify the latest saved value after pending hydration/unmount writes, using CAS. */
export function updateSavedComposeDraft<T>(
  draftKey: string,
  update: (value: T) => T,
  scope: NodeScope = appCommandScope(),
): Promise<void> {
  const writes = composeDraftWrites(scope);
  return enqueue(writes, draftKey, async () => {
    await writes.retries.flushInline(draftKey).catch(() => undefined);
    const saved = await writes.api.getComposeDraft<T>(draftKey);
    if (!saved) return;
    const value = update(saved.value);
    if (value === saved.value) return;
    const state = revisionStateFor(writes, draftKey);
    try {
      const result = await writes.api.saveComposeDraft(
        draftKey,
        saved.ownerType,
        saved.ownerId,
        value,
        saved.revision,
      );
      state.revision = result?.revision ?? saved.revision;
      state.conflictRevision = null;
    } catch (error) {
      await recordComposeConflict(writes, draftKey, state, error);
    }
  });
}

/** Draft keys on `scope`'s node with a failed save or discard awaiting retry. */
export function composeDraftWritesAwaitingRetry(scope: NodeScope = appCommandScope()): string[] {
  return composeDraftWrites(scope).retries.pendingKeys();
}
