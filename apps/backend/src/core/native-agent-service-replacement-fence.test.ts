/**
 * While an environment's runtime is rebuilt, reset or restored, no prompt is
 * dispatched to it: the refusal comes before anything is journaled, so the
 * prompt definitely did not run and can be sent again afterwards.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

describe("native agent dispatch during a runtime replacement", () => {
  test("is refused without sending or parking, and accepted once the replacement ends", async () => {
    const stub = createProviderStub("cursor");
    const fence = new EnvironmentMutationFence();
    await withService(
      {
        prefix: "orkestrator-native-fence-",
        provider: async () => stub.provider,
        environmentFence: fence,
      },
      async ({ service, storage }) => {
        const base = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-1",
          prompt: "Do the work",
        };
        let release!: () => void;
        const replacement = fence.withReplacement(
          "env-1",
          () => new Promise<void>((resolve) => (release = resolve)),
        );
        const refused = await service.dispatchIntent({ ...base, requestId: "during" });
        expect(refused.outcome).toBe("rejected");
        expect("error" in refused ? refused.error : "").toContain("being rebuilt");
        expect(stub.send).toHaveBeenCalledTimes(0);
        const key = nativeAgentSessionStorageKey("env-1", "cursor", base.logicalSessionKey);
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toBeUndefined();
        release();
        await replacement;
        await expect(service.dispatchIntent({ ...base, requestId: "after" })).resolves.toEqual({
          outcome: "accepted",
          requestId: "after",
        });
      },
    );
  });
});

test("tab close rejects native prompts before session preflight, then releases admission", async () => {
  const stub = createProviderStub("cursor");
  const fence = new EnvironmentMutationFence();
  await withService(
    {
      prefix: "ork-native-close-fence-",
      provider: async () => stub.provider,
      environmentFence: fence,
    },
    async ({ service, storage }) => {
      const base = {
        environmentId: "env-1",
        agent: "cursor" as const,
        logicalSessionKey: "env-env-1:tab-1",
        prompt: "work",
      };
      const release = fence.beginTabClose("env-1");
      try {
        expect(await service.dispatchIntent({ ...base, requestId: "during-close" })).toMatchObject({
          outcome: "rejected",
          error: expect.stringContaining("tab is being closed"),
        });
        expect(stub.send).not.toHaveBeenCalled();
        expect(
          await storage.getNativeAgentSession(
            nativeAgentSessionStorageKey(base.environmentId, base.agent, base.logicalSessionKey),
          ),
        ).toBeNull();
      } finally {
        release();
      }
      expect(await service.dispatchIntent({ ...base, requestId: "after-close" })).toMatchObject({
        outcome: "accepted",
      });
    },
  );
});

test("a native prompt's delayed identity preflight prevents close admission", async () => {
  const stub = createProviderStub("cursor");
  const fence = new EnvironmentMutationFence();
  await withService(
    {
      prefix: "ork-native-close-preflight-",
      provider: async () => stub.provider,
      environmentFence: fence,
    },
    async ({ service }) => {
      const typed = service as unknown as {
        trustedSessionInput: (
          input: Parameters<typeof service.dispatchIntent>[0],
        ) => Promise<Parameters<typeof service.dispatchIntent>[0]>;
      };
      const original = typed.trustedSessionInput.bind(service);
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const preflight = spyOn(typed, "trustedSessionInput").mockImplementation(async (input) => {
        await gate;
        return original(input);
      });
      const dispatch = service.dispatchIntent({
        environmentId: "env-1",
        agent: "cursor",
        logicalSessionKey: "env-env-1:tab-1",
        prompt: "work",
        requestId: "before-close",
      });
      try {
        expect(() => fence.beginTabClose("env-1")).toThrow("submission is in progress");
      } finally {
        resume();
      }
      expect(await dispatch).toMatchObject({ outcome: "accepted" });
      preflight.mockRestore();
      const release = fence.beginTabClose("env-1");
      release();
    },
  );
});

test("persisted pending teardown blocks new native work after close failure or restart", async () => {
  const stub = createProviderStub("cursor");
  await withService(
    { prefix: "ork-native-pending-close-", provider: async () => stub.provider },
    async ({ service, storage }) => {
      const base = {
        environmentId: "env-1",
        agent: "cursor" as const,
        logicalSessionKey: "env-env-1:tab-1",
        prompt: "work",
        requestId: "after-failed-close",
      };
      await storage.setTabTeardownIntent("env-1", {
        tabId: "tab-1",
        kind: "cursor-native",
        createdAt: new Date().toISOString(),
      });
      expect(await service.dispatchIntent(base)).toMatchObject({
        outcome: "rejected",
        error: expect.stringContaining("pending teardown"),
      });
      await expect(service.dispatchPrompt(base)).rejects.toThrow("pending teardown");
      expect(stub.send).not.toHaveBeenCalled();
      await storage.updateEnvironment("env-1", { tabTeardownIntents: {} });
      expect(await service.dispatchIntent(base)).toMatchObject({ outcome: "accepted" });
    },
  );
});
