import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { mockWriteText } from "../../mocks/clipboard";

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
const mockResetWebClientServe = mock(async () => ({
  enabled: true,
  running: true,
  url: "https://workstation.example.ts.net/",
  error: null,
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
const mockToastSuccess = mock(() => {});
const mockToastError = mock(() => {});
const actualBackend = await import("../../../apps/web/src/lib/backend");

mock.module("@/lib/backend", () => ({
  ...actualBackend,
  updateGlobalConfig: mockUpdateGlobalConfig,
  getLogDirectory: mockGetLogDirectory,
  propagateGithubTokenToContainers: mockPropagateGithubTokenToContainers,
  getWebClientStatus: mockGetWebClientStatus,
  setWebClientEnabled: mockSetWebClientEnabled,
  resetWebClientServe: mockResetWebClientServe,
  getGatewayTokenSettings: mockGetGatewayTokenSettings,
  setGatewayToken: mockSetGatewayToken,
  openInBrowser: mockOpenInBrowser,
  testDomainResolution: mockTestDomainResolution,
  revealInFileManager: mock(async () => {}),
}));

mock.module("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

const { GlobalSettings } = await import("../../../apps/web/src/components/settings/GlobalSettings");

describe("GlobalSettings", () => {
  beforeEach(() => {
    cleanup();
    mockUpdateGlobalConfig.mockClear();
    mockGetLogDirectory.mockClear();
    mockPropagateGithubTokenToContainers.mockClear();
    mockGetWebClientStatus.mockClear();
    mockSetWebClientEnabled.mockClear();
    mockResetWebClientServe.mockClear();
    mockGetGatewayTokenSettings.mockClear();
    mockSetGatewayToken.mockClear();
    mockOpenInBrowser.mockClear();
    mockTestDomainResolution.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockWriteText.mockReset();
    mockWriteText.mockImplementation(async () => {});
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
    mockResetWebClientServe.mockImplementation(async () => ({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
      error: null,
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
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(expect.objectContaining({ webClientEnabled: false }));
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
    });
    render(<GlobalSettings activeSection="web-client" />);

    expect(await screen.findByText(/Refusing to replace/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset Tailscale Serve" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/removes the existing HTTPS listener on port 443/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset Tailscale Serve" }));

    await waitFor(() => expect(mockResetWebClientServe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    expect(mockToastSuccess).toHaveBeenCalledWith("Tailscale Serve reset");
  });

  test("keeps a failed Electron web access transition retryable after config persistence", async () => {
    window.orkestratorGateway = undefined;
    mockSetWebClientEnabled.mockRejectedValueOnce(new Error("control request failed"));
    const { container } = render(<GlobalSettings activeSection="web-client" />);
    await screen.findByText("Running");

    fireEvent.click(screen.getByRole("switch", { name: "Allow web access" }));
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to save settings",
      { description: "control request failed" },
    ));
    expect(screen.getByText("control request failed")).toBeTruthy();
    const saveButton = within(container).getByRole("button", { name: "Save Changes" }) as HTMLButtonElement;
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
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("displays, reveals, edits, and saves the gateway token", async () => {
    const { container } = render(<GlobalSettings activeSection="web-client" />);
    const input = await screen.findByLabelText("Gateway token") as HTMLInputElement;

    expect(input.type).toBe("password");
    expect(input.value).toBe("gateway-token-123456");
    fireEvent.click(screen.getByRole("button", { name: "Show gateway token" }));
    expect(input.type).toBe("text");

    fireEvent.change(input, { target: { value: "replacement-token-123456" } });
    expect(screen.getByText("Save changes to use this token for future sign-ins.")).toBeTruthy();
    fireEvent.click(within(container).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockSetGatewayToken).toHaveBeenCalledWith("replacement-token-123456"));
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

  test("shows an environment-managed gateway token as read-only", async () => {
    mockGetGatewayTokenSettings.mockResolvedValueOnce({
      token: "environment-token-123456",
      editable: false,
      source: "environment",
    });
    render(<GlobalSettings activeSection="web-client" />);

    const input = await screen.findByLabelText("Gateway token") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("environment-token-123456"));
    expect(input.disabled).toBe(true);
    expect(screen.getByText(/ORKESTRATOR_GATEWAY_TOKEN/)).toBeTruthy();
  });

  test("validates gateway token character and encoded-cookie boundaries", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    const input = await screen.findByLabelText("Gateway token") as HTMLInputElement;
    const saveButton = screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "short" } });
    expect(screen.getByText("Gateway token must be at least 16 characters.")).toBeTruthy();
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "😀".repeat(512) } });
    expect(screen.getByText("Gateway token is too large to store in a browser cookie.")).toBeTruthy();
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "valid-token-value-123456" } });
    expect(screen.queryByText(/Gateway token must|too large to store/)).toBeNull();
    expect(saveButton.disabled).toBe(false);
  });

  test("resets an unsaved gateway token edit", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    const input = await screen.findByLabelText("Gateway token") as HTMLInputElement;

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
    const input = await screen.findByLabelText("Gateway token") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "replacement-token-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to save settings",
      { description: "credential write failed" },
    ));
    expect(input.value).toBe("replacement-token-123456");
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);
    console.error = originalConsoleError;
  });

  test("does not let a remote client change the desktop web access lifecycle", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    const input = await screen.findByLabelText("Gateway token") as HTMLInputElement;

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

  test("shows a disabled lifecycle toggle in a remote browser", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    await screen.findByText("Running");

    expect(screen.getByLabelText("Gateway token")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Allow web access" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mockSetWebClientEnabled).not.toHaveBeenCalled();
  });

  test("uses a normal browser link for the active remote gateway", async () => {
    render(<GlobalSettings activeSection="web-client" />);
    const link = await screen.findByRole("link", { name: /100\.88\.12\.3/ }) as HTMLAnchorElement;

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

  test("preserves max and ultra Codex preferences when saving unrelated settings", async () => {
    for (const effort of ["max", "ultra"] as const) {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            codexModel: "gpt-5.6-sol",
            codexReasoningEffort: effort,
            codexNativeFastModeDefault: false,
          },
        },
      }));
      const { unmount } = render(<GlobalSettings activeSection="codex" />);

      fireEvent.click(screen.getByRole("switch", { name: "Codex fast mode for new native tabs" }));
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

      await waitFor(() => {
        expect(mockUpdateGlobalConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({
            codexModel: "gpt-5.6-sol",
            codexReasoningEffort: effort,
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
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Test DNS" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(domains, { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Test DNS" }));
    await waitFor(() => expect(mockTestDomainResolution).toHaveBeenCalledWith(["example.com"]));

    fireEvent.click(screen.getAllByRole("button", { name: "Reset" }).at(-1)!);
    expect(domains.value).toBe("");
    expect(screen.queryByText(/Invalid domain format/)).toBeNull();
  });

  test("clears terminal color validation errors when changes are reset", () => {
    const { container } = render(<GlobalSettings activeSection="terminal" />);
    const colorTextInput = container.querySelector('input[type="text"][value="#000000"]') as HTMLInputElement;

    fireEvent.change(colorTextInput, { target: { value: "invalid" } });
    expect(screen.getByText("Invalid hex color format. Use #RGB or #RRGGBB.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "Reset" }).at(-1)!);
    expect(colorTextInput.value).toBe("#000000");
    expect(screen.queryByText("Invalid hex color format. Use #RGB or #RRGGBB.")).toBeNull();
  });

  test("propagates changed GitHub credentials without failing a saved config", async () => {
    mockPropagateGithubTokenToContainers.mockResolvedValueOnce({ updated: ["container-1"] });
    render(<GlobalSettings activeSection="general" />);

    fireEvent.change(screen.getByPlaceholderText("ghp_..."), { target: { value: "new-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockPropagateGithubTokenToContainers).toHaveBeenCalledWith("new-token"));
    expect(mockToastSuccess).toHaveBeenCalledWith("Updated GitHub token in 1 container(s)");
  });

  test("keeps the config saved when GitHub credential propagation fails", async () => {
    mockPropagateGithubTokenToContainers.mockRejectedValueOnce(new Error("container unavailable"));
    render(<GlobalSettings activeSection="general" />);

    fireEvent.change(screen.getByPlaceholderText("ghp_..."), { target: { value: "new-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockPropagateGithubTokenToContainers).toHaveBeenCalledTimes(1));
    expect(mockToastSuccess).toHaveBeenCalledWith("Settings saved");
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("reports persistence failures and leaves Save available for retry", async () => {
    mockUpdateGlobalConfig.mockRejectedValueOnce(new Error("disk full"));
    render(<GlobalSettings activeSection="codex" />);

    fireEvent.click(screen.getByRole("switch", { name: "Codex fast mode for new native tabs" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to save settings",
      { description: "disk full" },
    ));
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false);
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
