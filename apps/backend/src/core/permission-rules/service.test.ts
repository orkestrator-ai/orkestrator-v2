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
  addEnvironment,
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

/**
 * Task 5 of todo 0723 without the app: a rule answers an environment nobody is
 * looking at while another one is on screen. "On screen" has no backend state;
 * what matters is that the sweep, not a mounted tab, answers, that each
 * environment keeps its own rules, and that the tab mounted on return reads no
 * card and the application its transcript note is drawn from.
 */
describe("permission rules for an environment that is not on screen", () => {
  const POLICY = {
    id: "interactive-host",
    sandbox: "none",
    approvals: "ask",
    projectResources: true,
    networkAccess: "full",
  } as const;

  function commandApproval(id: string, sessionId: string): AgentInteractionRequest {
    return { ...approval(id), sessionId };
  }

  /** Pending requests per provider session; each request id names its command. */
  function multiSession(
    pending: Map<string, AgentInteractionRequest[]>,
    commands: Map<string, string>,
  ) {
    const resolutions: AgentInteractionResolution[] = [];
    return {
      resolutions,
      capability: {
        listPendingInteractions: async (sessionId: string): Promise<AgentInteractionSnapshot> =>
          ({
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            sessionId,
            revision: 1,
            requests: pending.get(sessionId) ?? [],
          }) as unknown as AgentInteractionSnapshot,
        resolveInteraction: async (
          sessionId: string,
          interactionId: string,
          resolution: AgentInteractionResolution,
        ) => {
          resolutions.push(resolution);
          pending.set(
            sessionId,
            (pending.get(sessionId) ?? []).filter((request) => request.id !== interactionId),
          );
          return { result: "applied" as const, interactionId, sessionId, revision: 2 };
        },
        permissionRuleDetail: (_sessionId: string, interactionId: string) => {
          const command = commands.get(interactionId);
          return command
            ? { subject: { kind: "command" as const, command }, allowOnceAnswers: [] }
            : null;
        },
      },
    };
  }

  test("answers only the environment its rule belongs to, and the returning tab reads no card", async () => {
    const pending = new Map([
      ["provider-a", [commandApproval("a1", "provider-a")]],
      ["provider-b", [commandApproval("b1", "provider-b")]],
    ]);
    const fake = multiSession(
      pending,
      new Map([
        ["a1", "npm test"],
        ["b1", "npm test"],
      ]),
    );
    const { provider } = createProviderStub("codex", {
      activity: async (sessionId) =>
        (pending.get(sessionId)?.length ?? 0) > 0 ? "waiting" : "working",
      interactions: fake.capability,
      interactiveSnapshot: async () => ({ status: "running", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-permission-rule-inactive-",
        provider: async () => provider,
        environment: { networkAccessMode: "full" },
      },
      async ({ storage, service }) => {
        await addEnvironment(storage, {
          id: "env-2",
          name: "On screen",
          networkAccessMode: "full",
          worktreePath: "/tmp/env-2",
          order: 1,
        });
        for (const [environmentId, tab, providerSessionId] of [
          ["env-1", "tab-a", "provider-a"],
          ["env-2", "tab-b", "provider-b"],
        ] as const) {
          await storage.adoptNativeAgentSession({
            key: nativeAgentSessionStorageKey(environmentId, "codex", tab),
            environmentId,
            agent: "codex",
            logicalSessionKey: tab,
            providerSessionId,
            policy: POLICY,
          });
        }
        // Saved from env-1's card for env-1 only; env-2 runs the same command.
        storage.permissionRuleStore().create({
          id: "rule-env-1",
          provider: "codex",
          scope: "environment",
          projectId: "project-1",
          environmentId: "env-1",
          kind: "command-prefix",
          pattern: "npm test",
          createdAt: 1,
          createdFrom: { environmentId: "env-1", agent: "codex", interactionId: "i-0" },
          useCount: 0,
        });

        await service.reconcileAgentActivity();

        expect(fake.resolutions.map((resolution) => resolution.interactionId)).toEqual(["a1"]);
        expect(service.sessionActivitySnapshot("env-1", "codex", "tab-a")).toBe("working");
        expect((await storage.getEnvironment("env-1"))?.unreadReason).not.toBe("agent_waiting");
        expect(service.sessionActivitySnapshot("env-2", "codex", "tab-b")).toBe("waiting");

        // Returning to env-1 mounts its tab: no card, and the application the
        // transcript note is drawn from (`list_permission_rules` by session).
        const returning = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "tab-a",
        };
        expect((await service.getProjection(returning))?.interactions).toEqual([]);
        expect(storage.permissionRuleStore().listApplications(returning)).toEqual([
          expect.objectContaining({
            ruleId: "rule-env-1",
            interactionId: "a1",
            scope: "environment",
          }),
        ]);
        expect(
          storage.permissionRuleStore().listApplications({
            environmentId: "env-2",
            agent: "codex",
            logicalSessionKey: "tab-b",
          }),
        ).toEqual([]);
        expect(
          (
            await service.getProjection({
              environmentId: "env-2",
              agent: "codex",
              logicalSessionKey: "tab-b",
            })
          )?.interactions.map((interaction) => interaction.id),
        ).toEqual(["b1"]);
      },
    );
  });

  test("a request no rule matches keeps the session waiting after another is answered", async () => {
    const pending = new Map([
      ["provider-a", [commandApproval("a1", "provider-a"), commandApproval("a2", "provider-a")]],
    ]);
    const fake = multiSession(
      pending,
      new Map([
        ["a1", "npm test"],
        ["a2", "git push origin main"],
      ]),
    );
    const { provider } = createProviderStub("codex", {
      activity: async (sessionId) =>
        (pending.get(sessionId)?.length ?? 0) > 0 ? "waiting" : "working",
      interactions: fake.capability,
      interactiveSnapshot: async () => ({ status: "running", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-permission-rule-partial-",
        provider: async () => provider,
        environment: { networkAccessMode: "full" },
      },
      async ({ storage, service }) => {
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("env-1", "codex", "tab-a"),
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "tab-a",
          providerSessionId: "provider-a",
          policy: POLICY,
        });
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

        await service.reconcileAgentActivity();

        expect(fake.resolutions.map((resolution) => resolution.interactionId)).toEqual(["a1"]);
        // The unmatched request still needs a person, so the waiting edge stays.
        expect(service.sessionActivitySnapshot("env-1", "codex", "tab-a")).toBe("waiting");
        expect(
          (
            await service.getProjection({
              environmentId: "env-1",
              agent: "codex",
              logicalSessionKey: "tab-a",
            })
          )?.interactions.map((interaction) => interaction.id),
        ).toEqual(["a2"]);
      },
    );
  });
});
