import { describe, expect, test } from "bun:test";
import {
  APT_PACKAGE_DENYLIST,
  MAX_APT_PACKAGES,
  aptPackageRefusal,
  declaredAptPackages,
  declaredAptPackagesFromText,
  declaresAptPackages,
} from "./apt-packages";

describe("aptPackages declarations", () => {
  test("absent, null or unparseable declares none", () => {
    for (const config of [{}, { aptPackages: null }, null, "text", ["aptPackages"]]) {
      const declared = declaredAptPackages(config);
      expect(declared).toEqual({ packages: [], refused: [], invalid: false });
      expect(declaresAptPackages(declared)).toBe(false);
    }
    expect(declaredAptPackagesFromText("{not json")).toEqual({
      packages: [],
      refused: [],
      invalid: false,
    });
  });

  test("an array declares each name once, in order, skipping empty strings", () => {
    const declared = declaredAptPackages({
      aptPackages: ["libvips-dev", "", "g++", "libvips-dev", "python3.13"],
    });
    expect(declared).toEqual({
      packages: ["libvips-dev", "g++", "python3.13"],
      refused: [],
      invalid: false,
    });
    expect(declaresAptPackages(declared)).toBe(true);
    expect(declaresAptPackages(declaredAptPackages({ aptPackages: [] }))).toBe(false);
  });

  test("names the installer refuses outright are reported, not installed", () => {
    const declared = declaredAptPackages({
      aptPackages: ["sudo", "openssh-server", "Foo", "x", "-o", "sud.;rm", "pkg:amd64", "a=1"],
    });
    expect(declared.packages).toEqual([]);
    expect(declared.refused).toEqual([
      { name: "sudo", reason: "denied" },
      { name: "openssh-server", reason: "denied" },
      { name: "Foo", reason: "malformed" },
      { name: "x", reason: "malformed" },
      { name: "-o", reason: "malformed" },
      { name: "sud.;rm", reason: "malformed" },
      { name: "pkg:amd64", reason: "malformed" },
      { name: "a=1", reason: "malformed" },
    ]);
    expect(declaresAptPackages(declared)).toBe(true);
  });

  test("a field that is not a list of strings, or names too many, is invalid", () => {
    expect(declaredAptPackages({ aptPackages: "libvips-dev" }).invalid).toBe(true);
    expect(declaredAptPackages({ aptPackages: { name: "x" } }).invalid).toBe(true);
    expect(declaredAptPackages({ aptPackages: ["ok-pkg", 3] })).toEqual({
      packages: ["ok-pkg"],
      refused: [],
      invalid: true,
    });
    const many = Array.from({ length: MAX_APT_PACKAGES + 1 }, (_, index) => `pkg${index}`);
    const declared = declaredAptPackages({ aptPackages: many });
    expect(declared.invalid).toBe(true);
    expect(declared.packages).toHaveLength(MAX_APT_PACKAGES);
    // Duplicates count, as the installer counts every argument.
    const repeated = Array.from({ length: MAX_APT_PACKAGES + 1 }, () => "hello");
    expect(declaredAptPackages({ aptPackages: repeated }).invalid).toBe(true);
  });

  test("a refused name is shortened for display", () => {
    const long = "a".repeat(500);
    expect(declaredAptPackages({ aptPackages: [long] }).refused[0]?.name).toHaveLength(100);
    expect(aptPackageRefusal("a".repeat(101))).toBe("malformed");
    expect(aptPackageRefusal("a".repeat(100))).toBeNull();
  });

  test("the denylist holds only valid package names", () => {
    for (const name of APT_PACKAGE_DENYLIST) expect(aptPackageRefusal(name)).toBe("denied");
    expect(new Set(APT_PACKAGE_DENYLIST).size).toBe(APT_PACKAGE_DENYLIST.length);
  });
});
