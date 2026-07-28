export type UnlistenFn = () => void;

export interface NativeEvent<T> {
  payload: T;
}

export interface ListenOptions {
  /**
   * Cancels both the registered listener and any pending filtered-stream
   * readiness wait. This matters for terminal streams: their gateway
   * connection may retry indefinitely while a tab is already unmounting.
   */
  signal?: AbortSignal;
}

/**
 * Internal lifecycle notification emitted whenever the shared backend event
 * stream has established a fresh connection. Consumers must refetch
 * authoritative state because the transport intentionally has no replay
 * buffer and changes may have happened while it was disconnected.
 */
export const NATIVE_EVENT_STREAM_CONNECTED_EVENT =
  "native-event-stream-connected";

export async function listen<T>(
  event: string,
  handler: (event: NativeEvent<T>) => void,
  options: ListenOptions = {},
): Promise<UnlistenFn> {
  if (!window.orkestrator) {
    return () => {};
  }

  const nativeUnlisten = window.orkestrator.listen<T>(event, (payload) => {
    handler({ payload });
  });
  let listening = true;
  let rejectAbort: ((error: Error) => void) | null = null;
  const abortError = new Error(`Listening for ${event} was cancelled`);
  abortError.name = "AbortError";
  const unlisten = () => {
    if (!listening) return;
    listening = false;
    options.signal?.removeEventListener("abort", onAbort);
    nativeUnlisten();
  };
  const onAbort = () => {
    unlisten();
    rejectAbort?.(abortError);
  };

  if (options.signal?.aborted) {
    onAbort();
    throw abortError;
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const ready = window.orkestrator.eventStreamReady?.(event);
    if (ready) {
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          rejectAbort = reject;
        }),
      ]);
    }
  } catch (error) {
    unlisten();
    throw error;
  } finally {
    rejectAbort = null;
  }
  return unlisten;
}
