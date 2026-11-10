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

  test("initial create failure is retryable, replayed without another create, and recovers", async () => {
    const { harness, stub } = await setup();
    const original = stub.provider.createSession;
    let creates = 0;
    stub.provider.createSession = async () => {
      creates++;
      throw new ProviderUnavailableError(BUSY);
    };
    const input = { environmentId: "env-1", agent: "claude", prompt: "first" };
    const refused = await harness.call("session.start", input, { requestId: "create-failure" });
    expect(!refused.ok && refused.error).toMatchObject({
      code: "operation-failed",
      exitCode: 1,
      retryable: true,
    });
    expect(stub.sends).toHaveLength(0);
    const count = creates;
    const replay = await harness.call("session.start", input, { requestId: "create-failure" });
    expect(replay.receipt?.replayed).toBe(true);
    expect(creates).toBe(count);
    stub.provider.createSession = original;
    expect((await harness.call("session.start", input, { requestId: "create-recovered" })).ok).toBe(
      true,
    );
    expect(stub.sends).toHaveLength(1);
  });

  test("retry first prompt in the failed start's session without creating another tab", async () => {
    const { harness, stub } = await setup();
    stub.setSend(async () => {
      throw new ProviderUnavailableError(BUSY);
    });
    const refused = await harness.call(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "first" },
      { requestId: "reuse-start" },
    );
    expect(refused.ok).toBe(false);
    const sessionId = refused.receipt?.resources.sessionId;
    expect(sessionId).toBeDefined();
    const before = await harness.storage.getPaneLayout("env-1");
    stub.setSend(async () => undefined);
    stub.setStatus(async () => "idle");
    const retry = await harness.call(
      "session.prompt",
      { sessionId, prompt: "first" },
      { requestId: "reuse-prompt" },
    );
    expect(retry.ok).toBe(true);
    const after = await harness.storage.getPaneLayout("env-1");
    expect(after).toEqual(before);
    expect(stub.sends).toHaveLength(2);
    expect(stub.sends[0]?.sessionId).toBe(stub.sends[1]?.sessionId);
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
