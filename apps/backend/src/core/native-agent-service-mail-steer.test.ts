/**
 * Deliver now on mail for an agent mid-turn: the carrier is steered into the
 * running turn through the same persisted steer record as a typed `/steer`,
 * and its fate is settled from evidence only, so mail is never sent twice.
 */
import { describe, expect, mock, test } from "bun:test";
import type { NativeAgentSessionActionOutcome } from "@orkestrator/protocol/native-agent";
import type { NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

type SteerAction = Parameters<NonNullable<NativeAgentRuntimeProvider["performSessionAction"]>>[1];

const identity = {
  environmentId: "env-1",
  agent: "cursor" as const,
  logicalSessionKey: "env-env-1:mail-steer",
};
const key = nativeAgentSessionStorageKey(
  identity.environmentId,
  identity.agent,
  identity.logicalSessionKey,
);

function steerProvider(options: {
  active?: () => Promise<{ state: "running"; runId: string } | { state: "idle" }>;
  respond?: (requestId: string) => Promise<NativeAgentSessionActionOutcome>;
  status?: () => Promise<"dispatched" | "absent" | "unknown">;
}) {
  const stub = createProviderStub("cursor");
  const performSessionAction = mock(async (_sessionId: string, action: SteerAction) =>
    (options.respond ?? (async () => ({ outcome: "applied" as const })))(
      action.kind === "steer" ? action.requestId : "",
    ),
  );
  Object.assign(stub.provider, {
    activeSteerRun: options.active ?? (async () => ({ state: "running", runId: "run-1" })),
    steerStatus: options.status ?? (async () => "unknown"),
    performSessionAction,
  });
  return { provider: stub.provider, send: stub.send, performSessionAction };
}

describe("native agent mail steer", () => {
  test("steers the carrier into the running turn and records it as delivered", async () => {
    const stub = steerProvider({});
    await withService(
      { prefix: "orkestrator-mail-steer-applied-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        const outcome = await service.steerMailInject({
          ...identity,
          text: "<orkestrator-peer-message>hello</orkestrator-peer-message>",
          requestId: "11111111-1111-4111-8111-111111111111",
        });
        expect(outcome).toEqual({ outcome: "applied" });
        expect(stub.performSessionAction.mock.calls[0]![1]).toMatchObject({
          kind: "steer",
          requestId: "11111111-1111-4111-8111-111111111111",
          expectedRunId: "run-1",
        });
        expect(stub.send).not.toHaveBeenCalled();
        const session = await storage.getNativeAgentSession(key);
        expect(session?.pendingSteer).toBeUndefined();
        expect(session?.dispatchedRequestIds).toContain("11111111-1111-4111-8111-111111111111");
        await expect(
          service.reconcileMailSteer({
            ...identity,
            requestId: "11111111-1111-4111-8111-111111111111",
          }),
        ).resolves.toBe("dispatched");
      },
    );
  });

  test("reports an idle turn without touching the provider", async () => {
    const stub = steerProvider({ active: async () => ({ state: "idle" }) });
    await withService(
      { prefix: "orkestrator-mail-steer-idle-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        await expect(
          service.steerMailInject({ ...identity, text: "mail", requestId: "steer-idle" }),
        ).resolves.toEqual({ outcome: "idle" });
        expect(stub.performSessionAction).not.toHaveBeenCalled();
      },
    );
  });

  test("a turn changing after the active-run lookup refuses mail without ordinary fallback", async () => {
    const stub = steerProvider({
      active: async () => ({ state: "running", runId: "run-before-race" }),
      respond: async () => ({ outcome: "mismatch" }),
    });
    await withService(
      { prefix: "orkestrator-mail-steer-raced-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        await expect(
          service.steerMailInject({ ...identity, text: "mail", requestId: "steer-raced" }),
        ).resolves.toEqual({ outcome: "refused", reason: "steer-refused" });
        expect(stub.performSessionAction.mock.calls[0]![1]).toMatchObject({
          kind: "steer",
          expectedRunId: "run-before-race",
          requestId: "steer-raced",
        });
        expect(stub.send).not.toHaveBeenCalled();
        const session = await storage.getNativeAgentSession(key);
        expect(session?.pendingSteer).toBeUndefined();
        expect(session?.dispatchedRequestIds ?? []).not.toContain("steer-raced");
      },
    );
  });

  test("a never-prompted tab has no turn to steer", async () => {
    const stub = steerProvider({});
    await withService(
      { prefix: "orkestrator-mail-steer-cold-", provider: async () => stub.provider },
      async ({ service }) => {
        await expect(
          service.steerMailInject({ ...identity, text: "mail", requestId: "steer-cold" }),
        ).resolves.toEqual({ outcome: "idle" });
      },
    );
  });

  test("a provider without steering refuses as unsupported", async () => {
    const stub = createProviderStub("cursor");
    await withService(
      { prefix: "orkestrator-mail-steer-unsupported-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        await expect(
          service.steerMailInject({ ...identity, text: "mail", requestId: "steer-unsupported" }),
        ).resolves.toEqual({ outcome: "refused", reason: "steer-unsupported" });
      },
    );
  });

  test("an unanswered steer stays parked until the steer journal settles it", async () => {
    let journal: "dispatched" | "absent" | "unknown" = "unknown";
    const stub = steerProvider({
      respond: async () => {
        throw new Error("connection lost");
      },
      status: async () => journal,
    });
    await withService(
      { prefix: "orkestrator-mail-steer-unknown-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        await expect(
          service.steerMailInject({ ...identity, text: "mail", requestId: "steer-unknown" }),
        ).resolves.toEqual({ outcome: "unknown" });
        expect((await storage.getNativeAgentSession(key))?.pendingSteer?.requestId).toBe(
          "steer-unknown",
        );

        await expect(
          service.reconcileMailSteer({ ...identity, requestId: "steer-unknown" }),
        ).resolves.toBe("unknown");
        journal = "absent";
        await expect(
          service.reconcileMailSteer({ ...identity, requestId: "steer-unknown" }),
        ).resolves.toBe("not-dispatched");
        const session = await storage.getNativeAgentSession(key);
        expect(session?.pendingSteer).toBeUndefined();
        expect(session?.dispatchedRequestIds ?? []).not.toContain("steer-unknown");
      },
    );
  });

  test("a steer id with no record anywhere is unknown, never unsent", async () => {
    const stub = steerProvider({});
    await withService(
      { prefix: "orkestrator-mail-steer-missing-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        await expect(
          service.reconcileMailSteer({ ...identity, requestId: "steer-never-seen" }),
        ).resolves.toBe("unknown");
      },
    );
  });

  test("an earlier unresolved steer is left to settle first", async () => {
    const stub = steerProvider({
      respond: async () => {
        throw new Error("connection lost");
      },
    });
    await withService(
      { prefix: "orkestrator-mail-steer-parked-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        await service.steerMailInject({ ...identity, text: "first", requestId: "steer-first" });
        await expect(
          service.steerMailInject({ ...identity, text: "second", requestId: "steer-second" }),
        ).resolves.toEqual({ outcome: "refused", reason: "steer-refused" });
        expect(stub.performSessionAction).toHaveBeenCalledTimes(1);
      },
    );
  });
});
