import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const invokeMock = mock<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve());

mock.module("@/lib/native/backend", () => ({
  invoke: invokeMock,
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({
    invoke: mock(() => Promise.resolve()),
  }));
});

const wrapperModulePath = "./backend.ts?wrapper-test";
const originalOrkestrator = window.orkestrator;
const originalGateway = window.orkestratorGateway;
const originalWindowOpen = window.open;
const backendWrappers = await import(wrapperModulePath) as typeof import("./backend");
const {
  connectLinear,
  createEnvironment,
  createLocalTerminalSession,
  createTerminalSession,
  disconnectLinear,
  ensureEnvironmentSetup,
  deletePaneLayout,
  getEnvironmentSnapshots,
  getPaneLayout,
  getLinearConnection,
  getLinearIssue,
  getLinearIssues,
  getSetupCommands,
  getGatewayTokenSettings,
  getWebClientStatus,
  postLinearCompletionComment,
  openInBrowser,
  recordEnvironmentActivity,
  runEnvironmentSetup,
  resetWebClientServe,
  savePaneLayout,
  setWebClientEnabled,
  setGatewayToken,
  setEnvironmentSetupComplete,
} = backendWrappers;

afterEach(() => {
  window.orkestrator = originalOrkestrator;
  window.orkestratorGateway = originalGateway;
  window.open = originalWindowOpen;
});

describe("backend setup wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  test("calls the setup-complete Electron command with the expected payload", async () => {
    await setEnvironmentSetupComplete("env-1", true);

    expect(invokeMock.mock.calls).toEqual([
      ["set_environment_setup_complete", { environmentId: "env-1", complete: true }],
    ]);
  });

  test("calls the get-setup-commands Electron command with the environment id", async () => {
    invokeMock.mockResolvedValue(["bun install"]);

    const commands = await getSetupCommands("env-1");

    expect(commands).toEqual(["bun install"]);
    expect(invokeMock.mock.calls).toEqual([
      ["get_setup_commands", { environmentId: "env-1" }],
    ]);
  });

  test("calls the run-environment-setup Electron command with the environment id", async () => {
    await runEnvironmentSetup("env-1");

    expect(invokeMock.mock.calls).toEqual([
      ["run_environment_setup", { environmentId: "env-1" }],
    ]);
  });

  test("calls the ensure-environment-setup Electron command with the environment id", async () => {
    await ensureEnvironmentSetup("env-1");

    expect(invokeMock.mock.calls).toEqual([
      ["ensure_environment_setup", { environmentId: "env-1" }],
    ]);
  });

  test("calls the create-environment Electron command with naming prompt", async () => {
    await createEnvironment(
      "project-1",
      undefined,
      "restricted",
      undefined,
      [{ hostPort: 5173, containerPort: 5173, protocol: "tcp" }],
      "containerized",
      "Build task\n\nShip the feature",
    );

    expect(invokeMock.mock.calls).toEqual([
      ["create_environment", {
        projectId: "project-1",
        name: undefined,
        networkAccessMode: "restricted",
        initialPrompt: undefined,
        portMappings: [{ hostPort: 5173, containerPort: 5173, protocol: "tcp" }],
        environmentType: "containerized",
        namingPrompt: "Build task\n\nShip the feature",
      }],
    ]);
  });

  test("calls the read-only environment snapshot command", async () => {
    invokeMock.mockResolvedValue([]);

    await expect(getEnvironmentSnapshots("project-1")).resolves.toEqual([]);
    expect(invokeMock.mock.calls).toEqual([
      ["get_environment_snapshots", { projectId: "project-1" }],
    ]);
  });

  test("records environment activity with the supplied occurrence time", async () => {
    const occurredAt = "2026-07-23T11:12:13.000Z";
    await recordEnvironmentActivity("env-1", occurredAt);

    expect(invokeMock.mock.calls).toEqual([
      ["record_environment_activity", { environmentId: "env-1", occurredAt }],
    ]);
  });

  test("creates environment-tracked local and container terminal sessions", async () => {
    invokeMock.mockResolvedValueOnce("local-session");
    await expect(createLocalTerminalSession("env-local", 100, 30, true))
      .resolves.toBe("local-session");

    invokeMock.mockResolvedValueOnce("container-session");
    await expect(createTerminalSession(
      "container-1",
      120,
      40,
      undefined,
      true,
    )).resolves.toBe("container-session");

    expect(invokeMock.mock.calls).toEqual([
      ["create_local_terminal_session", {
        environmentId: "env-local",
        cols: 100,
        rows: 30,
        trackEnvironmentActivity: true,
      }],
      ["create_terminal_session", {
        containerId: "container-1",
        cols: 120,
        rows: 40,
        user: undefined,
        trackEnvironmentActivity: true,
      }],
    ]);
  });

  test("calls Linear Electron commands with expected payloads", async () => {
    await getLinearConnection();
    await connectLinear("lin_api_secret");
    await getLinearIssues();
    await getLinearIssue("ENG-123");
    await postLinearCompletionComment("pipeline-1", "issue-1", "Done");
    await disconnectLinear();

    expect(invokeMock.mock.calls).toEqual([
      ["get_linear_connection"],
      ["connect_linear", { apiKey: "lin_api_secret" }],
      ["get_linear_issues"],
      ["get_linear_issue", { issueId: "ENG-123" }],
      ["post_linear_completion_comment", {
        pipelineId: "pipeline-1",
        issueId: "issue-1",
        body: "Done",
      }],
      ["disconnect_linear"],
    ]);
  });
});

describe("backend pane layout wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  test("forwards exact pane layout command payloads and results", async () => {
    const layout = {
      version: 1,
      environmentId: "env-1",
      containerId: "container-1",
      activePaneId: "pane-1",
      root: { kind: "leaf", id: "pane-1", tabs: [], activeTabId: null },
      updatedAt: "2026-07-16T00:00:00.000Z",
      revision: 2,
    };
    invokeMock.mockResolvedValueOnce(layout);
    await expect(getPaneLayout("env-1")).resolves.toEqual(layout);

    invokeMock.mockResolvedValueOnce(layout);
    await expect(savePaneLayout("env-1", {
      version: layout.version,
      containerId: layout.containerId,
      activePaneId: layout.activePaneId,
      root: layout.root,
    })).resolves.toEqual(layout);
    await expect(deletePaneLayout("env-1")).resolves.toBeUndefined();

    expect(invokeMock.mock.calls).toEqual([
      ["get_pane_layout", { environmentId: "env-1" }],
      ["save_pane_layout", {
        environmentId: "env-1",
        layout: {
          version: 1,
          containerId: "container-1",
          activePaneId: "pane-1",
          root: layout.root,
        },
      }],
      ["delete_pane_layout", { environmentId: "env-1" }],
    ]);
  });
});

describe("backend web client wrappers", () => {
  test("uses the Electron preload API for status and transitions", async () => {
    const status = { enabled: true, running: true, url: "http://100.88.12.3:34121/", error: null };
    const getStatus = mock(async () => status);
    const setEnabled = mock(async (enabled: boolean) => ({
      ...status,
      enabled,
      running: enabled,
      url: enabled ? status.url : null,
    }));
    const resetServe = mock(async () => status);
    const tokenSettings = { token: "test-token-123456", editable: true, source: "file" as const };
    const getTokenSettings = mock(async () => tokenSettings);
    const setToken = mock(async (token: string) => ({ ...tokenSettings, token }));
    window.orkestrator = {
      ...originalOrkestrator!,
      webClient: { getStatus, setEnabled, resetServe, getTokenSettings, setToken },
    };

    await expect(getWebClientStatus()).resolves.toEqual(status);
    await expect(setWebClientEnabled(false)).resolves.toMatchObject({ enabled: false, running: false });
    await expect(resetWebClientServe()).resolves.toEqual(status);
    await expect(getGatewayTokenSettings()).resolves.toEqual(tokenSettings);
    await expect(setGatewayToken("replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(resetServe).toHaveBeenCalledTimes(1);
    expect(setToken).toHaveBeenCalledWith("replacement-token-123456");
  });

  test("reports the current browser origin as running in authenticated gateway mode", async () => {
    window.orkestrator = undefined;
    window.orkestratorGateway = { enabled: true };

    await expect(getWebClientStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      url: `${window.location.origin}/`,
      error: null,
    });
  });

  test("reports the configured direct backend origin in public-client mode", async () => {
    window.orkestrator = undefined;
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };

    await expect(getWebClientStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      url: "https://workstation.tailnet.ts.net/",
      error: null,
    });
  });

  test("rejects status and mutations outside Electron or gateway mode", async () => {
    window.orkestrator = undefined;
    window.orkestratorGateway = undefined;

    await expect(getWebClientStatus()).rejects.toThrow("only available in the desktop app");
    await expect(setWebClientEnabled(true)).rejects.toThrow("only available in the desktop app");
    await expect(resetWebClientServe()).rejects.toThrow("only available for the local desktop app");
    await expect(getGatewayTokenSettings()).rejects.toThrow("unavailable");
    await expect(setGatewayToken("replacement-token-123456")).rejects.toThrow("unavailable");
  });
});

describe("backend command wrapper coverage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: unknown) =>
      command === "read_file_base64" ? btoa("binary") : undefined
    );
    window.orkestrator = originalOrkestrator;
    window.orkestratorGateway = originalGateway;
  });

  test("prefers the native browser opener when Electron also exposes gateway metadata", async () => {
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net",
    };

    await openInBrowser("https://example.com/docs");

    expect(invokeMock).toHaveBeenCalledWith("open_in_browser", {
      url: "https://example.com/docs",
    });
  });

  test("opens browser-gateway links in a client-side tab", async () => {
    const windowOpen = mock(() => null);
    window.open = windowOpen as typeof window.open;
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net",
    };

    await openInBrowser("https://example.com/docs");

    expect(windowOpen).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("every exported command wrapper reaches the native invoke boundary", async () => {
    const specialWrappers = new Set([
      "getWebClientStatus",
      "setWebClientEnabled",
      "resetWebClientServe",
      "getGatewayTokenSettings",
      "setGatewayToken",
      "readBinaryFile",
    ]);
    const commandWrappers = Object.entries(backendWrappers).flatMap(([name, value]) =>
      typeof value === "function" && !specialWrappers.has(name)
        ? [[name, value as (...args: unknown[]) => Promise<unknown>] as const]
        : []
    );

    expect(commandWrappers.length).toBeGreaterThan(150);
    for (const [name, wrapper] of commandWrappers) {
      invokeMock.mockClear();
      const args = Array.from({ length: wrapper.length }, () => "value");
      await wrapper(...args);
      expect(invokeMock.mock.calls.length, `${name} must call invoke`).toBeGreaterThan(0);
    }
  });

  test("readBinaryFile decodes the base64 wrapper result", async () => {
    await expect(backendWrappers.readBinaryFile("/tmp/image.bin")).resolves.toEqual(
      Uint8Array.from(new TextEncoder().encode("binary")),
    );
    expect(invokeMock).toHaveBeenCalledWith("read_file_base64", { filePath: "/tmp/image.bin" });
  });
});
