/**
 * A definitive steer refusal settles the backend's parked attempt: the pending
 * record and its backups go, and the id never joins delivered history. A lost
 * refusal, a thrown error, or a refusal naming another request stays on the
 * existing uncertain reconcile/retry/discard path.
 */
import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  nativeAgentSteerRejectionMessage,
  type NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import type { NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";
import type { StorageService } from "./storage.js";

type SteerAction = Parameters<NonNullable<NativeAgentRuntimeProvider["performSessionAction"]>>[1];

const REFUSAL_MESSAGE = "Wait for this turn to finish, then send again.";

function steerProvider(respond: (requestId: string) => Promise<NativeAgentSessionActionOutcome>) {
  const stub = createProviderStub("cursor");
  const performSessionAction = mock(async (_sessionId: string, action: SteerAction) =>
    respond(action.kind === "steer" ? action.requestId : ""),
  );
  Object.assign(stub.provider, {
    activeSteerRun: async () => ({ state: "running", runId: "cursor-run-1" }),
    steerStatus: async () => "unknown",
    performSessionAction,
  });
  return { provider: stub.provider, send: stub.send, performSessionAction };
}

function rejected(requestId: string): NativeAgentSessionActionOutcome {
  return {
    outcome: "rejected",
    reason: "steer-capacity-exceeded",
    requestId,
    message: REFUSAL_MESSAGE,
  };
}

async function persistedSessionText(storage: StorageService): Promise<string> {
  const dir = storage.getDataDir();
  const files = (await fs.readdir(dir)).filter((name) =>
    name.startsWith("native-agent-sessions.json"),
  );
  return (await Promise.all(files.map((name) => fs.readFile(path.join(dir, name), "utf8")))).join(
    "\n",
  );
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

describe("native agent steer rejection", () => {
  test("a verified refusal clears the pending steer without recording delivery", async () => {
    const stub = steerProvider(async (requestId) => rejected(requestId));
    await withService(
      { prefix: "orkestrator-native-steer-rejected-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = identityFor("tab-steer-rejected");
        await service.ensureSession(identity);
        const secret = "REJECTED-STEER-CONTENT";

        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: secret },
        });

        expect(outcome).toMatchObject({
          outcome: "rejected",
          reason: "steer-capacity-exceeded",
          message: REFUSAL_MESSAGE,
        });
        const sent = stub.performSessionAction.mock.calls[0]![1];
        expect(sent).toMatchObject({
          kind: "steer",
          requestId: outcome.requestId,
          expectedRunId: "cursor-run-1",
        });
        const session = await storage.getNativeAgentSession(keyFor(identity));
        expect(session?.pendingSteer).toBeUndefined();
        expect(session?.dispatchedRequestIds ?? []).not.toContain(outcome.requestId);
        // Pending backups are scrubbed along with the live record.
        expect(await persistedSessionText(storage)).not.toContain(secret);
        expect((await service.getProjection(identity))?.recoverableDispatch).toBeUndefined();

        // Nothing is parked, so the next prompt is admitted immediately.
        await expect(
          service.dispatchIntent({
            ...identity,
            prompt: "Continue after the refusal",
            requestId: "prompt-after-rejection",
          }),
        ).resolves.toEqual({ outcome: "accepted", requestId: "prompt-after-rejection" });
        expect(stub.send).toHaveBeenCalledTimes(1);
      },
    );
  });

  test("an unpublished steer record clears the pending steer like any definitive refusal", async () => {
    // No bridge message, so the protocol's fallback text reaches the user.
    const stub = steerProvider(async (requestId) => ({
      outcome: "rejected",
      reason: "steer-not-recorded",
      requestId,
    }));
    await withService(
      { prefix: "orkestrator-native-steer-not-recorded-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = identityFor("tab-steer-not-recorded");
        await service.ensureSession(identity);
        const secret = "NOT-RECORDED-STEER-CONTENT";

        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: secret },
        });

        expect(outcome).toMatchObject({ outcome: "rejected", reason: "steer-not-recorded" });
        const session = await storage.getNativeAgentSession(keyFor(identity));
        expect(session?.pendingSteer).toBeUndefined();
        expect(session?.dispatchedRequestIds ?? []).not.toContain(outcome.requestId);
        expect(await persistedSessionText(storage)).not.toContain(secret);
        expect((await service.getProjection(identity))?.recoverableDispatch).toBeUndefined();
      },
    );
  });

  test("a retried steer refused as not recorded settles with actionable text", async () => {
    let lose = true;
    const stub = steerProvider(async (requestId) => {
      if (lose) throw new Error("socket hang up");
      return { outcome: "rejected", reason: "steer-not-recorded", requestId };
    });
    await withService(
      {
        prefix: "orkestrator-native-steer-not-recorded-retry-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = identityFor("tab-steer-not-recorded-retry");
        await service.ensureSession(identity);
        const first = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Keep the change narrow" },
        });
        expect(first.outcome).toBe("unknown");
        const requestId = first.requestId!;

        lose = false;
        await expect(service.retryRecoverableDispatch({ ...identity, requestId })).resolves.toEqual(
          {
            outcome: "rejected",
            error: nativeAgentSteerRejectionMessage({ reason: "steer-not-recorded" }),
          },
        );
        const session = await storage.getNativeAgentSession(keyFor(identity));
        expect(session?.pendingSteer).toBeUndefined();
        expect(session?.dispatchedRequestIds ?? []).not.toContain(requestId);
      },
    );
  });

  test("a lost refusal stays uncertain until an exact retry is definitively refused", async () => {
    let lose = true;
    const stub = steerProvider(async (requestId) => {
      if (lose) throw new Error("socket hang up");
      return rejected(requestId);
    });
    await withService(
      { prefix: "orkestrator-native-steer-lost-rejection-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = identityFor("tab-steer-lost-rejection");
        await service.ensureSession(identity);
        const first = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Keep the change narrow" },
        });
        expect(first.outcome).toBe("unknown");
        const requestId = first.requestId!;
        const key = keyFor(identity);
        expect((await storage.getNativeAgentSession(key))?.pendingSteer).toMatchObject({
          requestId,
          state: "unknown",
        });
        await expect(service.getProjection(identity)).resolves.toMatchObject({
          recoverableDispatch: { requestId, kind: "steer", status: "action-required" },
        });

        lose = false;
        await expect(service.retryRecoverableDispatch({ ...identity, requestId })).resolves.toEqual(
          { outcome: "rejected", error: REFUSAL_MESSAGE },
        );
        const retried = stub.performSessionAction.mock.calls.at(-1)![1];
        expect(retried).toMatchObject({ requestId, expectedRunId: "cursor-run-1" });
        const session = await storage.getNativeAgentSession(key);
        expect(session?.pendingSteer).toBeUndefined();
        expect(session?.dispatchedRequestIds ?? []).not.toContain(requestId);
      },
    );
  });

  test.each([
    [
      "a refusal naming another request",
      async (): Promise<NativeAgentSessionActionOutcome> => rejected("someone-else"),
    ],
    [
      "a refusal with an unknown reason",
      async (requestId: string): Promise<NativeAgentSessionActionOutcome> =>
        ({ ...rejected(requestId), reason: "rate-limited" }) as never,
    ],
    [
      "a thrown provider rejection",
      async (): Promise<NativeAgentSessionActionOutcome> => {
        throw new Error("steer refused with 429");
      },
    ],
  ] as const)("keeps %s parked as unknown", async (name, respond) => {
    const stub = steerProvider(respond);
    await withService(
      {
        prefix: "orkestrator-native-steer-unverified-rejection-",
        provider: async () => stub.provider,
      },
      async ({ service, storage }) => {
        const identity = identityFor(`tab-steer-unverified-${name.length}`);
        await service.ensureSession(identity);
        const outcome = await service.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "Keep the change narrow" },
        });
        expect(outcome.outcome).toBe("unknown");
        const pending = (await storage.getNativeAgentSession(keyFor(identity)))?.pendingSteer;
        expect(pending).toMatchObject({ requestId: outcome.requestId, state: "unknown" });
      },
    );
  });
});
