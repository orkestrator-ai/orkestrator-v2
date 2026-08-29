import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { Environment } from "@/types";
import type { GitHubCredentialStatus } from "@/lib/backend";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useConfigStore } from "@/stores/configStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { mockToastError } from "../../mocks/sonner";

// Snapshot the real module before replacing it, and restore it afterwards, so
// other suites that need the genuine backend wrappers are unaffected.
import * as realBackend from "@/lib/backend";
const realBackendSnapshot = { ...realBackend };

const updateEnvironmentAgentSettingsMock = mock(
  async (environmentId: string, ..._rest: unknown[]) => ({ id: environmentId }) as Environment,
);
const getContainerGitHubCredentialStatusMock = mock(async () => ({
  source: "host-cli" as const,
  available: true,
}));
const createFeatureBuildMock = mock(async (..._args: unknown[]) => ({
  taskId: "task-1",
  pipelineId: "pipeline-1",
  environmentId: "env-feature",
}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getContainerGitHubCredentialStatus: getContainerGitHubCredentialStatusMock,
  updateEnvironmentAgentSettings: updateEnvironmentAgentSettingsMock,
  createFeatureBuild: createFeatureBuildMock,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const {
  CreateEnvironmentFlowDialog,
  resolveEnvironmentAgentSettings,
  resolveEnvironmentAgentLaunchSettings,
  resolveEnvironmentCreateRequest,
} = await import("@/components/environments/CreateEnvironmentFlowDialog");
import type { ClaudeOptions } from "@/components/environments/CreateEnvironmentDialog";

const baseOptions: ClaudeOptions = {
  environmentType: "containerized",
  environmentName: "",
  launchAgent: true,
  agentType: "claude",
  // The create dialog's own transient selection, which keeps a flat mode per
  // platform. Only the launching agent's is written to durable settings.
  claudeMode: "terminal",
  opencodeMode: "terminal",
  codexMode: "native",
  grokMode: "native",
  model: "default",
  initialPrompt: "",
  initialPromptAttachments: [],
  networkAccessMode: "restricted",
  portMappings: [],
};

afterEach(cleanup);

/**
 * Drive the real create dialog to submission and return the agent-settings call
 * the flow made, so the durable launch intent is asserted end to end rather than
 * only through the pure helpers.
 */
async function submitCreateFlow(options: { turnOffLaunchAgent?: boolean } = {}) {
  const created = { id: "env-created" } as Environment;
  const startEnvironment = mock(async () => {});
  render(
    <CreateEnvironmentFlowDialog
      open
      onOpenChange={() => {}}
      projectId="project-1"
      createEnvironment={mock(async () => created)}
      updateEnvironment={() => {}}
      startEnvironment={startEnvironment}
    />,
  );

  if (options.turnOffLaunchAgent) {
    fireEvent.click(screen.getByLabelText("Launch Agent"));
  }
  fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

  await waitFor(() => expect(updateEnvironmentAgentSettingsMock).toHaveBeenCalled());
  return updateEnvironmentAgentSettingsMock.mock.calls[0]!;
}

describe("CreateEnvironmentFlowDialog", () => {
  beforeEach(() => {
    updateEnvironmentAgentSettingsMock.mockClear();
    createFeatureBuildMock.mockClear();
    createFeatureBuildMock.mockResolvedValue({
      taskId: "task-1",
      pipelineId: "pipeline-1",
      environmentId: "env-feature",
    });
    getContainerGitHubCredentialStatusMock.mockClear();
    getContainerGitHubCredentialStatusMock.mockResolvedValue({
      source: "host-cli",
      available: true,
    });
    useClaudeOptionsStore.setState({ options: {}, pendingNativeLaunches: {} });
    useClaudeStore.setState({ models: [] });
    useConfigStore.setState({
      config: structuredClone(useConfigStore.getInitialState().config),
      isLoading: false,
      error: null,
    });
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          name: "Project One",
          gitUrl: "https://example.test/project-one.git",
          localPath: "/work/project-one",
          addedAt: "2026-08-11T00:00:00.000Z",
          order: 0,
        },
      ],
    });
    useUIStore.setState({
      selectedProjectId: "project-previous",
      selectedEnvironmentId: "env-previous",
      collapsedProjects: ["project-1"],
    });
  });

  test("does not submit a forced local fallback for a remote-only project", async () => {
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          name: "Remote Only",
          gitUrl: "https://example.test/remote-only.git",
          localPath: null,
          addedAt: "2026-08-11T00:00:00.000Z",
          order: 0,
        },
      ],
    });
    const createEnvironment = mock(async () => ({ id: "env-impossible-local" }) as Environment);

    render(
      <DockerAvailabilityProvider available={false}>
        <CreateEnvironmentFlowDialog
          open
          onOpenChange={() => {}}
          projectId="project-1"
          createEnvironment={createEnvironment}
          updateEnvironment={() => {}}
          startEnvironment={async () => {}}
        />
      </DockerAvailabilityProvider>,
    );

    expect(
      (screen.getByRole("button", { name: /Containerized/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: /Local/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const submit = screen.getByRole("button", { name: "Create Environment" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(createEnvironment).not.toHaveBeenCalled();
  });

  test("warns before creating a container when host GitHub CLI credentials are unavailable", async () => {
    getContainerGitHubCredentialStatusMock.mockResolvedValueOnce({
      source: "host-cli",
      available: false,
    });
    const createEnvironment = mock(async () => ({ id: "env-no-host-auth" }) as Environment);

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={createEnvironment}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    expect(await screen.findByText("No GitHub CLI credentials found")).toBeTruthy();
    expect(screen.getByText(/run gh auth login/i)).toBeTruthy();
    expect(createEnvironment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create anyway" }));
    await waitFor(() => expect(createEnvironment).toHaveBeenCalledTimes(1));
  });

  test("warns when PAT mode is selected without a stored token", async () => {
    getContainerGitHubCredentialStatusMock.mockResolvedValueOnce({
      source: "pat",
      available: false,
    });
    const createEnvironment = mock(async () => ({ id: "env-no-pat" }) as Environment);

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={createEnvironment}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    expect(await screen.findByText("No GitHub token configured")).toBeTruthy();
    expect(screen.getByText(/no token is stored/i)).toBeTruthy();
    expect(createEnvironment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(createEnvironment).not.toHaveBeenCalled();
    expect(screen.queryByText("No GitHub token configured") === null).toBe(true);
  });

  test("shows the generic warning when credential status cannot be checked", async () => {
    getContainerGitHubCredentialStatusMock.mockRejectedValueOnce(
      new Error("credential service unavailable"),
    );
    const createEnvironment = mock(async () => ({ id: "env-status-error" }) as Environment);

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={createEnvironment}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    expect(await screen.findByText("GitHub credentials could not be verified")).toBeTruthy();
    expect(
      screen.getByText(/could not confirm that GitHub credentials are available/i),
    ).toBeTruthy();
    expect(createEnvironment).not.toHaveBeenCalled();
  });

  test("cancels a delayed credential preflight when the dialog closes", async () => {
    let resolveStatus: ((status: GitHubCredentialStatus) => void) | undefined;
    getContainerGitHubCredentialStatusMock.mockImplementationOnce(
      () =>
        new Promise<GitHubCredentialStatus>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const createEnvironment = mock(async () => ({ id: "env-too-late" }) as Environment);
    const props = {
      onOpenChange: () => {},
      projectId: "project-1",
      createEnvironment,
      updateEnvironment: () => {},
      startEnvironment: async () => {},
    };
    const view = render(<CreateEnvironmentFlowDialog open {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(getContainerGitHubCredentialStatusMock).toHaveBeenCalledTimes(1));

    view.rerender(<CreateEnvironmentFlowDialog open={false} {...props} />);
    await act(async () => {
      resolveStatus?.({ source: "host-cli", available: false });
      await Promise.resolve();
    });

    expect(createEnvironment).not.toHaveBeenCalled();
    expect(screen.queryByText("No GitHub CLI credentials found") === null).toBe(true);
  });

  test("ignores a delayed credential result after switching projects", async () => {
    let resolveStatus: ((status: GitHubCredentialStatus) => void) | undefined;
    getContainerGitHubCredentialStatusMock.mockImplementationOnce(
      () =>
        new Promise<GitHubCredentialStatus>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const createEnvironment = mock(async () => ({ id: "env-project-2" }) as Environment);
    const sharedProps = {
      open: true,
      onOpenChange: () => {},
      createEnvironment,
      updateEnvironment: () => {},
      startEnvironment: async () => {},
    };
    const view = render(<CreateEnvironmentFlowDialog projectId="project-1" {...sharedProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(getContainerGitHubCredentialStatusMock).toHaveBeenCalledTimes(1));

    view.rerender(<CreateEnvironmentFlowDialog projectId="project-2" {...sharedProps} />);
    await act(async () => {
      resolveStatus?.({ source: "host-cli", available: false });
      await Promise.resolve();
    });

    expect(screen.queryByText("No GitHub CLI credentials found") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() =>
      expect(createEnvironment).toHaveBeenCalledWith(
        "project-2",
        undefined,
        "full",
        undefined,
        undefined,
        "containerized",
        undefined,
      ),
    );
  });

  test("settles a delayed credential preflight when unmounted", async () => {
    let resolveStatus: ((status: GitHubCredentialStatus) => void) | undefined;
    getContainerGitHubCredentialStatusMock.mockImplementationOnce(
      () =>
        new Promise<GitHubCredentialStatus>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const createEnvironment = mock(async () => ({ id: "env-unmounted" }) as Environment);
    const view = render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={createEnvironment}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(getContainerGitHubCredentialStatusMock).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => {
      resolveStatus?.({ source: "host-cli", available: true });
      await Promise.resolve();
    });
    expect(createEnvironment).not.toHaveBeenCalled();
  });

  test("cancels a delayed container credential preflight when Docker stops", async () => {
    let resolveStatus: ((status: GitHubCredentialStatus) => void) | undefined;
    getContainerGitHubCredentialStatusMock.mockImplementationOnce(
      () =>
        new Promise<GitHubCredentialStatus>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const createEnvironment = mock(async () => ({ id: "env-after-outage" }) as Environment);
    const props = {
      open: true,
      onOpenChange: () => {},
      projectId: "project-1",
      createEnvironment,
      updateEnvironment: () => {},
      startEnvironment: async () => {},
    };
    const view = render(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentFlowDialog {...props} />
      </DockerAvailabilityProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    await waitFor(() => expect(getContainerGitHubCredentialStatusMock).toHaveBeenCalledTimes(1));

    view.rerender(
      <DockerAvailabilityProvider available={false}>
        <CreateEnvironmentFlowDialog {...props} />
      </DockerAvailabilityProvider>,
    );
    await act(async () => {
      resolveStatus?.({ source: "host-cli", available: true });
      await Promise.resolve();
    });

    expect(createEnvironment).not.toHaveBeenCalled();
  });

  test("does not create from an open credential warning after Docker stops", async () => {
    getContainerGitHubCredentialStatusMock.mockResolvedValueOnce({
      source: "host-cli",
      available: false,
    });
    const createEnvironment = mock(async () => ({ id: "env-after-warning-outage" }) as Environment);
    const props = {
      open: true,
      onOpenChange: () => {},
      projectId: "project-1",
      createEnvironment,
      updateEnvironment: () => {},
      startEnvironment: async () => {},
    };
    const view = render(
      <DockerAvailabilityProvider available>
        <CreateEnvironmentFlowDialog {...props} />
      </DockerAvailabilityProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    expect(await screen.findByText("No GitHub CLI credentials found")).toBeTruthy();

    view.rerender(
      <DockerAvailabilityProvider available={false}>
        <CreateEnvironmentFlowDialog {...props} />
      </DockerAvailabilityProvider>,
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Create anyway" }) === null).toBe(true);
    });
    expect(createEnvironment).not.toHaveBeenCalled();
  });

  test("cleans up the warning when create-anyway fails", async () => {
    getContainerGitHubCredentialStatusMock.mockResolvedValueOnce({
      source: "host-cli",
      available: false,
    });
    const createEnvironment = mock(async () => ({ id: "env-retry" }) as Environment);
    createEnvironment.mockRejectedValueOnce(new Error("container creation failed"));

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={createEnvironment}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
    expect(await screen.findByText("No GitHub CLI credentials found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create anyway" }));

    await waitFor(() => expect(createEnvironment).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByText("No GitHub CLI credentials found") === null).toBe(true),
    );
  });

  /**
   * A feature build clones the repository exactly like a plain container
   * create, so it has to go behind the same credential warning rather than
   * around it — the ticket and the pipeline are written by the same request
   * that provisions, so a failed clone is not something the user can undo.
   */
  function startFeatureBuild(name: string) {
    fireEvent.click(screen.getByRole("button", { name: /A feature/ }));
    fireEvent.change(screen.getByLabelText(/Feature name/i), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));
  }

  test("warns before a containerized feature build when credentials are unavailable", async () => {
    getContainerGitHubCredentialStatusMock.mockResolvedValueOnce({
      source: "host-cli",
      available: false,
    });
    const createEnvironment = mock(async () => ({ id: "env-feature" }) as Environment);

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={createEnvironment}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    startFeatureBuild("Dark mode toggle");

    expect(await screen.findByText("No GitHub CLI credentials found")).toBeTruthy();
    expect(createFeatureBuildMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create anyway" }));

    await waitFor(() => expect(createFeatureBuildMock).toHaveBeenCalledTimes(1));
    // The one request owns the ticket, the environment and the pipeline, so
    // the plain create path must not also run.
    expect(createEnvironment).not.toHaveBeenCalled();
    const request = createFeatureBuildMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.title).toBe("Dark mode toggle");
    expect(request.environmentType).toBe("containerized");
  });

  test("activates the feature environment so its setup surface mounts", async () => {
    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={mock(async () => ({ id: "unused" }) as Environment)}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    startFeatureBuild("Dark mode toggle");

    await waitFor(() => {
      expect(useUIStore.getState()).toMatchObject({
        selectedProjectId: "project-1",
        selectedEnvironmentId: "env-feature",
      });
    });
    expect(useUIStore.getState().collapsedProjects).not.toContain("project-1");
  });

  test("abandons a feature build when the credential warning is dismissed", async () => {
    getContainerGitHubCredentialStatusMock.mockResolvedValueOnce({
      source: "host-cli",
      available: false,
    });

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={mock(async () => ({ id: "env-feature" }) as Environment)}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    startFeatureBuild("Dark mode toggle");
    expect(await screen.findByText("No GitHub CLI credentials found")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(createFeatureBuildMock).not.toHaveBeenCalled();
    // The dialog stays open on the same ticket, so the user can fix the
    // credential and try again without retyping it.
    expect(screen.queryByText("No GitHub CLI credentials found") === null).toBe(true);
    expect((screen.getByLabelText(/Feature name/i) as HTMLInputElement).value).toBe(
      "Dark mode toggle",
    );
  });

  test("reports a failed feature build without closing the dialog", async () => {
    createFeatureBuildMock.mockRejectedValueOnce(new Error("Docker is not running"));
    const onOpenChange = mock(() => {});

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        createEnvironment={mock(async () => ({ id: "env-feature" }) as Environment)}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    startFeatureBuild("Dark mode toggle");

    await waitFor(() => expect(createFeatureBuildMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError.mock.calls[0]![0]).toBe("Could not start the build");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("skips the credential check for a local feature build", async () => {
    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={mock(async () => ({ id: "env-feature-local" }) as Environment)}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Local/ }));
    startFeatureBuild("Dark mode toggle");

    await waitFor(() => expect(createFeatureBuildMock).toHaveBeenCalledTimes(1));
    // A local worktree reuses the host checkout instead of cloning.
    expect(getContainerGitHubCredentialStatusMock).not.toHaveBeenCalled();
    const request = createFeatureBuildMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.environmentType).toBe("local");
  });

  test("does not check container GitHub credentials for a local worktree", async () => {
    const createEnvironment = mock(async () => ({ id: "env-local" }) as Environment);

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={createEnvironment}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Local/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => expect(createEnvironment).toHaveBeenCalledTimes(1));
    expect(getContainerGitHubCredentialStatusMock).not.toHaveBeenCalled();
  });

  test("persists the durable launch intent when the agent will be launched", async () => {
    const call = await submitCreateFlow();
    expect(call[0]).toBe("env-created");
    expect(call[2]).toBe(true);
    expect(call[3]).toBe("sonnet");
    expect(call[4]).toBeUndefined();
  });

  test("starts a newly created environment as a backend-owned background task", async () => {
    const startEnvironment = mock(async () => {});
    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={mock(async () => ({ id: "env-background" }) as Environment)}
        updateEnvironment={() => {}}
        startEnvironment={startEnvironment}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(startEnvironment).toHaveBeenCalledWith("env-background", "", {
        background: true,
        silent: true,
      });
    });
  });

  test("closes without awaiting background provisioning", async () => {
    const startEnvironment = mock(
      () =>
        new Promise<void>(() => {
          // Backend admission intentionally never settles in this test.
        }),
    );
    const onOpenChange = mock(() => {});
    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        createEnvironment={mock(async () => ({ id: "env-pending-start" }) as Environment)}
        updateEnvironment={() => {}}
        startEnvironment={startEnvironment}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(startEnvironment).toHaveBeenCalledWith("env-pending-start", "", {
        background: true,
        silent: true,
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("closes after creation and contains a rejected background-start admission", async () => {
    const startError = new Error("background admission rejected");
    const startEnvironment = mock(async () => {
      throw startError;
    });
    const onOpenChange = mock(() => {});
    const originalConsoleError = console.error;
    const consoleError = mock(() => undefined);
    console.error = consoleError as typeof console.error;

    try {
      render(
        <CreateEnvironmentFlowDialog
          open
          onOpenChange={onOpenChange}
          projectId="project-1"
          createEnvironment={mock(async () => ({ id: "env-rejected" }) as Environment)}
          updateEnvironment={() => {}}
          startEnvironment={startEnvironment}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(consoleError).toHaveBeenCalledWith("Failed to auto-start environment:", startError);
      });
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("surfaces an agent-settings persistence failure and does not start", async () => {
    const createEnvironment = mock(async () => ({ id: "env-settings-failed" }) as Environment);
    const startEnvironment = mock(async () => {});
    const onOpenChange = mock(() => {});
    updateEnvironmentAgentSettingsMock.mockRejectedValueOnce(
      new Error("Initial prompt attachments exceed the 32 MB limit"),
    );

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        createEnvironment={createEnvironment}
        updateEnvironment={() => {}}
        startEnvironment={startEnvironment}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Could not create environment", {
        description: "Initial prompt attachments exceed the 32 MB limit",
      }),
    );
    expect(createEnvironment).toHaveBeenCalledTimes(1);
    expect(startEnvironment).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("persists a cleared launch intent when the user turns the agent off", async () => {
    const call = await submitCreateFlow({ turnOffLaunchAgent: true });
    // Recording `false` explicitly is what stops an environment created with the
    // agent off from ever being treated as awaiting a launch.
    expect(call[2]).toBe(false);
    expect(call[3]).toBeUndefined();
    expect(call[4]).toBeUndefined();
  });

  test("keeps the selected model and effort as one-shot launch state without changing defaults", async () => {
    const created = { id: "env-selected-options" } as Environment;
    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={mock(async () => created)}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    const picker = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("button", { name: "codex models" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(picker.getAttribute("aria-expanded")).toBe("false"));

    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("button", { name: "codex models" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /GPT-5\.4-Mini/ }));
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => expect(updateEnvironmentAgentSettingsMock).toHaveBeenCalled());
    const call = updateEnvironmentAgentSettingsMock.mock.calls[0]!;
    expect(call[2]).toBe(true);
    expect(call[3]).toBe("gpt-5.4-mini");
    expect(call[4]).toBe("high");
    expect(useClaudeOptionsStore.getState().getOptions("env-selected-options")).toEqual(
      expect.objectContaining({
        agentType: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "high",
      }),
    );
    // The durable half of the claim: a per-create choice reaches the launched
    // tab and nothing else. Creating must not write repository-scoped state
    // that would then outrank the configured default for the next create.
    expect(
      useConfigStore.getState().config.repositories["project-1"]?.lastEnvironmentAgentSelection,
    ).toBeUndefined();
  });

  test("uses configured defaults instead of a legacy last-agent selection when reopened", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen creator
          </button>
          <CreateEnvironmentFlowDialog
            open={open}
            onOpenChange={setOpen}
            projectId="project-1"
            createEnvironment={mock(async () => ({ id: "env-reopen" }) as Environment)}
            updateEnvironment={() => {}}
            startEnvironment={async () => {}}
          />
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog") === null).toBe(true);
    act(() => {
      const config = structuredClone(useConfigStore.getState().config);
      config.global.enabledAgentPlatforms = ["claude", "codex", "pi"];
      config.global.agentSettings = {
        ...config.global.agentSettings,
        actionDefaults: {
          ...config.global.agentSettings?.actionDefaults,
          newProject: { platform: "codex", model: "gpt-5.4", reasoningEffort: "high" },
        },
      };
      config.repositories["project-1"] = {
        defaultBranch: "main",
        prBaseBranch: "main",
        lastEnvironmentAgentSelection: {
          platform: "pi",
          mode: "native",
        },
      };
      useConfigStore.getState().setConfig(config);
    });
    fireEvent.click(screen.getByRole("button", { name: "Reopen creator" }));
    const picker = await screen.findByRole("combobox", { name: "Agent, model and reasoning" });
    expect(picker.textContent).toContain("gpt-5.4");
    expect(picker.textContent).toContain("High");
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
    expect(
      screen.getByRole("button", { name: "Favorite models" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.getByRole("button", { name: "codex models" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("does not let a late catalog refresh replace a user-touched agent selection", async () => {
    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={mock(async () => ({ id: "env-late-catalog" }) as Environment)}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    const picker = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("button", { name: "codex models" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    act(() => {
      useClaudeStore.setState({
        models: [
          {
            id: "late-claude",
            name: "Late Claude",
            supportsEffort: false,
          },
        ],
      });
    });

    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    expect(screen.getByRole("button", { name: "codex models" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByRole("menuitemradio", { name: /Late Claude/ }) === null).toBe(true);
  });

  // An untouched dialog keeps resolving its configured default while model
  // catalogues load asynchronously.
  test("applies a configured default once a late catalog makes it resolvable", async () => {
    act(() => {
      const config = structuredClone(useConfigStore.getState().config);
      config.repositories["project-1"] = {
        defaultBranch: "main",
        prBaseBranch: "main",
        lastEnvironmentAgentSelection: {
          platform: "claude",
          mode: "native",
        },
      };
      config.global.agentSettings = {
        ...config.global.agentSettings,
        actionDefaults: {
          ...config.global.agentSettings?.actionDefaults,
          newProject: { platform: "claude", model: "late-claude" },
        },
      };
      useConfigStore.getState().setConfig(config);
    });

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={mock(async () => ({ id: "env-late-remembered" }) as Environment)}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    // The configured model is not in the fallback catalogue, so the dialog shows
    // a safe current-catalogue choice rather than pinning a model that is not
    // offered yet.
    expect(
      screen.getByRole("combobox", { name: "Agent, model and reasoning" }).textContent,
    ).not.toContain("Late Claude");

    // The late catalogue keeps `default` on offer, so the pre-existing
    // "selected model vanished" effect stays quiet. Only the re-apply effect can
    // move the dialog onto the newly resolvable configured model.
    act(() => {
      useClaudeStore.setState({
        models: [
          { id: "default", name: "Default (recommended)", supportsEffort: false },
          { id: "late-claude", name: "Late Claude", supportsEffort: false },
        ],
      });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Agent, model and reasoning" }).textContent,
      ).toContain("Late Claude");
    });
  });

  test("forwards non-empty launch attachments only while launch is enabled", () => {
    const attachments = [
      {
        id: "image-1",
        name: "diagram.png",
        previewUrl: "data:image/png;base64,cHJldmlldw==",
        base64Data: "cGl4ZWxz",
      },
    ];

    expect(
      resolveEnvironmentAgentLaunchSettings({
        ...baseOptions,
        initialPromptAttachments: attachments,
      }),
    ).toEqual({
      pendingAgentLaunch: true,
      initialAgentModel: "default",
      initialReasoningEffort: undefined,
      initialPromptAttachments: attachments,
    });
    expect(
      resolveEnvironmentAgentLaunchSettings({
        ...baseOptions,
        launchAgent: false,
        initialPromptAttachments: attachments,
      }),
    ).toEqual({
      pendingAgentLaunch: false,
      initialAgentModel: undefined,
      initialReasoningEffort: undefined,
      initialPromptAttachments: undefined,
    });
  });

  test("keeps the transient options store free of a model when the agent is off", async () => {
    // The transient store must mirror the backend write: a one-shot model only
    // means anything for a launch, and leaving one here would hand the next
    // reader a model the user never asked to run.
    const created = { id: "env-agent-off" } as Environment;
    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        createEnvironment={mock(async () => created)}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Launch agent/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => expect(updateEnvironmentAgentSettingsMock).toHaveBeenCalled());
    const stored = useClaudeOptionsStore.getState().getOptions("env-agent-off");
    expect(stored?.launchAgent).toBe(false);
    expect(stored?.model).toBeUndefined();
    expect(stored?.reasoningEffort).toBeUndefined();
  });

  test("falls back to no project name when the id matches no known project", () => {
    useProjectStore.setState({ projects: [] });
    const operations = {
      createEnvironment: mock(async () => ({ id: "unused" }) as Environment),
      updateEnvironment: () => {},
      startEnvironment: async () => {},
    };

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-missing"
        {...operations}
      />,
    );

    // The title renders bare rather than with a stray separator or "undefined".
    expect(screen.getByText("Create Ork (Environment)")).toBeTruthy();
  });

  test("uses the stored project name unless an explicit name is provided", () => {
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          name: "Stored Project",
          gitUrl: "https://example.invalid/stored.git",
          localPath: null,
          addedAt: "2026-01-01T00:00:00.000Z",
          order: 0,
        },
      ],
    });
    const operations = {
      createEnvironment: mock(async () => ({ id: "unused" }) as Environment),
      updateEnvironment: () => {},
      startEnvironment: async () => {},
    };
    const { rerender } = render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        {...operations}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: "Create Ork (Environment) - Stored Project",
      }),
    ).toBeTruthy();

    rerender(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId="project-1"
        projectName="Explicit Project"
        {...operations}
      />,
    );
    expect(
      screen.getByRole("heading", {
        name: "Create Ork (Environment) - Explicit Project",
      }),
    ).toBeTruthy();
  });

  test("does not submit without a selected project", () => {
    const createEnvironment = mock(async () => {
      throw new Error("must not be called");
    });
    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId={null}
        createEnvironment={createEnvironment}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    expect(createEnvironment).not.toHaveBeenCalled();
    expect(screen.getByText("Create Ork (Environment)")).toBeTruthy();
  });

  test("maps optional create fields and derives naming intent only for unnamed environments", () => {
    expect(
      resolveEnvironmentCreateRequest({
        ...baseOptions,
        initialPrompt: "  repair stale sessions  ",
      }),
    ).toEqual({
      name: undefined,
      networkAccessMode: "restricted",
      initialPrompt: "  repair stale sessions  ",
      portMappings: undefined,
      environmentType: "containerized",
      namingPrompt: "repair stale sessions",
    });

    expect(
      resolveEnvironmentCreateRequest({
        ...baseOptions,
        environmentName: "Manual Name",
        initialPrompt: "Do not use this for naming",
        portMappings: [{ containerPort: 8080, hostPort: 48080, protocol: "tcp" }],
      }),
    ).toEqual(
      expect.objectContaining({
        name: "Manual Name",
        namingPrompt: undefined,
        portMappings: [{ containerPort: 8080, hostPort: 48080, protocol: "tcp" }],
      }),
    );
  });

  test("pins only the launching agent's own column", () => {
    // The other platforms are left unset so they keep inheriting. Writing all
    // three would freeze this environment against later repository or app
    // changes it never opted out of.
    expect(resolveEnvironmentAgentSettings(baseOptions)).toEqual({
      defaultAgent: "claude",
      platforms: { claude: { mode: "terminal" } },
    });
    expect(
      resolveEnvironmentAgentSettings({
        ...baseOptions,
        agentType: "opencode",
        opencodeMode: "native",
      }),
    ).toEqual({ defaultAgent: "opencode", platforms: { opencode: { mode: "native" } } });
    expect(
      resolveEnvironmentAgentSettings({
        ...baseOptions,
        agentType: "codex",
        codexMode: "terminal",
      }),
    ).toEqual({ defaultAgent: "codex", platforms: { codex: { mode: "terminal" } } });
    expect(
      resolveEnvironmentAgentSettings({
        ...baseOptions,
        agentType: "cursor",
      }),
    ).toEqual({ defaultAgent: "cursor", platforms: { cursor: { mode: "native" } } });
    expect(
      resolveEnvironmentAgentSettings({
        ...baseOptions,
        agentType: "grok",
        grokMode: "native",
      }),
    ).toEqual({ defaultAgent: "grok", platforms: { grok: { mode: "native" } } });
  });
});
