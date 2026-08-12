import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  dockerContainerRuntimeName,
  dockerOwnerNamespace,
} from "../../../apps/backend/src/core/docker-ownership";

describe("Docker registry ownership", () => {
  test("is stable for one resolved data directory and distinct across registries", () => {
    const packagedData = path.join(path.sep, "data", "orkestrator-v2");
    const developmentData = path.join(path.sep, "data", "orkestrator-v2-dev");

    expect(dockerOwnerNamespace(packagedData)).toBe(
      dockerOwnerNamespace(path.join(packagedData, ".")),
    );
    expect(dockerOwnerNamespace(packagedData)).not.toBe(
      dockerOwnerNamespace(developmentData),
    );
  });

  test("makes daemon-global container names owner-specific and Docker-safe", () => {
    const environmentId = "Feature / Environment";
    const packagedName = dockerContainerRuntimeName("aaaaaaaaaaaaaaaa", environmentId);
    const developmentName = dockerContainerRuntimeName("bbbbbbbbbbbbbbbb", environmentId);

    expect(packagedName).toBe("ork-aaaaaaaaaaaaaaaa-feature-environment");
    expect(developmentName).toBe("ork-bbbbbbbbbbbbbbbb-feature-environment");
    expect(packagedName).not.toBe(developmentName);
  });
});
