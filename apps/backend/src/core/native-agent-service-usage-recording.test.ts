import { expect, test } from "bun:test";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";

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
