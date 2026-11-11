/**
 * Todo 7567 task 2: the agent-mail presence pass reads each environment row
 * once and hands it to the delivery gate. These tests drive the real
 * `NativeAgentService.mailInjectPresence` with and without that row, so a gate
 * that ignored the row (or read it again) fails here rather than passing
 * behind the fake gate the presence-pass test uses.
 */
import { expect, spyOn, test } from "bun:test";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const TAB = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey: "tab-1" };

test("the native gate uses the environment row its caller already read", async () => {
  const { provider } = createProviderStub("codex", { activity: async () => "idle" });
  await withService(
    { prefix: "orkestrator-native-mail-presence-known-", provider: async () => provider },
    async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });
      await service.reconcileAgentActivity();
      const row = (await storage.getEnvironment("env-1"))!;
      const getEnvironment = spyOn(storage, "getEnvironment");
      try {
        // Nothing passed: the gate reads the row itself.
        expect(await service.mailInjectPresence(TAB)).toBe("idle");
        expect(getEnvironment).toHaveBeenCalledTimes(1);
        getEnvironment.mockClear();

        // A passed row is used instead of a second read.
        expect(await service.mailInjectPresence(TAB, { environment: row })).toBe("idle");
        expect(getEnvironment).not.toHaveBeenCalled();

        // The gate judges the row it was handed, not storage, which still
        // reads running and ready throughout.
        expect(
          await service.mailInjectPresence(TAB, { environment: { ...row, status: "stopped" } }),
        ).toBe("environment_stopped");
        expect(
          await service.mailInjectPresence(TAB, {
            environment: { ...row, deletionRequestedAt: new Date().toISOString() },
          }),
        ).toBe("environment_stopped");
        expect(
          await service.mailInjectPresence(TAB, {
            environment: {
              ...row,
              setupPhase: "running",
              setupScriptsComplete: false,
              setupOverride: false,
            },
          }),
        ).toBe("environment_unready");
        expect(getEnvironment).not.toHaveBeenCalled();

        // A pass that found no row passes null: stopped, without reading again.
        expect(await service.mailInjectPresence(TAB, { environment: null })).toBe(
          "environment_stopped",
        );
        expect(getEnvironment).not.toHaveBeenCalled();

        // An explicit undefined is the same as passing nothing.
        expect(await service.mailInjectPresence(TAB, { environment: undefined })).toBe("idle");
        expect(getEnvironment).toHaveBeenCalledTimes(1);
      } finally {
        getEnvironment.mockRestore();
      }
    },
  );
});

test("without a passed row the native gate follows storage", async () => {
  const { provider } = createProviderStub("codex", { activity: async () => "idle" });
  await withService(
    {
      prefix: "orkestrator-native-mail-presence-fallback-",
      provider: async () => provider,
      environment: { status: "stopped" },
    },
    async ({ service }) => {
      expect(await service.mailInjectPresence(TAB)).toBe("environment_stopped");
      expect(await service.mailInjectPresence(TAB, {})).toBe("environment_stopped");
    },
  );
});
