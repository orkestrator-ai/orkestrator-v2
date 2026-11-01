import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as realProjectIconImage from "@/lib/project-icon-image";
const realProjectIconImageSnapshot = { ...realProjectIconImage };
import * as realSelect from "@/components/ui/select";
import { mockToastError, mockToastSuccess } from "../../mocks/sonner";
import type { HostImageFile } from "@/lib/backend/files-sessions";
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
const mockGetGitRemoteUrl = mock(async (_path: string): Promise<string | null> => null);
const mockGetCachedOpenCodeModelCatalog = mock(
  async (_projectId: string): Promise<OpenCodeModelCatalogSnapshot | null> => null,
);
const hostImage = (path: string): HostImageFile => ({
  path,
  name: path.split("/").pop()!,
  mimeType: "image/png",
  base64: "eA==",
});
const mockFindProjectIcons = mock(async (_root: string): Promise<string[]> => []);
const mockReadHostImageFile = mock(async (path: string) => hostImage(path));
const hostFile = new File(["png"], "logo.png", { type: "image/png" });
const mockFileFromHostImage = mock((_image: HostImageFile) => hostFile);
const mockOpenDialog = mock(async () => {
  if (dialogError) {
    throw dialogError;
  }
  return nextDialogResult;
});
const realSelectSnapshot = { ...realSelect };

mock.module("@/lib/backend", () => ({
  findProjectIcons: mockFindProjectIcons,
  readHostImageFile: mockReadHostImageFile,
  updateRepositoryConfig: mockUpdateRepositoryConfig,
  updateProject: mockUpdateProject,
  getGitRemoteUrl: mockGetGitRemoteUrl,
  getCachedOpenCodeModelCatalog: mockGetCachedOpenCodeModelCatalog,
}));

mock.module("@/lib/host-path-picker", () => ({
  pickHostPath: mockOpenDialog,
}));

const PICKED_ICON = "data:image/png;base64,iVBORw0KGgo=";
const mockProjectIconFromFile = mock(async (_file: File) => PICKED_ICON);
mock.module("@/lib/project-icon-image", () => ({
  PROJECT_ICON_FILE_ACCEPT: "image/*,.ico",
  projectIconFromFile: mockProjectIconFromFile,
  fileFromHostImage: mockFileFromHostImage,
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
  mock.module("@/lib/project-icon-image", () => realProjectIconImageSnapshot);
  mock.module("@/components/ui/select", () => realSelectSnapshot);
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { CODEX_MODELS } from "@/lib/codex-models";
import { useConfigStore } from "@/stores/configStore";
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
  useAgentModelCatalogStore.setState({
    claudeModels: [],
    codexModels: CODEX_MODELS,
    cursorModels: [],
    grokModels: [],
  });
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
    mockGetGitRemoteUrl.mockReset();
    mockGetGitRemoteUrl.mockImplementation(async () => null);
    mockGetCachedOpenCodeModelCatalog.mockReset();
    mockGetCachedOpenCodeModelCatalog.mockImplementation(async () => null);
    mockOpenDialog.mockClear();
    mockFindProjectIcons.mockReset();
    mockFindProjectIcons.mockImplementation(async () => []);
    mockReadHostImageFile.mockReset();
    mockReadHostImageFile.mockImplementation(async (path) => hostImage(path));
    mockFileFromHostImage.mockClear();
    mockProjectIconFromFile.mockReset();
    mockProjectIconFromFile.mockImplementation(async () => PICKED_ICON);
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
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
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
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
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

      fireEvent.click(
        within(getSettingsContent()).getByRole("button", { name: "Browse for local path" }),
      );

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

    test("the Git URL is editable and saved with the project", async () => {
      const onUpdateProject = mock(async (project: Project) => project);
      renderSettings({ section: "general", onUpdateProject });

      const gitUrlInput = screen.getByLabelText("Git URL") as HTMLInputElement;
      expect(gitUrlInput.value).toBe("git@github.com:test/repo.git");
      expect(gitUrlInput.readOnly).toBe(false);

      fireEvent.change(gitUrlInput, {
        target: { value: "  https://github.com/new-owner/repo.git  " },
      });
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(onUpdateProject).toHaveBeenCalledTimes(1));
      expect(onUpdateProject.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          id: "project-1",
          name: "test-repo",
          gitUrl: "https://github.com/new-owner/repo.git",
        }),
      );
    });

    test("an unchanged Git URL does not update the project", async () => {
      const onUpdateProject = mock(async (project: Project) => project);
      renderSettings({ section: "general", onUpdateProject });

      fireEvent.click(getSaveButton());

      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));
      expect(onUpdateProject).not.toHaveBeenCalled();
    });

    test("saves unrelated settings for a project with an existing local-path remote", async () => {
      const onUpdateProject = mock(async (project: Project) => project);
      renderSettings({
        section: "branches",
        project: { gitUrl: "/tmp/origin.git" },
        onUpdateProject,
      });

      fireEvent.change(screen.getByLabelText("Default Branch"), { target: { value: "develop" } });
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(mockUpdateRepositoryConfig).toHaveBeenCalledTimes(1));
      expect(getSavedConfig().defaultBranch).toBe("develop");
      expect(onUpdateProject).not.toHaveBeenCalled();
    });

    test("can rename a project with an existing local-path remote", async () => {
      const onUpdateProject = mock(async (project: Project) => project);
      renderSettings({
        section: "general",
        project: { gitUrl: "/tmp/origin.git" },
        onUpdateProject,
      });

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "renamed" } });
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(onUpdateProject).toHaveBeenCalledTimes(1));
      expect(onUpdateProject.mock.calls[0]?.[0]).toMatchObject({
        name: "renamed",
        gitUrl: "/tmp/origin.git",
      });
    });

    test("rejects an empty or malformed Git URL", () => {
      renderSettings({ section: "general" });
      const gitUrlInput = screen.getByLabelText("Git URL");

      fireEvent.change(gitUrlInput, { target: { value: "   " } });
      expect(screen.getByText("Git URL cannot be empty")).toBeTruthy();
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(gitUrlInput, { target: { value: "github.com/owner/repo" } });
      expect(screen.getByText("Enter an HTTPS, SSH, or git@ remote URL")).toBeTruthy();
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(gitUrlInput, { target: { value: "git@github.com:owner/repo.git" } });
      expect(screen.queryByText("Enter an HTTPS, SSH, or git@ remote URL") === null).toBe(true);
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(false);
    });

    test("fills the Git URL from the local clone's origin remote", async () => {
      mockGetGitRemoteUrl.mockImplementation(async () => "git@github.com:moved/repo.git");
      renderSettings({ section: "general", project: { localPath: "/Users/test/repo" } });

      fireEvent.click(
        within(getSettingsContent()).getByRole("button", {
          name: "Use the local clone's origin remote",
        }),
      );

      await waitFor(() =>
        expect((screen.getByLabelText("Git URL") as HTMLInputElement).value).toBe(
          "git@github.com:moved/repo.git",
        ),
      );
      expect(mockGetGitRemoteUrl).toHaveBeenCalledWith("/Users/test/repo");
    });

    test("reports a local clone without an origin remote", async () => {
      renderSettings({ section: "general", project: { localPath: "/Users/test/repo" } });

      fireEvent.click(
        within(getSettingsContent()).getByRole("button", {
          name: "Use the local clone's origin remote",
        }),
      );

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("No origin remote found", expect.anything()),
      );
      expect((screen.getByLabelText("Git URL") as HTMLInputElement).value).toBe(
        "git@github.com:test/repo.git",
      );
    });

    test("reports a failure to read the local origin", async () => {
      mockGetGitRemoteUrl.mockImplementation(async () => {
        throw new Error("git config failed");
      });
      renderSettings({ section: "general", project: { localPath: "/tmp/repo" } });

      fireEvent.click(screen.getByRole("button", { name: "Use the local clone's origin remote" }));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Could not read the local remote", {
          description: "git config failed",
        }),
      );
      expect((screen.getByLabelText("Git URL") as HTMLInputElement).value).toBe(
        "git@github.com:test/repo.git",
      );
    });

    test("keeps an origin read from racing an edit or save", async () => {
      let resolveRemote!: (value: string) => void;
      mockGetGitRemoteUrl.mockImplementation(
        () => new Promise<string>((resolve) => (resolveRemote = resolve)),
      );
      const onUpdateProject = mock(async (project: Project) => project);
      renderSettings({
        section: "general",
        project: { localPath: "/tmp/repo" },
        onUpdateProject,
      });

      fireEvent.click(screen.getByRole("button", { name: "Use the local clone's origin remote" }));
      expect((screen.getByLabelText("Git URL") as HTMLInputElement).disabled).toBe(true);
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByLabelText("Local Path") as HTMLInputElement).disabled).toBe(true);

      await act(async () => resolveRemote("git@github.com:moved/repo.git"));
      expect((screen.getByLabelText("Git URL") as HTMLInputElement).value).toBe(
        "git@github.com:moved/repo.git",
      );
      expect((getSaveButton() as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(getSaveButton());
      await waitFor(() => expect(onUpdateProject).toHaveBeenCalledTimes(1));
      expect(onUpdateProject.mock.calls[0]?.[0].gitUrl).toBe("git@github.com:moved/repo.git");
    });

    test("ignores an origin result after Cancel", async () => {
      let resolveRemote!: (value: string) => void;
      mockGetGitRemoteUrl.mockImplementation(
        () => new Promise<string>((resolve) => (resolveRemote = resolve)),
      );
      renderSettings({ section: "general", project: { localPath: "/tmp/repo" } });

      fireEvent.click(screen.getByRole("button", { name: "Use the local clone's origin remote" }));
      fireEvent.click(getCancelButton());
      await act(async () => resolveRemote("git@github.com:late/repo.git"));

      expect((screen.getByLabelText("Git URL") as HTMLInputElement).value).toBe(
        "git@github.com:test/repo.git",
      );
    });

    test("opens GitHub and non-GitHub remotes in the browser", () => {
      const open = mock(() => null);
      const previousOpen = window.open;
      window.open = open;
      try {
        renderSettings({ section: "general" });
        fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
        expect(open).toHaveBeenCalledWith("https://github.com/test/repo", "_blank");

        fireEvent.change(screen.getByLabelText("Git URL"), {
          target: { value: "https://git.example.com/owner/repo.git" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
        expect(open).toHaveBeenLastCalledWith("https://git.example.com/owner/repo.git", "_blank");

        fireEvent.change(screen.getByLabelText("Git URL"), {
          target: { value: "https://user:token@git.example.com/owner/repo.git" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
        expect(open).toHaveBeenLastCalledWith("https://git.example.com/owner/repo.git", "_blank");
      } finally {
        window.open = previousOpen;
      }
    });

    test("hides the local remote shortcut without a local path", () => {
      renderSettings({ section: "general" });

      expect(
        within(getSettingsContent()).queryByRole("button", {
          name: "Use the local clone's origin remote",
        }) === null,
      ).toBe(true);
    });

    test("a chosen image is previewed and saved as the project icon", async () => {
      const onUpdateProject = mock(async (project: Project) => project);
      renderSettings({ section: "general", onUpdateProject });

      expect(within(getSettingsContent()).queryByTestId("project-icon") === null).toBe(true);
      nextDialogResult = "/icons/logo.png";
      fireEvent.click(screen.getByRole("button", { name: "Icon" }));
      await waitFor(() =>
        expect(
          within(screen.getByTestId("project-icon-preview"))
            .getByTestId("project-icon")
            .getAttribute("src"),
        ).toBe(PICKED_ICON),
      );
      expect(mockOpenDialog).toHaveBeenCalledWith({
        mode: "file",
        title: "Select Icon Image",
        defaultPath: undefined,
      });
      expect(mockReadHostImageFile).toHaveBeenCalledWith("/icons/logo.png");
      expect(mockFileFromHostImage).toHaveBeenCalledWith(hostImage("/icons/logo.png"));
      expect(mockProjectIconFromFile).toHaveBeenCalledWith(hostFile);
      expect(mockFindProjectIcons).not.toHaveBeenCalled();
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(onUpdateProject).toHaveBeenCalledTimes(1));
      expect(onUpdateProject.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ id: "project-1", icon: PICKED_ICON }),
      );
    });

    test("a newer selection wins when conversions finish out of order", async () => {
      const first = Promise.withResolvers<string>();
      const second = Promise.withResolvers<string>();
      mockProjectIconFromFile.mockImplementationOnce(() => first.promise);
      mockProjectIconFromFile.mockImplementationOnce(() => second.promise);
      renderSettings({ section: "general" });
      nextDialogResult = "/icons/logo.png";
      fireEvent.click(screen.getByLabelText("Icon"));
      await waitFor(() => expect(mockProjectIconFromFile).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      fireEvent.click(screen.getByLabelText("Icon"));
      await waitFor(() => expect(mockProjectIconFromFile).toHaveBeenCalledTimes(2));
      const latestIcon = "data:image/webp;base64,YQ==";
      await act(async () => second.resolve(latestIcon));
      expect(getSaveButton().hasAttribute("disabled")).toBe(false);
      await act(async () => first.resolve(PICKED_ICON));
      expect(screen.getByTestId("project-icon").getAttribute("src")).toBe(latestIcon);
    });

    test("an obsolete conversion cannot report errors or finish the current selection", async () => {
      const first = Promise.withResolvers<string>();
      const second = Promise.withResolvers<string>();
      mockProjectIconFromFile.mockImplementationOnce(() => first.promise);
      mockProjectIconFromFile.mockImplementationOnce(() => second.promise);
      renderSettings({ section: "general" });
      nextDialogResult = "/icons/logo.png";
      fireEvent.click(screen.getByLabelText("Icon"));
      await waitFor(() => expect(mockProjectIconFromFile).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      fireEvent.click(screen.getByLabelText("Icon"));
      await waitFor(() => expect(mockProjectIconFromFile).toHaveBeenCalledTimes(2));
      await act(async () => first.reject(new Error("obsolete")));
      expect(mockToastError).not.toHaveBeenCalled();
      expect(getSaveButton().hasAttribute("disabled")).toBe(true);
      await act(async () => second.resolve(PICKED_ICON));
      expect(getSaveButton().hasAttribute("disabled")).toBe(false);
    });

    for (const action of ["remove", "cancel", "reset", "close"] as const) {
      test(`${action} abandons a pending icon conversion`, async () => {
        const conversion = Promise.withResolvers<string>();
        mockProjectIconFromFile.mockImplementationOnce(() => conversion.promise);
        const view = renderSettings({
          section: "general",
          project: { icon: PICKED_ICON },
        });
        nextDialogResult = "/icons/logo.png";
        fireEvent.click(screen.getByRole("button", { name: "Icon" }));
        await waitFor(() => expect(mockProjectIconFromFile).toHaveBeenCalledTimes(1));
        const resetIcon = "data:image/webp;base64,YQ==";
        if (action === "remove") fireEvent.click(screen.getByRole("button", { name: "Remove" }));
        if (action === "cancel") fireEvent.click(getCancelButton());
        if (action === "reset" || action === "close") {
          view.rerender(
            <RepositorySettings
              project={{ ...view.project, icon: resetIcon }}
              open={action !== "close"}
              onOpenChange={view.onOpenChange}
            />,
          );
        }
        await act(async () => conversion.resolve("data:image/png;base64,Yg=="));
        if (action === "close") {
          view.rerender(
            <RepositorySettings project={view.project} open onOpenChange={view.onOpenChange} />,
          );
        }
        const image = screen.queryByTestId("project-icon");
        expect(image?.getAttribute("src") ?? null).toBe(
          action === "remove" ? null : action === "reset" ? resetIcon : PICKED_ICON,
        );
        expect(getSaveButton().hasAttribute("disabled")).toBe(false);
      });
    }

    test("Save waits until conversion settles and then saves the converted icon", async () => {
      const conversion = Promise.withResolvers<string>();
      mockProjectIconFromFile.mockImplementationOnce(() => conversion.promise);
      const onUpdateProject = mock(async (project: Project) => project);
      renderSettings({ section: "general", onUpdateProject });
      nextDialogResult = "/icons/logo.png";
      fireEvent.click(screen.getByLabelText("Icon"));
      await waitFor(() => expect(mockProjectIconFromFile).toHaveBeenCalledTimes(1));
      expect(getSaveButton().hasAttribute("disabled")).toBe(true);
      fireEvent.click(getSaveButton());
      expect(mockUpdateRepositoryConfig).not.toHaveBeenCalled();
      expect(onUpdateProject).not.toHaveBeenCalled();
      await act(async () => conversion.resolve(PICKED_ICON));
      fireEvent.click(getSaveButton());
      await waitFor(() =>
        expect(onUpdateProject).toHaveBeenCalledWith(
          expect.objectContaining({ icon: PICKED_ICON }),
        ),
      );
    });

    test("removing the icon saves the project without one", async () => {
      const onUpdateProject = mock(async (project: Project) => project);
      renderSettings({
        section: "general",
        project: { icon: PICKED_ICON },
        onUpdateProject,
      });

      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      expect(within(getSettingsContent()).queryByTestId("project-icon") === null).toBe(true);
      fireEvent.click(getSaveButton());

      await waitFor(() => expect(onUpdateProject).toHaveBeenCalledTimes(1));
      expect(onUpdateProject.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ id: "project-1", icon: null }),
      );
    });

    test("an image that cannot be used is reported and leaves the icon alone", async () => {
      mockProjectIconFromFile.mockImplementationOnce(async () => {
        throw new Error("The image could not be read");
      });
      renderSettings({ section: "general" });

      nextDialogResult = "/icons/logo.png";
      fireEvent.click(screen.getByLabelText("Icon"));
      await waitFor(() => expect(mockProjectIconFromFile).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mockToastError).toHaveBeenCalled());
      expect(within(getSettingsContent()).queryByTestId("project-icon") === null).toBe(true);
    });

    for (const [root, path, displayed] of [
      ["/repo", "/repo/public/favicon.png", "public/favicon.png"],
      ["/repo/", "/repo/public/favicon.png", "public/favicon.png"],
      ["/repo", "/repo2/logo.png", "/repo2/logo.png"],
      ["/repo", "/elsewhere/logo.png", "/elsewhere/logo.png"],
    ]) {
      test(`detects an icon and formats ${path} relative to ${root}`, async () => {
        mockFindProjectIcons.mockResolvedValueOnce([path!]);
        renderSettings({ section: "general", project: { localPath: root } });
        fireEvent.click(screen.getByRole("button", { name: "Icon" }));
        await waitFor(() =>
          expect(mockToastSuccess).toHaveBeenCalledWith("Found the project's icon", {
            description: `${displayed}. Use Change Image to browse for another.`,
          }),
        );
        expect(mockFindProjectIcons).toHaveBeenCalledWith(root);
        expect(mockReadHostImageFile).toHaveBeenCalledWith(path);
        expect(screen.getByTestId("project-icon").getAttribute("src")).toBe(PICKED_ICON);
        expect(mockOpenDialog).not.toHaveBeenCalled();
      });
    }

    test("changing an existing icon skips discovery and browses from the repository", async () => {
      nextDialogResult = "/repo/new.png";
      renderSettings({
        section: "general",
        project: { localPath: "/repo", icon: PICKED_ICON },
      });
      fireEvent.click(screen.getByRole("button", { name: "Icon" }));
      await waitFor(() => expect(mockProjectIconFromFile).toHaveBeenCalledTimes(1));
      expect(mockFindProjectIcons).not.toHaveBeenCalled();
      expect(mockOpenDialog).toHaveBeenCalledWith({
        mode: "file",
        title: "Select Icon Image",
        defaultPath: "/repo",
      });
    });

    test("unreadable and undecodable candidates fall back to the host picker", async () => {
      mockFindProjectIcons.mockResolvedValueOnce(["/repo/unreadable.png", "/repo/broken.png"]);
      mockReadHostImageFile.mockRejectedValueOnce(new Error("unreadable"));
      mockProjectIconFromFile.mockRejectedValueOnce(new Error("cannot decode"));
      nextDialogResult = "/repo/chosen.png";
      renderSettings({ section: "general", project: { localPath: "/repo" } });
      fireEvent.click(screen.getByLabelText("Icon"));
      await waitFor(() => expect(mockProjectIconFromFile).toHaveBeenCalledTimes(2));
      expect(mockReadHostImageFile.mock.calls.map(([path]) => path)).toEqual([
        "/repo/unreadable.png",
        "/repo/broken.png",
        "/repo/chosen.png",
      ]);
      expect(mockOpenDialog).toHaveBeenCalledWith({
        mode: "file",
        title: "Select Icon Image",
        defaultPath: "/repo",
      });
      expect(mockToastError).not.toHaveBeenCalled();
      expect(screen.getByTestId("project-icon").getAttribute("src")).toBe(PICKED_ICON);
    });

    test("discovery failure still opens the picker", async () => {
      mockFindProjectIcons.mockRejectedValueOnce(new Error("offline"));
      renderSettings({ section: "general", project: { localPath: "/repo" } });
      fireEvent.click(screen.getByLabelText("Icon"));
      await waitFor(() => expect(mockOpenDialog).toHaveBeenCalledTimes(1));
      expect(mockToastError).not.toHaveBeenCalled();
      expect(getSaveButton().hasAttribute("disabled")).toBe(false);
    });

    test("picker cancellation preserves the icon without reading an image", async () => {
      renderSettings({ section: "general", project: { icon: PICKED_ICON } });
      fireEvent.click(screen.getByRole("button", { name: "Icon" }));
      await waitFor(() => expect(mockOpenDialog).toHaveBeenCalledTimes(1));
      expect(mockReadHostImageFile).not.toHaveBeenCalled();
      expect(mockProjectIconFromFile).not.toHaveBeenCalled();
      expect(screen.getByTestId("project-icon").getAttribute("src")).toBe(PICKED_ICON);
      expect(getSaveButton().hasAttribute("disabled")).toBe(false);
      expect(mockToastError).not.toHaveBeenCalled();
    });

    test("host read errors preserve the icon and unblock Save", async () => {
      nextDialogResult = "/icons/unreadable.png";
      mockReadHostImageFile.mockRejectedValueOnce(new Error("Permission denied"));
      renderSettings({ section: "general", project: { icon: PICKED_ICON } });
      fireEvent.click(screen.getByRole("button", { name: "Icon" }));
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Could not use that image", {
          description: "Permission denied",
        }),
      );
      expect(mockProjectIconFromFile).not.toHaveBeenCalled();
      expect(screen.getByTestId("project-icon").getAttribute("src")).toBe(PICKED_ICON);
      expect(getSaveButton().hasAttribute("disabled")).toBe(false);
    });

    test("Save stays blocked through discovery, host read and conversion", async () => {
      const discovery = Promise.withResolvers<string[]>();
      const read = Promise.withResolvers<HostImageFile>();
      const conversion = Promise.withResolvers<string>();
      mockFindProjectIcons.mockReturnValueOnce(discovery.promise);
      mockReadHostImageFile.mockReturnValueOnce(read.promise);
      mockProjectIconFromFile.mockReturnValueOnce(conversion.promise);
      const onUpdateProject = mock(async (project: Project) => project);
      renderSettings({
        section: "general",
        project: { localPath: "/repo" },
        onUpdateProject,
      });
      fireEvent.click(screen.getByLabelText("Icon"));
      expect(mockFindProjectIcons).toHaveBeenCalledTimes(1);
      const assertBlocked = () => {
        expect(getSaveButton().hasAttribute("disabled")).toBe(true);
        fireEvent.click(getSaveButton());
        expect(onUpdateProject).not.toHaveBeenCalled();
        expect(mockUpdateRepositoryConfig).not.toHaveBeenCalled();
      };
      assertBlocked();
      await act(async () => discovery.resolve(["/repo/logo.png"]));
      expect(mockReadHostImageFile).toHaveBeenCalledTimes(1);
      assertBlocked();
      await act(async () => read.resolve(hostImage("/repo/logo.png")));
      expect(mockProjectIconFromFile).toHaveBeenCalledTimes(1);
      assertBlocked();
      await act(async () => conversion.resolve(PICKED_ICON));
      expect(getSaveButton().hasAttribute("disabled")).toBe(false);
      fireEvent.click(getSaveButton());
      await waitFor(() =>
        expect(onUpdateProject).toHaveBeenCalledWith(
          expect.objectContaining({ icon: PICKED_ICON }),
        ),
      );
    });

    for (const action of ["remove", "reset", "close"] as const) {
      for (const fails of [false, true]) {
        test(`${action} ignores a stale host read that ${fails ? "fails" : "succeeds"}`, async () => {
          const read = Promise.withResolvers<HostImageFile>();
          mockReadHostImageFile.mockReturnValueOnce(read.promise);
          nextDialogResult = "/icons/logo.png";
          const view = renderSettings({
            section: "general",
            project: { icon: PICKED_ICON },
          });
          fireEvent.click(screen.getByLabelText("Icon"));
          await waitFor(() => expect(mockReadHostImageFile).toHaveBeenCalledTimes(1));
          expect(getSaveButton().hasAttribute("disabled")).toBe(true);
          const resetIcon = "data:image/webp;base64,YQ==";
          if (action === "remove") fireEvent.click(screen.getByRole("button", { name: "Remove" }));
          else
            view.rerender(
              <RepositorySettings
                project={{ ...view.project, icon: resetIcon }}
                open={action !== "close"}
                onOpenChange={view.onOpenChange}
              />,
            );
          await act(async () => {
            if (fails) read.reject(new Error("stale read"));
            else read.resolve(hostImage("/icons/logo.png"));
          });
          if (action === "close")
            view.rerender(
              <RepositorySettings project={view.project} open onOpenChange={view.onOpenChange} />,
            );
          expect(mockProjectIconFromFile).not.toHaveBeenCalled();
          expect(mockToastError).not.toHaveBeenCalled();
          expect(screen.queryByTestId("project-icon")?.getAttribute("src") ?? null).toBe(
            action === "remove" ? null : action === "reset" ? resetIcon : PICKED_ICON,
          );
          expect(getSaveButton().hasAttribute("disabled")).toBe(false);
        });
      }
    }

    test("cancel resets edits and closes the dialog", () => {
      const onOpenChange = mock(() => {});
      renderSettings({
        section: "general",
        onOpenChange,
      });

      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "changed" } });
      fireEvent.change(screen.getByLabelText("Local Path"), { target: { value: "/tmp/changed" } });
      fireEvent.change(screen.getByLabelText("Git URL"), {
        target: { value: "https://github.com/changed/repo.git" },
      });
      fireEvent.click(getCancelButton());

      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("test-repo");
      expect((screen.getByLabelText("Git URL") as HTMLInputElement).value).toBe(
        "git@github.com:test/repo.git",
      );
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
