import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the component under test
// ---------------------------------------------------------------------------

let mockSection = "agent";
let nextDialogResult: string | null = null;
let dialogError: Error | null = null;
let updateRepositoryConfigImpl = (_projectId: string, repoConfig: unknown) =>
  Promise.resolve({
    version: "1.0",
    global: makeConfig().global,
    repositories: { "project-1": repoConfig as Record<string, unknown> },
  });

const mockUpdateRepositoryConfig = mock((projectId: string, repoConfig: unknown) =>
  updateRepositoryConfigImpl(projectId, repoConfig)
);
const mockUpdateProject = mock(async (project: unknown) => project);
const mockOpenDialog = mock(async () => {
  if (dialogError) {
    throw dialogError;
  }
  return nextDialogResult;
});
const mockToastSuccess = mock(() => {});
const mockToastError = mock(() => {});

mock.module("@/lib/tauri", () => ({
  updateRepositoryConfig: mockUpdateRepositoryConfig,
  updateProject: mockUpdateProject,
}));

mock.module("@/lib/native/dialog", () => ({
  open: mockOpenDialog,
}));

mock.module("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

mock.module("@/components/settings/FullscreenSettingsLayout", () => ({
  FullscreenSettingsLayout: ({
    open,
    children,
    footer,
  }: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    title: string;
    menuItems: unknown[];
    children: (section: string) => React.ReactNode;
    footer?: React.ReactNode;
    defaultSection?: string;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="settings-layout">
        <div data-testid="settings-content">{children(mockSection)}</div>
        {footer && <div data-testid="settings-footer">{footer}</div>}
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
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <option value={value}>{children}</option>,
  SelectTrigger: ({
    children,
  }: {
    children: React.ReactNode;
    id?: string;
    className?: string;
  }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => placeholder ? <option value="">{placeholder}</option> : null,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { CODEX_MODELS } from "@/lib/codex-client";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useConfigStore } from "@/stores/configStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { RepositorySettings } from "../../../src/components/settings/RepositorySettings";
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
  useOpenCodeStore.setState({ models: new Map() });
  useCodexStore.setState({ models: CODEX_MODELS });
}

function renderSettings({
  project,
  config,
  section = "agent",
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
      />
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
    mockSection = "agent";
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
    mockOpenDialog.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();

    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  describe("agent section", () => {
    test("renders accessible agent tiles and keeps app default selected by default", () => {
      renderSettings();

      expect(screen.getByText("Agent Style")).toBeTruthy();

      const group = getAgentGroup();
      expect(within(group).getByRole("radio", { name: "Use App Default (Claude)" }).getAttribute("aria-checked")).toBe("true");
      expect(within(group).getByRole("radio", { name: "Claude" })).toBeTruthy();
      expect(within(group).getByRole("radio", { name: "OpenCode" })).toBeTruthy();
      expect(within(group).getByRole("radio", { name: "Codex" })).toBeTruthy();

      const [styleSelect] = getMockSelects();
      expect(styleSelect.value).toBe("__app_default__");
    });

    test("shows the project override and keeps the app-default tile label tied to the global default", () => {
      const { container } = renderSettings({
        config: {
          global: { defaultAgent: "claude" } as AppConfig["global"],
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              defaultAgent: "opencode",
            },
          },
        },
      });

      expect(getAgentRadio("Use App Default (Claude)")).toBeTruthy();
      expect(getAgentRadio("OpenCode").getAttribute("aria-checked")).toBe("true");
      expect(container.querySelector("span.text-xs.text-muted-foreground.bg-zinc-800")?.textContent).toBe("OpenCode");
    });

    test("clicking an agent tile updates the effective badge and clears model and effort on save", async () => {
      const { container } = renderSettings({
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              defaultModel: "claude-sonnet-4-6",
              defaultEffort: "high",
            },
          },
        },
      });

      fireEvent.click(getAgentRadio("OpenCode"));
      expect(container.querySelector("span.text-xs.text-muted-foreground.bg-zinc-800")?.textContent).toBe("OpenCode");

      fireEvent.click(getSaveButton());

      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));

      const savedConfig = getSavedConfig();
      expect(savedConfig.defaultAgent).toBe("opencode");
      expect(savedConfig.defaultModel).toBeUndefined();
      expect(savedConfig.defaultEffort).toBeUndefined();
    });

    test("saves explicit agent and style overrides", async () => {
      renderSettings();

      fireEvent.click(getAgentRadio("OpenCode"));

      const [styleSelect] = getMockSelects();
      fireEvent.change(styleSelect, { target: { value: "native" } });
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));

      const savedConfig = getSavedConfig();
      expect(savedConfig.defaultAgent).toBe("opencode");
      expect(savedConfig.agentStyle).toBe("native");
    });

    test("omits agent and style overrides when reset to app default", async () => {
      renderSettings({
        config: {
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              defaultAgent: "opencode",
              agentStyle: "native",
            },
          },
        },
      });

      fireEvent.click(getAgentRadio(/^Use App Default/));

      const [styleSelect] = getMockSelects();
      fireEvent.change(styleSelect, { target: { value: "__app_default__" } });
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));

      const savedConfig = getSavedConfig();
      expect(savedConfig.defaultAgent).toBeUndefined();
      expect(savedConfig.agentStyle).toBeUndefined();
    });

    test("uses OpenCode model variants when the effective agent is OpenCode", () => {
      renderSettings({
        config: {
          global: { defaultAgent: "opencode" } as AppConfig["global"],
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              defaultAgent: "opencode",
              defaultModel: "openai/gpt-5",
            },
          },
        },
        prepareStores: () => {
          useOpenCodeStore.setState({
            models: new Map([
              [
                "env-1",
                [
                  {
                    id: "openai/gpt-5",
                    name: "GPT-5",
                    provider: "openai",
                    variants: ["low", "high", "xhigh"],
                  },
                ],
              ],
            ]),
          });
        },
      });

      const selects = getMockSelects();
      // Order: [agentStyle, claudeNativeBackend, defaultModel, defaultEffort]
      const effortSelect = selects[3]!;
      const values = Array.from(effortSelect.querySelectorAll("option")).map((option) => option.value);

      expect(values).toContain("low");
      expect(values).toContain("high");
      expect(values).toContain("xhigh");
    });

    test("shows a no-models hint when the effective agent has no available models", () => {
      renderSettings({
        config: {
          global: { defaultAgent: "opencode" } as AppConfig["global"],
          repositories: {
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "main",
              defaultAgent: "opencode",
            },
          },
        },
      });

      expect(screen.getByText("Start an environment to load available models")).toBeTruthy();
    });
  });

  describe("general section", () => {
    test("validates project name and disables save when it is empty", () => {
      renderSettings({ section: "general" });

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });

      expect(screen.getByText("Name cannot be empty")).toBeTruthy();
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(true);
    });

    test("browsing updates the local path field", async () => {
      nextDialogResult = "/Users/test/repo";
      renderSettings({ section: "general" });

      const contentButtons = within(getSettingsContent()).getAllByRole("button");
      fireEvent.click(contentButtons[1]!);

      await waitFor(() => expect(mockOpenDialog).toHaveBeenCalledTimes(1));
      expect((screen.getByLabelText("Local Path") as HTMLInputElement).value).toBe("/Users/test/repo");
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
        })
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

    test("preserves the last environment type when saving repository settings", async () => {
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

      expect(getSavedConfig().lastEnvironmentType).toBe("local");
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
              defaultPortMappings: [
                { containerPort: 3000, hostPort: 3001, protocol: "tcp" },
              ],
            },
          },
        },
      });

      fireEvent.change(screen.getByLabelText("Container Entry Port"), { target: { value: "8080" } });
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

    test("omits an out-of-range entry port on save", async () => {
      renderSettings({ section: "ports" });

      fireEvent.change(screen.getByLabelText("Container Entry Port"), { target: { value: "70000" } });
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
        expect((within(getSettingsContent()).getByRole("textbox") as HTMLInputElement).value).toBe("config/.env")
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
          })
        )
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
          expect.objectContaining({ description: "save failed" })
        )
      );
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
