import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import type { ActionDefaults } from "../../../packages/protocol/src/action-defaults";

const mockUpdateGlobalConfig = mock(async (globalConfig: unknown) => ({
  version: "1.0",
  global: globalConfig,
  repositories: {},
}));
const mockGetLogDirectory = mock(async () => null);
const actualBackend = await import("../../../apps/web/src/lib/backend");

mock.module("@/lib/backend", () => ({
  ...actualBackend,
  updateGlobalConfig: mockUpdateGlobalConfig,
  getLogDirectory: mockGetLogDirectory,
}));

const { GlobalSettings } = await import("../../../apps/web/src/components/settings/GlobalSettings");

function savedActionDefaults(): ActionDefaults {
  const call = mockUpdateGlobalConfig.mock.calls.at(-1)?.[0] as
    | { agentSettings?: { actionDefaults?: ActionDefaults } }
    | undefined;
  return call?.agentSettings?.actionDefaults ?? {};
}

function openPicker(action: string) {
  fireEvent.pointerDown(
    screen.getByRole("combobox", { name: `${action} default agent, model and reasoning` }),
  );
}

describe("GlobalSettings defaults section", () => {
  beforeEach(() => {
    cleanup();
    mockUpdateGlobalConfig.mockClear();
    mockGetLogDirectory.mockClear();
    window.orkestratorGateway = { enabled: true };

    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          enabledAgentPlatforms: ["claude", "codex"],
          agentSettings: {
            defaultAgent: "claude",
            platforms: {
              claude: { mode: "terminal", model: "claude-sonnet-5", claudeNativeBackend: "sdk" },
              codex: { mode: "native", model: "gpt-5.4", reasoningEffort: "medium" },
              opencode: { mode: "terminal", model: "opencode/grok-code" },
            },
          },
          codexMaxConcurrentThreads: 5,
          terminalAppearance: {
            fontFamily: "Fira Code",
            fontSize: 14,
            backgroundColor: "#000000",
          },
          terminalScrollback: 5000,
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

  test("offers a picker per action, all on the app default until configured", () => {
    render(<GlobalSettings activeSection="defaults" />);

    for (const action of [
      "New environments",
      "Review",
      "Review 2",
      "Fix review issues",
      "PR",
      "Resolve",
      "Push",
    ]) {
      const picker = screen.getByRole("combobox", {
        name: `${action} default agent, model and reasoning`,
      });
      expect(picker.textContent).toContain("App default");
    }
  });

  test("saves the chosen platform and model for an action", async () => {
    render(<GlobalSettings activeSection="defaults" />);

    openPicker("Review");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Haiku/ }));

    expect(
      screen.getByRole("combobox", { name: "Review default agent, model and reasoning" })
        .textContent,
    ).toContain("Haiku");

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1));
    expect(savedActionDefaults()).toEqual({
      review: { platform: "claude", model: "haiku" },
    });
  });

  test("edits and clears the new Multi Review defaults independently", async () => {
    render(<GlobalSettings activeSection="defaults" />);

    openPicker("Review 2");
    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^gpt-5\.4/ }));
    openPicker("Fix review issues");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Haiku/ }));

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(savedActionDefaults()).toEqual({
        review2: { platform: "codex", model: "gpt-5.4" },
        fixReviewIssues: { platform: "claude", model: "haiku" },
      }),
    );

    mockUpdateGlobalConfig.mockClear();
    const review2Picker = screen.getByRole("combobox", {
      name: "Review 2 default agent, model and reasoning",
    });
    fireEvent.click(within(review2Picker.parentElement!).getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(savedActionDefaults()).toEqual({
        fixReviewIssues: { platform: "claude", model: "haiku" },
      }),
    );
  });

  test("switching provider on the rail drops the previous provider's model", async () => {
    render(<GlobalSettings activeSection="defaults" />);

    openPicker("PR");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Haiku/ }));
    openPicker("PR");
    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    fireEvent.keyDown(document.body, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1));
    // Claude's `haiku` is meaningless to Codex, so the platform switch must
    // fall back to Codex's own default model rather than carry it across.
    expect(savedActionDefaults()).toEqual({ pr: { platform: "codex" } });
  });

  test("uses unsaved platform changes when configuring defaults before one combined save", async () => {
    const view = render(<GlobalSettings activeSection="platforms" />);

    // Platform changes live in GlobalSettings until the shared Save button is
    // pressed. The Defaults pane must consume that same draft rather than the
    // older config-store snapshot.
    fireEvent.click(screen.getByRole("switch", { name: "Claude Code" }));
    view.rerender(<GlobalSettings activeSection="defaults" />);

    openPicker("Review");
    expect(screen.queryByRole("button", { name: "claude models" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: "codex models" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^gpt-5\.4/ }));

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          enabledAgentPlatforms: ["codex"],
          agentSettings: expect.objectContaining({
            defaultAgent: "codex",
            actionDefaults: { review: { platform: "codex", model: "gpt-5.4" } },
          }),
        }),
      ),
    );
  });

  test("clears a configured default back to the app default", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          agentSettings: {
            ...state.config.global.agentSettings,
            actionDefaults: { push: { platform: "codex", model: "gpt-5.4" } },
          },
        },
      },
    }));
    render(<GlobalSettings activeSection="defaults" />);

    const picker = screen.getByRole("combobox", {
      name: "Push default agent, model and reasoning",
    });
    expect(picker.textContent).not.toContain("App default");

    fireEvent.click(within(picker.parentElement!).getByRole("button", { name: "Clear" }));
    expect(
      screen.getByRole("combobox", { name: "Push default agent, model and reasoning" }).textContent,
    ).toContain("App default");

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1));
    expect(savedActionDefaults()).toEqual({});
  });

  test("keeps unsaved edits when the picker's favorite star writes to the store", async () => {
    render(<GlobalSettings activeSection="defaults" />);

    openPicker("Review");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Haiku/ }));

    // The star persists `favoriteModels` optimistically, replacing
    // `config.global` while this form is dirty. The form must not treat that
    // as a reload and reset the selection the user just made.
    openPicker("Review");
    fireEvent.click(screen.getByRole("button", { name: /^Add Haiku.* to favorites$/ }));
    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalled());
    expect(
      screen.getByRole("combobox", { name: "Review default agent, model and reasoning" })
        .textContent,
    ).toContain("Haiku");

    const saveButton = screen.getByRole("button", { name: "Save Changes" });
    expect(saveButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(savedActionDefaults()).toEqual({
        review: { platform: "claude", model: "haiku" },
      }),
    );
  });

  test("re-syncs the form when the stored defaults actually change", async () => {
    render(<GlobalSettings activeSection="defaults" />);

    openPicker("Review");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Haiku/ }));

    // The other half of the guard above: a write that does change a value this
    // form owns is a genuine reload and must win over the local edit, or the
    // form would keep showing state the backend has already replaced.
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          agentSettings: {
            ...state.config.global.agentSettings,
            actionDefaults: { review: { platform: "codex", model: "gpt-5.4" } },
          },
        },
      },
    }));

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Review default agent, model and reasoning" })
          .textContent,
      ).toContain("gpt-5.4"),
    );
  });

  test("sets and clears an action's reasoning level", async () => {
    render(<GlobalSettings activeSection="defaults" />);

    // The picker opens on the app default platform, so reach Codex's catalog
    // through the rail before choosing one of its models.
    openPicker("Resolve");
    fireEvent.click(screen.getByRole("button", { name: "codex models" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^gpt-5\.4/ }));
    openPicker("Resolve");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(savedActionDefaults()).toEqual({
        resolve: { platform: "codex", model: "gpt-5.4", reasoningEffort: "high" },
      }),
    );

    // Back to "Default" means the model's own level, which is an absent value
    // rather than a stored "default" string.
    mockUpdateGlobalConfig.mockClear();
    openPicker("Resolve");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Default" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() =>
      expect(savedActionDefaults()).toEqual({
        resolve: { platform: "codex", model: "gpt-5.4" },
      }),
    );
  });

  test("warns about a saved model the current catalog no longer lists", () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          agentSettings: {
            ...state.config.global.agentSettings,
            actionDefaults: { review: { platform: "claude", model: "retired-model" } },
          },
        },
      },
    }));
    render(<GlobalSettings activeSection="defaults" />);

    // The value is kept and sent as-is rather than quietly rewritten, so the
    // pane has to say why it is not showing a catalog entry.
    expect(screen.getByText(/retired-model is not in the current catalog/)).toBeTruthy();
  });

  test("never offers OpenCode's placeholder model as a durable default", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          enabledAgentPlatforms: ["claude", "codex", "opencode"],
        },
      },
    }));
    render(<GlobalSettings activeSection="defaults" />);

    openPicker("Push");
    fireEvent.click(screen.getByRole("button", { name: "opencode models" }));

    // With no cached OpenCode catalog the builder synthesises a single
    // `default` entry. No OpenCode server knows that id, so the pane must not
    // offer it; selecting the platform alone already means its own default.
    expect(screen.queryByRole("menuitemradio", { name: /^Default/ }) === null).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() =>
      expect(savedActionDefaults()).toEqual({
        push: { platform: "opencode" },
      }),
    );
  });

  test("carries saved defaults through a save made from another section", async () => {
    const stored: ActionDefaults = { review: { platform: "codex", reasoningEffort: "xhigh" } };
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          agentSettings: { ...state.config.global.agentSettings, actionDefaults: stored },
        },
      },
    }));
    render(<GlobalSettings activeSection="review" />);

    // `update_global_config` replaces the stored global wholesale, so a save
    // from an unrelated pane must resend these or it silently deletes them.
    fireEvent.change(screen.getByLabelText("Review instruction"), {
      target: { value: "Focus on release blockers." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1));
    expect(savedActionDefaults()).toEqual(stored);
  });
});
