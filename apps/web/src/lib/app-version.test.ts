import { describe, expect, test } from "bun:test";
import { BUNDLED_APP_VERSION, resolveDisplayedAppVersion } from "./app-version";
import webPackage from "../../package.json";

describe("app version", () => {
  test("reads the web package version", () => {
    expect(BUNDLED_APP_VERSION).toBe(webPackage.version);
    expect(BUNDLED_APP_VERSION).toMatch(/^[A-Za-z0-9._+-]{1,64}$/);
  });

  test("prefers a real runtime version over the bundle", () => {
    expect(resolveDisplayedAppVersion("2.16.0")).toBe("2.16.0");
    expect(resolveDisplayedAppVersion(" 2.16.0 ")).toBe("2.16.0");
  });

  test("falls back to the bundle when runtime is missing or unset", () => {
    expect(resolveDisplayedAppVersion(null)).toBe(BUNDLED_APP_VERSION);
    expect(resolveDisplayedAppVersion(undefined)).toBe(BUNDLED_APP_VERSION);
    expect(resolveDisplayedAppVersion("")).toBe(BUNDLED_APP_VERSION);
    expect(resolveDisplayedAppVersion("0.0.0")).toBe(BUNDLED_APP_VERSION);
    expect(resolveDisplayedAppVersion("   ")).toBe(BUNDLED_APP_VERSION);
  });
});
