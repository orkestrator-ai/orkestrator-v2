import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Environment } from "@/types";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { SetupPendingOverlay } from "./SetupPendingOverlay";

function createEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "test-env",
    branch: "main",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date().toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    ...overrides,
  };
}

describe("SetupPendingOverlay", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    useEnvironmentStore.setState({
      environments: [createEnvironment({ setupPhase: "running" })],
      isLoading: false,
      error: null,
      deletingEnvironments: new Set<string>(),
    });
  });

  test("renders the waiting copy and agent-specific subtext", () => {
    render(<SetupPendingOverlay environmentId="env-1" subtext="Claude will connect automatically" />);
    expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
    expect(screen.getByText("Claude will connect automatically")).toBeTruthy();
  });

  test("Skip button requires a confirmation step before firing the override", () => {
    render(<SetupPendingOverlay environmentId="env-1" subtext="x" />);

    fireEvent.click(screen.getByRole("button", { name: /skip setup wait/i }));

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.setupPhase)
      .toBe("running");
    expect(screen.getByRole("button", { name: /skip anyway/i })).toBeTruthy();
  });

  test("Cancel returns to the plain wait state without flipping gates", () => {
    render(<SetupPendingOverlay environmentId="env-1" subtext="x" />);
    fireEvent.click(screen.getByRole("button", { name: /skip setup wait/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.setupPhase)
      .toBe("running");
    expect(screen.getByRole("button", { name: /skip setup wait/i })).toBeTruthy();
  });
});
