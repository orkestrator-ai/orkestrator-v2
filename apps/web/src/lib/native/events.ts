export type UnlistenFn = () => void;

export interface NativeEvent<T> {
  payload: T;
}

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
