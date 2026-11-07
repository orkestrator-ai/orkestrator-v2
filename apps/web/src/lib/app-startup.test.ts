import { describe, expect, mock, spyOn, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
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
      seed: async () => {
        order.push("seed");
      },
      render: () => {
        order.push("render");
      },
      timer: timer.timer,
    });

    expect(order).toEqual(["hydrate", "render"]);
    for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
    expect(order).toEqual(["hydrate", "render", "seed"]);
    expect(timer.set).toHaveBeenCalledWith(expect.any(Function), 2_000);
    expect(timer.clear).toHaveBeenCalledWith(timer.handle);
  });

  test("warns and still renders when hydration rejects", async () => {
    const error = new Error("cache unavailable");
    const render = mock(() => {});
    const logs = captureLogs();
    const timer = controlledTimer();

    await startApp({
      hydrate: () => Promise.reject(error),
      seed: async () => {},
      render,
      timer: timer.timer,
    });

    expect(logs.records().map(({ level, area, event }) => [level, area, event])).toEqual([
      ["warn", "web.startup", "model-catalogue.restore-failed"],
    ]);
    logs.restore();
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
      seed: async () => {},
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

  test("renders before a slow seed resolves, and the seed then updates the stores", async () => {
    const seed = deferred<void>();
    const order: string[] = [];
    let seeded = false;
    await startApp({
      hydrate: async () => {
        order.push("cached-read");
      },
      seed: async () => {
        order.push("seed-started");
        await seed.promise;
        seeded = true;
      },
      render: () => {
        order.push("render");
      },
      timer: controlledTimer().timer,
    });

    expect(order).toEqual(["cached-read", "render"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["cached-read", "render", "seed-started"]);
    expect(seeded).toBe(false);

    seed.resolve();
    await seed.promise;
    await Promise.resolve();
    expect(seeded).toBe(true);
  });

  test("renders from the cached read when the seed fails, and warns once", async () => {
    const render = mock(() => {});
    const logs = captureLogs();
    try {
      await startApp({
        hydrate: async () => {},
        seed: () => Promise.reject(new Error("grok returned an empty model catalogue")),
        render,
        timer: controlledTimer().timer,
      });
      expect(render).toHaveBeenCalledTimes(1);
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
      expect(logs.records().map(({ level, event }) => [level, event])).toEqual([
        ["warn", "model-catalogue.seed-failed"],
      ]);
      expect(render).toHaveBeenCalledTimes(1);
    } finally {
      logs.restore();
    }
  });

  test("starts the seed once after timeout and does not repeat it when the read settles", async () => {
    const read = deferred<void>();
    const seed = mock(async () => {});
    const render = mock(() => {});
    const timer = controlledTimer();
    const startup = startApp({ hydrate: () => read.promise, seed, render, timer: timer.timer });

    await Promise.resolve();
    timer.fire();
    await startup;
    expect(render).toHaveBeenCalledTimes(1);
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    expect(seed).toHaveBeenCalledTimes(1);

    read.resolve();
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    expect(seed).toHaveBeenCalledTimes(1);
  });

  test("a never-settling cached read cannot suppress rendering or background seeding", async () => {
    const order: string[] = [];
    const timer = controlledTimer();
    const startup = startApp({
      hydrate: () => new Promise<void>(() => {}),
      seed: async () => {
        order.push("seed");
      },
      render: () => {
        order.push("render");
      },
      timer: timer.timer,
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    timer.fire();
    await startup;
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    expect(order).toEqual(["render", "seed"]);
    expect(timer.clear).toHaveBeenCalledWith(timer.handle);
  });

  test("the default first read asks for the stored cache only", async () => {
    const backend = await import("@/lib/backend");
    const calls: unknown[] = [];
    const spy = spyOn(backend, "getAgentModelCatalogCache").mockImplementation(
      async (_machine, options) => {
        calls.push(options);
        // The seed never answers: render must not wait for it.
        return options?.seed === true ? new Promise(() => {}) : { schemaVersion: 1 as const };
      },
    );
    const render = mock(() => {});
    try {
      await startApp({ render, timer: controlledTimer().timer });
      expect(render).toHaveBeenCalledTimes(1);
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
      expect(calls).toEqual([{ seed: false }, { seed: true }]);
    } finally {
      spy.mockRestore();
    }
  });
});
