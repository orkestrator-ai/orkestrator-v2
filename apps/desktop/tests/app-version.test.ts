import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DESKTOP_PACKAGE_VERSION, desktopApplicationVersion } from "../electron/app-version";

const manifestVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

describe("desktopApplicationVersion", () => {
  test("reads the desktop manifest version", () => {
    expect(DESKTOP_PACKAGE_VERSION).toBe(manifestVersion);
  });

  test("an unpackaged run reports the package version, not Electron's own", () => {
    // What `app.getVersion()` returns when the dev launcher starts Electron on
    // `apps/desktop/dist/electron/main.js`: Electron's release, not Orkestrator's.
    const electronOwnVersion = "45.0.0";
    expect(electronOwnVersion).not.toBe(manifestVersion);

    expect(
      desktopApplicationVersion({ isPackaged: false, getVersion: () => electronOwnVersion }),
    ).toBe(manifestVersion);
  });

  test("a packaged app keeps Electron's application version", () => {
    expect(
      desktopApplicationVersion({ isPackaged: true, getVersion: () => "2.31.0" }, "2.30.0-beta"),
    ).toBe("2.31.0");
  });
});
