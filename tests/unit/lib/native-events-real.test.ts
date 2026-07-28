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

  test("waits until a dedicated event stream is ready before resolving", async () => {
    const { listen } = await loadNativeEvents();
    const unlisten = mock(() => undefined);
    let resolveReady: (() => void) | undefined;
    const eventStreamReady = mock(
      () => new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
    );
    window.orkestrator = {
      listen: mock(() => unlisten),
      eventStreamReady,
    } as never;

    let settled = false;
    const pending = listen("terminal-output-session-1", mock(() => undefined))
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(eventStreamReady).toHaveBeenCalledWith("terminal-output-session-1");

    resolveReady?.();
    expect(await pending).toBe(unlisten);
  });

  test("unsubscribes when dedicated event stream setup fails", async () => {
    const { listen } = await loadNativeEvents();
    const unlisten = mock(() => undefined);
    window.orkestrator = {
      listen: mock(() => unlisten),
      eventStreamReady: mock(async () => {
        throw new Error("stream unavailable");
      }),
    } as never;

    await expect(
      listen("terminal-output-session-1", mock(() => undefined)),
    ).rejects.toThrow("stream unavailable");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
