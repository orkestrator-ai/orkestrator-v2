import { changeProjectionChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import type { AnyEventDef } from "@orkestrator/protocol/contract/event";
import {
  isChangeProjection,
  isChangeProjectionEvent,
} from "@orkestrator/protocol/change-resources";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createChangesApi } from "@/lib/backend/changes";
import {
  listenAuthoritative,
  listenAuthoritativeWith,
  type AuthoritativeListenOptions,
} from "@/lib/native/authoritative-events";
import type { NativeEvent, UnlistenFn } from "@/lib/native/events";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot, isAppCommandScope } from "@/lib/node-scope-slots";
import { changeProjectionStore, toolPresentationKey } from "@/stores/changeProjectionStore";

/**
 * One subscription per node scope to that node's change projections (plan
 * item 3012, report Appendix B).
 *
 * Components register interest in resource keys; the first registration
 * installs the event listener (subscribe before snapshot), then each key is
 * read once. A reconnect re-reads every registered key conditionally, and an
 * answer to a read started before that reconnect is discarded (it may come
 * from a replaced backend). Events for keys nobody shows are ignored, so the
 * store stays bounded by what is visible. There are no timers: the backend
 * owns freshness.
 *
 * Resource keys name environment ids, which are only unique on their node, so
 * the interest, read queue, connection epoch and tool batches are the scope's,
 * and the projections land in the scope's `changeProjectionStore`. Every
 * export takes an optional trailing `scope`, the app's command scope when
 * omitted; the listener stops when the scope is disposed.
 */

const MAX_CONCURRENT_READS = 6;

type ToolScope = { environmentId: string; provider: string; conversationId: string };

interface PendingBatch extends ToolScope {
  callIds: Set<string>;
}

interface ChangeSubscriptions {
  subscribeChangeResource(resourceKey: string): () => void;
  requestChangeRead(resourceKey: string, joinInFlight?: boolean): void;
  subscribeToolPresentation(scope: ToolScope, callId: string): () => void;
  requestToolPresentation(scope: ToolScope, callId: string, force?: boolean): void;
  reset(): void;
}

/**
 * `listenAuthoritative` on `scope`'s node: the mocked `listen` on the app's
 * command scope. On another scope `def` is heard through the client's typed
 * `listen` (plan item 7011); the reconnect notice, which has no definition,
 * by name.
 */
function listenAuthoritativeInScope<E extends AnyEventDef>(
  scope: NodeScope,
  def: E,
  handler: (event: NativeEvent<unknown>) => unknown,
  options: AuthoritativeListenOptions,
): Promise<UnlistenFn> {
  if (isAppCommandScope(scope)) return listenAuthoritative(def.name, handler, options);
  return listenAuthoritativeWith(
    <P>(name: string, listener: (message: NativeEvent<P>) => unknown) =>
      Promise.resolve(
        name === def.name
          ? scope.client.listen(def, (payload) => listener({ payload: payload as P }))
          : scope.client.listenRaw<P>(name, (payload) => listener({ payload })),
      ),
    def.name,
    handler,
    options,
  );
}

function createChangeSubscriptions(nodeScope: NodeScope): ChangeSubscriptions {
  // Held for the slot's life: the scope is disposed before any late callback.
  const store = nodeScope.store(changeProjectionStore);
  const api = () => backendApiForScope(nodeScope, createChangesApi, backend);

  const interest = new Map<string, number>();
  let listening: Promise<void> | null = null;
  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  let active = 0;
  const queue: string[] = [];
  const queued = new Set<string>();
  /** Advances on every transport resync; fences reads started before it. */
  let connectionEpoch = 0;
  /** Keys with a read in flight, by the connection epoch it started in. */
  const reading = new Map<string, number>();

  const toolInterest = new Map<string, { scope: ToolScope; callId: string; count: number }>();
  const batches = new Map<string, PendingBatch>();
  const requestedTools = new Set<string>();
  let batchScheduled = false;

  nodeScope.onDispose("change-subscriptions", () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  });

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
    const current = store.getState().projections.get(resourceKey);
    const epoch = connectionEpoch;
    reading.set(resourceKey, epoch);
    try {
      const result = await api().getChangeView(
        resourceKey,
        current ? { generation: current.ownerGeneration, revision: current.revision } : undefined,
      );
      // The resync queued a fresh read of every registered key.
      if (epoch !== connectionEpoch || disposed) return;
      if (result.kind === "projection" || result.kind === "reset") {
        if (isChangeProjection(result.projection))
          store.getState().applyProjection(result.projection);
      } else if (result.kind === "deleted") {
        store.getState().markDeleted(resourceKey);
      }
    } catch {
      // An older backend without change tracking, or a transient failure: the
      // components fall back to their legacy presentation.
    } finally {
      if (reading.get(resourceKey) === epoch) reading.delete(resourceKey);
    }
  }

  function requestChangeRead(resourceKey: string, joinInFlight = false): void {
    if (disposed || queued.has(resourceKey)) return;
    if (joinInFlight && reading.get(resourceKey) === connectionEpoch) return;
    queued.add(resourceKey);
    queue.push(resourceKey);
    drain();
  }

  function ensureListening(): Promise<void> {
    if (disposed) return Promise.resolve();
    listening ??= listenAuthoritativeInScope(
      nodeScope,
      changeProjectionChangedEvent,
      (event) => {
        const payload = event.payload;
        if (disposed || !isChangeProjectionEvent(payload)) return;
        const state = store.getState();
        switch (payload.kind) {
          case "projection":
            reconcileToolPresentations();
            if (interest.has(payload.projection.resourceKey))
              state.applyProjection(payload.projection);
            break;
          case "deleted":
            if (interest.has(payload.resourceKey)) state.markDeleted(payload.resourceKey);
            break;
          case "reset":
            if (interest.has(payload.resourceKey)) requestChangeRead(payload.resourceKey);
            break;
          case "content-invalidated":
            state.applyContentInvalidation(
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
          if (disposed) return;
          connectionEpoch++;
          store.getState().resync();
          reconcileToolPresentations();
          for (const key of interest.keys()) requestChangeRead(key);
        },
      },
    ).then(
      (stop) => {
        if (disposed) stop();
        else unlisten = stop;
      },
      () => {
        listening = null;
      },
    );
    return listening;
  }

  function subscribeChangeResource(resourceKey: string): () => void {
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

  function subscribeToolPresentation(scope: ToolScope, callId: string): () => void {
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

  function flushBatches(): void {
    batchScheduled = false;
    if (disposed) return;
    const pending = [...batches.values()];
    batches.clear();
    for (const batch of pending) {
      const callIds = [...batch.callIds];
      for (let index = 0; index < callIds.length; index += 200) {
        const slice = callIds.slice(index, index + 200);
        const epoch = connectionEpoch;
        void api()
          .getToolChangePresentations({
            environmentId: batch.environmentId,
            provider: batch.provider,
            conversationId: batch.conversationId,
            callIds: slice,
          })
          .then((result) => {
            if (epoch !== connectionEpoch || disposed) return;
            const state = store.getState();
            state.applyToolPresentations(
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
              if (isChangeProjection(projection)) state.applyProjection(projection);
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

  function requestToolPresentation(scope: ToolScope, callId: string, force = false): void {
    if (disposed) return;
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

  function reset(): void {
    unlisten?.();
    unlisten = null;
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

  return {
    subscribeChangeResource,
    requestChangeRead,
    subscribeToolPresentation,
    requestToolPresentation,
    reset,
  };
}

const changeSubscriptions = defineScopedSlot("change-subscriptions", createChangeSubscriptions);

/**
 * Queue a read of one resource. `joinInFlight` lets a new consumer share a
 * read already running in this connection epoch; resyncs and resets always
 * read again.
 */
export function requestChangeRead(
  resourceKey: string,
  joinInFlight = false,
  scope: NodeScope = appCommandScope(),
): void {
  changeSubscriptions(scope).requestChangeRead(resourceKey, joinInFlight);
}

/** Register interest in a resource on `scope`'s node; returns the release function. */
export function subscribeChangeResource(
  resourceKey: string,
  scope: NodeScope = appCommandScope(),
): () => void {
  return changeSubscriptions(scope).subscribeChangeResource(resourceKey);
}

// ---------------------------------------------------------------------------
// Tool presentations, batched per conversation
// ---------------------------------------------------------------------------

export function subscribeToolPresentation(
  tool: ToolScope,
  callId: string,
  scope: NodeScope = appCommandScope(),
): () => void {
  return changeSubscriptions(scope).subscribeToolPresentation(tool, callId);
}

/**
 * Ask for a tool row's presentation. Rows of one conversation are batched
 * into one request per tick; a row is requested again when `force` is set
 * (its transcript part changed).
 */
export function requestToolPresentation(
  tool: ToolScope,
  callId: string,
  force = false,
  scope: NodeScope = appCommandScope(),
): void {
  changeSubscriptions(scope).requestToolPresentation(tool, callId, force);
}

/** Test seam: forgets `scope`'s subscriptions (the app's command scope when omitted). */
export function resetChangeSubscriptionsForTests(scope: NodeScope = appCommandScope()): void {
  changeSubscriptions(scope).reset();
}
