/**
 * A steer that misses its turn starts a new turn (todo 0005, task 10). `idle`
 * and `mismatch` are definitive "not sent" answers, so the text goes out once
 * more under a request id of its own: as an ordinary turn now when nothing is
 * running, or through the prompt queue when something else is. A caller that
 * bound the steer to one run is still told instead, and nothing is sent.
 */
import { describe, expect, mock, test } from "bun:test";
import type { NativeAgentSessionActionOutcome } from "@orkestrator/protocol/native-agent";
import type { ProviderStatus } from "./agent-provider-contract.js";
import type { NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

type SteerAction = Parameters<NonNullable<NativeAgentRuntimeProvider["performSessionAction"]>>[1];

function steerProvider(options: {
  active: "running" | "idle";
  steer?: (requestId: string) => Promise<NativeAgentSessionActionOutcome>;
  status?: () => ProviderStatus;
}) {
  const stub = createProviderStub("cursor", {
    status: async () => options.status?.() ?? "idle",
  });
  const performSessionAction = mock(async (_sessionId: string, action: SteerAction) =>
    options.steer
      ? options.steer(action.kind === "steer" ? action.requestId : "")
      : ({ outcome: "applied" } as NativeAgentSessionActionOutcome),
  );
  Object.assign(stub.provider, {
    activeSteerRun: async () =>
      options.active === "running"
        ? { state: "running", runId: "cursor-run-1" }
        : { state: "idle" },
    steerStatus: async () => "unknown",
    performSessionAction,
  });
  return { ...stub, performSessionAction };
}

function identityFor(tab: string) {
  return {
    environmentId: "env-1",
    agent: "cursor" as const,
    logicalSessionKey: `env-env-1:${tab}`,
  };
}

function keyFor(identity: ReturnType<typeof identityFor>) {
  return nativeAgentSessionStorageKey(
    identity.environmentId,
    identity.agent,
    identity.logicalSessionKey,
  );
}

function queueKeyFor(identity: ReturnType<typeof identityFor>) {
  return `${identity.agent}\0${identity.logicalSessionKey}`;
}

describe("a steer that misses its turn", () => {
  test("is sent as a new turn when no turn is running", async () => {
    const stub = steerProvider({ active: "idle" });
    await withService(
      { prefix: "orkestrator-native-missed-steer-idle-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = identityFor("tab-missed-idle");
        await service.ensureSession(identity);

        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "  Keep the change narrow  " },
        });

        expect(outcome).toMatchObject({ outcome: "applied", deliveredAs: "new-turn" });
        expect(outcome.requestId).toBeString();
        // The backend's own idle pre-check sent nothing as a steer.
        expect(stub.performSessionAction).not.toHaveBeenCalled();
        expect(stub.send).toHaveBeenCalledTimes(1);
        expect(stub.send.mock.calls[0]![1]).toContain("Keep the change narrow");
        const session = await storage.getNativeAgentSession(keyFor(identity));
        expect(session?.dispatchedRequestIds).toContain(outcome.requestId);
        expect(session?.pendingDispatch).toBeUndefined();
        expect(await storage.getPromptQueue(queueKeyFor(identity))).toBeNull();
      },
    );
  });

  test("is sent as a new turn when the provider answers that its turn ended", async () => {
    const stub = steerProvider({ active: "running", steer: async () => ({ outcome: "idle" }) });
    await withService(
      { prefix: "orkestrator-native-missed-steer-late-idle-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = identityFor("tab-missed-late-idle");
        await service.ensureSession(identity);

        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Check the parser" },
        });

        expect(outcome).toMatchObject({ outcome: "applied", deliveredAs: "new-turn" });
        const steerRequestId = (
          stub.performSessionAction.mock.calls[0]![1] as { requestId: string }
        ).requestId;
        // The turn has its own id: the bridge has already seen the steer's.
        expect(outcome.requestId).not.toBe(steerRequestId);
        expect(stub.send).toHaveBeenCalledTimes(1);
        const session = await storage.getNativeAgentSession(keyFor(identity));
        expect(session?.pendingSteer).toBeUndefined();
        expect(session?.dispatchedRequestIds).toContain(outcome.requestId);
        expect(session?.dispatchedRequestIds ?? []).not.toContain(steerRequestId);
      },
    );
  });

  test("is queued, never steered, when a different turn is running", async () => {
    const stub = steerProvider({
      active: "running",
      steer: async () => ({ outcome: "mismatch" }),
      status: () => "running",
    });
    await withService(
      { prefix: "orkestrator-native-missed-steer-mismatch-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = identityFor("tab-missed-mismatch");
        await service.ensureSession(identity);

        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Use the new schema" },
        });

        expect(outcome).toMatchObject({ outcome: "applied", deliveredAs: "queued" });
        expect(stub.performSessionAction).toHaveBeenCalledTimes(1);
        expect(stub.send).not.toHaveBeenCalled();
        const queue = await storage.getPromptQueue(queueKeyFor(identity));
        expect(queue?.messages).toEqual([
          {
            id: outcome.requestId,
            requestId: outcome.requestId,
            text: "Use the new schema",
            command: { kind: "literal" },
            preserveSessionMode: true,
          },
        ]);
        expect(
          (await storage.getNativeAgentSession(keyFor(identity)))?.pendingSteer,
        ).toBeUndefined();
      },
    );
  });

  test("is queued when a turn starts between the miss and the new turn", async () => {
    const stub = steerProvider({ active: "idle", status: () => "running" });
    await withService(
      { prefix: "orkestrator-native-missed-steer-raced-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = identityFor("tab-missed-raced");
        await service.ensureSession(identity);

        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Rename the flag" },
        });

        expect(outcome).toMatchObject({ outcome: "applied", deliveredAs: "queued" });
        expect(stub.send).not.toHaveBeenCalled();
        const session = await storage.getNativeAgentSession(keyFor(identity));
        // The held admission opened nothing: the id is unsent and only queued.
        expect(session?.pendingDispatch).toBeUndefined();
        expect(session?.dispatchedRequestIds ?? []).not.toContain(outcome.requestId);
        expect((await storage.getPromptQueue(queueKeyFor(identity)))?.messages).toMatchObject([
          { id: outcome.requestId, text: "Rename the flag" },
        ]);
      },
    );
  });

  test("waits behind prompts the user queued first", async () => {
    const stub = steerProvider({ active: "idle", status: () => "running" });
    await withService(
      { prefix: "orkestrator-native-missed-steer-backlog-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = identityFor("tab-missed-backlog");
        await service.ensureSession(identity);
        await storage.savePromptQueue(queueKeyFor(identity), "env-1", [
          { id: "queued-first", text: "Run the tests" },
        ]);

        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Then update the docs" },
        });

        expect(outcome).toMatchObject({ outcome: "applied", deliveredAs: "queued" });
        expect(stub.send).not.toHaveBeenCalled();
        expect(
          (await storage.getPromptQueue(queueKeyFor(identity)))?.messages.map(
            (message) => (message as { id: string }).id,
          ),
        ).toEqual(["queued-first", outcome.requestId!]);
      },
    );
  });

  test("goes out once under a caller's turn id, however often it is replayed", async () => {
    const stub = steerProvider({ active: "idle" });
    await withService(
      { prefix: "orkestrator-native-missed-steer-replay-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = identityFor("tab-missed-replay");
        await service.ensureSession(identity);
        const action = {
          kind: "steer" as const,
          text: "Keep the change narrow",
          turnRequestId: "op-turn-1",
        };

        const first = await service.performProjectionAction({ ...identity, action });
        const second = await service.performProjectionAction({ ...identity, action });

        expect(first).toEqual({
          outcome: "applied",
          deliveredAs: "new-turn",
          requestId: "op-turn-1",
        });
        expect(second).toEqual(first);
        expect(stub.send).toHaveBeenCalledTimes(1);
      },
    );
  });

  test.each(["idle", "mismatch"] as const)(
    "is refused with %s and sends nothing when the caller bound it to its run",
    async (missed) => {
      const stub = steerProvider({
        active: "running",
        steer: async () => ({ outcome: missed }),
        status: () => "running",
      });
      await withService(
        {
          prefix: `orkestrator-native-missed-steer-refuse-${missed}-`,
          provider: async () => stub.provider,
        },
        async ({ service, storage }) => {
          const identity = identityFor(`tab-missed-refuse-${missed}`);
          await service.ensureSession(identity);

          const outcome = await service.performProjectionAction({
            ...identity,
            action: { kind: "steer", text: "Only for this run", onMissedTurn: "refuse" },
          });

          expect(outcome).toEqual({ outcome: missed });
          expect(stub.send).not.toHaveBeenCalled();
          expect(await storage.getPromptQueue(queueKeyFor(identity))).toBeNull();
        },
      );
    },
  );

  test("a parked steer whose retry finds the turn over becomes a new turn", async () => {
    let lose = true;
    const stub = steerProvider({
      active: "running",
      steer: async () => {
        if (lose) throw new Error("socket hang up");
        return { outcome: "idle" };
      },
    });
    await withService(
      { prefix: "orkestrator-native-missed-steer-retry-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = identityFor("tab-missed-retry");
        await service.ensureSession(identity);
        const parked = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Keep the change narrow" },
        });
        expect(parked.outcome).toBe("unknown");
        // The ambiguous steer stays parked: its text may already be in a turn.
        expect(stub.send).not.toHaveBeenCalled();

        lose = false;
        const retried = await service.retryRecoverableDispatch({
          ...identity,
          requestId: parked.requestId!,
        });

        expect(retried).toMatchObject({ outcome: "accepted", deliveredAs: "new-turn" });
        if (retried.outcome !== "accepted") throw new Error("expected acceptance");
        expect(retried.requestId).not.toBe(parked.requestId);
        expect(stub.send).toHaveBeenCalledTimes(1);
        const session = await storage.getNativeAgentSession(keyFor(identity));
        expect(session?.pendingSteer).toBeUndefined();
        expect(session?.dispatchedRequestIds).toContain(retried.requestId);
        expect(session?.dispatchedRequestIds ?? []).not.toContain(parked.requestId);
      },
    );
  });
});
