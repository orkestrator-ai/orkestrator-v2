import { describe, expect, test } from "bun:test";
import { BUNDLED_APP_VERSION, normalizeBackendVersion } from "./app-version";
import webPackage from "../../package.json";

describe("app version", () => {
  test("reads the web package version", () => {
    expect(BUNDLED_APP_VERSION).toBe(webPackage.version);
    expect(BUNDLED_APP_VERSION).toMatch(/^[A-Za-z0-9._+-]{1,64}$/);
  });

  test("keeps a real backend version", () => {
    expect(normalizeBackendVersion("2.16.0")).toBe("2.16.0");
    expect(normalizeBackendVersion(" 2.16.0 ")).toBe("2.16.0");
  });

  test("treats a missing or placeholder backend version as unreported", () => {
    // Never substitute the client's own version: the debug tab shows both side
    // by side, so a fallback would hide exactly the mismatch it exists to show.
    expect(normalizeBackendVersion(null)).toBeNull();
    expect(normalizeBackendVersion(undefined)).toBeNull();
    expect(normalizeBackendVersion("")).toBeNull();
    expect(normalizeBackendVersion("   ")).toBeNull();
    expect(normalizeBackendVersion("0.0.0")).toBeNull();
  });
});
