import { describe, expect, test } from "bun:test";
import {
  appVersionSkew,
  BUNDLED_APP_VERSION,
  compareAppVersions,
  normalizeBackendVersion,
} from "./app-version";
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

describe("compareAppVersions", () => {
  test("orders release versions numerically, not lexically", () => {
    expect(compareAppVersions("2.19.9", "2.19.17")).toBe(-1);
    expect(compareAppVersions("2.20.0", "2.19.17")).toBe(1);
    expect(compareAppVersions("10.0.0", "9.99.99")).toBe(1);
    expect(compareAppVersions("v2.19.17", "2.19.17")).toBe(0);
  });

  test("ranks a prerelease below its release and orders prereleases", () => {
    expect(compareAppVersions("2.20.0-beta.1", "2.20.0")).toBe(-1);
    expect(compareAppVersions("2.20.0", "2.20.0-beta.1")).toBe(1);
    expect(compareAppVersions("2.20.0-beta.2", "2.20.0-beta.10")).toBe(-1);
    expect(compareAppVersions("2.20.0-beta", "2.20.0-beta.1")).toBe(-1);
    expect(compareAppVersions("2.20.0-1", "2.20.0-alpha")).toBe(-1);
  });

  test("ignores build metadata", () => {
    expect(compareAppVersions("2.19.17+abc", "2.19.17+def")).toBe(0);
  });

  test("refuses to order a version that is not semver", () => {
    expect(compareAppVersions("dev", "2.19.17")).toBeNull();
    expect(compareAppVersions("2.19", "2.19.17")).toBeNull();
  });
});

describe("appVersionSkew", () => {
  test("names which side is older", () => {
    expect(appVersionSkew("2.19.17", "2.19.17")).toBe("same");
    expect(appVersionSkew("2.19.17", "2.20.0")).toBe("client-older");
    expect(appVersionSkew("2.20.0", "2.19.17")).toBe("backend-older");
    expect(appVersionSkew("2.19.17+a", "2.19.17+b")).toBe("same");
  });

  test("reports an unorderable mismatch without guessing a direction", () => {
    expect(appVersionSkew("dev", "2.19.17")).toBe("different");
    expect(appVersionSkew("dev", "dev")).toBe("same");
  });
});
