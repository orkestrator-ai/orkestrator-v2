import { describe, expect, test } from "bun:test";
import { desktopDevMode } from "../electron/dev-mode";

const devEnv = { ELECTRON_DEV: "1", VITE_DEV_SERVER_URL: "https://attacker.example" };

describe("desktopDevMode", () => {
  test("an unpacked app with ELECTRON_DEV=1 runs in development mode on the dev server", () => {
    expect(desktopDevMode({ isPackaged: false }, devEnv)).toEqual({
      isDev: true,
      devServerUrl: "https://attacker.example",
      ignoredDevRequest: false,
    });
  });

  test("a packaged app ignores ELECTRON_DEV and the dev server URL", () => {
    expect(desktopDevMode({ isPackaged: true }, devEnv)).toEqual({
      isDev: false,
      devServerUrl: undefined,
      ignoredDevRequest: true,
    });
  });

  test("a dev server URL alone never enables development mode", () => {
    for (const isPackaged of [false, true]) {
      expect(
        desktopDevMode({ isPackaged }, { VITE_DEV_SERVER_URL: "http://127.0.0.1:1420" }),
      ).toEqual({ isDev: false, devServerUrl: undefined, ignoredDevRequest: false });
    }
  });

  test("only the exact value 1 requests development mode", () => {
    for (const value of ["true", "0", " 1", ""]) {
      expect(desktopDevMode({ isPackaged: false }, { ELECTRON_DEV: value }).isDev).toBe(false);
    }
  });
});
