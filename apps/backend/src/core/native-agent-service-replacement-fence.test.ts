/**
 * While an environment's runtime is rebuilt, reset or restored, no prompt is
 * dispatched to it: the refusal comes before anything is journaled, so the
 * prompt definitely did not run and can be sent again afterwards.
 */
import { describe, expect, test } from "bun:test";
import { withEnvironmentReplacement } from "./environment-replacement-fence.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

describe("native agent dispatch during a runtime replacement", () => {
  test("is refused without sending or parking, and accepted once the replacement ends", async () => {
    const stub = createProviderStub("cursor");
    await withService(
      { prefix: "orkestrator-native-fence-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const base = {
          environmentId: "env-1",
          agent: "cursor" as const,
          logicalSessionKey: "env-env-1:tab-1",
          prompt: "Do the work",
        };
        let release!: () => void;
        const replacement = withEnvironmentReplacement(
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
