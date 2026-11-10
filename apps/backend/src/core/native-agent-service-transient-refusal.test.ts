/**
 * A prompt the provider refused because it was temporarily unavailable (a
 * bridge's 503 before dispatch, an unreachable bridge) sent nothing and parks
 * nothing, so its rejection says `transient`: the same prompt under a new
 * request id may succeed (7260). Refusals that will not change on their own,
 * ambiguous dispatches and recovery retries that keep their parked record
 * never carry it, because a new id there either fails the same way or could
 * run the prompt twice.
 */
import { describe, expect, test, spyOn } from "bun:test";
import {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderUnavailableError,
  ProviderUnreachableError,
} from "./native-agent-provider.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const base = {
  environmentId: "env-1",
  agent: "claude" as const,
  logicalSessionKey: "env-env-1:tab-1",
  prompt: "Do the work",
};
const key = nativeAgentSessionStorageKey(base.environmentId, base.agent, base.logicalSessionKey);
const busyRefusal =
  "claude prompt dispatch is temporarily unavailable (HTTP 503): The session's preferences are busy, so the prompt was not sent. Try again.";

describe("transient prompt refusals", () => {
  test("a 503 refusal is transient, parks nothing, and a new id runs once it clears", async () => {
    let refuse = true;
    const stub = createProviderStub("claude", {
      send: async () => {
        if (refuse) throw new ProviderUnavailableError(busyRefusal);
      },
    });
    await withService(
      { prefix: "orkestrator-native-transient-503-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await expect(service.dispatchIntent({ ...base, requestId: "first" })).resolves.toEqual({
          outcome: "rejected",
          error: busyRefusal,
          transient: true,
        });
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toBeUndefined();

        refuse = false;
        await expect(service.dispatchIntent({ ...base, requestId: "second" })).resolves.toEqual({
          outcome: "accepted",
          requestId: "second",
        });
      },
    );
  });

  test("an unreachable bridge is transient too", async () => {
    const stub = createProviderStub("cursor", {
      send: async () => {
        throw new ProviderUnreachableError("Bridge is offline");
      },
    });
    await withService(
      { prefix: "orkestrator-native-transient-unreachable-", provider: async () => stub.provider },
      async ({ service }) => {
        await expect(
          service.dispatchIntent({ ...base, agent: "cursor", requestId: "first" }),
        ).resolves.toEqual({ outcome: "rejected", error: "Bridge is offline", transient: true });
      },
    );
  });

  for (const agent of ["claude", "opencode"] as const) {
    test(`${agent}: preflight refusal respects parked dispatch state`, async () => {
      let unavailable = false;
      const stub = createProviderStub(agent, {
        status: async () => {
          if (unavailable) throw new ProviderUnavailableError(busyRefusal);
          return "idle";
        },
        send: async () => {
          throw new AmbiguousPromptDispatchError("Response lost");
        },
        dispatchStatus: async () => "unknown",
      });
      await withService(
        { prefix: "transient-preflight-", provider: async () => stub.provider },
        async ({ service, storage }) => {
          const input = { ...base, agent };
          const storageKey = nativeAgentSessionStorageKey(
            base.environmentId,
            agent,
            base.logicalSessionKey,
          );
          expect((await service.dispatchIntent({ ...input, requestId: "parked" })).outcome).toBe(
            "unknown",
          );
          unavailable = true;
          const refused = await service.dispatchIntent({ ...input, requestId: "new" });
          expect(refused.outcome).toBe("rejected");
          expect(refused).not.toHaveProperty("transient");
          expect(
            (await storage.getNativeAgentSession(storageKey))?.pendingDispatch?.requestId,
          ).toBe("parked");
          expect(stub.send).toHaveBeenCalledTimes(1);
        },
      );
    });

    test(`${agent}: a clean preflight availability refusal is transient`, async () => {
      const stub = createProviderStub(agent, {
        createSession: async () => {
          throw new ProviderUnavailableError(busyRefusal);
        },
      });
      await withService(
        { prefix: "transient-create-", provider: async () => stub.provider },
        async ({ service }) => {
          const result = await service.dispatchIntent({ ...base, agent, requestId: "first" });
          expect(result).toMatchObject({ outcome: "rejected", transient: true });
          expect(stub.send).not.toHaveBeenCalled();
        },
      );
    });
  }

  test("preflight failure with a parked steer is not transient", async () => {
    let unavailable = false;
    const stub = createProviderStub("claude", {
      status: async () => {
        if (unavailable) throw new ProviderUnavailableError(busyRefusal);
        return "idle";
      },
    });
    await withService(
      { prefix: "transient-steer-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(base);
        await storage.dispatchNativeAgentSteerOnce(
          key,
          {
            requestId: "steer",
            text: "continue",
            inputDigest: "a".repeat(64),
            expectedRunId: "run-1",
            state: "prepared",
            createdAt: new Date(0).toISOString(),
          },
          async () => ({ outcome: "unknown", requestId: "steer" }),
        );
        unavailable = true;
        const refused = await service.dispatchIntent({ ...base, requestId: "new" });
        expect(refused.outcome).toBe("rejected");
        expect(refused).not.toHaveProperty("transient");
        expect((await storage.getNativeAgentSession(key))?.pendingSteer?.requestId).toBe("steer");
        expect(stub.send).not.toHaveBeenCalled();
      },
    );
  });

  test("failed pending cleanup never advertises a new-key retry", async () => {
    const stub = createProviderStub("claude", {
      send: async () => {
        throw new ProviderUnavailableError(busyRefusal);
      },
    });
    await withService(
      { prefix: "transient-cleanup-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const clear = spyOn(storage, "clearPendingNativeAgentDispatch").mockRejectedValue(
          new Error("write failed"),
        );
        try {
          const refused = await service.dispatchIntent({ ...base, requestId: "first" });
          expect(refused.outcome).toBe("rejected");
          expect(refused).not.toHaveProperty("transient");
          expect((await storage.getNativeAgentSession(key))?.pendingDispatch?.requestId).toBe(
            "first",
          );
        } finally {
          clear.mockRestore();
        }
      },
    );
  });

  test("a terminal refusal, an ambiguous dispatch and a parked conflict are not transient", async () => {
    let behaviour: "rejected" | "ambiguous" | "unavailable" = "rejected";
    const stub = createProviderStub("claude", {
      send: async () => {
        if (behaviour === "rejected") throw new PromptRejectedError("No input");
        if (behaviour === "ambiguous") throw new AmbiguousPromptDispatchError("Response was lost");
        throw new ProviderUnavailableError(busyRefusal);
      },
      dispatchStatus: async () => "unknown" as const,
    });
    await withService(
      { prefix: "orkestrator-native-transient-not-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await expect(service.dispatchIntent({ ...base, requestId: "rejected" })).resolves.toEqual({
          outcome: "rejected",
          error: "No input",
        });

        behaviour = "ambiguous";
        const ambiguous = await service.dispatchIntent({ ...base, requestId: "parked" });
        expect(ambiguous.outcome).toBe("unknown");
        expect(ambiguous).not.toHaveProperty("transient");

        // A new id is refused by the parked record, whatever the provider would say.
        behaviour = "unavailable";
        const conflict = await service.dispatchIntent({ ...base, requestId: "another" });
        expect(conflict.outcome).toBe("rejected");
        expect(conflict).not.toHaveProperty("transient");

        // Retrying the parked record keeps it parked when the provider is
        // unavailable, so the refusal is not a reason to send under a new id.
        const retry = await service.retryRecoverableDispatch({ ...base, requestId: "parked" });
        expect(retry).toEqual({ outcome: "rejected", error: busyRefusal });
        expect((await storage.getNativeAgentSession(key))?.pendingDispatch).toMatchObject({
          requestId: "parked",
        });
      },
    );
  });
});
