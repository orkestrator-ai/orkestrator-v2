import { afterEach, describe, expect, mock, test } from "bun:test";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { listenAuthoritative } from "./authoritative-events";

// `@/lib/native/events` is mocked for every renderer test in tests/setup.ts.
const listenMock = listen as unknown as ReturnType<typeof mock>;
const originalError = console.error;

afterEach(() => {
  listenMock.mockReset();
  listenMock.mockImplementation(() => Promise.resolve(() => undefined));
  console.error = originalError;
});

describe("listenAuthoritative", () => {
  test("subscribes to the event and its resync signal and releases both", async () => {
    const released: string[] = [];
    const callbacks = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation(async (event: string, callback) => {
      callbacks.set(event, callback);
      return () => released.push(event);
    });
    const onResync = mock(() => undefined);
    const handler = mock(() => undefined);

    const unlisten = await listenAuthoritative("changed", handler, { onResync });
    callbacks.get("changed")!({ payload: 1 });
    callbacks.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)!({ payload: undefined });
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith({ payload: 1 });
    expect(onResync).toHaveBeenCalledTimes(1);

    unlisten();
    expect(released).toEqual(["changed", NATIVE_EVENT_STREAM_CONNECTED_EVENT]);
  });

  test("releases the resync listener when the event subscription fails", async () => {
    const released = mock(() => undefined);
    listenMock.mockImplementation(async (event: string) => {
      if (event === "changed") throw new Error("no stream");
      return released;
    });
    await expect(
      listenAuthoritative("changed", () => undefined, { onResync: () => undefined }),
    ).rejects.toThrow("no stream");
    expect(released).toHaveBeenCalledTimes(1);
  });

  test("defers resync during event readiness until the incremental listener is subscribed", async () => {
    let resync!: () => void;
    let ready!: (unlisten: () => void) => void;
    const onResync = mock(() => undefined);
    listenMock.mockImplementation((event: string, callback) => {
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) {
        resync = callback;
        return Promise.resolve(() => undefined);
      }
      return new Promise((resolve) => {
        ready = resolve;
      });
    });
    const subscription = listenAuthoritative("changed", () => undefined, { onResync });
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    resync();
    resync();
    expect(onResync).not.toHaveBeenCalled();
    ready(() => undefined);
    const unlisten = await subscription;
    await Promise.resolve();
    expect(onResync).toHaveBeenCalledTimes(1);
    unlisten();
    resync();
    await Promise.resolve();
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  test("initial snapshot does not depend on a stream announcement for late subscribers", async () => {
    const onResync = mock(() => undefined);
    const unlisten = await listenAuthoritative("changed", () => undefined, {
      onResync,
      resyncOnSubscribe: true,
    });
    await Promise.resolve();
    expect(onResync).toHaveBeenCalledTimes(1);
    unlisten();
  });

  test("reports a failed refetch instead of leaving an unhandled rejection", async () => {
    let resync: ((event: { payload: unknown }) => void) | undefined;
    listenMock.mockImplementation(async (event: string, callback) => {
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) resync = callback;
      return () => undefined;
    });
    const logged = mock(() => undefined);
    console.error = logged;
    let attempts = 0;
    const recovered = mock(() => undefined);
    await listenAuthoritative("changed", () => undefined, {
      onResync: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("snapshot unavailable");
        recovered();
      },
    });
    resync!({ payload: undefined });
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(logged).toHaveBeenCalledTimes(1);
    resync!({ payload: undefined });
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(recovered).toHaveBeenCalledTimes(1);
  });
});
