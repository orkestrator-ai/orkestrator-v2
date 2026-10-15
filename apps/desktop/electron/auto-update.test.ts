import { describe, expect, test } from "bun:test";
import {
  DISABLE_AUTO_UPDATE_ENV,
  autoUpdateUnavailableReason,
  isAutoUpdateSupported,
  type AutoUpdateEnvironment,
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
    const appImage = { ...linux, env: { APPIMAGE: "/opt/apps/app.AppImage" } };
    expect(isAutoUpdateSupported({ ...appImage, isWritable: () => true })).toBe(true);
  });

  test("on Linux needs a writable folder to replace the AppImage in", () => {
    const appImage = {
      ...supported,
      platform: "linux" as const,
      env: { APPIMAGE: "/opt/apps/app.AppImage" },
    };
    const checked: string[] = [];
    const reason = autoUpdateUnavailableReason({
      ...appImage,
      isWritable: (directory) => {
        checked.push(directory);
        return false;
      },
    });
    expect(checked).toEqual(["/opt/apps"]);
    expect(reason).toContain("not writable");
  });
});

describe("autoUpdateUnavailableReason", () => {
  test("names why an install cannot update itself, for the update panel", () => {
    expect(autoUpdateUnavailableReason(supported)).toBeNull();
    expect(
      autoUpdateUnavailableReason({ ...supported, env: { [DISABLE_AUTO_UPDATE_ENV]: "1" } }),
    ).toContain("turned off");
    expect(autoUpdateUnavailableReason({ ...supported, isPackaged: false })).toContain(
      "Development",
    );
    expect(autoUpdateUnavailableReason({ ...supported, platform: "linux" })).toContain(
      "package manager",
    );
    expect(autoUpdateUnavailableReason({ ...supported, fileExists: () => false })).toContain(
      "release build",
    );
  });
});
