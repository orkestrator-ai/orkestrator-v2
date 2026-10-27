import { expect, mock, spyOn, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION as VERSION,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const identity = {
  environmentId: "env-1",
  agent: "claude" as const,
  logicalSessionKey: "remember-tab",
};

function permissionRequest(id = "approval"): AgentInteractionRequest {
  return {
    version: VERSION,
    id,
    provider: "claude",
    kind: "command-approval",
    origin: "interactive-native",
    sessionId: "provider-session",
    state: "pending",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    presentation: { title: "Run command", questions: [], confirmLabel: "Approve" },
  };
}

test.each([false, true])(
  "remember service resolves session and refreshes after approval (save failure %s)",
  async (saveFailure) => {
    let pending = [permissionRequest()];
    const resolve = mock(async () => {
      pending = [];
      return {
        result: "applied" as const,
        interactionId: "approval",
        sessionId: "provider-session",
        revision: 2,
      };
    });
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      interactions: {
        listPendingInteractions: async () => ({ version: VERSION, revision: 1, requests: pending }),
        resolveInteraction: resolve,
        permissionRuleDetail: () => ({
          subject: { kind: "command", command: "npm test" },
          allowOnceAnswers: [],
        }),
      },
    });
    await withService(
      {
        prefix: "remember-service-",
        provider: async () => stub.provider,
        environment: { agentSettings: { executionPolicy: { approvals: "ask" } } },
      },
      async ({ service, storage }) => {
        await expect(
          service.approveProjectionInteractionAndRemember({
            ...identity,
            interactionId: " ",
            choice: { pattern: "npm test", scope: "project", anyProvider: false },
          }),
        ).rejects.toThrow("must not be blank");
        await expect(
          service.approveProjectionInteractionAndRemember({
            ...identity,
            interactionId: "missing-session",
            choice: { pattern: "npm test", scope: "project", anyProvider: false },
          }),
        ).rejects.toThrow("session was not found");
        expect(resolve).not.toHaveBeenCalled();
        await service.ensureSession(identity);
        expect((await service.getProjection(identity))?.interactions).toHaveLength(1);
        if (saveFailure)
          storage.permissionRuleStore().create = () => {
            throw new Error("database unavailable");
          };
        const internal = service as unknown as {
          interactions: { forgetPendingInteractions(key: string): void };
          projections: { refreshProjection(input: unknown, force: boolean): Promise<unknown> };
        };
        const forget = spyOn(internal.interactions, "forgetPendingInteractions");
        const refresh = spyOn(internal.projections, "refreshProjection");
        const result = await service.approveProjectionInteractionAndRemember({
          ...identity,
          interactionId: "approval",
          choice: { pattern: "npm test", scope: "project", anyProvider: false },
        });
        expect(result.outcome.result).toBe("applied");
        expect(forget).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledWith(expect.objectContaining(identity), true);
        expect(Boolean(result.ruleSaveWarning)).toBe(saveFailure);
        expect(resolve).toHaveBeenCalledTimes(1);
        expect((await service.getProjection(identity))?.interactions).toEqual([]);
        expect(storage.permissionRuleStore().list()).toHaveLength(saveFailure ? 0 : 1);
        const again = await service.approveProjectionInteractionAndRemember({
          ...identity,
          interactionId: "approval",
          choice: { pattern: "npm test", scope: "project", anyProvider: false },
        });
        expect(again.outcome.result).toBe("stale");
        expect(resolve).toHaveBeenCalledTimes(1);
      },
    );
  },
);
