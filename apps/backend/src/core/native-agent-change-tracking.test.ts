/**
 * The real native dispatch path and change tracking (acceptance H04): the
 * turn start is captured inside the at-most-once window before
 * `provider.send`, the dispatch outcome is recorded after it, and a held
 * start never reaches the provider.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarness, type Harness } from "./change-tracking/service-test-support.js";
import { turnIdFor } from "./change-tracking/turn-boundaries.js";
import {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  type NativeAgentRuntimeProvider,
  type ProviderSendOptions,
} from "./native-agent-provider.js";
import { NativeAgentService } from "./native-agent-service.js";
import type { NativeAgentChangeTrackingHooks } from "./native-agent-service-shared.js";
import { StorageService } from "./storage.js";

const SESSION = "env-env-1:tab-1";
const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function providerStub(send: (prompt: string, options: ProviderSendOptions) => Promise<void>) {
  const sendMock = mock(async (_sessionId: string, prompt: string, options: ProviderSendOptions) =>
    send(prompt, options),
  );
  const provider = {
    agent: "cursor",
    createSession: mock(async () => "provider-session"),
    registerSession: mock(() => undefined),
    send: sendMock,
    status: mock(async () => "idle"),
    messages: async () => [],
    structured: async () => null,
    abort: mock(async () => undefined),
    dispose: mock(async () => undefined),
  } as unknown as NativeAgentRuntimeProvider;
  return { provider, send: sendMock };
}

async function withService(
  options: {
    provider: NativeAgentRuntimeProvider;
    changeTracking: () => NativeAgentChangeTrackingHooks;
    worktreePath?: string;
  },
  run: (context: { storage: StorageService; service: NativeAgentService }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-change-tracking-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: options.worktreePath ?? "/tmp/env-1",
    setupScriptsComplete: true,
  });
  const service = new NativeAgentService(
    storage,
    async (command: string) => {
      throw new Error(`Unexpected backend command: ${command}`);
    },
    { provider: async () => options.provider, changeTracking: options.changeTracking },
  );
  try {
    await run({ storage, service });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

/** Hooks that record call order around a configurable start result. */
function recordingHooks(
  log: string[],
  start: () => Promise<
    { kind: "ready" | "degraded" | "untracked" } | { kind: "held"; reason: string }
  >,
) {
  const prepared: Array<Parameters<NativeAgentChangeTrackingHooks["prepareTurnStart"]>[0]> = [];
  const hooks: NativeAgentChangeTrackingHooks = {
    prepareTurnStart: async (context) => {
      prepared.push(context);
      log.push(`prepare:${context.requestId}`);
      return start();
    },
    markTurnDispatched: (_environmentId, _logicalSessionKey, requestId, outcome) => {
      log.push(`mark:${requestId}:${outcome}`);
    },
    noteProviderObserved: () => undefined,
    noteFork: () => undefined,
  };
  return { hooks, prepared };
}

const prompt = (requestId: string) => ({
  environmentId: "env-1",
  agent: "cursor" as const,
  logicalSessionKey: SESSION,
  prompt: "Do the work",
  requestId,
});

describe("native dispatch and change tracking", () => {
  test("captures the start before provider.send and records accepted, rejected and uncertain after it", async () => {
    const log: string[] = [];
    let behaviour: "accept" | "reject" | "ambiguous" = "accept";
    const { provider } = providerStub(async (_prompt, options) => {
      log.push(`send:${options.requestId}`);
      if (behaviour === "reject") throw new PromptRejectedError("No input");
      if (behaviour === "ambiguous") throw new AmbiguousPromptDispatchError("Response was lost");
    });
    const { hooks, prepared } = recordingHooks(log, async () => ({ kind: "ready" }));
    await withService({ provider, changeTracking: () => hooks }, async ({ service }) => {
      await expect(service.dispatchIntent(prompt("accepted-1"))).resolves.toMatchObject({
        outcome: "accepted",
      });
      behaviour = "reject";
      await expect(service.dispatchIntent(prompt("rejected-1"))).resolves.toMatchObject({
        outcome: "rejected",
      });
      behaviour = "ambiguous";
      await expect(service.dispatchIntent(prompt("unknown-1"))).resolves.toMatchObject({
        outcome: "unknown",
      });
    });
    expect(log).toEqual([
      "prepare:accepted-1",
      "send:accepted-1",
      "mark:accepted-1:accepted",
      "prepare:rejected-1",
      "send:rejected-1",
      "mark:rejected-1:rejected",
      "prepare:unknown-1",
      "send:unknown-1",
      "mark:unknown-1:uncertain",
    ]);
    expect(prepared[0]).toEqual({
      environmentId: "env-1",
      logicalSessionKey: SESSION,
      requestId: "accepted-1",
      provider: "cursor",
      providerSessionId: "provider-session",
    });
  });

  test("a held start refuses the dispatch without sending or recording a dispatch", async () => {
    const log: string[] = [];
    const { provider, send } = providerStub(async () => {
      log.push("send");
    });
    const { hooks } = recordingHooks(log, async () => ({
      kind: "held",
      reason: "capture-failed",
    }));
    await withService({ provider, changeTracking: () => hooks }, async ({ service }) => {
      const outcome = await service.dispatchIntent(prompt("held-1"));
      expect(outcome.outcome).not.toBe("accepted");
      expect(JSON.stringify(outcome)).toContain("strict checkpoints");
    });
    expect(send).not.toHaveBeenCalled();
    expect(log).toEqual(["prepare:held-1"]);
  });

  test("H04: a queued message's turn starts at dispatch, after an edit made while it waited", async () => {
    const h = createHarness();
    harnesses.push(h);
    const agentLine = "one\ntwo\nuser\nagent\n";
    let lifecycleAtSend: string | null = null;
    const { provider } = providerStub(async (_prompt, options) => {
      lifecycleAtSend =
        h.service.ledger.turn(turnIdFor("env-1", SESSION, options.requestId))?.lifecycle ?? null;
      // The agent's own write during the turn.
      writeFileSync(path.join(h.repo, "a.txt"), agentLine);
    });
    await withService(
      { provider, changeTracking: () => h.service.nativeAgentHooks(), worktreePath: h.repo },
      async ({ storage, service }) => {
        const queueKey = `cursor\u0000${SESSION}`;
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "row-1", requestId: "queued-1", text: "Queued prompt" },
        ]);
        // The user edits while the message waits; nothing was captured at queue time.
        writeFileSync(path.join(h.repo, "a.txt"), "one\ntwo\nuser\n");
        expect(h.service.ledger.snapshots()).toHaveLength(0);

        service.notifyPromptQueueChanged(queueKey);
        const deadline = Date.now() + 5_000;
        while (
          h.service.ledger.turn(turnIdFor("env-1", SESSION, "queued-1"))?.lifecycle !== "running"
        ) {
          if (Date.now() > deadline) throw new Error("queued prompt was not dispatched");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    );
    expect(lifecycleAtSend as string | null).toBe("start-ready");
    await h.service.finalizeTurn({
      environmentId: "env-1",
      logicalSessionKey: SESSION,
      requestId: "queued-1",
    });
    const turn = h.service.ledger.latestMeasurement(
      "turn",
      turnIdFor("env-1", SESSION, "queued-1"),
      "turn-net",
    )!;
    expect(turn.boundary.before).toBe("fresh-before");
    // Only the agent's line: the queued-time edit is preexisting state.
    expect(turn.totals.additions.value).toBe(1);
    expect(turn.totals.deletions.value).toBe(0);
    const body = await h.service.diffBodies.getDiff({ diffIdentityId: turn.diffIdentityId! });
    if (body.kind !== "body") throw new Error("expected a body");
    expect(
      body.files
        .flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines))
        .filter((l) => l.type === "add"),
    ).toMatchObject([{ text: "agent" }]);
  });
});
