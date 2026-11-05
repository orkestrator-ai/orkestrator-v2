import { describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorConversationSessionKey,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { AgentMailService } from "./agent-mail-service.js";
import { createNativeAgentDisplayTail } from "./native-agent-display-tails.js";
import type { NativeAgentService } from "./native-agent-service.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { createProject, type StorageService } from "./storage.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const CONVERSATION = "held";
const SIBLING = "sibling";
const logicalKey = (id: string) =>
  coordinatorConversationSessionKey("coordinator-1", { id, tabId: `tab-${id}` });
const session = (id: string, agent: AgentPlatform = "codex") => ({
  environmentId: coordinatorRuntimeId("coordinator-1", id),
  agent,
  logicalSessionKey: logicalKey(id),
});
const liveWindow = { messages: 100, targetBytes: 512 * 1024 };

type Hold = "paused" | "startup-failed" | "platform-off" | "safety-level";

/**
 * An unavailable platform holds only the conversations on it, so those two
 * holds put the conversation on a platform its sibling, on Codex, is not on.
 * Grok is the one platform below the default safety level.
 */
const HELD_AGENT: Record<Hold, AgentPlatform> = {
  paused: "codex",
  "startup-failed": "codex",
  "platform-off": "claude",
  "safety-level": "grok",
};
const held = (hold: Hold) => session(CONVERSATION, HELD_AGENT[hold]);

/**
 * What "connecting" means for a conversation that may not run. The pane reads
 * while paused, after a failed start or with its platform unavailable, and those
 * reads must never reach what starts a provider. `providerStarts` counts every
 * resolution, because resolving a provider is what starts its bridge; `turns`
 * counts every prompt a provider was sent, and `mailAttempts` every mail dispatch
 * that got as far as preparing the checkout.
 */
async function withHeldConversation(
  hold: Hold,
  run: (input: {
    service: NativeAgentService;
    storage: StorageService;
    providerStarts: () => number;
    turns: () => number;
    aborted: () => number;
    holdAgain: () => Promise<void>;
    setRunning: (running: boolean) => void;
    setStatusUnavailable: (unavailable: boolean) => void;
    mailAttempts: () => number;
    /** Turn the platform back on, or lower the safety level to admit it. */
    release: () => Promise<void>;
  }) => Promise<void>,
) {
  let starts = 0;
  let turns = 0;
  let running = false;
  let statusUnavailable = false;
  let aborted = 0;
  let mailAttempts = 0;
  const stubs = new Map<AgentPlatform, ReturnType<typeof createProviderStub>>();
  await withService(
    {
      prefix: `ork-held-coordinator-${hold}-`,
      provider: async (input) => {
        starts += 1;
        const stub =
          stubs.get(input.agent) ??
          createProviderStub(input.agent, {
            messages: async (id) => [
              {
                id: `row-${id.replace("provider-", "")}`,
                role: "assistant",
                content: "Saved answer",
                parts: [],
              },
            ],
            status: async () => {
              if (statusUnavailable) throw new Error("Status unavailable");
              return running ? "running" : "idle";
            },
            abort: async () => {
              aborted += 1;
              running = false;
              statusUnavailable = false;
            },
            send: async () => {
              turns += 1;
            },
          });
        stubs.set(input.agent, stub);
        return stub.provider;
      },
      beforeMailInject: async () => {
        mailAttempts += 1;
      },
    },
    async ({ storage, service }) => {
      const now = new Date(0).toISOString();
      const project = await storage.addProject(createProject("remote", tmpdir()));
      const agentOf = (id: string) => (id === CONVERSATION ? HELD_AGENT[hold] : "codex");
      const conversation = (id: string, role: "main" | "side") => ({
        id,
        tabId: `tab-${id}`,
        logicalSessionKey: logicalKey(id),
        agent: agentOf(id),
        title: id,
        createdAt: now,
        mailboxIncarnationId: `incarnation-${id}`,
        role,
        ...(role === "side" ? { sideOrdinal: 1 } : {}),
      });
      await storage.coordinators.mutateCoordinatorWorkspace(project.id, () => ({
        version: COORDINATOR_WORKSPACE_VERSION,
        id: "coordinator-1",
        projectId: project.id,
        executionPolicy: COORDINATOR_EXECUTION_POLICY,
        lifecycleState: "ready",
        conversations: [conversation(CONVERSATION, "side"), conversation(SIBLING, "main")],
        selectedConversationId: CONVERSATION,
        repositoryContextRevision: 1,
        createdAt: now,
        updatedAt: now,
      }));
      for (const id of [CONVERSATION, SIBLING]) {
        const identity = session(id, agentOf(id));
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        await storage.adoptNativeAgentSession({
          key,
          ...identity,
          providerSessionId: `provider-${id}`,
          origin: "coordinator",
          executionPolicy: COORDINATOR_EXECUTION_POLICY,
          owner: { kind: "coordinator", projectId: project.id, coordinatorId: "coordinator-1" },
        });
        await storage.putNativeAgentDisplayTail(
          key,
          createNativeAgentDisplayTail({
            ...identity,
            providerSessionId: `provider-${id}`,
            historyEpoch: `epoch-${id}`,
            messages: [{ id: `row-${id}`, role: "assistant", content: "Saved answer", parts: [] }],
            updatedAt: now,
          })!,
        );
      }
      await storage.coordinators.mutateCoordinatorWorkspace(project.id, (workspace) => ({
        ...workspace!,
        ...(hold === "paused" ? { lifecycleState: "paused" as const } : {}),
        conversations: workspace!.conversations.map((item) =>
          hold === "startup-failed" && item.id === CONVERSATION
            ? { ...item, startupError: "bridge did not become healthy" }
            : item,
        ),
      }));
      const settings = async (global: Record<string, unknown>) => {
        const config = await storage.loadConfig();
        await storage.saveConfig({ ...config, global: { ...config.global, ...global } });
      };
      // Grok Build stays turned on, so that only the safety level holds it.
      if (hold === "platform-off") await settings({ enabledAgentPlatforms: ["codex"] });
      if (hold === "safety-level") await settings({ enabledAgentPlatforms: ["codex", "grok"] });
      await run({
        service,
        storage,
        providerStarts: () => starts,
        turns: () => turns,
        aborted: () => aborted,
        setRunning: (value) => {
          running = value;
        },
        setStatusUnavailable: (value) => {
          statusUnavailable = value;
        },
        holdAgain: () =>
          settings(
            hold === "platform-off"
              ? { enabledAgentPlatforms: ["codex"] }
              : { coordinatorProviderTiers: "enforced" },
          ),
        mailAttempts: () => mailAttempts,
        release: () =>
          settings(
            hold === "platform-off"
              ? { enabledAgentPlatforms: ["codex", "claude"] }
              : { coordinatorProviderTiers: "advisory" },
          ),
      });
    },
  );
}

const EVERY_HOLD = ["paused", "startup-failed", "platform-off", "safety-level"] as const;

describe.each(EVERY_HOLD)("a %s coordinator conversation", (hold) => {
  test("Stop without a cached provider returns null and starts nothing", async () => {
    await withHeldConversation(hold, async ({ service, providerStarts, turns, aborted }) => {
      expect(await service.stopProjectionSession(held(hold))).toBeNull();
      expect(providerStarts()).toBe(0);
      expect(turns()).toBe(0);
      expect(aborted()).toBe(0);
    });
  });

  test("answers every read a connecting pane sends from saved data, starting nothing", async () => {
    await withHeldConversation(hold, async ({ service, providerStarts }) => {
      const input = held(hold);
      const transcript = await service.getTranscriptUpdate({
        ...input,
        viewVersion: 1,
        liveWindow,
      });
      expect(transcript).toMatchObject({
        status: "snapshot",
        value: { messages: [{ id: `row-${CONVERSATION}` }], freshness: "cached" },
      });
      const state = await service.getSessionStateUpdate({ ...input, viewVersion: 1 });
      expect(state).toMatchObject({
        status: "snapshot",
        value: { turn: { phase: "idle" }, interactions: [] },
      });
      expect(
        await service.getDiscoveryUpdate({ ...input, viewVersion: 1, sections: ["models"] }),
      ).toMatchObject({ status: "missing" });
      expect(
        await service.getLiveUpdate({
          ...input,
          viewVersion: 1,
          liveWindow,
          transcriptToken: "stale",
          stateToken: "stale",
        } as never),
      ).toMatchObject({ transcript: { status: "snapshot" }, state: { status: "snapshot" } });
      expect(await service.getProjection(input)).toMatchObject({
        messages: [{ id: `row-${CONVERSATION}` }],
        turn: { phase: "idle" },
      });

      expect(providerStarts()).toBe(0);
    });
  });

  test("repeats an unchanged background read without a body or a provider", async () => {
    await withHeldConversation(hold, async ({ service, providerStarts }) => {
      const input = held(hold);
      const first = await service.getTranscriptUpdate({ ...input, viewVersion: 1, liveWindow });
      if (first.status !== "snapshot") throw new Error(`unexpected ${first.status}`);
      expect(
        await service.getTranscriptUpdate({
          ...input,
          viewVersion: 1,
          liveWindow,
          knownToken: first.token,
        }),
      ).toMatchObject({ status: "unchanged" });
      const state = await service.getSessionStateUpdate({ ...input, viewVersion: 1 });
      if (state.status !== "snapshot") throw new Error(`unexpected ${state.status}`);
      expect(
        await service.getSessionStateUpdate({ ...input, viewVersion: 1, knownToken: state.token }),
      ).toMatchObject({ status: "unchanged" });
      expect(providerStarts()).toBe(0);
    });
  });

  test("refuses to establish a session or start a turn, starting no provider", async () => {
    await withHeldConversation(hold, async ({ service, providerStarts }) => {
      const input = held(hold);
      await expect(
        service.adoptSession({ ...input, providerSessionId: `provider-${CONVERSATION}` }),
      ).rejects.toThrow();
      await expect(service.ensureSession(input)).rejects.toThrow();
      await expect(
        service.dispatchPrompt({ ...input, prompt: "Hello", requestId: "held-prompt" } as never),
      ).rejects.toThrow();
      expect(providerStarts()).toBe(0);
    });
  });
});

describe.each(["startup-failed", "platform-off", "safety-level"] as const)(
  "a conversation held by %s",
  (hold) => {
    test("leaves its sibling running against its provider", async () => {
      await withHeldConversation(hold, async ({ service, providerStarts }) => {
        await service.getSessionStateUpdate({ ...held(hold), viewVersion: 1 });
        expect(providerStarts()).toBe(0);
        await service.getSessionStateUpdate({ ...session(SIBLING), viewVersion: 1 });
        expect(providerStarts()).toBeGreaterThan(0);
      });
    });
  },
);

describe.each(["platform-off", "safety-level"] as const)(
  "a conversation whose platform is unavailable (%s)",
  (hold) => {
    const mailTo = async (storage: StorageService) => {
      await storage.synchronizeAgentMailboxes();
      return storage.sendAgentMail(
        {
          kind: "coordinator",
          projectId: (await storage.loadProjects())[0]!.id,
          coordinatorId: "coordinator-1",
          conversationId: SIBLING,
          environmentId: session(SIBLING).environmentId,
          tabId: `tab-${SIBLING}`,
        },
        {
          requestId: "to-held",
          toEnvironmentId: held(hold).environmentId,
          toTabId: `tab-${CONVERSATION}`,
          body: "For the held conversation.",
        },
      );
    };
    const mail = (service: NativeAgentService, storage: StorageService) =>
      new AgentMailService(storage, service, {
        dispatchMailInject: async () => ({ outcome: "accepted" }),
      });

    test("a turn started before the hold stays visible and can be stopped without a provider start", async () => {
      await withHeldConversation(
        hold,
        async ({ service, providerStarts, release, holdAgain, setRunning, aborted }) => {
          const input = held(hold);
          await release();
          await service.ensureSession(input);
          await service.dispatchPrompt({ ...input, requestId: "before-hold", prompt: "Run" });
          setRunning(true);
          await holdAgain();
          const starts = providerStarts();
          // New reads after an inactive pane or a reload use backend-owned state.
          for (let read = 0; read < 2; read += 1) {
            expect(await service.getSessionStateUpdate({ ...input, viewVersion: 1 })).toMatchObject(
              {
                status: "snapshot",
                value: { turn: { phase: "running" } },
              },
            );
            expect(await service.getProjection(input)).toMatchObject({
              turn: { phase: "running" },
            });
          }
          await expect(
            service.dispatchPrompt({ ...input, requestId: "while-held", prompt: "Blocked" }),
          ).rejects.toThrow();
          expect(await service.stopProjectionSession(input)).toMatchObject({
            turn: { phase: "idle" },
          });
          expect(aborted()).toBe(1);
          expect(providerStarts()).toBe(starts);
          expect(await service.getSessionStateUpdate({ ...input, viewVersion: 1 })).toMatchObject({
            value: { turn: { phase: "idle" } },
          });
        },
      );
    });

    test("a failed cached status read preserves history and Stop without restarting a provider", async () => {
      await withHeldConversation(
        hold,
        async ({
          service,
          providerStarts,
          turns,
          release,
          holdAgain,
          setStatusUnavailable,
          aborted,
        }) => {
          const input = held(hold);
          await release();
          await service.ensureSession(input);
          await holdAgain();
          setStatusUnavailable(true);
          const starts = providerStarts();
          for (let read = 0; read < 2; read += 1) {
            expect(await service.getSessionStateUpdate({ ...input, viewVersion: 1 })).toMatchObject(
              {
                status: "snapshot",
                value: { turn: { phase: "running" }, interactions: [], composerControls: [] },
              },
            );
            expect(await service.getProjection(input)).toMatchObject({
              messages: [{ id: "row-held", content: "Saved answer" }],
              turn: { phase: "running" },
            });
          }
          // Cancellation must reach the cached provider even while its status
          // reads fail. The fake abort restores its readable idle status.
          expect(await service.stopProjectionSession(input)).toMatchObject({
            turn: { phase: "idle" },
          });
          expect(aborted()).toBe(1);
          expect(providerStarts()).toBe(starts);
          expect(turns()).toBe(0);
          setStatusUnavailable(false);
          expect(await service.getSessionStateUpdate({ ...input, viewVersion: 1 })).toMatchObject({
            value: { turn: { phase: "idle" } },
          });
        },
      );
    });

    test("says why in what it answers", async () => {
      await withHeldConversation(hold, async ({ service }) => {
        expect(
          await service.getSessionStateUpdate({ ...held(hold), viewVersion: 1 }),
        ).toMatchObject({
          value: { turn: { error: expect.stringContaining("unavailable for Coordinator") } },
        });
      });
    });

    test("each read costs one settings read and starts nothing", async () => {
      await withHeldConversation(hold, async ({ service, storage, providerStarts }) => {
        const loadConfig = spyOn(storage, "loadConfig");
        const reads = async (read: () => Promise<unknown>) => {
          loadConfig.mockClear();
          await read();
          return loadConfig.mock.calls.length;
        };
        const input = held(hold);
        // A live update is a transcript read and a state read.
        expect({
          transcript: await reads(() =>
            service.getTranscriptUpdate({ ...input, viewVersion: 1, liveWindow }),
          ),
          state: await reads(() => service.getSessionStateUpdate({ ...input, viewVersion: 1 })),
          discovery: await reads(() =>
            service.getDiscoveryUpdate({ ...input, viewVersion: 1, sections: ["models"] }),
          ),
          live: await reads(() =>
            service.getLiveUpdate({
              ...input,
              viewVersion: 1,
              liveWindow,
              transcriptToken: "stale",
              stateToken: "stale",
            } as never),
          ),
          projection: await reads(() => service.getProjection(input)),
        }).toEqual({ transcript: 1, state: 1, discovery: 1, live: 2, projection: 1 });
        expect(providerStarts()).toBe(0);
      });
    });

    test("delivers no mail, starts no provider and runs no turn", async () => {
      await withHeldConversation(
        hold,
        async ({ service, storage, providerStarts, turns, mailAttempts }) => {
          const message = await mailTo(storage);
          const agentMail = mail(service, storage);
          await agentMail.init();
          try {
            await service.getTranscriptUpdate({ ...held(hold), viewVersion: 1, liveWindow });
            await service.getSessionStateUpdate({ ...held(hold), viewVersion: 1 });
            await agentMail.drainInjects();

            expect(providerStarts()).toBe(0);
            expect(turns()).toBe(0);
            expect(mailAttempts()).toBe(0);
            expect(
              await storage.getAgentMailMessage(
                held(hold).environmentId,
                `tab-${CONVERSATION}`,
                message.id,
              ),
            ).toMatchObject({ placement: "pending-inject" });
          } finally {
            await agentMail.shutdown();
          }
        },
      );
    });

    test("resumes on the provider once the platform is available, delivering what waited", async () => {
      await withHeldConversation(
        hold,
        async ({ service, storage, providerStarts, turns, release }) => {
          const message = await mailTo(storage);
          const agentMail = mail(service, storage);
          await agentMail.init();
          try {
            await agentMail.drainInjects();
            expect(providerStarts()).toBe(0);

            const before = await service.getTranscriptUpdate({
              ...held(hold),
              viewVersion: 1,
              liveWindow,
            });
            expect(before).toMatchObject({
              status: "snapshot",
              value: {
                identity: { providerSessionId: "provider-held" },
                messages: [{ id: "row-held", content: "Saved answer" }],
              },
            });
            await release();

            const resumed = await service.ensureSession(held(hold));
            expect(resumed.providerSessionId).toBe("provider-held");
            expect(
              await service.getTranscriptUpdate({ ...held(hold), viewVersion: 1, liveWindow }),
            ).toMatchObject({
              status: "snapshot",
              value: {
                identity: { providerSessionId: "provider-held" },
                messages: [{ id: "row-held", content: "Saved answer" }],
              },
            });
            expect(providerStarts()).toBeGreaterThan(0);
            expect(
              await service.getSessionStateUpdate({ ...held(hold), viewVersion: 1 }),
            ).not.toMatchObject({
              value: { turn: { error: expect.stringContaining("showing saved history") } },
            });
            await agentMail.drainInjects();
            expect(turns()).toBe(1);
            expect(
              await storage.getAgentMailMessage(
                held(hold).environmentId,
                `tab-${CONVERSATION}`,
                message.id,
              ),
            ).not.toMatchObject({ placement: "pending-inject" });
          } finally {
            await agentMail.shutdown();
          }
        },
      );
    });
  },
);

test("a paused coordinator holds its sibling conversations too", async () => {
  await withHeldConversation("paused", async ({ service, providerStarts }) => {
    await service.getSessionStateUpdate({ ...session(SIBLING), viewVersion: 1 });
    expect(providerStarts()).toBe(0);
  });
});
