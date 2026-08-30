import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { mockWriteText } from "../../mocks/clipboard";
import {
  REVIEW_INSTRUCTION_MAX_LENGTH,
  REVIEW_INSTRUCTION_RECOMMENDED_LENGTH,
} from "../../../packages/protocol/src/review-prompt";
import { MAX_OPENCODE_MODEL_PROVIDERS } from "../../../packages/protocol/src/native-agent";
import { mockToastError, mockToastSuccess } from "../../mocks/sonner";

const mockUpdateGlobalConfig = mock(async (globalConfig: unknown) => ({
  version: "1.0",
  global: globalConfig,
  repositories: {},
}));
const mockSetGitHubToken = mock(async (token: string | null) => ({
  version: "1.0",
  global: {
    ...useConfigStore.getState().config.global,
    githubTokenConfigured: token !== null,
  },
  repositories: {},
}));
const mockSetCursorApiKey = mock(async (apiKey: string | null) => ({
  version: "1.0",
  global: {
    ...useConfigStore.getState().config.global,
    cursorApiKeyConfigured: apiKey !== null,
  },
  repositories: {},
}));
const mockSetAnthropicApiKey = mock(async (apiKey: string | null) => ({
  version: "1.0",
  global: {
    ...useConfigStore.getState().config.global,
    anthropicApiKeyConfigured: apiKey !== null,
  },
  repositories: {},
}));
const mockGetLogDirectory = mock(async () => null);
const mockGetLogStorageStats = mock(async () => ({ totalBytes: 1536, fileCount: 2 }));
const mockCleanupLogs = mock(async () => ({ totalBytes: 0, fileCount: 0 }));
const mockPropagateGithubCredentialsToContainers = mock(
  async (): Promise<{ updated: string[]; failed: [string, string][] }> => ({
    updated: [],
    failed: [],
  }),
);
const mockGetWebClientStatus = mock(async () => ({
  enabled: true,
  running: true,
  url: "http://100.88.12.3:34121/",
  error: null,
  resetAvailable: false,
}));
const mockSetWebClientEnabled = mock(async (enabled: boolean) => ({
  enabled,
  running: enabled,
  url: enabled ? "http://100.88.12.3:34121/" : null,
  error: null,
  resetAvailable: false,
}));
const mockResetWebClientServe = mock(async () => ({
  enabled: true,
  running: true,
  url: "https://workstation.example.ts.net/",
  error: null,
  resetAvailable: false,
}));
const mockGetGatewayTokenSettings = mock(async () => ({
  token: "gateway-token-123456",
  editable: true,
  source: "file" as const,
}));
const mockSetGatewayToken = mock(async (token: string) => ({
  token: token.trim(),
  editable: true,
  source: "file" as const,
}));
const mockOpenInBrowser = mock(async () => undefined);
const mockTestDomainResolution = mock(async () => []);
const mockRevealInFileManager = mock(async (_path: string) => {});
const mockGetCachedOpenCodeModelCatalog = mock(async (_projectId: string) => null);
const mockRefreshHostAgentModelCatalog = mock(async (agent: string, _projectId?: string) => ({
  agent,
  modelCount: 2,
}));
const mockGetAgentModelCatalogCache = mock(async () => ({}));
const actualBackend = await import("../../../apps/web/src/lib/backend");

mock.module("@/lib/backend", () => ({
  ...actualBackend,
  updateGlobalConfig: mockUpdateGlobalConfig,
  setGitHubToken: mockSetGitHubToken,
  setCursorApiKey: mockSetCursorApiKey,
  setAnthropicApiKey: mockSetAnthropicApiKey,
  getLogDirectory: mockGetLogDirectory,
  getLogStorageStats: mockGetLogStorageStats,
  cleanupLogs: mockCleanupLogs,
  propagateGithubCredentialsToContainers: mockPropagateGithubCredentialsToContainers,
  getWebClientStatus: mockGetWebClientStatus,
  setWebClientEnabled: mockSetWebClientEnabled,
  resetWebClientServe: mockResetWebClientServe,
  getGatewayTokenSettings: mockGetGatewayTokenSettings,
  setGatewayToken: mockSetGatewayToken,
  openInBrowser: mockOpenInBrowser,
  testDomainResolution: mockTestDomainResolution,
  revealInFileManager: mockRevealInFileManager,
  getCachedOpenCodeModelCatalog: mockGetCachedOpenCodeModelCatalog,
  refreshHostAgentModelCatalog: mockRefreshHostAgentModelCatalog,
  getAgentModelCatalogCache: mockGetAgentModelCatalogCache,
}));

const { GlobalSettings } = await import("../../../apps/web/src/components/settings/GlobalSettings");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("GlobalSettings", () => {
  const setSavedCodexMaxConcurrentThreads = (value: number) => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          codexMaxConcurrentThreads: value,
        },
      },
    }));
  };

  beforeEach(() => {
    cleanup();
    mockUpdateGlobalConfig.mockClear();
    mockSetGitHubToken.mockClear();
    mockSetCursorApiKey.mockClear();
    mockSetAnthropicApiKey.mockClear();
    mockGetLogDirectory.mockClear();
    mockGetLogDirectory.mockImplementation(async () => null);
    mockGetLogStorageStats.mockClear();
    mockGetLogStorageStats.mockImplementation(async () => ({ totalBytes: 1536, fileCount: 2 }));
    mockCleanupLogs.mockClear();
    mockCleanupLogs.mockImplementation(async () => ({ totalBytes: 0, fileCount: 0 }));
    mockPropagateGithubCredentialsToContainers.mockClear();
    mockPropagateGithubCredentialsToContainers.mockImplementation(async () => ({
      updated: [],
      failed: [],
    }));
    mockGetWebClientStatus.mockClear();
    mockSetWebClientEnabled.mockClear();
    mockResetWebClientServe.mockClear();
    mockGetGatewayTokenSettings.mockClear();
    mockSetGatewayToken.mockClear();
    mockOpenInBrowser.mockClear();
    mockTestDomainResolution.mockClear();
    mockRevealInFileManager.mockClear();
    mockGetCachedOpenCodeModelCatalog.mockClear();
    mockGetCachedOpenCodeModelCatalog.mockImplementation(async () => null);
    mockRefreshHostAgentModelCatalog.mockClear();
    mockRefreshHostAgentModelCatalog.mockImplementation(async (agent: string) => ({
      agent,
      modelCount: 2,
    }));
    mockGetAgentModelCatalogCache.mockClear();
    mockGetAgentModelCatalogCache.mockImplementation(async () => ({}));
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockWriteText.mockReset();
    mockWriteText.mockImplementation(async () => {});
    mockGetWebClientStatus.mockImplementation(async () => ({
      enabled: true,
      running: true,
      url: "http://100.88.12.3:34121/",
      error: null,
      resetAvailable: false,
    }));
    mockSetWebClientEnabled.mockImplementation(async (enabled: boolean) => ({
      enabled,
      running: enabled,
      url: enabled ? "http://100.88.12.3:34121/" : null,
      error: null,
      resetAvailable: false,
    }));
    mockResetWebClientServe.mockImplementation(async () => ({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
      error: null,
      resetAvailable: false,
    }));
    mockGetGatewayTokenSettings.mockImplementation(async () => ({
      token: "gateway-token-123456",
      editable: true,
      source: "file" as const,
    }));
    mockSetGatewayToken.mockImplementation(async (token: string) => ({
      token: token.trim(),
      editable: true,
      source: "file" as const,
    }));
    window.orkestratorGateway = { enabled: true };
    useProjectStore.setState({ projects: [], isLoading: false, error: null });
    useUIStore.setState({ selectedProjectId: null });

    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          agentSettings: {
            defaultAgent: "claude",
            platforms: {
              opencode: { model: "opencode/grok-code", mode: "terminal" },
              claude: { model: "claude-sonnet-4-6", mode: "terminal" },
              codex: { model: "gpt-5.3-codex", reasoningEffort: "medium", mode: "native" },
            },
          },
          terminalAppearance: {
            fontFamily: "Fira Code",
            fontSize: 14,
            backgroundColor: "#000000",
          },
          terminalScrollback: 5000,
          experimentalCodexRawEventLogging: true,
          debugLogging: false,
          debugLogRetentionDays: 7,
          webClientEnabled: true,
        },
        repositories: {},
      },
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    window.orkestratorGateway = undefined;
  });

  test("saves codexMode changes", async () => {
    const { container } = render(<GlobalSettings activeSection="codex" />);

    // Each platform pane labels its own mode group, so the query cannot pick up
    // another platform's control.
    const codexMode = screen.getByRole("radiogroup", { name: "Codex mode" });
    fireEvent.click(within(codexMode).getByRole("radio", { name: /^Terminal/ }));
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSettings: expect.objectContaining({
            platforms: expect.objectContaining({
              codex: expect.objectContaining({ mode: "terminal" }),
            }),
          }),
        }),
      );
    });
  });

  test("shows the default Codex subagent limit and saves changes", async () => {
    render(<GlobalSettings activeSection="codex" />);

    const input = screen.getByLabelText("Concurrent subagent limit") as HTMLInputElement;
    expect(input.value).toBe("5");

    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          codexMaxConcurrentThreads: 8,
        }),
      );
    });
  });

  test("initializes the Codex subagent limit from a persisted non-default value", async () => {
    setSavedCodexMaxConcurrentThreads(9);
    render(<GlobalSettings activeSection="codex" />);

    expect((screen.getByLabelText("Concurrent subagent limit") as HTMLInputElement).value).toBe(
      "9",
    );
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });
  });

  for (const [description, invalidValue] of [
    ["an empty value", ""],
    ["zero", "0"],
    ["a negative value", "-1"],
    ["a fractional value", "1.5"],
    ["a non-numeric value", "not-a-number"],
    ["a value that leaves no safe root slot", String(Number.MAX_SAFE_INTEGER)],
  ] as const) {
    test(`rejects ${description} without corrupting the saved Codex subagent limit`, async () => {
      setSavedCodexMaxConcurrentThreads(7);
      render(<GlobalSettings activeSection="codex" />);

      const input = screen.getByLabelText("Concurrent subagent limit") as HTMLInputElement;
      const saveButton = screen.getByRole("button", {
        name: "Save Changes",
      }) as HTMLButtonElement;

      fireEvent.change(input, { target: { value: invalidValue } });

      expect(input.value).toBe("7");
      await waitFor(() => expect(saveButton.disabled).toBe(true));
      expect(useConfigStore.getState().config.global.codexMaxConcurrentThreads).toBe(7);
      expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
    });
  }

  test("resets an unsaved Codex subagent limit to the persisted value", async () => {
    setSavedCodexMaxConcurrentThreads(6);
    render(<GlobalSettings activeSection="codex" />);

    const input = screen.getByLabelText("Concurrent subagent limit") as HTMLInputElement;
    const saveButton = screen.getByRole("button", {
      name: "Save Changes",
    }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "12" } });
    await waitFor(() => expect(saveButton.disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(input.value).toBe("6");
    await waitFor(() => expect(saveButton.disabled).toBe(true));
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test("resynchronizes the Codex subagent limit when the config store changes", async () => {
    setSavedCodexMaxConcurrentThreads(4);
    render(<GlobalSettings activeSection="codex" />);

    const input = screen.getByLabelText("Concurrent subagent limit") as HTMLInputElement;
    const saveButton = screen.getByRole("button", {
      name: "Save Changes",
    }) as HTMLButtonElement;
    expect(input.value).toBe("4");

    fireEvent.change(input, { target: { value: "8" } });
    await waitFor(() => expect(saveButton.disabled).toBe(false));

    act(() => setSavedCodexMaxConcurrentThreads(11));

    await waitFor(() => expect(input.value).toBe("11"));
    await waitFor(() => expect(saveButton.disabled).toBe(true));
  });

  test("retains a Codex subagent limit edit after a failed save so it can be retried", async () => {
    setSavedCodexMaxConcurrentThreads(6);
    mockUpdateGlobalConfig.mockRejectedValueOnce(new Error("disk full"));
    render(<GlobalSettings activeSection="codex" />);

    const input = screen.getByLabelText("Concurrent subagent limit") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("Failed to save settings", {
        description: "disk full",
      });
    });
    expect(input.value).toBe("10");
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(2));
    expect(mockUpdateGlobalConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ codexMaxConcurrentThreads: 10 }),
    );
  });

  test("shows the shared backend status and credentials in Electron", async () => {
    window.orkestratorGateway = undefined;
    render(<GlobalSettings activeSection="web-client" />);

    expect(screen.getByText("Web client")).toBeTruthy();
    expect(screen.getByText(/Connect from orkestrator.dev/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Allow web access" })).toBeTruthy();
    expect(await screen.findByLabelText("Gateway token")).toBeTruthy();
    expect(mockGetWebClientStatus).toHaveBeenCalledTimes(1);
    expect(mockGetGatewayTokenSettings).toHaveBeenCalledTimes(1);
  });

  test("persists and applies Electron web access changes", async () => {
    window.orkestratorGateway = undefined;
    const { container } = render(<GlobalSettings activeSection="web-client" />);
    await screen.findByText("Running");

    fireEvent.click(screen.getByRole("switch", { name: "Allow web access" }));
    expect(screen.getByText("Save changes to stop web access.")).toBeTruthy();
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ webClientEnabled: false }),
      );
      expect(mockSetWebClientEnabled).toHaveBeenCalledWith(false);
    });
  });

  test("copies the current web client URL", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    await screen.findByText("Running");

    fireEvent.click(screen.getByRole("button", { name: "Copy web client URL" }));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("http://100.88.12.3:34121/");
    });
    expect(screen.getByRole("button", { name: "Web client URL copied" })).toBeTruthy();
  });

  test("confirms and resets a conflicting Tailscale Serve listener", async () => {
    window.orkestratorGateway = undefined;
    mockGetWebClientStatus.mockResolvedValueOnce({
      enabled: true,
      running: false,
      url: null,
      error: "Refusing to replace the existing Tailscale Serve configuration on HTTPS port 443",
      resetAvailable: true,
    });
    render(<GlobalSettings activeSection="web-client" />);

    expect(await screen.findByText(/Refusing to replace/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset Tailscale Serve" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/removes the existing HTTPS listener on port 443/),
    ).toBeTruthy();
    // The load-bearing property is that the component default is *gone*: if
    // tailwind-merge ever stopped collapsing them, `z-50 … z-[80]` would still
    // satisfy a `toContain` check while the rendered layer became dependent on
    // stylesheet order.
    const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]');
    expect(dialog.className).toContain("z-[80]");
    expect(dialog.className).not.toContain("z-50");
    expect(overlay?.className).toContain("z-[80]");
    expect(overlay?.className).not.toContain("z-50");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset Tailscale Serve" }));

    await waitFor(() => expect(mockResetWebClientServe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    expect(mockToastSuccess).toHaveBeenCalledWith("Tailscale Serve reset");
  });

  test("cancels a Tailscale Serve reset without invoking the destructive command", async () => {
    window.orkestratorGateway = undefined;
    mockGetWebClientStatus.mockResolvedValueOnce({
      enabled: true,
      running: false,
      url: null,
      error: "Existing HTTPS listener",
      resetAvailable: true,
    });
    render(<GlobalSettings activeSection="web-client" />);

    fireEvent.click(await screen.findByRole("button", { name: "Reset Tailscale Serve" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
    expect(mockResetWebClientServe).not.toHaveBeenCalled();
  });

  test("keeps a resettable Serve conflict retryable after a transient reset failure", async () => {
    window.orkestratorGateway = undefined;
    mockGetWebClientStatus.mockResolvedValueOnce({
      enabled: true,
      running: false,
      url: null,
      error: "Refusing to replace the existing Tailscale Serve configuration on HTTPS port 443",
      resetAvailable: true,
    });
    mockResetWebClientServe
      .mockResolvedValueOnce({
        enabled: true,
        running: false,
        url: null,
        error: "Tailscale daemon unavailable",
        resetAvailable: true,
      })
      .mockResolvedValueOnce({
        enabled: true,
        running: true,
        url: "https://workstation.example.ts.net/",
        error: null,
        resetAvailable: false,
      });
    render(<GlobalSettings activeSection="web-client" />);

    const confirmReset = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Reset Tailscale Serve" }));
      const dialog = await screen.findByRole("alertdialog");
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Reset Tailscale Serve" }));
      });
    };

    await confirmReset();
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Failed to reset Tailscale Serve", {
        description: "Tailscale daemon unavailable",
      }),
    );
    expect(screen.getByRole("button", { name: "Reset Tailscale Serve" })).toBeTruthy();

    await confirmReset();
    await waitFor(() => expect(mockResetWebClientServe).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Running")).toBeTruthy();
  });

  test("keeps a failed Electron web access transition retryable after config persistence", async () => {
    window.orkestratorGateway = undefined;
    mockSetWebClientEnabled.mockRejectedValueOnce(new Error("control request failed"));
    const { container } = render(<GlobalSettings activeSection="web-client" />);
    await screen.findByText("Running");

    fireEvent.click(screen.getByRole("switch", { name: "Allow web access" }));
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Failed to save settings", {
        description: "control request failed",
      }),
    );
    expect(screen.getByText("control request failed")).toBeTruthy();
    const saveButton = within(container).getByRole("button", {
      name: "Save Changes",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);
    await waitFor(() => expect(mockSetWebClientEnabled).toHaveBeenCalledTimes(2));
    expect(mockSetWebClientEnabled).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(saveButton.disabled).toBe(true));
  });

  test("renders the authoritative disabled status as Off", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, webClientEnabled: false },
      },
    }));
    mockGetWebClientStatus.mockResolvedValueOnce({
      enabled: false,
      running: false,
      url: null,
      error: null,
    });

    render(<GlobalSettings activeSection="web-client" />);
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.queryByRole("link") === null).toBe(true);
  });

  test("displays, reveals, edits, and saves the gateway token", async () => {
    const { container } = render(<GlobalSettings activeSection="web-client" />);
    const input = (await screen.findByLabelText("Gateway token")) as HTMLInputElement;

    expect(input.type).toBe("password");
    expect(input.value).toBe("gateway-token-123456");
    fireEvent.click(screen.getByRole("button", { name: "Show gateway token" }));
    expect(input.type).toBe("text");

    fireEvent.change(input, { target: { value: "replacement-token-123456" } });
    expect(screen.getByText("Save changes to use this token for future sign-ins.")).toBeTruthy();
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockSetGatewayToken).toHaveBeenCalledWith("replacement-token-123456"),
    );
  });

  test("copies the gateway token", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    await screen.findByDisplayValue("gateway-token-123456");

    fireEvent.click(screen.getByRole("button", { name: "Copy gateway token" }));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("gateway-token-123456");
    });
    expect(screen.getByRole("button", { name: "Gateway token copied" })).toBeTruthy();
  });

  test("reports clipboard failures for the web URL and gateway token", async () => {
    const originalConsoleError = console.error;
    console.error = mock(() => undefined);
    mockWriteText.mockRejectedValue(new Error("clipboard denied"));
    try {
      render(<GlobalSettings activeSection="web-client" />);
      await screen.findByText("Running");
      await screen.findByDisplayValue("gateway-token-123456");

      fireEvent.click(screen.getByRole("button", { name: "Copy web client URL" }));
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Failed to copy web client URL"),
      );

      fireEvent.click(screen.getByRole("button", { name: "Copy gateway token" }));
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Failed to copy gateway token"),
      );
      expect(mockWriteText).toHaveBeenCalledTimes(2);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("shows an environment-managed gateway token as read-only", async () => {
    mockGetGatewayTokenSettings.mockResolvedValueOnce({
      token: "environment-token-123456",
      editable: false,
      source: "environment",
    });
    render(<GlobalSettings activeSection="web-client" />);

    const input = (await screen.findByLabelText("Gateway token")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("environment-token-123456"));
    expect(input.disabled).toBe(true);
    expect(screen.getByText(/ORKESTRATOR_GATEWAY_TOKEN/)).toBeTruthy();
  });

  test("validates gateway token character and encoded-cookie boundaries", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    const input = (await screen.findByLabelText("Gateway token")) as HTMLInputElement;
    const saveButton = screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "short" } });
    expect(screen.getByText("Gateway token must be at least 16 characters.")).toBeTruthy();
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "😀".repeat(512) } });
    expect(
      screen.getByText("Gateway token is too large to store in a browser cookie."),
    ).toBeTruthy();
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "valid-token-value-123456" } });
    expect(screen.queryByText(/Gateway token must|too large to store/) === null).toBe(true);
    expect(saveButton.disabled).toBe(false);
  });

  test("resets an unsaved gateway token edit", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    const input = (await screen.findByLabelText("Gateway token")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "replacement-token-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(input.value).toBe("gateway-token-123456");
    expect(mockSetGatewayToken).not.toHaveBeenCalled();
  });

  test("shows gateway token load failures without enabling an empty input", async () => {
    mockGetGatewayTokenSettings.mockRejectedValueOnce(new Error("token settings unavailable"));
    render(<GlobalSettings activeSection="web-client" />);

    expect(await screen.findByText("token settings unavailable")).toBeTruthy();
    expect((screen.getByLabelText("Gateway token") as HTMLInputElement).disabled).toBe(true);
  });

  test("reports gateway token persistence failures and keeps the edit retryable", async () => {
    const originalConsoleError = console.error;
    console.error = mock(() => undefined);
    mockSetGatewayToken.mockRejectedValueOnce(new Error("credential write failed"));
    render(<GlobalSettings activeSection="web-client" />);
    const input = (await screen.findByLabelText("Gateway token")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "replacement-token-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Failed to save settings", {
        description: "credential write failed",
      }),
    );
    expect(input.value).toBe("replacement-token-123456");
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    console.error = originalConsoleError;
  });

  test("does not let a remote client change the desktop web access lifecycle", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    const input = (await screen.findByLabelText("Gateway token")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "replacement-token-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockSetGatewayToken).toHaveBeenCalledWith("replacement-token-123456");
      expect(mockSetWebClientEnabled).not.toHaveBeenCalled();
    });
  });

  test("does not refetch gateway credentials for unrelated configuration changes", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    await screen.findByLabelText("Gateway token");

    act(() => {
      useConfigStore.setState((state) => ({
        config: {
          ...state.config,
          global: { ...state.config.global, webClientEnabled: false },
        },
      }));
    });
    expect(mockGetGatewayTokenSettings).toHaveBeenCalledTimes(1);
  });

  test("ignores stale status and token loads after switching away and back", async () => {
    const firstStatus = deferred<{
      enabled: boolean;
      running: boolean;
      url: string | null;
      error: string | null;
      resetAvailable: boolean;
    }>();
    const secondStatus = deferred<{
      enabled: boolean;
      running: boolean;
      url: string | null;
      error: string | null;
      resetAvailable: boolean;
    }>();
    const firstToken = deferred<{ token: string; editable: boolean; source: "file" }>();
    const secondToken = deferred<{ token: string; editable: boolean; source: "file" }>();
    mockGetWebClientStatus
      .mockImplementationOnce(() => firstStatus.promise)
      .mockImplementationOnce(() => secondStatus.promise);
    mockGetGatewayTokenSettings
      .mockImplementationOnce(() => firstToken.promise)
      .mockImplementationOnce(() => secondToken.promise);

    const view = render(<GlobalSettings activeSection="web-client" />);
    view.rerender(<GlobalSettings activeSection="general" />);
    view.rerender(<GlobalSettings activeSection="web-client" />);

    await act(async () => {
      secondStatus.resolve({
        enabled: true,
        running: true,
        url: "https://new.example.ts.net/",
        error: null,
        resetAvailable: false,
      });
      secondToken.resolve({ token: "new-gateway-token-123456", editable: true, source: "file" });
      await Promise.resolve();
    });
    expect(await screen.findByDisplayValue("new-gateway-token-123456")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();

    await act(async () => {
      firstStatus.resolve({
        enabled: true,
        running: false,
        url: null,
        error: "stale status",
        resetAvailable: false,
      });
      firstToken.resolve({ token: "stale-gateway-token", editable: true, source: "file" });
      await Promise.resolve();
    });
    expect(screen.queryByText("stale status") === null).toBe(true);
    expect(screen.queryByDisplayValue("stale-gateway-token") === null).toBe(true);
    expect(screen.getByDisplayValue("new-gateway-token-123456")).toBeTruthy();
  });

  test("discards pending web client results after unmount", async () => {
    const status = deferred<{
      enabled: boolean;
      running: boolean;
      url: string | null;
      error: string | null;
      resetAvailable: boolean;
    }>();
    const token = deferred<{ token: string; editable: boolean; source: "file" }>();
    mockGetWebClientStatus.mockImplementationOnce(() => status.promise);
    mockGetGatewayTokenSettings.mockImplementationOnce(() => token.promise);
    const view = render(<GlobalSettings activeSection="web-client" />);
    view.unmount();

    await act(async () => {
      status.resolve({
        enabled: true,
        running: true,
        url: null,
        error: null,
        resetAvailable: false,
      });
      token.resolve({ token: "late-gateway-token", editable: true, source: "file" });
      await Promise.resolve();
    });
    expect(screen.queryByDisplayValue("late-gateway-token") === null).toBe(true);
  });

  test("shows unavailable and status-fetch errors", async () => {
    mockGetWebClientStatus.mockResolvedValueOnce({
      enabled: true,
      running: false,
      url: null,
      error: "No Tailscale connection was found",
    });
    const { unmount } = render(<GlobalSettings activeSection="web-client" />);

    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("No Tailscale connection was found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset Tailscale Serve" }) === null).toBe(true);
    unmount();

    mockGetWebClientStatus.mockRejectedValueOnce(new Error("IPC unavailable"));
    render(<GlobalSettings activeSection="web-client" />);
    expect(await screen.findByText("IPC unavailable")).toBeTruthy();
  });

  test("shows a disabled lifecycle toggle in a remote browser", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    await screen.findByText("Running");

    expect(screen.getByLabelText("Gateway token")).toBeTruthy();
    expect(
      (screen.getByRole("switch", { name: "Allow web access" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mockSetWebClientEnabled).not.toHaveBeenCalled();
  });

  test("uses a normal browser link for the active remote gateway", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    const link = (await screen.findByRole("link", { name: /100\.88\.12\.3/ })) as HTMLAnchorElement;

    expect(link.href).toBe("http://100.88.12.3:34121/");
    expect(link.target).toBe("_blank");
    expect(mockOpenInBrowser).not.toHaveBeenCalled();
  });

  test("opens the managed HTTPS address in the system browser from Electron", async () => {
    window.orkestratorGateway = undefined;
    render(<GlobalSettings activeSection="web-client" />);
    const link = await screen.findByRole("link", { name: /100\.88\.12\.3/ });

    fireEvent.click(link);
    expect(mockOpenInBrowser).toHaveBeenCalledWith("http://100.88.12.3:34121/");
  });

  describe("OpenCode model providers", () => {
    const providerItems = () =>
      screen
        .getAllByRole("button", { name: /^Remove .* provider$/ })
        .map((button) => button.closest("li")?.querySelector("span")?.textContent ?? "");

    test("names and refreshes the fallback repository when none is selected", async () => {
      useProjectStore.setState({
        projects: [
          {
            id: "project-2",
            name: "Fallback Repository",
            gitUrl: "https://github.com/acme/fallback.git",
            localPath: null,
            addedAt: "2026-08-27T00:00:00.000Z",
            order: 0,
          },
          {
            id: "project-1",
            name: "Other Repository",
            gitUrl: "https://github.com/acme/other.git",
            localPath: null,
            addedAt: "2026-08-27T00:00:00.000Z",
            order: 1,
          },
        ],
      });

      render(<GlobalSettings activeSection="opencode" />);

      expect(
        screen.getByText("No repository is selected; models are loaded from Fallback Repository."),
      ).toBeTruthy();
      await waitFor(() => {
        expect(mockGetCachedOpenCodeModelCatalog).toHaveBeenCalledWith("project-2");
      });

      fireEvent.click(screen.getByRole("button", { name: "Refresh OpenCode models" }));

      await waitFor(() => {
        expect(mockRefreshHostAgentModelCatalog).toHaveBeenCalledWith("opencode", "project-2");
        expect(mockToastSuccess).toHaveBeenCalledWith(
          "OpenCode models refreshed for Fallback Repository (2)",
        );
      });
    });

    test("defaults to the two managed provider catalogues", () => {
      render(<GlobalSettings activeSection="opencode" />);

      expect(providerItems()).toEqual(["opencode", "opencode-go"]);
      // Nothing is dirty yet, so the section must not offer a reset.
      expect(screen.queryByRole("button", { name: "Reset to defaults" }) === null).toBe(true);
    });

    test("adds a provider and saves the widened list", async () => {
      render(<GlobalSettings activeSection="opencode" />);

      fireEvent.change(screen.getByLabelText("Add a provider"), {
        target: { value: "OpenRouter" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      // Ids are stored lowercased so a stray capital cannot select nothing.
      expect(providerItems()).toEqual(["opencode", "opencode-go", "openrouter"]);
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

      await waitFor(() => {
        expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            openCodeModelProviders: ["opencode", "opencode-go", "openrouter"],
          }),
        );
      });
    });

    test("removes a provider and saves the narrowed list", async () => {
      render(<GlobalSettings activeSection="opencode" />);

      fireEvent.click(screen.getByRole("button", { name: "Remove opencode-go provider" }));
      expect(providerItems()).toEqual(["opencode"]);
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

      await waitFor(() => {
        expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
          expect.objectContaining({ openCodeModelProviders: ["opencode"] }),
        );
      });
    });

    test("rejects a duplicate, a blank, and a pasted model id", () => {
      render(<GlobalSettings activeSection="opencode" />);
      const input = screen.getByLabelText("Add a provider");
      const addButton = () => screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;

      expect(addButton().disabled).toBe(true);

      fireEvent.change(input, { target: { value: "opencode" } });
      expect(screen.getByText("That provider is already in the list.")).toBeTruthy();
      expect(addButton().disabled).toBe(true);

      // A whole model id would silently match no provider.
      fireEvent.change(input, { target: { value: "opencode/claude-sonnet-5" } });
      expect(screen.getByText(/Use the provider id/)).toBeTruthy();
      expect(addButton().disabled).toBe(true);

      fireEvent.change(input, { target: { value: "   " } });
      expect(addButton().disabled).toBe(true);
    });

    test("warns that clearing every provider offers the whole catalogue", async () => {
      render(<GlobalSettings activeSection="opencode" />);

      for (const provider of ["opencode", "opencode-go"]) {
        fireEvent.click(screen.getByRole("button", { name: `Remove ${provider} provider` }));
      }

      expect(screen.getByText(/every provider OpenCode advertises/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

      await waitFor(() => {
        expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
          expect.objectContaining({ openCodeModelProviders: [] }),
        );
      });
    });

    test("restores the managed defaults after an edit", () => {
      render(<GlobalSettings activeSection="opencode" />);

      fireEvent.click(screen.getByRole("button", { name: "Remove opencode provider" }));
      fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

      expect(providerItems()).toEqual(["opencode", "opencode-go"]);
    });

    test("refuses to add past the stored provider cap", () => {
      useConfigStore.setState((state) => ({
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            openCodeModelProviders: Array.from(
              { length: MAX_OPENCODE_MODEL_PROVIDERS },
              (_unused, index) => `provider-${index}`,
            ),
          },
        },
      }));
      render(<GlobalSettings activeSection="opencode" />);

      expect(providerItems()).toHaveLength(MAX_OPENCODE_MODEL_PROVIDERS);
      fireEvent.change(screen.getByLabelText("Add a provider"), {
        target: { value: "openrouter" },
      });

      // The backend truncates a longer list, so an add that would be silently
      // dropped has to be refused here instead.
      expect(screen.getByText(`At most ${MAX_OPENCODE_MODEL_PROVIDERS} providers.`)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(
        true,
      );

      // Removing one frees a slot without needing a re-render of the list.
      fireEvent.click(screen.getByRole("button", { name: "Remove provider-0 provider" }));
      expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });
  });

  test("renders every settings section", () => {
    const { rerender } = render(<GlobalSettings activeSection="general" />);
    expect(screen.getByText("Preferred Editor")).toBeTruthy();
    rerender(<GlobalSettings activeSection="review" />);
    expect(screen.getByText("Code review instruction")).toBeTruthy();
    rerender(<GlobalSettings activeSection="claude" />);
    expect(screen.getByText(/How Claude Code runs in environments/)).toBeTruthy();
    rerender(<GlobalSettings activeSection="opencode" />);
    expect(screen.getByText(/How OpenCode runs in environments/)).toBeTruthy();
    rerender(<GlobalSettings activeSection="codex" />);
    expect(screen.getByText(/How Codex runs in environments/)).toBeTruthy();
    rerender(<GlobalSettings activeSection="terminal" />);
    expect(screen.getByText("Font Family")).toBeTruthy();
    rerender(<GlobalSettings activeSection="network" />);
    expect(screen.getByText("Network Whitelist")).toBeTruthy();
    rerender(<GlobalSettings activeSection="container" />);
    expect(screen.getByText("CPU Cores")).toBeTruthy();
    rerender(<GlobalSettings activeSection="experimental" />);
    expect(screen.getByText("Codex Raw Event Logging")).toBeTruthy();
    rerender(<GlobalSettings activeSection="debug" />);
    expect(screen.getByText("Save Logs for Debugging")).toBeTruthy();
  });

  test("saves one shared custom review instruction", async () => {
    render(<GlobalSettings activeSection="review" />);

    const instruction = screen.getByLabelText("Review instruction") as HTMLTextAreaElement;
    expect(instruction.value).toContain("{{targetBranch}}");
    expect(instruction.className).toContain("focus-visible:ring-ring/50");
    expect(instruction.className).toContain("focus-visible:ring-[3px]");
    expect(instruction.className).not.toContain("focus-visible:outline-1");
    expect(
      screen.getByText(/Applied to normal, build-pipeline, and looped native reviews/),
    ).toBeTruthy();
    expect(screen.getByText(/cannot remove or override the fixed safety rules/)).toBeTruthy();

    fireEvent.change(instruction, {
      target: { value: "Review origin/{{targetBranch}}...HEAD for regressions." },
    });
    expect(screen.getByText("Custom")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewInstruction: "Review origin/{{targetBranch}}...HEAD for regressions.",
        }),
      );
    });
  });

  test("calls onSaveSuccess after a fully successful save", async () => {
    let resolveSaveSuccess: (() => void) | undefined;
    const saveSucceeded = new Promise<void>((resolve) => {
      resolveSaveSuccess = resolve;
    });
    const onSaveSuccess = mock(() => resolveSaveSuccess?.());
    render(<GlobalSettings activeSection="review" onSaveSuccess={onSaveSuccess} />);

    fireEvent.change(screen.getByLabelText("Review instruction"), {
      target: { value: "Review the committed snapshot." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await act(async () => {
      await saveSucceeded;
    });
    expect(onSaveSuccess).toHaveBeenCalledTimes(1);
  });

  test("does not call onSaveSuccess after persistence fails", async () => {
    const onSaveSuccess = mock(() => {});
    mockUpdateGlobalConfig.mockRejectedValueOnce(new Error("disk full"));
    render(<GlobalSettings activeSection="review" onSaveSuccess={onSaveSuccess} />);

    fireEvent.change(screen.getByLabelText("Review instruction"), {
      target: { value: "Review the committed snapshot." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Failed to save settings", {
        description: "disk full",
      }),
    );
    expect(onSaveSuccess).not.toHaveBeenCalled();
  });

  test("does not call onSaveSuccess when credential propagation fails", async () => {
    const onSaveSuccess = mock(() => {});
    mockPropagateGithubCredentialsToContainers.mockRejectedValueOnce(
      new Error("container unavailable"),
    );
    render(<GlobalSettings activeSection="general" onSaveSuccess={onSaveSuccess} />);

    fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Settings saved, but containers were not updated",
        { description: "container unavailable. Save Changes to retry." },
      ),
    );
    expect(onSaveSuccess).not.toHaveBeenCalled();
  });

  test("resets a saved custom review instruction to the built-in default", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, reviewInstruction: "Only review tests." },
      },
    }));
    render(<GlobalSettings activeSection="review" />);

    const instruction = screen.getByLabelText("Review instruction") as HTMLTextAreaElement;
    expect(instruction.value).toBe("Only review tests.");
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(instruction.value).toContain("correctness, regressions, security");
    expect(screen.getByText("Default")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1));
    const savedGlobal = mockUpdateGlobalConfig.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(savedGlobal, "reviewInstruction")).toBe(false);
  });

  test("does not allow an empty review instruction to be saved", async () => {
    render(<GlobalSettings activeSection="review" />);
    await waitFor(() => expect(mockGetLogDirectory).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Review instruction"), {
      target: { value: "   " },
    });

    expect(
      screen.getByText(
        "Review instruction cannot be empty. Enter an instruction or reset to the default.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("falls back to the built-in instruction for malformed persisted values", () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, reviewInstruction: 123 as never },
      },
    }));

    render(<GlobalSettings activeSection="review" />);

    const instruction = screen.getByLabelText("Review instruction") as HTMLTextAreaElement;
    expect(instruction.value).toContain("correctness, regressions, security");
    expect(instruction.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByText("Default")).toBeTruthy();
  });

  test("enforces the review instruction length boundary", async () => {
    render(<GlobalSettings activeSection="review" />);
    await waitFor(() => expect(mockGetLogDirectory).toHaveBeenCalled());
    const instruction = screen.getByLabelText("Review instruction") as HTMLTextAreaElement;

    expect(instruction.maxLength).toBe(REVIEW_INSTRUCTION_MAX_LENGTH);
    fireEvent.change(instruction, {
      target: { value: "x".repeat(REVIEW_INSTRUCTION_MAX_LENGTH + 1) },
    });

    expect(
      screen.getByText("Review instruction must be 100,000 characters or fewer."),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Long review instructions are repeated across review passes/) === null,
    ).toBe(true);
    expect(instruction.getAttribute("aria-describedby")).not.toContain(
      "review-instruction-warning",
    );
    expect(instruction.getAttribute("aria-invalid")).toBe("true");
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("does not warn at the inclusive recommended-length boundary", async () => {
    render(<GlobalSettings activeSection="review" />);
    await waitFor(() => expect(mockGetLogDirectory).toHaveBeenCalled());
    const instruction = screen.getByLabelText("Review instruction") as HTMLTextAreaElement;

    fireEvent.change(instruction, {
      target: { value: "x".repeat(REVIEW_INSTRUCTION_RECOMMENDED_LENGTH) },
    });

    expect(
      screen.queryByText(/Long review instructions are repeated across review passes/) === null,
    ).toBe(true);
    expect(instruction.getAttribute("aria-describedby")).toBe(
      "review-instruction-description review-instruction-status",
    );
  });

  test("keeps every described-by target present in the document", async () => {
    // Asserting only that the warning id appears would let a regression drop
    // the description and status ids, leaving the field partly unannounced.
    render(<GlobalSettings activeSection="review" />);
    await waitFor(() => expect(mockGetLogDirectory).toHaveBeenCalled());
    const instruction = screen.getByLabelText("Review instruction") as HTMLTextAreaElement;

    for (const value of [
      "Short review instruction.",
      "x".repeat(REVIEW_INSTRUCTION_RECOMMENDED_LENGTH + 1),
    ]) {
      fireEvent.change(instruction, { target: { value } });
      const ids = instruction.getAttribute("aria-describedby")!.split(" ");
      expect(ids).toContain("review-instruction-description");
      expect(ids).toContain("review-instruction-status");
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(document.getElementById(id)).toBeTruthy();
      }
    }
  });

  test("warns about long review instructions without blocking legacy values", async () => {
    render(<GlobalSettings activeSection="review" />);
    await waitFor(() => expect(mockGetLogDirectory).toHaveBeenCalled());
    const instruction = screen.getByLabelText("Review instruction") as HTMLTextAreaElement;

    fireEvent.change(instruction, {
      target: { value: "x".repeat(REVIEW_INSTRUCTION_RECOMMENDED_LENGTH + 1) },
    });

    const warning = screen.getByText(/Long review instructions are repeated across review passes/);
    expect(warning.textContent).toContain(
      `${REVIEW_INSTRUCTION_RECOMMENDED_LENGTH.toLocaleString()} characters or fewer`,
    );
    expect(instruction.getAttribute("aria-describedby")).toBe(
      "review-instruction-description review-instruction-status review-instruction-warning",
    );
    expect(warning.id).toBe("review-instruction-warning");
    expect(instruction.getAttribute("aria-invalid")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.change(instruction, { target: { value: "Short review instruction." } });
    expect(
      screen.queryByText(/Long review instructions are repeated across review passes/) === null,
    ).toBe(true);
    expect(instruction.getAttribute("aria-describedby")).not.toContain(
      "review-instruction-warning",
    );
  });

  test("reports custom instructions that do not use the target branch token", async () => {
    render(<GlobalSettings activeSection="review" />);
    await waitFor(() => expect(mockGetLogDirectory).toHaveBeenCalled());
    const instruction = screen.getByLabelText("Review instruction") as HTMLTextAreaElement;

    fireEvent.change(instruction, { target: { value: "Review the current diff." } });

    expect(screen.getByText("No dynamic target branch token")).toBeTruthy();
    expect(
      screen.getByText(
        `24 / ${REVIEW_INSTRUCTION_MAX_LENGTH.toLocaleString()} characters · ~6 tokens`,
      ),
    ).toBeTruthy();
  });

  test("saves a non-default editor selection", async () => {
    render(<GlobalSettings activeSection="general" />);

    fireEvent.click(screen.getByRole("button", { name: "Cursor" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ preferredEditor: "cursor" }),
      ),
    );
  });

  test("saves the default agent from the Defaults page", async () => {
    // Default Agent sits beside the defaults it governs rather than on General,
    // and the same control appears at the repository and environment tiers.
    render(<GlobalSettings activeSection="defaults" />);

    const agents = screen.getByRole("radiogroup", { name: "Default agent" });
    expect(
      within(agents)
        .getAllByRole("radio")
        .map((radio) => radio.textContent?.trim()),
    ).toEqual(["Claude Code", "Codex", "OpenCode"]);

    fireEvent.click(within(agents).getByRole("radio", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSettings: expect.objectContaining({ defaultAgent: "codex" }),
        }),
      ),
    );
  });

  test("shows all platforms and persists visibility choices", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          enabledAgentPlatforms: ["claude", "codex", "cursor", "grok", "opencode"],
        },
      },
    }));
    render(<GlobalSettings activeSection="platforms" />);

    for (const name of ["Claude Code", "Codex", "Cursor Agent", "Grok Build", "OpenCode"]) {
      expect(screen.getByRole("switch", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("switch", { name: "Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          enabledAgentPlatforms: ["codex", "cursor", "grok", "opencode"],
          // Disabling the default agent retargets it at the first platform that
          // is still enabled, rather than leaving a launch surface that is gone.
          agentSettings: expect.objectContaining({ defaultAgent: "codex" }),
        }),
      ),
    );
  });

  test("saves container CPU and memory slider changes", async () => {
    render(<GlobalSettings activeSection="container" />);
    const [cpuSlider, memorySlider] = screen.getAllByRole("slider");

    fireEvent.keyDown(cpuSlider!, { key: "ArrowRight" });
    fireEvent.keyDown(memorySlider!, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          containerResources: { cpuCores: 3, memoryGb: 5 },
        }),
      ),
    );
  });

  test("preserves the selected terminal font family while saving a size change", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          terminalAppearance: {
            ...state.config.global.terminalAppearance,
            fontFamily: "JetBrains Mono",
          },
        },
      },
    }));
    render(<GlobalSettings activeSection="terminal" />);

    expect(screen.getByRole("combobox").textContent).toContain("JetBrains Mono");
    fireEvent.keyDown(screen.getAllByRole("slider")[0]!, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalAppearance: expect.objectContaining({
            fontFamily: "JetBrains Mono",
            fontSize: 15,
          }),
        }),
      ),
    );
  });

  test("reveals and saves API credentials", async () => {
    const { rerender } = render(<GlobalSettings activeSection="claude" />);
    const anthropicInput = screen.getByPlaceholderText("sk-ant-...") as HTMLInputElement;
    expect(anthropicInput.type).toBe("password");
    fireEvent.click(anthropicInput.parentElement!.querySelector("button")!);
    expect(anthropicInput.type).toBe("text");
    fireEvent.change(anthropicInput, { target: { value: "test-anthropic-key" } });

    rerender(<GlobalSettings activeSection="cursor" />);
    const cursorInput = screen.getByLabelText("Cursor API key") as HTMLInputElement;
    expect(cursorInput.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show Cursor API key" }));
    expect(cursorInput.type).toBe("text");
    fireEvent.change(cursorInput, { target: { value: "test-cursor-key" } });

    rerender(<GlobalSettings activeSection="general" />);
    fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
    const githubInput = screen.getByLabelText("GitHub token") as HTMLInputElement;
    expect(githubInput.type).toBe("password");
    fireEvent.click(githubInput.parentElement!.querySelector("button")!);
    expect(githubInput.type).toBe("text");
    fireEvent.change(githubInput, { target: { value: "test-github-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig.mock.calls[0]?.[0]).not.toHaveProperty("anthropicApiKey");
      expect(mockSetAnthropicApiKey).toHaveBeenCalledWith("test-anthropic-key");
      expect(mockUpdateGlobalConfig.mock.calls[0]?.[0]).not.toHaveProperty("cursorApiKey");
      expect(mockSetCursorApiKey).toHaveBeenCalledWith("test-cursor-key");
      expect(mockUpdateGlobalConfig.mock.calls[0]?.[0]).not.toHaveProperty("githubToken");
      expect(mockSetGitHubToken).toHaveBeenCalledWith("test-github-token");
    });
  });

  test("treats a configured Cursor API key as write-only and clears it explicitly", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          cursorApiKeyConfigured: true,
        },
      },
    }));
    render(<GlobalSettings activeSection="cursor" />);

    const input = screen.getByLabelText("Cursor API key") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("API key configured — enter a replacement");

    fireEvent.click(screen.getByRole("button", { name: "Clear stored Cursor API key" }));
    expect(
      screen.getByText("The stored Cursor API key will be cleared when you save."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockSetCursorApiKey).toHaveBeenCalledWith(null));
    expect(mockUpdateGlobalConfig.mock.calls[0]?.[0]).not.toHaveProperty("cursorApiKey");
  });

  test("treats a configured Anthropic API key as write-only and clears it explicitly", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          anthropicApiKeyConfigured: true,
          anthropicApiKeySource: "config",
        },
      },
    }));
    render(<GlobalSettings activeSection="claude" />);

    const input = screen.getByPlaceholderText(
      "API key configured — enter a replacement",
    ) as HTMLInputElement;
    expect(input.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Clear stored Anthropic API key" }));
    expect(
      screen.getByText("The stored Anthropic API key will be cleared when you save."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockSetAnthropicApiKey).toHaveBeenCalledWith(null));
    expect(mockUpdateGlobalConfig.mock.calls[0]?.[0]).not.toHaveProperty("anthropicApiKey");
  });

  test("warns that a Cursor key inherited from the host environment cannot be cleared here", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          cursorApiKeyConfigured: false,
          cursorApiKeySource: "host-env" as const,
        },
      },
    }));
    render(<GlobalSettings activeSection="cursor" />);

    // Nothing is stored, so there is no clear button and the field is empty —
    // without this notice the pane implies no key reaches new containers.
    expect(screen.queryByRole("button", { name: "Clear stored Cursor API key" }) === null).toBe(
      true,
    );
    expect((screen.getByLabelText("Cursor API key") as HTMLInputElement).placeholder).toBe(
      "Cursor API key",
    );
    expect(screen.getByText(/inherited CURSOR_API_KEY from its own environment/)).toBeTruthy();
  });

  test("shows no host-environment warning when the stored key is the one in use", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          cursorApiKeyConfigured: true,
          cursorApiKeySource: "config" as const,
        },
      },
    }));
    render(<GlobalSettings activeSection="cursor" />);

    expect(screen.queryByText(/inherited CURSOR_API_KEY from its own environment/) === null).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Clear stored Cursor API key" })).toBeTruthy();
  });

  test("treats a configured GitHub token as write-only and replaces it explicitly", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          githubTokenConfigured: true,
        },
      },
    }));
    render(<GlobalSettings activeSection="general" />);

    fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
    const githubInput = screen.getByLabelText("GitHub token") as HTMLInputElement;
    expect(githubInput.value).toBe("");
    expect(githubInput.placeholder).toBe("Token configured — enter a replacement");

    fireEvent.change(githubInput, { target: { value: "replacement-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockSetGitHubToken).toHaveBeenCalledWith("replacement-token");
    });
    expect(mockUpdateGlobalConfig.mock.calls[0]?.[0]).not.toHaveProperty("githubToken");
    expect(mockPropagateGithubCredentialsToContainers).toHaveBeenCalledWith();
  });

  test("clears a configured GitHub token through the write-only command", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          githubTokenConfigured: true,
        },
      },
    }));
    render(<GlobalSettings activeSection="general" />);

    fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear stored token" }));
    expect(screen.getByText("The stored GitHub token will be cleared when you save.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockSetGitHubToken).toHaveBeenCalledWith(null);
    });
    expect(mockPropagateGithubCredentialsToContainers).toHaveBeenCalledWith();
  });

  test("switches from host credentials to PAT mode without writing an empty token", async () => {
    render(<GlobalSettings activeSection="general" />);

    const hostCredentials = screen.getByRole("switch", {
      name: "Use host GitHub CLI credentials",
    });
    expect(hostCredentials.getAttribute("data-state")).toBe("checked");
    expect(screen.queryByLabelText("GitHub token") === null).toBe(true);

    fireEvent.click(hostCredentials);
    expect(screen.getByLabelText("GitHub token")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ useHostGitHubCredentials: false }),
      ),
    );
    expect(mockSetGitHubToken).not.toHaveBeenCalled();
    expect(mockPropagateGithubCredentialsToContainers).toHaveBeenCalledWith();
  });

  test("keeps persisted settings and the PAT edit retryable when token storage fails", async () => {
    const originalConsoleError = console.error;
    console.error = mock(() => undefined);
    mockSetGitHubToken.mockRejectedValueOnce(new Error("keychain unavailable"));
    try {
      render(<GlobalSettings activeSection="general" />);
      fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
      const token = screen.getByLabelText("GitHub token") as HTMLInputElement;
      fireEvent.change(token, { target: { value: "replacement-token" } });
      fireEvent.change(screen.getByPlaceholderText(".env, .env.local"), {
        target: { value: ".env.local" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Failed to save settings", {
          description: "keychain unavailable",
        }),
      );
      expect(useConfigStore.getState().config.global.envFilePatterns).toEqual([".env.local"]);
      expect(useConfigStore.getState().config.global.useHostGitHubCredentials).toBe(false);
      expect(token.value).toBe("replacement-token");
      expect(
        (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("discards a failed PAT edit on Reset instead of resurrecting it later", async () => {
    const originalConsoleError = console.error;
    console.error = mock(() => undefined);
    mockSetGitHubToken.mockRejectedValueOnce(new Error("keychain unavailable"));
    try {
      render(<GlobalSettings activeSection="general" />);
      fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
      const token = screen.getByLabelText("GitHub token") as HTMLInputElement;
      fireEvent.change(token, { target: { value: "discarded-token" } });
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Failed to save settings", {
          description: "keychain unavailable",
        }),
      );
      expect(token.value).toBe("discarded-token");

      fireEvent.click(screen.getAllByRole("button", { name: "Reset" }).at(-1)!);
      expect(token.value).toBe("");

      // Any later external config change re-runs the `[global]` sync effect. A
      // retained edit would be restored here, putting a token the user threw
      // away back in the field — and back into the next save.
      await act(async () => {
        useConfigStore.getState().setConfig({
          ...useConfigStore.getState().config,
          global: {
            ...useConfigStore.getState().config.global,
            debugLogging: !useConfigStore.getState().config.global.debugLogging,
          },
        });
        await Promise.resolve();
      });
      expect((screen.getByLabelText("GitHub token") as HTMLInputElement).value).toBe("");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("switches from a configured PAT to host credentials without replacing the PAT", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          useHostGitHubCredentials: false,
          githubTokenConfigured: true,
        },
      },
    }));
    render(<GlobalSettings activeSection="general" />);

    const hostCredentials = screen.getByRole("switch", {
      name: "Use host GitHub CLI credentials",
    });
    expect(hostCredentials.getAttribute("data-state")).toBe("unchecked");
    fireEvent.click(hostCredentials);
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ useHostGitHubCredentials: true }),
      ),
    );
    expect(mockSetGitHubToken).not.toHaveBeenCalled();
    expect(mockPropagateGithubCredentialsToContainers).toHaveBeenCalledWith();
  });

  test("saves debug logging retention, reports storage, and cleans up its log directory", async () => {
    mockGetLogDirectory.mockResolvedValue("/tmp/orkestrator-logs");
    render(<GlobalSettings activeSection="debug" />);

    expect(await screen.findByText("1.5 KB across 2 files")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disabled" }));
    fireEvent.change(screen.getByLabelText("Log retention days"), { target: { value: "30" } });
    const logDirectory = await screen.findByRole("button", { name: "/tmp/orkestrator-logs" });
    fireEvent.click(logDirectory);
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(mockRevealInFileManager).toHaveBeenCalledWith("/tmp/orkestrator-logs");
    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ debugLogging: true, debugLogRetentionDays: 30 }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Clean up logs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete logs" }));
    await waitFor(() => expect(mockCleanupLogs).toHaveBeenCalled());
    expect(await screen.findByText("0 B across 0 files")).toBeTruthy();
  });

  test("keeps the recursive log-storage walk off sections that do not show it", async () => {
    const { rerender } = render(<GlobalSettings activeSection="general" />);
    await waitFor(() => expect(mockGetLogDirectory).toHaveBeenCalled());
    expect(mockGetLogStorageStats).not.toHaveBeenCalled();

    rerender(<GlobalSettings activeSection="debug" />);
    await waitFor(() => expect(mockGetLogStorageStats).toHaveBeenCalled());
  });

  test("still reports the log directory when the storage walk fails", async () => {
    mockGetLogDirectory.mockResolvedValue("/tmp/orkestrator-logs");
    mockGetLogStorageStats.mockRejectedValue(new Error("too many entries"));
    render(<GlobalSettings activeSection="debug" />);

    expect(await screen.findByText("Storage usage unavailable")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "/tmp/orkestrator-logs" })).toBeTruthy();
  });

  test("surfaces a cleanup failure without claiming the logs were removed", async () => {
    mockCleanupLogs.mockRejectedValue(new Error("permission denied"));
    render(<GlobalSettings activeSection="debug" />);

    expect(await screen.findByText("1.5 KB across 2 files")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clean up logs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete logs" }));

    await waitFor(() => expect(mockCleanupLogs).toHaveBeenCalled());
    expect(await screen.findByText("1.5 KB across 2 files")).toBeTruthy();
  });

  test("keeps later log-storage results when an earlier walk finishes last", async () => {
    const first = deferred<{ totalBytes: number; fileCount: number }>();
    const second = deferred<{ totalBytes: number; fileCount: number }>();
    let statsCalls = 0;
    mockGetLogDirectory.mockResolvedValue("/tmp/orkestrator-logs");
    mockGetLogStorageStats.mockImplementation(() => {
      statsCalls += 1;
      return statsCalls === 1 ? first.promise : second.promise;
    });

    const { rerender } = render(<GlobalSettings activeSection="debug" />);
    await waitFor(() => expect(mockGetLogStorageStats).toHaveBeenCalledTimes(1));

    rerender(<GlobalSettings activeSection="general" />);
    rerender(<GlobalSettings activeSection="debug" />);
    await waitFor(() => expect(mockGetLogStorageStats).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Calculating storage used…")).toBeTruthy();

    await act(async () => {
      first.resolve({ totalBytes: 1536, fileCount: 2 });
      await first.promise;
    });
    expect(screen.getByText("Calculating storage used…")).toBeTruthy();
    expect(screen.queryByText("1.5 KB across 2 files") === null).toBe(true);

    await act(async () => {
      second.resolve({ totalBytes: 2048, fileCount: 4 });
      await second.promise;
    });
    expect(await screen.findByText("2 KB across 4 files")).toBeTruthy();
  });

  test("does not let a stale storage walk overwrite a cleanup", async () => {
    const first = deferred<{ totalBytes: number; fileCount: number }>();
    const second = deferred<{ totalBytes: number; fileCount: number }>();
    let statsCalls = 0;
    mockGetLogDirectory.mockResolvedValue("/tmp/orkestrator-logs");
    mockGetLogStorageStats.mockImplementation(() => {
      statsCalls += 1;
      return statsCalls === 1 ? first.promise : second.promise;
    });

    const { rerender } = render(<GlobalSettings activeSection="debug" />);
    await waitFor(() => expect(mockGetLogStorageStats).toHaveBeenCalledTimes(1));

    rerender(<GlobalSettings activeSection="general" />);
    rerender(<GlobalSettings activeSection="debug" />);
    await waitFor(() => expect(mockGetLogStorageStats).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({ totalBytes: 1536, fileCount: 2 });
      await second.promise;
    });
    expect(await screen.findByText("1.5 KB across 2 files")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clean up logs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete logs" }));
    await waitFor(() => expect(mockCleanupLogs).toHaveBeenCalled());
    expect(await screen.findByText("0 B across 0 files")).toBeTruthy();

    await act(async () => {
      first.resolve({ totalBytes: 4096, fileCount: 8 });
      await first.promise;
    });
    expect(screen.getByText("0 B across 0 files")).toBeTruthy();
    expect(screen.queryByText("4 KB across 8 files") === null).toBe(true);
  });

  test("names the blocking reason when an invalid retention disables Save from another section", async () => {
    const { rerender } = render(<GlobalSettings activeSection="debug" />);
    const retention = await screen.findByLabelText("Log retention days");

    // Clearing the field is the ordinary way into the invalid state.
    fireEvent.change(retention, { target: { value: "" } });
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // The inline message lives in the Debug pane, so without a shared reason
    // the block would be invisible from every other section.
    rerender(<GlobalSettings activeSection="general" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Log retention in Debug");
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    rerender(<GlobalSettings activeSection="debug" />);
    fireEvent.change(await screen.findByLabelText("Log retention days"), {
      target: { value: "30" },
    });
    rerender(<GlobalSettings activeSection="general" />);
    await waitFor(() => expect(screen.queryAllByRole("alert").length).toBe(0));
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("uses and restores the default terminal scrollback when legacy config omits it", () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, terminalScrollback: undefined },
      },
    }));
    const { container } = render(<GlobalSettings activeSection="terminal" />);
    expect(screen.getByText("1,000 lines")).toBeTruthy();

    const colorTextInput = container.querySelector(
      'input[type="text"][value="#000000"]',
    ) as HTMLInputElement;
    fireEvent.change(colorTextInput, { target: { value: "invalid" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reset" }).at(-1)!);

    expect(screen.getByText("1,000 lines")).toBeTruthy();
    expect(screen.queryByText("Invalid hex color format. Use #RGB or #RRGGBB.") === null).toBe(
      true,
    );
  });

  test("saves terminal font and scrollback selections", async () => {
    render(<GlobalSettings activeSection="terminal" />);

    const font = screen.getByRole("combobox");
    fireEvent.keyDown(font, { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox");
    const option = screen.getByRole("option", { name: "JetBrains Mono" });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.pointerUp(option, { pointerType: "mouse" });
    await waitFor(() => expect(font.textContent).toContain("JetBrains Mono"));
    fireEvent.animationEnd(listbox);
    await waitFor(() => expect(screen.queryByRole("listbox") === null).toBe(true));
    const scrollback = screen.getAllByRole("slider")[1]!;
    fireEvent.keyDown(scrollback, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalAppearance: expect.objectContaining({ fontFamily: "JetBrains Mono" }),
          terminalScrollback: 5100,
        }),
      ),
    );
  });

  test("blocks saves for invalid domains and terminal colors", () => {
    const { container, rerender } = render(<GlobalSettings activeSection="network" />);
    fireEvent.change(screen.getByPlaceholderText(/github\.com/), {
      target: { value: "not a domain" },
    });
    expect(screen.getByText("Invalid domain format: not a domain")).toBeTruthy();
    expect(
      (within(container).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    rerender(<GlobalSettings activeSection="terminal" />);
    fireEvent.change(screen.getByPlaceholderText("#0e1014"), { target: { value: "invalid" } });
    expect(screen.getByText("Invalid hex color format. Use #RGB or #RRGGBB.")).toBeTruthy();
    expect(
      (within(container).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("treats a missing legacy Claude mode as native and saves explicit terminal", async () => {
    useConfigStore.setState((state) => {
      // A config that never set a Claude mode: the pane must show the shipped
      // native default rather than an empty selection.
      const global = { ...state.config.global };
      global.agentSettings = {
        ...global.agentSettings,
        platforms: { ...global.agentSettings?.platforms, claude: {} },
      };
      return {
        config: {
          ...state.config,
          global,
        },
      };
    });
    render(<GlobalSettings activeSection="claude" />);

    const section = screen.getByRole("radiogroup", { name: "Claude Code mode" });
    const nativeButton = within(section).getByRole("radio", { name: /^Native/ });
    const terminalButton = within(section).getByRole("radio", { name: /^Terminal/ });
    const saveButton = screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement;

    // Nothing is stored, so nothing is selected; the pane says the shipped
    // default is Native beneath the group instead of faking a selection.
    expect(nativeButton.getAttribute("aria-checked")).toBe("false");
    expect(terminalButton.getAttribute("aria-checked")).toBe("false");
    expect(saveButton.disabled).toBe(true);

    fireEvent.click(terminalButton);
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSettings: expect.objectContaining({
            platforms: expect.objectContaining({
              claude: expect.objectContaining({ mode: "terminal" }),
            }),
          }),
        }),
      ),
    );
  });

  test("saves the Claude native backend selection", async () => {
    render(<GlobalSettings activeSection="claude" />);

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Claude native backend" })).getByRole("radio", {
        name: /^Tmux/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSettings: expect.objectContaining({
            platforms: expect.objectContaining({
              claude: expect.objectContaining({ claudeNativeBackend: "tmux" }),
            }),
          }),
        }),
      ),
    );
  });

  test("trims and deduplicates environment patterns and allowed domains", async () => {
    const view = render(<GlobalSettings activeSection="general" />);
    // Env patterns are filenames, so `.ENV` is a different pattern from `.env`
    // and must survive; domains are DNS names, so case is irrelevant there.
    fireEvent.change(screen.getByPlaceholderText(".env, .env.local"), {
      target: { value: " .env , .env.local, .env, .ENV,  " },
    });
    view.rerender(<GlobalSettings activeSection="network" />);
    fireEvent.change(screen.getByPlaceholderText(/github\.com/), {
      target: { value: " Example.com\napi.example.com\nexample.com\nEXAMPLE.COM\n " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          envFilePatterns: [".env", ".env.local", ".ENV"],
          // First spelling typed wins, in first-occurrence order.
          allowedDomains: ["Example.com", "api.example.com"],
        }),
      ),
    );
  });

  test("calls onSaveSuccess only after the success delay", async () => {
    const onSaveSuccess = mock(() => undefined);
    render(<GlobalSettings activeSection="codex" onSaveSuccess={onSaveSuccess} />);
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Codex mode" })).getByRole("radio", {
        name: /^Terminal/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("Settings saved"));
    expect(onSaveSuccess).not.toHaveBeenCalled();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 550)));
    expect(onSaveSuccess).toHaveBeenCalledTimes(1);
  });

  test("preserves the tmux Claude model preference when saving unrelated settings", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          agentSettings: { platforms: { claude: { model: "default" } } },
        },
      },
    }));

    const { container } = render(<GlobalSettings activeSection="codex" />);

    // Each platform pane labels its own mode group, so the query cannot pick up
    // another platform's control.
    const codexMode = screen.getByRole("radiogroup", { name: "Codex mode" });
    fireEvent.click(within(codexMode).getByRole("radio", { name: /^Terminal/ }));
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSettings: {
            platforms: { claude: { model: "default" }, codex: { mode: "terminal" } },
          },
        }),
      );
    });
  });

  test("preserves max and ultra Codex preferences when saving unrelated settings", async () => {
    for (const effort of ["max", "ultra"] as const) {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            agentSettings: {
              platforms: { codex: { model: "gpt-5.6-sol", reasoningEffort: effort } },
            },
          },
        },
      }));
      const { unmount } = render(<GlobalSettings activeSection="codex" />);

      fireEvent.click(
        within(screen.getByRole("radiogroup", { name: "Codex mode" })).getByRole("radio", {
          name: /^Terminal/,
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

      await waitFor(() => {
        expect(mockUpdateGlobalConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            agentSettings: expect.objectContaining({
              platforms: expect.objectContaining({
                codex: expect.objectContaining({ model: "gpt-5.6-sol", reasoningEffort: effort }),
              }),
            }),
          }),
        );
      });
      unmount();
      mockUpdateGlobalConfig.mockClear();
    }
  });

  test("validates domains locally, tests valid domains, and resets validation state", async () => {
    mockTestDomainResolution.mockResolvedValueOnce([
      { domain: "example.com", valid: true, resolvable: true },
    ]);
    render(<GlobalSettings activeSection="network" />);
    const domains = screen.getByPlaceholderText(/github\.com/) as HTMLTextAreaElement;

    fireEvent.change(domains, { target: { value: "not a domain" } });
    expect(screen.getByText("Invalid domain format: not a domain")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Test DNS" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.change(domains, { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Test DNS" }));
    await waitFor(() => expect(mockTestDomainResolution).toHaveBeenCalledWith(["example.com"]));

    fireEvent.click(screen.getAllByRole("button", { name: "Reset" }).at(-1)!);
    expect(domains.value).toBe("");
    expect(screen.queryByText(/Invalid domain format/) === null).toBe(true);
  });

  test("renders every DNS result state and recovers from a test failure", async () => {
    const originalConsoleError = console.error;
    console.error = mock(() => undefined);
    mockTestDomainResolution
      .mockResolvedValueOnce([
        { domain: "resolved.example", valid: true, resolvable: true },
        { domain: "missing.example", valid: true, resolvable: false, error: "Not found" },
        { domain: "invalid.example", valid: false, resolvable: false, error: "Invalid response" },
      ])
      .mockRejectedValueOnce(new Error("resolver offline"));
    try {
      render(<GlobalSettings activeSection="network" />);
      const domains = screen.getByPlaceholderText(/github\.com/);
      fireEvent.change(domains, {
        target: { value: "resolved.example\nmissing.example\ninvalid.example" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Test DNS" }));

      expect(await screen.findByText("resolved.example")).toBeTruthy();
      expect(screen.getByText("Not found")).toBeTruthy();
      expect(screen.getByText("Invalid response")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Test DNS" }));
      await waitFor(() => expect(mockTestDomainResolution).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByRole("button", { name: "Test DNS" })).toBeTruthy());
      expect(console.error).toHaveBeenCalledWith(
        "[settings] Failed to test domains:",
        expect.any(Error),
      );
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("clears terminal color validation errors when changes are reset", () => {
    const { container } = render(<GlobalSettings activeSection="terminal" />);
    const colorTextInput = container.querySelector(
      'input[type="text"][value="#000000"]',
    ) as HTMLInputElement;

    fireEvent.change(colorTextInput, { target: { value: "invalid" } });
    expect(screen.getByText("Invalid hex color format. Use #RGB or #RRGGBB.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(colorTextInput, { target: { value: "#123456" } });
    expect(screen.queryByText("Invalid hex color format. Use #RGB or #RRGGBB.") === null).toBe(
      true,
    );
    fireEvent.change(colorTextInput, { target: { value: "invalid" } });

    fireEvent.click(screen.getAllByRole("button", { name: "Reset" }).at(-1)!);
    expect(colorTextInput.value).toBe("#000000");
    expect(screen.queryByText("Invalid hex color format. Use #RGB or #RRGGBB.") === null).toBe(
      true,
    );
  });

  test("propagates changed GitHub credentials without failing a saved config", async () => {
    mockPropagateGithubCredentialsToContainers.mockResolvedValueOnce({
      updated: ["container-1"],
      failed: [],
    });
    render(<GlobalSettings activeSection="general" />);

    fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
    fireEvent.change(screen.getByLabelText("GitHub token"), { target: { value: "new-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockPropagateGithubCredentialsToContainers).toHaveBeenCalledWith());
    expect(mockToastSuccess).toHaveBeenCalledWith("Updated GitHub credentials in 1 container(s)");
  });

  test("keeps the config saved and offers a retry when credential propagation throws", async () => {
    mockPropagateGithubCredentialsToContainers.mockRejectedValueOnce(
      new Error("container unavailable"),
    );
    render(<GlobalSettings activeSection="general" />);

    fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
    fireEvent.change(screen.getByLabelText("GitHub token"), { target: { value: "new-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockPropagateGithubCredentialsToContainers).toHaveBeenCalledTimes(1),
    );
    expect(mockToastError).toHaveBeenCalledWith("Settings saved, but containers were not updated", {
      description: "container unavailable. Save Changes to retry.",
    });
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Settings saved");
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("reports partial GitHub credential propagation failures with affected containers", async () => {
    mockPropagateGithubCredentialsToContainers.mockResolvedValueOnce({
      updated: ["environment-1"],
      failed: [["environment-2", "container unavailable"]],
    });
    render(<GlobalSettings activeSection="general" />);

    fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Settings saved, but some containers were not updated",
        {
          description:
            "Updated 1 container(s). Failed: environment-2: container unavailable. Save Changes to retry.",
        },
      ),
    );
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Settings saved");
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("truncates long GitHub credential propagation failure details", async () => {
    mockPropagateGithubCredentialsToContainers.mockResolvedValueOnce({
      updated: [],
      failed: [
        ["environment-1", "failed one"],
        ["environment-2", "failed two"],
        ["environment-3", "failed three"],
        ["environment-4", "failed four"],
        ["environment-5", "failed five"],
      ],
    });
    render(<GlobalSettings activeSection="general" />);
    fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Settings saved, but some containers were not updated",
        {
          description:
            "Failed: environment-1: failed one; environment-2: failed two; environment-3: failed three; and 2 more. Save Changes to retry.",
        },
      ),
    );
  });

  test("reports complete GitHub credential propagation failures and retries on save", async () => {
    mockPropagateGithubCredentialsToContainers.mockResolvedValueOnce({
      updated: [],
      failed: [
        ["environment-1", "container unavailable"],
        ["environment-2", "permission denied"],
      ],
    });
    mockPropagateGithubCredentialsToContainers.mockResolvedValueOnce({
      updated: ["environment-1", "environment-2"],
      failed: [],
    });
    render(<GlobalSettings activeSection="general" />);

    fireEvent.click(screen.getByRole("switch", { name: "Use host GitHub CLI credentials" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Settings saved, but some containers were not updated",
        {
          description:
            "Failed: environment-1: container unavailable; environment-2: permission denied. Save Changes to retry.",
        },
      ),
    );
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Settings saved");

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(mockPropagateGithubCredentialsToContainers).toHaveBeenCalledTimes(2),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Updated GitHub credentials in 2 container(s)");
    expect(mockToastSuccess).toHaveBeenCalledWith("Settings saved");
  });

  test("reports persistence failures and leaves Save available for retry", async () => {
    mockUpdateGlobalConfig.mockRejectedValueOnce(new Error("disk full"));
    render(<GlobalSettings activeSection="codex" />);

    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Codex mode" })).getByRole("radio", {
        name: /^Terminal/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Failed to save settings", {
        description: "disk full",
      }),
    );
    expect(
      (screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("saves experimental Codex raw event logging changes", async () => {
    render(<GlobalSettings activeSection="experimental" />);

    fireEvent.click(screen.getByRole("button", { name: "Enabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          experimentalCodexRawEventLogging: false,
        }),
      );
    });
  });
});
