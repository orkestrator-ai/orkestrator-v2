export type UnlistenFn = () => void;

export interface NativeEvent<T> {
  payload: T;
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
): Promise<UnlistenFn> {
  if (!window.orkestrator) {
    return () => {};
  }

  return window.orkestrator.listen<T>(event, (payload) => {
    handler({ payload });
  });
}
