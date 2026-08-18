import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { Environment, LastEnvironmentAgentSelection } from "@/types";
import type { GitHubCredentialStatus } from "@/lib/backend";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useConfigStore } from "@/stores/configStore";
import { useProjectStore } from "@/stores/projectStore";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";

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
const rememberEnvironmentAgentSelectionMock = mock(
  async (projectId: string, selection: LastEnvironmentAgentSelection) => {
    const config = structuredClone(useConfigStore.getState().config);
    config.repositories[projectId] = {
      ...(config.repositories[projectId] ?? {
        defaultBranch: "main",
        prBaseBranch: "main",
      }),
      lastEnvironmentAgentSelection: selection,
    };
    return config;
  },
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getContainerGitHubCredentialStatus: getContainerGitHubCredentialStatusMock,
  rememberEnvironmentAgentSelection: rememberEnvironmentAgentSelectionMock,
  updateEnvironmentAgentSettings: updateEnvironmentAgentSettingsMock,
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
  claudeMode: "terminal",
  opencodeMode: "terminal",
  codexMode: "native",
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
    rememberEnvironmentAgentSelectionMock.mockClear();
    rememberEnvironmentAgentSelectionMock.mockImplementation(async (projectId, selection) => {
      const config = structuredClone(useConfigStore.getState().config);
      config.repositories[projectId] = {
        ...(config.repositories[projectId] ?? {
          defaultBranch: "main",
          prBaseBranch: "main",
        }),
        lastEnvironmentAgentSelection: selection,
      };
      return config;
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
    expect(call[6]).toBe(true);
    expect(call[7]).toBe("sonnet");
    expect(call[8]).toBeUndefined();
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

  test("persists a cleared launch intent when the user turns the agent off", async () => {
    const call = await submitCreateFlow({ turnOffLaunchAgent: true });
    // Recording `false` explicitly is what stops an environment created with the
    // agent off from ever being treated as awaiting a launch.
    expect(call[6]).toBe(false);
    expect(call[7]).toBeUndefined();
    expect(call[8]).toBeUndefined();
  });

  test("persists a selected model and effort in both durable and transient launch state", async () => {
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
    expect(call[6]).toBe(true);
    expect(call[7]).toBe("gpt-5.4-mini");
    expect(call[8]).toBe("high");
    expect(rememberEnvironmentAgentSelectionMock).toHaveBeenCalledWith("project-1", {
      platform: "codex",
      mode: "native",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
    });
    // The write is deliberately not awaited by the create flow, so the store
    // catches up on its own tick.
    await waitFor(() => {
      expect(
        useConfigStore.getState().config.repositories["project-1"]?.lastEnvironmentAgentSelection,
      ).toEqual({
        platform: "codex",
        mode: "native",
        model: "gpt-5.4-mini",
        reasoningEffort: "high",
      });
    });
    expect(useClaudeOptionsStore.getState().getOptions("env-selected-options")).toEqual(
      expect.objectContaining({
        agentType: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "high",
      }),
    );
  });

  test("continues creation without publishing local preference state when remembering fails", async () => {
    const preferenceError = new Error("config storage unavailable");
    rememberEnvironmentAgentSelectionMock.mockRejectedValueOnce(preferenceError);
    const onOpenChange = mock(() => {});
    const startEnvironment = mock(async () => {});
    const originalConsoleWarn = console.warn;
    console.warn = mock(() => {});
    try {
      render(
        <CreateEnvironmentFlowDialog
          open
          onOpenChange={onOpenChange}
          projectId="project-1"
          createEnvironment={mock(async () => ({ id: "env-preference-failed" }) as Environment)}
          updateEnvironment={() => {}}
          startEnvironment={startEnvironment}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

      await waitFor(() => {
        expect(startEnvironment).toHaveBeenCalledWith("env-preference-failed", "", {
          background: true,
          silent: true,
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
      await waitFor(() => {
        expect(console.warn).toHaveBeenCalledWith(
          "[CreateEnvironmentFlowDialog] Failed to remember agent selection:",
          preferenceError,
        );
      });
      expect(
        useConfigStore.getState().config.repositories["project-1"]?.lastEnvironmentAgentSelection,
      ).toBeUndefined();
    } finally {
      console.warn = originalConsoleWarn;
    }
  });

  // The environment already exists by the time the preference is written, so a
  // config write that never settles must not strand the user in the modal with a
  // created-but-unstarted environment.
  test("closes and starts the environment even when the preference write never settles", async () => {
    rememberEnvironmentAgentSelectionMock.mockImplementationOnce(() => new Promise(() => {}));
    const onOpenChange = mock(() => {});
    const startEnvironment = mock(async () => {});

    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={onOpenChange}
        projectId="project-1"
        createEnvironment={mock(async () => ({ id: "env-preference-hung" }) as Environment)}
        updateEnvironment={() => {}}
        startEnvironment={startEnvironment}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    await waitFor(() => {
      expect(startEnvironment).toHaveBeenCalledWith("env-preference-hung", "", {
        background: true,
        silent: true,
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(rememberEnvironmentAgentSelectionMock).toHaveBeenCalled();
    // The create button must not be left spinning behind the pending write.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Create Environment" }).hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  test("restores the durably remembered selection after closing and reopening", async () => {
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
      config.repositories["project-1"] = {
        defaultBranch: "main",
        prBaseBranch: "main",
        lastEnvironmentAgentSelection: {
          platform: "codex",
          mode: "native",
          model: "gpt-5.4-mini",
          reasoningEffort: "high",
        },
      };
      useConfigStore.getState().setConfig(config);
    });
    fireEvent.click(screen.getByRole("button", { name: "Reopen creator" }));
    const picker = await screen.findByRole("combobox", { name: "Agent, model and reasoning" });
    expect(picker.textContent).toContain("GPT-5.4-Mini");
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

  // The mirror of the test above, and the reason the re-apply effect exists: an
  // untouched dialog must keep picking up the remembered selection until the
  // catalogue that can actually resolve it has loaded.
  test("applies a remembered selection once a late catalog makes it resolvable", async () => {
    act(() => {
      const config = structuredClone(useConfigStore.getState().config);
      config.repositories["project-1"] = {
        defaultBranch: "main",
        prBaseBranch: "main",
        lastEnvironmentAgentSelection: {
          platform: "claude",
          mode: "native",
          model: "late-claude",
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

    // The remembered model is not in the fallback catalogue, so the dialog shows
    // a safe current-catalogue choice rather than pinning a model that is not
    // offered yet.
    expect(
      screen.getByRole("combobox", { name: "Agent, model and reasoning" }).textContent,
    ).not.toContain("Late Claude");

    // The late catalogue keeps `default` on offer, so the pre-existing
    // "selected model vanished" effect stays quiet. Only the re-apply effect can
    // move the dialog onto the newly resolvable remembered model.
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

    fireEvent.click(screen.getByRole("switch", { name: /Launch agent/i }));
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

  test("maps each agent mode to its backend slot", () => {
    expect(resolveEnvironmentAgentSettings(baseOptions)).toEqual({
      defaultAgent: "claude",
      claudeMode: "terminal",
      opencodeMode: null,
      codexMode: null,
    });
    expect(
      resolveEnvironmentAgentSettings({
        ...baseOptions,
        agentType: "opencode",
        opencodeMode: "native",
      }),
    ).toEqual({
      defaultAgent: "opencode",
      claudeMode: null,
      opencodeMode: "native",
      codexMode: null,
    });
    expect(
      resolveEnvironmentAgentSettings({
        ...baseOptions,
        agentType: "codex",
        codexMode: "terminal",
      }),
    ).toEqual({
      defaultAgent: "codex",
      claudeMode: null,
      opencodeMode: null,
      codexMode: "terminal",
    });
  });
});
