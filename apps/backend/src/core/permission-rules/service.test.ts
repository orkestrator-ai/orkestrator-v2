import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import type { ProviderActivityState } from "../native-agent-provider.js";
import { nativeAgentSessionStorageKey } from "../native-agent-service.js";
import {
  createProviderStub,
  withService,
} from "../native-agent-service-projection-test-support.js";

/**
 * Rules apply from the backend's own activity sweep: no tab has to be mounted,
 * and a request a rule answers never becomes a waiting edge (todo 0723).
 */

function approval(id: string): AgentInteractionRequest {
  const now = Date.now();
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id,
    provider: "codex",
    kind: "command-approval",
    origin: "interactive-native",
    sessionId: "provider-1",
    state: "pending",
    revision: 0,
    presentation: { title: "Approve command", questions: [] },
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
    expiresAt: now + 60_000,
  };
}

function interactions(pending: { current: AgentInteractionRequest[] }) {
  const resolutions: AgentInteractionResolution[] = [];
  return {
    resolutions,
    capability: {
      listPendingInteractions: async (sessionId: string): Promise<AgentInteractionSnapshot> =>
        ({
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          sessionId,
          revision: 1,
          requests: pending.current,
        }) as unknown as AgentInteractionSnapshot,
      resolveInteraction: async (
        sessionId: string,
        interactionId: string,
        resolution: AgentInteractionResolution,
      ) => {
        resolutions.push(resolution);
        pending.current = pending.current.filter((request) => request.id !== interactionId);
        return { result: "applied" as const, interactionId, sessionId, revision: 2 };
      },
      permissionRuleDetail: () => ({
        subject: { kind: "command" as const, command: "npm test" },
        allowOnceAnswers: [],
      }),
    },
  };
}

describe("permission rules in the activity sweep", () => {
  for (const withRule of [true, false]) {
    test(
      withRule
        ? "a rule answers a waiting session with no tab mounted and no waiting edge"
        : "without a rule the session waits for the user as before",
      async () => {
        const pending = { current: [approval("a1")] };
        const fake = interactions(pending);
        let state: ProviderActivityState = "waiting";
        const { provider } = createProviderStub("codex", {
          activity: async () => (pending.current.length > 0 ? "waiting" : state),
          interactions: fake.capability,
        });
        await withService(
          {
            prefix: "orkestrator-permission-rule-sweep-",
            provider: async () => provider,
            environment: { networkAccessMode: "full" },
          },
          async ({ storage, service }) => {
            await storage.adoptNativeAgentSession({
              key: nativeAgentSessionStorageKey("env-1", "codex", "tab-1"),
              environmentId: "env-1",
              agent: "codex",
              logicalSessionKey: "tab-1",
              providerSessionId: "provider-1",
              policy: {
                id: "interactive-host",
                sandbox: "none",
                approvals: "ask",
                projectResources: true,
                networkAccess: "full",
              },
            });
            if (withRule) {
              storage.permissionRuleStore().create({
                id: "rule-1",
                provider: "codex",
                scope: "project",
                projectId: "project-1",
                kind: "command-prefix",
                pattern: "npm test",
                createdAt: 1,
                createdFrom: { environmentId: "env-1", agent: "codex", interactionId: "i-0" },
                useCount: 0,
              });
            }
            state = "working";

            await service.reconcileAgentActivity();

            if (withRule) {
              expect(fake.resolutions).toHaveLength(1);
              expect(fake.resolutions[0]).toMatchObject({ interactionId: "a1", action: "answer" });
              expect(service.sessionActivitySnapshot("env-1", "codex", "tab-1")).toBe("working");
              expect((await storage.getEnvironment("env-1"))?.unreadReason).not.toBe(
                "agent_waiting",
              );
              expect(storage.permissionRuleStore().listApplications()).toEqual([
                expect.objectContaining({
                  ruleId: "rule-1",
                  environmentId: "env-1",
                  logicalSessionKey: "tab-1",
                }),
              ]);
            } else {
              expect(fake.resolutions).toEqual([]);
              expect(service.sessionActivitySnapshot("env-1", "codex", "tab-1")).toBe("waiting");
            }
          },
        );
      },
    );
  }
});
