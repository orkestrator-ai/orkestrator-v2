import { afterEach, describe, expect, test } from "bun:test";
import {
  NATIVE_AGENT_GOAL_LIMITS,
  sessionGoal,
  type NativeAgentGoal,
} from "@orkestrator/protocol/native-agent-goal";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import { PUBLIC_ACTION_INPUTS } from "@orkestrator/protocol/public-api-inputs";
import {
  decodePublicSessionId,
  encodePublicSessionId,
  nativeTabLogicalSessionKey,
  type PublicGoalMutationResult,
  type PublicSessionGoal,
} from "@orkestrator/protocol/public-api-resources";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { nativeAgentSessionStorageKey } from "../native-agent-service.js";
import { storageInternals } from "../storage-test-support.js";
import { goalIdForRequest } from "../native-agent-goal-service.js";
import { intentFingerprint, requestKey } from "./operation-ledger.js";
import { reconcileOperation } from "./reconciler.js";
import type { PublicApiHarness } from "./test-support.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";
import { createPublicActionContext } from "./dispatch.js";

/**
 * `session.goal.*` over the real dispatch, operation ledger, native-agent
 * service and goal service, with a scripted provider. Nothing spends tokens.
 */

afterEach(cleanupSessionHarnesses);

async function tabWithNoConversation(harness: PublicApiHarness, platform: AgentPlatform) {
  const tabId = `empty-${platform}`;
  await harness.storage.savePaneLayout(
    "env-1",
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          {
            id: tabId,
            type: "agent-native",
            nativeAgentData: { environmentId: "env-1", platform },
          },
        ],
        activeTabId: tabId,
      },
    },
    0,
  );
  return encodePublicSessionId("env-1", tabId);
}

async function goalSetup() {
  const agent = "claude" as const;
  const context = await setup(agent);
  const { harness, service, stub } = context;
  const started = await harness.call<{ sessionId: string; tabId: string }>(
    "session.start",
    { environmentId: "env-1", agent, prompt: "first turn" },
    { requestId: "goal-start" },
  );
  if (!started.ok) throw new Error(`session.start failed: ${started.error.code}`);
  const { sessionId, tabId } = started.result;
  setActivity(service, agent, tabId, stub.sends[0]!.sessionId, "idle");
  const key = nativeAgentSessionStorageKey(
    "env-1",
    agent,
    nativeTabLogicalSessionKey("env-1", tabId),
  );
  return {
    ...context,
    sessionId,
    tabId,
    key,
    stored: async () => {
      const session = await harness.storage.getNativeAgentSession(key);
      return { goal: session ? sessionGoal(session) : undefined, session };
    },
    set(input: Record<string, unknown>, requestId: string) {
      return harness.call<PublicGoalMutationResult>(
        "session.goal.set",
        { sessionId, objective: "Make it pass", ...input },
        { requestId },
      );
    },
    forceGoal: (update: (goal: NativeAgentGoal) => Partial<NativeAgentGoal>) =>
      harness.storage.updateNativeAgentGoal(key, (goal) =>
        goal ? { ...goal, ...update(goal) } : undefined,
      ),
  };
}

function failure(response: { ok: boolean; error?: { code: string } }) {
  expect(response.ok).toBe(false);
  return response.error?.code;
}

describe("session.goal.set", () => {
  test("takes structured fields, so an objective is never parsed for flags", async () => {
    const { set, stored, service } = await goalSetup();
    const objective = "Explain --budget 5 --max-iterations 99 --check rm -rf /";
    const response = await set({ objective, check: "bun test", maxIterations: 7 }, "set-text");
    expect(response.ok).toBe(true);
    await service.goals.settled();
    const { goal } = await stored();
    expect(goal).toMatchObject({
      objective,
      check: "bun test",
      maxIterations: 7,
      status: "active",
    });
    expect(goal?.tokenBudget).toBeUndefined();
  });

  test("defaults the cap once, at admission, and records what it resolved", async () => {
    const { set, stored, harness } = await goalSetup();
    const response = await set({}, "set-default");
    expect((await stored()).goal?.maxIterations).toBe(
      NATIVE_AGENT_GOAL_LIMITS.maxIterationsDefault,
    );
    const record = await harness.storage.publicOperations.getPublicOperation(
      response.receipt!.operationId,
    );
    expect(record.status === "found" && record.record.resolved?.maxIterations).toBe(
      NATIVE_AGENT_GOAL_LIMITS.maxIterationsDefault,
    );
  });

  test("replaying a set creates one goal, even after that goal ended and was cleared", async () => {
    const { set, stored, harness, sessionId, service } = await goalSetup();
    const first = await set({ check: "bun test" }, "set-replay");
    expect(first.ok && first.receipt?.replayed).toBe(false);
    if (!first.ok) return;
    const goalId = first.result.goal!.goalId;
    await service.goals.settled();

    const replay = await set({ check: "bun test" }, "set-replay");
    expect(replay.ok && replay.receipt?.replayed).toBe(true);
    expect(replay.ok && replay.result.goal?.goalId).toBe(goalId);
    expect((await stored()).goal?.goalId).toBe(goalId);
    expect((await stored()).session?.goalHistory ?? []).toEqual([]);

    await harness.call("session.goal.clear", { sessionId }, { requestId: "clear-1" });
    expect((await stored()).goal).toBeUndefined();

    const afterClear = await set({ check: "bun test" }, "set-replay");
    expect(afterClear.ok && afterClear.receipt?.replayed).toBe(true);
    expect((await stored()).goal).toBeUndefined();
  });

  test("two copies of one request at once set one goal", async () => {
    const { set, stored, service } = await goalSetup();
    const responses = await Promise.all([set({}, "set-race"), set({}, "set-race")]);
    await service.goals.settled();
    const { goal, session } = await stored();
    expect(goal).toBeDefined();
    expect(session?.goalHistory ?? []).toEqual([]);
    for (const response of responses) {
      // The other copy may report the first still in flight; it never sets another.
      if (response.ok) expect(response.result.goal?.goalId).toBe(goal!.goalId);
    }
  });

  test("the same key with a different objective conflicts and changes nothing", async () => {
    const { set, stored } = await goalSetup();
    await set({ objective: "One" }, "set-conflict");
    expect(failure(await set({ objective: "Two" }, "set-conflict"))).toBe("request-conflict");
    expect((await stored()).goal?.objective).toBe("One");
  });

  test("a set the backend died during reports whether it took effect", async () => {
    const { set, stored, harness, service } = await goalSetup();
    const first = await set({}, "set-crash");
    if (!first.ok) throw new Error("set failed");
    await service.goals.settled();
    const operationId = first.receipt!.operationId;
    const goalId = goalIdForRequest(operationId);
    expect((await stored()).goal?.goalId).toBe(goalId);
    const died = await harness.storage.publicOperations.updatePublicOperation(
      operationId,
      (record) => {
        const { completedAt: _completedAt, result: _result, ...rest } = record;
        return { ...rest, state: "running", generation: "earlier" };
      },
    );

    const context = createPublicActionContext(
      harness.context,
      { commands: harness.commands } as never,
      { installationId: "install", generation: "current" },
    );
    const reconciled = await reconcileOperation(died!, context);
    expect(reconciled.state).toBe("succeeded");
    expect((reconciled.result as unknown as PublicGoalMutationResult).goal?.goalId).toBe(goalId);
    expect((await stored()).session?.goalHistory ?? []).toEqual([]);

    await harness.call(
      "session.goal.clear",
      { sessionId: first.result.sessionId },
      { requestId: "clear" },
    );
    const noGoal = await harness.storage.publicOperations.updatePublicOperation(
      operationId,
      (record) => ({
        ...record,
        operationId: record.operationId,
        state: "running",
        generation: "earlier",
      }),
    );
    // Cleared since: the history still proves the set happened.
    expect((await reconcileOperation(noGoal!, context)).state).toBe("succeeded");
  });

  test("a set that never reached the record reads as interrupted", async () => {
    const { harness, sessionId } = await goalSetup();
    const decoded = decodePublicSessionId(sessionId)!;
    const scope = `session:${sessionId}`;
    const { record } = await harness.storage.publicOperations.admitPublicOperation({
      authority: "operator",
      action: "session.goal.set",
      scope,
      requestId: "never-ran",
      requestKey: requestKey("operator", "session.goal.set", scope, "never-ran"),
      fingerprint: intentFingerprint("session.goal.set", {}),
      resolved: { agent: "claude", maxIterations: 20 },
      resources: { environmentId: decoded.environmentId, sessionId, tabId: decoded.tabId },
      generation: "earlier",
      now: Date.now(),
    });
    const running = await harness.storage.publicOperations.updatePublicOperation(
      record.operationId,
      (current) => ({ ...current, state: "running" }),
    );
    const context = createPublicActionContext(
      harness.context,
      { commands: harness.commands } as never,
      { installationId: "install", generation: "current" },
    );
    expect((await reconcileOperation(running!, context)).state).toBe("interrupted");
  });

  test("a replacement needs the running goal cleared first, and is not admitted", async () => {
    const { set, stored, harness } = await goalSetup();
    const first = await set({ objective: "One" }, "set-one");
    const refused = await set({ objective: "Two" }, "set-two");
    expect(failure(refused)).toBe("conflict");
    expect(refused.ok ? undefined : refused.error.details?.goalId).toBe(
      first.ok ? first.result.goal?.goalId : undefined,
    );
    expect(refused.receipt).toBeUndefined();
    expect((await stored()).goal?.objective).toBe("One");
    const operations = await harness.storage.publicOperations.listActivePublicOperations();
    expect(operations.some((record) => record.requestId === "set-two")).toBe(false);
  });

  test("an ended goal can be replaced, and moves to the history", async () => {
    const { set, stored, forceGoal } = await goalSetup();
    const first = await set({ objective: "One" }, "set-ended-one");
    await forceGoal(() => ({ status: "claimed", statusReason: "agent-claimed" }));
    await set({ objective: "Two" }, "set-ended-two");
    const { goal, session } = await stored();
    expect(goal?.objective).toBe("Two");
    expect(session?.goalHistory?.map((past) => past.goalId)).toEqual([
      first.ok ? first.result.goal!.goalId : "",
    ]);
  });

  test("refuses bad bounds before admission", async () => {
    const { set, stored } = await goalSetup();
    for (const input of [
      { objective: "   " },
      { objective: "x".repeat(NATIVE_AGENT_GOAL_LIMITS.objectiveMaxChars + 1) },
      { maxIterations: 0 },
      { maxIterations: NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit + 1 },
      { maxIterations: 1.5 },
      { tokenBudget: 0 },
      { check: "" },
      { check: "first\nsecond" },
      { check: "x".repeat(NATIVE_AGENT_GOAL_LIMITS.checkMaxBytes + 1) },
      { unknown: true },
    ]) {
      expect(failure(await set(input, `bad-${JSON.stringify(input).length}`))).toBe(
        "invalid-input",
      );
    }
    expect((await stored()).goal).toBeUndefined();
  });

  test("refuses a provider that has not qualified for goals", async () => {
    const { harness } = await setup();
    const unqualified = AGENT_PLATFORMS.find(
      (platform) => nativeAgentCapabilities(platform).actions?.goal !== true,
    );
    if (!unqualified) return;
    const sessionId = await tabWithNoConversation(harness, unqualified);
    const refused = await harness.call(
      "session.goal.set",
      { sessionId, objective: "Make it pass" },
      { requestId: "set-unqualified" },
    );
    expect(failure(refused)).toBe("capability-unavailable");
  });

  test("refuses a tab with no conversation", async () => {
    const { harness } = await setup();
    const sessionId = await tabWithNoConversation(harness, "claude");
    const refused = await harness.call(
      "session.goal.set",
      { sessionId, objective: "Make it pass" },
      { requestId: "set-no-session" },
    );
    expect(failure(refused)).toBe("not-ready");
  });

  test("refuses a parked dispatch, which would hold the loop back unseen", async () => {
    const { harness, set, key } = await goalSetup();
    const session = (await harness.storage.getNativeAgentSession(key))!;
    await storageInternals(harness.storage).repos.nativeAgentSessions.saveNativeAgentSession(key, {
      ...session,
      pendingDispatch: {
        requestId: "parked",
        prompt: "later",
        createdAt: new Date().toISOString(),
      },
    });
    expect(failure(await set({}, "set-parked"))).toBe("dispatch-parked");
  });
});

describe("session.goal.get", () => {
  test("reads the record: no provider call, no private field", async () => {
    const { set, harness, sessionId, forceGoal, stub } = await goalSetup();
    await set({ check: "bun test" }, "set-read");
    await forceGoal(() => ({
      status: "paused",
      statusReason: "turn-failed",
      statusDetail: "capacity",
      workspaceFingerprint: "fingerprint",
      evaluatedRequestId: "evaluated",
      pendingReport: { status: "progress", message: "private", at: new Date(0).toISOString() },
      lastCheck: {
        passed: false,
        exitCode: 1,
        durationMs: 3,
        outputTail: "FAILED secret-looking output",
        at: new Date(0).toISOString(),
      },
    }));
    const sends = stub.sends.length;
    const response = await harness.call<PublicSessionGoal>("session.goal.get", { sessionId });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.result.goal).toMatchObject({ status: "paused", check: "bun test" });
    expect(response.result.description).toContain("capacity");
    const text = JSON.stringify(response.result);
    for (const hidden of [
      "providerSessionId",
      "workspaceFingerprint",
      "evaluatedRequestId",
      "pendingReport",
      "FAILED secret-looking output",
    ]) {
      expect(text).not.toContain(hidden);
    }
    expect(stub.sends).toHaveLength(sends);

    const withOutput = await harness.call<PublicSessionGoal>("session.goal.get", {
      sessionId,
      includeCheckOutput: true,
    });
    expect(withOutput.ok && withOutput.result.checkOutput).toBe("FAILED secret-looking output");
  });

  test("reads as no goal, and shows the goal on session.get while it is held", async () => {
    const { set, harness, sessionId } = await goalSetup();
    const none = await harness.call<PublicSessionGoal>("session.goal.get", { sessionId });
    expect(none.ok && none.result.goal).toBeNull();
    const before = await harness.call<{ goal?: unknown }>("session.get", { sessionId });
    expect(before.ok && "goal" in before.result).toBe(false);
    await set({ check: "bun test", maxIterations: 7 }, "set-summary");
    const after = await harness.call<{ goal?: Record<string, unknown> }>("session.get", {
      sessionId,
    });
    expect(after.ok && after.result.goal).toMatchObject({
      status: "active",
      running: true,
      maxIterations: 7,
      hasCheck: true,
    });
    expect(after.ok && JSON.stringify(after.result)).not.toContain("Make it pass");
  });
});

describe("session.goal.pause, resume and clear", () => {
  test("pause then resume, and neither is admitted when it cannot apply", async () => {
    const { set, harness, sessionId, stored, service } = await goalSetup();
    expect(
      failure(await harness.call("session.goal.pause", { sessionId }, { requestId: "pause-0" })),
    ).toBe("conflict");
    expect(
      failure(await harness.call("session.goal.resume", { sessionId }, { requestId: "resume-0" })),
    ).toBe("conflict");

    await set({}, "set-control");
    await service.goals.settled();
    const paused = await harness.call<PublicGoalMutationResult>(
      "session.goal.pause",
      { sessionId },
      { requestId: "pause-1" },
    );
    expect(paused.ok && paused.result.goal?.status).toBe("paused");
    expect((await stored()).goal?.statusReason).toBe("user-paused");
    const replay = await harness.call(
      "session.goal.pause",
      { sessionId },
      { requestId: "pause-1" },
    );
    expect(replay.receipt?.replayed).toBe(true);

    const resumed = await harness.call<PublicGoalMutationResult>(
      "session.goal.resume",
      { sessionId, maxIterations: 50 },
      { requestId: "resume-1" },
    );
    expect(resumed.ok && resumed.result.goal?.maxIterations).toBe(50);
    expect((await stored()).goal?.status).toBe("active");
    await service.goals.settled();
  });

  test("a goal still at its cap reports why it did not resume", async () => {
    const { set, harness, sessionId, forceGoal, service } = await goalSetup();
    await set({ maxIterations: 2 }, "set-cap");
    await service.goals.settled();
    await forceGoal(() => ({ status: "limited", statusReason: "iteration-cap", iterations: 2 }));
    const refused = await harness.call(
      "session.goal.resume",
      { sessionId },
      { requestId: "resume-cap" },
    );
    expect(failure(refused)).toBe("conflict");
    expect(refused.ok ? "" : refused.error.message).toContain("still at its limit");
    expect(refused.receipt?.state).toBe("failed");
  });

  test("an ended goal cannot resume, and a higher limit is bounded", async () => {
    const { set, harness, sessionId, forceGoal } = await goalSetup();
    await set({}, "set-ended");
    expect(
      failure(
        await harness.call(
          "session.goal.resume",
          { sessionId, maxIterations: NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit + 1 },
          { requestId: "resume-high" },
        ),
      ),
    ).toBe("invalid-input");
    await forceGoal(() => ({ status: "complete", statusReason: "check-passed" }));
    const refused = await harness.call(
      "session.goal.resume",
      { sessionId },
      { requestId: "resume-ended" },
    );
    expect(failure(refused)).toBe("conflict");
    expect(refused.ok ? "" : refused.error.message).toContain("set a new one");
  });

  test("clear removes the goal in any status, and is harmless with none", async () => {
    const { set, harness, sessionId, stored } = await goalSetup();
    const nothing = await harness.call<PublicGoalMutationResult>(
      "session.goal.clear",
      { sessionId },
      { requestId: "clear-none" },
    );
    expect(nothing.ok && nothing.result.cleared).toBe(false);
    await set({}, "set-clear");
    const cleared = await harness.call<PublicGoalMutationResult>(
      "session.goal.clear",
      { sessionId },
      { requestId: "clear-some" },
    );
    expect(cleared.ok && cleared.result.cleared).toBe(true);
    expect((await stored()).goal).toBeUndefined();
    const read = await harness.call<PublicSessionGoal>("session.goal.get", { sessionId });
    expect(read.ok && read.result.history).toHaveLength(1);
  });

  test("receipts and results are content-free", async () => {
    const { set, harness, sessionId, forceGoal } = await goalSetup();
    const secret = "objective-text-that-must-stay-out";
    const check = "check-command-that-must-stay-out";
    const responses = [await set({ objective: secret, check }, "set-content")];
    await forceGoal(() => ({
      lastReport: { status: "progress", message: "report-text", at: new Date(0).toISOString() },
    }));
    responses.push(
      await harness.call("session.goal.pause", { sessionId }, { requestId: "pause-content" }),
      await harness.call("session.goal.clear", { sessionId }, { requestId: "clear-content" }),
    );
    for (const response of responses) {
      const text = JSON.stringify(response);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(check);
      expect(text).not.toContain("report-text");
      expect(text).not.toContain("provider-session");
    }
  });
});

describe("the contract", () => {
  test("input bounds are the goal's own limits", () => {
    const set = PUBLIC_ACTION_INPUTS["session.goal.set"].input.properties;
    expect(set.maxIterations!.maximum).toBe(NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit);
    expect(set.objective!.maxLength).toBe(NATIVE_AGENT_GOAL_LIMITS.objectiveMaxChars);
    expect(set.check!.maxLength).toBe(NATIVE_AGENT_GOAL_LIMITS.checkMaxBytes);
    expect(
      PUBLIC_ACTION_INPUTS["session.goal.resume"].input.properties.maxIterations!.maximum,
    ).toBe(NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit);
  });
});
