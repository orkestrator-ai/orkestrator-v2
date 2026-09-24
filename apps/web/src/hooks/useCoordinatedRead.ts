import { useCallback, useEffect, useRef, useState } from "react";
import {
  getReadCoordinator,
  readKeyId,
  type ReadCoordinator,
  type ReadDemand,
  type ReadErrorKind,
  type ReadFunction,
  type ReadKey,
  type ReadState,
  type ReadSubscription,
} from "@/lib/read-coordinator";

export interface UseCoordinatedReadOptions<T> {
  key: ReadKey;
  /** Latest closure is always used; changing it does not resubscribe. */
  read: ReadFunction<T>;
  /** `false` removes the subscription entirely (no demand, no explicit reads). */
  enabled?: boolean;
  demand?: ReadDemand;
  /** See `ReadSubscriptionOptions.readOnSubscribe`. Defaults to `true`. */
  readOnSubscribe?: boolean;
  classifyError?: (error: unknown) => ReadErrorKind;
  /** Called on every state change of this subscription. */
  onState?: (state: ReadState<T>) => void;
  /**
   * Mirror state into React state (rerenders on every change, including the
   * `loading` transition). Off by default so side-effecting consumers do not
   * pay for rerenders they do not use.
   */
  trackState?: boolean;
  /** Injection seam for tests; defaults to the shared coordinator. */
  coordinator?: ReadCoordinator;
}

export interface CoordinatedRead<T> {
  /** Last observed state when `trackState` is on; otherwise `null`. */
  state: ReadState<T> | null;
  /**
   * Explicit refresh: resolves after a read that started after the call.
   * Resolves `null` when the subscription is disabled.
   */
  refresh: () => Promise<ReadState<T> | null>;
  /** Invalidation hint; coalesced, joined and deferred while hidden. */
  invalidate: () => void;
}

/**
 * Subscribes a component to the shared read coordinator.
 *
 * The subscription is keyed by `readKeyId(key)`: a key change disposes the old
 * subscription (its late results no longer reach this component) and
 * subscribes the new one. Demand updates in place without resubscribing.
 *
 * ```tsx
 * const { state, refresh } = useCoordinatedRead({
 *   key: { resource: "system-usage", target: backendScope, options: diskTarget },
 *   demand: { intervalMs: open ? 3_000 : 5_000, priority: "auxiliary" },
 *   read: () => getSystemUsage(diskTarget),
 *   trackState: true,
 * });
 * ```
 */
export function useCoordinatedRead<T>({
  key,
  read,
  enabled = true,
  demand,
  readOnSubscribe = true,
  classifyError,
  onState,
  trackState = false,
  coordinator: injectedCoordinator,
}: UseCoordinatedReadOptions<T>): CoordinatedRead<T> {
  const coordinator = injectedCoordinator ?? getReadCoordinator();
  const keyId = readKeyId(key);
  const [state, setState] = useState<ReadState<T> | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const readRef = useRef(read);
  readRef.current = read;
  const demandRef = useRef(demand);
  demandRef.current = demand;
  const classifyRef = useRef(classifyError);
  classifyRef.current = classifyError;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const handleRef = useRef<ReadSubscription<T> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    const handle = coordinator.subscribe<T>({
      key: keyRef.current,
      read: (context) => readRef.current(context),
      demand: demandRef.current,
      readOnSubscribe,
      ...(classifyRef.current ? { classifyError: (error) => classifyRef.current!(error) } : {}),
      onState: (next) => {
        onStateRef.current?.(next);
        if (trackState) setState(next);
      },
    });
    handleRef.current = handle;
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      handle.dispose();
    };
  }, [coordinator, enabled, keyId, readOnSubscribe, trackState]);

  const active = demand?.active;
  const intervalMs = demand?.intervalMs;
  const priority = demand?.priority;
  const quietBackoff = demand?.quietBackoffMs?.join(",") ?? "";
  useEffect(() => {
    handleRef.current?.update({ demand: demandRef.current });
  }, [active, intervalMs, priority, quietBackoff]);

  const refresh = useCallback(
    () => (handleRef.current ? handleRef.current.refresh() : Promise.resolve(null)),
    [],
  );
  const invalidate = useCallback(() => handleRef.current?.invalidate(), []);

  return { state, refresh, invalidate };
}
