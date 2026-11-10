import { afterEach, describe, expect, test } from "bun:test";
import { PromptRejectedError, ProviderUnavailableError } from "../agent-provider-contract.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";

/**
 * A prompt a bridge refused as temporarily unavailable, before anything was
 * sent, fails as `operation-failed` (exit 1) with `retryable: true`, so a
 * script can tell "send it again under a new key" from a refusal that will
 * never work (7260). The same key still replays the failure.
 */

afterEach(cleanupSessionHarnesses);

const BUSY =
  "claude prompt dispatch is temporarily unavailable (HTTP 503): The session's preferences are busy, so the prompt was not sent. Try again.";

describe("transient prompt refusals in the public API", () => {
  test("session.prompt: retryable, replayed under the same key, and a new key runs", async () => {
    const { harness, service, stub } = await setup();
    const started = await harness.call<{ sessionId: string; tabId: string; runId: string }>(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "first" },
      { requestId: "transient-1" },
    );
    if (!started.ok) throw new Error(started.error.message);
    stub.setStatus(async () => "idle");
    setActivity(service, "claude", started.result.tabId, stub.sends[0]!.sessionId, "idle");
    await harness.call("run.get", { operationId: started.result.runId });

    stub.setSend(async () => {
      throw new ProviderUnavailableError(BUSY);
    });
    const refused = await harness.call(
      "session.prompt",
      { sessionId: started.result.sessionId, prompt: "second" },
      { requestId: "transient-2" },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({
      code: "operation-failed",
      exitCode: 1,
      retryable: true,
      message: BUSY,
    });
    expect(refused.receipt).toMatchObject({
      state: "failed",
      dispatch: { state: "rejected" },
      replayed: false,
    });

    // The same key replays the failure; it is never sent again.
    stub.setSend(async () => undefined);
    const sendsBefore = stub.sends.length;
    const replay = await harness.call(
      "session.prompt",
      { sessionId: started.result.sessionId, prompt: "second" },
      { requestId: "transient-2" },
    );
    expect(!replay.ok && replay.error.code).toBe("operation-failed");
    expect(replay.receipt?.replayed).toBe(true);
    expect(stub.sends).toHaveLength(sendsBefore);

    // A new key is safe: nothing was parked, and the prompt runs once.
    const retried = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId: started.result.sessionId, prompt: "second" },
      { requestId: "transient-3" },
    );
    expect(retried.ok).toBe(true);
    expect(stub.sends).toHaveLength(sendsBefore + 1);
  });

  test("session.start: a transient first-prompt refusal is retryable", async () => {
    const { harness, stub } = await setup();
    stub.setSend(async () => {
      throw new ProviderUnavailableError(BUSY);
    });
    const refused = await harness.call(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "first" },
      { requestId: "transient-start" },
    );
    expect(!refused.ok && refused.error).toMatchObject({
      code: "operation-failed",
      exitCode: 1,
      retryable: true,
    });
  });

  test("a refusal that will not change on its own carries no retryable", async () => {
    const { harness, stub } = await setup();
    stub.setSend(async () => {
      throw new PromptRejectedError("No input");
    });
    const refused = await harness.call(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "first" },
      { requestId: "terminal-start" },
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("operation-failed");
    expect(refused.error.retryable).toBeUndefined();
  });
});
