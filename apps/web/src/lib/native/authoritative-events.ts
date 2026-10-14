import {
  listen,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
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
export async function listenAuthoritative<T>(
  event: string,
  handler: (event: NativeEvent<T>) => unknown,
  options: AuthoritativeListenOptions,
): Promise<UnlistenFn> {
  const listenOptions = options.signal ? [{ signal: options.signal }] : [];
  const unlistenEvent = await listen<T>(event, handler, ...listenOptions);
  let unlistenResync: UnlistenFn;
  try {
    unlistenResync = await listen<undefined>(
      NATIVE_EVENT_STREAM_CONNECTED_EVENT,
      () => {
        void Promise.resolve()
          .then(options.onResync)
          .catch((error: unknown) => {
            console.error(`[events] Resync for ${event} failed:`, error);
          });
      },
      ...listenOptions,
    );
  } catch (error) {
    unlistenEvent();
    throw error;
  }
  return () => {
    unlistenEvent();
    unlistenResync();
  };
}
