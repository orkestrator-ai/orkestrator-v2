import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { invoke } from "@/lib/native/backend";
import type { Mock } from "bun:test";
import type { Environment } from "@/types";
import { environmentStore } from "@/stores/environmentStore";
import { appCommandScope } from "@/lib/node-scope-slots";
import * as realSetupCommands from "@/lib/setup-commands";
import { appCommandStore } from "@/test/app-command-store";

const invokeMock = invoke as unknown as Mock<typeof invoke>;

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
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  beforeEach(() => {
    forceResolveSetupRuntime.mockReset();
    forceResolveSetupRuntime.mockResolvedValue(undefined);
    retrySetupRuntime.mockReset();
    retrySetupRuntime.mockResolvedValue(undefined);
    appCommandStore(environmentStore).setState({
      environments: [createEnvironment({ setupPhase: "running" })],
      isLoading: false,
      error: null,
      deletingEnvironments: new Set<string>(),
    });
  });

  test("renders the waiting copy and agent-specific subtext", () => {
    renderInAppCommandScope(
      <SetupPendingOverlay
        environmentId="env-1"
        setupPhase="running"
        subtext="Claude will connect automatically"
      />,
    );
    expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
    expect(screen.getByText("Claude will connect automatically")).toBeTruthy();
  });

  test("shows the queued opening prompt as a sent message with the wait beneath it", () => {
    const { rerender } = renderInAppCommandScope(
      <SetupPendingOverlay environmentId="env-1" setupPhase="running" subtext="x" />,
    );
    expect(screen.queryByTestId("setup-pending-prompt") === null).toBe(true);

    rerender(
      <SetupPendingOverlay
        environmentId="env-1"
        setupPhase="running"
        subtext="Claude will connect automatically"
        pendingPrompt={{ text: "Fix the login bug", createdAt: "2026-11-02T10:00:00.000Z" }}
      />,
    );
    const prompt = screen.getByTestId("setup-pending-prompt");
    expect(prompt.textContent).toContain("Fix the login bug");
    expect(prompt.textContent).toContain("You");
    expect(screen.getByRole("status").textContent).toBe("Waiting for setup scripts to complete...");
    // The transcript layout has no centered spinner or agent subtext.
    expect(screen.queryByText("Claude will connect automatically") === null).toBe(true);
  });

  test("the transcript layout keeps skip confirmation and failed-setup recovery", async () => {
    const pendingPrompt = { text: "Fix the login bug", createdAt: "2026-11-02T10:00:00.000Z" };
    const { rerender } = renderInAppCommandScope(
      <SetupPendingOverlay
        environmentId="env-1"
        setupPhase="running"
        subtext="x"
        pendingPrompt={pendingPrompt}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^skip setup wait$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^skip anyway$/i }));
    expect(forceResolveSetupRuntime).toHaveBeenCalledWith("env-1", appCommandScope());
    expect(await screen.findByRole("button", { name: /^skip setup wait$/i })).toBeTruthy();

    rerender(
      <SetupPendingOverlay
        environmentId="env-1"
        setupPhase="failed"
        subtext="x"
        pendingPrompt={pendingPrompt}
      />,
    );
    expect(screen.getByText("Environment setup failed.")).toBeTruthy();
    expect(screen.getByTestId("setup-pending-prompt").textContent).toContain("Fix the login bug");
    fireEvent.click(screen.getByRole("button", { name: /^retry setup$/i }));
    await waitFor(() => expect(retrySetupRuntime).toHaveBeenCalledWith("env-1", appCommandScope()));
  });

  test("held setup keeps the queued prompt above the approval panel instead of retry actions", async () => {
    appCommandStore(environmentStore).setState({
      environments: [createEnvironment({ setupPhase: "failed", setupApprovalRequired: true })],
    });
    invokeMock.mockResolvedValueOnce({
      environmentId: "env-1",
      projectId: "project-1",
      hash: "f".repeat(64),
      commands: ["bun install"],
      defaultBranch: "main",
      defaultBranchCommands: [],
      approvalRequired: true,
    });
    renderInAppCommandScope(
      <SetupPendingOverlay
        environmentId="env-1"
        setupPhase="failed"
        subtext="x"
        pendingPrompt={{ text: "Fix the login bug", createdAt: "2026-11-02T10:00:00.000Z" }}
      />,
    );

    expect(await screen.findByText("bun install")).toBeTruthy();
    const prompt = screen.getByTestId("setup-pending-prompt");
    const panel = screen.getByTestId("setup-approval-panel");
    expect(prompt.textContent).toContain("Fix the login bug");
    expect(prompt.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run once" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry setup/i }) === null).toBe(true);
    expect(screen.queryByRole("status") === null).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("get_environment_setup_approval", {
      environmentId: "env-1",
    });
    expect(retrySetupRuntime).not.toHaveBeenCalled();
    expect(forceResolveSetupRuntime).not.toHaveBeenCalled();
  });

  for (const kind of ["retry", "override"] as const) {
    test(`transcript ${kind} failure shows an inline error and allows another attempt`, async () => {
      const command = kind === "retry" ? retrySetupRuntime : forceResolveSetupRuntime;
      let rejectOperation!: (reason: Error) => void;
      command.mockImplementationOnce(
        () =>
          new Promise<undefined>((_resolve, reject) => {
            rejectOperation = reject;
          }),
      );
      renderInAppCommandScope(
        <SetupPendingOverlay
          environmentId="env-1"
          setupPhase="failed"
          subtext="x"
          pendingPrompt={{ text: "Fix the login bug", createdAt: "2026-11-02T10:00:00.000Z" }}
        />,
      );
      if (kind === "override") {
        fireEvent.click(screen.getByRole("button", { name: /^skip setup$/i }));
      }
      const actionName = kind === "retry" ? /^retry setup$/i : /^skip anyway$/i;
      const busyName = kind === "retry" ? /retrying setup/i : /skipping setup/i;
      fireEvent.click(screen.getByRole("button", { name: actionName }));
      const busyButton = screen.getByRole("button", { name: busyName }) as HTMLButtonElement;
      expect(busyButton.disabled).toBe(true);
      fireEvent.click(busyButton);
      expect(command).toHaveBeenCalledTimes(1);
      expect(command).toHaveBeenCalledWith("env-1", appCommandScope());
      if (kind === "override") {
        expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
          true,
        );
      }

      rejectOperation(new Error("Backend unavailable"));
      expect((await screen.findByRole("alert")).textContent).toBe("Backend unavailable");
      expect((screen.getByRole("button", { name: actionName }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(screen.getByTestId("setup-pending-prompt").textContent).toContain("Fix the login bug");
      if (kind === "override") {
        expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
          false,
        );
      }

      fireEvent.click(screen.getByRole("button", { name: actionName }));
      await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole("alert") === null).toBe(true));
      expect(
        await screen.findByRole("button", {
          name: kind === "retry" ? /^retry setup$/i : /^skip setup$/i,
        }),
      ).toBeTruthy();
    });
  }

  test("transcript elapsed time uses the queued timestamp, ticks, and survives remounting", () => {
    const startedAt = Date.parse("2026-11-02T10:00:00.000Z");
    const now = spyOn(Date, "now").mockReturnValue(startedAt + 64_000);
    const ticks: Array<() => void> = [];
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
    ) => {
      ticks.push(callback);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    try {
      const overlay = (
        <SetupPendingOverlay
          environmentId="env-1"
          setupPhase="running"
          subtext="x"
          pendingPrompt={{ text: "Fix the login bug", createdAt: "2026-11-02T10:00:00.000Z" }}
        />
      );
      const { unmount } = renderInAppCommandScope(overlay);
      expect(screen.getByText("1m 4s")).toBeTruthy();
      now.mockReturnValue(startedAt + 66_000);
      act(() => ticks.forEach((tick) => tick()));
      expect(screen.getByText("1m 6s")).toBeTruthy();
      expect(screen.queryByText("1m 4s") === null).toBe(true);
      unmount();
      expect(clear).toHaveBeenCalledWith(1);
      now.mockReturnValue(startedAt + 70_000);
      renderInAppCommandScope(overlay);
      expect(screen.getByText("1m 10s")).toBeTruthy();
    } finally {
      cleanup();
      interval.mockRestore();
      clear.mockRestore();
      now.mockRestore();
    }
  });

  test("an invalid queued timestamp omits the clock and keeps the prompt and setup controls", () => {
    const interval = spyOn(globalThis, "setInterval");
    try {
      const { container } = renderInAppCommandScope(
        <SetupPendingOverlay
          environmentId="env-1"
          setupPhase="running"
          subtext="x"
          pendingPrompt={{ text: "Fix the login bug", createdAt: "invalid-date" }}
        />,
      );
      expect(interval).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("NaN");
      expect(screen.getByTestId("setup-pending-prompt").textContent).toContain("Fix the login bug");
      expect(screen.getByRole("status").textContent).toBe(
        "Waiting for setup scripts to complete...",
      );
      expect(screen.getByRole("button", { name: /^skip setup wait$/i })).toBeTruthy();
    } finally {
      interval.mockRestore();
    }
  });

  test("Skip button requires a confirmation step before firing the override", () => {
    renderInAppCommandScope(
      <SetupPendingOverlay environmentId="env-1" setupPhase="running" subtext="x" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /skip setup wait/i }));

    expect(
      appCommandStore(environmentStore).getState().getEnvironmentById("env-1")?.setupPhase,
    ).toBe("running");
    expect(screen.getByRole("button", { name: /skip anyway/i })).toBeTruthy();
  });

  test("Cancel returns to the plain wait state without flipping gates", () => {
    renderInAppCommandScope(
      <SetupPendingOverlay environmentId="env-1" setupPhase="running" subtext="x" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /skip setup wait/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(
      appCommandStore(environmentStore).getState().getEnvironmentById("env-1")?.setupPhase,
    ).toBe("running");
    expect(screen.getByRole("button", { name: /skip setup wait/i })).toBeTruthy();
  });

  test("renders failed setup actions instead of an indefinite waiting spinner", () => {
    renderInAppCommandScope(
      <SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />,
    );

    expect(screen.getByText("Environment setup failed.")).toBeTruthy();
    expect(screen.queryByText("Waiting for setup scripts to complete...") === null).toBe(true);
    expect(screen.getByRole("button", { name: /retry setup/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /skip setup/i })).toBeTruthy();
  });

  test("retries a failed setup and disables duplicate submissions", async () => {
    let resolveRetry!: () => void;
    retrySetupRuntime.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveRetry = () => resolve(undefined);
        }),
    );
    renderInAppCommandScope(
      <SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^retry setup$/i }));

    expect(retrySetupRuntime).toHaveBeenCalledWith("env-1", appCommandScope());
    expect(
      (screen.getByRole("button", { name: /retrying setup/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    resolveRetry();
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /^retry setup$/i }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });

  test("surfaces override failures and lets the user try again", async () => {
    forceResolveSetupRuntime.mockRejectedValueOnce(new Error("Backend unavailable"));
    renderInAppCommandScope(
      <SetupPendingOverlay environmentId="env-1" setupPhase="failed" subtext="x" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^skip setup$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^skip anyway$/i }));

    expect(forceResolveSetupRuntime).toHaveBeenCalledWith("env-1", appCommandScope());
    expect((await screen.findByRole("alert")).textContent).toContain("Backend unavailable");
    expect(
      (screen.getByRole("button", { name: /^skip anyway$/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
