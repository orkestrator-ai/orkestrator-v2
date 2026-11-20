import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_REGISTRY_INDEX_FORMAT,
  CAPABILITY_REGISTRY_LIMITS,
  capabilityRegistrySigningPayload,
  isCapabilityRegistryForbidden,
  isCapabilitySourceForbidden,
  parseCapabilityRegistryInput,
  validateCapabilityRegistryIndex,
} from "./capability-registry.js";
import { capabilityPackageId, isPackageSource } from "./capability-resources.js";

const commit = "c".repeat(40);
const sha = "d".repeat(64);
const index = (packages: unknown, extra: Record<string, unknown> = {}) => ({
  format: CAPABILITY_REGISTRY_INDEX_FORMAT,
  version: 1,
  packages,
  ...extra,
});

describe("registry identity", () => {
  test("a registry package is registry:<registryId>/<qualifiedId>", () => {
    const source = { kind: "registry" as const, registryId: "team", qualifiedId: "@team/review" };
    expect(isPackageSource(source)).toBe(true);
    expect(capabilityPackageId(source)).toBe("registry:team/@team/review");
    for (const bad of [
      { kind: "registry", registryId: "Team", qualifiedId: "x" },
      { kind: "registry", registryId: "team", qualifiedId: "../x" },
      { kind: "registry", registryId: "team", qualifiedId: "a//b" },
      { kind: "registry", registryId: "team", qualifiedId: "/abs" },
    ]) {
      expect(isPackageSource(bad)).toBe(false);
    }
  });

  test("forbiddenSources forbids a registry by prefix", () => {
    expect(isCapabilityRegistryForbidden(["registry:team/"], "team")).toBe(true);
    expect(isCapabilityRegistryForbidden(["registry:team"], "team")).toBe(true);
    expect(isCapabilityRegistryForbidden(["registry:team/"], "teamwork")).toBe(false);
    expect(isCapabilityRegistryForbidden(["registry:team/x"], "team")).toBe(false);
    expect(isCapabilitySourceForbidden(["registry:team/x"], "registry:team/x/y")).toBe(true);
  });
});

describe("registry index", () => {
  test("a valid index parses; latest defaults to the first version", () => {
    const { index: parsed, issues } = validateCapabilityRegistryIndex(
      index({
        "team/review": {
          displayName: "Review",
          versions: [
            { version: "1.1.0", git: { repo: "https://github.com/t/r", subpath: "s", commit } },
            {
              version: "1.0.0",
              tarball: { url: "https://cdn.example.com/r.tgz", sha256: `sha256:${sha}` },
            },
          ],
        },
      }),
    );
    expect(issues).toEqual([]);
    expect(parsed?.packages["team/review"]).toMatchObject({
      latest: "1.1.0",
      versions: [
        { version: "1.1.0", artifact: { kind: "git", commit } },
        { version: "1.0.0", artifact: { kind: "tarball", sha256: sha, subpath: "" } },
      ],
    });
  });

  test("unsafe or malformed entries are dropped and reported", () => {
    const { index: parsed, issues } = validateCapabilityRegistryIndex(
      index({
        "../escape": { versions: [] },
        "team/short-commit": {
          versions: [{ version: "1", git: { repo: "https://x/y", subpath: "", commit: "abc" } }],
        },
        "team/http": {
          versions: [{ version: "1", tarball: { url: "http://x/y.tgz", sha256: sha } }],
        },
        "team/creds": {
          versions: [{ version: "1", tarball: { url: "https://u:p@x/y.tgz", sha256: sha } }],
        },
        "team/local-repo": {
          versions: [{ version: "1", git: { repo: "/home/me/repo", subpath: "", commit } }],
        },
        "team/escape-subpath": {
          versions: [
            {
              version: "1",
              tarball: { url: "https://x/y.tgz", sha256: sha, subpath: "../up" },
            },
          ],
        },
        "team/bad-latest": {
          latest: "9",
          versions: [{ version: "1", tarball: { url: "https://x/y.tgz", sha256: sha } }],
        },
        "team/duplicate": {
          versions: [
            { version: "1", tarball: { url: "https://x/y.tgz", sha256: sha } },
            { version: "1", tarball: { url: "https://x/z.tgz", sha256: sha } },
          ],
        },
      }),
    );
    expect(Object.keys(parsed?.packages ?? {})).toEqual(["team/duplicate"]);
    const text = issues.map((issue) => issue.message).join("\n");
    for (const expected of [
      "Not a valid package name",
      "full commit",
      "https address",
      "https or SSH",
      "relative path",
      "latest must name",
      "listed twice",
    ]) {
      expect(text).toContain(expected);
    }
  });

  test("bounds: versions per package and packages per index", () => {
    const versions = Array.from(
      { length: CAPABILITY_REGISTRY_LIMITS.maxVersionsPerPackage + 1 },
      (_, i) => ({ version: `${i}`, tarball: { url: "https://x/y.tgz", sha256: sha } }),
    );
    expect(validateCapabilityRegistryIndex(index({ a: { versions } })).issues[0]?.message).toBe(
      "Expected 1 to 100 versions.",
    );
    const many = Object.fromEntries(
      Array.from({ length: CAPABILITY_REGISTRY_LIMITS.maxPackagesPerIndex + 1 }, (_, i) => [
        `p${i}`,
        {},
      ]),
    );
    expect(validateCapabilityRegistryIndex(index(many)).index).toBeNull();
  });

  test("a document that is not an index is refused", () => {
    expect(validateCapabilityRegistryIndex([]).index).toBeNull();
    expect(validateCapabilityRegistryIndex({ format: "npm", version: 1 }).index).toBeNull();
    expect(validateCapabilityRegistryIndex(index({}, { version: 2 })).index).toBeNull();
    expect(
      validateCapabilityRegistryIndex(index({}, { signature: { algorithm: "rsa" } })).issues[0]
        ?.message,
    ).toBe("The signature is malformed.");
  });

  test("the signing payload is canonical and leaves the signature out", () => {
    const a = capabilityRegistrySigningPayload({
      version: 1,
      format: "f",
      packages: { b: 1, a: 2 },
    });
    const b = capabilityRegistrySigningPayload({
      packages: { a: 2, b: 1 },
      format: "f",
      version: 1,
      signature: { value: "x" },
    });
    expect(a).toBe(b);
    expect(a).not.toContain("signature");
  });
});

describe("registry settings input", () => {
  test("ids, https addresses and keys are checked", () => {
    expect(
      parseCapabilityRegistryInput({ id: "team", indexUrl: "https://r.example.com/index.json" }),
    ).toEqual({
      registry: { id: "team", label: "team", indexUrl: "https://r.example.com/index.json" },
    });
    expect(parseCapabilityRegistryInput({ id: "Team", indexUrl: "https://x" })).toHaveProperty(
      "error",
    );
    expect(parseCapabilityRegistryInput({ id: "t", indexUrl: "http://x/i.json" })).toHaveProperty(
      "error",
    );
    expect(
      parseCapabilityRegistryInput({ id: "t", indexUrl: "https://x/i.json", signingKey: "short" }),
    ).toHaveProperty("error");
  });
});
