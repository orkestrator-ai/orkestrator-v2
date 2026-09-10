import { describe, expect, test } from "bun:test";
import {
  BUNDLED_APP_VERSION,
  resolveDisplayedAppVersion,
  type DisplayedAppVersion,
} from "./app-version";
import webPackage from "../../package.json";

describe("app version", () => {
  test("reads the web package version", () => {
    expect(BUNDLED_APP_VERSION).toBe(webPackage.version);
    expect(BUNDLED_APP_VERSION).toMatch(/^[A-Za-z0-9._+-]{1,64}$/);
  });

  test("prefers a real runtime version over the bundle", () => {
    expect(resolveDisplayedAppVersion("2.16.0")).toEqual({
      version: "2.16.0",
      source: "runtime",
    });
    expect(resolveDisplayedAppVersion(" 2.16.0 ")).toEqual({
      version: "2.16.0",
      source: "runtime",
    });
  });

  test("falls back to the bundle when runtime is missing or unset", () => {
    const bundled: DisplayedAppVersion = { version: BUNDLED_APP_VERSION, source: "bundled" };
    expect(resolveDisplayedAppVersion(null)).toEqual(bundled);
    expect(resolveDisplayedAppVersion(undefined)).toEqual(bundled);
    expect(resolveDisplayedAppVersion("")).toEqual(bundled);
    expect(resolveDisplayedAppVersion("0.0.0")).toEqual(bundled);
    expect(resolveDisplayedAppVersion("   ")).toEqual(bundled);
  });

  test("marks the source so a fallback is never read as a backend answer", () => {
    // The debug tab renders this distinction, so losing it would silently turn
    // an unreachable backend into a plausible-looking version.
    expect(resolveDisplayedAppVersion("9.8.7-test").source).toBe("runtime");
    expect(resolveDisplayedAppVersion(null).source).toBe("bundled");
  });
});
