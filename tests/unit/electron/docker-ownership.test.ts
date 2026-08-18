import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  dockerContainerRuntimeName,
  dockerOwnerNamespace,
} from "../../../apps/backend/src/core/docker-ownership";

const { countPrunedDockerResources, dockerOwnerMatches, parseDockerByteSize } = (
  await import("../../../apps/backend/src/core/commands")
).__testing;

describe("Docker registry ownership", () => {
  test("is stable for one resolved data directory and distinct across registries", () => {
    const packagedData = path.join(path.sep, "data", "orkestrator-v2");
    const developmentData = path.join(path.sep, "data", "orkestrator-v2-dev");

    expect(dockerOwnerNamespace(packagedData)).toBe(
      dockerOwnerNamespace(path.join(packagedData, ".")),
    );
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

  test("strips leading and trailing separators Docker rejects in a name", () => {
    expect(dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", "..env--")).toBe(
      "ork-aaaaaaaaaaaaaaaa-env",
    );
    expect(dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", "-lead-trail.")).toBe(
      "ork-aaaaaaaaaaaaaaaa-lead-trail",
    );
  });

  test("falls back to a fixed segment when an id sanitizes away entirely", () => {
    // Docker rejects an empty name and one ending in the separator, so the empty
    // sanitizer result must not reach the daemon as `ork-<owner>-`.
    for (const emptyish of ["", "///", "...", "---", "!!!"]) {
      expect(dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", emptyish)).toBe(
        "ork-aaaaaaaaaaaaaaaa-environment",
      );
    }
  });

  test("bounds the generated name and keeps it Docker-legal after truncation", () => {
    const name = dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", "e".repeat(400));

    expect(name.length).toBe(128);
    expect(name.startsWith("ork-aaaaaaaaaaaaaaaa-")).toBe(true);
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });
});

describe("dockerOwnerMatches", () => {
  const owner = "aaaaaaaaaaaaaaaa";

  test("adopts a container created before the owner label existed", () => {
    // Docker cannot label an existing container, so refusing these would strand
    // every pre-upgrade container: unlistable and unreachable by the orphan sweep.
    expect(dockerOwnerMatches("app=orkestrator-v2", owner)).toBe(true);
    expect(dockerOwnerMatches("", owner)).toBe(true);
    expect(dockerOwnerMatches(undefined, owner)).toBe(true);
  });

  test("claims its own containers and rejects another registry's", () => {
    expect(dockerOwnerMatches(`app=orkestrator-v2,orkestrator-owner=${owner}`, owner)).toBe(true);
    expect(dockerOwnerMatches(`orkestrator-owner=${owner},environment-name=x`, owner)).toBe(true);
    expect(dockerOwnerMatches("orkestrator-owner=bbbbbbbbbbbbbbbb", owner)).toBe(false);
    // A prefix of the key must not be read as the key.
    expect(dockerOwnerMatches(`not-orkestrator-owner=${owner}`, owner)).toBe(true);
  });

  test("does not confuse an empty owner label with an absent one", () => {
    expect(dockerOwnerMatches("orkestrator-owner=", owner)).toBe(false);
    expect(dockerOwnerMatches("orkestrator-owner", owner)).toBe(false);
  });

  test("requires an exact owner in agent-test mode", () => {
    expect(dockerOwnerMatches(`orkestrator-owner=${owner}`, owner, true)).toBe(true);
    expect(dockerOwnerMatches("app=orkestrator-v2", owner, true)).toBe(false);
    expect(dockerOwnerMatches(undefined, owner, true)).toBe(false);
    expect(dockerOwnerMatches("orkestrator-owner=bbbbbbbbbbbbbbbb", owner, true)).toBe(false);
  });
});

describe("countPrunedDockerResources", () => {
  test("counts every id listed under the deleted heading", () => {
    expect(
      countPrunedDockerResources(
        "Deleted Containers:\nabc\ndef\n\nTotal reclaimed space: 1.25GB\n",
      ),
    ).toBe(2);
  });

  test("stops at the reclaimed-space line when no blank line separates it", () => {
    expect(
      countPrunedDockerResources("Deleted Containers:\nabc\nTotal reclaimed space: 10B\n"),
    ).toBe(1);
  });

  test("reports zero when the prune removed nothing", () => {
    // Docker omits the heading entirely, which drives the UI's
    // "Nothing to clean up" branch — it must not read as a parse failure.
    expect(countPrunedDockerResources("Total reclaimed space: 0B\n")).toBe(0);
    expect(countPrunedDockerResources("")).toBe(0);
  });
});

describe("parseDockerByteSize", () => {
  test("converts Docker decimal and binary sizes to byte counts", () => {
    expect(parseDockerByteSize("1.25GB")).toBe(1_250_000_000);
    expect(parseDockerByteSize("2 MiB")).toBe(2_097_152);
    expect(parseDockerByteSize("n/a")).toBe(0);
  });
});
