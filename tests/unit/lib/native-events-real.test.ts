import { afterEach, describe, expect, mock, test } from "bun:test";

async function loadNativeEvents() {
  return import("../../../apps/web/src/lib/native/events.ts?real") as Promise<typeof import("../../../apps/web/src/lib/native/events")>;
}

afterEach(() => {
  delete window.orkestrator;
});

describe("native event wrapper", () => {
  test("wraps preload payloads in NativeEvent objects", async () => {
    const { listen } = await loadNativeEvents();
    const unlisten = mock(() => undefined);
    const preloadListen = mock((_event: string, callback: (payload: unknown) => void) => {
      callback({ value: 42 });
      return unlisten;
    });
    window.orkestrator = { listen: preloadListen } as never;

    const handler = mock(() => undefined);
    const returnedUnlisten = await listen("environment-updated", handler);

    expect(preloadListen).toHaveBeenCalledWith("environment-updated", expect.any(Function));
    expect(handler).toHaveBeenCalledWith({ payload: { value: 42 } });
    returnedUnlisten();
    expect(unlisten).toHaveBeenCalled();
  });

  test("returns a no-op unlisten function without a preload bridge", async () => {
    const { listen } = await loadNativeEvents();
    const unlisten = await listen("event", mock(() => undefined));
    expect(unlisten()).toBeUndefined();
  });
});
