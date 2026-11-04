/**
 * The existing notices take the routing rule: status wakes and watched pull
 * requests reach whoever `CoordinatorNoticeRouter` says, and only a new event
 * starts a coordinator. The hierarchy itself is `coordinator-notice-hierarchy.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CoordinatorNoticeRoute } from "@orkestrator/protocol/coordinator-notices";
import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import { CoordinatorNoticeRouter } from "./coordinator-notice-router.js";
import { CoordinatorPullRequestWatches } from "./coordinator-pr-watches.js";
import type { OutboxItem } from "./nodes/node-mail.js";

const worlds: MailWorld[] = [];

async function world(): Promise<MailWorld> {
  const created = await MailWorld.create();
  worlds.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((item) => item.close()));
});

/** A pipeline the main coordinator started, about to end. */
async function ownedPipeline(
  target: MailWorld,
): Promise<{ worker: MailActor; pipelineId: string }> {
  const main = await target.main();
  const worker = await target.addEnvironment("build-env");
  const pipelineId = "pipeline-1";
  await target.storage.saveBuildPipeline(pipelineId, target.projectId, worker.environmentId, 1, {
    id: pipelineId,
    environmentId: worker.environmentId,
    projectId: target.projectId,
    taskTitle: "Fix the parser",
    iteration: 1,
    phase: "building",
  });
  await target.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: `association-${pipelineId}`,
    projectId: target.projectId,
    coordinatorId: target.coordinatorId,
    conversationId: main.conversationId!,
    kind: "build-pipeline",
    resourceId: pipelineId,
    requestId: `request-${pipelineId}`,
    createdAt: new Date().toISOString(),
  });
  return { worker, pipelineId };
}

async function endPipeline(target: MailWorld, worker: MailActor, pipelineId: string) {
  await target.storage.saveBuildPipeline(pipelineId, target.projectId, worker.environmentId, 2, {
    id: pipelineId,
    environmentId: worker.environmentId,
    projectId: target.projectId,
    taskTitle: "Fix the parser",
    iteration: 1,
    phase: "complete",
    verificationResult: "pass",
  });
}

async function openMains(target: MailWorld): Promise<number> {
  const workspace = await target.storage.coordinators.getCoordinatorWorkspace(target.projectId);
  return (
    workspace?.conversations.filter((item) => item.role === "main" && !item.closedAt).length ?? 0
  );
}

function upTo(queued: Array<Partial<OutboxItem>>, route: CoordinatorNoticeRoute) {
  return {
    routeNotice: async () => route,
    queueNotice: async (_controllerId: string, item: Partial<OutboxItem>) => {
      queued.push(item);
    },
  };
}

const COMMAND: CoordinatorNoticeRoute = {
  kind: "command-node",
  controllerId: "bk_command",
  controllerName: "Command",
};

describe("a status wake", () => {
  test("on a leaf goes to the command node, and is counted as sent", async () => {
    const target = await world();
    const queued: Array<Partial<OutboxItem>> = [];
    target.coordinator.noticeRouter.setOutbox(upTo(queued, COMMAND));
    const { worker, pipelineId } = await ownedPipeline(target);
    await endPipeline(target, worker, pipelineId);
    await target.coordinator.statusWakes.observeWorkflow("build-pipeline", pipelineId);
    await target.deliver();

    expect(queued).toHaveLength(1);
    expect(queued[0]?.coordinatorNotice).toMatchObject({ kind: "repository", createSession: true });
    const main = await target.main();
    const inbox = await target.storage.getAgentMailMailbox(main.environmentId, main.tabId);
    expect(inbox.messages).toHaveLength(0);
    // The same state observed again is not another notice.
    await target.coordinator.statusWakes.observeWorkflow("build-pipeline", pipelineId);
    expect(queued).toHaveLength(1);
  });

  test("standalone, a new event with no main running starts one", async () => {
    const target = await world();
    const { worker, pipelineId } = await ownedPipeline(target);
    await target.closeMain();
    expect(await openMains(target)).toBe(0);
    await endPipeline(target, worker, pipelineId);
    await target.coordinator.statusWakes.observeWorkflow("build-pipeline", pipelineId);
    expect(await openMains(target)).toBe(1);
    const main = await target.main();
    const inbox = await target.storage.getAgentMailMailbox(main.environmentId, main.tabId);
    expect(inbox.messages).toHaveLength(1);
  });

  test("a sweep of older state starts nothing, and sends it when one opens", async () => {
    const target = await world();
    const { worker, pipelineId } = await ownedPipeline(target);
    await target.closeMain();
    await endPipeline(target, worker, pipelineId);

    await target.coordinator.statusWakes.reconcile();
    expect(await openMains(target)).toBe(0);

    await target.coordinator.ensureMainConversation(target.projectId);
    await target.coordinator.statusWakes.reconcile();
    const main = await target.main();
    const inbox = await target.storage.getAgentMailMailbox(main.environmentId, main.tabId);
    expect(inbox.messages).toHaveLength(1);
  });

  test("a sweep on a leaf tells the command node not to start anything either", async () => {
    const target = await world();
    const queued: Array<Partial<OutboxItem>> = [];
    target.coordinator.noticeRouter.setOutbox(upTo(queued, COMMAND));
    const { worker, pipelineId } = await ownedPipeline(target);
    await endPipeline(target, worker, pipelineId);
    await target.coordinator.statusWakes.reconcile();
    expect(queued[0]?.coordinatorNotice).toMatchObject({
      kind: "repository",
      createSession: false,
    });
  });

  test("a worker's waiting notice stays with the coordinator that delegated to it", async () => {
    const target = await world();
    const queued: Array<Partial<OutboxItem>> = [];
    target.coordinator.noticeRouter.setOutbox(upTo(queued, COMMAND));
    const router = target.coordinator.noticeRouter;
    const delivered = await router.deliver({
      projectId: target.projectId,
      audience: "delegator",
      createSession: false,
      resourceId: "env-1",
      requestId: () => "status:waiting",
      upwardRequestId: "status:waiting",
      subject: "Worker waiting",
      body: "It is waiting on an approval.",
    });
    expect(delivered).toBe(true);
    expect(queued).toHaveLength(0);
  });
});

describe("a watched pull request", () => {
  async function watching(target: MailWorld, router: CoordinatorNoticeRouter) {
    await target.storage.updateProject(target.projectId, {
      gitUrl: "https://github.com/acme/app.git",
    });
    let now = Date.parse("2030-01-01T10:00:00.000Z");
    const state = { checksState: "pending", fail: false };
    const watches = new CoordinatorPullRequestWatches({
      storage: target.storage,
      noticeRouter: router,
      coalesceMs: 0,
      now: () => now,
      token: async () => "token",
      readStatus: async () => {
        if (state.fail) throw new Error("temporary read failure");
        return {
          title: "Add the watch",
          htmlUrl: "https://github.com/acme/app/pull/7",
          state: "open",
          isDraft: false,
          checksState: state.checksState,
          mergeability: "blocked",
          reviewDecision: "none",
        } as never;
      },
      confirmDeleted: async () => false,
    });
    await watches.watch(target.projectId, { owner: "acme", repo: "app", number: 7 }, "rendered");
    return {
      watches,
      state,
      advance: () => {
        now += 60 * 60_000;
      },
    };
  }

  test("goes up from a leaf", async () => {
    const target = await world();
    const queued: Array<Partial<OutboxItem>> = [];
    target.coordinator.noticeRouter.setOutbox(upTo(queued, COMMAND));
    const { watches, state, advance } = await watching(target, target.coordinator.noticeRouter);
    await watches.sweep();
    advance();
    state.checksState = "success";
    await watches.sweep();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.requestId).toContain("pr-watch:");
  });

  test("a change seen by a later sweep is a new event and starts a coordinator", async () => {
    const target = await world();
    const { watches, state, advance } = await watching(target, target.coordinator.noticeRouter);
    await watches.sweep();
    await target.closeMain();
    advance();
    state.checksState = "success";
    await watches.sweep();
    expect(await openMains(target)).toBe(1);
  });

  test("the first sweep after a restart compares older state, so it starts nothing", async () => {
    const target = await world();
    const before = await watching(target, target.coordinator.noticeRouter);
    await before.watches.sweep();
    await target.closeMain();

    const after = await watching(target, target.coordinator.noticeRouter);
    // A no-op sweep must not consume this watch's startup baseline.
    await after.watches.sweep();
    before.advance();
    after.advance();
    after.state.checksState = "success";
    await after.watches.sweep();
    expect(await openMains(target)).toBe(0);
    after.advance();
    after.state.checksState = "failure";
    await after.watches.sweep();
    expect(await openMains(target)).toBe(1);
  });
  test("failed and capped startup reads keep a separate baseline for every watch", async () => {
    const target = await world();
    const before = await watching(target, target.coordinator.noticeRouter);
    for (let number = 8; number <= 22; number++)
      await before.watches.watch(
        target.projectId,
        { owner: "acme", repo: "app", number },
        "rendered",
      );
    await before.watches.sweep();
    before.advance();
    await before.watches.sweep();
    await target.closeMain();
    const after = await watching(target, target.coordinator.noticeRouter);
    after.advance();
    after.state.fail = true;
    await after.watches.sweep();
    after.advance();
    after.state.fail = false;
    after.state.checksState = "success";
    await after.watches.sweep();
    await after.watches.sweep();
    expect(await openMains(target)).toBe(0);
    after.advance();
    after.state.checksState = "failure";
    await after.watches.sweep();
    expect(await openMains(target)).toBe(1);
  });
});
