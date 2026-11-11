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
