import {
  CHANGE_PROJECTION_CHANGED_EVENT,
  isChangeProjection,
  isChangeProjectionEvent,
} from "@orkestrator/protocol/change-resources";
import * as backend from "@/lib/backend";
import { listenAuthoritative } from "@/lib/native/authoritative-events";
import { toolPresentationKey, useChangeProjectionStore } from "@/stores/changeProjectionStore";

/**
 * One process-wide subscription to backend change projections.
 *
 * Components register interest in resource keys; the first registration
 * installs the event listener (subscribe before snapshot), then each key is
 * read once. A reconnect re-reads every registered key conditionally, and an
 * answer to a read started before that reconnect is discarded (it may come
 * from a replaced backend). Events for keys nobody shows are ignored, so the
 * store stays bounded by what is visible. There are no timers: the backend
 * owns freshness.
 */

const interest = new Map<string, number>();
let listening: Promise<void> | null = null;
const MAX_CONCURRENT_READS = 6;
let active = 0;
const queue: string[] = [];
const queued = new Set<string>();
/** Advances on every transport resync; fences reads started before it. */
let connectionEpoch = 0;
/** Keys with a read in flight, by the connection epoch it started in. */
const reading = new Map<string, number>();

function drain(): void {
  while (active < MAX_CONCURRENT_READS && queue.length > 0) {
    const key = queue.shift()!;
    queued.delete(key);
    if (!interest.has(key)) continue;
    active++;
    void read(key).finally(() => {
      active--;
      drain();
    });
  }
}

async function read(resourceKey: string): Promise<void> {
  const store = useChangeProjectionStore.getState();
  const current = store.projections.get(resourceKey);
  const epoch = connectionEpoch;
  reading.set(resourceKey, epoch);
  try {
    const result = await backend.getChangeView(
      resourceKey,
      current ? { generation: current.ownerGeneration, revision: current.revision } : undefined,
    );
    // The resync queued a fresh read of every registered key.
    if (epoch !== connectionEpoch) return;
    if (result.kind === "projection" || result.kind === "reset") {
      if (isChangeProjection(result.projection)) store.applyProjection(result.projection);
    } else if (result.kind === "deleted") {
      store.markDeleted(resourceKey);
    }
  } catch {
    // An older backend without change tracking, or a transient failure: the
    // components fall back to their legacy presentation.
  } finally {
    if (reading.get(resourceKey) === epoch) reading.delete(resourceKey);
  }
}

/**
 * Queue a read of one resource. `joinInFlight` lets a new consumer share a
 * read already running in this connection epoch; resyncs and resets always
 * read again.
 */
export function requestChangeRead(resourceKey: string, joinInFlight = false): void {
  if (queued.has(resourceKey)) return;
  if (joinInFlight && reading.get(resourceKey) === connectionEpoch) return;
  queued.add(resourceKey);
  queue.push(resourceKey);
  drain();
}

function ensureListening(): Promise<void> {
  listening ??= listenAuthoritative<unknown>(
    CHANGE_PROJECTION_CHANGED_EVENT,
    (event) => {
      const payload = event.payload;
      if (!isChangeProjectionEvent(payload)) return;
      const store = useChangeProjectionStore.getState();
      switch (payload.kind) {
        case "projection":
          reconcileToolPresentations();
          if (interest.has(payload.projection.resourceKey))
            store.applyProjection(payload.projection);
          break;
        case "deleted":
          if (interest.has(payload.resourceKey)) store.markDeleted(payload.resourceKey);
          break;
        case "reset":
          if (interest.has(payload.resourceKey)) requestChangeRead(payload.resourceKey);
          break;
        case "content-invalidated":
          store.applyContentInvalidation(
            payload.resourceKey,
            payload.contentGeneration,
            payload.pathIds,
            payload.ownerGeneration,
          );
          break;
      }
    },
    {
      onResync: () => {
        connectionEpoch++;
        useChangeProjectionStore.getState().resync();
        reconcileToolPresentations();
        for (const key of interest.keys()) requestChangeRead(key);
      },
    },
  ).then(
    () => undefined,
    () => {
      listening = null;
    },
  );
  return listening;
}

/** Register interest in a resource; returns the release function. */
export function subscribeChangeResource(resourceKey: string): () => void {
  interest.set(resourceKey, (interest.get(resourceKey) ?? 0) + 1);
  void ensureListening().then(() => requestChangeRead(resourceKey, true));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (interest.get(resourceKey) ?? 1) - 1;
    if (count <= 0) interest.delete(resourceKey);
    else interest.set(resourceKey, count);
  };
}

// ---------------------------------------------------------------------------
// Tool presentations, batched per conversation
// ---------------------------------------------------------------------------

interface PendingBatch {
  environmentId: string;
  provider: string;
  conversationId: string;
  callIds: Set<string>;
}

const toolInterest = new Map<
  string,
  {
    scope: { environmentId: string; provider: string; conversationId: string };
    callId: string;
    count: number;
  }
>();

export function subscribeToolPresentation(
  scope: { environmentId: string; provider: string; conversationId: string },
  callId: string,
): () => void {
  const key = toolPresentationKey(
    scope.environmentId,
    scope.provider,
    scope.conversationId,
    callId,
  );
  const entry = toolInterest.get(key) ?? { scope, callId, count: 0 };
  entry.count++;
  toolInterest.set(key, entry);
  requestToolPresentation(scope, callId);
  return () => {
    if (--entry.count === 0) {
      toolInterest.delete(key);
      requestedTools.delete(key);
    }
  };
}

function reconcileToolPresentations(): void {
  for (const { scope, callId } of toolInterest.values())
    requestToolPresentation(scope, callId, true);
}

const batches = new Map<string, PendingBatch>();
const requestedTools = new Set<string>();
let batchScheduled = false;

function flushBatches(): void {
  batchScheduled = false;
  const pending = [...batches.values()];
  batches.clear();
  for (const batch of pending) {
    const callIds = [...batch.callIds];
    for (let index = 0; index < callIds.length; index += 200) {
      const slice = callIds.slice(index, index + 200);
      const epoch = connectionEpoch;
      void backend
        .getToolChangePresentations({
          environmentId: batch.environmentId,
          provider: batch.provider,
          conversationId: batch.conversationId,
          callIds: slice,
        })
        .then((result) => {
          if (epoch !== connectionEpoch) return;
          const store = useChangeProjectionStore.getState();
          store.applyToolPresentations(
            slice.map((callId) => [
              toolPresentationKey(
                batch.environmentId,
                batch.provider,
                batch.conversationId,
                callId,
              ),
              result.presentations[callId] ?? null,
            ]),
          );
          for (const projection of Object.values(result.projections)) {
            if (isChangeProjection(projection)) store.applyProjection(projection);
          }
        })
        .catch(() => {
          // Older backend: rows keep their legacy presentation.
          for (const callId of slice) {
            requestedTools.delete(
              toolPresentationKey(
                batch.environmentId,
                batch.provider,
                batch.conversationId,
                callId,
              ),
            );
          }
        });
    }
  }
}

/**
 * Ask for a tool row's presentation. Rows of one conversation are batched
 * into one request per tick; a row is requested again when `force` is set
 * (its transcript part changed).
 */
export function requestToolPresentation(
  scope: { environmentId: string; provider: string; conversationId: string },
  callId: string,
  force = false,
): void {
  const key = toolPresentationKey(
    scope.environmentId,
    scope.provider,
    scope.conversationId,
    callId,
  );
  if (requestedTools.has(key) && !force) return;
  requestedTools.add(key);
  if (requestedTools.size > 20_000) requestedTools.clear();
  const batchKey = `${scope.environmentId}\0${scope.provider}\0${scope.conversationId}`;
  let batch = batches.get(batchKey);
  if (!batch) {
    batch = { ...scope, callIds: new Set() };
    batches.set(batchKey, batch);
  }
  batch.callIds.add(callId);
  if (!batchScheduled) {
    batchScheduled = true;
    queueMicrotask(flushBatches);
  }
  void ensureListening();
}

/** Test seam. */
export function resetChangeSubscriptionsForTests(): void {
  interest.clear();
  listening = null;
  queue.length = 0;
  queued.clear();
  reading.clear();
  connectionEpoch = 0;
  batches.clear();
  requestedTools.clear();
  toolInterest.clear();
  active = 0;
}
