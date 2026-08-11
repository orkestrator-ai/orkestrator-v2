import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { useClaudeStore } from "@/stores/claudeStore";
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
      agent: "opencode",
      mcpServers: [{ name: "opencode-linear", status: "disabled" }],
      plugins: [{ name: "@team/opencode-review", status: "configured" }],
    },
  ];
}

/** Swapped per test so each one controls timing and failure of the load. */
let extensionHandler: (
  environmentId: string,
  options?: { refresh?: boolean },
) => Promise<AgentExtensionCatalog[]> = async () => defaultExtensionCatalogs();

let mockSection = "agent";
const mockUpdateEnvironmentAgentSettings = mock(async (
  environmentId: string,
  defaultAgent: string | null,
  claudeMode: string | null,
  claudeNativeBackend: string | null,
  opencodeMode: string | null,
  codexMode: string | null,
) => ({
  ...makeEnvironment(),
  id: environmentId,
  defaultAgent: defaultAgent ?? undefined,
  claudeMode: claudeMode ?? undefined,
  claudeNativeBackend: claudeNativeBackend ?? undefined,
  opencodeMode: opencodeMode ?? undefined,
  codexMode: codexMode ?? undefined,
}));
const mockGetEnvironmentExtensions = mock(
  (environmentId: string, options?: { refresh?: boolean }) =>
    extensionHandler(environmentId, options),
);
const mockListEnvironmentAgentSkills = mock(
  async (environmentId: string, provider: AgentSkillProvider) => ({
    provider,
    roots: [{
      path: `/workspace/.${provider}/skills`,
      label: `./.${provider}/skills`,
      scope: "project" as const,
      exists: true,
      skillCount: 1,
    }],
    skills: [{
      id: `/workspace/.${provider}/skills/${provider}-skill/SKILL.md`,
      name: `${provider}-skill`,
      description: `${provider} environment skill`,
      filePath: `/workspace/.${provider}/skills/${provider}-skill/SKILL.md`,
      location: `./.${provider}/skills/${provider}-skill`,
      scope: "project" as const,
      shadowed: false,
    }],
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
const actualBackend = await import("../../../apps/web/src/lib/backend");

mock.module("@/lib/backend", () => ({
  ...actualBackend,
  getEnvironmentExtensions: mockGetEnvironmentExtensions,
  listEnvironmentAgentSkills: mockListEnvironmentAgentSkills,
  readEnvironmentAgentSkill: mockReadEnvironmentAgentSkill,
  updateEnvironmentAgentSettings: mockUpdateEnvironmentAgentSettings,
  renameEnvironment: mock(async (_id: string, name: string) => ({ ...makeEnvironment(), name })),
  updateEnvironmentAllowedDomains: mock(async () => makeEnvironment()),
  updatePortMappings: mock(async () => makeEnvironment()),
  syncEnvironmentStatus: mock(async () => makeEnvironment()),
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

const { EnvironmentSettingsDialog } = await import("../../../apps/web/src/components/environments/EnvironmentSettingsDialog");

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
    mockSection = "agent";
    mockUpdateEnvironmentAgentSettings.mockClear();
    mockGetEnvironmentExtensions.mockClear();
    mockListEnvironmentAgentSkills.mockClear();
    mockReadEnvironmentAgentSkill.mockClear();
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
          defaultAgent: "claude",
          opencodeModel: "opencode/grok-code",
          codexModel: "gpt-5.3-codex",
          codexReasoningEffort: "medium",
          opencodeMode: "terminal",
          claudeMode: "terminal",
          claudeNativeBackend: "sdk",
          codexMode: "native",
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

  test("saves a codex mode override", async () => {
    const onUpdate = mock(() => {});

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={onUpdate}
      />
    );

    const codexSection = screen.getByText("Codex Mode").parentElement;
    if (!codexSection) {
      throw new Error("Expected Codex Mode section");
    }

    fireEvent.click(within(codexSection).getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateEnvironmentAgentSettings).toHaveBeenCalledWith(
        "env-1",
        null,
        null,
        null,
        null,
        "terminal",
      );
    });
    // Editing settings must leave any pending launch intent alone: the argument is
    // omitted rather than sent as `false`, which the backend would apply.
    expect(mockUpdateEnvironmentAgentSettings.mock.calls[0]).toHaveLength(6);

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        codexMode: "terminal",
      })
    );
  });

  test("orders agent controls alphabetically", () => {
    extensionHandler = () => new Promise(() => undefined);
    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />
    );

    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.textContent?.trim())
        .filter((label) => ["Claude", "Codex", "OpenCode"].includes(label ?? "")),
    ).toEqual(["Claude", "Codex", "OpenCode"]);
    expect(
      Array.from(document.querySelectorAll("label"))
        .map((label) => label.textContent?.trim())
        .filter((label) => ["Claude Mode", "Codex Mode", "OpenCode Mode"].includes(label ?? "")),
    ).toEqual(["Claude Mode", "Codex Mode", "OpenCode Mode"]);
  });

  test("uses top agent tabs and shows MCP servers, plugins, and skills for each agent", async () => {
    mockSection = "extensions";

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("claude-docs")).toBeTruthy();
    });

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["Claude", "Codex", "OpenCode"]);
    expect(screen.getByText("claude-review")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("claude-skill").length).toBeGreaterThan(0));
    expect(screen.getByText("Project")).toBeTruthy();

    clickAgentTab("Codex");
    await waitFor(() => expect(screen.getByText("codex-github")).toBeTruthy());
    expect(screen.getByText("codex-browser")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("codex-skill").length).toBeGreaterThan(0));

    clickAgentTab("OpenCode");
    await waitFor(() => expect(screen.getByText("opencode-linear")).toBeTruthy());
    expect(screen.getByText("@team/opencode-review")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("opencode-skill").length).toBeGreaterThan(0));

    const skillCalls = mockListEnvironmentAgentSkills.mock.calls.map((call) => call.slice(0, 2));
    expect(skillCalls.every(([environmentId]) => environmentId === "env-1")).toBe(true);
    expect(new Set(skillCalls.map(([, provider]) => provider))).toEqual(
      new Set(["claude", "codex", "opencode"]),
    );
    await waitFor(() => {
      const readCalls = mockReadEnvironmentAgentSkill.mock.calls;
      expect(readCalls.every(([environmentId]) => environmentId === "env-1")).toBe(true);
      expect(new Set(readCalls.map(([, provider]) => provider))).toEqual(
        new Set(["claude", "codex", "opencode"]),
      );
    });
    expect(screen.queryByRole("button", { name: "Reveal skill in file manager" })).toBeNull();
    expect(mockGetEnvironmentExtensions).toHaveBeenCalledWith("env-1", {});
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
      />
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
      />
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
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Extension settings could not be loaded/)).toBeTruthy();
      });
      expect(screen.queryByText("claude-docs")).toBeNull();
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
        />
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
      />
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
      />
    );

    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());
    for (const label of ["Claude", "Codex", "OpenCode"]) {
      expect(screen.getByRole("tab", { name: label })).toBeTruthy();
    }
    clickAgentTab("Codex");
    expect(screen.getByText("Could not read Codex MCP servers.")).toBeTruthy();
    expect(screen.getByText("Could not read Codex plugins.")).toBeTruthy();
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
      />
    );

    expect(screen.getByText(/Reading Claude, Codex, and OpenCode configuration/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Refresh/ }).hasAttribute("disabled")).toBe(true);

    await act(async () => {
      gate.resolve(defaultExtensionCatalogs());
    });

    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());
    expect(screen.queryByText(/Reading Claude, Codex, and OpenCode configuration/)).toBeNull();
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
      />
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
      />
    );
    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());

    extensionHandler = () => refreshGate.promise;
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    // Mid-refresh the panel keeps showing what it already had.
    expect(screen.getByText("claude-docs")).toBeTruthy();
    expect(screen.queryByText(/Reading Claude, Codex, and OpenCode configuration/)).toBeNull();

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
    expect(screen.queryByText("claude-docs")).toBeNull();
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
      />
    );

    rerender(
      <EnvironmentSettingsDialog
        open={false}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={() => {}}
      />
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
      />
    );

    expect(screen.queryByText("env-1-only-server")).toBeNull();
    expect(screen.getByText(/Reading Claude, Codex, and OpenCode configuration/)).toBeTruthy();

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
    expect(screen.queryByText("env-1-only-server")).toBeNull();
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
        />
      );

      rerender(
        <EnvironmentSettingsDialog
          open={false}
          onOpenChange={() => {}}
          environment={makeEnvironment()}
          onUpdate={() => {}}
        />
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
        />
      );

      // The abandoned failure must not paint an error over the new load.
      expect(screen.queryByText(/Extension settings could not be loaded/)).toBeNull();
      expect(screen.getByText(/Reading Claude, Codex, and OpenCode configuration/)).toBeTruthy();
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
      />
    );
    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());

    rerender(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment({ id: "env-2" })}
        onUpdate={() => {}}
      />
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
      />
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
      />
    );
    await waitFor(() => expect(screen.getByText("claude-docs")).toBeTruthy());
    const localMenu = capturedMenuItems.map((item) => item.id);
    expect(localMenu).toContain("extensions");
    // Local environments have no container network or port settings.
    expect(localMenu).not.toContain("ports");
  });
});
