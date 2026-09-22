import { describe, expect, mock, test } from "bun:test";
import {
  isDesktopRenderer,
  startDesktopRenderer,
  waitForDesktopConnection,
} from "./desktop-startup";

function clock() {
  const pending = new Map<number, () => void>();
  return {
    timer: {
      set: (callback: () => void, delay: number) => {
        pending.set(delay, callback);
        return delay;
      },
      clear: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    async fire(delay: number) {
      const callback = pending.get(delay);
      pending.delete(delay);
      callback?.();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
    pending,
  };
}
function api(remote = false) {
  return {
    connections: {
      list: mock(async () => ({
        activeConnectionId: remote ? "remote" : "local",
        localAvailable: true,
      })),
    },
    invoke: mock(async () => ({})),
  } as unknown as NonNullable<Window["orkestrator"]>;
}

describe("desktop startup connection", () => {
  test("waits for a delayed preload and confirms a backend read before continuing", async () => {
    const time = clock();
    let bridge: ReturnType<typeof api> | undefined;
    const ready = waitForDesktopConnection({ getApi: () => bridge, timer: time.timer });
    let resolved = false;
    void ready.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    bridge = api();
    await time.fire(250);
    expect(await ready).toBe("ready");
    expect(bridge.invoke).toHaveBeenCalledWith("get_config");
    expect(time.pending.size).toBe(0);
  });

  test("retries a transient rejected request without overlapping requests", async () => {
    const time = clock();
    const bridge = api();
    bridge.invoke = mock().mockRejectedValueOnce(new Error("not ready")).mockResolvedValue({});
    const ready = waitForDesktopConnection({ getApi: () => bridge, timer: time.timer });
    await time.fire(0);
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
    await time.fire(250);
    expect(await ready).toBe("ready");
    expect(bridge.invoke).toHaveBeenCalledTimes(2);
  });

  test("a missing preload expires without leaving retries running", async () => {
    const time = clock();
    const ready = waitForDesktopConnection({ getApi: () => undefined, timer: time.timer });
    await time.fire(10_000);
    expect(await ready).toBe("bridge-unavailable");
    expect(time.pending.size).toBe(0);
  });

  test("a hung backend expires and owns a late rejection without starting more work", async () => {
    const time = clock();
    const bridge = api();
    let reject!: (error: Error) => void;
    bridge.invoke = mock(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    ) as typeof bridge.invoke;
    const ready = waitForDesktopConnection({ getApi: () => bridge, timer: time.timer });
    await time.fire(0);
    await time.fire(10_000);
    expect(await ready).toBe("backend-unavailable");
    reject(new Error("late failure"));
    await time.fire(0);
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
    expect(time.pending.size).toBe(0);
  });

  test("a timed-out IPC handshake cannot issue a late backend request", async () => {
    const time = clock();
    const bridge = api();
    let resolve!: (value: unknown) => void;
    bridge.connections!.list = mock(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ) as never;
    const ready = waitForDesktopConnection({ getApi: () => bridge, timer: time.timer });
    await time.fire(10_000);
    expect(await ready).toBe("bridge-unavailable");
    resolve({ activeConnectionId: "local", localAvailable: true });
    await time.fire(0);
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  test("remote windows can reach their connection settings even when the remote host is offline", async () => {
    const time = clock();
    const bridge = api(true);
    expect(await waitForDesktopConnection({ getApi: () => bridge, timer: time.timer })).toBe(
      "ready",
    );
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
});

function target(protocol = "file:", userAgent = "Electron/42") {
  const document = window.document.implementation.createHTMLDocument();
  document.body.innerHTML = '<div id="root"></div>';
  return { document, location: { protocol, reload: mock(() => {}) }, navigator: { userAgent } };
}

describe("desktop startup screen", () => {
  test("never imports or mounts the workspace on connection failure and offers reload", async () => {
    const view = target();
    const start = mock(async () => {});
    await startDesktopRenderer({
      target: view as never,
      start,
      connect: async () => "bridge-unavailable",
    });
    expect(start).not.toHaveBeenCalled();
    expect(view.document.querySelector('[role="alert"]')?.textContent).toContain(
      "couldn’t connect",
    );
    expect(view.document.body.textContent).not.toContain("Docker");
    view.document.querySelector("button")!.click();
    expect(view.location.reload).toHaveBeenCalledTimes(1);
  });

  test("does not load the app until the connection is ready", async () => {
    const view = target();
    let resolve!: (result: "ready") => void;
    const connect = () =>
      new Promise<"ready">((done) => {
        resolve = done;
      });
    const start = mock(async () => {});
    const startup = startDesktopRenderer({ target: view as never, start, connect });
    expect(start).not.toHaveBeenCalled();
    expect(view.document.querySelector('[role="status"]')).not.toBeNull();
    resolve("ready");
    await startup;
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("ordinary browser gateways bypass the desktop check", async () => {
    const view = target("https:", "Chrome/140");
    const connect = mock(async () => "ready" as const);
    const start = mock(async () => {});
    await startDesktopRenderer({ target: view as never, start, connect });
    expect(connect).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(isDesktopRenderer(target("http:", "Electron/42") as never)).toBe(true);
    expect(isDesktopRenderer(target("file:", "Chrome/140") as never)).toBe(true);
  });

  test("a failed renderer import has a reload action instead of a blank window", async () => {
    const view = target();
    await startDesktopRenderer({
      target: view as never,
      connect: async () => "ready",
      start: async () => {
        throw new Error("chunk missing");
      },
    });
    expect(view.document.querySelector("button")?.textContent).toBe("Reload window");
  });
});
