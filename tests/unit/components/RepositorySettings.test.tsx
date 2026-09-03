import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as realSelect from "@/components/ui/select";
import { mockToastError, mockToastSuccess } from "../../mocks/sonner";
import type { OpenCodeModelCatalogSnapshot } from "@/lib/backend";

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the component under test
// ---------------------------------------------------------------------------

let mockSection = "defaults";
let nextDialogResult: string | null = null;
let dialogError: Error | null = null;
let updateRepositoryConfigImpl = (_projectId: string, repoConfig: unknown) =>
  Promise.resolve({
    version: "1.0",
    global: makeConfig().global,
    repositories: { "project-1": repoConfig as Record<string, unknown> },
  });

const mockUpdateRepositoryConfig = mock((projectId: string, repoConfig: unknown) =>
  updateRepositoryConfigImpl(projectId, repoConfig),
);
const mockUpdateProject = mock(async (project: unknown) => project);
const mockGetCachedOpenCodeModelCatalog = mock(
  async (_projectId: string): Promise<OpenCodeModelCatalogSnapshot | null> => null,
);
const mockOpenDialog = mock(async () => {
  if (dialogError) {
    throw dialogError;
  }
  return nextDialogResult;
});
const realSelectSnapshot = { ...realSelect };

mock.module("@/lib/backend", () => ({
  updateRepositoryConfig: mockUpdateRepositoryConfig,
  updateProject: mockUpdateProject,
  getCachedOpenCodeModelCatalog: mockGetCachedOpenCodeModelCatalog,
}));

mock.module("@/lib/native/dialog", () => ({
  open: mockOpenDialog,
}));

mock.module("@/components/settings/FullscreenSettingsLayout", () => ({
  FullscreenSettingsLayout: ({
    open,
    children,
    headerActions,
  }: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    title: string;
    menuItems: unknown[];
    children: (section: string) => React.ReactNode;
    headerActions?: React.ReactNode;
    defaultSection?: string;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="settings-layout">
        <div data-testid="settings-content">{children(mockSection)}</div>
        {headerActions && <div data-testid="settings-header-actions">{headerActions}</div>}
      </div>
    );
  },
}));

mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children: React.ReactNode;
    variant?: string;
    size?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

mock.module("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

mock.module("@/components/ui/label", () => ({
  Label: ({
    children,
    ...props
  }: React.LabelHTMLAttributes<HTMLLabelElement> & { children: React.ReactNode }) => (
    <label {...props}>{children}</label>
  ),
}));

mock.module("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
  }) => (
    <select
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
      disabled={disabled}
      data-testid="mock-select"
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode; id?: string; className?: string }) => (
    <>{children}</>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) =>
    placeholder ? <option value="">{placeholder}</option> : null,
}));

afterAll(() => {
  mock.module("@/components/ui/select", () => realSelectSnapshot);
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { CODEX_MODELS } from "@/lib/codex-client";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useConfigStore } from "@/stores/configStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { RepositorySettings } from "../../../apps/web/src/components/settings/RepositorySettings";
import type { AppConfig, Project } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "test-repo",
    gitUrl: "git@github.com:test/repo.git",
    localPath: null,
    addedAt: new Date().toISOString(),
    order: 0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    version: "1.0",
    global: {
      containerResources: { cpuCores: 2, memoryGb: 4 },
      envFilePatterns: [".env"],
      allowedDomains: [],
      defaultAgent: "claude",
      opencodeModel: "opencode/grok-code",
      codexModel: "gpt-5.3-codex",
      codexReasoningEffort: "medium",
      opencodeMode: "terminal",
      claudeMode: "terminal",
      terminalAppearance: {
        fontFamily: "monospace",
        fontSize: 14,
        backgroundColor: "#000000",
      },
      terminalScrollback: 5000,
      ...overrides.global,
    },
    repositories: overrides.repositories ?? {},
  };
}

function resetStores(config = makeConfig()) {
  useConfigStore.setState({
    config,
    isLoading: false,
    error: null,
  });
  useClaudeStore.setState({ models: [] });
  useOpenCodeStore.setState({ models: new Map(), modelSource: new Map() });
  useCodexStore.setState({ models: CODEX_MODELS });
  useAgentModelCatalogStore.setState({ cursorModels: [], grokModels: [] });
}

function renderSettings({
  project,
  config,
  section = "defaults",
  onOpenChange,
  onUpdateProject,
  prepareStores,
}: {
  project?: Partial<Project>;
  config?: Partial<AppConfig>;
  section?: string;
  onOpenChange?: (open: boolean) => void;
  onUpdateProject?: (project: Project) => Promise<Project | void>;
  prepareStores?: () => void;
} = {}) {
  mockSection = section;
  const resolvedProject = makeProject(project);
  const resolvedConfig = makeConfig(config);
  resetStores(resolvedConfig);
  prepareStores?.();

  const handleOpenChange = onOpenChange ?? mock(() => {});

  return {
    ...render(
      <RepositorySettings
        project={resolvedProject}
        open={true}
        onOpenChange={handleOpenChange}
        onUpdateProject={onUpdateProject}
      />,
    ),
    project: resolvedProject,
    onOpenChange: handleOpenChange,
  };
}

function getSettingsContent() {
  return screen.getByTestId("settings-content");
}

function getSaveButton() {
  return screen.getByRole("button", { name: "Save" });
}

function getCancelButton() {
  return screen.getByRole("button", { name: "Cancel" });
}

function getMockSelects() {
  return screen.getAllByTestId("mock-select") as HTMLSelectElement[];
}

function getAgentGroup() {
  return screen.getByRole("radiogroup", { name: "Default Agent" });
}

function getAgentRadio(name: string | RegExp) {
  return within(getAgentGroup()).getByRole("radio", { name });
}

function getSavedConfig() {
  return mockUpdateRepositoryConfig.mock.calls[0]?.[1] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RepositorySettings", () => {
  beforeEach(() => {
    mockSection = "defaults";
    nextDialogResult = null;
    dialogError = null;
    updateRepositoryConfigImpl = (_projectId: string, repoConfig: unknown) =>
      Promise.resolve({
        version: "1.0",
        global: makeConfig().global,
        repositories: { "project-1": repoConfig as Record<string, unknown> },
      });

    mockUpdateRepositoryConfig.mockClear();
    mockUpdateProject.mockClear();
    mockGetCachedOpenCodeModelCatalog.mockReset();
    mockGetCachedOpenCodeModelCatalog.mockImplementation(async () => null);
    mockOpenDialog.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();

    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  describe("agent settings", () => {
    test("every control starts on Inherit", () => {
      renderSettings({ section: "defaults" });

      const agents = screen.getByRole("radiogroup", { name: "Default agent" });
      expect(
        within(agents)
          .getByRole("radio", { name: /^Inherit/ })
          .getAttribute("aria-checked"),
      ).toBe("true");
      // The inherit label names the value *and* where it comes from, so a
      // deliberate app choice is distinguishable from a shipped default.
      expect(within(agents).getByRole("radio", { name: /^Inherit/ }).textContent).toContain(
        "Claude Code",
      );
    });

    test("saves a default agent override", async () => {
      renderSettings({ section: "defaults" });

      fireEvent.click(
        within(screen.getByRole("radiogroup", { name: "Default agent" })).getByRole("radio", {
          name: "Codex",
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(mockUpdateRepositoryConfig).toHaveBeenCalledWith(
          "project-1",
          expect.objectContaining({
            agentSettings: expect.objectContaining({ defaultAgent: "codex" }),
          }),
        ),
      );
    });

    test("saves a per-platform mode without moving the other platforms", async () => {
      // The repository used to store one `agentStyle` that Claude alone read
      // while the UI implied it covered every agent.
      renderSettings({ section: "codex" });

      fireEvent.click(
        within(screen.getByRole("radiogroup", { name: "Codex mode" })).getByRole("radio", {
          name: /^Terminal/,
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        const saved = mockUpdateRepositoryConfig.mock.calls.at(-1)?.[1] as {
          agentSettings?: { platforms?: Record<string, unknown> };
        };
        expect(saved.agentSettings?.platforms).toEqual({ codex: { mode: "terminal" } });
      });
    });

    test("allows a reasoning override while the model remains inherited", async () => {
      renderSettings({
        section: "claude",
        config: {
          global: {
            ...makeConfig().global,
            agentSettings: {
              defaultAgent: "claude",
              // Configuration uses Claude's concrete id while the catalog uses
              // the `sonnet` alias. Inheritance must match through resolvedModel.
              platforms: { claude: { model: "claude-sonnet-5" } },
            },
          },
        },
      });

      fireEvent.pointerDown(screen.getByRole("combobox", { name: "Claude Code default model" }));
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        const saved = mockUpdateRepositoryConfig.mock.calls.at(-1)?.[1] as {
          agentSettings?: { platforms?: Record<string, unknown> };
        };
        expect(saved.agentSettings?.platforms).toEqual({ claude: { reasoningEffort: "high" } });
      });
    });

    test("allows the Defaults pane to override reasoning for its inherited model", async () => {
      renderSettings({
        section: "defaults",
        config: {
          global: {
            ...makeConfig().global,
            agentSettings: {
              defaultAgent: "codex",
              platforms: { codex: { model: "gpt-5.4" } },
            },
          },
        },
      });

      fireEvent.pointerDown(screen.getByRole("combobox", { name: "Default model and reasoning" }));
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        const saved = mockUpdateRepositoryConfig.mock.calls.at(-1)?.[1] as {
          agentSettings?: { platforms?: Record<string, unknown> };
        };
        expect(saved.agentSettings?.platforms).toEqual({ codex: { reasoningEffort: "high" } });
      });
    });

    test("omits the block entirely when nothing is overridden", async () => {
      renderSettings({ section: "defaults" });

      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(mockUpdateRepositoryConfig).toHaveBeenCalledWith(
          "project-1",
          expect.objectContaining({ agentSettings: {} }),
        ),
      );
    });
  });

  describe("general section", () => {
    test("validates project name and disables save when it is empty", () => {
      renderSettings({ section: "general" });

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });

      expect(screen.getByText("Name cannot be empty")).toBeTruthy();
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(true);
    });

    test("rejects project names longer than 100 characters", () => {
      renderSettings({ section: "general" });

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "x".repeat(101) } });

      expect(screen.getByText("Name cannot exceed 100 characters")).toBeTruthy();
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(true);
    });

    test("browsing updates the local path field", async () => {
      nextDialogResult = "/Users/test/repo";
      renderSettings({ section: "general" });

      const contentButtons = within(getSettingsContent()).getAllByRole("button");
      fireEvent.click(contentButtons[1]!);

      await waitFor(() => expect(mockOpenDialog).toHaveBeenCalledTimes(1));
      expect((screen.getByLabelText("Local Path") as HTMLInputElement).value).toBe(
        "/Users/test/repo",
      );
    });

    test("save trims changed project fields and calls onUpdateProject", async () => {
      const onUpdateProject = mock(async (project: Project) => project);
      renderSettings({
        section: "general",
        onUpdateProject,
      });

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  renamed repo  " } });
      fireEvent.change(screen.getByLabelText("Local Path"), { target: { value: "  /tmp/repo  " } });
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(onUpdateProject).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));

      expect(onUpdateProject.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          id: "project-1",
          name: "renamed repo",
          localPath: "/tmp/repo",
        }),
      );
    });

    test("cancel resets edits and closes the dialog", () => {
      const onOpenChange = mock(() => {});
      renderSettings({
        section: "general",
        onOpenChange,
      });

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "changed" } });
      fireEvent.change(screen.getByLabelText("Local Path"), { target: { value: "/tmp/changed" } });
      fireEvent.click(getCancelButton());

      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("test-repo");
      expect((screen.getByLabelText("Local Path") as HTMLInputElement).value).toBe("");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe("branches section", () => {
    test("saves default branch and PR base branch changes", async () => {
      renderSettings({ section: "branches" });

      fireEvent.change(screen.getByLabelText("Default Branch"), { target: { value: "develop" } });
      fireEvent.change(screen.getByLabelText("PR Base Branch"), { target: { value: "release" } });
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));

      const savedConfig = getSavedConfig();
      expect(savedConfig.defaultBranch).toBe("develop");
      expect(savedConfig.prBaseBranch).toBe("release");
    });

    test("uses the authoritative response to preserve backend-owned environment state", async () => {
      updateRepositoryConfigImpl = (_projectId: string, repoConfig: unknown) =>
        Promise.resolve({
          version: "1.0",
          global: makeConfig().global,
          repositories: {
            "project-1": {
              ...(repoConfig as Record<string, unknown>),
              lastEnvironmentType: "local",
            },
          },
        });
      renderSettings({
        section: "branches",
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              lastEnvironmentType: "local",
            },
          },
        },
      });

      fireEvent.change(screen.getByLabelText("Default Branch"), { target: { value: "develop" } });
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));

      expect(getSavedConfig().lastEnvironmentType).toBeUndefined();
      await waitFor(() => {
        expect(
          useConfigStore.getState().config.repositories["project-1"]?.lastEnvironmentType,
        ).toBe("local");
      });
    });
  });

  describe("ports section", () => {
    test("saves entry port and additional port mapping edits", async () => {
      renderSettings({
        section: "ports",
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              entryPort: 3000,
              defaultPortMappings: [{ containerPort: 3000, hostPort: 3001, protocol: "tcp" }],
            },
          },
        },
      });

      fireEvent.change(screen.getByLabelText("Container Entry Port"), {
        target: { value: "8080" },
      });
      fireEvent.change(screen.getByPlaceholderText("Host"), { target: { value: "4000" } });
      fireEvent.change(getMockSelects()[0]!, { target: { value: "udp" } });
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));

      const savedConfig = getSavedConfig();
      expect(savedConfig.entryPort).toBe(8080);
      expect(savedConfig.defaultPortMappings).toEqual([
        { containerPort: 3000, hostPort: 4000, protocol: "udp" },
      ]);
    });

    test("disables save when host ports are duplicated", () => {
      renderSettings({
        section: "ports",
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              defaultPortMappings: [
                { containerPort: 3000, hostPort: 4000, protocol: "tcp" },
                { containerPort: 3001, hostPort: 4000, protocol: "tcp" },
              ],
            },
          },
        },
      });

      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(true);
    });

    test("disables save when a container port is outside the valid range", () => {
      renderSettings({
        section: "ports",
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              defaultPortMappings: [{ containerPort: 0, hostPort: 4000, protocol: "tcp" }],
            },
          },
        },
      });

      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(true);
    });

    test("omits an out-of-range entry port on save", async () => {
      renderSettings({ section: "ports" });

      fireEvent.change(screen.getByLabelText("Container Entry Port"), {
        target: { value: "70000" },
      });
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));
      expect(getSavedConfig().entryPort).toBeUndefined();
    });
  });

  describe("files section", () => {
    test("adds a file row and saves cleaned file paths", async () => {
      renderSettings({ section: "files" });

      fireEvent.click(within(getSettingsContent()).getByRole("button", { name: /add file/i }));

      const inputs = within(getSettingsContent()).getAllByRole("textbox");
      fireEvent.change(inputs[0]!, { target: { value: "config/settings.json" } });
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));
      expect(getSavedConfig().filesToCopy).toEqual(["config/settings.json"]);
    });

    test("disables save for invalid file paths", () => {
      renderSettings({
        section: "files",
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              filesToCopy: ["/etc/passwd"],
            },
          },
        },
      });

      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(true);
    });

    test("rejects duplicate file paths case-insensitively", () => {
      renderSettings({
        section: "files",
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              filesToCopy: ["Config/.env", "config/.ENV"],
            },
          },
        },
      });

      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(true);
    });

    test("disables file browsing until a local path is configured", () => {
      renderSettings({
        section: "files",
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              filesToCopy: [""],
            },
          },
        },
      });

      expect(
        (within(getSettingsContent()).getByTitle("Set local path first") as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });

    test("browse file converts an absolute path under the repo to a relative path", async () => {
      nextDialogResult = "/repo/config/.env";
      renderSettings({
        section: "files",
        project: { localPath: "/repo" },
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              filesToCopy: [""],
            },
          },
        },
      });

      const contentButtons = within(getSettingsContent()).getAllByRole("button");
      fireEvent.click(contentButtons[0]!);

      await waitFor(() =>
        expect((within(getSettingsContent()).getByRole("textbox") as HTMLInputElement).value).toBe(
          "config/.env",
        ),
      );
    });

    test("browse file outside the repo shows an error toast", async () => {
      nextDialogResult = "/other/config/.env";
      renderSettings({
        section: "files",
        project: { localPath: "/repo" },
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              filesToCopy: [""],
            },
          },
        },
      });

      const contentButtons = within(getSettingsContent()).getAllByRole("button");
      fireEvent.click(contentButtons[0]!);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          "Invalid file location",
          expect.objectContaining({
            description: "The file must be inside the project's local path.",
          }),
        ),
      );
    });
  });

  describe("save errors", () => {
    test("shows an error toast and re-enables save when persistence fails", async () => {
      updateRepositoryConfigImpl = async () => {
        throw new Error("save failed");
      };

      renderSettings({ section: "branches" });
      fireEvent.click(getSaveButton());

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          "Failed to save settings",
          expect.objectContaining({ description: "save failed" }),
        ),
      );
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
