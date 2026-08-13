import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  dockerContainerRuntimeName,
  dockerOwnerNamespace,
} from "../../../apps/backend/src/core/docker-ownership";

const {
  countPrunedDockerResources,
  dockerOwnerMatches,
  parseDockerByteSize,
} = (await import("../../../apps/backend/src/core/commands")).__testing;

describe("Docker registry ownership", () => {
  test("is stable for one resolved data directory and distinct across registries", () => {
    const packagedData = path.join(path.sep, "data", "orkestrator-v2");
    const developmentData = path.join(path.sep, "data", "orkestrator-v2-dev");

    expect(dockerOwnerNamespace(packagedData)).toBe(dockerOwnerNamespace(path.join(packagedData, ".")));
    expect(dockerOwnerNamespace(packagedData)).not.toBe(dockerOwnerNamespace(developmentData));
  });

  test("makes daemon-global container names owner-specific and Docker-safe", () => {
    const environmentId = "Feature / Environment";
    const packagedName = dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", environmentId);
    const developmentName = dockerContainerRuntimeName("bbbbbbbbbbbbbbbb", environmentId);

    expect(packagedName).toBe("ork-aaaaaaaaaaaaaaaa-feature-environment");
    expect(developmentName).toBe("ork-bbbbbbbbbbbbbbbb-feature-environment");
    expect(packagedName).not.toBe(developmentName);
  });

  test("keeps same-named project environments distinct through their ids", () => {
    const first = dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", "environment-project-a");
    const second = dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", "environment-project-b");

    expect(first).not.toBe(second);
  });

  test("normalizes empty, edge-separated, and oversized ids", () => {
    expect(dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", "..env--")).toBe(
      "ork-aaaaaaaaaaaaaaaa-env",
    );
    for (const emptyish of ["", "///", "...", "---", "!!!"]) {
      expect(dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", emptyish)).toBe(
        "ork-aaaaaaaaaaaaaaaa-environment",
      );
    }
    const longName = dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", "e".repeat(400));
    expect(longName.length).toBe(128);
    expect(longName).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });
});

describe("Docker cleanup parsing", () => {
  const owner = "aaaaaaaaaaaaaaaa";

  test("adopts legacy containers but rejects another registry owner", () => {
    expect(dockerOwnerMatches("app=orkestrator-v2", owner)).toBe(true);
    expect(dockerOwnerMatches(undefined, owner)).toBe(true);
    expect(dockerOwnerMatches(`app=orkestrator-v2,orkestrator-owner=${owner}`, owner)).toBe(true);
    expect(dockerOwnerMatches("orkestrator-owner=bbbbbbbbbbbbbbbb", owner)).toBe(false);
    expect(dockerOwnerMatches("orkestrator-owner=", owner)).toBe(false);
  });

  test("counts deleted containers without inventing removals", () => {
    expect(countPrunedDockerResources(
      "Deleted Containers:\nabc\ndef\n\nTotal reclaimed space: 1.25GB\n",
    )).toBe(2);
    expect(countPrunedDockerResources("Total reclaimed space: 0B\n")).toBe(0);
  });

  test("converts Docker decimal and binary sizes to byte counts", () => {
    expect(parseDockerByteSize("1.25GB")).toBe(1_250_000_000);
    expect(parseDockerByteSize("2 MiB")).toBe(2_097_152);
    expect(parseDockerByteSize("n/a")).toBe(0);
  });
});
