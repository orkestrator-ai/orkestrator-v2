/**
 * Pull request status wakes on the real mail world: a coordinator that raised
 * a pull request (`create_pr`), ran `resolve_conflicts` on it, or launched the
 * review whose auto-PR opened it hears once per state change, and nothing
 * about a PR the user raised. Storage, routes, budgets and the injection drain
 * are production code; only the agents, the PR monitor, the clock and the
 * timers are simulated.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import type { AgentMessagingSettings } from "@orkestrator/protocol/agent-mail";
import type { CoordinatorPullRequestFollow } from "@orkestrator/protocol/coordinator";
import type { PrCheckSummary } from "@orkestrator/protocol/pr-monitor";
import { MailWorld, type MailActor } from "./agent-mail-world-test-support.js";
import type { CoordinatorPrHealth } from "./coordinator-pr-status.js";
import {
  COORDINATOR_RESOLVE_REFRESH_WAIT_MS,
  COORDINATOR_RESOLVE_START_GRACE_MS,
  COORDINATOR_STATUS_COALESCE_MS,
  CoordinatorStatusWakes,
  type CoordinatorStatusWakeTimers,
} from "./coordinator-status-wakes.js";
import type { StorageService } from "./storage.js";
import { multiReviewFixIdentity } from "./multi-review-fix-identity.js";
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

  count(): number {
    return this.due.length;
  }
}

const PR_URL = "https://github.com/org/repo/pull/7";

let world: MailWorld | null = null;
let timers: ManualTimers;
/** What this node's PR monitor has announced, per environment. */
let health: Map<string, CoordinatorPrHealth>;
let activity: Map<string, AgentActivityState | "unknown">;

afterEach(async () => {
  await world?.close();
  world = null;
  setSystemTime();
});

async function createWorld(settings: Partial<AgentMessagingSettings> = {}): Promise<MailWorld> {
  timers = new ManualTimers();
  health = new Map();
  activity = new Map();
  world = await MailWorld.create({
    statusWakes: {
      timers,
      workerActivity: async (environmentId, tabId) =>
        activity.get(`${environmentId}:${tabId}`) ?? "unknown",
      lastAssistantExcerpt: async () => undefined,
      waitingBlocker: async () => undefined,
      prMonitorHealth: (environment: Environment) => health.get(environment.id) ?? {},
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

async function follow(
  current: MailWorld,
  worker: MailActor,
  source: CoordinatorPullRequestFollow["source"],
  extra: {
    prUrl?: string;
    resolve?: { tabId: string; requestedAt: string };
    publication?: { tabId: string; requestedAt: string };
  } = {},
  requestId = `pr-follow:${source}`,
) {
  const main = await current.main();
  return current.storage.coordinators.followCoordinatorPullRequest({
    projectId: current.projectId,
    coordinatorId: current.coordinatorId,
    conversationId: main.conversationId!,
    environmentId: worker.environmentId,
    requestId,
    source,
    ...extra,
  });
}

/** The PR monitor's reading: the environment record plus its announced health. */
async function monitor(
  current: MailWorld,
  worker: MailActor,
  record: Partial<Environment>,
  monitorHealth: { confirmed?: boolean; checks?: PrCheckSummary } = {},
): Promise<void> {
  await current.storage.updateEnvironment(worker.environmentId, record);
  health.set(worker.environmentId, {
    ...(monitorHealth.confirmed ? { prMonitorConfirmed: true } : {}),
    ...(monitorHealth.checks ? { prCheckSummary: monitorHealth.checks } : {}),
    lastSuccessfulCheckAt: new Date(timers.now()).toISOString(),
  });
}

function states(current: MailWorld, actor: MailActor): Array<string | undefined> {
  return current.carriers(actor).flatMap((turn) => turn.map((carrier) => carrier.notice?.state));
}

async function followOf(current: MailWorld, worker: MailActor) {
  return (
    await current.storage.coordinators.listCoordinatorWorkflowAssociations(current.projectId)
  ).find((item) => item.kind === "pull-request" && item.resourceId === worker.environmentId);
}

describe("followed-worker filter", () => {
  test("a follow noted while a sweep reads the store is not dropped from the event filter", async () => {
    timers = new ManualTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const storage = {
      coordinators: {
        getCoordinatorReconciliationState: async () => {
          reads += 1;
          if (reads === 1) await gate;
          return { workspaces: [], workflows: [] };
        },
      },
      loadConfig: async () => ({ global: {} }),
      addResourceChangeListener: () => () => undefined,
    } as unknown as StorageService;
    const wakes = new CoordinatorStatusWakes(storage, { timers });
    const sweep = wakes.reconcile();
    while (reads === 0) await new Promise((resolve) => setImmediate(resolve));
    // create_pr writes its follow and notes it while the sweep's read is in flight.
    wakes.notePullRequestFollowed("env-new");
    release();
    await sweep;
    // Forget the note's own debounce; the filter (`followed`) is what is under test.
    wakes.stop();
    expect(timers.count()).toBe(0);
    wakes.notePullRequestChange("env-new");
    expect(timers.count()).toBe(1);
    // A worker nobody follows still costs nothing.
    wakes.notePullRequestChange("env-other");
    expect(timers.count()).toBe(1);
  });
});

describe("pull request status wakes", () => {
  test("a PR raised with create_pr wakes once per state change, until it merges", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("pr-env");
    await follow(current, worker, "create-pr");

    // The PR tab is still working: no pull request, no news.
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);

    await monitor(current, worker, { prUrl: PR_URL, prState: "open", hasMergeConflicts: null });
    await settle(current);
    expect(states(current, coordinator)).toEqual(["pr-opened"]);
    const [opened] = current.carriers(coordinator)[0]!;
    expect(opened).toMatchObject({
      kind: "notice",
      notice: {
        resource: { kind: "pull-request", id: worker.environmentId, label: "pr-env" },
        state: "pr-opened",
        tone: "success",
      },
    });
    expect(opened!.subject).toBe("Pull request pr-env is open");
    expect(opened!.body).toContain(`Pull request: ${PR_URL}`);
    expect(opened!.body).toContain(
      `get_environment { "environmentId": "${worker.environmentId}" }`,
    );
    expect((await followOf(current, worker))?.pullRequest?.prUrl).toBe(PR_URL);
    await current.finishTurn(coordinator);

    // The same reading again, however often, is not news.
    await settle(current);
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);

    await monitor(current, worker, { hasMergeConflicts: true, prMergeability: "dirty" });
    await settle(current);
    expect(states(current, coordinator)).toEqual(["pr-opened", "pr-conflicts"]);
    expect(current.received(coordinator)[1]).toContain(
      `resolve_conflicts { "environmentId": "${worker.environmentId}" }`,
    );
    await current.finishTurn(coordinator);

    // Conflicts fixed, checks still running: recorded, not woken.
    await monitor(
      current,
      worker,
      { hasMergeConflicts: false, prMergeability: "blocked" },
      { confirmed: true, checks: { passed: 1, total: 2, pending: 1 } },
    );
    await settle(current);
    expect(current.wakes(coordinator)).toBe(2);

    await monitor(
      current,
      worker,
      { prMergeability: "blocked" },
      { confirmed: true, checks: { passed: 1, total: 2, pending: 0 } },
    );
    await settle(current);
    expect(states(current, coordinator).at(-1)).toBe("pr-checks-failed");
    expect(current.received(coordinator)[2]).toContain("1 failed");
    await current.finishTurn(coordinator);

    await monitor(
      current,
      worker,
      { prMergeability: "clean" },
      { confirmed: true, checks: { passed: 2, total: 2, pending: 0 } },
    );
    await settle(current);
    expect(states(current, coordinator).at(-1)).toBe("pr-ready");
    expect(current.received(coordinator)[3]).toContain("never merges");
    await current.finishTurn(coordinator);

    await monitor(current, worker, { prState: "merged" }, { confirmed: true });
    await settle(current);
    expect(states(current, coordinator)).toEqual([
      "pr-opened",
      "pr-conflicts",
      "pr-checks-failed",
      "pr-ready",
      "pr-merged",
    ]);
    expect((await followOf(current, worker))?.terminalNotifiedAt).toBeDefined();
    await current.finishTurn(coordinator);
    await current.restart();
    await settle(current);
    expect(current.wakes(coordinator)).toBe(5);
  });

  test("a state that recurs after a fix wakes again; re-observing one episode does not", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("pr-env");
    await follow(current, worker, "create-pr");
    await monitor(current, worker, { prUrl: PR_URL, prState: "open", hasMergeConflicts: null });
    await settle(current);
    await current.finishTurn(coordinator);
    const conflicts = () =>
      monitor(current, worker, { hasMergeConflicts: true, prMergeability: "dirty" });
    const quiet = () =>
      monitor(
        current,
        worker,
        { hasMergeConflicts: false, prMergeability: "blocked" },
        { confirmed: true, checks: { passed: 1, total: 2, pending: 1 } },
      );
    const failing = () =>
      monitor(
        current,
        worker,
        { hasMergeConflicts: false, prMergeability: "blocked" },
        { confirmed: true, checks: { passed: 1, total: 2, pending: 0 } },
      );
    /** One state change, then the same episode seen again by a restarted backend. */
    const step = async (change: () => Promise<void>) => {
      await change();
      await settle(current);
      await current.finishTurn(coordinator);
      await current.restart();
      await settle(current);
      await settle(current);
    };
    await step(conflicts);
    await step(quiet);
    await step(conflicts);
    await step(quiet);
    await step(failing);
    await step(quiet);
    await step(failing);
    expect(states(current, coordinator)).toEqual([
      "pr-opened",
      "pr-conflicts",
      "pr-conflicts",
      "pr-checks-failed",
      "pr-checks-failed",
    ]);
    expect(current.wakes(coordinator)).toBe(5);
    // Eight recorded states (opened, then seven changes, quiet ones included).
    expect((await followOf(current, worker))?.pullRequest?.notices).toBe(8);
  });

  test("Merge and Cleanup: a merge recorded just before the worker is deleted still wakes once", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("pr-env");
    const gone = await current.addEnvironment("gone-env");
    await follow(current, worker, "create-pr");
    await follow(current, gone, "create-pr", {}, "pr-follow:gone");
    for (const actor of [worker, gone])
      await monitor(current, actor, { prUrl: PR_URL, prState: "open", hasMergeConflicts: null });
    await settle(current);
    await current.finishTurn(coordinator);
    expect(current.wakes(coordinator)).toBe(1);

    // The merge write and the deletion land before any observation runs.
    await current.storage.updateEnvironment(worker.environmentId, { prState: "merged" });
    await current.coordinator.statusWakes.captureFinalPullRequest(
      (await current.storage.getEnvironment(worker.environmentId))!,
    );
    await current.storage.removeEnvironment(worker.environmentId);
    // A worker deleted with its PR still open is simply no longer followed.
    await current.coordinator.statusWakes.captureFinalPullRequest(
      (await current.storage.getEnvironment(gone.environmentId))!,
    );
    await current.storage.removeEnvironment(gone.environmentId);
    await settle(current);
    await current.restart();
    await settle(current);

    expect(states(current, coordinator).slice(-1)).toEqual(["pr-merged"]);
    expect(current.wakes(coordinator)).toBe(2);
    const [merged] = current.carriers(coordinator)[1]!;
    expect(merged!.subject).toBe("Pull request pr-env was merged");
    for (const actor of [worker, gone])
      expect((await followOf(current, actor))?.terminalNotifiedAt).toBeDefined();
  });

  test("a PR the user raised has no follow and wakes nobody", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("user-pr");
    await monitor(current, worker, { prUrl: PR_URL, prState: "open", hasMergeConflicts: true });
    await settle(current);
    await monitor(current, worker, { prState: "merged" });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
  });

  test("Finished work only sends no PR wakes, and still ends a merged follow", async () => {
    const current = await createWorld({ coordinatorStatusWakes: "off" });
    const coordinator = await current.main();
    const worker = await current.addEnvironment("pr-env");
    await follow(current, worker, "create-pr");
    await monitor(current, worker, { prUrl: PR_URL, prState: "open", hasMergeConflicts: true });
    await settle(current);
    await monitor(current, worker, { prState: "merged" });
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
    expect((await followOf(current, worker))?.terminalNotifiedAt).toBeDefined();
  });

  test("a finished Resolve tab wakes once, after the PR monitor's recheck, with its state", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("pr-env");
    await monitor(
      current,
      worker,
      {
        prUrl: PR_URL,
        prState: "open",
        hasMergeConflicts: true,
        prMergeability: "dirty",
        prRecheckAfterAgentCompletionArmedAt: new Date(timers.now()).toISOString(),
      },
      { confirmed: true },
    );
    const tab = "agent-job-resolve";
    await follow(current, worker, "resolve-conflicts", {
      prUrl: PR_URL,
      resolve: { tabId: tab, requestedAt: new Date(timers.now()).toISOString() },
    });
    activity.set(`${worker.environmentId}:${tab}`, "working");
    // While the Resolve tab runs, the conflict it is fixing is not news.
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
    expect((await followOf(current, worker))?.pullRequest?.resolve?.seenWorkingAt).toBeDefined();

    // The turn ended; the monitor has not rechecked yet, so the report waits.
    activity.set(`${worker.environmentId}:${tab}`, "idle");
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
    expect((await followOf(current, worker))?.pullRequest?.resolve?.finishedAt).toBeDefined();

    // The recheck lands: no conflicts, the refresh disarmed, checks green.
    await monitor(
      current,
      worker,
      {
        hasMergeConflicts: false,
        prMergeability: "clean",
        prRecheckAfterAgentCompletionArmedAt: undefined,
      },
      { confirmed: true, checks: { passed: 4, total: 4, pending: 0 } },
    );
    await settle(current);
    expect(states(current, coordinator)).toEqual(["resolve-finished"]);
    const [report] = current.carriers(coordinator)[0]!;
    expect(report!.subject).toBe(
      "Pull request pr-env Resolve tab finished; the pull request is ready to merge",
    );
    expect(report!.body).toContain(
      `get_tab_transcript { "environmentId": "${worker.environmentId}", "tabId": "${tab}" }`,
    );
    expect(report!.body).not.toContain("had not rechecked");
    await current.finishTurn(coordinator);

    // The report already said "ready": the same state is not sent again.
    await settle(current);
    await current.restart();
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);
    expect((await followOf(current, worker))?.pullRequest?.resolve?.notifiedAt).toBeDefined();
  });

  test("a Resolve tab whose recheck never lands reports the last reading after the bounded wait", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("pr-env");
    await monitor(current, worker, {
      prUrl: PR_URL,
      prState: "open",
      hasMergeConflicts: true,
      prRecheckAfterAgentCompletionArmedAt: new Date(timers.now()).toISOString(),
    });
    const tab = "agent-job-resolve";
    await follow(current, worker, "resolve-conflicts", {
      prUrl: PR_URL,
      resolve: { tabId: tab, requestedAt: new Date(timers.now()).toISOString() },
    });
    activity.set(`${worker.environmentId}:${tab}`, "working");
    await settle(current);
    activity.set(`${worker.environmentId}:${tab}`, "idle");
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);

    // A stale monitor: its last answer predates the turn's end.
    health.set(worker.environmentId, { lastSuccessfulCheckAt: new Date(0).toISOString() });
    timers.advance(COORDINATOR_RESOLVE_REFRESH_WAIT_MS);
    await current.coordinator.statusWakes.settled();
    await settle(current);
    expect(states(current, coordinator)).toEqual(["resolve-finished"]);
    expect(current.received(coordinator)[0]).toContain("still conflicts");
    expect(current.received(coordinator)[0]).toContain("had not rechecked");
  });

  test("a Resolve turn too short to see is reported after the start grace", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("pr-env");
    await monitor(
      current,
      worker,
      { prUrl: PR_URL, prState: "open", hasMergeConflicts: false, prMergeability: "blocked" },
      { confirmed: true },
    );
    const tab = "agent-job-resolve";
    await follow(current, worker, "resolve-conflicts", {
      prUrl: PR_URL,
      resolve: { tabId: tab, requestedAt: new Date(timers.now()).toISOString() },
    });
    // Idle from the first look: it may not have started yet.
    activity.set(`${worker.environmentId}:${tab}`, "idle");
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
    timers.advance(COORDINATOR_RESOLVE_START_GRACE_MS);
    await current.coordinator.statusWakes.settled();
    await settle(current);
    expect(states(current, coordinator)).toEqual(["resolve-finished"]);
    expect(current.received(coordinator)[0]).toContain("no longer reports conflicts");
  });

  test("a review joining a create_pr follow is found by its own request; one of them reports", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("review-env");
    const fix = { sessionKey: "fix", startedAt: "2026-10-16T10:10:00Z", status: "idle" };
    await current.storage.saveMultiReviewWorkflow("review-1", worker.environmentId, 1, {
      id: "review-1",
      environmentId: worker.environmentId,
      projectId: current.projectId,
      reviewers: [],
      autoPr: true,
      phase: "interactive",
      fixSession: fix,
      autoPrLaunch: {
        state: "launched",
        requestId: "pr",
        tabId: "pr-tab",
        fixIdentity: multiReviewFixIdentity(fix),
      },
    });
    const main = await current.main();
    await current.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "association-review-1",
      projectId: current.projectId,
      coordinatorId: current.coordinatorId,
      conversationId: main.conversationId!,
      kind: "multi-review",
      resourceId: "review-1",
      requestId: "request-review-1",
      createdAt: new Date().toISOString(),
    });
    // The coordinator also called create_pr, so a follow already exists.
    await follow(current, worker, "create-pr");
    await monitor(current, worker, { prUrl: PR_URL, prState: "open", hasMergeConflicts: null });
    await settle(current);
    const joined = await followOf(current, worker);
    expect(joined?.requestId).toBe("pr-follow:create-pr");
    expect(joined?.requestAliases?.map((alias) => alias.requestId)).toContain(
      "pr-follow:review:association-review-1",
    );
    expect(joined?.pullRequest?.reviewAssociationId).toBe("association-review-1");
    await current.finishTurn(coordinator);
    await monitor(current, worker, { hasMergeConflicts: true, prMergeability: "dirty" });
    await settle(current);
    await current.finishTurn(coordinator);
    await monitor(current, worker, { prState: "closed" });
    await settle(current);
    await settle(current);
    // The review's pr-opened is not repeated by the follow, and its pr-closed
    // is left to the follow: each state is heard once.
    expect(states(current, coordinator)).toEqual(["pr-opened", "pr-conflicts", "pr-closed"]);
    const follows = (
      await current.storage.coordinators.listCoordinatorWorkflowAssociations(current.projectId)
    ).filter((item) => item.kind === "pull-request");
    expect(follows).toHaveLength(1);
  });

  test("a review's auto-PR is followed after its pr-opened, without repeating it", async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("review-env");
    const fix = { sessionKey: "fix", startedAt: "2026-10-16T10:10:00Z", status: "idle" };
    await current.storage.saveMultiReviewWorkflow("review-1", worker.environmentId, 1, {
      id: "review-1",
      environmentId: worker.environmentId,
      projectId: current.projectId,
      reviewers: [],
      autoPr: true,
      phase: "interactive",
      fixSession: fix,
      autoPrLaunch: {
        state: "launched",
        requestId: "pr",
        tabId: "pr-tab",
        fixIdentity: multiReviewFixIdentity(fix),
      },
    });
    const main = await current.main();
    await current.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "association-review-1",
      projectId: current.projectId,
      coordinatorId: current.coordinatorId,
      conversationId: main.conversationId!,
      kind: "multi-review",
      resourceId: "review-1",
      requestId: "request-review-1",
      createdAt: new Date().toISOString(),
    });
    await monitor(current, worker, { prUrl: PR_URL, prState: "open", hasMergeConflicts: null });
    await settle(current);
    expect(states(current, coordinator)).toEqual(["pr-opened"]);
    expect(current.carriers(coordinator)[0]![0]!.notice?.resource.kind).toBe("multi-review");
    const followed = await followOf(current, worker);
    expect(followed?.pullRequest).toMatchObject({
      source: "multi-review",
      prUrl: PR_URL,
      reviewAssociationId: "association-review-1",
    });
    await current.finishTurn(coordinator);
    await settle(current);
    expect(current.wakes(coordinator)).toBe(1);

    // Later changes come from the follow, once each; the review stays quiet.
    await monitor(current, worker, { hasMergeConflicts: true, prMergeability: "dirty" });
    await settle(current);
    await current.finishTurn(coordinator);
    await monitor(current, worker, { prState: "closed" });
    await settle(current);
    expect(states(current, coordinator)).toEqual(["pr-opened", "pr-conflicts", "pr-closed"]);
    expect(
      current
        .carriers(coordinator)
        .slice(1)
        .flat()
        .map((carrier) => carrier.notice?.resource.kind),
    ).toEqual(["pull-request", "pull-request"]);
  });
});

for (const ending of ["idle", "unknown"] as const) {
  test(`a PR tab ending ${ending} without a URL reports once across restart`, async () => {
    const current = await createWorld();
    const coordinator = await current.main();
    const worker = await current.addEnvironment("failed-pr");
    const tabId = "pr-tab";
    await follow(current, worker, "create-pr", {
      publication: { tabId, requestedAt: new Date(timers.now()).toISOString() },
    });
    activity.set(`${worker.environmentId}:${tabId}`, "working");
    await settle(current);
    expect(current.wakes(coordinator)).toBe(0);
    activity.set(`${worker.environmentId}:${tabId}`, ending);
    await current.restart();
    await settle(current);
    await settle(current);
    await current.restart();
    await settle(current);
    expect(states(current, coordinator)).toEqual(["pr-not-created"]);
    expect(current.received(coordinator)[0]).toContain("get_tab_transcript");
    expect((await followOf(current, worker))?.terminalNotifiedAt).toBeDefined();
  });
}

test("a queued Resolve remains pending beyond the start grace", async () => {
  const current = await createWorld();
  const coordinator = await current.main();
  const worker = await current.addEnvironment("queued-resolve");
  await monitor(current, worker, { prUrl: PR_URL, prState: "open", hasMergeConflicts: true });
  const tabId = "slow-resolve";
  const association = await follow(current, worker, "resolve-conflicts", {
    resolve: { tabId, requestedAt: new Date(timers.now()).toISOString() },
  });
  await current.storage.coordinators.updateCoordinatorWorkflowAssociation(
    association.id,
    (item) => {
      item.nodeId = "bk_leaf";
      return true;
    },
  );
  let pending = true;
  let tab: "idle" | "working" = "idle";
  current.coordinator.setRemoteAccess({
    workerState: async () => ({ environment: "running", tab, requestPending: pending }),
    pullRequestReading: async () => ({
      reading: {
        prUrl: PR_URL,
        prState: "open",
        hasMergeConflicts: true,
        mergeability: "dirty",
        checkSummary: null,
        viewerCanMerge: null,
        confirmed: true,
        recheckArmed: false,
      },
    }),
    nodeName: async () => "Leaf",
    environmentPr: async () => ({}),
    workflow: async () => null,
    lastAssistantExcerpt: async () => undefined,
  });
  timers.advance(COORDINATOR_RESOLVE_START_GRACE_MS * 2);
  await settle(current);
  expect(current.wakes(coordinator)).toBe(0);
  expect((await followOf(current, worker))?.pullRequest?.resolve?.finishedAt).toBeUndefined();
  pending = false;
  tab = "working";
  await settle(current);
  expect(current.wakes(coordinator)).toBe(0);
  tab = "idle";
  await settle(current);
  expect(states(current, coordinator)).toEqual(["resolve-finished"]);
});
