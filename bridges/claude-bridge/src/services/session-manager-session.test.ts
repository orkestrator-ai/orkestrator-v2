import { describe, expect, mock, test } from "bun:test";

import {
  IDLE_TRANSCRIPT_EVICTION_MS,
  createSession,
  dismissQuestion,
  evictIdleHydratedTranscripts,
  expectControlOnlyPrompt,
  getPendingPlanApprovals,
  getPendingQuestions,
  getSession,
  peekSession,
  getSessionActivity,
  hydratePersistedSessionMessages,
  materializePersistedSession,
  mockSdkGetSessionInfo,
  mockGetMcpRuntimeConfig,
  mockSdkGetSessionMessages,
  mockSpawn,
  nextQueryCall,
  queryControlOverrides,
  respondToPlanApproval,
  sdkSessionInfo,
  sendPrompt,
  track,
  transcriptWithToolResult,
  waitFor,
} from "./session-manager-test-harness.js";
import {
  performSessionMcpAction,
  readClaudeAuthStatus,
  readSessionMcpServers,
  resetClaudeCatalogCachesForTesting,
} from "./session-manager-catalog.js";

describe("catalog discovery caching", () => {
  test("passes the bridge marker to a metadata probe's Claude CLI environment", async () => {
    const previousBridgeMarker = process.env.ORKESTRATOR_NATIVE_AGENT_BRIDGE;
    process.env.ORKESTRATOR_NATIVE_AGENT_BRIDGE = "claude";
    try {
      resetClaudeCatalogCachesForTesting();
      queryControlOverrides.accountInfo = mock(async () => ({}));
      await readClaudeAuthStatus();
      const probe = await nextQueryCall();
      expect(typeof probe.prompt).not.toBe("string");
      expect(probe.options).toMatchObject({
        env: { ORKESTRATOR_NATIVE_AGENT_BRIDGE: "claude" },
      });
      expect(probe.isClosed()).toBe(true);
    } finally {
      if (previousBridgeMarker === undefined) delete process.env.ORKESTRATOR_NATIVE_AGENT_BRIDGE;
      else process.env.ORKESTRATOR_NATIVE_AGENT_BRIDGE = previousBridgeMarker;
    }
  });

  test("backs off repeated failing authentication probes", async () => {
    resetClaudeCatalogCachesForTesting();
    const accountInfo = mock(async () => {
      throw new Error("probe failed");
    });
    queryControlOverrides.accountInfo = accountInfo;

    expect((await readClaudeAuthStatus()).state).toBe("unknown");
    expect((await readClaudeAuthStatus()).state).toBe("unknown");
    expect(accountInfo).toHaveBeenCalledTimes(1);
  });
});

describe("idle MCP catalogue", () => {
  test("retains inventory and performs actions after the turn query is released", async () => {
    const reconnect = mock(async () => undefined);
    queryControlOverrides.mcpServerStatus = async () => [
      {
        name: "docs",
        status: "connected",
        scope: "project",
        tools: [{ name: "search" }],
      },
    ];
    queryControlOverrides.reconnectMcpServer = reconnect;
    const session = createSession();
    track(session.id);
    const promptPromise = sendPrompt(session.id, "inspect MCP state");
    const call = await nextQueryCall();
    expect(await readSessionMcpServers(session.id)).toEqual([
      expect.objectContaining({ id: "docs", status: "connected", toolCount: 1 }),
    ]);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    // Turn completion releases the foreground before the runtime observes EOF.
    // Wait for the CLI to exit so the action exercises the metadata fallback.
    await waitFor(() => session.claudeRuntime === undefined);
    expect(session.queryControl).toBeUndefined();

    expect(await readSessionMcpServers(session.id)).toEqual([
      expect.objectContaining({ id: "docs", status: "connected", toolCount: 1 }),
    ]);
    await performSessionMcpAction(session.id, "docs", "reconnect");
    await expectControlOnlyPrompt(await nextQueryCall());
    expect(reconnect).toHaveBeenCalledWith("docs");

    // A sign-in link arrives only through a live CLI's `onElicitation`; a
    // probe would send it nowhere, so the action is refused instead.
    reconnect.mockClear();
    await expect(performSessionMcpAction(session.id, "docs", "sign-in")).rejects.toThrow(
      "only while this session's Claude is running",
    );
    expect(reconnect).not.toHaveBeenCalled();
  });
});

describe("an MCP action through a probe", () => {
  const CONFIG_LAYERS = new Map([
    ["docs", "project"],
    ["late", "project"],
    ["orkestrator", "orkestrator"],
  ]);
  const sessionReport = [
    { name: "docs", status: "connected", scope: "dynamic", tools: [{ name: "search" }] },
    { name: "late", status: "failed", scope: "dynamic", error: "exited" },
    { name: "orkestrator", status: "connected", scope: "dynamic", tools: [{ name: "ticket" }] },
  ];
  // A bare CLI: no injected server, and the layers it read for itself.
  const probeReport = (late: Record<string, unknown>) => [
    { name: "docs", status: "failed", scope: "user", error: "the probe's own view" },
    { name: "late", scope: "user", ...late },
    { name: "only-the-probe-sees-this", status: "connected", scope: "user" },
  ];

  /** A session whose CLI reported `sessionReport` and has since exited. */
  async function sessionWithoutCli() {
    const base = mockGetMcpRuntimeConfig.getMockImplementation()!;
    mockGetMcpRuntimeConfig.mockImplementationOnce(async () => ({
      ...(await base()),
      layers: CONFIG_LAYERS,
    }));
    queryControlOverrides.mcpServerStatus = async () => sessionReport;
    const session = createSession();
    track(session.id);
    const promptPromise = sendPrompt(session.id, "inspect MCP state");
    const call = await nextQueryCall();
    const before = await readSessionMcpServers(session.id);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    await waitFor(() => session.claudeRuntime === undefined);
    return { session, before };
  }

  const without = (rows: Array<{ id: string }>, id: string) => rows.filter((row) => row.id !== id);

  test("the session's report gives each server the layer it was loaded from", async () => {
    const { before } = await sessionWithoutCli();
    expect(before.map(({ id, scope }) => [id, scope])).toEqual([
      ["docs", "project"],
      ["late", "project"],
      ["orkestrator", "orkestrator"],
    ]);
  });

  test("a reconnect updates only its own row and keeps the injected server", async () => {
    const { session, before } = await sessionWithoutCli();
    queryControlOverrides.mcpServerStatus = async () =>
      probeReport({ status: "connected", tools: [{ name: "late_tool" }] });
    await performSessionMcpAction(session.id, "late", "reconnect");
    await expectControlOnlyPrompt(await nextQueryCall());

    const after = await readSessionMcpServers(session.id);
    expect(without(after, "late")).toEqual(without(before, "late"));
    expect(after.map((row) => row.id)).toEqual(["docs", "late", "orkestrator"]);
    const late = after.find((row) => row.id === "late")!;
    expect(late).toMatchObject({ status: "connected", scope: "project", toolCount: 1 });
    expect(late.error).toBeUndefined();
  });

  test("disable and enable update only their own row", async () => {
    const { session, before } = await sessionWithoutCli();
    queryControlOverrides.toggleMcpServer = mock(async () => undefined);
    queryControlOverrides.mcpServerStatus = async () => probeReport({ status: "disabled" });
    await performSessionMcpAction(session.id, "late", "disable");
    await expectControlOnlyPrompt(await nextQueryCall());
    let after = await readSessionMcpServers(session.id);
    expect(without(after, "late")).toEqual(without(before, "late"));
    expect(after.find((row) => row.id === "late")).toMatchObject({
      status: "disabled",
      scope: "project",
      actions: ["enable"],
    });

    queryControlOverrides.mcpServerStatus = async () => probeReport({ status: "connected" });
    await performSessionMcpAction(session.id, "late", "enable");
    await expectControlOnlyPrompt(await nextQueryCall());
    after = await readSessionMcpServers(session.id);
    expect(without(after, "late")).toEqual(without(before, "late"));
    expect(after.find((row) => row.id === "late")).toMatchObject({
      status: "connected",
      scope: "project",
    });
  });

  test("a server the session never listed, or the probe does not report, changes nothing", async () => {
    const { session, before } = await sessionWithoutCli();
    queryControlOverrides.mcpServerStatus = async () => probeReport({ status: "connected" });
    await performSessionMcpAction(session.id, "only-the-probe-sees-this", "reconnect");
    await expectControlOnlyPrompt(await nextQueryCall());
    expect(await readSessionMcpServers(session.id)).toEqual(before);

    await performSessionMcpAction(session.id, "orkestrator", "reconnect");
    await expectControlOnlyPrompt(await nextQueryCall());
    expect(await readSessionMcpServers(session.id)).toEqual(before);
  });

  test("a probe's refusal leaves the list alone", async () => {
    const { session, before } = await sessionWithoutCli();
    queryControlOverrides.reconnectMcpServer = mock(async () => {
      throw new Error("Server not found: orkestrator");
    });
    await expect(performSessionMcpAction(session.id, "orkestrator", "reconnect")).rejects.toThrow(
      "Server not found",
    );
    await expectControlOnlyPrompt(await nextQueryCall());
    expect(await readSessionMcpServers(session.id)).toEqual(before);
  });

  test("a running CLI's answer still replaces the whole list", async () => {
    let report: Array<Record<string, unknown>> = sessionReport;
    queryControlOverrides.mcpServerStatus = async () => report;
    const session = createSession();
    track(session.id);
    const promptPromise = sendPrompt(session.id, "inspect MCP state");
    const call = await nextQueryCall();
    await readSessionMcpServers(session.id);
    report = [{ name: "docs", status: "connected", scope: "dynamic" }];
    await performSessionMcpAction(session.id, "docs", "reconnect");
    expect(session.mcpInventory?.map((row) => row.id)).toEqual(["docs"]);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });
});

describe("MCP server errors", () => {
  test("redacts credentials an MCP server echoes in its error", async () => {
    queryControlOverrides.mcpServerStatus = async () => [
      {
        name: "deploy",
        status: "failed",
        error:
          "HTTP 401 from https://user:hunter2@mcp.example.test/sse?api_key=sk-live0123456789abcdef: Authorization: Bearer ghp_0123456789abcdefghij",
      },
    ];
    const session = createSession();
    track(session.id);
    const promptPromise = sendPrompt(session.id, "inspect MCP state");
    const call = await nextQueryCall();
    const [server] = await readSessionMcpServers(session.id);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;

    expect(server?.error).toContain("HTTP 401");
    for (const secret of ["hunter2", "sk-live0123456789abcdef", "ghp_0123456789abcdefghij"]) {
      expect(server?.error).not.toContain(secret);
    }
  });
});

describe("session titles", () => {
  test("leaves first-turn title generation to the backend", async () => {
    const session = createSession();
    track(session.id);
    const originalTitle = session.title;
    const promptPromise = sendPrompt(session.id, "backend owns this title");
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;

    expect(session.title).toBe(originalTitle);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("does not overwrite an explicit title that begins with Session", async () => {
    const session = createSession("Session planning notes");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "do work");
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.title).toBe("Session planning notes");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Activity state (the backend's two-second per-session sweep)
// ---------------------------------------------------------------------------

describe("getSessionActivity", () => {
  let activitySessionSequence = 0;

  /** A rollout id no other test in this file has materialized. */
  function freshSdkId(): string {
    activitySessionSequence += 1;
    return `cccccccc-dddd-4eee-8fff-${activitySessionSequence.toString(16).padStart(12, "0")}`;
  }

  /** On disk and known to this process, but with nothing read from it yet. */
  async function persistedSession() {
    return materializePersistedSession({ sessionId: freshSdkId() });
  }

  test("reports missing for an id no rollout could ever exist for", async () => {
    expect(await getSessionActivity("not-a-session-id")).toBe("missing");
    // No rollout id can be derived, so there is nothing to look for on disk.
    expect(mockSdkGetSessionInfo).not.toHaveBeenCalled();
  });

  test("reports missing for a well-formed id whose rollout is gone", async () => {
    mockSdkGetSessionInfo.mockImplementation(async () => undefined);

    expect(await getSessionActivity(`session-${freshSdkId()}`)).toBe("missing");
  });

  test("reports idle for a resident session that is not running", async () => {
    const state = createSession("idle session");
    track(state.id);

    expect(await getSessionActivity(state.id)).toBe("idle");
  });

  test("reports idle, not missing, for a non-resident session still on disk", async () => {
    // The data-loss guard. A bridge restart leaves every persisted session
    // absent from the map until something materializes it, and this endpoint
    // deliberately is not that something — but the backend deletes its session
    // mapping on "missing", so answering from residency alone would cut the
    // user's link to an intact conversation.
    const sdkId = freshSdkId();
    const info = sdkSessionInfo({ sessionId: sdkId });
    mockSdkGetSessionInfo.mockImplementation(async () => info);
    const bridgeId = `session-${sdkId}`;
    expect(getSession(bridgeId)).toBeUndefined();

    expect(await getSessionActivity(bridgeId)).toBe("idle");
    // Answering must not have made it resident either.
    expect(getSession(bridgeId)).toBeUndefined();
  });

  test("reports working for a running turn with nothing parked", async () => {
    const state = createSession("running");
    track(state.id);

    const promptPromise = sendPrompt(state.id, "go");
    const call = await nextQueryCall();
    expect(await getSessionActivity(state.id)).toBe("working");

    call.finish();
    await promptPromise;
    expect(await getSessionActivity(state.id)).toBe("idle");
  });

  test("keeps an idle parent working until all background tasks and agents finish", async () => {
    const state = createSession("background work");
    track(state.id);

    for (const status of ["pending", "running", "paused"] as const) {
      state.backgroundTasks = {
        "background-1": { id: "background-1", status },
      };
      expect(state.status).toBe("idle");
      expect(await getSessionActivity(state.id)).toBe("working");
    }

    for (const status of ["completed", "failed", "killed"] as const) {
      state.backgroundTasks = {
        "background-1": { id: "background-1", status },
      };
      expect(await getSessionActivity(state.id)).toBe("idle");
    }
  });

  test("reports waiting while a question is parked", async () => {
    const state = createSession("asking");
    track(state.id);

    const promptPromise = sendPrompt(state.id, "ask me something");
    const call = await nextQueryCall();
    const toolPromise = call.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Which one?" }],
    });
    await waitFor(() => getPendingQuestions(state.id).length === 1);

    // Still `running` as far as the session is concerned; the difference is
    // that the turn is blocked on the user, not on Claude.
    expect(state.status).toBe("running");
    expect(await getSessionActivity(state.id)).toBe("waiting");

    const [question] = getPendingQuestions(state.id);
    expect(dismissQuestion(question!.id)).toBe(true);
    await toolPromise;
    expect(await getSessionActivity(state.id)).toBe("working");

    call.finish();
    await promptPromise;
  });

  test("reports waiting while a plan approval is parked", async () => {
    const state = createSession("planning");
    track(state.id);

    const promptPromise = sendPrompt(state.id, "make a plan", {
      permissionMode: "plan",
    });
    const call = await nextQueryCall();
    const toolPromise = call.options.canUseTool!("ExitPlanMode", {
      plan: "do stuff",
    });
    await waitFor(() => getPendingPlanApprovals(state.id).length === 1);

    expect(await getSessionActivity(state.id)).toBe("waiting");

    const [approval] = getPendingPlanApprovals(state.id);
    expect(respondToPlanApproval(approval!.id, true)).toBe(true);
    await toolPromise;

    call.finish();
    await promptPromise;
  });

  test("a parked question outranks a live background task", async () => {
    const state = createSession("asking with background work");
    track(state.id);

    const promptPromise = sendPrompt(state.id, "ask me something");
    const call = await nextQueryCall();
    // The ordinary shape: a backgrounded Bash command started earlier in this
    // same turn is still alive when the turn stops to ask for permission.
    state.backgroundTasks = {
      "background-1": { id: "background-1", status: "running" },
    };
    const toolPromise = call.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Which one?" }],
    });
    await waitFor(() => getPendingQuestions(state.id).length === 1);

    expect(state.status).toBe("running");
    // Reporting `working` here would pulse the sidebar blue instead of amber
    // and drop the attention edge for a question nobody is looking at.
    expect(await getSessionActivity(state.id)).toBe("waiting");

    const [question] = getPendingQuestions(state.id);
    expect(dismissQuestion(question!.id)).toBe(true);
    await toolPromise;
    expect(await getSessionActivity(state.id)).toBe("working");

    call.finish();
    await promptPromise;
  });

  test("a parked plan approval outranks a live background task", async () => {
    const state = createSession("planning with background work");
    track(state.id);

    const promptPromise = sendPrompt(state.id, "make a plan", {
      permissionMode: "plan",
    });
    const call = await nextQueryCall();
    state.backgroundTasks = {
      "background-1": { id: "background-1", status: "pending" },
    };
    const toolPromise = call.options.canUseTool!("ExitPlanMode", {
      plan: "do stuff",
    });
    await waitFor(() => getPendingPlanApprovals(state.id).length === 1);

    expect(await getSessionActivity(state.id)).toBe("waiting");

    const [approval] = getPendingPlanApprovals(state.id);
    expect(respondToPlanApproval(approval!.id, true)).toBe(true);
    await toolPromise;

    call.finish();
    await promptPromise;
  });

  test("does not refresh the idle clock, unlike getSession", async () => {
    const state = await persistedSession();
    const readAt = Date.now() - 60_000;
    state.lastAccessedAt = readAt;

    expect(await getSessionActivity(state.id)).toBe("idle");
    expect(state.lastAccessedAt).toBe(readAt);

    expect(peekSession(state.id)).toBe(state);
    expect(state.lastAccessedAt).toBe(readAt);

    // The contrast is the point: `GET /:id` goes through `getSession`, which
    // touches, and that is exactly why the backend sweep must not use it.
    getSession(state.id);
    expect(state.lastAccessedAt).toBeGreaterThan(readAt);
  });

  test("polling every two seconds still lets a stale transcript be evicted", async () => {
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    const state = await persistedSession();
    await hydratePersistedSessionMessages(state.id);
    expect(state.messages.length).toBeGreaterThan(0);

    const hydratedAt = state.lastAccessedAt!;
    const expiresAt = hydratedAt + IDLE_TRANSCRIPT_EVICTION_MS;
    for (let at = hydratedAt; at <= expiresAt + 2_000; at += 2_000) {
      expect(await getSessionActivity(state.id)).toBe("idle");
    }

    // The regression this endpoint exists to prevent: a poll on `GET /:id`
    // every two seconds kept `now - lastAccessedAt` under the threshold
    // forever, so this sweep could never reach any polled session again.
    expect(evictIdleHydratedTranscripts(expiresAt + 2_001)).toContain(state.id);
    expect(state.messages).toEqual([]);
    expect(state.persistedMessagesLoaded).toBe(false);
  });

  test("does not hydrate the persisted transcript", async () => {
    const state = await persistedSession();
    expect(state.persistedMessagesLoaded).toBe(false);

    expect(await getSessionActivity(state.id)).toBe("idle");

    // `GET /:id` hydrates on a metadata-only session, which is what turned the
    // sweep into a "read every persisted transcript into memory" loop.
    expect(state.persistedMessagesLoaded).toBe(false);
    expect(mockSdkGetSessionMessages).not.toHaveBeenCalled();
  });
});
