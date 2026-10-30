import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { DesignProfileLedger } from "./browser-profiles.js";
import { DesignError } from "./errors.js";
import { DesignRenderQueue } from "./render-queue.js";
import {
  DEFAULT_DESIGN_RENDER_BUDGETS,
  DesignRenderer,
  launchDesignBrowser,
  resolveDesignChromiumPath,
  type DesignBrowserHandle,
  type DesignRenderBudgets,
  type DesignRenderJob,
} from "./renderer.js";

const frame = { html: "<p>Hello</p>", width: 320, height: 240 };

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on("unhandledRejection", onUnhandled);
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
});

const renderers: DesignRenderer[] = [];
afterEach(async () => {
  await Promise.all(renderers.splice(0).map((renderer) => renderer.close()));
  // Let any late microtasks surface before asserting nothing went unhandled.
  await Bun.sleep(5);
  expect(unhandled).toEqual([]);
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const never = () => new Promise<never>(() => {});

type Operation = { op: string; html?: string };

interface FakeOptions {
  /** Runtime behavior per operation; the page tracks the last rendered html. */
  evaluate?: (operation: Operation, rendered: string) => unknown;
  newContext?: () => Promise<void> | void;
  contextClose?: () => Promise<void>;
  browserClose?: () => Promise<void>;
  screenshot?: () => Buffer;
}

function fakeBrowser(options: FakeOptions = {}) {
  const handlers = new Map<string, Array<() => void>>();
  const abort = mock(() => {});
  const kill = mock(async () => {});
  const contextClose = mock(() => options.contextClose?.() ?? Promise.resolve());
  const contextOptions: unknown[] = [];
  const screenshotOptions: unknown[] = [];
  const evaluated: Operation[] = [];
  const newContext = mock(async (contextOption: unknown) => {
    contextOptions.push(contextOption);
    await options.newContext?.();
    let rendered = "";
    const page = {
      setDefaultTimeout() {},
      setContent: mock(async () => {}),
      evaluate: mock(async (_fn: unknown, argument: unknown) => {
        if (typeof argument === "number") return undefined; // asset wait
        const operation = argument as Operation;
        evaluated.push(operation);
        if (operation.op === "render") rendered = operation.html ?? "";
        const value = options.evaluate
          ? await options.evaluate(operation, rendered)
          : operation.op === "render"
            ? true
            : rendered;
        if (value instanceof Error) return { ok: false, message: value.message };
        return { ok: true, value };
      }),
      screenshot: mock(async (screenshotOption: unknown) => {
        screenshotOptions.push(screenshotOption);
        return options.screenshot?.() ?? Buffer.from("png");
      }),
    };
    return {
      close: contextClose,
      route: mock(async (_pattern: string, handler: (route: { abort: () => void }) => void) => {
        handler({ abort });
      }),
      newPage: mock(async () => page),
    };
  });
  const close = mock(() => options.browserClose?.() ?? Promise.resolve());
  const browser = {
    once: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    newContext,
  } as unknown as Browser;
  const handle: DesignBrowserHandle = { browser, close, kill };
  const disconnect = () => {
    const list = handlers.get("disconnected") ?? [];
    handlers.delete("disconnected");
    for (const handler of list) handler();
  };
  return {
    handle,
    abort,
    kill,
    close,
    contextClose,
    newContext,
    contextOptions,
    screenshotOptions,
    evaluated,
    disconnect,
  };
}

function launcher(...handles: Array<DesignBrowserHandle | (() => Promise<DesignBrowserHandle>)>) {
  let index = 0;
  return mock(async () => {
    const next = handles[Math.min(index++, handles.length - 1)]!;
    return typeof next === "function" ? next() : next;
  });
}

function renderer(
  launch: ReturnType<typeof launcher>,
  options: {
    budgets?: Partial<DesignRenderBudgets>;
    maxJobs?: number;
    workers?: number;
    healthCacheMs?: number;
    executablePath?: () => string | undefined;
  } = {},
) {
  const instance = new DesignRenderer({
    launchBrowser: launch as never,
    executablePath: options.executablePath ?? (() => "/chromium"),
    ...options,
  });
  renderers.push(instance);
  return instance;
}

function job(overrides: Partial<DesignRenderJob> = {}): DesignRenderJob {
  return {
    environmentId: "env-a",
    canvasId: "canvas-1",
    priority: "interactive",
    frame,
    operation: { op: "serialize" },
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<DesignError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DesignError) return error;
    throw error;
  }
  throw new Error("expected rejection");
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met");
    await Bun.sleep(1);
  }
}

describe("resolveDesignChromiumPath", () => {
  test("returns undefined for a missing configured path and honors an existing one", () => {
    expect(
      resolveDesignChromiumPath(
        { ORKESTRATOR_DESIGN_CHROMIUM_PATH: "/definitely/missing/chromium" },
        [],
      ),
    ).toBeUndefined();
    expect(resolveDesignChromiumPath({ ORKESTRATOR_DESIGN_CHROMIUM_PATH: process.execPath })).toBe(
      process.execPath,
    );
  });
});

describe("DesignRenderer isolation and results", () => {
  test("isolates each job and passes deterministic capture inputs", async () => {
    const fake = fakeBrowser();
    const launch = launcher(fake.handle);
    const instance = renderer(launch);
    expect(await instance.run<string>(job())).toBe(frame.html);
    const capture = await instance.run<{ mimeType: string; data: string }>(
      job({ operation: { op: "capture" } }),
    );
    expect(capture).toEqual({ mimeType: "image/png", data: Buffer.from("png").toString("base64") });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(fake.newContext).toHaveBeenCalledTimes(2);
    expect(fake.contextClose).toHaveBeenCalledTimes(2);
    expect(fake.abort).toHaveBeenCalled();
    expect(fake.contextOptions[0]).toEqual({
      viewport: { width: 320, height: 240 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    expect(fake.screenshotOptions[0]).toMatchObject({ type: "png", animations: "disabled" });
  });

  test("rejects oversized captures before encoding", async () => {
    const fake = fakeBrowser({ screenshot: () => Buffer.alloc(8 * 1024 * 1024 + 1) });
    const instance = renderer(launcher(fake.handle));
    const error = await failure(instance.run(job({ operation: { op: "capture" } })));
    expect(error.code).toBe("invalid-content");
    expect(error.message).toBe("Capture exceeds 8 MiB");
    expect(fake.contextClose).toHaveBeenCalled();
  });

  test("passes runtime messages through unchanged as plain errors", async () => {
    const fake = fakeBrowser({
      evaluate: (operation) =>
        operation.op === "inspectElement"
          ? new Error("Selector must match exactly one element")
          : true,
    });
    const instance = renderer(launcher(fake.handle));
    const rejection = instance.run(job({ operation: { op: "inspectElement", selector: "p" } }));
    await expect(rejection).rejects.toThrow("Selector must match exactly one element");
    const error = await rejection.catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(DesignError);
    expect((error as Error).message).toBe("Selector must match exactly one element");
  });

  test("rejects oversized requests before admission", async () => {
    const launch = launcher(fakeBrowser().handle);
    const instance = renderer(launch);
    const error = await failure(
      instance.run(job({ frame: { ...frame, html: "x".repeat(256 * 1024 + 1) } })),
    );
    expect(error.code).toBe("invalid-content");
    expect(launch).not.toHaveBeenCalled();
    expect(instance.status().queued).toBe(0);
  });
});

describe("DesignRenderer admission and scheduling", () => {
  test("rejects beyond maxJobs with retry guidance and recovers after draining", async () => {
    const gate = deferred();
    const fake = fakeBrowser({
      evaluate: async (operation, rendered) => {
        if (operation.op === "serialize") await gate.promise;
        return operation.op === "render" ? true : rendered;
      },
    });
    const instance = renderer(launcher(fake.handle));
    const pending = Array.from({ length: 16 }, () => instance.run(job()));
    const error = await failure(instance.run(job()));
    expect(error.code).toBe("capacity");
    expect(error.failure.retryAfterMs).toBeGreaterThan(0);
    const health = instance.status();
    expect(health.state).toBe("saturated");
    expect(health.ready).toBe(true);
    expect(health.queued + health.running).toBe(16);
    gate.resolve();
    await expect(Promise.all(pending)).resolves.toHaveLength(16);
    await expect(instance.run(job())).resolves.toBe(frame.html);
  });

  test("serves a second environment before a flooding environment drains", async () => {
    const gate = deferred();
    const completed: string[] = [];
    let first = true;
    const fake = fakeBrowser({
      evaluate: async (operation, rendered) => {
        if (operation.op === "render") return true;
        if (first) {
          first = false;
          await gate.promise;
        }
        return rendered;
      },
    });
    const instance = renderer(launcher(fake.handle));
    const record = (name: string, promise: Promise<unknown>) =>
      promise.then(() => {
        completed.push(name);
      });
    const flood = Array.from({ length: 10 }, (_, index) =>
      record(
        `a${index}`,
        instance.run(job({ frame: { ...frame, html: `<p>a${index}</p>` }, canvasId: `c${index}` })),
      ),
    );
    await waitFor(() => fake.evaluated.some((operation) => operation.op === "serialize"));
    const other = record(
      "b",
      instance.run(job({ environmentId: "env-b", frame: { ...frame, html: "<p>b</p>" } })),
    );
    gate.resolve();
    await Promise.all([...flood, other]);
    expect(completed.indexOf("b")).toBeLessThanOrEqual(1);
    expect(completed).toHaveLength(11);
  });

  test("prefers interactive work over queued background work", async () => {
    const gate = deferred();
    const order: string[] = [];
    let first = true;
    const fake = fakeBrowser({
      evaluate: async (operation, rendered) => {
        if (operation.op === "render") return true;
        if (first) {
          first = false;
          await gate.promise;
        }
        order.push(rendered);
        return rendered;
      },
    });
    const instance = renderer(launcher(fake.handle));
    const blocker = instance.run(job({ frame: { ...frame, html: "blocker" } }));
    await waitFor(() => fake.evaluated.some((operation) => operation.op === "serialize"));
    const background = instance.run(
      job({ priority: "background", environmentId: "env-b", frame: { ...frame, html: "bg" } }),
    );
    const interactive = instance.run(
      job({ priority: "interactive", environmentId: "env-c", frame: { ...frame, html: "ui" } }),
    );
    gate.resolve();
    await Promise.all([blocker, background, interactive]);
    expect(order).toEqual(["blocker", "ui", "bg"]);
  });

  test("ages waiting jobs so background work cannot starve", () => {
    const queue = new DesignRenderQueue<{
      environmentId: string;
      canvasId: string;
      priority: "interactive" | "validation" | "background";
      enqueuedAt: number;
      name: string;
    }>(2_000);
    queue.push({
      environmentId: "a",
      canvasId: "x",
      priority: "background",
      enqueuedAt: 0,
      name: "old-bg",
    });
    queue.push({
      environmentId: "b",
      canvasId: "y",
      priority: "interactive",
      enqueuedAt: 4_500,
      name: "new-ui",
    });
    // Before aging the fresh interactive job wins.
    expect(queue.effectiveRank({ ...base("background"), enqueuedAt: 0 }, 1_000)).toBe(2);
    // After two aging periods the background job reaches interactive rank and,
    // having waited longest with its environment unserved, goes first.
    expect(queue.take(4_600)?.name).toBe("old-bg");
    expect(queue.take(4_600)?.name).toBe("new-ui");
    expect(queue.take(4_600)).toBeUndefined();
  });

  test("expires jobs that never start and leaves them unexecuted", async () => {
    const gate = deferred();
    const fake = fakeBrowser({
      evaluate: async (operation, rendered) => {
        if (operation.op === "serialize" && rendered === "blocker") await gate.promise;
        return operation.op === "render" ? true : rendered;
      },
    });
    const instance = renderer(launcher(fake.handle), { budgets: { queueMs: 30 } });
    const blocker = instance.run(job({ frame: { ...frame, html: "blocker" } }));
    await waitFor(() => fake.evaluated.length >= 2);
    const started = Date.now();
    const error = await failure(instance.run(job({ frame: { ...frame, html: "late" } })));
    expect(Date.now() - started).toBeLessThan(500);
    expect(error.code).toBe("deadline");
    expect(error.message).toContain("not started");
    expect(error.failure.retry).toBe("after-delay");
    gate.resolve();
    await blocker;
    expect(fake.evaluated.some((operation) => operation.html === "late")).toBe(false);
    expect(instance.status().queued).toBe(0);
  });
});

describe("DesignRenderer lifecycle deadlines", () => {
  test("a hung launch settles within the deadline and a later job uses a new generation", async () => {
    const late = fakeBrowser();
    const hung = deferred<DesignBrowserHandle>();
    const finish = deferred<string>();
    const good = fakeBrowser({
      evaluate: (operation) => (operation.op === "render" ? true : finish.promise),
    });
    const launch = launcher(() => hung.promise, good.handle);
    const instance = renderer(launch, { budgets: { launchMs: 30, overallMs: 400 } });
    const started = Date.now();
    const error = await failure(instance.run(job()));
    expect(Date.now() - started).toBeLessThan(400);
    expect(error.code).toBe("renderer-unavailable");
    expect(instance.status().state).toBe("launch-failed");
    const inFlight = instance.run(job());
    await waitFor(() => good.evaluated.some((operation) => operation.op === "serialize"));
    expect(launch).toHaveBeenCalledTimes(2);
    expect(instance.status()).toMatchObject({ state: "running", generation: 2 });
    // A late launch cannot take over the new generation while its job runs.
    hung.resolve(late.handle);
    await waitFor(() => late.close.mock.calls.length === 1);
    expect(late.newContext).not.toHaveBeenCalled();
    finish.resolve(frame.html);
    await expect(inFlight).resolves.toBe(frame.html);
    expect(instance.status().generation).toBe(2);
  });

  test("launch failure is not reported as a missing executable", async () => {
    const good = fakeBrowser();
    const launch = launcher(() => Promise.reject(new Error("spawn EACCES /secret")), good.handle);
    const instance = renderer(launch);
    const error = await failure(instance.run(job()));
    expect(error.code).toBe("renderer-unavailable");
    expect(error.message).not.toContain("require Chromium");
    expect(error.message).not.toContain("/secret");
    const health = instance.status();
    expect(health).toMatchObject({ state: "launch-failed", ready: false });
    expect(health.error).toBe(health.message);
    await expect(instance.run(job())).resolves.toBe(frame.html);
    expect(instance.status().state).toBe("ready");
  });

  test("a hung context creation retires the generation", async () => {
    const lateContext = deferred();
    const first = fakeBrowser({ newContext: () => lateContext.promise });
    const second = fakeBrowser();
    const launch = launcher(first.handle, second.handle);
    const instance = renderer(launch, { budgets: { contextMs: 30 } });
    const error = await failure(instance.run(job()));
    expect(error.code).toBe("renderer-unavailable");
    expect(first.close).toHaveBeenCalled();
    await expect(instance.run(job())).resolves.toBe(frame.html);
    expect(launch).toHaveBeenCalledTimes(2);
    // The late context is closed with its rejection handled.
    lateContext.resolve();
    await waitFor(() => first.contextClose.mock.calls.length === 1);
  });

  test("a hung runtime closes its context and the generation keeps serving", async () => {
    let hang = true;
    const fake = fakeBrowser({
      evaluate: async (operation, rendered) => {
        if (operation.op === "serialize" && hang) {
          hang = false;
          return never();
        }
        return operation.op === "render" ? true : rendered;
      },
    });
    const launch = launcher(fake.handle);
    const instance = renderer(launch, { budgets: { runMs: 30 } });
    const error = await failure(instance.run(job()));
    expect(error.code).toBe("deadline");
    await waitFor(() => fake.contextClose.mock.calls.length === 1);
    await expect(instance.run(job())).resolves.toBe(frame.html);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  test("a hung context close retires the generation and escalates to kill", async () => {
    const first = fakeBrowser({
      evaluate: (operation) => (operation.op === "render" ? true : never()),
      contextClose: never,
      browserClose: never,
    });
    const second = fakeBrowser();
    const launch = launcher(first.handle, second.handle);
    const instance = renderer(launch, { budgets: { runMs: 20, cleanupMs: 20 } });
    expect((await failure(instance.run(job()))).code).toBe("deadline");
    await waitFor(() => first.kill.mock.calls.length === 1);
    await expect(instance.run(job())).resolves.toBe(frame.html);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  test("an old generation's disconnect does not clear the replacement browser", async () => {
    const closing = deferred();
    const first = fakeBrowser({
      evaluate: (operation) => (operation.op === "render" ? true : never()),
      contextClose: never,
      browserClose: () => closing.promise,
    });
    const second = fakeBrowser();
    const launch = launcher(first.handle, second.handle);
    const instance = renderer(launch, { budgets: { runMs: 20, cleanupMs: 500 } });
    await failure(instance.run(job()));
    await waitFor(() => first.close.mock.calls.length === 1);
    await instance.run(job());
    expect(launch).toHaveBeenCalledTimes(2);
    first.disconnect();
    await instance.run(job());
    expect(launch).toHaveBeenCalledTimes(2);
    expect(instance.status().generation).toBe(2);
    let stopped = false;
    const shutdown = instance.close().then(() => {
      stopped = true;
    });
    await waitFor(() => second.close.mock.calls.length === 1);
    expect(stopped).toBe(false);
    closing.resolve();
    await shutdown;
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.kill).not.toHaveBeenCalled();
  });

  test("generation death fails running jobs exactly once without rerunning them", async () => {
    const first = fakeBrowser({
      evaluate: (operation) => (operation.op === "render" ? true : never()),
    });
    const second = fakeBrowser();
    const launch = launcher(first.handle, second.handle);
    const instance = renderer(launch, { workers: 2 });
    const settled: string[] = [];
    const jobs = [0, 1].map((index) =>
      instance.run(job({ canvasId: `c${index}` })).then(
        () => settled.push("resolved"),
        (error: DesignError) => settled.push(error.code),
      ),
    );
    await waitFor(() => first.evaluated.filter((op) => op.op === "serialize").length === 2);
    first.disconnect();
    await Promise.all(jobs);
    expect(settled).toEqual(["renderer-unavailable", "renderer-unavailable"]);
    expect(instance.status().state).toBe("recovering");
    await expect(instance.run(job())).resolves.toBe(frame.html);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(first.evaluated.filter((op) => op.op === "serialize")).toHaveLength(2);
    expect(instance.status()).toMatchObject({ state: "ready", generation: 2 });
    await instance.close();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(first.kill).not.toHaveBeenCalled();
  });

  test("shutdown joins disconnected generation cleanup and kills after close rejects", async () => {
    const closing = deferred();
    const first = fakeBrowser({ browserClose: () => closing.promise });
    const second = fakeBrowser();
    const launch = launcher(first.handle, second.handle);
    const instance = renderer(launch, { budgets: { cleanupMs: 1_000 } });
    await instance.run(job());
    first.disconnect();
    await waitFor(() => first.close.mock.calls.length === 1);
    await instance.run(job());
    let stopped = false;
    const shutdown = instance.close().then(() => {
      stopped = true;
    });
    await waitFor(() => second.close.mock.calls.length === 1);
    expect(stopped).toBe(false);
    closing.reject(new Error("browser close failed"));
    await shutdown;
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});

describe("DesignRenderer shutdown", () => {
  test("close() with active and queued work resolves within bounds and leaves no timers", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const pendingTimers = new Set<unknown>();
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number) => {
      const handle: unknown = realSetTimeout(() => {
        pendingTimers.delete(handle);
        callback();
      }, ms);
      pendingTimers.add(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
      pendingTimers.delete(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout;
    try {
      const fake = fakeBrowser({
        evaluate: (operation) => (operation.op === "render" ? true : never()),
        contextClose: never,
        browserClose: never,
      });
      const instance = renderer(launcher(fake.handle), {
        budgets: { cleanupMs: 30, runMs: 10_000, queueMs: 10_000, overallMs: 20_000 },
      });
      const active = failure(instance.run(job()));
      const queued = failure(instance.run(job({ environmentId: "env-b" })));
      await waitFor(() => fake.evaluated.some((operation) => operation.op === "serialize"));
      const started = Date.now();
      await instance.close();
      expect(Date.now() - started).toBeLessThan(500);
      expect((await active).code).toBe("renderer-unavailable");
      expect((await queued).message).toBe("Design renderer is stopping");
      expect(fake.kill).toHaveBeenCalledTimes(1);
      const after = await failure(instance.run(job()));
      expect(after.message).toBe("Design renderer is stopping");
      expect(instance.status().state).toBe("stopping");
      await Bun.sleep(1);
      expect(pendingTimers.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("close() stops a launch in progress and closes the late browser", async () => {
    const hung = deferred<DesignBrowserHandle>();
    const late = fakeBrowser();
    const instance = renderer(
      launcher(() => hung.promise),
      { budgets: { cleanupMs: 20 } },
    );
    const pending = failure(instance.run(job()));
    await Bun.sleep(5);
    await instance.close();
    expect((await pending).code).toBe("renderer-unavailable");
    hung.resolve(late.handle);
    await waitFor(() => late.close.mock.calls.length === 1);
  });
});

describe("DesignRenderer health", () => {
  test("reports missing executables with install guidance", async () => {
    const launch = launcher(fakeBrowser().handle);
    const instance = renderer(launch, { executablePath: () => undefined });
    const health = instance.status();
    expect(health).toMatchObject({ state: "missing-executable", ready: false });
    expect(health.error).toContain("ORKESTRATOR_DESIGN_CHROMIUM_PATH");
    const error = await failure(instance.run(job()));
    expect(error.code).toBe("renderer-unavailable");
    expect(error.message).toContain("ORKESTRATOR_DESIGN_CHROMIUM_PATH");
    expect((await instance.probe()).state).toBe("missing-executable");
    expect(launch).not.toHaveBeenCalled();
  });

  test("is ready but unknown before any probe without launching a browser", () => {
    const launch = launcher(fakeBrowser().handle);
    const instance = renderer(launch);
    expect(instance.status()).toMatchObject({
      state: "unknown",
      ready: true,
      queued: 0,
      running: 0,
      generation: 0,
    });
    expect(instance.status().error).toBeUndefined();
    expect(typeof instance.status().checkedAt).toBe("string");
    expect(launch).not.toHaveBeenCalled();
  });

  test("caches, deduplicates and force-refreshes probes", async () => {
    const fake = fakeBrowser();
    const instance = renderer(launcher(fake.handle), { healthCacheMs: 60_000 });
    const [first, second] = await Promise.all([instance.probe(), instance.probe()]);
    expect(first.state).toBe("ready");
    expect(second.state).toBe("ready");
    expect(fake.newContext).toHaveBeenCalledTimes(1);
    await instance.probe();
    expect(fake.newContext).toHaveBeenCalledTimes(1);
    await instance.probe(true);
    expect(fake.newContext).toHaveBeenCalledTimes(2);
    instance.invalidateHealth();
    await instance.probe();
    expect(fake.newContext).toHaveBeenCalledTimes(3);
  });

  test("a failed probe reports launch failure and death invalidates cached health", async () => {
    const good = fakeBrowser();
    const instance = renderer(
      launcher(() => Promise.reject(new Error("boom")), good.handle),
      { healthCacheMs: 60_000 },
    );
    expect(await instance.probe()).toMatchObject({ state: "launch-failed", ready: false });
    expect((await instance.probe(true)).state).toBe("ready");
    good.disconnect();
    expect(instance.status().state).toBe("recovering");
  });
});

const realChromium = resolveDesignChromiumPath();
/** Bound for the one untimed cold start that loads Chromium from disk (0246). */
const COLD_START_MS = 120_000;

describe("DesignRenderer with real Chromium", () => {
  // A host's first Chromium start reads roughly 350 MB of browser from disk.
  // On a CI runner with a cold page cache and a contended disk that read alone
  // outlasts the production launch budget, while every later start takes
  // milliseconds (0246). Pay it once here, outside the renderer, so both cases
  // hold the renderer's own launch path to the production budgets.
  beforeAll(async () => {
    if (!realChromium) return;
    const started = performance.now();
    const browser = await chromium.launch({
      headless: true,
      executablePath: realChromium,
      timeout: COLD_START_MS,
    });
    try {
      const page = await browser.newPage();
      await page.setContent("<p>warm</p>");
      await page.screenshot({ type: "png" });
    } finally {
      await browser.close();
    }
    const elapsed = Math.round(performance.now() - started);
    if (elapsed > DEFAULT_DESIGN_RENDER_BUDGETS.launchMs / 3)
      console.warn(`[real Chromium] cold start took ${elapsed} ms before the cases (0246)`);
  }, COLD_START_MS + 15_000);

  test.skipIf(!realChromium)(
    "starts a loaded browser within the production launch budget",
    async () => {
      let launchTimeout: number | undefined;
      const instance = new DesignRenderer({
        launchBrowser: (options) => {
          launchTimeout = options?.timeout;
          return launchDesignBrowser(options);
        },
      });
      renderers.push(instance);
      expect(await instance.run<string>(job())).toContain("Hello");
      expect(launchTimeout).toBe(DEFAULT_DESIGN_RENDER_BUDGETS.launchMs);
      expect(instance.status()).toMatchObject({ state: "ready", ready: true });
    },
    DEFAULT_DESIGN_RENDER_BUDGETS.overallMs + 5_000,
  );

  test.skipIf(!realChromium)(
    "blocks authored scripts and remote images while capturing a PNG",
    async () => {
      let launch: Promise<string> | undefined;
      const instance = new DesignRenderer({
        launchBrowser: (options) => {
          const started = performance.now();
          const elapsed = () => `${Math.round(performance.now() - started)} ms`;
          const browser = launchDesignBrowser(options);
          launch = browser.then(
            () => `started after ${elapsed()}`,
            (error: unknown) =>
              `failed after ${elapsed()}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return browser;
        },
      });
      renderers.push(instance);
      try {
        await rendersInRealChromium(instance);
      } catch (error) {
        // Playwright's own launch error carries the browser's log.
        const outcome = launch
          ? await Promise.race([launch, Bun.sleep(1_000).then(() => "still pending")])
          : "never attempted";
        console.error(`[real Chromium] launch ${outcome}`);
        throw error;
      }
    },
    2 * DEFAULT_DESIGN_RENDER_BUDGETS.overallMs,
  );

  test.skipIf(!realChromium || process.platform === "win32")(
    "terminates an owned server after its browser connection disconnects and renders with a replacement",
    async () => {
      const handles: DesignBrowserHandle[] = [];
      const cleanup = deferred();
      const instance = new DesignRenderer({
        launchBrowser: async (options) => {
          const handle = await launchDesignBrowser(options);
          handles.push(handle);
          if (handles.length !== 1) return handle;
          return {
            ...handle,
            close: async () => {
              await cleanup.promise;
              await handle.close();
            },
          };
        },
        budgets: { cleanupMs: 2_000 },
      });
      renderers.push(instance);
      try {
        expect(await instance.run<string>(job())).toContain("Hello");
        const first = handles[0]!;
        const pid = first.pid;
        if (!pid) throw new Error("expected the browser process id");
        await first.browser.close();
        expect(first.browser.isConnected()).toBe(false);
        // Only the connection has closed; the server is still ours to end.
        expect(processAlive(pid)).toBe(true);
        cleanup.resolve();
        await waitFor(() => !processAlive(pid), 5_000);
        expect(await instance.run<string>(job())).toContain("Hello");
        expect(handles).toHaveLength(2);
        expect(instance.status()).toMatchObject({ state: "ready", generation: 2 });
        await instance.close();
        for (const handle of handles) {
          if (handle.pid) await waitFor(() => !processAlive(handle.pid!), 5_000);
        }
      } finally {
        cleanup.resolve();
        await instance.close();
        await Promise.all(handles.map((handle) => handle.kill().catch(() => undefined)));
      }
    },
    2 * DEFAULT_DESIGN_RENDER_BUDGETS.overallMs,
  );

  test.skipIf(!realChromium || process.platform === "win32")(
    "kills a browser whose close hangs instead of leaving it running",
    async () => {
      let handle: DesignBrowserHandle | undefined;
      const instance = new DesignRenderer({
        launchBrowser: async (options) => (handle = await launchDesignBrowser(options)),
        budgets: { cleanupMs: 500 },
      });
      renderers.push(instance);
      expect(await instance.run<string>(job())).toContain("Hello");
      const pid = handle?.pid;
      if (!pid) throw new Error("expected the browser process id");
      expect(processAlive(pid)).toBe(true);
      // A stopped browser never answers, so its graceful close hangs.
      process.kill(pid, "SIGSTOP");
      try {
        const started = Date.now();
        await instance.close();
        expect(Date.now() - started).toBeLessThan(5_000);
        await waitFor(() => !processAlive(pid), 5_000);
      } finally {
        if (processAlive(pid)) {
          process.kill(pid, "SIGCONT");
          process.kill(pid, "SIGKILL");
        }
      }
    },
    DEFAULT_DESIGN_RENDER_BUDGETS.overallMs + 10_000,
  );

  test.skipIf(!realChromium || process.platform === "win32")(
    "a killed backend's browser profile is removed by the next startup sweep (0248)",
    async () => {
      // The child's TMPDIR is ours, so its profile lands where this test owns it.
      // Names are short: Chromium puts its SingletonSocket in that TMPDIR, the
      // test process's own TMPDIR is already private (0248), and a longer path
      // passed Linux's 108-byte socket limit, so Chromium aborted at launch.
      const root = mkdtempSync(path.join(tmpdir(), "ork-dk-"));
      const temp = path.join(root, "t");
      const ledgerDir = path.join(root, "design-browser-profiles");
      mkdirSync(temp);
      const child = spawn(
        process.execPath,
        [path.join(import.meta.dir, "fixtures/recorded-renderer.ts"), ledgerDir],
        { env: { ...process.env, TMPDIR: temp }, stdio: ["ignore", "pipe", "inherit"] },
      );
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      let browserPid: number | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout!.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("ready")) resolve();
          });
          child.once("exit", () => reject(new Error("the renderer fixture exited early")));
        });
        const [recordName] = readdirSync(ledgerDir).filter((name) => name.endsWith(".json"));
        const record = JSON.parse(readFileSync(path.join(ledgerDir, recordName!), "utf8")) as {
          profile: string;
          artifacts?: string;
          browser: { pid: number };
        };
        browserPid = record.browser.pid;
        expect(path.dirname(record.profile)).toBe(temp);
        expect(existsSync(record.profile)).toBe(true);
        // Playwright honoured artifactsDir: nothing unrecorded in the temp dir (0830).
        expect(path.dirname(record.artifacts!)).toBe(ledgerDir);
        expect(existsSync(record.artifacts!)).toBe(true);
        expect(
          readdirSync(temp).filter((name) => name.startsWith("playwright-artifacts-")),
        ).toEqual([]);

        child.kill("SIGKILL");
        await exited;
        // Chromium ends once its launcher's pipe closes; nothing removes the profile.
        await waitFor(() => !processAlive(browserPid!), 10_000);
        expect(existsSync(record.profile)).toBe(true);

        const removed = await new DesignProfileLedger(ledgerDir).sweep(0);
        expect(removed).toEqual([record.profile]);
        expect(readdirSync(temp).filter((name) => name.startsWith("playwright_"))).not.toContain(
          path.basename(record.profile),
        );
        expect(readdirSync(ledgerDir)).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        // The browser is this test's own descendant, named by the ledger it wrote.
        if (browserPid && processAlive(browserPid)) process.kill(browserPid, "SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    },
    COLD_START_MS,
  );
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function rendersInRealChromium(instance: DesignRenderer): Promise<void> {
  const html =
    '<div id="root">Hi</div><script>document.body.dataset.ran = "yes"</script><img src="https://example.com/x.png">';
  const realFrame = { html, width: 200, height: 120 };

  const serialized = await instance.run<string>(job({ frame: realFrame }));
  expect(serialized).not.toContain("<script");
  expect(serialized).not.toContain("data-ran");
  expect(serialized).toContain("Hi");
  const capture = await instance.run<{ mimeType: string; data: string }>(
    job({ frame: realFrame, operation: { op: "capture" } }),
  );
  expect(capture.mimeType).toBe("image/png");
  expect(Buffer.from(capture.data, "base64").subarray(1, 4).toString()).toBe("PNG");
  // Awaiting the rejection directly: `expect(promise).rejects` starves the
  // real browser connection under bun test and makes this step take seconds.
  const runtimeError = await instance
    .run(job({ frame: realFrame, operation: { op: "inspectElement", selector: "p" } }))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(runtimeError).not.toBeInstanceOf(DesignError);
  expect((runtimeError as Error).message).toBe("Selector must match exactly one element");
}

function base(priority: "interactive" | "validation" | "background") {
  return { environmentId: "x", canvasId: "y", priority, enqueuedAt: 0 };
}
