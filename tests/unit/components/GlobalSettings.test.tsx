import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { mockWriteText } from "../../mocks/clipboard";
import { REVIEW_PROMPT_MAX_LENGTH } from "../../../packages/protocol/src/review-prompt";
import { mockToastError, mockToastSuccess } from "../../mocks/sonner";

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
  revealInFileManager: mockRevealInFileManager,
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
    mockRevealInFileManager.mockClear();
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
      resetAvailable: true,
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
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Failed to reset Tailscale Serve",
      { description: "Tailscale daemon unavailable" },
    ));
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

  test("reports clipboard failures for the web URL and gateway token", async () => {
    const originalConsoleError = console.error;
    console.error = mock(() => undefined);
    mockWriteText.mockRejectedValue(new Error("clipboard denied"));
    try {
      render(<GlobalSettings activeSection="web-client" />);
      await screen.findByText("Running");
      await screen.findByDisplayValue("gateway-token-123456");

      fireEvent.click(screen.getByRole("button", { name: "Copy web client URL" }));
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Failed to copy web client URL"));

      fireEvent.click(screen.getByRole("button", { name: "Copy gateway token" }));
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Failed to copy gateway token"));
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
    expect(screen.queryByRole("button", { name: "Reset Tailscale Serve" })).toBeNull();
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
    rerender(<GlobalSettings activeSection="review" />);
    expect(screen.getByText("Code review prompt")).toBeTruthy();
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

  test("saves a custom action-bar review prompt", async () => {
    render(<GlobalSettings activeSection="review" />);

    const prompt = screen.getByLabelText("Prompt template") as HTMLTextAreaElement;
    expect(prompt.value).toContain("{{targetBranch}}");

    fireEvent.change(prompt, {
      target: { value: "Review origin/{{targetBranch}}...HEAD for regressions." },
    });
    expect(screen.getByText("Custom")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewPrompt: "Review origin/{{targetBranch}}...HEAD for regressions.",
        }),
      );
    });
  });

  test("resets a saved custom review prompt to the built-in default", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, reviewPrompt: "Only review tests." },
      },
    }));
    render(<GlobalSettings activeSection="review" />);

    const prompt = screen.getByLabelText("Prompt template") as HTMLTextAreaElement;
    expect(prompt.value).toBe("Only review tests.");
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(prompt.value).toContain("Security and instruction hierarchy");
    expect(screen.getByText("Default")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1));
    const savedGlobal = mockUpdateGlobalConfig.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(savedGlobal, "reviewPrompt")).toBe(false);
  });

  test("does not allow an empty review prompt to be saved", async () => {
    render(<GlobalSettings activeSection="review" />);
    await waitFor(() => expect(mockGetLogDirectory).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Prompt template"), {
      target: { value: "   " },
    });

    expect(screen.getByText("Review prompt cannot be empty. Enter a prompt or reset to the default.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("falls back to the built-in prompt for malformed persisted values", () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, reviewPrompt: 123 as never },
      },
    }));

    render(<GlobalSettings activeSection="review" />);

    const prompt = screen.getByLabelText("Prompt template") as HTMLTextAreaElement;
    expect(prompt.value).toContain("Security and instruction hierarchy");
    expect(prompt.getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByText("Default")).toBeTruthy();
  });

  test("enforces the review prompt length boundary", async () => {
    render(<GlobalSettings activeSection="review" />);
    await waitFor(() => expect(mockGetLogDirectory).toHaveBeenCalled());
    const prompt = screen.getByLabelText("Prompt template") as HTMLTextAreaElement;

    expect(prompt.maxLength).toBe(REVIEW_PROMPT_MAX_LENGTH);
    fireEvent.change(prompt, {
      target: { value: "x".repeat(REVIEW_PROMPT_MAX_LENGTH + 1) },
    });

    expect(screen.getByText("Review prompt must be 100,000 characters or fewer.")).toBeTruthy();
    expect(prompt.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("reports custom prompts that do not use the target branch token", async () => {
    render(<GlobalSettings activeSection="review" />);
    await waitFor(() => expect(mockGetLogDirectory).toHaveBeenCalled());
    const prompt = screen.getByLabelText("Prompt template") as HTMLTextAreaElement;

    fireEvent.change(prompt, { target: { value: "Review the current diff." } });

    expect(screen.getByText("No dynamic target branch token")).toBeTruthy();
    expect(screen.getByText(`24 / ${REVIEW_PROMPT_MAX_LENGTH.toLocaleString()} characters`)).toBeTruthy();
  });

  test("saves non-default editor and agent selections", async () => {
    render(<GlobalSettings activeSection="general" />);

    fireEvent.click(screen.getByRole("button", { name: "Cursor" }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({ preferredEditor: "cursor", defaultAgent: "codex" }),
    ));
  });

  test("saves container CPU and memory slider changes", async () => {
    render(<GlobalSettings activeSection="container" />);
    const [cpuSlider, memorySlider] = screen.getAllByRole("slider");

    fireEvent.keyDown(cpuSlider!, { key: "ArrowRight" });
    fireEvent.keyDown(memorySlider!, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        containerResources: { cpuCores: 3, memoryGb: 5 },
      }),
    ));
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

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalAppearance: expect.objectContaining({
          fontFamily: "JetBrains Mono",
          fontSize: 15,
        }),
      }),
    ));
  });

  test("reveals and saves API credentials", async () => {
    const { rerender } = render(<GlobalSettings activeSection="claude" />);
    const anthropicInput = screen.getByPlaceholderText("sk-ant-...") as HTMLInputElement;
    expect(anthropicInput.type).toBe("password");
    fireEvent.click(anthropicInput.parentElement!.querySelector("button")!);
    expect(anthropicInput.type).toBe("text");
    fireEvent.change(anthropicInput, { target: { value: "test-anthropic-key" } });

    rerender(<GlobalSettings activeSection="general" />);
    const githubInput = screen.getByPlaceholderText("ghp_...") as HTMLInputElement;
    expect(githubInput.type).toBe("password");
    fireEvent.click(githubInput.parentElement!.querySelector("button")!);
    expect(githubInput.type).toBe("text");
    fireEvent.change(githubInput, { target: { value: "test-github-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        anthropicApiKey: "test-anthropic-key",
        githubToken: "test-github-token",
      }),
    ));
  });

  test("saves debug logging and opens its log directory", async () => {
    mockGetLogDirectory.mockResolvedValueOnce("/tmp/orkestrator-logs");
    render(<GlobalSettings activeSection="debug" />);

    fireEvent.click(screen.getByRole("button", { name: "Disabled" }));
    const logDirectory = await screen.findByRole("button", { name: "/tmp/orkestrator-logs" });
    fireEvent.click(logDirectory);
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(mockRevealInFileManager).toHaveBeenCalledWith("/tmp/orkestrator-logs");
    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({ debugLogging: true }),
    ));
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

    const colorTextInput = container.querySelector('input[type="text"][value="#000000"]') as HTMLInputElement;
    fireEvent.change(colorTextInput, { target: { value: "invalid" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reset" }).at(-1)!);

    expect(screen.getByText("1,000 lines")).toBeTruthy();
    expect(screen.queryByText("Invalid hex color format. Use #RGB or #RRGGBB.")).toBeNull();
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
    const colorTextInput = container.querySelector('input[type="text"][value="#000000"]') as HTMLInputElement;

    fireEvent.change(colorTextInput, { target: { value: "invalid" } });
    expect(screen.getByText("Invalid hex color format. Use #RGB or #RRGGBB.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(colorTextInput, { target: { value: "#123456" } });
    expect(screen.queryByText("Invalid hex color format. Use #RGB or #RRGGBB.")).toBeNull();
    fireEvent.change(colorTextInput, { target: { value: "invalid" } });

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
