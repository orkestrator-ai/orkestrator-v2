// Exercise the bridge HTTP surface after foreground ownership is cleared.
// Only the SDK/process edge is simulated; admission, holds and snapshots are real.
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import {
  createSession,
  getPendingInteractions,
  mockQuery,
  nextQueryCall,
  queryControlOverrides,
  sendPrompt,
  track,
  waitFor,
} from "../services/session-manager-test-harness.js";
import { setClaudeRuntimeIdleTimingForTesting } from "../services/session-manager-runtime-idle.js";

const { default: routes } = await import("./session.js");
const app = new Hono().route("/session", routes);

function post(sessionId: string, route: string, body: unknown) {
  return app.request(`/session/${sessionId}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function warmSession() {
  const session = createSession("warm route controls");
  track(session.id);
  const prompt = sendPrompt(session.id, "hello");
  const call = await nextQueryCall();
  call.push({ type: "result", subtype: "success" });
  await prompt;
  expect(session.queryControl).toBeUndefined();
  expect(session.claudeRuntime?.state).toBe("open");
  return { session, call };
}

describe("HTTP controls on a warm Claude runtime", () => {
  test("catalogues, settings and MCP writes use the retained CLI without extending its window", async () => {
    const setModel = mock(async () => {});
    const setPermissionMode = mock(async () => {});
    const toggleMcpServer = mock(async () => {});
    const reconnectMcpServer = mock(async () => {});
    const supportedCommands = mock(async () => [
      { name: "review", description: "Review", argumentHint: "" },
    ]);
    const mcpServerStatus = mock(async () => [
      {
        name: "remote",
        status: "connected",
        config: { type: "http", url: "https://example.invalid/mcp" },
      },
    ]);
    Object.assign(queryControlOverrides, {
      setModel,
      setPermissionMode,
      toggleMcpServer,
      reconnectMcpServer,
      supportedCommands,
      mcpServerStatus,
    });
    const { session, call } = await warmSession();
    const timer = session.claudeRuntime!.idleTimer;
    const queryCount = mockQuery.mock.calls.length;
    supportedCommands.mockClear();
    expect((await app.request(`/session/${session.id}/commands`)).status).toBe(200);
    expect((await app.request(`/session/${session.id}/mcp`)).status).toBe(200);
    expect(mcpServerStatus).toHaveBeenCalled();
    expect((await post(session.id, "commands/refresh", {})).status).toBe(200);
    expect(supportedCommands).toHaveBeenCalled();
    expect(
      (await post(session.id, "config", { model: "claude-sonnet-4-6", mode: "plan" })).status,
    ).toBe(200);
    expect(setModel).toHaveBeenLastCalledWith("claude-sonnet-4-6");
    expect(setPermissionMode).toHaveBeenLastCalledWith("plan");
    expect((await post(session.id, "config", { mode: "build" })).status).toBe(200);
    expect(setPermissionMode).toHaveBeenLastCalledWith("bypassPermissions");
    for (const action of ["disable", "enable", "reconnect"]) {
      expect((await post(session.id, `mcp/remote/${action}`, {})).status).toBe(200);
    }
    expect(toggleMcpServer.mock.calls).toEqual([
      ["remote", false],
      ["remote", true],
    ]);
    expect(reconnectMcpServer).toHaveBeenCalledWith("remote");
    expect(mockQuery.mock.calls.length).toBe(queryCount);
    expect(session.queryControl).toBeUndefined();
    expect(session.claudeRuntime!.idleTimer).toBe(timer);
    call.finish();
  });

  test("failed warm control writes return a conflict", async () => {
    queryControlOverrides.setModel = async () => {
      throw new Error("Query closed before response received");
    };
    queryControlOverrides.toggleMcpServer = async () => {
      throw new Error("Query closed before response received");
    };
    const { session, call } = await warmSession();
    expect((await post(session.id, "config", { model: "new-model" })).status).toBe(409);
    expect((await post(session.id, "mcp/remote/disable", {})).status).toBe(409);
    call.finish();
  });

  test("a paused approval survives absent readers and releases the CLI after its answer", async () => {
    let fire: (() => void) | undefined;
    setClaudeRuntimeIdleTimingForTesting({
      idleMs: 60_000,
      schedule: (callback) => {
        fire = callback;
        return {
          cancel: () => {
            fire = undefined;
          },
        };
      },
    });
    const { session, call } = await warmSession();
    // The callback uses the current policy, just as a live tool request does.
    session.executionPolicy = {
      id: "interactive-host",
      sandbox: "none",
      approvals: "ask",
      projectResources: true,
      networkAccess: "full",
    };
    const decision = call.options.canUseTool!("Bash", { command: "echo hello" }, {
      signal: new AbortController().signal,
      requestId: "warm-approval",
    } as never);
    await waitFor(() => getPendingInteractions(session.id).length === 1);
    expect((await post(session.id, "interactions/warm-approval/hold", { held: true })).status).toBe(
      200,
    );
    // No subscribed renderer is needed to retain the approval and the CLI.
    fire!();
    expect(session.claudeRuntime?.state).toBe("open");
    const snapshot = await app.request(`/session/${session.id}/interactions`);
    expect(await snapshot.json()).toMatchObject({
      interactions: [{ id: "warm-approval", hold: { heldAt: expect.any(Number) } }],
    });
    expect(
      (await post(session.id, "interactions/warm-approval", { action: "decline" })).status,
    ).toBe(200);
    expect(await decision).toMatchObject({ behavior: "deny" });
    fire!();
    expect(session.claudeRuntime?.state).toBe("draining");
    call.finish();
  });
});
