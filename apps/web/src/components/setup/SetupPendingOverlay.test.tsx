import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Environment } from "@/types";
import { useEnvironmentStore } from "@/stores/environmentStore";
import * as realSetupCommands from "@/lib/setup-commands";

const realSetupCommandsSnapshot = { ...realSetupCommands };
const forceResolveSetupRuntime = mock(async () => undefined);
const retrySetupRuntime = mock(async () => undefined);

mock.module("@/lib/setup-commands", () => ({
  ...realSetupCommandsSnapshot,
  forceResolveSetupRuntime,
  retrySetupRuntime,
}));

const { SetupPendingOverlay } = await import("./SetupPendingOverlay");

afterAll(() => {
  mock.module("@/lib/setup-commands", () => realSetupCommandsSnapshot);
});

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
    forceResolveSetupRuntime.mockReset();
    forceResolveSetupRuntime.mockResolvedValue(undefined);
    retrySetupRuntime.mockReset();
    retrySetupRuntime.mockResolvedValue(undefined);
    useEnvironmentStore.setState({
      environments: [createEnvironment({ setupPhase: "running" })],
      isLoading: false,
      error: null,
      deletingEnvironments: new Set<string>(),
    });
  });

  test("renders the waiting copy and agent-specific subtext", () => {
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="running" subtext="Claude will connect automatically" />);
    expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
    expect(screen.getByText("Claude will connect automatically")).toBeTruthy();
  });

  test("Skip button requires a confirmation step before firing the override", () => {
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="running" subtext="x" />);

    fireEvent.click(screen.getByRole("button", { name: /skip setup wait/i }));

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.setupPhase)
      .toBe("running");
    expect(screen.getByRole("button", { name: /skip anyway/i })).toBeTruthy();
  });

  test("Cancel returns to the plain wait state without flipping gates", () => {
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="running" subtext="x" />);
    fireEvent.click(screen.getByRole("button", { name: /skip setup wait/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.setupPhase)
      .toBe("running");
    expect(screen.getByRole("button", { name: /skip setup wait/i })).toBeTruthy();
  });

  test("renders failed setup actions instead of an indefinite waiting spinner", () => {
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);

    expect(screen.getByText("Environment setup failed.")).toBeTruthy();
    expect(screen.queryByText("Waiting for setup scripts to complete...")).toBeNull();
    expect(screen.getByRole("button", { name: /retry setup/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /skip setup/i })).toBeTruthy();
  });

  test("retries a failed setup and disables duplicate submissions", async () => {
    let resolveRetry!: () => void;
    retrySetupRuntime.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      resolveRetry = () => resolve(undefined);
    }));
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);

    fireEvent.click(screen.getByRole("button", { name: /^retry setup$/i }));

    expect(retrySetupRuntime).toHaveBeenCalledWith("env-1");
    expect((screen.getByRole("button", { name: /retrying setup/i }) as HTMLButtonElement).disabled)
      .toBe(true);
    resolveRetry();
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /^retry setup$/i }) as HTMLButtonElement).disabled)
        .toBe(false);
    });
  });

  test("surfaces override failures and lets the user try again", async () => {
    forceResolveSetupRuntime.mockRejectedValueOnce(new Error("Backend unavailable"));
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);
    fireEvent.click(screen.getByRole("button", { name: /^skip setup$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^skip anyway$/i }));

    expect(forceResolveSetupRuntime).toHaveBeenCalledWith("env-1");
    expect((await screen.findByRole("alert")).textContent).toContain("Backend unavailable");
    expect((screen.getByRole("button", { name: /^skip anyway$/i }) as HTMLButtonElement).disabled)
      .toBe(false);
  });
});
