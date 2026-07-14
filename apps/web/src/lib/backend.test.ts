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
const backendWrappers = await import(wrapperModulePath) as typeof import("./backend");
const {
  connectLinear,
  createEnvironment,
  disconnectLinear,
  ensureEnvironmentSetup,
  getEnvironmentSnapshots,
  getLinearConnection,
  getLinearIssue,
  getLinearIssues,
  getSetupCommands,
  getGatewayTokenSettings,
  getWebClientStatus,
  postLinearCompletionComment,
  runEnvironmentSetup,
  setWebClientEnabled,
  setGatewayToken,
  setEnvironmentSetupComplete,
} = backendWrappers;

afterEach(() => {
  window.orkestrator = originalOrkestrator;
  window.orkestratorGateway = originalGateway;
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
    const tokenSettings = { token: "test-token-123456", editable: true, source: "file" as const };
    const getTokenSettings = mock(async () => tokenSettings);
    const setToken = mock(async (token: string) => ({ ...tokenSettings, token }));
    window.orkestrator = {
      ...originalOrkestrator!,
      webClient: { getStatus, setEnabled, getTokenSettings, setToken },
    };

    await expect(getWebClientStatus()).resolves.toEqual(status);
    await expect(setWebClientEnabled(false)).resolves.toMatchObject({ enabled: false, running: false });
    await expect(getGatewayTokenSettings()).resolves.toEqual(tokenSettings);
    await expect(setGatewayToken("replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenCalledWith(false);
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

  test("every exported command wrapper reaches the native invoke boundary", async () => {
    const specialWrappers = new Set([
      "getWebClientStatus",
      "setWebClientEnabled",
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
