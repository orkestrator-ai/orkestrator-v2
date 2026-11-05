import { describe, expect, jest, test } from "bun:test";
import { harness, type Harness } from "./app-server-runtime-test-harness.js";

jest.setTimeout(30_000);

/**
 * The status snapshot names a usage limit by app-server's own code, so the
 * backend does not have to match the error's wording.
 */
describe("usage-limit failure code", () => {
  async function failedTurn(h: Harness, error: Record<string, unknown>) {
    const { sessionId } = h.runtime.createSession({ mode: "build" });
    await h.runtime.prompt(sessionId, { prompt: "go", requestId: "req-1", attachments: [] });
    await h.drain();
    h.child().notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "failed", error },
    });
    await h.drain();
    return sessionId;
  }

  test("a turn app-server failed with usageLimitExceeded reports errorCode usage-limit", async () => {
    const h = await harness();
    // Wording that no text classifier would read as a usage limit.
    const sessionId = await failedTurn(h, {
      message: "Your plan is paused until Friday.",
      codexErrorInfo: "usageLimitExceeded",
    });

    expect(h.runtime.getStatus(sessionId)).toMatchObject({
      status: "error",
      phase: "failed",
      error: "Your plan is paused until Friday.",
      errorCode: "usage-limit",
    });
  });

  test("any other failure code reports no errorCode", async () => {
    const h = await harness();
    const sessionId = await failedTurn(h, {
      message: "Invalid request",
      codexErrorInfo: "badRequest",
    });

    const status = h.runtime.getStatus(sessionId);
    expect(status).toMatchObject({ status: "error", error: "Invalid request" });
    expect(status).not.toHaveProperty("errorCode");
  });

  test("the next accepted turn clears the code with the error", async () => {
    const h = await harness();
    const sessionId = await failedTurn(h, {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
    });
    expect(h.runtime.getStatus(sessionId)).toMatchObject({ errorCode: "usage-limit" });

    await h.runtime.prompt(sessionId, { prompt: "continue", requestId: "req-2", attachments: [] });
    await h.drain();

    const status = h.runtime.getStatus(sessionId);
    expect(status).toMatchObject({ status: "running" });
    expect(status).not.toHaveProperty("errorCode");
  });
});
