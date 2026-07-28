import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// `tests/setup.ts` replaces `@/lib/native/events` with a fake for the whole
// suite, and Bun keys that mock by resolved path — so a plain `./events`
// import here would hand back the fake, not the code under test. A query
// suffix resolves to the same file through a different module key, which is
// the only way to exercise the real implementation without unmocking a module
// dozens of other suites rely on. The specifier is built at runtime because
// TypeScript cannot resolve the suffixed path statically.
const realEventsModulePath = "./events.ts?real";
const { listen, NATIVE_EVENT_STREAM_READY_TIMEOUT_MS } =
  (await import(realEventsModulePath)) as typeof import("./events");

type NativeApi = NonNullable<Window["orkestrator"]>;

const nativeUnlisten = mock(() => undefined);
let registered: Array<{ event: string; callback: (payload: unknown) => void }>;
let readyResult: (() => Promise<void>) | undefined;

function installNativeApi(): void {
  registered = [];
  window.orkestrator = {
    listen: ((event: string, callback: (payload: unknown) => void) => {
      registered.push({ event, callback });
      return nativeUnlisten;
    }) as NativeApi["listen"],
    eventStreamReady: (() => readyResult?.()) as NativeApi["eventStreamReady"],
  } as NativeApi;
}

/** Spies on abort-listener removal without replacing the real signal. */
function trackAbortListeners(signal: AbortSignal): {
  added: string[];
  removed: string[];
} {
  const added: string[] = [];
  const removed: string[] = [];
  const realAdd = signal.addEventListener.bind(signal);
  const realRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, ...rest: unknown[]) => {
    added.push(type);
    return (realAdd as (...args: unknown[]) => void)(type, ...rest);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
    removed.push(type);
    return (realRemove as (...args: unknown[]) => void)(type, ...rest);
  }) as AbortSignal["removeEventListener"];
  return { added, removed };
}

beforeEach(() => {
  nativeUnlisten.mockClear();
  readyResult = undefined;
  installNativeApi();
});

afterEach(() => {
  delete window.orkestrator;
});

describe("listen", () => {
  test("resolves to a no-op when no native API is installed", async () => {
    delete window.orkestrator;
    const unlisten = await listen("terminal-output-session-1", () => {});
    expect(() => unlisten()).not.toThrow();
  });

  test("removes the native listener and throws when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    readyResult = () => new Promise<void>(() => {});

    await expect(
      listen("terminal-output-session-1", () => {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // The native registration happens before the aborted check, so the only
    // thing standing between an already-cancelled caller and a leaked backend
    // subscription is this unlisten.
    expect(nativeUnlisten).toHaveBeenCalledTimes(1);
    // Readiness must never even be consulted for a caller that already gave up.
    expect(registered).toHaveLength(1);
  });

  test("detaches its abort listener once the caller unlistens", async () => {
    const controller = new AbortController();
    const tracked = trackAbortListeners(controller.signal);

    const unlisten = await listen("menu-zoom", () => {}, {
      signal: controller.signal,
    });
    expect(tracked.added).toEqual(["abort"]);
    expect(tracked.removed).toEqual([]);

    unlisten();
    expect(tracked.removed).toEqual(["abort"]);
    expect(nativeUnlisten).toHaveBeenCalledTimes(1);

    // A long-lived signal aborting later must not reach a listener that has
    // already been torn down — that retained closure is the leak this cleanup
    // exists to prevent.
    controller.abort();
    expect(nativeUnlisten).toHaveBeenCalledTimes(1);
  });

  test("cancels a pending readiness wait when the signal aborts", async () => {
    const controller = new AbortController();
    readyResult = () => new Promise<void>(() => {});

    const pending = listen("terminal-output-session-1", () => {}, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(nativeUnlisten).toHaveBeenCalledTimes(1);
  });

  test("proceeds when a filtered stream never becomes ready", async () => {
    // The gateway retries a failed per-terminal stream forever, so its
    // readiness promise can stay pending indefinitely. Callers that await
    // listen() before starting their real work (useTerminal creates the PTY,
    // then starts it) must not be stranded there.
    readyResult = () => new Promise<void>(() => {});
    const received: unknown[] = [];

    const unlisten = await listen<string>(
      "terminal-output-session-1",
      (event) => received.push(event.payload),
      { readyTimeoutMs: 0 },
    );

    // The listener is live regardless: whatever the stream missed is repaired
    // by the consumer's desync/revision-gap reconcile once it recovers.
    registered[0]?.callback("late-output");
    expect(received).toEqual(["late-output"]);
    unlisten();
    expect(nativeUnlisten).toHaveBeenCalledTimes(1);
  });

  test("waits for readiness rather than timing out when the stream connects", async () => {
    let resolveReady: () => void = () => {};
    readyResult = () => new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    let settled = false;

    const pending = listen("terminal-output-session-1", () => {}, {
      readyTimeoutMs: 60_000,
    }).then((unlisten) => {
      settled = true;
      return unlisten;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveReady();
    await pending;
    expect(settled).toBe(true);
  });

  test("uses a bounded default readiness timeout", () => {
    expect(NATIVE_EVENT_STREAM_READY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(NATIVE_EVENT_STREAM_READY_TIMEOUT_MS)).toBe(true);
  });

  test("removes the native listener when readiness rejects", async () => {
    readyResult = () => Promise.reject(new Error("stream unavailable"));

    await expect(listen("terminal-output-session-1", () => {})).rejects.toThrow(
      "stream unavailable",
    );
    expect(nativeUnlisten).toHaveBeenCalledTimes(1);
  });
});
