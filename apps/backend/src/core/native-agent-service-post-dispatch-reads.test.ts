import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorConversationSessionKey,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import type { ProviderInteractiveSnapshot } from "./agent-provider-contract.js";
import { createNativeAgentDisplayTail } from "./native-agent-display-tails.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { projectionInternals } from "./native-agent-service-test-collaborators.js";
import { createProject } from "./storage.js";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";

const identity = {
  environmentId: "env-1",
  agent: "claude" as const,
  logicalSessionKey: "env-env-1:post-dispatch",
};

function row(index: number) {
  return {
    id: `m${index}`,
    role: "assistant" as const,
    content: `row ${index}`,
    parts: [] as unknown[],
    createdAt: "2026-11-04T00:00:00.000Z",
  };
}

/** A provider answering the way a bridge does: the newest `limit` rows, or all. */
function boundedProvider(total: number) {
  const reads: Array<{ limit: number | undefined; rows: number }> = [];
  const history = Array.from({ length: total }, (_, index) => row(index));
  const stub = createProviderStub("claude", {
    interactiveSnapshot: async (_sessionId, options) => {
      const messages = options?.limit === undefined ? history : history.slice(-options.limit);
      reads.push({ limit: options?.limit, rows: messages.length });
      return { status: "idle", messages } satisfies ProviderInteractiveSnapshot;
    },
  });
  return { stub, reads };
}

describe("post-dispatch transcript reads (TX-2)", () => {
  test("a prompt send follows up with a short tail read, never the whole transcript", async () => {
    const { stub, reads } = boundedProvider(4_000);
    await withService(
      { prefix: "ork-post-dispatch-tail-", provider: async () => stub.provider },
      async ({ service }) => {
        const outcome = await service.dispatchIntent({
          ...identity,
          prompt: "Next step",
          requestId: "request-1",
        });
        expect(outcome.outcome).toBe("accepted");
        await waitForCondition(() => reads.length > 0);
        await waitForCondition(
          () =>
            service.cachedProjectionSnapshot("env-1", "claude", identity.logicalSessionKey) !==
            null,
        );

        for (const read of reads) {
          expect(read.limit).toBeLessThanOrEqual(33);
          expect(read.rows).toBeLessThanOrEqual(33);
        }
        // What the refresh is for still happens: the turn state is cached, and
        // the cached rows say truthfully that they are not the whole history.
        const cached = service.cachedProjectionSnapshot(
          "env-1",
          "claude",
          identity.logicalSessionKey,
        )!;
        expect(cached.turn.phase).toBe("idle");
        expect(cached.messages).toHaveLength(32);
        expect(cached.messages.at(-1)).toMatchObject({ id: "m3999" });
        expect(cached.messageWindow?.truncated).toBe(true);
        expect(cached.messageWindow?.canLoadEarlier).toBe(true);
      },
    );
  });

  test("a tail refresh does not narrow the window the next reader inherits", async () => {
    const { stub, reads } = boundedProvider(100);
    await withService(
      { prefix: "ork-post-dispatch-inherit-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        await service.getProjection({ ...identity, messageLimit: 80 });
        await service.dispatchIntent({ ...identity, prompt: "Next", requestId: "request-2" });
        await waitForCondition(() => reads.some((read) => read.limit === 33));

        const next = await service.getProjection(identity);
        expect(reads.at(-1)?.limit).toBe(81);
        expect(next?.messages).toHaveLength(80);
      },
    );
  });

  test("a one-message state read asks the provider for two rows and reports older history", async () => {
    const { stub, reads } = boundedProvider(4_000);
    await withService(
      { prefix: "ork-post-dispatch-one-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const projection = await service.getProjection({ ...identity, messageLimit: 1 });
        expect(reads).toEqual([{ limit: 2, rows: 2 }]);
        expect(projection?.messages).toHaveLength(1);
        expect(projection?.messageWindow?.truncated).toBe(true);
        expect(projection?.messageWindow?.canLoadEarlier).toBe(true);
      },
    );
  });

  test("a session that fits the window stays complete", async () => {
    const { stub, reads } = boundedProvider(3);
    await withService(
      { prefix: "ork-post-dispatch-fits-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const projection = await service.getProjection({ ...identity, messageLimit: 3 });
        expect(reads).toEqual([{ limit: 4, rows: 3 }]);
        expect(projection?.messages).toHaveLength(3);
        expect(projection?.messageWindow?.truncated).toBe(false);
      },
    );
  });

  test("a sync read keeps the whole transcript its retained history is built from", async () => {
    const { stub, reads } = boundedProvider(600);
    await withService(
      { prefix: "ork-post-dispatch-sync-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        const update = await service.getProjectionUpdate({
          ...identity,
          syncVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        });
        expect(update.status).toBe("snapshot");
        expect(reads).toEqual([{ limit: undefined, rows: 600 }]);
      },
    );
  });

  test("a provider without an interactive snapshot is read with the same bound", async () => {
    const limits: Array<number | undefined> = [];
    const stub = createProviderStub("claude");
    Object.assign(stub.provider, {
      messages: async (_sessionId: string, options?: { limit?: number }) => {
        limits.push(options?.limit);
        return [row(1)];
      },
    });
    await withService(
      { prefix: "ork-post-dispatch-messages-", provider: async () => stub.provider },
      async ({ service }) => {
        await service.ensureSession(identity);
        await service.getProjection({ ...identity, messageLimit: 5 });
        expect(limits).toEqual([6]);
      },
    );
  });

  describe("a paused coordinator's saved history", () => {
    const coordinator = coordinatorRuntimeId("coordinator-1", "conversation-1");
    const tab = coordinatorConversationSessionKey("coordinator-1", {
      id: "conversation-1",
      tabId: "coordinator-tab",
    });
    const sessionKey = nativeAgentSessionStorageKey(coordinator, "codex", tab);
    const read = {
      environmentId: coordinator,
      agent: "codex" as const,
      logicalSessionKey: tab,
      viewVersion: 1 as const,
      liveWindow: { messages: 100, targetBytes: 512 * 1024 },
    };

    /** A paused conversation with a saved tail, and this legacy view left in the cache. */
    async function readPaused(savedRows: number, legacy: Partial<NativeAgentSessionProjection>) {
      let shown: unknown[] = [];
      await withService(
        {
          prefix: "ork-post-dispatch-paused-",
          provider: async () => createProviderStub("codex").provider,
        },
        async ({ storage, service }) => {
          const now = new Date(0).toISOString();
          const project = await storage.addProject(createProject("remote", tmpdir()));
          await storage.coordinators.mutateCoordinatorWorkspace(project.id, () => ({
            version: COORDINATOR_WORKSPACE_VERSION,
            id: "coordinator-1",
            projectId: project.id,
            executionPolicy: COORDINATOR_EXECUTION_POLICY,
            lifecycleState: "ready",
            conversations: [
              {
                id: "conversation-1",
                tabId: "coordinator-tab",
                logicalSessionKey: tab,
                agent: "codex",
                title: "Coordinator",
                createdAt: now,
                mailboxIncarnationId: "incarnation-1",
              },
            ],
            selectedConversationId: "conversation-1",
            repositoryContextRevision: 1,
            createdAt: now,
            updatedAt: now,
          }));
          await storage.adoptNativeAgentSession({
            key: sessionKey,
            environmentId: coordinator,
            agent: "codex",
            logicalSessionKey: tab,
            providerSessionId: "provider-1",
          });
          await storage.putNativeAgentDisplayTail(
            sessionKey,
            createNativeAgentDisplayTail({
              environmentId: coordinator,
              agent: "codex",
              logicalSessionKey: tab,
              providerSessionId: "provider-1",
              historyEpoch: "epoch-1",
              messages: Array.from({ length: savedRows }, (_, index) => row(index)),
              updatedAt: now,
            })!,
          );
          await storage.coordinators.mutateCoordinatorWorkspace(project.id, (workspace) => ({
            ...workspace!,
            lifecycleState: "paused",
          }));
          projectionInternals(service).projectionCache.set(sessionKey, {
            input: { environmentId: coordinator, agent: "codex", logicalSessionKey: tab },
            projection: {
              sessionId: "provider-1",
              generation: "generation-1",
              ...legacy,
            } as NativeAgentSessionProjection,
            fingerprint: "",
            generation: "generation-1",
          });
          const update = await service.getTranscriptUpdate(read);
          if (update.status !== "snapshot") throw new Error(`unexpected ${update.status}`);
          shown = update.value.messages;
        },
      );
      return shown;
    }

    test("is not replaced by a state refresh's short tail", async () => {
      const shown = await readPaused(50, {
        messages: [row(49)],
        messageWindow: { limit: 32, truncated: true, canLoadEarlier: true },
      });
      expect(shown).toHaveLength(50);
    });

    test("gives way to a wider window a reader left in the cache", async () => {
      const shown = await readPaused(2, {
        messages: [row(1), row(2), row(3)],
        messageWindow: { limit: 3, truncated: true, canLoadEarlier: true },
      });
      expect(shown).toHaveLength(3);
    });
  });
});
