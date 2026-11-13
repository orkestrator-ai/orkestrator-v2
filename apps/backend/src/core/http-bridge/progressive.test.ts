import { describe, expect, test } from "bun:test";
import { claudeConnection, codexConnection, httpProvider } from "../agent-provider-test-support.js";

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
