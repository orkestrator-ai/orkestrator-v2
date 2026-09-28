import { describe, expect, test } from "bun:test";

import type { ProviderActivityState } from "./native-agent-provider.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

describe("hasObservedLiveWork", () => {
  test("reports working or waiting sessions for the environment and agent only", async () => {
    let state: ProviderActivityState = "idle";
    const { provider } = createProviderStub("claude", { activity: async () => state });
    await withService(
      { prefix: "orkestrator-native-live-work-", provider: async () => provider },
      async ({ storage, service }) => {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "claude", "tab-1"),
          environmentId: "env-1",
          agent: "claude",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });

        // Nothing observed yet is not evidence of work.
        expect(await service.hasObservedLiveWork("env-1", "claude")).toBe(false);

        await service.reconcileAgentActivity();
        expect(await service.hasObservedLiveWork("env-1", "claude")).toBe(false);

        state = "working";
        await service.reconcileAgentActivity();
        expect(await service.hasObservedLiveWork("env-1", "claude")).toBe(true);
        expect(await service.hasObservedLiveWork("env-1", "codex")).toBe(false);
        expect(await service.hasObservedLiveWork("env-2", "claude")).toBe(false);

        state = "waiting";
        await service.reconcileAgentActivity();
        expect(await service.hasObservedLiveWork("env-1", "claude")).toBe(true);
      },
    );
  });
});
