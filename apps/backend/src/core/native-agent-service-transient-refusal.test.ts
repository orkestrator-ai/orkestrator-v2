/**
 * A prompt the provider refused because it was temporarily unavailable (a
 * bridge's 503 before dispatch, an unreachable bridge) sent nothing and parks
 * nothing, so its rejection says `transient`: the same prompt under a new
 * request id may succeed (7260). Refusals that will not change on their own,
 * ambiguous dispatches and recovery retries that keep their parked record
 * never carry it, because a new id there either fails the same way or could
 * run the prompt twice.
 */
import { describe, expect, test } from "bun:test";
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
