import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppConfig } from "@/types";

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
  getClaudeModelCatalog,
  getPaneLayout,
  getLinearConnection,
  getLinearIssue,
  getLinearIssues,
  getGitHubIssues,
  getGitHubIssue,
  updateGitHubIssue,
  updateGitHubIssueStatus,
  closeGitHubIssue,
  addGitHubIssueComment,
  updateGitHubIssueComment,
  postGitHubCompletionComment,
  getSetupCommands,
  getGatewayTokenSettings,
  getWebClientStatus,
  postLinearCompletionComment,
  openInBrowser,
  recordEnvironmentActivity,
  recordEnvironmentCompletion,
  runEnvironmentSetup,
  resetWebClientServe,
  savePaneLayout,
  setWebClientEnabled,
  setGatewayToken,
  setGitHubToken,
  setEnvironmentSetupComplete,
  setEnvironmentUnread,
  setEnvironmentPendingAgentLaunch,
  setEnvironmentInitialPrompt,
  updateAgentModelDefault,
  updateEnvironmentAgentSettings,
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

  test("persists the durable post-setup agent launch flag", async () => {
    await setEnvironmentPendingAgentLaunch("env-1", false);

    expect(invokeMock.mock.calls).toEqual([
      ["set_environment_pending_agent_launch", {
        environmentId: "env-1",
        pending: false,
      }],
    ]);
  });

  test("configures an environment and its durable launch intent together", async () => {
    await updateEnvironmentAgentSettings(
      "env-1",
      "codex",
      null,
      null,
      null,
      "native",
      true,
    );

    expect(invokeMock.mock.calls).toEqual([
      ["update_environment_agent_settings", {
        environmentId: "env-1",
        defaultAgent: "codex",
        claudeMode: null,
        claudeNativeBackend: null,
        opencodeMode: null,
        codexMode: "native",
        pendingAgentLaunch: true,
      }],
    ]);
  });

  test("omits the launch intent key entirely when no launch is being configured", async () => {
    await updateEnvironmentAgentSettings("env-1", "codex", null, null, null, "native");

    // Omission is load-bearing: the settings dialog and FeaturesView both call
    // this while an environment may still be awaiting its launch, and sending
    // `false` would clear it.
    const [[command, args]] = invokeMock.mock.calls as [[string, Record<string, unknown>]];
    expect(command).toBe("update_environment_agent_settings");
    expect(args).not.toHaveProperty("pendingAgentLaunch");
  });

  test("records a cleared launch intent when one is explicitly configured off", async () => {
    await updateEnvironmentAgentSettings("env-1", "claude", "terminal", null, null, null, false);

    expect(invokeMock.mock.calls).toEqual([
      ["update_environment_agent_settings", {
        environmentId: "env-1",
        defaultAgent: "claude",
        claudeMode: "terminal",
        claudeNativeBackend: null,
        opencodeMode: null,
        codexMode: null,
        pendingAgentLaunch: false,
      }],
    ]);
  });

  test("persists a rewritten initial prompt so a recovered launch keeps its attachment references", async () => {
    await setEnvironmentInitialPrompt("env-1", "Fix it [img](/work/a.png)");

    expect(invokeMock.mock.calls).toEqual([
      ["set_environment_initial_prompt", {
        environmentId: "env-1",
        initialPrompt: "Fix it [img](/work/a.png)",
      }],
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

  test("requests an environment-scoped Claude model catalog refresh", async () => {
    const snapshot = {
      environmentId: "env-1",
      models: [{ id: "claude-opus-5", name: "Claude Opus 5" }],
      source: "sdk" as const,
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
    };
    invokeMock.mockResolvedValue(snapshot);

    await expect(getClaudeModelCatalog("env-1", true)).resolves.toEqual(snapshot);
    expect(invokeMock).toHaveBeenCalledWith("get_claude_model_catalog", {
      environmentId: "env-1",
      forceRefresh: true,
    });
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

  test("persists a build pipeline association when creating an environment", async () => {
    await createEnvironment(
      "project-1",
      undefined,
      "full",
      undefined,
      undefined,
      "local",
      undefined,
      "pipeline-42",
    );

    expect(invokeMock.mock.calls).toEqual([
      ["create_environment", {
        projectId: "project-1",
        name: undefined,
        networkAccessMode: "full",
        initialPrompt: undefined,
        portMappings: undefined,
        environmentType: "local",
        namingPrompt: undefined,
        buildPipelineId: "pipeline-42",
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

  test("records completed activity atomically with the supplied occurrence time", async () => {
    const occurredAt = "2026-07-23T11:12:14.000Z";
    await recordEnvironmentCompletion("env-1", occurredAt);

    expect(invokeMock.mock.calls).toEqual([
      ["record_environment_completion", { environmentId: "env-1", occurredAt }],
    ]);
  });

  test("guards unread clears with the activity token observed by the client", async () => {
    await setEnvironmentUnread("env-1", false, "2026-07-23T11:12:14.000Z");

    expect(invokeMock.mock.calls).toEqual([
      ["set_environment_unread", {
        environmentId: "env-1",
        unread: false,
        expectedLastActivityAt: "2026-07-23T11:12:14.000Z",
      }],
    ]);

    invokeMock.mockClear();
    await setEnvironmentUnread("env-legacy", false, null);
    expect(invokeMock).toHaveBeenCalledWith("set_environment_unread", {
      environmentId: "env-legacy",
      unread: false,
      expectedLastActivityAt: null,
    });
  });

  test("forwards revisioned build-pipeline persistence payloads exactly", async () => {
    const snapshot = { status: "running", taskIndex: 2 };

    await backendWrappers.getBuildPipeline("pipeline-1");
    await backendWrappers.listBuildPipelines("project-1");
    await backendWrappers.saveBuildPipeline(
      "pipeline-1",
      "project-1",
      "env-1",
      3,
      snapshot,
      7,
    );
    await backendWrappers.deleteBuildPipeline("pipeline-1");

    expect(invokeMock.mock.calls).toEqual([
      ["get_build_pipeline", { pipelineId: "pipeline-1" }],
      ["list_build_pipelines", { projectId: "project-1" }],
      ["save_build_pipeline", {
        pipelineId: "pipeline-1",
        projectId: "project-1",
        environmentId: "env-1",
        version: 3,
        snapshot,
        expectedRevision: 7,
      }],
      ["delete_build_pipeline", { pipelineId: "pipeline-1" }],
    ]);
  });

  test("forwards prompt-queue persistence and atomic claim payloads exactly", async () => {
    const messages = [{ id: "message-1", text: "Ship it" }];

    await backendWrappers.getPromptQueue("codex\u0000env-1:tab-1");
    await backendWrappers.listPromptQueues("env-1");
    await backendWrappers.savePromptQueue(
      "codex\u0000env-1:tab-1",
      "env-1",
      messages,
      4,
    );
    await backendWrappers.claimPromptQueueHead(
      "codex\u0000env-1:tab-1",
      "env-1",
      "message-1",
      messages,
    );

    expect(invokeMock.mock.calls).toEqual([
      ["get_prompt_queue", { queueKey: "codex\u0000env-1:tab-1" }],
      ["list_prompt_queues", { environmentId: "env-1" }],
      ["save_prompt_queue", {
        queueKey: "codex\u0000env-1:tab-1",
        environmentId: "env-1",
        messages,
        expectedRevision: 4,
      }],
      ["claim_prompt_queue_head", {
        queueKey: "codex\u0000env-1:tab-1",
        environmentId: "env-1",
        expectedMessageId: "message-1",
        candidateMessages: messages,
      }],
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

  test("calls GitHub issue Electron commands with project-scoped payloads", async () => {
    await getGitHubIssues("project-1");
    await getGitHubIssue("project-1", 42);
    await updateGitHubIssue("project-1", 42, { title: "Title", body: "Body" });
    await updateGitHubIssueStatus("project-1", 42, "inprogress");
    await addGitHubIssueComment("project-1", 42, "Comment");
    await updateGitHubIssueComment("project-1", 42, 9001, "Edited");
    await closeGitHubIssue("project-1", 42);
    await postGitHubCompletionComment(
      "pipeline-1",
      "project-1",
      "acme",
      "widget",
      42,
      "Build completed",
    );

    expect(invokeMock.mock.calls).toEqual([
      ["get_github_issues", { projectId: "project-1" }],
      ["get_github_issue", { projectId: "project-1", issueNumber: 42 }],
      ["update_github_issue", {
        projectId: "project-1",
        issueNumber: 42,
        title: "Title",
        body: "Body",
      }],
      ["update_github_issue_status", {
        projectId: "project-1",
        issueNumber: 42,
        status: "inprogress",
      }],
      ["add_github_issue_comment", {
        projectId: "project-1",
        issueNumber: 42,
        body: "Comment",
      }],
      ["update_github_issue_comment", {
        projectId: "project-1",
        issueNumber: 42,
        commentId: 9001,
        body: "Edited",
      }],
      ["close_github_issue", { projectId: "project-1", issueNumber: 42 }],
      ["post_github_completion_comment", {
        pipelineId: "pipeline-1",
        projectId: "project-1",
        repositoryOwner: "acme",
        repositoryName: "widget",
        issueNumber: 42,
        body: "Build completed",
      }],
    ]);
  });

  test("uses the write-only GitHub token command for replacement and clearing", async () => {
    const configured = {
      version: "1.0",
      global: { githubTokenConfigured: true },
      repositories: {},
    } as AppConfig;
    const cleared = {
      version: "1.0",
      global: { githubTokenConfigured: false },
      repositories: {},
    } as AppConfig;
    invokeMock.mockResolvedValueOnce(configured).mockResolvedValueOnce(cleared);

    await expect(setGitHubToken("ghp_replacement")).resolves.toBe(configured);
    await expect(setGitHubToken(null)).resolves.toBe(cleared);

    expect(invokeMock.mock.calls).toEqual([
      ["set_github_token", { token: "ghp_replacement" }],
      ["set_github_token", { token: null }],
    ]);
  });

  test("forwards each agent model default under the single-key command", async () => {
    const updated = {
      version: "1.0",
      global: { codexModel: "gpt-5.4-codex" },
      repositories: {},
    } as AppConfig;
    invokeMock.mockResolvedValue(updated);

    await expect(updateAgentModelDefault("codexModel", "gpt-5.4-codex")).resolves.toBe(updated);
    expect(invokeMock).toHaveBeenCalledWith("update_agent_model_default", {
      key: "codexModel",
      modelId: "gpt-5.4-codex",
    });

    await updateAgentModelDefault("claudeModel", "claude-opus-4");
    await updateAgentModelDefault("opencodeModel", "opencode/gpt-5.4");
    expect(invokeMock.mock.calls).toEqual([
      ["update_agent_model_default", { key: "codexModel", modelId: "gpt-5.4-codex" }],
      ["update_agent_model_default", { key: "claudeModel", modelId: "claude-opus-4" }],
      ["update_agent_model_default", { key: "opencodeModel", modelId: "opencode/gpt-5.4" }],
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

  test("forwards PR verification and deterministic package-generation inputs", async () => {
    invokeMock.mockResolvedValueOnce({
      url: "https://github.com/acme/repo/pull/42",
      headRefName: "feature/review",
      baseRefName: "main",
      state: "OPEN",
    });
    await backendWrappers.verifyEnvironmentPr(
      "env-1",
      "https://github.com/acme/repo/pull/42",
      "main",
    );
    expect(invokeMock).toHaveBeenLastCalledWith("verify_environment_pr", {
      environmentId: "env-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      targetBranch: "main",
    });

    const preparation = {
      validation: [{
        command: "bun test",
        status: "passed" as const,
        exitCode: 0,
        stdoutPath: ".orkestrator/review-artifacts/package-1/validation-01.stdout.txt",
        stderrPath: ".orkestrator/review-artifacts/package-1/validation-01.stderr.txt",
        durationMs: 42,
        limitation: null,
      }],
      uncommittedFiles: [],
      limitations: [],
    };
    invokeMock.mockResolvedValueOnce({});
    await backendWrappers.generateLoopedReviewPackage(
      "env-1",
      "package-1",
      2,
      "main",
      preparation,
    );
    expect(invokeMock).toHaveBeenLastCalledWith(
      "generate_looped_review_package",
      {
        environmentId: "env-1",
        packageId: "package-1",
        round: 2,
        targetBranch: "main",
        preparation,
      },
    );
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

  test("getEnvironmentExtensions defaults to the cached backend result", async () => {
    await backendWrappers.getEnvironmentExtensions("env-1");

    expect(invokeMock).toHaveBeenCalledWith("get_environment_extensions", {
      environmentId: "env-1",
      refresh: false,
    });
  });

  test("getEnvironmentExtensions forwards an explicit refresh", async () => {
    await backendWrappers.getEnvironmentExtensions("env-1", { refresh: true });

    expect(invokeMock).toHaveBeenCalledWith("get_environment_extensions", {
      environmentId: "env-1",
      refresh: true,
    });
  });

  test("readBinaryFile decodes the base64 wrapper result", async () => {
    await expect(backendWrappers.readBinaryFile("/tmp/image.bin")).resolves.toEqual(
      Uint8Array.from(new TextEncoder().encode("binary")),
    );
    expect(invokeMock).toHaveBeenCalledWith("read_file_base64", { filePath: "/tmp/image.bin" });
  });
});
