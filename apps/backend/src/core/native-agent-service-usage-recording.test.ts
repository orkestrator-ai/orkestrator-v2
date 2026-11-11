import { expect, test } from "bun:test";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";
import { launchInternals } from "./native-agent-service-test-collaborators.js";

/**
 * The wiring between a projection and the usage store: the backend records
 * what the provider reported for turns the user may never have had a tab open
 * for, and records each one once however many projections see it.
 */

test("a projection records the session's turns once", async () => {
  let usage = {
    usedTokens: 10,
    turns: [
      { turnId: "turn-1", inputTokens: 100, outputTokens: 20, costUsd: 0.5, modelId: "opus" },
    ],
  };
  const stub = createProviderStub("claude", {
    interactiveSnapshot: async () => ({ status: "idle", messages: [], contextUsage: usage }),
  });
  await withService(
    {
      prefix: "orkestrator-native-usage-recording-",
      provider: async () => stub.provider,
    },
    async ({ service, storage }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:usage",
      };
      await service.ensureSession(identity);
      await service.getProjection(identity);
      await waitForCondition(() => storage.getAgentUsageHistory({ days: 1 }).totals.turns === 1);

      const first = storage.getAgentUsageHistory({ days: 1 });
      expect(first.totals.inputTokens).toBe(100);
      expect(first.totals.costUsd).toBeCloseTo(0.5, 10);
      expect(first.sessions).toBe(1);
      expect(first.platforms[0]?.platform).toBe("claude");
      expect(first.models[0]?.modelId).toBe("opus");

      // Reading the projection again republishes the same turn; it must not
      // be counted twice.
      await service.getProjection(identity);
      await service.getProjection(identity);
      expect(storage.getAgentUsageHistory({ days: 1 }).totals.turns).toBe(1);

      usage = {
        usedTokens: 20,
        turns: [
          ...usage.turns,
          { turnId: "turn-2", inputTokens: 7, outputTokens: 3, costUsd: 0.25, modelId: "opus" },
        ],
      };
      await service.getProjection(identity);
      await waitForCondition(() => storage.getAgentUsageHistory({ days: 1 }).totals.turns === 2);
      expect(storage.getAgentUsageHistory({ days: 1 }).totals.inputTokens).toBe(107);
    },
  );
});

/**
 * A session driven only through the CLI: `session start --wait`
 * then reads, never a full projection. The provider's full snapshot reports no
 * turns here, so only the reads under test can record the one the status
 * route reports.
 */
function cliOnlyStub(agent: "claude" | "pi") {
  let finished = false;
  const usage = {
    usedTokens: 168,
    turns: [{ turnId: "turn-1", inputTokens: 123, outputTokens: 45, modelId: "fake" }],
  };
  const stub = createProviderStub(agent, {
    interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    sessionStateSnapshot: async () =>
      finished ? { status: "idle", contextUsage: usage } : { status: "running" },
  });
  return {
    stub,
    finish() {
      finished = true;
    },
  };
}

test("the session-state view records a turn no projection read has seen", async () => {
  const { stub, finish } = cliOnlyStub("pi");
  await withService(
    { prefix: "orkestrator-native-usage-state-view-", provider: async () => stub.provider },
    async ({ service, storage }) => {
      const identity = {
        environmentId: "env-1",
        agent: "pi" as const,
        logicalSessionKey: "env-env-1:cli-state",
      };
      await service.ensureSession(identity);
      finish();
      const update = await service.getSessionStateUpdate({
        ...identity,
        viewVersion: 1,
        forceSnapshot: true,
      });
      expect(update.status).toBe("snapshot");
      await waitForCondition(() => storage.getAgentUsageHistory({ days: 1 }).totals.turns === 1);
      const report = storage.getAgentUsageHistory({ days: 1 });
      expect(report.totals.inputTokens).toBe(123);
      expect(report.totals.outputTokens).toBe(45);

      // Another state read republishes the same turn and adds nothing.
      await service.getSessionStateUpdate({ ...identity, viewVersion: 1, forceSnapshot: true });
      expect(storage.getAgentUsageHistory({ days: 1 }).totals.turns).toBe(1);
    },
  );
});

test("settling a turn's outcome records its usage without any view read", async () => {
  const { stub, finish } = cliOnlyStub("claude");
  await withService(
    { prefix: "orkestrator-native-usage-settled-", provider: async () => stub.provider },
    async ({ service, storage }) => {
      const identity = {
        environmentId: "env-1",
        agent: "claude" as const,
        logicalSessionKey: "env-env-1:cli-start",
      };
      const session = await service.dispatchPrompt({
        ...identity,
        prompt: "first",
        requestId: "r-1",
      });
      launchInternals(service).observedSessionActivity.set(session.key, {
        providerSessionId: session.providerSessionId,
        state: "idle",
      });
      finish();
      const reads = stub.sessionStateSnapshot!.mock.calls.length;
      expect(await service.sessionTurnOutcome({ ...identity, requestId: "r-1" })).toEqual({
        outcome: "completed",
      });
      await waitForCondition(() => storage.getAgentUsageHistory({ days: 1 }).totals.turns === 1);
      expect(storage.getAgentUsageHistory({ days: 1 }).totals.inputTokens).toBe(123);
      // One usage read for the settled turn; the recorded outcome answers
      // later calls from storage and reads nothing more.
      expect(stub.sessionStateSnapshot!.mock.calls.length).toBe(reads + 1);
      await service.sessionTurnOutcome({ ...identity, requestId: "r-1" });
      expect(stub.sessionStateSnapshot!.mock.calls.length).toBe(reads + 1);
    },
  );
});

const cliIdentity = {
  environmentId: "env-1",
  agent: "claude" as const,
  logicalSessionKey: "env-env-1:cli-start",
};

function markIdle(service: Parameters<typeof launchInternals>[0], key: string, id: string) {
  launchInternals(service).observedSessionActivity.set(key, {
    providerSessionId: id,
    state: "idle",
  });
}

function turn(turnId: string, inputTokens: number) {
  return { turnId, inputTokens, outputTokens: 1, modelId: "fake" };
}

function settledHelper(service: unknown) {
  return (service as { settledTurnUsage: { owes(key: string): boolean } }).settledTurnUsage;
}

test("a turn that settles while the previous turn's usage read is in flight is still counted", async () => {
  let gate: Promise<void> | undefined;
  let turns = [turn("turn-1", 100)];
  const stub = createProviderStub("claude", {
    interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    sessionStateSnapshot: async () => {
      // Captured before the read waits: turn 2 has not happened yet.
      const seen = turns;
      if (gate) await gate;
      return { status: "idle", contextUsage: { usedTokens: 1, turns: seen } };
    },
  });
  await withService(
    { prefix: "orkestrator-native-usage-overlap-", provider: async () => stub.provider },
    async ({ service, storage }) => {
      const first = await service.dispatchPrompt({ ...cliIdentity, prompt: "1", requestId: "r-1" });
      markIdle(service, first.key, first.providerSessionId);
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reads = stub.sessionStateSnapshot!.mock.calls.length;
      await service.sessionTurnOutcome({ ...cliIdentity, requestId: "r-1" });
      await waitForCondition(() => stub.sessionStateSnapshot!.mock.calls.length === reads + 1);

      // Turn 2 runs and settles while turn 1's read is still waiting.
      gate = undefined;
      const second = await service.dispatchPrompt({
        ...cliIdentity,
        prompt: "2",
        requestId: "r-2",
      });
      turns = [...turns, turn("turn-2", 7)];
      markIdle(service, second.key, second.providerSessionId);
      expect(await service.sessionTurnOutcome({ ...cliIdentity, requestId: "r-2" })).toEqual({
        outcome: "completed",
      });
      release();
      await waitForCondition(() => storage.getAgentUsageHistory({ days: 1 }).totals.turns === 2);
      expect(storage.getAgentUsageHistory({ days: 1 }).totals.inputTokens).toBe(107);
    },
  );
});

test("a failed settled usage read is retried by the next outcome call", async () => {
  let fail = true;
  const stub = createProviderStub("claude", {
    interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    sessionStateSnapshot: async () => {
      if (fail) throw new Error("bridge restarting");
      return { status: "idle", contextUsage: { usedTokens: 1, turns: [turn("turn-1", 123)] } };
    },
  });
  await withService(
    { prefix: "orkestrator-native-usage-retry-", provider: async () => stub.provider },
    async ({ service, storage }) => {
      const session = await service.dispatchPrompt({
        ...cliIdentity,
        prompt: "first",
        requestId: "r-1",
      });
      markIdle(service, session.key, session.providerSessionId);
      expect(await service.sessionTurnOutcome({ ...cliIdentity, requestId: "r-1" })).toEqual({
        outcome: "completed",
      });
      await waitForCondition(() => settledHelper(service).owes(session.key));
      expect(storage.getAgentUsageHistory({ days: 1 }).totals.turns).toBe(0);

      fail = false;
      // Answered from the recorded outcome, and the owed read rides on it.
      await service.sessionTurnOutcome({ ...cliIdentity, requestId: "r-1" });
      await waitForCondition(() => storage.getAgentUsageHistory({ days: 1 }).totals.turns === 1);
      expect(settledHelper(service).owes(session.key)).toBe(false);
    },
  );
});

test("the queue drain settles the previous turn with the usage its own status read carried", async () => {
  const usage = { usedTokens: 1, turns: [turn("turn-1", 55)] };
  const stub = createProviderStub("claude", {
    interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    sessionStateSnapshot: async () => ({ status: "idle" }),
  });
  (stub.provider as { observeSession?: unknown }).observeSession = async () => ({
    status: "idle",
    contextUsage: usage,
  });
  await withService(
    { prefix: "orkestrator-native-usage-drain-", provider: async () => stub.provider },
    async ({ service, storage }) => {
      const session = await service.dispatchPrompt({
        ...cliIdentity,
        prompt: "first",
        requestId: "r-1",
      });
      markIdle(service, session.key, session.providerSessionId);
      const reads = stub.sessionStateSnapshot!.mock.calls.length;
      const queueKey = `claude\0${cliIdentity.logicalSessionKey}`;
      await storage.enqueuePromptQueueMessage(queueKey, "env-1", { id: "u-2", text: "next" });
      service.notifyPromptQueueChanged(queueKey);
      await waitForCondition(
        async () => (await storage.getNativeAgentSession(session.key))?.turnOutcomes?.length === 1,
      );
      await waitForCondition(() => storage.getAgentUsageHistory({ days: 1 }).totals.turns === 1);
      expect(storage.getAgentUsageHistory({ days: 1 }).totals.inputTokens).toBe(55);
      // The settle reused the drain's observation instead of reading again.
      expect(stub.sessionStateSnapshot!.mock.calls.length).toBe(reads);
    },
  );
});
