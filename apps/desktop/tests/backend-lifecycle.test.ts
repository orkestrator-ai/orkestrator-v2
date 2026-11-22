import { describe, expect, mock, test } from "bun:test";
import {
  createBackendWebClientControls,
  prepareAppImageInstall,
  registerBackendShutdown,
} from "../electron/backend-lifecycle";

describe("desktop backend lifecycle", () => {
  test("forwards every web client operation to the current backend", async () => {
    const backend = {
      getWebClientStatus: mock(async () => ({
        enabled: true,
        running: false,
        url: null,
        error: null,
      })),
      setWebClientEnabled: mock(async (enabled: boolean) => ({
        enabled,
        running: enabled,
        url: null,
        error: null,
      })),
      resetWebClientServe: mock(async () => ({
        enabled: true,
        running: true,
        url: null,
        error: null,
      })),
      getTokenSettings: mock(async () => ({
        token: "gateway-token-123456",
        editable: true,
        source: "file" as const,
      })),
      setToken: mock(async (token: string) => ({ token, editable: true, source: "file" as const })),
    };
    const controls = createBackendWebClientControls(() => backend);

    await expect(controls.getWebClientStatus()).resolves.toMatchObject({ enabled: true });
    await expect(controls.setWebClientEnabled(false)).resolves.toMatchObject({ enabled: false });
    await expect(controls.resetWebClientServe()).resolves.toMatchObject({ running: true });
    await expect(controls.getGatewayTokenSettings()).resolves.toMatchObject({ editable: true });
    await expect(controls.setGatewayToken("replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(backend.setWebClientEnabled).toHaveBeenCalledWith(false);
    expect(backend.resetWebClientServe).toHaveBeenCalledTimes(1);
    expect(backend.setToken).toHaveBeenCalledWith("replacement-token-123456");
  });

  test("reads the backend lazily and rejects operations before initialization", async () => {
    let backend: ReturnType<Parameters<typeof createBackendWebClientControls>[0]> = null;
    const controls = createBackendWebClientControls(() => backend);

    expect(() => controls.getWebClientStatus()).toThrow("Backend is not initialized");
    backend = {
      getWebClientStatus: async () => ({ enabled: false, running: false, url: null, error: null }),
      setWebClientEnabled: async (enabled) => ({ enabled, running: false, url: null, error: null }),
      resetWebClientServe: async () => ({ enabled: true, running: true, url: null, error: null }),
      getTokenSettings: async () => ({
        token: "gateway-token-123456",
        editable: true,
        source: "file",
      }),
      setToken: async (token) => ({ token, editable: true, source: "file" }),
    };
    await expect(controls.getWebClientStatus()).resolves.toMatchObject({ enabled: false });
  });

  /**
   * The held quit is re-issued on its own `setTimeout(0)`, scheduled only once
   * the hold settles. A loaded host that stalls the event loop past a fixed
   * sleep runs that already-due sleep before the quit timer the same wake-up
   * schedules, so wait for the quit itself, with a bound.
   */
  async function waitForQuits(state: { quits: number }, count: number): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (state.quits < count && Date.now() < deadline) await Bun.sleep(1);
  }

  function fakeQuittingApp() {
    const listeners = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
    const state = { prevented: 0, quits: 0 };
    const app = {
      on: mock((event: string, listener: (event: { preventDefault(): void }) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return app as never;
      }),
      quit: mock(() => {
        state.quits += 1;
      }),
    };
    const emit = (event: string) => {
      for (const listener of listeners.get(event) ?? []) {
        listener({ preventDefault: () => (state.prevented += 1) });
      }
    };
    return { app, state, emit };
  }

  test("stops the backend once and holds the quit until it has exited", async () => {
    const { app, state, emit } = fakeQuittingApp();
    const exited = Promise.withResolvers<void>();
    const backendProcess = { stop: mock(() => exited.promise) };

    registerBackendShutdown(app as never, backendProcess as never, 5_000);
    emit("before-quit");
    emit("before-quit");
    emit("will-quit");
    expect(backendProcess.stop).toHaveBeenCalledTimes(1);
    expect(state.prevented).toBe(1);

    // Another hold (the log flush) re-issuing the quit must not let it through.
    emit("will-quit");
    expect(state.prevented).toBe(2);
    await Bun.sleep(5);
    expect(state.quits).toBe(0);

    exited.resolve();
    await waitForQuits(state, 1);
    expect(state.quits).toBe(1);
    emit("will-quit");
    expect(state.prevented).toBe(2);
  });

  test("quits anyway when the backend outlives its exit deadline", async () => {
    const { app, state, emit } = fakeQuittingApp();
    const backendProcess = { stop: mock(() => new Promise<void>(() => {})) };

    registerBackendShutdown(app as never, backendProcess as never, 10);
    emit("before-quit");
    emit("will-quit");
    await waitForQuits(state, 1);
    expect(state.quits).toBe(1);
  });
});

test("AppImage replacement can claim the lock only after the old backend exits", async () => {
  const order: string[] = [];
  let drain!: () => void;
  const backend = {
    stop: () =>
      new Promise<void>((resolve) => {
        drain = resolve;
      }),
  };
  let locked = true;
  const preparation = prepareAppImageInstall(
    {
      releaseSingleInstanceLock: () => {
        locked = false;
        order.push("unlock");
      },
    },
    backend,
  );
  expect(locked).toBe(true);
  order.push("backend-exit");
  drain();
  await preparation;
  // AppImageUpdater's force-run spawn happens only after this preparation resolves.
  order.push(locked ? "single-instance-rejected" : "replacement-started");
  expect(order).toEqual(["backend-exit", "unlock", "replacement-started"]);
});

test("AppImage replacement finds the old essential log already stopped", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { installEssentialLog } = await import("@orkestrator/protocol/node/essential-log");
  const { resetLogger } = await import("@orkestrator/protocol/logger");
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-appimage-handover-"));
  const file = path.join(root, "logs", "essential", "essential.jsonl");
  const lifecycle = async () =>
    (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line.includes('"area":"logging"'))
      .map((line) => (JSON.parse(line) as { event: string }).event);
  const old = installEssentialLog({ dataDir: root, owner: "desktop" });
  let replacement: ReturnType<typeof installEssentialLog> | null = null;
  try {
    await prepareAppImageInstall(
      {
        releaseSingleInstanceLock: () => {
          // The replacement wins the lock and starts writing the same file.
          replacement = installEssentialLog({ dataDir: root, owner: "desktop" });
        },
      },
      { stop: async () => {} },
      old,
    );
    await replacement!.flush();
    // The old process's will-quit hold stops it again; that must add nothing.
    await old.stop();
    await replacement!.flush();
    expect(await lifecycle()).toEqual([
      "essential.started",
      "essential.stopped",
      "essential.started",
    ]);
  } finally {
    await (replacement as ReturnType<typeof installEssentialLog> | null)?.stop();
    resetLogger();
    await rm(root, { recursive: true, force: true });
  }
});

test("an essential log that cannot stop does not hold an update forever", async () => {
  let unlocked = false;
  await prepareAppImageInstall(
    { releaseSingleInstanceLock: () => (unlocked = true) },
    { stop: async () => {} },
    { stop: () => new Promise<void>(() => {}) },
    10,
  );
  expect(unlocked).toBe(true);
});

test("a failed essential log stop still releases the lock", async () => {
  let unlocked = false;
  await prepareAppImageInstall(
    { releaseSingleInstanceLock: () => (unlocked = true) },
    { stop: async () => {} },
    { stop: () => Promise.reject(new Error("disk gone")) },
  );
  expect(unlocked).toBe(true);
});
