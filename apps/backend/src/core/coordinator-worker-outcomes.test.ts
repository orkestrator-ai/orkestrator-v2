/**
 * Worker outcome wakes on the real mail world: a coordinator hears once when
 * a worker it launched, delegated to or built with a pipeline is merged,
 * closed or deleted, whoever did it, and never twice for one outcome (a PR
 * follow that reports the merge itself, several delegations to one worker,
 * a restart). Storage, routes, budgets and the injection drain are
 * production code; only the agents, the PR monitor, the clock and the timers
 * are simulated.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { AgentMessagingSettings } from "@orkestrator/protocol/agent-mail";
import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import { prReadingFrom, WORKER_OUTCOME_AWARENESS } from "./coordinator-pr-status.js";
import type { CoordinatorRemoteAccess, RemotePullRequestReading } from "./coordinator-remote.js";
import {
  COORDINATOR_STATUS_COALESCE_MS,
  type CoordinatorStatusWakeTimers,
} from "./coordinator-status-wakes.js";
import { workerOutcomeNotice } from "./coordinator-worker-outcomes.js";
import type { Environment } from "./models.js";

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
}

const PR_URL = "https://github.com/org/repo/pull/9";

let world: MailWorld | null = null;
let timers: ManualTimers;

afterEach(async () => {
  await world?.close();
  world = null;
  setSystemTime();
});

async function createWorld(settings: Partial<AgentMessagingSettings> = {}): Promise<MailWorld> {
  timers = new ManualTimers();
  world = await MailWorld.create({
    statusWakes: {
      timers,
      workerActivity: async () => "idle",
      lastAssistantExcerpt: async () => undefined,
      waitingBlocker: async () => undefined,
    },
  });
  if (Object.keys(settings).length > 0) {
    const config = await world.storage.loadConfig();
    await world.storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, ...settings },
    });
  }
  return world;
}

async function settle(current: MailWorld): Promise<void> {
  await current.coordinator.reconcileWorkflowNotifications();
  await current.deliver();
  await current.coordinator.statusWakes.settled();
  timers.advance(COORDINATOR_STATUS_COALESCE_MS + 1);
  await current.deliver();
}

/** A delegation (launch or prompt) the coordinator made to this worker, already answered. */
async function delegated(current: MailWorld, worker: MailActor, requestId: string) {
  const main = await current.main();
  await current.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: `delegation-${requestId}`,
    projectId: current.projectId,
    coordinatorId: current.coordinatorId,
    conversationId: main.conversationId!,
    kind: "environment",
    resourceId: worker.environmentId,
    requestId,
    createdAt: new Date(timers.now()).toISOString(),
  });
}

/** What `deleteEnvironment` does to the coordinator's records, then the deletion. */
async function deleteWorker(current: MailWorld, worker: MailActor): Promise<void> {
  const last = (await current.storage.getEnvironment(worker.environmentId)) as Environment;
  await current.coordinator.statusWakes.captureFinalPullRequest(last);
  await current.storage.removeEnvironment(worker.environmentId);
}

function states(current: MailWorld, actor: MailActor): Array<string | undefined> {
  return current.carriers(actor).flatMap((turn) => turn.map((carrier) => carrier.notice?.state));
}

describe("worker outcome wakes", () => {
  test("a PR the user raised on a launched worker wakes the coordinator once when it merges", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("feature-env");
    await delegated(current, worker, "launch-feature");
    await settle(current);

    // The user raises a PR in the UI: an open PR is not an outcome.
    await current.storage.updateEnvironment(worker.environmentId, {
      prUrl: PR_URL,
      prState: "open",
    });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);

    await current.storage.updateEnvironment(worker.environmentId, { prState: "merged" });
    await settle(current);
    expect(states(current, coordinator)).toEqual(["pr-merged"]);
    const [merged] = current.carriers(coordinator)[0]!;
    expect(merged).toMatchObject({
      notice: {
        resource: { kind: "pull-request", id: worker.environmentId, label: "feature-env" },
        tone: "success",
      },
    });
    expect(merged!.subject).toBe("Pull request feature-env was merged");
    expect(merged!.body).toContain(`Pull request: ${PR_URL}`);
    expect(merged!.body).toContain(WORKER_OUTCOME_AWARENESS);
    await current.finishTurn(coordinator);

    // Merged ends the watch: a later deletion and a restart are not news again.
    await deleteWorker(current, worker);
    await settle(current);
    await current.restart();
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);
  });

  test("Merge and Cleanup on a pipeline's worker is one notice naming both", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("pipeline-env");
    await current.storage.saveBuildPipeline(
      "pipeline-1",
      current.projectId,
      worker.environmentId,
      1,
      {
        id: "pipeline-1",
        environmentId: worker.environmentId,
        projectId: current.projectId,
        phase: "complete",
      },
    );
    const main = await current.main();
    await current.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "association-pipeline-1",
      projectId: current.projectId,
      coordinatorId: current.coordinatorId,
      conversationId: main.conversationId!,
      kind: "build-pipeline",
      resourceId: "pipeline-1",
      requestId: "request-pipeline-1",
      createdAt: new Date(timers.now()).toISOString(),
      // The completion notice went out before this watch existed.
      statusNotice: { key: "complete", notifiedAt: new Date(timers.now()).toISOString() },
      terminalNotifiedAt: new Date(timers.now()).toISOString(),
    });
    await current.storage.updateEnvironment(worker.environmentId, {
      prUrl: PR_URL,
      prState: "open",
    });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);

    // The merge write and the deletion land before any observation runs.
    await current.storage.updateEnvironment(worker.environmentId, { prState: "merged" });
    await deleteWorker(current, worker);
    await settle(current);
    await current.restart();
    await settle(current);

    expect(states(current, coordinator)).toEqual(["pr-merged"]);
    expect(current.carriers(coordinator)[0]![0]!.subject).toBe(
      "Pull request pipeline-env was merged and its environment deleted",
    );
  });

  test("deleting a worker whose PR is still open says so, once", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("open-env");
    await delegated(current, worker, "launch-open");
    // Two later prompts to the same worker: still one watch.
    await delegated(current, worker, "prompt-open-1");
    await delegated(current, worker, "prompt-open-2");
    await current.storage.updateEnvironment(worker.environmentId, {
      prUrl: PR_URL,
      prState: "open",
    });
    await settle(current);

    await deleteWorker(current, worker);
    await settle(current);
    await current.restart();
    await settle(current);

    expect(states(current, coordinator)).toEqual(["deleted"]);
    const [deleted] = current.carriers(coordinator)[0]!;
    expect(deleted).toMatchObject({
      notice: { resource: { kind: "environment", id: worker.environmentId, label: "open-env" } },
    });
    expect(deleted!.subject).toBe("Environment open-env was deleted");
    expect(deleted!.body).toContain(`Its pull request was open when it was deleted: ${PR_URL}`);
    expect(deleted!.body).toContain(WORKER_OUTCOME_AWARENESS);
  });

  test("a merge a PR follow reports is not reported a second time", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("followed-env");
    await delegated(current, worker, "launch-followed");
    const main = await current.main();
    await current.storage.coordinators.followCoordinatorPullRequest({
      projectId: current.projectId,
      coordinatorId: current.coordinatorId,
      conversationId: main.conversationId!,
      environmentId: worker.environmentId,
      requestId: "pr-follow:create-pr",
      source: "create-pr",
    });
    await current.storage.updateEnvironment(worker.environmentId, {
      prUrl: PR_URL,
      prState: "open",
    });
    await settle(current);
    await current.finishTurn(coordinator);

    await current.storage.updateEnvironment(worker.environmentId, { prState: "merged" });
    await settle(current);
    await current.restart();
    await settle(current);
    expect(states(current, coordinator)).toEqual(["pr-opened", "pr-merged"]);
  });

  test("an outcome reached before the worker was ever watched is old news", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const merged = await current.addEnvironment("merged-env");
    await current.storage.updateEnvironment(merged.environmentId, {
      prUrl: PR_URL,
      prState: "merged",
    });
    const gone = await current.addEnvironment("gone-env");
    await current.storage.removeEnvironment(gone.environmentId);
    await delegated(current, merged, "launch-merged");
    await delegated(current, gone, "launch-gone");

    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
    const watches = (
      await current.storage.coordinators.listCoordinatorWorkflowAssociations(current.projectId)
    ).map((association) => association.workerOutcome?.ended);
    expect(watches).toEqual([
      expect.objectContaining({ notified: false }),
      expect.objectContaining({ key: "deleted", notified: false }),
    ]);
  });

  test("a worker on another node that disappears there is reported as deleted on that node", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    let leaf: RemotePullRequestReading | null | "unavailable" = {
      reading: prReadingFrom({ prUrl: PR_URL, prState: "open" }),
      name: "remote-env",
    };
    current.coordinator.statusWakes.setRemoteAccess({
      pullRequestReading: async () => leaf,
      nodeName: async () => "Build node",
      workflow: async () => "unavailable",
    } as unknown as CoordinatorRemoteAccess);
    const main = await current.main();
    await current.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "delegation-remote",
      projectId: current.projectId,
      coordinatorId: current.coordinatorId,
      conversationId: main.conversationId!,
      kind: "environment",
      resourceId: "env-remote",
      nodeId: "bk_leaf",
      requestId: "launch-remote",
      createdAt: new Date(timers.now()).toISOString(),
    });
    await settle(current);
    // An unreachable node is no news.
    leaf = "unavailable";
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);

    leaf = null;
    await settle(current);
    await settle(current);
    expect(states(current, coordinator)).toEqual(["deleted"]);
    const [deleted] = current.carriers(coordinator)[0]!;
    expect(deleted!.subject).toBe("Environment remote-env on Build node was deleted");
    expect(deleted!.body).toContain("Runs on Build node (nodeId bk_leaf).");
    expect(deleted!.body).toContain(`Its pull request was open when it was deleted: ${PR_URL}`);
  });

  test("a pipeline that has not named its worker yet is asked again, not dropped", async () => {
    const current = await createWorld();
    const worker = await current.addEnvironment("late-env");
    const save = (snapshot: Record<string, unknown>) =>
      current.storage.saveBuildPipeline(
        "pipeline-late",
        current.projectId,
        worker.environmentId,
        1,
        {
          id: "pipeline-late",
          projectId: current.projectId,
          phase: "building",
          ...snapshot,
        },
      );
    await save({});
    const main = await current.main();
    await current.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "association-pipeline-late",
      projectId: current.projectId,
      coordinatorId: current.coordinatorId,
      conversationId: main.conversationId!,
      kind: "build-pipeline",
      resourceId: "pipeline-late",
      requestId: "request-pipeline-late",
      createdAt: new Date(timers.now()).toISOString(),
    });
    const watch = async () =>
      (
        await current.storage.coordinators.listCoordinatorWorkflowAssociations(current.projectId)
      )[0]!.workerOutcome;
    await settle(current);
    expect(await watch()).toBeUndefined();

    await save({ environmentId: worker.environmentId });
    await settle(current);
    expect(await watch()).toMatchObject({
      environmentId: worker.environmentId,
      name: "late-env",
    });
    expect((await watch())?.ended).toBeUndefined();
  });

  test("Finished work only sends no outcome notices", async () => {
    const current = await createWorld({ coordinatorStatusWakes: "off" });
    const coordinator = await current.main();
    const worker = await current.addEnvironment("quiet-env");
    await delegated(current, worker, "launch-quiet");
    await current.storage.updateEnvironment(worker.environmentId, {
      prUrl: PR_URL,
      prState: "open",
    });
    await settle(current);
    await current.storage.updateEnvironment(worker.environmentId, { prState: "merged" });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
  });
});

describe("workerOutcomeNotice", () => {
  const base = { gone: false, deleting: false, prUrl: PR_URL, prState: "open" as const };

  test("an open PR, or a deletion still running, is no outcome yet", () => {
    expect(workerOutcomeNotice("env", base)).toBeNull();
    expect(workerOutcomeNotice("env", { ...base, deleting: true })).toBeNull();
    expect(workerOutcomeNotice("env", { ...base, prUrl: null, prState: null })).toBeNull();
  });

  test("a close says it was not merged; a deletion without a PR says there was none", () => {
    const closed = workerOutcomeNotice("env", { ...base, prState: "closed" });
    expect(closed?.notice.status).toMatchObject({
      state: "pr-closed",
      headline: "was closed without merging",
    });
    const deleted = workerOutcomeNotice("env", {
      gone: true,
      deleting: true,
      prUrl: null,
      prState: null,
    });
    expect(deleted?.key).toBe("deleted");
    expect(deleted?.notice.status.details[0]).toBe("It had no pull request when it was deleted.");
    expect(deleted?.notice.status.tools).toEqual(["list_workflows {}"]);
  });
});
