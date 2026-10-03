import { afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import {
  DISABLE_AUTO_UPDATE_ENV,
  createAutoUpdateController,
  isAutoUpdateSupported,
  type AutoUpdateEnvironment,
  type UpdaterLike,
  type UpdateCheckResult,
} from "./auto-update.js";

const supported: AutoUpdateEnvironment = {
  isPackaged: true,
  runtimeFlavor: "production",
  platform: "darwin",
  env: {},
  resourcesPath: "/app/Contents/Resources",
  fileExists: (filePath) => filePath === "/app/Contents/Resources/app-update.yml",
};

describe("isAutoUpdateSupported", () => {
  test("accepts a packaged production install that embeds app-update.yml", () => {
    expect(isAutoUpdateSupported(supported)).toBe(true);
  });

  test("rejects unpackaged, non-production, and feed-less installs", () => {
    expect(isAutoUpdateSupported({ ...supported, isPackaged: false })).toBe(false);
    expect(isAutoUpdateSupported({ ...supported, runtimeFlavor: "agent-test" })).toBe(false);
    // The ad-hoc signed `package:mac` install has no update feed.
    expect(isAutoUpdateSupported({ ...supported, fileExists: () => false })).toBe(false);
  });

  test("honors the opt-out environment variable", () => {
    expect(isAutoUpdateSupported({ ...supported, env: { [DISABLE_AUTO_UPDATE_ENV]: "1" } })).toBe(
      false,
    );
  });

  test("on Linux only updates an AppImage", () => {
    const linux = { ...supported, platform: "linux" as const };
    expect(isAutoUpdateSupported(linux)).toBe(false);
    expect(isAutoUpdateSupported({ ...linux, env: { APPIMAGE: "/tmp/app.AppImage" } })).toBe(true);
  });
});

function createHarness(checkResult: UpdateCheckResult | Error | null = {}) {
  const listeners = new Map<string, (arg: never) => void>();
  const updater: UpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: true,
    on: ((event: string, listener: (arg: never) => void) => {
      listeners.set(event, listener);
    }) as UpdaterLike["on"],
    checkForUpdates: mock(async () => {
      if (checkResult instanceof Error) throw checkResult;
      return checkResult;
    }),
    quitAndInstall: mock(() => undefined),
  };
  const showMessageBox = mock(async (_window: unknown, _options: { message?: string }) => ({
    response: 0,
    checkboxChecked: false,
  }));
  const log = { info: mock(() => undefined), warn: mock(() => undefined) };
  const controller = createAutoUpdateController({
    updater,
    productName: "Orkestrator AI",
    currentVersion: "2.19.9",
    getWindow: () => null,
    showMessageBox,
    log,
  });
  const emit = (event: string, arg: unknown) => listeners.get(event)?.(arg as never);
  return { updater, showMessageBox, controller, emit, log };
}

describe("createAutoUpdateController", () => {
  test("downloads automatically, installs on quit, and ignores prereleases", () => {
    const { updater } = createHarness();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
  });

  test("restarts only when the user chooses Restart Now", async () => {
    const { updater, showMessageBox, emit } = createHarness();
    emit("update-downloaded", { version: "2.20.0" });
    await Promise.resolve();
    await Promise.resolve();
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);

    const later = createHarness();
    later.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    later.emit("update-downloaded", { version: "2.20.0" });
    await Promise.resolve();
    await Promise.resolve();
    expect(later.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  test("prompts once per downloaded version", async () => {
    const { showMessageBox, emit } = createHarness();
    emit("update-downloaded", { version: "2.20.0" });
    emit("update-downloaded", { version: "2.20.0" });
    await Promise.resolve();
    await Promise.resolve();
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  test("a manual check reports an up-to-date install", async () => {
    const { controller, showMessageBox } = createHarness({ isUpdateAvailable: false });
    await controller.checkNow();
    expect(showMessageBox.mock.calls[0]?.[1].message).toContain("is up to date");
  });

  test("a manual check reports a check failure", async () => {
    const { controller, showMessageBox } = createHarness(new Error("offline"));
    await controller.checkNow();
    expect(showMessageBox.mock.calls[0]?.[1].message).toBe("Could not check for updates");
  });

  test("a manual check re-offers an update that was already downloaded", async () => {
    const { controller, updater, showMessageBox, emit } = createHarness();
    emit("update-downloaded", { version: "2.20.0" });
    await Promise.resolve();
    await Promise.resolve();
    showMessageBox.mockClear();
    await controller.checkNow();
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => jest.useRealTimers());

describe("update download and lifecycle", () => {
  test("reports asynchronous manual download failures and permits retry", async () => {
    const download = deferred<string[]>();
    const { controller, updater, showMessageBox, log } = createHarness({
      isUpdateAvailable: true,
      downloadPromise: download.promise,
    });
    const manual = controller.checkNow();
    await flush();
    download.reject(new Error("signature verification failed"));
    await manual;
    expect(showMessageBox.mock.calls[0]?.[1]).toMatchObject({
      message: "Could not download or prepare the update",
      detail: "signature verification failed",
    });
    expect(log.warn).toHaveBeenCalledWith(
      "[Updater] Update download or staging failed:",
      expect.any(Error),
    );
    spyOn(updater, "checkForUpdates").mockResolvedValueOnce({ isUpdateAvailable: false });
    await controller.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(showMessageBox.mock.calls[1]?.[1].message).toContain("is up to date");
  });

  test("consumes asynchronous background download rejection without a dialog or unhandled rejection", async () => {
    jest.useFakeTimers();
    const download = deferred<string[]>();
    const { controller, showMessageBox, log } = createHarness({
      isUpdateAvailable: true,
      downloadPromise: download.promise,
    });
    const unhandled = mock(() => undefined);
    process.on("unhandledRejection", unhandled);
    try {
      controller.start();
      jest.advanceTimersByTime(30_000);
      await flush();
      download.reject(new Error("download interrupted"));
      await flush();
      controller.stop();
      jest.useRealTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(showMessageBox).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        "[Updater] Update download or staging failed:",
        expect.any(Error),
      );
    } finally {
      controller.stop();
      process.off("unhandledRejection", unhandled);
    }
  });

  test("waits for download/staging before prompting and retries a failed macOS staging attempt", async () => {
    const download = deferred<string[]>();
    const { controller, updater, showMessageBox, emit } = createHarness({
      isUpdateAvailable: true,
      downloadPromise: download.promise,
    });
    const manual = controller.checkNow();
    await flush();
    emit("update-downloaded", { version: "2.20.0" });
    expect(showMessageBox).not.toHaveBeenCalled();
    emit("error", new Error("native staging failed"));
    download.reject(new Error("native staging failed"));
    await manual;
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    spyOn(updater, "checkForUpdates").mockResolvedValueOnce({ isUpdateAvailable: false });
    showMessageBox.mockClear();
    await controller.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(showMessageBox.mock.calls[0]?.[1].message).toContain("is up to date");
  });

  test("invalidates an open restart prompt on a late native error even after downloadPromise resolved", async () => {
    const dialog = deferred<{ response: number; checkboxChecked: boolean }>();
    const { controller, updater, showMessageBox, emit } = createHarness({
      isUpdateAvailable: true,
      downloadPromise: Promise.resolve([]),
    });
    showMessageBox.mockImplementationOnce(() => dialog.promise);
    await controller.checkNow();
    emit("update-downloaded", { version: "2.20.0" });
    emit("error", new Error("native verification failed"));
    dialog.resolve({ response: 0, checkboxChecked: false });
    await flush();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    spyOn(updater, "checkForUpdates").mockResolvedValueOnce({ isUpdateAvailable: false });
    await controller.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(showMessageBox.mock.calls[1]?.[1].message).toContain("is up to date");
  });

  test("prompts on a successful download and reports no premature success", async () => {
    const download = deferred<string[]>();
    const { controller, emit, showMessageBox } = createHarness({
      isUpdateAvailable: true,
      downloadPromise: download.promise,
    });
    const manual = controller.checkNow();
    await flush();
    expect(showMessageBox).not.toHaveBeenCalled();
    emit("update-downloaded", { version: "2.20.0" });
    download.resolve(["update.zip"]);
    await manual;
    expect(showMessageBox.mock.calls[0]?.[1].message).toContain("ready to install");
  });

  test("launches after 30 seconds, repeats every six hours, starts once, and clears timers on stop", async () => {
    jest.useFakeTimers();
    const { controller, updater } = createHarness();
    controller.start();
    controller.start();
    jest.advanceTimersByTime(29_999);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(6 * 60 * 60 * 1000 - 30_000);
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(6 * 60 * 60 * 1000);
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
    controller.stop();
    jest.advanceTimersByTime(12 * 60 * 60 * 1000);
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
    controller.start();
    controller.stop();
    jest.advanceTimersByTime(30_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  test("shares a background download with a manual check and suppresses overlapping menu clicks", async () => {
    jest.useFakeTimers();
    const download = deferred<string[]>();
    const { controller, updater, showMessageBox } = createHarness({
      isUpdateAvailable: true,
      downloadPromise: download.promise,
    });
    try {
      controller.start();
      jest.advanceTimersByTime(30_000);
      await flush();
      const manual = controller.checkNow();
      await controller.checkNow();
      jest.advanceTimersByTime(6 * 60 * 60 * 1000);
      await flush();
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
      download.reject(new Error("offline"));
      await manual;
      expect(showMessageBox).toHaveBeenCalledTimes(1);
      expect(showMessageBox.mock.calls[0]?.[1].message).toBe(
        "Could not download or prepare the update",
      );
    } finally {
      controller.stop();
    }
  });

  test("background metadata failures remain log-only and can be retried manually", async () => {
    jest.useFakeTimers();
    const { controller, updater, showMessageBox } = createHarness(new Error("offline"));
    try {
      controller.start();
      jest.advanceTimersByTime(30_000);
      await flush();
      expect(showMessageBox).not.toHaveBeenCalled();
      spyOn(updater, "checkForUpdates").mockResolvedValueOnce(null);
      await controller.checkNow();
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
      expect(showMessageBox.mock.calls[0]?.[1].message).toContain("is up to date");
    } finally {
      controller.stop();
    }
  });
});
