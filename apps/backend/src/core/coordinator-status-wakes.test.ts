import { multiReviewFixIdentity } from "./multi-review-fix-identity.js";
/**
 * Status wakes on the real mail world: storage, routes, budgets, the
 * coordinator service and the injection drain are production code; only the
 * agents, the clock and the timers are simulated.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  AGENT_MAIL_HOURLY_LIMIT_REASON,
  AGENT_MAIL_LOOP_BUDGET_REASON,
  type AgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import {
  buildPipelineStatus,
  COORDINATOR_STATUS_COALESCE_MS,
  COORDINATOR_WAITING_DEBOUNCE_MS,
  lastAssistantText,
  multiReviewStatus,
  renderCoordinatorStatusNotice,
  waitingBlocker,
  waitingStatus,
  type CoordinatorStatusWakeTimers,
  type CoordinatorWaitingBlocker,
  type CoordinatorStatusWakeOptions,
} from "./coordinator-status-wakes.js";

/** Timers the test advances by hand; the system clock moves with them. */
class ManualTimers implements CoordinatorStatusWakeTimers {
  private current = Date.now();
  private nextId = 0;
  private due: Array<{ id: number; at: number; callback: () => void }> = [];

  constructor() {
    setSystemTime(new Date(this.current));
  }

  now = (): number => this.current;

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    this.nextId += 1;
    this.due.push({ id: this.nextId, at: this.current + delayMs, callback });
    return this.nextId;
  };

  clearTimeout = (handle: unknown): void => {
    this.due = this.due.filter((entry) => entry.id !== handle);
  };

  advance(milliseconds: number): void {
    this.current += milliseconds;
    setSystemTime(new Date(this.current));
    const ready = this.due
      .filter((entry) => entry.at <= this.current)
      .sort((left, right) => left.at - right.at);
    this.due = this.due.filter((entry) => entry.at > this.current);
    for (const entry of ready) entry.callback();
  }

  pending(): number {
    return this.due.length;
  }
}

const READY_REPORT = {
  issues: [
    { severity: "P1", title: "a" },
    { severity: "P0", title: "b" },
    { severity: "P1", title: "c" },
  ],
  testCoverageGaps: [{ file: "x.ts", untestedBehavior: "y" }],
  verdict: { ready: "with-fixes", reasoning: "" },
};

type WorldSetup = {
  world: MailWorld;
  timers: ManualTimers;
  activity: Map<string, AgentActivityState | "unknown">;
  excerpts: Map<string, string>;
  blockers: Map<string, CoordinatorWaitingBlocker>;
};

let setup: WorldSetup | null = null;

async function createWorld(
  settings: Partial<AgentMessagingSettings> = {},
  overrides: CoordinatorStatusWakeOptions = {},
): Promise<WorldSetup> {
  const timers = new ManualTimers();
  const activity = new Map<string, AgentActivityState | "unknown">();
  const excerpts = new Map<string, string>();
  const blockers = new Map<string, CoordinatorWaitingBlocker>();
  const world = await MailWorld.create({
    statusWakes: {
      timers,
      workerActivity: async (environmentId, tabId) =>
        activity.get(`${environmentId}:${tabId}`) ?? "working",
      lastAssistantExcerpt: async (environmentId, tabId) =>
        excerpts.get(`${environmentId}:${tabId}`),
      waitingBlocker: async (environmentId, tabId) => blockers.get(`${environmentId}:${tabId}`),
      ...overrides,
    },
  });
  if (Object.keys(settings).length > 0) {
    const config = await world.storage.loadConfig();
    await world.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, ...settings },
    });
  }
  setup = { world, timers, activity, excerpts, blockers };
  return setup;
}

afterEach(async () => {
  await setup?.world.close();
  setup = null;
  setSystemTime();
});

async function associate(
  world: MailWorld,
  kind: "multi-review" | "build-pipeline",
  resourceId: string,
): Promise<string> {
  const main = await world.main();
  const id = `association-${resourceId}`;
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id,
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: main.conversationId!,
    kind,
    resourceId,
    requestId: `request-${resourceId}`,
    createdAt: new Date().toISOString(),
  });
  return id;
}

async function saveReview(
  world: MailWorld,
  environment: MailActor,
  id: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  await world.storage.saveMultiReviewWorkflow(id, environment.environmentId, 1, {
    id,
    environmentId: environment.environmentId,
    projectId: world.projectId,
    reviewers: [],
    ...snapshot,
  });
}

async function savePipeline(
  world: MailWorld,
  environment: MailActor,
  id: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  await world.storage.saveBuildPipeline(id, world.projectId, environment.environmentId, 1, {
    id,
    environmentId: environment.environmentId,
    projectId: world.projectId,
    taskTitle: "Fix the parser",
    iteration: 1,
    ...snapshot,
  });
}

/**
 * Move the clock only once the drains already running have finished. Real time
 * does not jump; a drain that read the store before a notice landed and the
 * clock after a jump would see a window that never existed.
 */
async function advance({ world, timers }: WorldSetup, milliseconds: number): Promise<void> {
  await world.deliver();
  await world.coordinator.statusWakes.settled();
  timers.advance(milliseconds);
}

/** Run a status pass, let the coalescing window close, and deliver what is due. */
async function settle(context: WorldSetup): Promise<void> {
  await context.world.coordinator.reconcileWorkflowNotifications();
  await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
  await context.world.deliver();
}

async function coordinatorInbox(world: MailWorld) {
  const main = await world.main();
  return (await world.storage.getAgentMailMailbox(main.environmentId, main.tabId)).messages;
}

describe("coordinator status wakes", () => {
  test("a Multi Review the coordinator started wakes it once when it is ready to address", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    await saveReview(world, worker, "review-1", { phase: "reviewing" });
    await associate(world, "multi-review", "review-1");

    await settle(context);
    expect(world.wakes(coordinator)).toBe(0);

    await saveReview(world, worker, "review-1", {
      phase: "ready",
      consolidatedReport: READY_REPORT,
      reviewSession: { sessionKey: "review", status: "idle", completedAt: "2026-10-16T10:00:00Z" },
    });
    await settle(context);

    expect(world.wakes(coordinator)).toBe(1);
    const [carrier] = world.carriers(coordinator)[0]!;
    expect(carrier).toMatchObject({
      kind: "notice",
      subject: "Multi Review review-env is ready to address",
      notice: {
        resource: { kind: "multi-review", id: "review-1", environmentId: worker.environmentId },
        state: "ready",
        tone: "attention",
      },
    });
    expect(carrier!.body).toContain("3 findings (1 P0, 2 P1), 1 test-coverage gap");
    expect(carrier!.body).toContain('`get_multi_review { "workflowId": "review-1" }`');
    expect(carrier!.body).toContain("address_multi_review");

    // The same state, observed again and after the coordinator's turn, is not news.
    await world.finishTurn(coordinator);
    await settle(context);
    expect(world.wakes(coordinator)).toBe(1);

    // Ownership is durable: the association remembers what it was told.
    const association = (
      await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)
    ).find((item) => item.resourceId === "review-1");
    expect(association?.statusNotice?.key).toMatch(/^ready:/);
  });

  test("a notice still in its coalescing hold rides along with mail dispatched meanwhile", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const review = await world.addEnvironment("review-env");
    const worker = await world.addEnvironment("worker");
    await world.delegate(coordinator, worker, "Run the suite.");
    await world.deliver();
    await world.send(worker, "coordinator", "Done: the suite passes.");

    await saveReview(world, review, "review-1", {
      phase: "ready",
      consolidatedReport: READY_REPORT,
    });
    await associate(world, "multi-review", "review-1");
    await world.coordinator.reconcileWorkflowNotifications();
    await world.deliver();
    // Held: the window waits for other notices.
    expect(world.wakes(coordinator)).toBe(0);

    // The worker's report is released by its turn ending; the notice joins it.
    await world.finishTurn(worker);
    expect(world.wakes(coordinator)).toBe(1);
    const carriers = world.carriers(coordinator)[0]!;
    expect(carriers.map((carrier) => carrier.notice?.state ?? carrier.body)).toEqual([
      "Done: the suite passes.",
      "ready",
    ]);

    // The hold ending later finds nothing left to send.
    await world.finishTurn(coordinator);
    await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
    await world.deliver();
    expect(world.wakes(coordinator)).toBe(1);
    expect(await world.undelivered(coordinator)).toEqual([]);
  });

  test.each(["batch-full", "held"] as const)(
    "a joined notice returned as %s retains its deadline and accepts later notices",
    async (outcome) => {
      const context = await createWorld();
      const { world } = context;
      const coordinator = await world.main();
      // Control the drain explicitly so every pending sibling is present before claiming.
      await world.mail.shutdown();
      const send = (id: string, body: string, hold = false) =>
        world.storage.sendAgentMail(
          { kind: "system", projectId: world.projectId, source: "workflow", resourceId: id },
          {
            requestId: id,
            toEnvironmentId: coordinator.environmentId,
            toTabId: coordinator.tabId,
            body,
          },
          hold ? { coalesceMs: COORDINATOR_STATUS_COALESCE_MS } : {},
        );
      const reports = outcome === "batch-full" ? 4 : 1;
      for (let index = 0; index < reports; index += 1)
        await send(`report-${index}`, "x".repeat(outcome === "batch-full" ? 31_000 : 10));
      const notice = await send("held-notice", "n".repeat(16_000), true);
      const deadline = new Date(
        context.timers.now() + COORDINATOR_STATUS_COALESCE_MS,
      ).toISOString();
      const key = `${coordinator.environmentId}\0${coordinator.logicalSessionKey}`;
      if (outcome === "held") world.holdNext.add(key);
      await world.deliver();
      const pending = () =>
        world.storage.listPendingAgentMailInjects(100, {
          includeCoalescing: true,
          includeDeferred: true,
        });
      expect(
        (await pending()).find((entry) => entry.message.id === notice.id)?.coalescingUntil,
      ).toBe(deadline);
      // Remove the immediate messages so only held notices could start a turn.
      const mailbox = (await pending()).find((entry) => entry.message.id === notice.id)!.mailbox;
      await world.storage.resetAgentMailInjectBackoff(mailbox.mailboxId);
      for (const entry of await pending()) {
        if (entry.message.id === notice.id) continue;
        const claimed = await world.storage.beginAgentMailInject(
          mailbox.mailboxId,
          entry.message.id,
          mailbox.incarnationId,
        );
        if (claimed)
          await world.storage.finishAgentMailInject(mailbox.mailboxId, entry.message.id, {
            outcome: "accepted",
          });
      }
      await world.finishTurn(coordinator);
      const wakes = world.wakes(coordinator);
      await advance(context, 3_000);
      const later = await send("later-notice", "later", true);
      const held = await pending();
      expect(held.find((entry) => entry.message.id === notice.id)?.coalescingUntil).toBe(deadline);
      expect(held.find((entry) => entry.message.id === later.id)?.coalescingUntil).toBe(deadline);
      await world.deliver();
      expect(world.wakes(coordinator)).toBe(wakes);
      await advance(context, COORDINATOR_STATUS_COALESCE_MS - 3_000 + 1);
      await world.deliver();
      expect(world.wakes(coordinator)).toBe(wakes + 1);
      expect(
        world
          .carriers(coordinator)
          .at(-1)!
          .map((entry) => entry.messageId),
      ).toEqual([notice.id, later.id]);
    },
  );

  test("a held notice never starts a turn of its own before its window ends", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const review = await world.addEnvironment("review-env");
    await saveReview(world, review, "review-1", {
      phase: "ready",
      consolidatedReport: READY_REPORT,
    });
    await associate(world, "multi-review", "review-1");
    await world.coordinator.reconcileWorkflowNotifications();
    await advance(context, COORDINATOR_STATUS_COALESCE_MS - 1_000);
    await world.deliver();
    expect(world.wakes(coordinator)).toBe(0);
    await advance(context, 1_001);
    await world.deliver();
    expect(world.wakes(coordinator)).toBe(1);
  });

  test("each later settled state wakes it once more: fix done, then completed", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    await saveReview(world, worker, "review-1", {
      phase: "ready",
      consolidatedReport: READY_REPORT,
    });
    await associate(world, "multi-review", "review-1");
    await settle(context);
    await world.finishTurn(coordinator);

    await saveReview(world, worker, "review-1", {
      phase: "interactive",
      consolidatedReport: READY_REPORT,
      fixSession: { sessionKey: "fix", status: "idle", startedAt: "2026-10-16T10:10:00Z" },
    });
    await settle(context);
    await world.finishTurn(coordinator);

    await saveReview(world, worker, "review-1", {
      phase: "completed",
      fixResult: { complete: true, summary: "All findings fixed", filesChanged: ["a.ts", "b.ts"] },
    });
    await settle(context);

    expect(world.wakes(coordinator)).toBe(3);
    expect(world.carriers(coordinator).map((turn) => turn[0]!.notice?.state)).toEqual([
      "ready",
      "fix-done",
      "completed",
    ]);
    expect(world.received(coordinator)[2]).toContain("Files changed: 2");
    // A terminal state closes the association's reporting, as before.
    const association = (
      await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)
    ).find((item) => item.resourceId === "review-1");
    expect(association?.terminalNotifiedAt).toBeDefined();
  });

  test("an auto-fix and auto-PR review wakes on the PR, not on each step it takes by itself", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    const auto = { autoFix: true, autoPr: true, consolidatedReport: READY_REPORT };
    const fix = { sessionKey: "fix", startedAt: "2026-10-16T10:10:00Z" };
    await saveReview(world, worker, "review-1", { ...auto, phase: "reviewing" });
    await associate(world, "multi-review", "review-1");
    await settle(context);
    // Consolidation with findings goes straight to the Fix handoff: no ready.
    await saveReview(world, worker, "review-1", {
      ...auto,
      phase: "interactive",
      addressPromptPending: true,
    });
    await settle(context);
    await saveReview(world, worker, "review-1", {
      ...auto,
      phase: "interactive",
      fixSession: { ...fix, status: "running" },
    });
    await settle(context);
    // The Fix finished and queued its PR in the same save: hold for the PR.
    await saveReview(world, worker, "review-1", {
      ...auto,
      phase: "interactive",
      fixSession: { ...fix, status: "idle" },
      autoPrLaunch: { state: "pending", requestId: "multi-review-pr:review-1" },
    });
    await settle(context);
    expect(world.wakes(coordinator)).toBe(0);

    await saveReview(world, worker, "review-1", {
      ...auto,
      phase: "interactive",
      fixSession: { ...fix, status: "idle" },
      autoPrLaunch: {
        state: "launched",
        requestId: "multi-review-pr:review-1",
        tabId: "pr-tab",
        fixIdentity: multiReviewFixIdentity(fix),
      },
    });
    await settle(context);
    await world.finishTurn(coordinator);
    // The PR monitor records the pull request; the next sweep reports it.
    await world.storage.updateEnvironment(worker.environmentId, {
      prUrl: "https://github.com/org/repo/pull/7",
      prState: "open",
    });
    await settle(context);

    expect(world.carriers(coordinator).map((turn) => turn[0]!.notice?.state)).toEqual([
      "pr-started",
      "pr-opened",
    ]);
    expect(world.carriers(coordinator)[0]![0]!.subject).toBe(
      "Multi Review review-env fix finished; PR session started",
    );
    expect(world.received(coordinator)[0]).toContain(
      `get_tab_state { "environmentId": "${worker.environmentId}", "tabId": "pr-tab" }`,
    );
    expect(world.received(coordinator)[1]).toContain(
      "Pull request: https://github.com/org/repo/pull/7",
    );
    expect(world.received(coordinator)[1]).toContain("does not merge");
  });

  test.each(["sessionKey", "startedAt"] as const)(
    "a later Fix with a new %s wakes with fix-done after an earlier PR launch",
    async (field) => {
      const context = await createWorld();
      const { world } = context;
      const coordinator = await world.main();
      const worker = await world.addEnvironment("review-env");
      const fix = { sessionKey: "fix-a", startedAt: "2026-10-16T10:10:00Z", status: "idle" };
      const autoPrLaunch = {
        state: "launched",
        requestId: "pr",
        tabId: "pr-tab",
        fixIdentity: multiReviewFixIdentity(fix),
      };
      const snapshot = { autoPr: true, phase: "interactive", fixSession: fix, autoPrLaunch };
      await saveReview(world, worker, "review-1", snapshot);
      await associate(world, "multi-review", "review-1");
      await settle(context);
      await world.finishTurn(coordinator);
      await world.storage.updateEnvironment(worker.environmentId, {
        prUrl: "https://github.com/org/repo/pull/7",
        prState: "open",
      });
      await saveReview(world, worker, "review-1", {
        ...snapshot,
        fixSession: { ...fix, [field]: field === "sessionKey" ? "fix-b" : "2026-10-16T11:10:00Z" },
      });
      await settle(context);
      expect(world.carriers(coordinator).map((turn) => turn[0]!.notice?.state)).toEqual([
        "pr-started",
        "fix-done",
      ]);
      expect(world.received(coordinator)[1]).toContain(
        "does not confirm inclusion of this Fix's changes",
      );
    },
  );

  test.each(["open", "closed", "merged", undefined] as const)(
    "first PR observation after restart reports state %s accurately",
    async (prState) => {
      const context = await createWorld();
      const { world } = context;
      const coordinator = await world.main();
      const worker = await world.addEnvironment("review-env");
      const fix = { sessionKey: "fix", startedAt: "2026-10-16T10:10:00Z", status: "idle" };
      const snapshot = {
        autoPr: true,
        phase: "interactive",
        fixSession: fix,
        autoPrLaunch: {
          state: "launched",
          requestId: "pr",
          fixIdentity: multiReviewFixIdentity(fix),
        },
      };
      const prUrl = "https://github.com/org/repo/pull/7";
      await saveReview(world, worker, "review-1", snapshot);
      await associate(world, "multi-review", "review-1");
      await world.storage.updateEnvironment(worker.environmentId, { prUrl, prState });
      const expected = prState === "open" ? "pr-opened" : prState ? `pr-${prState}` : "pr-unknown";
      expect(multiReviewStatus(snapshot, "review-1", { prUrl, prState })?.state).toBe(expected);
      await world.restart();
      await settle(context);
      expect(world.carriers(coordinator)[0]![0]!.notice?.state).toBe(expected);
      await world.finishTurn(coordinator);
      await world.restart();
      await settle(context);
      expect(await coordinatorInbox(world)).toHaveLength(1);
      // The retained URL also must not mask a subsequent state change.
      if (prState === "open") {
        await world.storage.updateEnvironment(worker.environmentId, { prState: "closed" });
        await settle(context);
        expect(world.carriers(coordinator)[1]![0]!.notice?.state).toBe("pr-closed");
      }
    },
  );

  test.each(["failed", "skipped"] as const)(
    "a structured Fix held for a pending PR wakes when the launch is %s",
    async (state) => {
      const context = await createWorld();
      const { world } = context;
      const coordinator = await world.main();
      const worker = await world.addEnvironment("review-env");
      const snapshot = {
        autoPr: true,
        phase: "completed",
        fixResult: { complete: true, summary: "Fixed" },
      };
      await saveReview(world, worker, "review-1", {
        ...snapshot,
        autoPrLaunch: { state: "pending", requestId: "pr" },
      });
      await associate(world, "multi-review", "review-1");
      await settle(context);
      expect(world.wakes(coordinator)).toBe(0);
      await saveReview(world, worker, "review-1", {
        ...snapshot,
        autoPrLaunch: { state, requestId: "pr", message: "PR needs manual creation" },
      });
      await settle(context);
      expect(world.carriers(coordinator)[0]![0]!.notice?.state).toBe("completed");
      expect(world.received(coordinator)[0]).toContain(
        "No PR session started: PR needs manual creation",
      );
      await world.finishTurn(coordinator);
      await settle(context);
      expect(await coordinatorInbox(world)).toHaveLength(1);
    },
  );

  test("an auto-PR review stops at a failed Fix or PR launch and says why", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    const auto = { autoFix: true, autoPr: true, consolidatedReport: READY_REPORT };
    for (const id of ["fix-failed", "pr-failed", "pr-skipped"]) {
      await saveReview(world, worker, id, { ...auto, phase: "reviewing" });
      await associate(world, "multi-review", id);
    }
    await settle(context);
    const fix = { sessionKey: "fix", startedAt: "2026-10-16T10:10:00Z" };
    await saveReview(world, worker, "fix-failed", {
      ...auto,
      phase: "interactive",
      fixSession: { ...fix, status: "failed", error: "The interactive fix session failed" },
    });
    await saveReview(world, worker, "pr-failed", {
      ...auto,
      phase: "interactive",
      fixSession: { ...fix, status: "idle" },
      autoPrLaunch: {
        state: "failed",
        requestId: "multi-review-pr:pr-failed",
        attempts: 3,
        message: "Environment already has the maximum of 12 tabs",
      },
    });
    await saveReview(world, worker, "pr-skipped", {
      ...auto,
      phase: "interactive",
      fixSession: { ...fix, status: "idle" },
      autoPrLaunch: {
        state: "skipped",
        requestId: "multi-review-pr:pr-skipped",
        message: "The Fix was stopped before it finished, so no PR agent was launched.",
      },
    });
    await settle(context);

    expect(world.wakes(coordinator)).toBe(1);
    const turn = world.carriers(coordinator)[0]!;
    const byResource = new Map(turn.map((carrier) => [carrier.notice?.resource.id, carrier]));
    expect(byResource.get("fix-failed")?.notice?.state).toBe("fix-failed");
    expect(byResource.get("fix-failed")?.body).toContain("No PR session will start.");
    expect(byResource.get("pr-failed")?.notice).toMatchObject({
      state: "pr-failed",
      tone: "failure",
    });
    expect(byResource.get("pr-failed")?.body).toContain("maximum of 12 tabs");
    expect(byResource.get("pr-skipped")?.notice?.state).toBe("fix-done");
    expect(byResource.get("pr-skipped")?.body).toContain(
      "No PR session started: The Fix was stopped before it finished",
    );
  });

  test("a build pipeline wakes on its end and on a pause the supervisor took, not a requested one", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("build-env");
    await savePipeline(world, worker, "pipeline-1", { phase: "building" });
    await associate(world, "build-pipeline", "pipeline-1");

    await savePipeline(world, worker, "pipeline-1", {
      phase: "paused",
      pausedFromPhase: "reviewing",
      pauseCause: "requested",
      error: "Reconnect failed",
    });
    await settle(context);
    expect(world.wakes(coordinator)).toBe(0);

    await savePipeline(world, worker, "pipeline-1", {
      phase: "paused",
      pausedFromPhase: "fixing",
      error: "The fix changed nothing",
      pauseCause: "supervisor",
    });
    await settle(context);
    await world.finishTurn(coordinator);

    await savePipeline(world, worker, "pipeline-1", {
      phase: "complete",
      verificationResult: "pass",
    });
    await settle(context);

    expect(world.carriers(coordinator).map((turn) => turn[0]!.notice)).toEqual([
      expect.objectContaining({ state: "paused", tone: "attention" }),
      expect.objectContaining({ state: "completed", tone: "success" }),
    ]);
    expect(world.received(coordinator)[0]).toContain("Error: The fix changed nothing");
  });

  test("stage completions wake only under the opt-in stages setting", async () => {
    const settled = await createWorld();
    const worker = await settled.world.addEnvironment("build-env");
    await savePipeline(settled.world, worker, "pipeline-1", { phase: "building" });
    await associate(settled.world, "build-pipeline", "pipeline-1");
    await savePipeline(settled.world, worker, "pipeline-1", { phase: "reviewing" });
    await settle(settled);
    expect(settled.world.wakes(await settled.world.main())).toBe(0);
    await settled.world.close();
    setup = null;

    const stages = await createWorld({ coordinatorStatusWakes: "stages" });
    const coordinator = await stages.world.main();
    const stagedWorker = await stages.world.addEnvironment("build-env");
    await savePipeline(stages.world, stagedWorker, "pipeline-2", { phase: "building" });
    await associate(stages.world, "build-pipeline", "pipeline-2");
    await savePipeline(stages.world, stagedWorker, "pipeline-2", { phase: "reviewing" });
    await settle(stages);
    expect(stages.world.carriers(coordinator)[0]![0]!.notice).toMatchObject({
      state: "stage-completed",
      tone: "info",
    });
    expect(stages.world.carriers(coordinator)[0]![0]!.subject).toContain(
      "finished its build stage",
    );
  });

  test("off keeps only the terminal workflow notices it always sent", async () => {
    const context = await createWorld({ coordinatorStatusWakes: "off" });
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    await saveReview(world, worker, "review-1", {
      phase: "ready",
      consolidatedReport: READY_REPORT,
    });
    await associate(world, "multi-review", "review-1");
    await settle(context);
    expect(world.wakes(coordinator)).toBe(0);

    await saveReview(world, worker, "review-1", { phase: "failed", error: "Reviewer crashed" });
    await settle(context);
    expect(world.wakes(coordinator)).toBe(1);
    expect(world.carriers(coordinator)[0]![0]!.notice?.state).toBe("failed");

    // A delegated worker waiting on an approval is not reported either.
    await world.finishTurn(coordinator);
    const delegated = await world.addEnvironment("worker", { launched: true });
    context.activity.set(`${delegated.environmentId}:${delegated.tabId}`, "waiting");
    await world.coordinator.noteWorkerActivity({ ...delegated, state: "waiting" });
    await advance(context, COORDINATOR_WAITING_DEBOUNCE_MS + 1);
    await settle(context);
    expect(world.wakes(coordinator)).toBe(1);
  });

  test("work the user started never wakes a coordinator", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("user-env");
    // No association: the user launched these from the UI.
    await saveReview(world, worker, "review-user", { phase: "failed", error: "x" });
    await savePipeline(world, worker, "pipeline-user", { phase: "complete" });
    context.activity.set(`${worker.environmentId}:${worker.tabId}`, "waiting");
    await world.coordinator.noteWorkerActivity({
      environmentId: worker.environmentId,
      tabId: worker.tabId,
      state: "waiting",
    });
    await advance(context, COORDINATOR_WAITING_DEBOUNCE_MS + 1);
    await settle(context);

    expect(world.wakes(coordinator)).toBe(0);
    expect(await coordinatorInbox(world)).toEqual([]);
  });

  test("seven reviews settling together arrive as one wake", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    const ids = Array.from({ length: 7 }, (_, index) => `review-${index + 1}`);
    for (const id of ids) {
      await saveReview(world, worker, id, { phase: "reviewing" });
      await associate(world, "multi-review", id);
    }
    for (const id of ids) {
      await saveReview(world, worker, id, { phase: "ready", consolidatedReport: READY_REPORT });
    }
    await world.coordinator.reconcileWorkflowNotifications();
    // Inside the coalescing window nothing is delivered yet.
    await world.deliver();
    expect(world.wakes(coordinator)).toBe(0);

    await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
    await world.deliver();
    expect(world.wakes(coordinator)).toBe(1);
    expect(world.carriers(coordinator)[0]!.map((carrier) => carrier.notice?.resource.id)).toEqual(
      ids,
    );
  });

  test("rapid transitions of one resource coalesce into one wake", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    await saveReview(world, worker, "review-1", { phase: "reviewing" });
    await associate(world, "multi-review", "review-1");

    await saveReview(world, worker, "review-1", {
      phase: "reviewing",
      reviewers: [
        {
          id: "r1",
          model: "gpt",
          status: "running",
          sessionKey: "r1",
          stalledSince: "2026-10-16T10:00:00Z",
        },
      ],
    });
    await world.coordinator.reconcileWorkflowNotifications();
    await advance(context, 3_000);
    await saveReview(world, worker, "review-1", { phase: "failed", error: "Stalled reviewer" });
    await world.coordinator.reconcileWorkflowNotifications();
    await advance(context, COORDINATOR_STATUS_COALESCE_MS);
    await world.deliver();

    expect(world.wakes(coordinator)).toBe(1);
    expect(world.carriers(coordinator)[0]!.map((carrier) => carrier.notice?.state)).toEqual([
      "stalled",
      "failed",
    ]);
  });

  test("legacy consolidation survives delayed result saves without duplicate wakes", async () => {
    const context = await createWorld();
    const { world } = context;
    const main = await world.main();
    const worker = await world.addEnvironment("legacy-review");
    await associate(world, "multi-review", "legacy");
    const snapshot = {
      phase: "ready",
      fixSession: {
        sessionKey: "legacy-consolidation",
        status: "idle",
        completedAt: "2026-10-16T10:00:00Z",
      },
      consolidatedReport: READY_REPORT,
    };
    await saveReview(world, worker, "legacy", { ...snapshot, updatedAt: "2026-10-16T10:01:00Z" });
    await settle(context);
    await world.finishTurn(main);
    await saveReview(world, worker, "legacy", {
      ...snapshot,
      updatedAt: "2026-10-16T10:02:00Z",
      pendingResultConsumptions: [],
    });
    await settle(context);
    expect(world.wakes(main)).toBe(1);
  });

  for (const stage of ["reviewer", "consolidation"] as const) {
    test(`a stalled build fan-out ${stage} wakes once per episode`, async () => {
      const context = await createWorld();
      const { world } = context;
      const main = await world.main();
      const worker = await world.addEnvironment("fanout");
      await associate(world, "build-pipeline", "fanout");
      const save = async (since: string) => {
        const session = { sessionKey: stage, status: "running", stalledSince: since };
        await savePipeline(world, worker, "fanout", {
          phase: "reviewing",
          reviewFanout:
            stage === "reviewer"
              ? { reviewers: [session] }
              : { reviewers: [], consolidation: session },
        });
        await settle(context);
      };
      await save("2026-10-16T10:00:00Z");
      await world.finishTurn(main);
      await save("2026-10-16T10:00:00Z");
      expect(world.wakes(main)).toBe(1);
      await save("2026-10-16T11:00:00Z");
      expect(world.wakes(main)).toBe(2);
      expect(
        world
          .carriers(main)
          .flat()
          .map((message) => message.notice?.state),
      ).toEqual(["stalled", "stalled"]);
    });
  }

  for (const budget of ["loop", "hourly"] as const) {
    test(`worker budget hold notices are once per ${budget} window and do not recurse`, async () => {
      const context = await createWorld(
        budget === "loop" ? { autonomousWakeBudget: 1 } : { hourlyWakeLimit: 1 },
      );
      const { world } = context;
      const main = await world.main();
      const worker = await world.addEnvironment("chatty");
      await world.send(worker, main, "first");
      await world.deliver();
      await world.finishTurn(main);
      const held = await world.send(worker, main, "second");
      expect(held.placementReason).toBe(
        budget === "loop" ? AGENT_MAIL_LOOP_BUDGET_REASON : AGENT_MAIL_HOURLY_LIMIT_REASON,
      );
      await world.send(worker, main, "third");
      await world.deliver();
      const notices = (await coordinatorInbox(world)).filter(
        (message) => message.notice?.state === "mail-held",
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]!.requestId).toMatch(budget === "loop" ? /:epoch-\d+$/ : /:hour-\d+$/);
      expect(notices[0]!.from.kind).toBe("system");
      expect(notices[0]!.placement).toBe("injected");
      expect(world.received(main).join("\n")).toContain("read_messages");
      await world.finishTurn(main);
      if (budget === "loop") {
        await world.storage.resetAgentMailBudgetForSession(
          main.environmentId,
          main.logicalSessionKey,
        );
      } else {
        await advance(context, 3_600_001);
        await world.deliver();
        await world.finishTurn(main);
      }
      await world.send(worker, main, "new budget first");
      await world.deliver();
      await world.finishTurn(main);
      await world.send(worker, main, "new budget held");
      await world.deliver();
      expect(
        (await coordinatorInbox(world)).filter((message) => message.notice?.state === "mail-held"),
      ).toHaveLength(2);
    });
  }

  test("a resource's notices spend the unattended budget; the user's prompt starts a new one", async () => {
    const context = await createWorld({ autonomousWakeBudget: 2 });
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    await saveReview(world, worker, "review-1", { phase: "reviewing" });
    await associate(world, "multi-review", "review-1");

    const stall = async (since: string) => {
      await saveReview(world, worker, "review-1", {
        phase: "reviewing",
        reviewers: [{ id: "r1", status: "running", sessionKey: "r1", stalledSince: since }],
      });
      await settle(context);
      await world.finishTurn(coordinator);
    };
    await stall("2026-10-16T10:00:00Z");
    await stall("2026-10-16T11:00:00Z");
    await stall("2026-10-16T12:00:00Z");

    expect(world.wakes(coordinator)).toBe(2);
    const held = (await coordinatorInbox(world)).filter(
      (message) => message.placement === "inject-held",
    );
    expect(held.map((message) => message.placementReason)).toEqual([AGENT_MAIL_LOOP_BUDGET_REASON]);

    // A person prompting the coordinator is the authority the budget stands for.
    await advance(context, 1_000);
    await world.storage.resetAgentMailBudgetForSession(
      coordinator.environmentId,
      coordinator.logicalSessionKey,
    );
    await stall("2026-10-16T13:00:00Z");
    expect(world.wakes(coordinator)).toBe(3);
  });

  test("the hourly limit holds a resource's notices and releases them as the hour passes", async () => {
    const context = await createWorld({ hourlyWakeLimit: 1 });
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    await saveReview(world, worker, "review-1", { phase: "reviewing" });
    await associate(world, "multi-review", "review-1");

    await saveReview(world, worker, "review-1", {
      phase: "ready",
      consolidatedReport: READY_REPORT,
    });
    await settle(context);
    await world.finishTurn(coordinator);
    await saveReview(world, worker, "review-1", { phase: "failed", error: "x" });
    await settle(context);
    expect(world.wakes(coordinator)).toBe(1);
    expect(
      (await coordinatorInbox(world)).find((message) => message.notice?.state === "failed")
        ?.placementReason,
    ).toBe(AGENT_MAIL_HOURLY_LIMIT_REASON);

    await advance(context, 60 * 60 * 1_000);
    await world.deliver();
    expect(world.wakes(coordinator)).toBe(2);
  });

  test("a notice placed before a backend restart is delivered once after it", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    await saveReview(world, worker, "review-1", {
      phase: "ready",
      consolidatedReport: READY_REPORT,
    });
    await associate(world, "multi-review", "review-1");
    await world.coordinator.reconcileWorkflowNotifications();

    await world.restart();
    await world.coordinator.reconcileWorkflowNotifications();
    await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
    await world.deliver();
    expect(world.wakes(coordinator)).toBe(1);
    expect(await coordinatorInbox(world)).toHaveLength(1);
  });

  test("a crash between placing a notice and recording it never sends it twice", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    await saveReview(world, worker, "review-1", {
      phase: "ready",
      consolidatedReport: READY_REPORT,
    });
    const associationId = await associate(world, "multi-review", "review-1");
    await world.coordinator.reconcileWorkflowNotifications();
    // The bookkeeping write is lost.
    await world.storage.coordinators.updateCoordinatorWorkflowAssociation(
      associationId,
      (association) => {
        delete association.statusNotice;
        return true;
      },
    );

    await world.restart();
    await settle(context);
    expect(world.wakes(coordinator)).toBe(1);
    expect(await coordinatorInbox(world)).toHaveLength(1);
  });

  test("an old workflow first seen after an upgrade is recorded without a wake", async () => {
    const context = await createWorld();
    const { world, timers } = context;
    const coordinator = await world.main();
    const worker = await world.addEnvironment("review-env");
    setSystemTime(new Date(timers.now() - 2 * 24 * 60 * 60 * 1_000));
    await saveReview(world, worker, "review-old", {
      phase: "ready",
      consolidatedReport: READY_REPORT,
    });
    setSystemTime(new Date(timers.now()));
    await associate(world, "multi-review", "review-old");

    await settle(context);
    expect(world.wakes(coordinator)).toBe(0);
    const association = (
      await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)
    ).find((item) => item.resourceId === "review-old");
    expect(association?.statusNotice?.key).toMatch(/^ready:/);
  });

  test("a workflow save is reported within seconds through the change listener", async () => {
    const context = await createWorld();
    const { world } = context;
    const coordinator = await world.main();
    world.coordinator.startStatusWakes();
    const worker = await world.addEnvironment("review-env");
    await saveReview(world, worker, "review-1", { phase: "reviewing" });
    await associate(world, "multi-review", "review-1");

    await saveReview(world, worker, "review-1", { phase: "cancelled" });
    await advance(context, 2_000);
    await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
    await world.deliver();
    expect(world.carriers(coordinator)[0]![0]!.notice?.state).toBe("cancelled");
  });

  describe("delegated tabs", () => {
    test("a worker waiting past the debounce wakes its coordinator once per episode", async () => {
      const context = await createWorld();
      const { world, activity, excerpts } = context;
      const coordinator = await world.main();
      const worker = await world.addEnvironment("worker", { launched: true });
      const key = `${worker.environmentId}:${worker.tabId}`;
      excerpts.set(key, "May I run `rm -rf build`?");

      // An approval answered within seconds is not news.
      activity.set(key, "waiting");
      await world.coordinator.noteWorkerActivity({ ...worker, state: "waiting" });
      await advance(context, 5_000);
      activity.set(key, "working");
      await world.coordinator.noteWorkerActivity({ ...worker, state: "working" });
      await advance(context, COORDINATOR_WAITING_DEBOUNCE_MS);
      await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
      await world.deliver();
      expect(world.wakes(coordinator)).toBe(0);

      // One that lasts is, and names what it is blocked on.
      context.blockers.set(key, "approval");
      activity.set(key, "waiting");
      await world.coordinator.noteWorkerActivity({ ...worker, state: "waiting" });
      await advance(context, COORDINATOR_WAITING_DEBOUNCE_MS);
      await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
      await world.deliver();
      expect(world.wakes(coordinator)).toBe(1);
      const [carrier] = world.carriers(coordinator)[0]!;
      expect(carrier!.body).toContain("is waiting for an approval.");
      expect(carrier!.notice).toMatchObject({
        resource: {
          kind: "agent-tab",
          environmentId: worker.environmentId,
          tabId: "startup-agent",
        },
        state: "waiting",
        tone: "attention",
      });
      expect(carrier!.body).toContain("Last message: May I run `rm -rf build`?");
      expect(carrier!.body).toContain("get_tab_state");

      // Still the same episode on the sweep: no second notice.
      await world.finishTurn(coordinator);
      await settle(context);
      expect(world.wakes(coordinator)).toBe(1);

      // Working again, then waiting again, is a new episode.
      activity.set(key, "working");
      await world.coordinator.noteWorkerActivity({ ...worker, state: "working" });
      activity.set(key, "waiting");
      await world.coordinator.noteWorkerActivity({ ...worker, state: "waiting" });
      await advance(context, COORDINATOR_WAITING_DEBOUNCE_MS);
      await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
      await world.deliver();
      expect(world.wakes(coordinator)).toBe(2);

      // The turn ending still closes the delegation with its own single wake.
      await world.finishTurn(coordinator);
      await world.finishTurn(worker);
      expect(world.wakes(coordinator)).toBe(3);
      expect(world.received(coordinator)[2]).toContain("without sending a report");
    });

    test("waiting excerpt and blocker reads start together on the serialized wake queue", async () => {
      const excerptStarted = Promise.withResolvers<void>();
      const blockerStarted = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const context = await createWorld(
        {},
        {
          lastAssistantExcerpt: async () => {
            excerptStarted.resolve();
            await release.promise;
            return "Please decide";
          },
          waitingBlocker: async () => {
            blockerStarted.resolve();
            await release.promise;
            return "approval-and-question";
          },
        },
      );
      const { world, activity } = context;
      const worker = await world.addEnvironment("waiting-worker", { launched: true });
      const coordinator = await world.main();
      activity.set(`${worker.environmentId}:${worker.tabId}`, "waiting");
      await world.coordinator.noteWorkerActivity({ ...worker, state: "waiting" });
      await advance(context, COORDINATOR_WAITING_DEBOUNCE_MS);
      try {
        await excerptStarted.promise;
        // With sequential reads this cannot resolve until the excerpt is released.
        await Promise.race([
          blockerStarted.promise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("blocker read did not start concurrently")), 500),
          ),
        ]);
      } finally {
        release.resolve();
      }
      await world.coordinator.statusWakes.settled();
      await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
      await world.deliver();
      expect(world.carriers(coordinator)[0]![0]!.body).toContain("cannot approve or answer");
      expect(world.carriers(coordinator)[0]![0]!.body).toContain("Please decide");
    });

    test("a waiting episode starting or ending announces a coordinator change", async () => {
      const context = await createWorld();
      const { world, activity } = context;
      await world.main();
      const worker = await world.addEnvironment("worker", { launched: true });
      const key = `${worker.environmentId}:${worker.tabId}`;
      const announced: string[] = [];
      const unsubscribe = world.storage.addResourceChangeListener((change) => {
        if (change.resource === "coordinator") announced.push(change.id);
      });
      try {
        activity.set(key, "waiting");
        await world.coordinator.noteWorkerActivity({ ...worker, state: "waiting" });
        expect(announced).toEqual([world.projectId]);
        const open = await world.storage.coordinators.listOpenCoordinatorDelegations();
        expect(open[0]!.delegation!.waiting?.since).toBeString();

        // The notice's own bookkeeping is not a change the panel shows.
        await advance(context, COORDINATOR_WAITING_DEBOUNCE_MS);
        await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
        expect(announced).toEqual([world.projectId]);

        activity.set(key, "working");
        await world.coordinator.noteWorkerActivity({ ...worker, state: "working" });
        expect(announced).toEqual([world.projectId, world.projectId]);
        const after = await world.storage.coordinators.listOpenCoordinatorDelegations();
        expect(after[0]!.delegation!.waiting).toBeUndefined();
      } finally {
        unsubscribe();
      }
    });

    test("two workers' waiting notices are budgeted apart, though both tabs are startup-agent", async () => {
      const context = await createWorld({ autonomousWakeBudget: 1 });
      const { world, activity } = context;
      const coordinator = await world.main();
      const first = await world.addEnvironment("first", { launched: true });
      const second = await world.addEnvironment("second", { launched: true });
      for (const worker of [first, second]) {
        activity.set(`${worker.environmentId}:${worker.tabId}`, "waiting");
        await world.coordinator.noteWorkerActivity({ ...worker, state: "waiting" });
      }
      await advance(context, COORDINATOR_WAITING_DEBOUNCE_MS);
      await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
      await world.deliver();
      expect(world.wakes(coordinator)).toBe(1);
      expect(
        world.carriers(coordinator)[0]!.map((carrier) => carrier.notice?.resource.environmentId),
      ).toEqual([first.environmentId, second.environmentId]);
    });

    test("the sweep finds a waiting episode whose edge was lost to a restart", async () => {
      const context = await createWorld();
      const { world, activity } = context;
      const coordinator = await world.main();
      const worker = await world.addEnvironment("worker", { launched: true });
      activity.set(`${worker.environmentId}:${worker.tabId}`, "waiting");

      await world.restart();
      await world.coordinator.reconcileWorkflowNotifications();
      await advance(context, COORDINATOR_WAITING_DEBOUNCE_MS);
      await advance(context, COORDINATOR_STATUS_COALESCE_MS + 1);
      await world.deliver();
      expect(world.carriers(coordinator)[0]![0]!.notice?.state).toBe("waiting");
    });

    test("a silent worker's finished notice carries its last message", async () => {
      const context = await createWorld();
      const { world, excerpts } = context;
      const coordinator = await world.main();
      const worker = await world.addEnvironment("quiet", { launched: true });
      excerpts.set(`${worker.environmentId}:${worker.tabId}`, "All tests pass; PR #12 opened.");
      await world.finishTurn(worker);
      expect(world.received(coordinator)[0]).toContain(
        "Last message: All tests pass; PR #12 opened.",
      );
      expect(world.received(coordinator)[0]).toContain("get_tab_transcript");
    });
  });
});

describe("status classification and bounds", () => {
  test("individual reviewers finishing is progress, not a status", () => {
    expect(
      multiReviewStatus(
        {
          phase: "reviewing",
          reviewers: [
            { id: "a", status: "completed" },
            { id: "b", status: "running" },
          ],
        },
        "review-1",
      ),
    ).toBeNull();
    expect(multiReviewStatus({ phase: "consolidating", reviewers: [] }, "review-1")?.mode).toBe(
      "stages",
    );
    expect(multiReviewStatus({ phase: "preparing" }, "review-1")).toBeNull();
    expect(buildPipelineStatus({ phase: "building" }, "pipeline-1")).toBeNull();
  });

  test("a relaunched fix or a second consolidation is a new state", () => {
    const fix = (sessionKey: string) =>
      multiReviewStatus(
        {
          phase: "interactive",
          fixSession: { sessionKey, status: "idle", startedAt: "2026-10-16T10:00:00Z" },
        },
        "review-1",
      )!.key;
    expect(fix("fix-a")).not.toBe(fix("fix-b"));
    const ready = (completedAt: string) =>
      multiReviewStatus(
        { phase: "ready", reviewSession: { completedAt }, consolidatedReport: READY_REPORT },
        "review-1",
      )!.key;
    expect(ready("2026-10-16T10:00:00Z")).not.toBe(ready("2026-10-16T11:00:00Z"));
    // A pending fix handoff has not settled.
    expect(
      multiReviewStatus(
        { phase: "interactive", addressPromptPending: true, fixSession: { status: "idle" } },
        "review-1",
      ),
    ).toBeNull();
  });

  test("a clean report with auto-PR is held, then reported through its PR states", () => {
    const status = (
      autoPrLaunch: Record<string, unknown>,
      environment: Record<string, unknown> = {},
      phase = "ready",
    ) =>
      multiReviewStatus(
        {
          phase,
          autoFix: true,
          autoPr: true,
          consolidatedReport: { issues: [], testCoverageGaps: [] },
          autoPrLaunch: { basis: "clean-review", requestId: "pr", ...autoPrLaunch },
        },
        "review-1",
        environment,
      );
    expect(status({ state: "pending" })).toBeNull();
    const started = status({ state: "launched", tabId: "pr-tab" })!;
    expect(started).toMatchObject({
      state: "pr-started",
      headline: "found nothing to fix; PR session started",
    });
    const opened = status(
      { state: "launched", tabId: "pr-tab" },
      { prUrl: "https://github.com/org/repo/pull/7", prState: "open" },
    )!;
    expect(opened).toMatchObject({
      state: "pr-opened",
      headline: "found nothing to fix and its pull request is open",
    });
    expect(opened.key).not.toBe(started.key);
    const failed = status({ state: "failed", message: "tab limit" })!;
    expect(failed).toMatchObject({
      state: "pr-failed",
      headline: "found nothing to fix but its PR session could not start",
    });
    expect(failed.tools.join(" ")).not.toContain("open_multi_review_fix");
    const skipped = status({ state: "skipped", message: "A pull request already exists" })!;
    expect(skipped).toMatchObject({ state: "ready", headline: "found nothing to fix" });
    expect(skipped.details).toContain("No PR session started: A pull request already exists");
  });

  test.each(["issues", "testCoverageGaps"])(
    "a retained clean-review PR cannot hide current %s",
    (kind) => {
      const status = multiReviewStatus(
        {
          phase: "ready",
          autoPr: true,
          consolidatedReport: { issues: [], testCoverageGaps: [], [kind]: [{}] },
          autoPrLaunch: { basis: "clean-review", state: "launched", requestId: "pr" },
        },
        "review-1",
        { prUrl: "https://github.com/org/repo/pull/7", prState: "open" },
      )!;
      expect(status).toMatchObject({ state: "ready", headline: "is ready to address" });
      expect(status.tools).toContain('address_multi_review { "workflowId": "review-1" }');
    },
  );

  test("auto-actions explain a ready review and hold a completion whose PR is queued", () => {
    const ready = (snapshot: Record<string, unknown>) =>
      multiReviewStatus(
        { phase: "ready", consolidatedReport: { issues: [], testCoverageGaps: [] }, ...snapshot },
        "review-1",
      )!.details;
    expect(ready({ autoFix: true, autoPr: true })).toContain(
      "Auto-fix is on, but there was nothing to fix, so no Fix or PR session started.",
    );
    expect(ready({ autoPr: true }).join(" ")).toContain(
      "once a Fix started with address_multi_review",
    );
    expect(ready({})).toHaveLength(1);
    expect(
      multiReviewStatus(
        { phase: "ready", consolidatedReport: READY_REPORT, autoFix: true },
        "review-1",
      )!.details.join(" "),
    ).not.toContain("nothing to fix");
    const completedFix = { sessionKey: "structured-fix", startedAt: "2026-10-16T10:10:00Z" };
    const completed = {
      phase: "completed",
      autoPr: true,
      fixResult: { complete: true },
      fixSession: completedFix,
    };
    expect(
      multiReviewStatus(
        { ...completed, autoPrLaunch: { state: "pending", requestId: "r" } },
        "review-1",
      ),
    ).toBeNull();
    expect(
      multiReviewStatus(
        {
          ...completed,
          autoPrLaunch: {
            state: "launched",
            requestId: "r",
            tabId: "pr",
            fixIdentity: multiReviewFixIdentity(completedFix),
          },
        },
        "review-1",
      )!.details,
    ).toContain("PR session started in tab pr.");
    // Without auto-PR a stray launch record is ignored, as the supervisor ignores it.
    expect(
      multiReviewStatus(
        {
          phase: "interactive",
          fixSession: { sessionKey: "fix", status: "idle" },
          autoPrLaunch: { state: "pending", requestId: "r" },
        },
        "review-1",
      )?.state,
    ).toBe("fix-done");
  });

  test("a legacy launch with no Fix identity cannot claim a later Fix's PR", () => {
    expect(
      multiReviewStatus(
        {
          phase: "interactive",
          autoPr: true,
          fixSession: { sessionKey: "later-fix", status: "idle" },
          autoPrLaunch: { state: "launched", requestId: "pr" },
        },
        "review-1",
        { prUrl: "https://github.com/org/repo/pull/7", prState: "open" },
      )?.state,
    ).toBe("fix-done");
  });

  for (const error of [
    "Reconnect failed",
    "Build paused, but stopping every agent could not be confirmed",
  ]) {
    test(`a requested pause with ${error} is not supervisor attention`, () => {
      expect(
        buildPipelineStatus({ phase: "paused", pauseCause: "requested", error }, "p"),
      ).toBeNull();
    });
  }

  test("legacy ready and consolidation keys use the session attempt, not bookkeeping time", () => {
    const session = { sessionKey: "legacy", startedAt: "start", completedAt: "done" };
    const ready = (updatedAt: string) =>
      multiReviewStatus({ phase: "ready", fixSession: session, updatedAt }, "r")!.key;
    expect(ready("first save")).toBe(ready("delayed result consumption"));
    const stage = (sessionKey: string) =>
      multiReviewStatus({ phase: "consolidating", fixSession: { ...session, sessionKey } }, "r")!
        .key;
    expect(stage("first attempt")).not.toBe(stage("second attempt"));
  });

  for (const [phase, finished] of [
    ["fixing", "verification"],
    ["creating-pr", "verification"],
    ["resolving-conflicts", "pull request"],
  ]) {
    test(`${phase} reports its preceding completed stage`, () => {
      expect(buildPipelineStatus({ phase }, "p")?.headline).toBe(
        `finished its ${finished} stage; now ${phase}`,
      );
    });
  }

  test("subjects, details and bodies stay bounded whatever the workflow holds", () => {
    const status = buildPipelineStatus(
      { phase: "failed", taskTitle: "t".repeat(5_000), error: "e".repeat(50_000) },
      "pipeline-1",
    )!;
    const rendered = renderCoordinatorStatusNotice(
      { kind: "build-pipeline", id: "pipeline-1", label: "l".repeat(1_000) },
      status,
    );
    expect(rendered.subject.length).toBeLessThanOrEqual(160);
    expect(rendered.body.length).toBeLessThan(2_000);
    expect(rendered.notice.resource.label!.length).toBeLessThanOrEqual(80);
    for (const line of rendered.body.split("\n")) expect(line.length).toBeLessThanOrEqual(600);
  });

  test("reads the newest assistant text from a projection page", () => {
    expect(
      lastAssistantText([
        { role: "assistant", content: "older" },
        { role: "user", content: "question" },
        { role: "assistant", content: "", parts: [{ type: "text", content: "newest\nanswer" }] },
        { role: "assistant", content: "", parts: [{ type: "tool-invocation" }] },
      ]),
    ).toBe("newest answer");
    expect(lastAssistantText(undefined)).toBeUndefined();
    expect(lastAssistantText([{ role: "assistant", content: "x".repeat(2_000) }])!.length).toBe(
      400,
    );
  });
});

describe("waiting blockers", () => {
  test("pending interactions name an approval, a question or both", () => {
    expect(waitingBlocker(undefined)).toBeUndefined();
    expect(waitingBlocker([])).toBeUndefined();
    expect(waitingBlocker([{ kind: "command-approval", state: "pending" }])).toBe("approval");
    expect(waitingBlocker([{ kind: "plan-approval", state: "answering" }])).toBe("approval");
    expect(waitingBlocker([{ kind: "question", state: "pending" }])).toBe("question");
    expect(waitingBlocker([{ kind: "elicitation", state: "pending" }])).toBe("question");
    expect(
      waitingBlocker([
        { kind: "file-approval", state: "pending" },
        { kind: "question", state: "pending" },
      ]),
    ).toBe("approval-and-question");
    // Settled or non-blocking requests are not why the turn waits.
    expect(waitingBlocker([{ kind: "question", state: "resolved" }])).toBeUndefined();
    expect(
      waitingBlocker([{ kind: "permission", state: "pending", blocking: false }]),
    ).toBeUndefined();
    expect(waitingBlocker([null, "x", { kind: 3, state: "pending" }])).toBeUndefined();
  });

  test("the waiting headline follows the blocker and falls back when unknown", () => {
    const delegation = { waiting: { since: "2026-10-25T00:00:00.000Z" } };
    expect(waitingStatus(delegation, "e", "t")!.headline).toBe(
      "is waiting for input or an approval",
    );
    expect(waitingStatus(delegation, "e", "t", undefined, "approval")!.headline).toBe(
      "is waiting for an approval",
    );
    const question = waitingStatus(delegation, "e", "t", undefined, "question")!;
    expect(question.headline).toBe("is waiting for an answer to a question");
    expect(question.details[0]).toContain("cannot answer on its behalf");
    // It may propose an answer the user confirms; approvals get no such hint.
    expect(question.details[1]).toContain("answer_worker_question");
    expect(question.details[1]).toContain("only their approval answers the worker");
    expect(
      waitingStatus(delegation, "e", "t", undefined, "approval")!.details.join(" "),
    ).not.toContain("answer_worker_question");
    const combined = waitingStatus(delegation, "e", "t", undefined, "approval-and-question")!;
    expect(combined.headline).toBe("is waiting for an approval and an answer to a question");
    expect(combined.details[0]).toContain("cannot approve or answer on its behalf");
    expect(combined.details[1]).toContain("Approvals stay with the person in the worker's tab");
    // The key is the episode, never the blocker: a later read cannot resend it.
    expect(waitingStatus(delegation, "e", "t", undefined, "question")!.key).toBe(
      waitingStatus(delegation, "e", "t")!.key,
    );
  });
});
