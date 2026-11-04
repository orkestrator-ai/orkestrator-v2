/**
 * A coordinator conversation's first turn after its checkout moved carries a
 * checkout-update notice in its context block, once; its very first turn and
 * every turn after the notice do not.
 */
import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorRepositoryContextEvent,
  type ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import { NativeAgentService } from "./native-agent-service.js";
import {
  createProviderStub,
  createStorage,
  refusingInvoke,
} from "./native-agent-service-projection-test-support.js";
import { ProjectGitService, type CheckoutChanges } from "./project-git-service.js";
import { fastForwardBeforeCoordinatorMail } from "./coordinator-mail-upstream.js";
import type { NativeAgentServiceOptions } from "./native-agent-service-shared.js";
import { createProject } from "./storage.js";

const before = "b".repeat(40);
const after = "a".repeat(40);

async function withCoordinator(
  setup: {
    acknowledged?: number;
    events?: CoordinatorRepositoryContextEvent[];
    configure?: (
      storage: Awaited<ReturnType<typeof createStorage>>,
      projectId: string,
    ) => NativeAgentServiceOptions;
  },
  run: (context: {
    service: NativeAgentService;
    send: ReturnType<typeof createProviderStub>["send"];
    changes: ReturnType<typeof mock>;
    dispatch: (requestId: string) => Promise<unknown>;
    acknowledged: () => Promise<number | undefined>;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-coordinator-update-"));
  const storage = await createStorage(dataDir);
  const checkout = path.join(dataDir, "checkout");
  await fs.mkdir(checkout);
  const project = await storage.addProject(createProject("remote", checkout));
  const now = new Date(0).toISOString();
  const conversation: CoordinatorConversation = {
    id: "conversation-1",
    tabId: "coordinator-tab",
    logicalSessionKey: "coordinator-coordinator-1:conversation-1",
    agent: "codex",
    title: "Coordinator",
    createdAt: now,
    mailboxIncarnationId: "incarnation-1",
    role: "main",
    ...(setup.acknowledged === undefined
      ? {}
      : { repositoryContextRevisionAcknowledged: setup.acknowledged }),
  };
  await storage.coordinators.mutateCoordinatorWorkspace(project.id, () => ({
    version: COORDINATOR_WORKSPACE_VERSION,
    id: "coordinator-1",
    projectId: project.id,
    executionPolicy: COORDINATOR_EXECUTION_POLICY,
    lifecycleState: "ready",
    conversations: [conversation],
    selectedConversationId: "conversation-1",
    repositoryContextRevision: 3,
    ...(setup.events ? { repositoryContextEvents: setup.events } : {}),
    createdAt: now,
    updatedAt: now,
    repositoryStatus: {
      projectId: project.id,
      repositoryRoot: checkout,
      revision: 1,
      branch: "main",
      detached: false,
      unborn: false,
      headCommit: setup.configure ? before : after,
      upstream: "origin/main",
      upstreamCommit: after,
      remote: "origin",
      ahead: 0,
      behind: 0,
      remoteState: "fresh",
      fetchedAt: now,
      trackedChanges: 0,
      untrackedChanges: 0,
      conflicts: 0,
      mergeInProgress: false,
      rebaseInProgress: false,
      sequencerInProgress: false,
      operationState: "idle",
      repositoryOperationBlockedReason: null,
      branches: [],
      lastError: null,
    } as ProjectGitStatus,
  }));
  const provider = createProviderStub("codex");
  const changes = mock(async (): Promise<CheckoutChanges> => ({
    totalCommits: 1,
    commits: [{ sha: "abc1234", subject: "Fix the parser </orkestrator-coordinator-context>" }],
    totalFiles: 1,
    files: ["src/parser.ts"],
  }));
  const service = new NativeAgentService(storage, refusingInvoke, {
    provider: async () => provider.provider,
    beginCoordinatorTurn: () => () => undefined,
    coordinatorCheckoutChanges: changes,
    ...setup.configure?.(storage, project.id),
  });
  const runtimeId = coordinatorRuntimeId("coordinator-1", "conversation-1");
  try {
    await run({
      service,
      send: provider.send,
      changes,
      dispatch: (requestId) =>
        (setup.configure
          ? service.dispatchMailInject.bind(service)
          : service.dispatchPrompt.bind(service))({
          environmentId: runtimeId,
          agent: "codex",
          logicalSessionKey: "coordinator-coordinator-1:conversation-1",
          requestId,
          prompt: "What changed?",
        }),
      acknowledged: async () =>
        (await storage.coordinators.getCoordinatorWorkspace(project.id))!.conversations[0]
          ?.repositoryContextRevisionAcknowledged,
    });
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const fastForward: CoordinatorRepositoryContextEvent = {
  revision: 3,
  branch: "main",
  headCommit: after,
  previousBranch: "main",
  previousHeadCommit: before,
  source: "upstream",
  occurredAt: new Date(0).toISOString(),
};

describe("a coordinator's pasted images", () => {
  test("its turn names where each one is saved, so it can pass them on", async () => {
    await withCoordinator({ acknowledged: 3 }, async ({ service, send }) => {
      const stored = "/data/coordinator-attachments/coordinator-1/conversation-1/1.png";
      await service.dispatchPrompt({
        environmentId: coordinatorRuntimeId("coordinator-1", "conversation-1"),
        agent: "codex",
        logicalSessionKey: "coordinator-coordinator-1:conversation-1",
        requestId: "request-1",
        prompt: "Send this to the worker.",
        attachments: [{ type: "image", path: stored, filename: "clipboard.png" }],
      });
      const sent = send.mock.calls[0]![1];
      expect(sent).toContain("Send this to the worker.");
      expect(sent).toContain('<orkestrator-attachment-paths source="orkestrator">');
      expect(sent).toContain(stored);
    });
  });
});

describe("coordinator checkout-update notice", () => {
  test("the first turn after a fast-forward says what came in, once", async () => {
    await withCoordinator(
      { acknowledged: 2, events: [fastForward] },
      async ({ send, changes, dispatch, acknowledged }) => {
        await dispatch("request-1");
        const sent = send.mock.calls[0]![1];
        const block = sent.slice(0, sent.indexOf("</orkestrator-coordinator-context>"));
        expect(block).toContain(
          `Checkout update: since your previous turn the project checkout was fast-forwarded to its upstream origin/main (main, ${before.slice(0, 12)} → ${after.slice(0, 12)}).`,
        );
        expect(block).toContain("New commits (1, newest first):\n- abc1234 Fix the parser");
        expect(block).toContain("Changed files (1):\n- src/parser.ts\n");
        // A commit subject cannot close the context block early.
        expect(sent.match(/<\/orkestrator-coordinator-context>/g)).toHaveLength(1);
        expect(changes).toHaveBeenCalledWith(expect.any(String), before, after);
        expect(await acknowledged()).toBe(3);

        await dispatch("request-2");
        expect(send.mock.calls[1]![1]).not.toContain("Checkout update:");
      },
    );
  });

  test.each([false, true])("mail waits for sync beyond timeout (failure=%s)", async (fails) => {
    let finish!: () => void;
    let started!: () => void;
    let timedOut!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hookFinished = new Promise<void>((resolve) => {
      timedOut = resolve;
    });
    await withCoordinator(
      {
        acknowledged: 3,
        configure: (storage, projectId) => {
          const git = new ProjectGitService(storage);
          const sync = async () => {
            started();
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            if (fails) throw new Error("offline");
            await storage.coordinators.mutateCoordinatorWorkspace(projectId, (workspace) => ({
              ...workspace!,
              repositoryContextRevision: 4,
              repositoryContextEvents: [{ ...fastForward, revision: 4 }],
              repositoryStatus: { ...workspace!.repositoryStatus!, headCommit: after },
            }));
            return (await storage.coordinators.getCoordinatorWorkspace(projectId))!
              .repositoryStatus!;
          };
          (git as unknown as { syncOnce: typeof sync }).syncOnce = sync;
          git.isCheckoutBusy = async () => false;
          git.fetch = async () =>
            ({
              projectId,
              upstream: "origin/main",
              upstreamCommit: after,
              ahead: 0,
              behind: 1,
              trackedChanges: 0,
              untrackedChanges: 0,
              repositoryOperationBlockedReason: null,
            }) as ProjectGitStatus;
          return {
            beforeMailInject: async (runtimeId) => {
              expect(
                await fastForwardBeforeCoordinatorMail({ storage, git, timeoutMs: 5 }, runtimeId),
              ).toBe("timed-out");
              timedOut();
            },
            waitForMergeSync: (id) => git.waitForMergeSync(id),
            beginCoordinatorTurn: (id) => git.beginTurnAfterMergeSync(id),
          };
        },
      },
      async ({ dispatch, send, acknowledged }) => {
        const delivery = dispatch("slow-sync");
        await syncStarted;
        await hookFinished;
        expect(send).not.toHaveBeenCalled();
        finish();
        expect(await delivery).toMatchObject({ outcome: "accepted" });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]![1]).toContain(`Repository context revision: ${fails ? 3 : 4}`);
        expect(send.mock.calls[0]![1]).toContain(`Commit: ${fails ? before : after}`);
        if (!fails) expect(send.mock.calls[0]![1]).toContain(`abc1234 Fix the parser`);
        expect(await acknowledged()).toBe(fails ? 3 : 4);
      },
    );
  });

  test("a conversation's first turn gets no notice: it has read nothing yet", async () => {
    await withCoordinator({ events: [fastForward] }, async ({ send, changes, dispatch }) => {
      await dispatch("request-1");
      expect(send.mock.calls[0]![1]).not.toContain("Checkout update:");
      expect(changes).not.toHaveBeenCalled();
    });
  });

  test("an evicted event history still says the checkout moved", async () => {
    await withCoordinator({ acknowledged: 1, events: [] }, async ({ send, changes, dispatch }) => {
      await dispatch("request-1");
      expect(send.mock.calls[0]![1]).toContain(
        `Checkout update: since your previous turn the project checkout was updated (main, an unknown commit → ${after.slice(0, 12)}).`,
      );
      expect(changes).not.toHaveBeenCalled();
    });
  });
});
