import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    mockToastSuccess.mockClear();
    mockToastError.mockClear();

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
