import {
  listen,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  type ListenOptions,
  type NativeEvent,
  type UnlistenFn,
} from "@/lib/native/events";

export interface AuthoritativeListenOptions {
  /**
   * Re-reads the authoritative snapshot this event incrementally updates. Runs
   * whenever the transport reports that events may have been missed.
   */
  onResync: () => unknown;
  signal?: AbortSignal;
  /** Reads an initial snapshot after both subscriptions are ready. */
  resyncOnSubscribe?: boolean;
}

/**
 * Subscribes to an incremental event together with the transport's resync
 * signal, so the refetch cannot be forgotten.
 *
 * Live events are increments over an authoritative snapshot, never the only
 * source of truth. The gateway replays short disconnects, but once a cursor
 * falls outside its replay ring the missed events are gone, and a consumer
 * that only applies events stays stale until the next one arrives.
 */
export function listenAuthoritative<T>(
  event: string,
  handler: (event: NativeEvent<T>) => unknown,
  options: AuthoritativeListenOptions,
): Promise<UnlistenFn> {
  return listenAuthoritativeWith(listen, event, handler, options);
}

type ListenFn = <T>(
  event: string,
  handler: (event: NativeEvent<T>) => unknown,
  options?: ListenOptions,
) => Promise<UnlistenFn>;

/** `listenAuthoritative` over an explicit `listen` (the portal's, for example). */
export async function listenAuthoritativeWith<T>(
  subscribe: ListenFn,
  event: string,
  handler: (event: NativeEvent<T>) => unknown,
  options: AuthoritativeListenOptions,
): Promise<UnlistenFn> {
  const listenOptions = options.signal ? [{ signal: options.signal }] : [];
  let ready = false;
  let disposed = false;
  let pendingResync = false;
  const resync = () => {
    if (disposed || options.signal?.aborted) return;
    if (!ready) {
      pendingResync = true;
      return;
    }
    void Promise.resolve()
      .then(() => {
        if (!disposed && !options.signal?.aborted) return options.onResync();
      })
      .catch((error: unknown) => {
        console.error(`[events] Resync for ${event} failed:`, error);
      });
  };
  // Install recovery first so a handshake while event readiness is pending
  // cannot disappear. Defer its read until the incremental listener is ready.
  const unlistenResync = await subscribe<undefined>(
    NATIVE_EVENT_STREAM_CONNECTED_EVENT,
    resync,
    ...listenOptions,
  );
  let unlistenEvent: UnlistenFn;
  try {
    unlistenEvent = await subscribe<T>(event, handler, ...listenOptions);
  } catch (error) {
    disposed = true;
    unlistenResync();
    throw error;
  }
  ready = true;
  if (pendingResync || options.resyncOnSubscribe) resync();
  return () => {
    disposed = true;
    unlistenEvent();
    unlistenResync();
  };
}
