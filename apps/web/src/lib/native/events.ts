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
  /**
   * Upper bound on the filtered-stream readiness wait. Injectable so tests do
   * not have to burn real time.
   */
  readyTimeoutMs?: number;
}

/**
 * How long to wait for a filtered (per-terminal) gateway stream to connect
 * before proceeding anyway.
 *
 * The gateway retries a failed filtered stream forever, so its readiness
 * promise can stay pending indefinitely — which would strand every caller that
 * awaits `listen()` before doing its real work (`useTerminal` creates the PTY
 * and only then starts it). Giving up on the wait is safe: the listener is
 * already registered, and the consumer's revision-gap/desync reconcile path
 * repairs whatever was missed once the stream does come up.
 */
export const NATIVE_EVENT_STREAM_READY_TIMEOUT_MS = 5_000;

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

  let readyTimeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const ready = window.orkestrator.eventStreamReady?.(event);
    if (ready) {
      await Promise.race([
        ready,
        // Resolves rather than rejects: a stream that has not come up yet is
        // not a reason to refuse to listen, and the caller's reconcile path
        // covers the gap.
        new Promise<void>((resolve) => {
          readyTimeout = setTimeout(
            resolve,
            options.readyTimeoutMs ?? NATIVE_EVENT_STREAM_READY_TIMEOUT_MS,
          );
        }),
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
    if (readyTimeout) clearTimeout(readyTimeout);
  }
  return unlisten;
}
