import { describe, expect, test } from "bun:test";
import { OpenCodeInstanceReload } from "./opencode-command-reload.js";

function settable<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function harness(initiallyIdle = true) {
  const calls: string[] = [];
  let idle = initiallyIdle;
  let disposeGate: Promise<void> | null = null;
  let disposeError: Error | null = null;
  const reload = new OpenCodeInstanceReload({
    idle: async () => {
      calls.push("idle");
      return idle;
    },
    dispose: async () => {
      calls.push("dispose");
      await disposeGate;
      if (disposeError) throw disposeError;
    },
    reloaded: () => {
      calls.push("reloaded");
    },
  });
  return {
    reload,
    calls,
    setIdle(value: boolean) {
      idle = value;
    },
    setDisposeGate(gate: Promise<void> | null) {
      disposeGate = gate;
    },
    setDisposeError(error: Error | null) {
      disposeError = error;
    },
  };
}

describe("OpenCode instance reload", () => {
  test("an idle directory reloads at once and clears the pending request", async () => {
    const h = harness();
    await expect(h.reload.request()).resolves.toBe("reloaded");
    expect(h.calls).toEqual(["idle", "dispose", "reloaded"]);
    expect(h.reload.pending).toBe(false);
  });

  test("a busy directory defers, and the next idle edge reloads it exactly once", async () => {
    const h = harness(false);
    await expect(h.reload.request()).resolves.toBe("deferred");
    expect(h.calls).toEqual(["idle"]);
    expect(h.reload.pending).toBe(true);

    // Still busy at this edge: nothing is disposed and the request stays.
    h.reload.idleObserved();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.calls).toEqual(["idle", "idle"]);
    expect(h.reload.pending).toBe(true);

    const disposed = settable<void>();
    h.setIdle(true);
    h.setDisposeGate(disposed.promise);
    h.reload.idleObserved();
    // Edges that arrive while the reload runs join it.
    h.reload.idleObserved();
    disposed.resolve();
    const release = await h.reload.enterDispatch();
    release();
    expect(h.calls).toEqual(["idle", "idle", "idle", "dispose", "reloaded"]);
    expect(h.reload.pending).toBe(false);

    // Nothing is pending any more, so later edges do nothing.
    h.reload.idleObserved();
    await Promise.resolve();
    expect(h.calls).toHaveLength(5);
  });

  test("an open dispatch holds the reload off, and its release retries it", async () => {
    const h = harness();
    const first = await h.reload.enterDispatch();
    const second = await h.reload.enterDispatch();
    await expect(h.reload.request()).resolves.toBe("deferred");
    // The idle edge of a command's own turn arrives before its dispatch ends.
    h.reload.idleObserved();
    expect(h.calls).toEqual([]);
    first();
    // A second release is harmless and does not unbalance the count.
    first();
    expect(h.calls).toEqual([]);
    second();
    const next = await h.reload.enterDispatch();
    next();
    expect(h.calls).toEqual(["idle", "dispose", "reloaded"]);
    expect(h.reload.pending).toBe(false);
  });

  test("a dispatch that starts during a reload waits until the instance is rebuilt", async () => {
    const h = harness();
    const disposed = settable<void>();
    h.setDisposeGate(disposed.promise);
    const reloading = h.reload.request();
    let entered = false;
    const dispatch = h.reload.enterDispatch().then((release) => {
      entered = true;
      h.calls.push("dispatch");
      return release;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(entered).toBe(false);
    disposed.resolve();
    await expect(reloading).resolves.toBe("reloaded");
    (await dispatch)();
    expect(h.calls).toEqual(["idle", "dispose", "reloaded", "dispatch"]);
  });

  test("a failed disposal propagates, drops the request and reopens dispatch", async () => {
    const h = harness();
    h.setDisposeError(new Error("refused"));
    await expect(h.reload.request()).rejects.toThrow("refused");
    expect(h.calls).toEqual(["idle", "dispose"]);
    expect(h.reload.pending).toBe(false);
    const release = await h.reload.enterDispatch();
    release();
  });

  test("a failed deferred reload is not retried on every idle edge", async () => {
    const h = harness(false);
    await h.reload.request();
    h.setIdle(true);
    const failed = settable<void>();
    h.setDisposeGate(failed.promise);
    h.setDisposeError(new Error("refused"));
    h.reload.idleObserved();
    failed.resolve();
    // enterDispatch waits for the failed reload to settle.
    (await h.reload.enterDispatch())();
    await Promise.resolve();
    expect(h.reload.pending).toBe(false);
    h.reload.idleObserved();
    await Promise.resolve();
    expect(h.calls.filter((call) => call === "dispose")).toHaveLength(1);
  });
});
