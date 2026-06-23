import { afterEach, describe, expect, test } from "bun:test";
import type { Environment } from "@/types";
import { getEnvironmentPortAddress } from "./environment-address";

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "test-env",
    branch: "main",
    containerId: "container-1",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

afterEach(() => {
  delete window.orkestratorGateway;
});

describe("getEnvironmentPortAddress", () => {
  test("returns the host localhost address for a mapped container port", () => {
    const environment = makeEnvironment({ entryPort: 3000, hostEntryPort: 49152 });

    expect(getEnvironmentPortAddress(environment)).toBe("localhost:49152");
  });

  test("returns null when there is no selected environment", () => {
    expect(getEnvironmentPortAddress(null)).toBeNull();
    expect(getEnvironmentPortAddress(undefined)).toBeNull();
  });

  test("returns null when the entry port is not configured", () => {
    const environment = makeEnvironment({ hostEntryPort: 49152 });

    expect(getEnvironmentPortAddress(environment)).toBeNull();
  });

  test("returns null when the host port is not mapped", () => {
    const environment = makeEnvironment({ entryPort: 3000 });

    expect(getEnvironmentPortAddress(environment)).toBeNull();
  });

  test("formats host port 0 when it is explicitly mapped", () => {
    const environment = makeEnvironment({ entryPort: 3000, hostEntryPort: 0 });

    expect(getEnvironmentPortAddress(environment)).toBe("localhost:0");
  });

  test("returns a gateway proxy URL when the renderer is served remotely", () => {
    window.orkestratorGateway = { enabled: true };
    const environment = makeEnvironment({ entryPort: 3000, hostEntryPort: 49152 });

    expect(getEnvironmentPortAddress(environment)).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/49152/`,
    );
  });

  test("returns null for host port 0 when the renderer is served remotely", () => {
    window.orkestratorGateway = { enabled: true };
    const environment = makeEnvironment({ entryPort: 3000, hostEntryPort: 0 });

    expect(getEnvironmentPortAddress(environment)).toBeNull();
  });

  test("returns null for local environments", () => {
    const environment = makeEnvironment({
      environmentType: "local",
      entryPort: 3000,
      hostEntryPort: 49152,
      worktreePath: "/tmp/repo",
    });

    expect(getEnvironmentPortAddress(environment)).toBeNull();
  });
});
