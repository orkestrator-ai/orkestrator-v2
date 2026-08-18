import { describe, expect, mock, test } from "bun:test";
import { startApp } from "./app-startup";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledTimer() {
  let callback: (() => void) | undefined;
  const handle = {};
  const set = mock((nextCallback: () => void, _delayMs: number) => {
    callback = nextCallback;
    return handle;
  });
  const clear = mock((_handle: unknown) => {});
  return {
    timer: { set, clear },
    fire: () => callback?.(),
    handle,
    set,
    clear,
  };
}

describe("startApp", () => {
  test("hydrates before rendering and clears the pending timeout", async () => {
    const order: string[] = [];
    const timer = controlledTimer();

    await startApp({
      hydrate: async () => {
        order.push("hydrate");
      },
      render: () => {
        order.push("render");
      },
      timer: timer.timer,
    });

    expect(order).toEqual(["hydrate", "render"]);
    expect(timer.set).toHaveBeenCalledWith(expect.any(Function), 2_000);
    expect(timer.clear).toHaveBeenCalledWith(timer.handle);
  });

  test("warns and still renders when hydration rejects", async () => {
    const error = new Error("cache unavailable");
    const render = mock(() => {});
    const warn = mock((_message: string, _error: unknown) => {});
    const timer = controlledTimer();

    await startApp({
      hydrate: () => Promise.reject(error),
      render,
      timer: timer.timer,
      warn,
    });

    expect(warn).toHaveBeenCalledWith("[App] Failed to restore the model catalogue cache:", error);
    expect(timer.clear).toHaveBeenCalledWith(timer.handle);
    expect(render).toHaveBeenCalledTimes(1);
  });

  test("renders after the timeout while allowing late hydration to finish", async () => {
    const hydration = deferred<void>();
    const render = mock(() => {});
    const timer = controlledTimer();
    let hydrationFinished = false;
    const startup = startApp({
      hydrate: async () => {
        await hydration.promise;
        hydrationFinished = true;
      },
      render,
      timeoutMs: 25,
      timer: timer.timer,
    });

    expect(render).not.toHaveBeenCalled();
    expect(timer.set).toHaveBeenCalledWith(expect.any(Function), 25);
    timer.fire();
    await startup;

    expect(timer.clear).toHaveBeenCalledWith(timer.handle);
    expect(render).toHaveBeenCalledTimes(1);
    expect(hydrationFinished).toBe(false);

    hydration.resolve();
    await hydration.promise;
    await Promise.resolve();

    expect(hydrationFinished).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
