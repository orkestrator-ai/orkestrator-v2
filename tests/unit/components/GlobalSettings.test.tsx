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
const mockTestDomainResolution = mock(async () => []);
const mockToastSuccess = mock(() => {});
const mockToastError = mock(() => {});
const actualBackend = await import("../../../src/lib/backend");

mock.module("@/lib/backend", () => ({
  ...actualBackend,
  updateGlobalConfig: mockUpdateGlobalConfig,
  getLogDirectory: mockGetLogDirectory,
  propagateGithubTokenToContainers: mockPropagateGithubTokenToContainers,
  testDomainResolution: mockTestDomainResolution,
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
    mockTestDomainResolution.mockClear();
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
