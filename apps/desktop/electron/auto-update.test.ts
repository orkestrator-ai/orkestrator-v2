import { describe, expect, mock, test } from "bun:test";
import {
  DISABLE_AUTO_UPDATE_ENV,
  createAutoUpdateController,
  isAutoUpdateSupported,
  type AutoUpdateEnvironment,
  type UpdaterLike,
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

function createHarness(checkResult: { isUpdateAvailable?: boolean } | Error = {}) {
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
  const controller = createAutoUpdateController({
    updater,
    productName: "Orkestrator AI",
    currentVersion: "2.19.9",
    getWindow: () => null,
    showMessageBox,
    log: { info: () => undefined, warn: () => undefined },
  });
  const emit = (event: string, arg: unknown) => listeners.get(event)?.(arg as never);
  return { updater, showMessageBox, controller, emit };
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
