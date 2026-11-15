import { describe, expect, test } from "bun:test";
import {
  claudeConnection,
  codexConnection,
  cursorConnection,
  httpProvider,
} from "../agent-provider-test-support.js";

/** A session resource larger than the 512 KiB the state read used to allow. */
function largeSessionBody() {
  return {
    status: "idle",
    backgroundTasks: Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [
        `shell-${index}`,
        {
          id: `shell-${index}`,
          status: "completed",
          endedAt: 1_000 + index,
          command: "c".repeat(4_000),
          outputTail: "o".repeat(2_000),
        },
      ]),
    ),
  };
}

describe("HTTP bridge session state read", () => {
  test("accepts a Claude session resource past 512 KiB", async () => {
    // Claude answers from the whole session resource, whose background-task
    // history grows with the session. A smaller cap here than the observe and
    // steer reads allow failed a long session's tab on every poll.
    const body = largeSessionBody();
    expect(JSON.stringify(body).length).toBeGreaterThan(512 * 1024);
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/runtime-health")) return new Response(null, { status: 404 });
      return Response.json(body);
    }, claudeConnection);

    const snapshot = await provider.sessionStateSnapshot!("session-1");

    expect(snapshot.status).toBe("idle");
    expect(snapshot.backgroundTasks).toHaveLength(128);
  });

  test("keeps the 512 KiB cap for a /status bridge", async () => {
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/runtime-health")) return new Response(null, { status: 404 });
      if (url.endsWith("/config")) return Response.json({});
      return Response.json({ status: "idle", padding: "x".repeat(600 * 1024) });
    }, codexConnection);

    await expect(provider.sessionStateSnapshot!("session-1")).rejects.toThrow(
      "codex session state read is oversized",
    );
  });
});

describe("the running turn's id (to-do 8107 (retired))", () => {
  function provider(body: Record<string, unknown>, connection = codexConnection) {
    return httpProvider((url) => {
      if (url.endsWith("/runtime-health")) return new Response(null, { status: 404 });
      if (url.endsWith("/config")) return Response.json({});
      return Response.json(body);
    }, connection).provider;
  }

  test("is the same turnId the steer check reads, while the turn runs", async () => {
    const running = provider({ status: "running", turnId: "turn-7" });
    expect((await running.sessionStateSnapshot!("session-1")).turnRunId).toBe("turn-7");
    expect(await running.activeSteerRun!("session-1")).toEqual({
      state: "running",
      runId: "turn-7",
    });
    const cursor = provider({ status: "running", turnId: "turn-8" }, cursorConnection);
    expect((await cursor.sessionStateSnapshot!("session-1")).turnRunId).toBe("turn-8");
  });

  test("is left out when idle, absent or oversized", async () => {
    for (const body of [
      { status: "idle", turnId: "turn-7" },
      { status: "running" },
      { status: "running", turnId: "x".repeat(513) },
    ]) {
      expect((await provider(body).sessionStateSnapshot!("session-1")).turnRunId).toBeUndefined();
    }
  });

  test("is published by Claude's session resource", async () => {
    const claude = provider({ status: "running", turnId: "claude-turn" }, claudeConnection);
    expect((await claude.sessionStateSnapshot!("session-1")).turnRunId).toBe("claude-turn");
  });
});
