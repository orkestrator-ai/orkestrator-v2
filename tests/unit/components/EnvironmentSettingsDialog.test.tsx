import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import type { AgentExtensionCatalog, AgentSkillProvider } from "@/lib/backend";
import type { Environment } from "@/types";
import { mockToastError, mockToastSuccess } from "../../mocks/sonner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

function clickAgentTab(name: string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.focus(tab);
}

function defaultExtensionCatalogs(): AgentExtensionCatalog[] {
  return [
    {
      agent: "claude",
      mcpServers: [{ name: "claude-docs", status: "connected" }],
      plugins: [{ name: "claude-review", status: "configured", source: "user" }],
    },
    {
      agent: "codex",
      mcpServers: [{ name: "codex-github", status: "configured" }],
      plugins: [{ name: "codex-browser", status: "configured", source: "bundled" }],
    },
    {
      agent: "cursor",
      mcpServers: [{ name: "cursor-linear", status: "configured" }],
      plugins: [{ name: "cursor-review", status: "configured", source: "user" }],
    },
    {
      agent: "grok",
      mcpServers: [{ name: "grok-filesystem", status: "configured" }],
      plugins: [{ name: "grok-superpowers", status: "configured" }],
    },
    {
      agent: "opencode",
      mcpServers: [{ name: "opencode-linear", status: "disabled" }],
      plugins: [{ name: "@team/opencode-review", status: "configured" }],
    },
    {
      agent: "pi",
      mcpServers: [],
      plugins: [{ name: "pi-project-extension", status: "configured", source: "project" }],
    },
  ];
}

/** Swapped per test so each one controls timing and failure of the load. */
let extensionHandler: (
  environmentId: string,
  options?: { refresh?: boolean },
) => Promise<AgentExtensionCatalog[]> = async () => defaultExtensionCatalogs();

let mockSection = "defaults";
const mockUpdateEnvironmentAgentSettings = mock(
  async (environmentId: string, agentSettings: unknown) => ({
    ...makeEnvironment(),
    id: environmentId,
    agentSettings: agentSettings as Environment["agentSettings"],
  }),
);
const mockGetEnvironmentExtensions = mock(
  (environmentId: string, options?: { refresh?: boolean }) =>
    extensionHandler(environmentId, options),
);
const mockListEnvironmentAgentSkills = mock(
  async (environmentId: string, provider: AgentSkillProvider) => ({
    provider,
    roots: [
      {
        path: `/workspace/.${provider}/skills`,
        label: `./.${provider}/skills`,
        scope: "project" as const,
        exists: true,
        skillCount: 1,
      },
    ],
    skills: [`${provider}-skill`, `${provider}-second`].map((name) => ({
      id: `/workspace/.${provider}/skills/${name}/SKILL.md`,
      name,
      description: `${provider} environment skill`,
      filePath: `/workspace/.${provider}/skills/${name}/SKILL.md`,
      location: `./.${provider}/skills/${name}`,
      scope: "project" as const,
      shadowed: false,
    })),
    errors: [],
    environmentId,
  }),
);
const mockReadEnvironmentAgentSkill = mock(
  async (_environmentId: string, provider: AgentSkillProvider, filePath: string) => ({
    path: filePath,
    content: `---\nname: ${provider}-skill\n---\n\n# ${provider} skill`,
    truncated: false,
  }),
);
const mockUpdatePortMappings = mock(async () => makeEnvironment());
const mockSyncEnvironmentStatus = mock(async () => makeEnvironment());
const actualBackend = await import("../../../apps/web/src/lib/backend");

mock.module("@/lib/backend", () => ({
  ...actualBackend,
  getEnvironmentExtensions: mockGetEnvironmentExtensions,
  listEnvironmentAgentSkills: mockListEnvironmentAgentSkills,
  readEnvironmentAgentSkill: mockReadEnvironmentAgentSkill,
  updateEnvironmentAgentSettings: mockUpdateEnvironmentAgentSettings,
  renameEnvironment: mock(async (_id: string, name: string) => ({ ...makeEnvironment(), name })),
  updateEnvironmentAllowedDomains: mock(async () => makeEnvironment()),
  updatePortMappings: mockUpdatePortMappings,
  syncEnvironmentStatus: mockSyncEnvironmentStatus,
  testDomainResolution: mock(async () => []),
}));

let capturedMenuItems: Array<{ id: string }> = [];

mock.module("@/components/settings/FullscreenSettingsLayout", () => ({
  FullscreenSettingsLayout: ({
    open,
    children,
    footer,
    menuItems,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    menuItems: unknown[];
    children: (section: string) => React.ReactNode;
    footer?: React.ReactNode;
  }) => {
    capturedMenuItems = menuItems as Array<{ id: string }>;
    if (!open) return null;
    return (
      <div data-testid="settings-layout">
        <div data-testid="settings-content">{children(mockSection)}</div>
        {footer && <div data-testid="settings-footer">{footer}</div>}
      </div>
    );
  },
}));

const { EnvironmentSettingsDialog } =
  await import("../../../apps/web/src/components/environments/EnvironmentSettingsDialog");

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "test-env",
    branch: "main",
    containerId: "container-1",
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "full",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

describe("EnvironmentSettingsDialog", () => {
  beforeEach(() => {
    cleanup();
    mockSection = "defaults";
    mockUpdateEnvironmentAgentSettings.mockClear();
    mockGetEnvironmentExtensions.mockClear();
    mockListEnvironmentAgentSkills.mockClear();
    mockReadEnvironmentAgentSkill.mockClear();
    mockUpdatePortMappings.mockClear();
    mockSyncEnvironmentStatus.mockClear();
    extensionHandler = async () => defaultExtensionCatalogs();
    capturedMenuItems = [];
    mockToastSuccess.mockClear();
    mockToastError.mockClear();

    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          enabledAgentPlatforms: ["claude", "codex", "opencode"],
          agentSettings: {
            defaultAgent: "claude",
            platforms: {
              claude: { mode: "terminal", claudeNativeBackend: "sdk" },
              codex: { mode: "native", model: "gpt-5.3-codex", reasoningEffort: "medium" },
              opencode: { mode: "terminal", model: "opencode/grok-code" },
            },
          },
          terminalAppearance: {
            fontFamily: "Fira Code",
            fontSize: 14,
            backgroundColor: "#000000",
          },
          terminalScrollback: 5000,
        },
        repositories: {},
      },
      isLoading: false,
      error: null,
    });

    useClaudeStore.setState({
      sessions: new Map(),
      sessionInitData: new Map(),
      serverStatuses: new Map(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("saves a Codex mode override from the Codex tab", async () => {
    mockSection = "codex";
    const onUpdate = mock(() => {});

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={onUpdate}
      />,
    );

    // Each platform has its own tab now, so choosing a mode for Codex cannot
    // move Claude or OpenCode the way the old shared control did.
    fireEvent.click(screen.getByRole("radio", { name: /^Terminal/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateEnvironmentAgentSettings).toHaveBeenCalledWith("env-1", {
        platforms: { codex: { mode: "terminal" } },
      });
    });
    // Editing settings must leave any pending launch intent alone: the argument
    // is omitted rather than sent as `false`, which the backend would apply.
    expect(mockUpdateEnvironmentAgentSettings.mock.calls[0]).toHaveLength(2);

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSettings: { platforms: { codex: { mode: "terminal" } } },
      }),
    );
  });

  test("offers a tab per enabled platform, in platform order", () => {
    extensionHandler = () => new Promise(() => undefined);
    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    // The section list is the tab strip. Every enabled platform gets one, in
    // the order `AGENT_PLATFORMS` declares, so the three dialogs agree.
    // Every enabled platform gets a tab, in the order `AGENT_PLATFORMS`
    // declares, so all three settings dialogs list them identically.
    expect(capturedMenuItems.map((item) => item.id)).toEqual([
      "general",
      "defaults",
      "claude",
      "codex",
      "opencode",
      "network",
      "ports",
      "extensions",
    ]);
  });

  test("uses top agent tabs and shows MCP servers, plugins, and skills for each agent", async () => {
    mockSection = "extensions";

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("claude-docs")).toBeTruthy();
    });

    // Scoped to this tablist: a document-wide role query also matched tabs left
    // in the shared happy-dom document by whichever file shared this worker.
    const tabList = screen.getByRole("tablist", { name: "Agent extensions" });
    const tabs = within(tabList).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "Claude",
      "Codex",
      "Cursor",
      "Grok",
      "OpenCode",
      "Pi",
    ]);
    // Six tabs do not fit one row at a narrow width. happy-dom does not lay
    // out, so the class contract stands in for the measurement: a fixed row
    // height with no wrapping is what clipped the two agents added last.
    expect(tabList.className).toContain("flex-wrap");
    expect(tabList.className).toContain("h-auto");
    expect(/(^|\s)h-10(\s|$)/.test(tabList.className)).toBe(false);
    expect(screen.getByText("claude-review")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("claude-skill").length).toBeGreaterThan(0));
    expect(screen.getByText("Project")).toBeTruthy();

    clickAgentTab("Codex");
    await waitFor(() => expect(screen.getByText("codex-github")).toBeTruthy());
    expect(screen.getByText("codex-browser")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("codex-skill").length).toBeGreaterThan(0));

    clickAgentTab("Cursor");
    await waitFor(() => expect(screen.getByText("cursor-linear")).toBeTruthy());
    expect(screen.getByText("cursor-review")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("cursor-skill").length).toBeGreaterThan(0));

    clickAgentTab("Grok");
    await waitFor(() => expect(screen.getByText("grok-filesystem")).toBeTruthy());
    expect(screen.getByText("grok-superpowers")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("grok-skill").length).toBeGreaterThan(0));

    clickAgentTab("OpenCode");
    await waitFor(() => expect(screen.getByText("opencode-linear")).toBeTruthy());
    expect(screen.getByText("@team/opencode-review")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("opencode-skill").length).toBeGreaterThan(0));

    clickAgentTab("Pi");
    await waitFor(() => expect(screen.getByText("pi-project-extension")).toBeTruthy());
    expect(screen.getByText("Pi does not include a built-in MCP client")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("pi-skill").length).toBeGreaterThan(0));

    const skillCalls = mockListEnvironmentAgentSkills.mock.calls.map((call) => call.slice(0, 2));
    expect(skillCalls.every(([environmentId]) => environmentId === "env-1")).toBe(true);
    expect(new Set(skillCalls.map(([, provider]) => provider))).toEqual(
      new Set(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
    );
    await waitFor(() => {
      const readCalls = mockReadEnvironmentAgentSkill.mock.calls;
      expect(readCalls.every(([environmentId]) => environmentId === "env-1")).toBe(true);
      expect(new Set(readCalls.map(([, provider]) => provider))).toEqual(
        new Set(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
      );
    });
    expect(screen.queryByRole("button", { name: "Reveal skill in file manager" }) === null).toBe(
      true,
    );
    expect(mockGetEnvironmentExtensions).toHaveBeenCalledWith("env-1", {});
  });

  test("keeps each agent's scanned skills and selection when the tab is revisited", async () => {
    mockSection = "extensions";

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /claude-second/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /claude-second/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /claude-second/ }).getAttribute("aria-current"),
      ).toBe("true"),
    );

    clickAgentTab("Codex");
    await waitFor(() => expect(screen.getByRole("button", { name: /codex-skill/ })).toBeTruthy());
    clickAgentTab("Claude");

    // Scanning a skill tree inside an environment runs a process in the
    // container, so returning to a tab must reuse what it already has rather
    // than re-running the scan and dropping the user back to the first skill.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /claude-second/ }).getAttribute("aria-current"),
      ).toBe("true"),
    );
    expect(mockListEnvironmentAgentSkills.mock.calls.map(([, provider]) => provider)).toEqual([
      "claude",
      "codex",
    ]);
  });

  test("rescans an agent's skills on demand", async () => {
    mockSection = "extensions";

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getAllByText("claude-skill").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Rescan skill directories" }));

    // Reusing a completed scan is what makes the Rescan button the only way to
    // pick up a skill written since the pane opened.
    await waitFor(() =>
      expect(mockListEnvironmentAgentSkills.mock.calls.map(([, provider]) => provider)).toEqual([
        "claude",
        "claude",
      ]),
    );
  });

  test("labels each item with its source, falling back to its status", async () => {
    mockSection = "extensions";
    extensionHandler = async () => [
      {
        agent: "claude",
        mcpServers: [
          { name: "with-source", status: "connected", source: "project" },
          { name: "without-source", status: "pending" },
        ],
        plugins: [],
      },
      { agent: "codex", mcpServers: [], plugins: [] },
      { agent: "opencode", mcpServers: [], plugins: [] },
    ];

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("with-source")).toBeTruthy());
    expect(screen.getByText("project")).toBeTruthy();
    // No source to show, so the status stands in for it.
    expect(screen.getByText("pending")).toBeTruthy();
  });

  test("summarises the configured extension count per agent", async () => {
    mockSection = "extensions";
    extensionHandler = async () => [
      {
        agent: "claude",
        mcpServers: [{ name: "only-one", status: "connected" }],
        plugins: [],
      },
      { agent: "codex", mcpServers: [], plugins: [] },
      { agent: "opencode", mcpServers: [], plugins: [] },
    ];

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("only-one")).toBeTruthy());
    expect(screen.getByText("1 configured extension")).toBeTruthy();
    expect(screen.getByText("No plugins configured")).toBeTruthy();

    clickAgentTab("Codex");
    await waitFor(() => expect(screen.getByText("No configured extensions found")).toBeTruthy());
    expect(screen.getByText("No MCP servers configured")).toBeTruthy();
    expect(screen.getByText("No plugins configured")).toBeTruthy();
  });

  test("shows an error banner and no stale data when the load fails", async () => {
    mockSection = "extensions";
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    extensionHandler = async () => {
      throw new Error("backend unavailable");
    };

    try {
      render(
        <EnvironmentSettingsDialog
          open={true}
          onOpenChange={() => {}}
          environment={makeEnvironment()}
          onUpdate={() => {}}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText(/Extension settings could not be loaded/)).toBeTruthy();
      });
      expect(screen.queryByText("claude-docs") === null).toBe(true);
      // The agent navigation and empty selected section remain available.
      expect(screen.getByRole("tab", { name: "Claude" })).toBeTruthy();
      expect(screen.getByRole("region", { name: "Claude extensions" })).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("does not surface backend error text to the user", async () => {
    mockSection = "extensions";
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    extensionHandler = async () => {
      throw new Error("spawn /usr/local/bin/claude --token sk-secret failed");
    };

    try {
      render(
        <EnvironmentSettingsDialog
          open={true}
          onOpenChange={() => {}}
          environment={makeEnvironment()}
          onUpdate={() => {}}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText(/Extension settings could not be loaded/)).toBeTruthy();
      });
      expect(document.body.textContent).not.toContain("sk-secret");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("renders per-collection errors reported by the backend", async () => {
    mockSection = "extensions";
    extensionHandler = async () => [
      {
        agent: "claude",
        mcpServers: [],
        plugins: [{ name: "claude-review", status: "configured" }],
        mcpError: "Could not read Claude MCP servers.",
      },
      { agent: "codex", mcpServers: [], plugins: [] },
      { agent: "opencode", mcpServers: [], plugins: [] },
    ];

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Could not read Claude MCP servers.")).toBeTruthy();
    });
    // The healthy half of the same agent still renders.
    expect(screen.getByText("claude-review")).toBeTruthy();
  });

  test("fills in agents the backend omitted rather than dropping their sections", async () => {
    mockSection = "extensions";
    extensionHandler = async () => [
      {
        agent: "claude",
        mcpServers: [{ name: "claude-docs", status: "connected" }],
        plugins: [],
      },
    ];

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());
    for (const label of ["Claude", "Codex", "Cursor", "Grok", "OpenCode"]) {
      expect(screen.getByRole("tab", { name: label })).toBeTruthy();
    }
    clickAgentTab("Codex");
    expect(screen.getByText("Could not read Codex MCP servers.")).toBeTruthy();
    expect(screen.getByText("Could not read Codex plugins.")).toBeTruthy();
    clickAgentTab("Cursor");
    expect(screen.getByText("Could not read Cursor MCP servers.")).toBeTruthy();
    expect(screen.getByText("Could not read Cursor plugins.")).toBeTruthy();
    clickAgentTab("Grok");
    expect(screen.getByText("Could not read Grok MCP servers.")).toBeTruthy();
    expect(screen.getByText("Could not read Grok plugins.")).toBeTruthy();
    clickAgentTab("OpenCode");
    expect(screen.getByText("Could not read OpenCode MCP servers.")).toBeTruthy();
    expect(screen.getByText("Could not read OpenCode plugins.")).toBeTruthy();
  });

  test("shows a loading placeholder until the first load resolves", async () => {
    mockSection = "extensions";
    const gate = deferred<AgentExtensionCatalog[]>();
    extensionHandler = () => gate.promise;

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    expect(screen.getByText(/Reading each agent's configuration/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Refresh/ }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      gate.resolve(defaultExtensionCatalogs());
    });

    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());
    expect(screen.queryByText(/Reading each agent's configuration/) === null).toBe(true);
    expect(screen.getByRole("button", { name: /Refresh/ }).hasAttribute("disabled")).toBe(false);
  });

  test("refresh asks the backend to bypass its cache", async () => {
    mockSection = "extensions";

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());
    expect(mockGetEnvironmentExtensions).toHaveBeenCalledWith("env-1", {});

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    await waitFor(() => {
      expect(mockGetEnvironmentExtensions).toHaveBeenCalledWith("env-1", { refresh: true });
    });
  });

  test("keeps the previous catalog visible while refreshing", async () => {
    mockSection = "extensions";
    const refreshGate = deferred<AgentExtensionCatalog[]>();

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());

    extensionHandler = () => refreshGate.promise;
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    // Mid-refresh the panel keeps showing what it already had.
    expect(screen.getByText("claude-docs")).toBeTruthy();
    expect(screen.queryByText(/Reading each agent's configuration/) === null).toBe(true);

    await act(async () => {
      refreshGate.resolve([
        {
          agent: "claude",
          mcpServers: [{ name: "refreshed-server", status: "connected" }],
          plugins: [],
        },
        { agent: "codex", mcpServers: [], plugins: [] },
        { agent: "opencode", mcpServers: [], plugins: [] },
      ]);
    });

    await waitFor(() => expect(screen.getByText("refreshed-server")).toBeTruthy());
    expect(screen.queryByText("claude-docs") === null).toBe(true);
  });

  test("discards a load that resolves after the dialog closed", async () => {
    mockSection = "extensions";
    const staleGate = deferred<AgentExtensionCatalog[]>();
    extensionHandler = () => staleGate.promise;

    const { rerender } = render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    rerender(
      <EnvironmentSettingsDialog
        open={false}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );

    // The first environment's response lands after the dialog was closed.
    await act(async () => {
      staleGate.resolve([
        {
          agent: "claude",
          mcpServers: [{ name: "env-1-only-server", status: "connected" }],
          plugins: [],
        },
        { agent: "codex", mcpServers: [], plugins: [] },
        { agent: "opencode", mcpServers: [], plugins: [] },
      ]);
    });

    // Reopening for a different environment must not show the first one's data.
    const nextGate = deferred<AgentExtensionCatalog[]>();
    extensionHandler = () => nextGate.promise;
    rerender(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment({ id: "env-2" })}
        onUpdate={() => {}}
      />,
    );

    expect(screen.queryByText("env-1-only-server") === null).toBe(true);
    expect(screen.getByText(/Reading each agent's configuration/)).toBeTruthy();

    await act(async () => {
      nextGate.resolve([
        {
          agent: "claude",
          mcpServers: [{ name: "env-2-server", status: "connected" }],
          plugins: [],
        },
        { agent: "codex", mcpServers: [], plugins: [] },
        { agent: "opencode", mcpServers: [], plugins: [] },
      ]);
    });

    await waitFor(() => expect(screen.getByText("env-2-server")).toBeTruthy());
    expect(screen.queryByText("env-1-only-server") === null).toBe(true);
  });

  test("discards a failed load that resolves after the dialog closed", async () => {
    mockSection = "extensions";
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const failing = deferred<AgentExtensionCatalog[]>();
    extensionHandler = () => failing.promise;

    try {
      const { rerender } = render(
        <EnvironmentSettingsDialog
          open={true}
          onOpenChange={() => {}}
          environment={makeEnvironment()}
          onUpdate={() => {}}
        />,
      );

      rerender(
        <EnvironmentSettingsDialog
          open={false}
          onOpenChange={() => {}}
          environment={makeEnvironment()}
          onUpdate={() => {}}
        />,
      );

      await act(async () => {
        failing.reject(new Error("backend unavailable"));
      });

      const nextGate = deferred<AgentExtensionCatalog[]>();
      extensionHandler = () => nextGate.promise;
      rerender(
        <EnvironmentSettingsDialog
          open={true}
          onOpenChange={() => {}}
          environment={makeEnvironment({ id: "env-2" })}
          onUpdate={() => {}}
        />,
      );

      // The abandoned failure must not paint an error over the new load.
      expect(screen.queryByText(/Extension settings could not be loaded/) === null).toBe(true);
      expect(screen.getByText(/Reading each agent's configuration/)).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("reloads when the dialog is reopened for a different environment", async () => {
    mockSection = "extensions";

    const { rerender } = render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());

    rerender(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment({ id: "env-2" })}
        onUpdate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(mockGetEnvironmentExtensions).toHaveBeenCalledWith("env-2", {});
    });
  });

  test("offers the extensions section for local and containerized environments", async () => {
    mockSection = "extensions";

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());
    expect(capturedMenuItems.map((item) => item.id)).toContain("extensions");
    cleanup();

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment({
          id: "env-local",
          environmentType: "local",
          containerId: null,
        })}
        onUpdate={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());
    const localMenu = capturedMenuItems.map((item) => item.id);
    expect(localMenu).toContain("extensions");
    // Local environments have no container network or port settings.
    expect(localMenu).not.toContain("ports");
  });

  test("blocks a pending port recreate when Docker becomes unavailable", async () => {
    mockSection = "ports";
    const onRestart = mock(async () => undefined);
    const onUpdate = mock(() => undefined);
    const environment = makeEnvironment({ status: "running" });
    const renderDialog = (available: boolean) => (
      <DockerAvailabilityProvider available={available}>
        <EnvironmentSettingsDialog
          open={true}
          onOpenChange={() => {}}
          environment={environment}
          onUpdate={onUpdate}
          onRestart={onRestart}
        />
      </DockerAvailabilityProvider>
    );
    const view = render(renderDialog(true));

    fireEvent.click(screen.getByRole("button", { name: "Add Port" }));
    fireEvent.change(screen.getByPlaceholderText("Host"), {
      target: { value: "3001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    const restartButton = await screen.findByRole("button", {
      name: "Restart Environment",
    });
    expect((restartButton as HTMLButtonElement).disabled).toBe(false);

    view.rerender(renderDialog(false));

    const disabledRestartButton = screen.getByRole("button", {
      name: "Restart Environment",
    });
    expect((disabledRestartButton as HTMLButtonElement).disabled).toBe(true);
    expect(disabledRestartButton.getAttribute("title")).toBe(
      "Start Docker to recreate this environment",
    );
    fireEvent.click(disabledRestartButton);

    expect(mockUpdatePortMappings).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(mockSyncEnvironmentStatus).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  test("saves port changes without a recreate prompt while Docker is unavailable", async () => {
    mockSection = "ports";
    const onRestart = mock(async () => undefined);
    const onUpdate = mock(() => undefined);
    const onOpenChange = mock(() => undefined);
    const environment = makeEnvironment({ status: "running" });
    render(
      <DockerAvailabilityProvider available={false}>
        <EnvironmentSettingsDialog
          open={true}
          onOpenChange={onOpenChange}
          environment={environment}
          onUpdate={onUpdate}
          onRestart={onRestart}
        />
      </DockerAvailabilityProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Port" }));
    fireEvent.change(screen.getByPlaceholderText("Host"), {
      target: { value: "3001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    // The recreate confirmation must not open: its only action is disabled
    // while the daemon is down, which would strand the user with no way to
    // save and silently drop every other edit in the form.
    await waitFor(() => {
      expect(mockUpdatePortMappings).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("button", { name: "Restart Environment" }) === null).toBe(true);
    expect(onRestart).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Environment settings saved",
      expect.objectContaining({
        description:
          "Port changes apply the next time this environment is recreated, once Docker is running.",
      }),
    );
  });
});
