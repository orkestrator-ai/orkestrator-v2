import { describe, expect, mock, test } from "bun:test";
import {
  createToolchainProgressController,
  preparePinnedToolchains,
} from "../../../apps/desktop/electron/toolchain-startup";
import type { ToolchainProgress } from "../../../apps/desktop/electron/toolchain-manager";

function progress(phase: ToolchainProgress["phase"]): ToolchainProgress {
  return { phase, completedTools: 0, totalTools: 3, overallFraction: 0, message: phase };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeWindow() {
  let destroyed = false;
  let closedListener: (() => void) | undefined;
  return {
    close: mock(() => {
      destroyed = true;
      closedListener?.();
    }),
    isDestroyed: mock(() => destroyed),
    once: mock((_event: "closed", listener: () => void) => {
      closedListener = listener;
      return undefined as never;
    }),
  };
}

describe("toolchain startup orchestration", () => {
  test("does not open a progress window for a verified cache", async () => {
    const createWindow = mock(async () => fakeWindow());
    const controller = createToolchainProgressController({
      createWindow,
      reportProgress: mock(() => undefined),
      logError: mock(() => undefined),
    });

    controller.report(progress("checking"));
    controller.report(progress("ready"));
    await controller.close();
    expect(createWindow).not.toHaveBeenCalled();
  });

  test("shares a pending window, forwards progress, and closes it even when creation resolves late", async () => {
    const pendingWindow = deferred<ReturnType<typeof fakeWindow>>();
    const reportProgress = mock(() => undefined);
    const controller = createToolchainProgressController({
      createWindow: mock(() => pendingWindow.promise),
      reportProgress,
      logError: mock(() => undefined),
    });

    controller.report(progress("downloading"));
    controller.report(progress("verifying"));
    const closing = controller.close();
    const window = fakeWindow();
    pendingWindow.resolve(window);
    await closing;

    expect(window.close).toHaveBeenCalledTimes(1);
    expect(reportProgress).not.toHaveBeenCalled();
  });

  test("retries progress window creation after a load failure", async () => {
    const error = new Error("preload failed");
    const window = fakeWindow();
    const createWindow = mock()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(window);
    const logError = mock(() => undefined);
    const reportProgress = mock(() => undefined);
    const controller = createToolchainProgressController({ createWindow, reportProgress, logError });

    controller.report(progress("downloading"));
    await Bun.sleep(0);
    controller.report(progress("downloading"));
    await Bun.sleep(0);

    expect(logError).toHaveBeenCalledWith(error);
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(reportProgress).toHaveBeenCalledTimes(1);
    await controller.close();
  });

  test("retries tool preparation and returns the verified bin directory", async () => {
    const ensure = mock()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ rootDir: "/data/toolchains", binDir: "/data/toolchains/bin", executables: {} });
    const showMessageBox = mock(async () => ({ response: 0 }));
    const quit = mock(() => undefined);
    const logError = mock(() => undefined);

    await expect(preparePinnedToolchains({
      dataDir: "/data",
      ensure,
      fetchImpl: mock(async () => new Response()),
      onProgress: mock(() => undefined),
      showMessageBox,
      quit,
      logError,
    })).resolves.toBe("/data/toolchains/bin");

    expect(ensure).toHaveBeenCalledTimes(2);
    expect(showMessageBox.mock.calls[0]?.[0].detail).toContain("network down");
    expect(quit).not.toHaveBeenCalled();
  });

  test("quits after a rejected retry prompt and handles non-Error failures", async () => {
    const quit = mock(() => undefined);
    const showMessageBox = mock(async () => ({ response: 1 }));

    await expect(preparePinnedToolchains({
      dataDir: "/data",
      ensure: mock(async () => { throw "offline"; }),
      fetchImpl: mock(async () => new Response()),
      onProgress: mock(() => undefined),
      showMessageBox,
      quit,
      logError: mock(() => undefined),
    })).resolves.toBeNull();

    expect(showMessageBox.mock.calls[0]?.[0].detail).toContain("offline");
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
