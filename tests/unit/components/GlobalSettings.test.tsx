import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";

const mockUpdateGlobalConfig = mock(async (globalConfig: unknown) => ({
  version: "1.0",
  global: globalConfig,
  repositories: {},
}));
const mockGetLogDirectory = mock(async () => null);
const mockPropagateGithubTokenToContainers = mock(async () => ({ updated: [] }));
const mockGetWebClientStatus = mock(async () => ({
  enabled: true,
  running: true,
  url: "http://100.88.12.3:34121/",
  error: null,
}));
const mockSetWebClientEnabled = mock(async (enabled: boolean) => ({
  enabled,
  running: enabled,
  url: enabled ? "http://100.88.12.3:34121/" : null,
  error: null,
}));
const mockOpenInBrowser = mock(async () => undefined);
const mockToastSuccess = mock(() => {});
const mockToastError = mock(() => {});
const actualBackend = await import("../../../src/lib/backend");

mock.module("@/lib/backend", () => ({
  ...actualBackend,
  updateGlobalConfig: mockUpdateGlobalConfig,
  getLogDirectory: mockGetLogDirectory,
  propagateGithubTokenToContainers: mockPropagateGithubTokenToContainers,
  getWebClientStatus: mockGetWebClientStatus,
  setWebClientEnabled: mockSetWebClientEnabled,
  openInBrowser: mockOpenInBrowser,
  testDomainResolution: mock(async () => []),
  revealInFileManager: mock(async () => {}),
}));

mock.module("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

const { GlobalSettings } = await import("../../../src/components/settings/GlobalSettings");

describe("GlobalSettings", () => {
  beforeEach(() => {
    cleanup();
    mockUpdateGlobalConfig.mockClear();
    mockGetLogDirectory.mockClear();
    mockPropagateGithubTokenToContainers.mockClear();
    mockGetWebClientStatus.mockClear();
    mockSetWebClientEnabled.mockClear();
    mockOpenInBrowser.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockGetWebClientStatus.mockImplementation(async () => ({
      enabled: true,
      running: true,
      url: "http://100.88.12.3:34121/",
      error: null,
    }));
    mockSetWebClientEnabled.mockImplementation(async (enabled: boolean) => ({
      enabled,
      running: enabled,
      url: enabled ? "http://100.88.12.3:34121/" : null,
      error: null,
    }));
    window.orkestratorGateway = undefined;

    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          defaultAgent: "claude",
          opencodeModel: "opencode/grok-code",
          claudeModel: "claude-sonnet-4-6",
          codexModel: "gpt-5.3-codex",
          codexReasoningEffort: "medium",
          opencodeMode: "terminal",
          claudeMode: "terminal",
          claudeNativeFastModeDefault: false,
          codexMode: "native",
          codexNativeFastModeDefault: false,
          terminalAppearance: {
            fontFamily: "Fira Code",
            fontSize: 14,
            backgroundColor: "#000000",
          },
          terminalScrollback: 5000,
          experimentalCodexRawEventLogging: true,
          debugLogging: false,
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

    const codexSection = screen
      .getByText("Choose how Codex runs in environments")
      .parentElement;
    if (!codexSection) {
      throw new Error("Expected Codex settings section");
    }

    fireEvent.click(within(codexSection).getByRole("button", { name: "Terminal" }));
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          codexMode: "terminal",
        })
      );
    });
  });

  test("turns off the web client and shows its live link", async () => {
    const { container } = render(<GlobalSettings activeSection="web-client" />);

    expect(await screen.findByRole("link", { name: /http:\/\/100\.88\.12\.3:34121\// })).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Allow web access" }));
    expect(screen.getByText("Save changes to stop the web client.")).toBeTruthy();
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ webClientEnabled: false }),
      );
      expect(mockSetWebClientEnabled).toHaveBeenCalledWith(false);
    });
  });

  test("starts a previously disabled web client", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, webClientEnabled: false },
      },
    }));
    mockGetWebClientStatus.mockResolvedValueOnce({ enabled: false, running: false, url: null, error: null });
    const { container } = render(<GlobalSettings activeSection="web-client" />);
    const toggle = screen.getByRole("switch", { name: "Allow web access" });
    await screen.findByText("Off");

    fireEvent.click(toggle);
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockSetWebClientEnabled).toHaveBeenCalledWith(true));
    expect(await screen.findByText("Running")).toBeTruthy();
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
    unmount();

    mockGetWebClientStatus.mockRejectedValueOnce(new Error("IPC unavailable"));
    render(<GlobalSettings activeSection="web-client" />);
    expect(await screen.findByText("IPC unavailable")).toBeTruthy();
  });

  test("keeps web-client controls read-only in a remote browser", async () => {
    window.orkestratorGateway = { enabled: true };
    render(<GlobalSettings activeSection="web-client" />);
    await screen.findByText("Running");

    const toggle = screen.getByRole("switch", { name: "Allow web access" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText("This setting can only be changed in the desktop app.")).toBeTruthy();
    expect(mockSetWebClientEnabled).not.toHaveBeenCalled();
  });

  test("reports transition failures without showing save success", async () => {
    const originalConsoleError = console.error;
    console.error = mock(() => undefined);
    mockSetWebClientEnabled.mockRejectedValueOnce(new Error("gateway transition failed"));
    const { container } = render(<GlobalSettings activeSection="web-client" />);
    await screen.findByText("Running");

    fireEvent.click(screen.getByRole("switch", { name: "Allow web access" }));
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to save settings",
      { description: "gateway transition failed" },
    ));
    expect(mockToastSuccess).not.toHaveBeenCalledWith("Settings saved");
    console.error = originalConsoleError;
  });

  test("resets a pending web-client change", async () => {
    const { container } = render(<GlobalSettings activeSection="web-client" />);
    await screen.findByText("Running");
    const toggle = screen.getByRole("switch", { name: "Allow web access" });

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(container).getByRole("button", { name: "Reset" }));

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test("opens the live gateway link through the desktop browser API", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    const link = await screen.findByRole("link", { name: /100\.88\.12\.3/ });

    fireEvent.click(link);
    expect(mockOpenInBrowser).toHaveBeenCalledWith("http://100.88.12.3:34121/");
  });

  test("ignores an older status response after configuration changes", async () => {
    let resolveFirst: ((value: { enabled: boolean; running: boolean; url: string | null; error: string | null }) => void) | undefined;
    mockGetWebClientStatus
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ enabled: true, running: false, url: null, error: "new status" });
    render(<GlobalSettings activeSection="web-client" />);

    act(() => {
      useConfigStore.setState((state) => ({
        config: {
          ...state.config,
          global: { ...state.config.global, webClientEnabled: false },
        },
      }));
    });
    expect(await screen.findByText("new status")).toBeTruthy();

    await act(async () => {
      resolveFirst?.({ enabled: true, running: true, url: "http://stale.invalid/", error: null });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText("http://stale.invalid/")).toBeNull());
    expect(screen.getByText("new status")).toBeTruthy();
  });

  test("renders every settings section", () => {
    const { rerender } = render(<GlobalSettings activeSection="general" />);
    expect(screen.getByText("Preferred Editor")).toBeTruthy();
    rerender(<GlobalSettings activeSection="claude" />);
    expect(screen.getByText("Choose how Claude runs in environments")).toBeTruthy();
    rerender(<GlobalSettings activeSection="opencode" />);
    expect(screen.getByText("Choose how OpenCode runs in environments")).toBeTruthy();
    rerender(<GlobalSettings activeSection="codex" />);
    expect(screen.getByText("Choose how Codex runs in environments")).toBeTruthy();
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

  test("blocks saves for invalid domains and terminal colors", () => {
    const { container, rerender } = render(<GlobalSettings activeSection="network" />);
    fireEvent.change(screen.getByPlaceholderText(/github\.com/), { target: { value: "not a domain" } });
    expect(screen.getByText("Invalid domain format: not a domain")).toBeTruthy();
    expect((within(container).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<GlobalSettings activeSection="terminal" />);
    fireEvent.change(screen.getByPlaceholderText("#141414"), { target: { value: "invalid" } });
    expect(screen.getByText("Invalid hex color format. Use #RGB or #RRGGBB.")).toBeTruthy();
    expect((within(container).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("saves Claude native fast mode default changes", async () => {
    const { container } = render(<GlobalSettings activeSection="claude" />);

    fireEvent.click(screen.getByRole("switch", { name: "Claude fast mode for new native tabs" }));
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          claudeNativeFastModeDefault: true,
        })
      );
    });
  });

  test("preserves the tmux Claude model preference when saving unrelated settings", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "default",
        },
      },
    }));

    const { container } = render(<GlobalSettings activeSection="codex" />);

    const codexSection = screen
      .getByText("Choose how Codex runs in environments")
      .parentElement;
    if (!codexSection) {
      throw new Error("Expected Codex settings section");
    }

    fireEvent.click(within(codexSection).getByRole("button", { name: "Terminal" }));
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          claudeModel: "default",
          codexMode: "terminal",
        })
      );
    });
  });

  test("renders saved native fast mode defaults as enabled", () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeNativeFastModeDefault: true,
          codexNativeFastModeDefault: true,
        },
      },
    }));

    const { rerender } = render(<GlobalSettings activeSection="claude" />);

    expect(
      screen
        .getByRole("switch", { name: "Claude fast mode for new native tabs" })
        .getAttribute("aria-checked")
    ).toBe("true");

    rerender(<GlobalSettings activeSection="codex" />);

    expect(
      screen
        .getByRole("switch", { name: "Codex fast mode for new native tabs" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });

  test("reset restores unsaved native fast mode default changes", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeNativeFastModeDefault: true,
        },
      },
    }));
    const { container } = render(<GlobalSettings activeSection="claude" />);
    const fastModeSwitch = screen.getByRole("switch", {
      name: "Claude fast mode for new native tabs",
    });

    fireEvent.click(fastModeSwitch);

    await waitFor(() => {
      expect(fastModeSwitch.getAttribute("aria-checked")).toBe("false");
    });

    fireEvent.click(within(container).getByRole("button", { name: "Reset" }));

    await waitFor(() => {
      expect(fastModeSwitch.getAttribute("aria-checked")).toBe("true");
    });
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test("native fast mode switches participate in save change detection", async () => {
    const { container } = render(<GlobalSettings activeSection="claude" />);
    const saveButton = within(container).getByRole("button", { name: "Save Changes" });
    const fastModeSwitch = screen.getByRole("switch", {
      name: "Claude fast mode for new native tabs",
    });

    expect((saveButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(fastModeSwitch);

    await waitFor(() => {
      expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(fastModeSwitch);

    await waitFor(() => {
      expect((saveButton as HTMLButtonElement).disabled).toBe(true);
    });
  });

  test("saves Codex native fast mode default changes", async () => {
    const { container } = render(<GlobalSettings activeSection="codex" />);

    fireEvent.click(screen.getByRole("switch", { name: "Codex fast mode for new native tabs" }));
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          codexNativeFastModeDefault: true,
        })
      );
    });
  });

  test("saves experimental Codex raw event logging changes", async () => {
    render(<GlobalSettings activeSection="experimental" />);

    fireEvent.click(screen.getByRole("button", { name: "Enabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          experimentalCodexRawEventLogging: false,
        })
      );
    });
  });
});
