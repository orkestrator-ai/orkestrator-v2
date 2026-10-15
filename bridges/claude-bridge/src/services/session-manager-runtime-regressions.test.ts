import { describe, expect, mock, test } from "bun:test";
import {
  originalSpawn,
  abortSession,
  getPromptDispatchState,
  mockGetMcpRuntimeConfig,
  mockGetPluginsForSdk,
  mockReadFile,
  mockSdkGetSessionMessages,
  nextQueryCall,
  queryControlOverrides,
  releaseWithBackgroundWork,
  sendPrompt,
  waitFor,
  rewindSessionFiles,
  transcriptWithToolResult,
  PERSISTED_SDK_ID,
  U1,
} from "./session-manager-test-harness.js";
import {
  applyClaudeLiveSettings,
  assertClaudeRuntimeAccepts,
  claudeLiveSettings,
  openClaudeRuntime,
  retireDrainingClaudeRuntime,
  type ClaudeRuntime,
} from "./session-manager-runtime.js";
import { takeQueryControls } from "./session-manager-background-tasks.js";
import { sessionRuntimeHealthBody } from "../routes/runtime-health-body.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function noReplacement() {
  await expect(nextQueryCall(30)).rejects.toThrow();
}

describe("termination confirmation", () => {
  test.each(["throw", "hang"])("a %s close keeps an aborted runtime fenced", async (mode) => {
    const ended = deferred();
    const abortController = new AbortController();
    abortController.abort();
    const close = mock(() => {
      if (mode === "throw") throw new Error("private provider detail");
      return new Promise<void>(() => {});
    });
    const runtime = {
      state: "draining",
      abortController,
      ended: ended.promise,
      control: { close },
    } as unknown as ClaudeRuntime;
    const session = { claudeRuntime: runtime } as ClaudeRuntime["session"];
    await expect(retireDrainingClaudeRuntime(session, 2)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(session.claudeRuntime).toBe(runtime);
    expect(close).toHaveBeenCalledTimes(1);
    ended.resolve();
    await retireDrainingClaudeRuntime(session, 2);
  });

  test("retirement stays fenced until a real child has exited", async () => {
    const child = originalSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const ended = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    ended.catch(() => {});
    const runtime = {
      state: "draining",
      abortController: new AbortController(),
      ended,
      control: {
        close: () => {
          throw new Error("close failed");
        },
      },
    } as unknown as ClaudeRuntime;
    const session = { claudeRuntime: runtime } as ClaudeRuntime["session"];
    try {
      await expect(retireDrainingClaudeRuntime(session, 10)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(child.exitCode).toBeNull();
      child.kill("SIGTERM");
      await ended;
      await retireDrainingClaudeRuntime(session, 10);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await ended;
    }
  });

  test("abort immediately followed by a prompt waits for the prior consumer to end", async () => {
    const gate = deferred();
    queryControlOverrides.beforeExit = () => gate.promise;
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("abort fence");
    const second = sendPrompt(session.id, "work");
    await input.next();
    await firstPrompt;
    abortSession(session.id);
    expect(openClaudeRuntime(session)).toBeUndefined();
    const replacement = sendPrompt(session.id, "after abort");
    await noReplacement();
    expect(session.claudeRuntime?.state).toBe("draining");
    gate.resolve();
    delete queryControlOverrides.beforeExit;
    const fresh = await nextQueryCall();
    expect(fresh).not.toBe(call);
    fresh.push({ type: "result", subtype: "success" });
    fresh.finish();
    await Promise.all([second, replacement]);
  });

  test("taking teardown ownership immediately removes the runtime from live readers", async () => {
    const { session, call, firstPrompt } = await releaseWithBackgroundWork("teardown fence");
    const runtime = session.claudeRuntime!;
    const controls = takeQueryControls(session);
    expect(controls.has(runtime.control)).toBe(true);
    expect(runtime.state).toBe("draining");
    expect(runtime.abortController.signal.aborted).toBe(true);
    expect(openClaudeRuntime(session)).toBeUndefined();
    call.finish();
    await firstPrompt;
  });
});

describe("retained launch configuration", () => {
  test.each([false, true])(
    "context and suggestions toggle from %s is refused before dispatch",
    async (enabled) => {
      for (const setting of ["context1m", "promptSuggestions"] as const) {
        const options =
          setting === "context1m"
            ? { parameterValues: { context1m: enabled } }
            : { promptSuggestions: enabled };
        const { session, call, firstPrompt } = await releaseWithBackgroundWork(
          setting,
          "agent-bg",
          options,
        );
        const changed =
          setting === "context1m"
            ? { parameterValues: { context1m: !enabled } }
            : { promptSuggestions: !enabled };
        const rows = session.messages.length;
        await expect(
          sendPrompt(session.id, "change", { ...changed, requestId: "refused" }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(session.messages).toHaveLength(rows);
        expect(getPromptDispatchState(session.id, "refused")).toBe("new");
        await noReplacement();
        call.finish();
        await firstPrompt;
      }
    },
  );

  test.each(["disabled", "budget-2048"])("adaptive cannot reset a %s launch", async (thinking) => {
    const setMaxThinkingTokens = mock(async () => {});
    queryControlOverrides.setMaxThinkingTokens = setMaxThinkingTokens;
    const { session, call, firstPrompt } = await releaseWithBackgroundWork("thinking", "agent-bg", {
      parameterValues: { thinking },
    });
    await expect(
      sendPrompt(session.id, "adaptive", { parameterValues: { thinking: "adaptive" } }),
    ).rejects.toMatchObject({ code: "conflict" });
    // The SDK's null means reset to spawn-time mode, not enable adaptive. Even
    // direct live-control application must reject before sending that reset.
    await expect(
      applyClaudeLiveSettings(
        session.claudeRuntime!,
        claudeLiveSettings({
          model: undefined,
          permissionMode: "default",
          effort: "high",
          fastMode: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(setMaxThinkingTokens).not.toHaveBeenCalled();
    call.finish();
    await firstPrompt;
  });

  test.each([
    ["ask", "default"],
    ["deny", "default"],
  ] as const)(
    "an %s runtime joins a bypassPermissions prompt in %s mode",
    async (approvals, expectedMode) => {
      // The backend sends bypassPermissions with every build prompt. The policy
      // caps it, so leaving plan mode neither conflicts nor widens the session.
      const setPermissionMode = mock(async (_mode: string) => {});
      queryControlOverrides.setPermissionMode = setPermissionMode;
      const { session, call, input, firstPrompt } = await releaseWithBackgroundWork(
        `${approvals} capability`,
        "agent-bg",
        { permissionMode: "plan" },
        {
          id: "interactive-host",
          approvals,
          sandbox: "provider",
          projectResources: true,
          networkAccess: "full",
        },
      );
      expect(call.options.allowDangerouslySkipPermissions).toBeUndefined();
      const secondPrompt = sendPrompt(session.id, "build", {
        permissionMode: "bypassPermissions",
      });
      await input.next();
      await firstPrompt;
      expect(setPermissionMode).toHaveBeenCalledWith(expectedMode);
      expect(setPermissionMode).not.toHaveBeenCalledWith("bypassPermissions");
      call.finish();
      await secondPrompt.catch(() => undefined);
    },
  );

  test("a plugin change is refused by pre-dispatch validation and direct send", async () => {
    const { session, call, firstPrompt } = await releaseWithBackgroundWork("plugin change");
    mockGetPluginsForSdk.mockImplementation(async () => [
      { type: "local", path: "/test/new-plugin" },
    ]);
    await expect(assertClaudeRuntimeAccepts(session, undefined)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(sendPrompt(session.id, "new plugin")).rejects.toMatchObject({ code: "conflict" });
    expect(session.status).toBe("idle");
    await noReplacement();
    call.finish();
    await firstPrompt;
  });

  test.each(["token-B", ""])(
    "credential rotation or clearing is refused (%s)",
    async (nextToken) => {
      const previous = process.env.ORKESTRATOR_GITHUB_CREDENTIAL_FILE;
      process.env.ORKESTRATOR_GITHUB_CREDENTIAL_FILE = "/test/credential";
      let token = "token-A";
      const originalReader = mockReadFile.getMockImplementation()!;
      mockReadFile.mockImplementation((path, ...args) =>
        path === "/test/credential"
          ? (Promise.resolve(token) as ReturnType<typeof originalReader>)
          : originalReader(path, ...args),
      );
      try {
        const { session, call, firstPrompt } = await releaseWithBackgroundWork("credentials");
        token = nextToken;
        await expect(assertClaudeRuntimeAccepts(session, undefined)).rejects.toMatchObject({
          code: "conflict",
        });
        await expect(sendPrompt(session.id, "rotated")).rejects.toMatchObject({ code: "conflict" });
        expect(JSON.stringify(session.claudeRuntime!.launch)).not.toContain("token-A");
        expect(session.status).toBe("idle");
        await noReplacement();
        call.finish();
        await firstPrompt;
      } finally {
        if (previous === undefined) delete process.env.ORKESTRATOR_GITHUB_CREDENTIAL_FILE;
        else process.env.ORKESTRATOR_GITHUB_CREDENTIAL_FILE = previous;
      }
    },
  );
});

describe("join setup", () => {
  test("failed MCP connection leaves revision pending and identical input retries", async () => {
    const setMcpServers = mock(async () => ({
      added: [],
      removed: [],
      errors: { required: "private connection detail" },
    }));
    queryControlOverrides.setMcpServers = setMcpServers;
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("mcp retry");
    const runtime = session.claudeRuntime!;
    const generation = session.latestTurnGeneration;
    const applied = session.mcpConfigRevision;
    const config = {
      servers: { required: { type: "http" as const, url: "http://localhost/mcp" } },
      names: new Set(["required"]),
      revision: { fingerprint: "saved", sources: { user: "new", project: "absent" }, scope: "all" },
    };
    mockGetMcpRuntimeConfig.mockImplementation(async () => config);
    await expect(sendPrompt(session.id, "use mcp", { requestId: "retry" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(runtime.mcpServers).toBe("");
    expect(sessionRuntimeHealthBody(session).mcpConfig).toEqual(applied);
    expect(session.latestTurnGeneration).toBe(generation);
    expect(session.status).toBe("idle");
    expect(getPromptDispatchState(session.id, "retry")).toBe("new");
    expect(call.isClosed()).toBe(false);
    await noReplacement();
    setMcpServers.mockImplementation(async () => ({
      added: ["required"],
      removed: [],
      errors: {},
    }));
    const retry = sendPrompt(session.id, "use mcp", { requestId: "retry" });
    expect((await input.next()).done).toBe(false);
    expect(setMcpServers).toHaveBeenCalledTimes(2);
    expect(session.mcpConfigRevision?.fingerprint).toBe("saved");
    call.finish();
    await Promise.all([firstPrompt, retry]);
  });

  test("required injected servers must be connected before prompt input", async () => {
    const update = mock(async () => ({ added: ["orkestrator"], removed: [], errors: {} }));
    const status = mock(async () => [{ name: "orkestrator", status: "failed" }]);
    queryControlOverrides.setMcpServers = update;
    queryControlOverrides.mcpServerStatus = status;
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("required mcp");
    const applied = session.mcpConfigRevision;
    mockGetMcpRuntimeConfig.mockImplementation(async () => ({
      servers: { orkestrator: { type: "http", url: "http://localhost/mcp" } },
      names: new Set(["orkestrator"]),
      revision: {
        fingerprint: "injected",
        sources: { user: "absent", project: "absent" },
        scope: "all",
      },
    }));
    const options = { agentMcp: { url: "http://localhost/mcp", token: "test-token" } };
    await expect(sendPrompt(session.id, "requires tool", options)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(session.mcpConfigRevision).toBe(applied);
    expect(session.claudeRuntime!.mcpServers).toBe("");
    await noReplacement();
    status.mockImplementation(async () => [{ name: "orkestrator", status: "connected" }]);
    const retry = sendPrompt(session.id, "requires tool", options);
    expect((await input.next()).done).toBe(false);
    expect(update).toHaveBeenCalledTimes(2);
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => session.status === "idle");
    status.mockImplementation(async () => [{ name: "orkestrator", status: "pending" }]);
    await expect(sendPrompt(session.id, "same configuration", options)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(session.claudeRuntime!.mcpServers).toBe("");
    call.finish();
    await Promise.all([firstPrompt, retry]);
  });

  test.each(["settings", "submission"])(
    "a %s failure preserves shared background work and generation",
    async (failure) => {
      const setModel = mock(async () => {});
      queryControlOverrides.setModel = setModel;
      const { session, call, firstPrompt } = await releaseWithBackgroundWork("setup failure");
      const runtime = session.claudeRuntime!;
      const generation = session.latestTurnGeneration;
      if (failure === "settings")
        setModel.mockImplementation(async () => {
          throw new Error("control failed");
        });
      else runtime.input.push = () => false;
      await expect(sendPrompt(session.id, "follow up")).rejects.toThrow();
      expect(session.status).toBe("idle");
      expect(session.latestTurnGeneration).toBe(generation);
      expect(session.backgroundTasks?.["agent-bg"]?.status).toBe("running");
      expect(runtime.state).toBe("open");
      expect(call.isClosed()).toBe(false);
      await noReplacement();
      call.finish();
      await firstPrompt;
    },
  );

  test("a continuation during awaited settings cannot drain the CLI under the follow-up", async () => {
    const gate = deferred();
    let setting = false;
    queryControlOverrides.setModel = async () => {
      setting = true;
      await gate.promise;
    };
    const { session, call, input, firstPrompt } = await releaseWithBackgroundWork("handoff");
    const second = sendPrompt(session.id, "next");
    await waitFor(() => setting);
    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "agent-bg",
      status: "completed",
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => session.backgroundTasks?.["agent-bg"]?.status === "completed");
    await noReplacement();
    expect(session.claudeRuntime?.state).toBe("open");
    gate.resolve();
    expect((await input.next()).done).toBe(false);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await Promise.all([firstPrompt, second]);
  });

  test("rewind after abort waits for exit and never uses the teardown handle", async () => {
    const gate = deferred();
    const liveRewind = mock(async () => ({ canRewind: true }));
    queryControlOverrides.beforeExit = () => gate.promise;
    queryControlOverrides.rewindFiles = liveRewind;
    const { session, input, firstPrompt } = await releaseWithBackgroundWork("rewind fence");
    session.sdkSessionId = PERSISTED_SDK_ID;
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    const second = sendPrompt(session.id, "work");
    await input.next();
    await firstPrompt;
    abortSession(session.id);
    const rewind = rewindSessionFiles(session.id, U1);
    await noReplacement();
    expect(liveRewind).not.toHaveBeenCalled();
    gate.resolve();
    delete queryControlOverrides.beforeExit;
    const transient = await nextQueryCall();
    transient.push({ type: "system", subtype: "init" });
    await rewind;
    transient.finish();
    await second;
    expect(liveRewind).toHaveBeenCalledTimes(1);
    expect(transient.options.maxTurns).toBe(0);
  });
});
