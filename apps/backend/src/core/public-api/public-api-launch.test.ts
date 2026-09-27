import { afterEach, describe, expect, jest, test } from "bun:test";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import type { PublicTranscriptPage } from "@orkestrator/protocol/public-api-resources";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";
import type { PublicApiHarness } from "./test-support.js";

/**
 * environment.launch driven renderer-free from persisted startup intent to
 * exactly one initial provider submission; transcript paging; and the
 * unqualified-provider path. Real storage, real Git worktrees, a controlled
 * provider.
 */

jest.setTimeout(60_000);
afterEach(cleanupSessionHarnesses);

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function receipt(harness: PublicApiHarness, operationId: string): Promise<PublicReceipt> {
  const response = await harness.call("run.get", { operationId });
  return response.receipt!;
}

describe("environment.launch", () => {
  test("setup, then exactly one initial prompt under the stable request ID, observed to completion", async () => {
    const { harness, service, stub } = await setup();
    const repository = await harness.createRepository("launch");
    const added = await harness.call<{ project: { id: string } }>(
      "project.add",
      { path: repository.projectPath },
      { requestId: "launch-add" },
    );
    if (!added.ok) throw new Error(added.error.message);
    const launched = await harness.call<{
      environment: { id: string };
      sessionId: string;
      runId: string;
    }>(
      "environment.launch",
      {
        projectId: added.result.project.id,
        type: "local",
        agent: "claude",
        prompt: "first task",
        name: "launched",
      },
      { requestId: "launch-1" },
    );
    if (!launched.ok) throw new Error(`${launched.error.code}: ${launched.error.message}`);
    const environmentId = launched.result.environment.id;
    const runId = launched.receipt!.operationId;

    // The backend owns the whole progression; no client or renderer drives it.
    const executing = await waitFor(
      () => receipt(harness, runId),
      (value) => value.stage === "executing",
    );
    expect(executing.dispatch?.state).toBe("accepted");
    expect(executing.resources.dispatchRequestId).toBe(
      `initial-prompt:${environmentId}:startup-agent`,
    );
    const initial = stub.sends.filter(
      (send) => send.requestId === executing.resources.dispatchRequestId,
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]!.prompt).toContain("first task");

    // Replaying the launch key sends nothing again.
    const replay = await harness.call(
      "environment.launch",
      {
        projectId: added.result.project.id,
        type: "local",
        agent: "claude",
        prompt: "first task",
        name: "launched",
      },
      { requestId: "launch-1" },
    );
    expect(replay.receipt?.replayed).toBe(true);
    expect(
      stub.sends.filter((send) => send.requestId === executing.resources.dispatchRequestId),
    ).toHaveLength(1);

    stub.setStatus(async () => "idle");
    setActivity(service, "claude", "startup-agent", initial[0]!.sessionId, "idle", environmentId);
    const final = await waitFor(
      () => receipt(harness, runId),
      (value) => value.state === "succeeded",
    );
    expect(final.execution?.state).toBe("completed");
    await harness.commands.get("delete_environment")!({ environmentId }, harness.context);
  });
});

describe("session.transcript", () => {
  test("pages are ordered, bounded and continue through an older cursor", async () => {
    const { harness, stub } = await setup();
    const started = await harness.call<{ sessionId: string }>(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "hello" },
      { requestId: "t-1" },
    );
    if (!started.ok) throw new Error(started.error.message);
    for (let index = 0; index < 12; index += 1) {
      stub.messages.push({
        id: `m-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index} ${"x".repeat(index === 11 ? 30_000 : 10)}`,
        createdAt: new Date(1_000 * index).toISOString(),
        parts:
          index === 3
            ? [
                {
                  type: "tool-call",
                  toolName: "Bash",
                  status: "completed",
                  input: { command: "rm -rf /secret" },
                },
              ]
            : [],
      });
    }
    const newest = await harness.call<PublicTranscriptPage>("session.transcript", {
      sessionId: started.result.sessionId,
      limit: 5,
    });
    if (!newest.ok) throw new Error(`${newest.error.code}: ${newest.error.message}`);
    expect(newest.result.messages.map((message) => message.id)).toEqual([
      "m-7",
      "m-8",
      "m-9",
      "m-10",
      "m-11",
    ]);
    expect(newest.result.messages.at(-1)!.textTruncated).toBe(true);
    expect(newest.result.olderCursor).toBeDefined();
    const older = await harness.call<PublicTranscriptPage>("session.transcript", {
      sessionId: started.result.sessionId,
      limit: 5,
      before: newest.result.olderCursor,
    });
    if (!older.ok) throw new Error(older.error.message);
    expect(older.result.messages.map((message) => message.id)).toEqual([
      "m-2",
      "m-3",
      "m-4",
      "m-5",
      "m-6",
    ]);
    const tool = older.result.messages.find((message) => message.id === "m-3")!;
    expect(tool.parts[0]).toMatchObject({
      type: "tool-call",
      toolName: "Bash",
      detailOmitted: true,
    });
    expect(JSON.stringify(older)).not.toContain("rm -rf /secret");
    const invalid = await harness.call("session.transcript", {
      sessionId: started.result.sessionId,
      before: "not-a-cursor",
    });
    expect(!invalid.ok && invalid.error.code).toBe("invalid-input");
  });
});

describe("unqualified providers", () => {
  test("a finished turn reports unsupported instead of claiming completion", async () => {
    const { harness, service, stub } = await setup("pi");
    await harness.storage.updateGlobalConfig({
      ...(await harness.storage.loadConfig()).global,
      enabledAgentPlatforms: ["claude", "codex", "opencode", "pi"],
    });
    const started = await harness.call<{ tabId: string; runId: string }>(
      "session.start",
      { environmentId: "env-1", agent: "pi", prompt: "task" },
      { requestId: "pi-1" },
    );
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    stub.setStatus(async () => "idle");
    setActivity(service, "pi", started.result.tabId, stub.sends[0]!.sessionId, "idle");
    const read = await receipt(harness, started.result.runId);
    expect(read.state).toBe("unknown");
    expect(read.execution?.state).toBe("unsupported");
    const capabilities = await harness.call<{ providers: Record<string, { completion: string }> }>(
      "capabilities",
      {},
    );
    if (!capabilities.ok) throw new Error("capabilities failed");
    expect(capabilities.result.providers.pi!.completion).toBe("unqualified");
    expect(capabilities.result.providers.claude!.completion).toBe("qualified");
  });
});
