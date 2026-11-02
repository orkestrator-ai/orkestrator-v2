import { afterEach, beforeEach, describe, expect, test, type Mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { portalStore } from "@/lib/portal/portal-store";
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
    portalStore.store.setState({ nodes: [], selfId: null });
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("a held setup shows its commands beside the default branch's instead of a retry", async () => {
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);
    expect(await screen.findByText("curl https://example.invalid | sh")).toBeTruthy();
    expect(screen.getByText("bun install")).toBeTruthy();
    expect(screen.getByText("The main branch runs:")).toBeTruthy();
    expect(screen.queryByText("Retry setup") === null).toBe(true);
    // A single machine has nowhere else to approve it.
    expect(screen.queryByText("Approve on every machine") === null).toBe(true);
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

  test("rejected commands are refreshed and need a new explicit approval", async () => {
    let changed = false;
    invokeMock.mockImplementation(async (command, args) => {
      calls.push({ command, args });
      if (command === "get_environment_setup_approval")
        return {
          environmentId: "env-1",
          projectId: "project-1",
          hash: changed ? "b".repeat(64) : HASH,
          commands: [changed ? "echo B" : "echo A"],
          defaultBranch: "main",
          defaultBranchCommands: [],
          approvalRequired: true,
        };
      if (command === "approve_environment_setup") {
        if (args?.hash === HASH) {
          changed = true;
          throw new Error("Commands changed; review again");
        }
        return { ...heldEnvironment(), setupApprovalRequired: false, setupPhase: "running" };
      }
    });
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);
    fireEvent.click(await screen.findByText("Run once"));
    expect(await screen.findByText("echo B")).toBeTruthy();
    expect(calls.filter((c) => c.command === "approve_environment_setup")).toHaveLength(1);
    fireEvent.click(screen.getByText("Run once"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        command: "approve_environment_setup",
        args: { environmentId: "env-1", hash: "b".repeat(64), remember: false },
      }),
    );
  });

  test("skip requires confirmation and can be cancelled", async () => {
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);
    await screen.findByText("Run once");
    fireEvent.click(screen.getByText("Skip setup"));
    expect(calls.some((c) => c.command === "override_environment_setup")).toBe(false);
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(screen.getByText("Skip setup"));
    fireEvent.click(screen.getByText("Skip setup"));
    await waitFor(() =>
      expect(calls.some((c) => c.command === "override_environment_setup")).toBe(true),
    );
  });

  test("machine outcomes require acknowledgement before starting here", async () => {
    portalStore.store.setState({ selfId: "bk_test" as never });
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "approve_setup_commands_on_nodes") {
        calls.push({ command, args });
        return {
          nodes: [
            { nodeId: "bk_test", nodeName: "Desk", status: "approved", projectIds: ["project-1"] },
            { nodeId: "bk_offline", nodeName: "Laptop", status: "not-connected", projectIds: [] },
          ],
        };
      }
      return original(command, args);
    });
    // A workspace target enables federation without fabricating node summaries.
    portalStore.store.setState({ nodes: [{ nodeId: "bk_offline" }] as never });
    render(
      <FederationProvider>
        <SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />
      </FederationProvider>,
    );
    fireEvent.click(await screen.findByText("Approve on every machine"));
    expect(await screen.findByText("Laptop: not connected; approve it there later")).toBeTruthy();
    expect(calls.filter((c) => c.command === "approve_environment_setup")).toHaveLength(0);
    expect(calls).toContainEqual({
      command: "approve_setup_commands_on_nodes",
      args: { nodeId: "bk_test", projectId: "project-1", hash: HASH },
    });
    fireEvent.click(screen.getByText("Approve for this project"));
    await waitFor(() =>
      expect(calls).toContainEqual({
        command: "approve_environment_setup",
        args: { environmentId: "env-1", hash: HASH, remember: true },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("setup-approval-panel") === null).toBe(true));
  });

  test("an ordinary setup failure still offers a retry", () => {
    useEnvironmentStore.setState({
      environments: [{ ...heldEnvironment(), setupApprovalRequired: false }],
    });
    render(<SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />);
    expect(screen.getByText("Retry setup")).toBeTruthy();
    expect(screen.queryByTestId("setup-approval-panel") === null).toBe(true);
  });
});
