import { afterEach, describe, expect, test } from "bun:test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import { decodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import { AmbiguousPromptDispatchError } from "../agent-provider-contract.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";
import type { PublicApiHarness } from "./test-support.js";

/**
 * Sessions and runs through the real dispatch journal, the real native-agent
 * service and real storage, with a controlled provider standing in for the
 * bridge. Provider behaviour is scripted per test; nothing here spends tokens.
 */

afterEach(cleanupSessionHarnesses);

async function receipt(harness: PublicApiHarness, operationId: string): Promise<PublicReceipt> {
  const response = await harness.call("run.get", { operationId });
  if (!response.receipt) throw new Error(`run.get failed: ${JSON.stringify(response)}`);
  return response.receipt;
}

async function startSession(harness: PublicApiHarness, requestId: string, prompt = "do the thing") {
  const response = await harness.call<{ sessionId: string; tabId: string; runId: string }>(
    "session.start",
    { environmentId: "env-1", agent: "claude", prompt },
    { requestId },
  );
  if (!response.ok)
    throw new Error(`session.start failed: ${response.error.code} ${response.error.message}`);
  return response;
}

describe("session.start and request-specific completion", () => {
  test("a run completes only on evidence about its own request", async () => {
    const { harness, service, stub } = await setup();
    const started = await startSession(harness, "job-1");
    const { sessionId, tabId, runId } = started.result;
    expect(decodePublicSessionId(sessionId)).toEqual({ environmentId: "env-1", tabId });
    expect(started.receipt?.dispatch?.state).toBe("accepted");
    expect(stub.sends).toHaveLength(1);
    expect(stub.sends[0]!.requestId).toBe(runId);

    // Accepted and working: not complete.
    expect((await receipt(harness, runId)).execution?.state).toBe("running");

    // The environment going idle elsewhere is not this run's completion:
    // until this session is observed idle the run keeps running.
    stub.setStatus(async () => "idle");
    expect((await receipt(harness, runId)).state).toBe("running");

    setActivity(service, "claude", tabId, stub.sends[0]!.sessionId, "idle");
    const settled = await receipt(harness, runId);
    expect(settled.state).toBe("succeeded");
    expect(settled.execution).toMatchObject({ state: "completed", evidence: "provider-status" });

    // Terminal results never move backwards.
    setActivity(service, "claude", tabId, stub.sends[0]!.sessionId, "working");
    expect((await receipt(harness, runId)).state).toBe("succeeded");
  });

  test("a failed turn settles as failed with its provider error", async () => {
    const { harness, service, stub } = await setup();
    const started = await startSession(harness, "job-fail");
    const { ProviderSessionFailedError } = await import("../native-agent-provider.js");
    stub.setStatus(async () => {
      throw new ProviderSessionFailedError("claude", "model overloaded");
    });
    setActivity(service, "claude", started.result.tabId, stub.sends[0]!.sessionId, "idle");
    const settled = await receipt(harness, started.result.runId);
    expect(settled.state).toBe("failed");
    expect(settled.execution?.error).toContain("model overloaded");
  });

  test("independent sessions settle independently", async () => {
    const { harness, service, stub } = await setup();
    const first = await startSession(harness, "job-a", "first task");
    const second = await startSession(harness, "job-b", "second task");
    expect(first.result.tabId).not.toBe(second.result.tabId);
    stub.setStatus(async () => "idle");
    setActivity(service, "claude", first.result.tabId, stub.sends[0]!.sessionId, "idle");
    expect((await receipt(harness, first.result.runId)).state).toBe("succeeded");
    expect((await receipt(harness, second.result.runId)).state).toBe("running");
  });

  test("replaying the start key returns the same session and sends nothing twice", async () => {
    const { harness, stub } = await setup();
    const first = await startSession(harness, "job-replay");
    const replay = await startSession(harness, "job-replay");
    expect(replay.receipt?.replayed).toBe(true);
    expect(replay.result.sessionId).toBe(first.result.sessionId);
    expect(stub.sends).toHaveLength(1);
    const conflict = await harness.call(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "other" },
      { requestId: "job-replay" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
  });

  test("refuses to start in an environment that is not ready", async () => {
    const { harness } = await setup();
    await harness.storage.updateEnvironment("env-1", {
      setupPhase: "running",
      setupScriptsComplete: false,
    });
    const response = await harness.call(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "x" },
      { requestId: "nr" },
    );
    expect(!response.ok && response.error.code).toBe("not-ready");
  });
});

describe("session.prompt", () => {
  test("rejects a busy session and never queues or steers implicitly", async () => {
    const { harness, stub } = await setup();
    const started = await startSession(harness, "busy-1");
    const response = await harness.call(
      "session.prompt",
      { sessionId: started.result.sessionId, prompt: "more" },
      { requestId: "busy-2" },
    );
    expect(!response.ok && response.error.code).toBe("busy");
    expect(stub.sends).toHaveLength(1);
  });

  test("a follow-up to an idle session is its own run", async () => {
    const { harness, service, stub } = await setup();
    const started = await startSession(harness, "follow-1");
    stub.setStatus(async () => "idle");
    setActivity(service, "claude", started.result.tabId, stub.sends[0]!.sessionId, "idle");
    expect((await receipt(harness, started.result.runId)).state).toBe("succeeded");
    const follow = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId: started.result.sessionId, prompt: "and now this" },
      { requestId: "follow-2" },
    );
    expect(follow.ok).toBe(true);
    if (!follow.ok) return;
    expect(stub.sends).toHaveLength(2);
    expect(stub.sends[1]!.requestId).toBe(follow.result.runId);
    // The new run is still running even though the previous one completed.
    expect((await receipt(harness, follow.result.runId)).execution?.state).toBe("running");
    expect((await receipt(harness, started.result.runId)).state).toBe("succeeded");
  });

  test("an unknown dispatch is parked, blocks other prompts, and retries under the same key", async () => {
    const { harness, service, stub } = await setup();
    const started = await startSession(harness, "amb-1");
    stub.setStatus(async () => "idle");
    setActivity(service, "claude", started.result.tabId, stub.sends[0]!.sessionId, "idle");
    await receipt(harness, started.result.runId);
    stub.setSend(async () => {
      throw new AmbiguousPromptDispatchError("socket closed after write");
    });
    const unknown = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId: started.result.sessionId, prompt: "maybe delivered" },
      { requestId: "amb-2" },
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error).toMatchObject({ code: "dispatch-unknown", exitCode: 7 });
    expect(unknown.receipt?.dispatch).toMatchObject({ state: "unknown", recoverable: true });
    const runId = unknown.receipt!.operationId;

    const blocked = await harness.call(
      "session.prompt",
      { sessionId: started.result.sessionId, prompt: "another" },
      { requestId: "amb-3" },
    );
    expect(!blocked.ok && blocked.error.code).toBe("dispatch-parked");

    stub.setSend(async () => undefined);
    const retried = await harness.call(
      "run.retry",
      { operationId: runId },
      { requestId: "amb-retry" },
    );
    expect(retried.ok).toBe(true);
    const sendsForRun = stub.sends.filter((send) => send.requestId === runId);
    expect(sendsForRun.length).toBe(2);
    expect(new Set(sendsForRun.map((send) => send.prompt)).size).toBe(1);
    expect((await receipt(harness, runId)).dispatch?.state).toBe("accepted");
  });

  test("discarding a parked dispatch leaves the run permanently unknown, not undone", async () => {
    const { harness, service, stub } = await setup();
    const started = await startSession(harness, "disc-1");
    stub.setStatus(async () => "idle");
    setActivity(service, "claude", started.result.tabId, stub.sends[0]!.sessionId, "idle");
    await receipt(harness, started.result.runId);
    stub.setSend(async () => {
      throw new AmbiguousPromptDispatchError("lost");
    });
    const unknown = await harness.call(
      "session.prompt",
      { sessionId: started.result.sessionId, prompt: "x" },
      { requestId: "disc-2" },
    );
    const runId = unknown.receipt!.operationId;
    const discarded = await harness.call(
      "run.discard",
      { operationId: runId },
      { requestId: "disc-3" },
    );
    expect(discarded.ok).toBe(true);
    const final = await receipt(harness, runId);
    expect(final.state).toBe("interrupted");
    expect(final.execution?.reason).toContain("may or may not");
  });
});

describe("controls and interactions", () => {
  test("stop refuses an idle session and a mismatched expected run", async () => {
    const { harness, service, stub } = await setup();
    const started = await startSession(harness, "stop-1");
    stub.setStatus(async () => "idle");
    setActivity(service, "claude", started.result.tabId, stub.sends[0]!.sessionId, "idle");
    await receipt(harness, started.result.runId);
    const idle = await harness.call(
      "session.stop",
      { sessionId: started.result.sessionId },
      { requestId: "stop-idle" },
    );
    expect(!idle.ok && idle.error.code).toBe("session-idle");

    const follow = await harness.call<{ runId: string }>(
      "session.prompt",
      { sessionId: started.result.sessionId, prompt: "next" },
      { requestId: "stop-2" },
    );
    if (!follow.ok) throw new Error("follow-up failed");
    const mismatch = await harness.call(
      "session.stop",
      { sessionId: started.result.sessionId, expectedOperationId: started.result.runId },
      { requestId: "stop-mismatch" },
    );
    expect(!mismatch.ok && mismatch.error.code).toBe("target-mismatch");
  });

  test("interactions: exact answers apply, stale revisions and malformed answers never approve", async () => {
    const { harness, service, stub } = await setup();
    const started = await startSession(harness, "ask-1");
    const providerSessionId = stub.sends[0]!.sessionId;
    stub.pending.push({
      version: 1,
      id: "q-1",
      provider: "claude",
      kind: "question",
      origin: "interactive-native",
      sessionId: providerSessionId,
      state: "pending",
      revision: 3,
      presentation: {
        title: "Which database?",
        questions: [
          {
            id: "db",
            prompt: "Pick one",
            required: true,
            multiple: false,
            secret: false,
            allowFreeText: false,
            options: [
              { id: "pg", label: "Postgres", providerValue: "pg" },
              { id: "sqlite", label: "SQLite", providerValue: "sqlite" },
            ],
          },
        ],
      },
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 1000,
    } as AgentInteractionRequest);
    setActivity(service, "claude", started.result.tabId, providerSessionId, "waiting");
    const waiting = await receipt(harness, started.result.runId);
    expect(waiting.execution?.state).toBe("waiting-for-input");
    expect(waiting.execution?.interactions?.[0]).toMatchObject({ id: "q-1", revision: 3 });

    const listed = await harness.call<{ items: Array<{ id: string; actions: string[] }> }>(
      "session.interactions",
      { sessionId: started.result.sessionId },
    );
    expect(listed.ok && listed.result.items[0]?.id).toBe("q-1");

    const stale = await harness.call(
      "session.interaction.resolve",
      {
        sessionId: started.result.sessionId,
        interactionId: "q-1",
        expectedRevision: 2,
        action: "answer",
        answers: [{ questionId: "db", optionIds: ["pg"] }],
      },
      { requestId: "ans-stale" },
    );
    expect(!stale.ok && stale.error.code).toBe("interaction-stale");
    const malformed = await harness.call(
      "session.interaction.resolve",
      {
        sessionId: started.result.sessionId,
        interactionId: "q-1",
        expectedRevision: 3,
        action: "answer",
        answers: [{ questionId: "db", optionIds: ["mysql"] }],
      },
      { requestId: "ans-bad" },
    );
    expect(!malformed.ok && malformed.error.code).toBe("invalid-input");
    expect(stub.resolutions).toHaveLength(0);

    const applied = await harness.call(
      "session.interaction.resolve",
      {
        sessionId: started.result.sessionId,
        interactionId: "q-1",
        expectedRevision: 3,
        action: "answer",
        answers: [{ questionId: "db", optionIds: ["pg"] }],
      },
      { requestId: "ans-ok" },
    );
    expect(applied.ok).toBe(true);
    expect(stub.resolutions).toHaveLength(1);
    // The activity snapshot still says waiting, but the question is answered:
    // the run is resuming, not asking again (no cached pending read).
    const resumed = await receipt(harness, started.result.runId);
    expect(resumed.execution?.state).toBe("running");
    expect(resumed.execution?.interactions).toBeUndefined();
    // Replaying the same answer key does not answer twice.
    const replay = await harness.call(
      "session.interaction.resolve",
      {
        sessionId: started.result.sessionId,
        interactionId: "q-1",
        expectedRevision: 3,
        action: "answer",
        answers: [{ questionId: "db", optionIds: ["pg"] }],
      },
      { requestId: "ans-ok" },
    );
    expect(replay.receipt?.replayed).toBe(true);
    expect(stub.resolutions).toHaveLength(1);
  });

  test("steering is refused where the provider cannot steer", async () => {
    const { harness } = await setup("opencode");
    const started = await harness.call<{ sessionId: string }>(
      "session.start",
      { environmentId: "env-1", agent: "opencode", prompt: "task" },
      { requestId: "steer-oc" },
    );
    if (!started.ok) throw new Error(`start failed: ${started.error.message}`);
    const steer = await harness.call(
      "session.steer",
      { sessionId: started.result.sessionId, text: "change course" },
      { requestId: "steer-1" },
    );
    expect(!steer.ok && steer.error.code).toBe("capability-unavailable");
  });
});

describe("session discovery", () => {
  test("lists sessions without reading transcripts and resolves exact handles", async () => {
    const { harness, stub } = await setup();
    const started = await startSession(harness, "list-1");
    const listed = await harness.call<{
      items: Array<{ id: string; latestRequestId: string | null }>;
    }>("session.list", { environmentId: "env-1" });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const summary = listed.result.items.find((item) => item.id === started.result.sessionId);
    expect(summary?.latestRequestId).toBe(started.result.runId);
    expect(JSON.stringify(listed)).not.toContain("do the thing");
    expect(JSON.stringify(listed)).not.toContain(stub.sends[0]!.sessionId);
    const missing = await harness.call("session.get", { sessionId: "ses_bm9wZQ" });
    expect(!missing.ok && missing.error.code).toBe("not-found");
  });
});

describe("observation cost and privacy", () => {
  test("list/get/run reads never read transcripts, and concurrent waiters share one status read", async () => {
    const { harness, service, stub } = await setup();
    const started = await startSession(harness, "cost-1");
    // Any transcript read would go through the provider's `messages`.
    const messagesSpy = { calls: 0 };
    (stub.provider as unknown as { messages: () => Promise<unknown[]> }).messages = async () => {
      messagesSpy.calls += 1;
      return [];
    };
    await harness.call("session.list", { environmentId: "env-1" });
    await harness.call("session.get", { sessionId: started.result.sessionId });
    await harness.call("environment.list", {});
    await harness.call("run.get", { operationId: started.result.runId });
    expect(messagesSpy.calls).toBe(0);

    stub.setStatus(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "idle";
    });
    setActivity(service, "claude", started.result.tabId, stub.sends[0]!.sessionId, "idle");
    const statusMock = stub.provider.status as unknown as { mock: { calls: unknown[] } };
    const before = statusMock.mock.calls.length;
    const reads = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.call("run.get", { operationId: started.result.runId }),
      ),
    );
    expect(reads.every((read) => read.receipt?.state === "succeeded")).toBe(true);
    expect(statusMock.mock.calls.length - before).toBeLessThanOrEqual(1);
    expect(messagesSpy.calls).toBe(0);
  });

  test("routine logs never contain the prompt", async () => {
    const sentinel = "PROMPT-SENTINEL-7f3a9c";
    const logged: string[] = [];
    const originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    for (const level of ["log", "info", "warn", "error"] as const) {
      console[level] = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
    }
    try {
      const { harness, stub } = await setup();
      const started = await startSession(harness, "privacy-1", `please ${sentinel}`);
      stub.setSend(async () => {
        throw new AmbiguousPromptDispatchError("lost");
      });
      await harness.call("run.get", { operationId: started.result.runId });
    } finally {
      Object.assign(console, originals);
    }
    expect(logged.some((line) => line.includes(sentinel))).toBe(false);
  });
});
