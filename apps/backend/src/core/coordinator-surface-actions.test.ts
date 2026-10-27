import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type {
  MultiReviewActionResult,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { CoordinatorService } from "./coordinator-service.js";
import { runCommand } from "./shell.js";
import { StorageService, createEnvironment, createProject } from "./storage.js";

let root: string;
let storage: StorageService;
let context: CommandContext;
let commands: Map<string, CommandHandler>;
let scope: { projectId: string; coordinatorId: string; conversationId: string };
let workerId: string;
let homeId: string;

const call = <T = Record<string, unknown>>(command: string, args: Record<string, unknown>) =>
  commands.get(command)!({ scope, ...args }, context) as Promise<T>;

async function saveLayout(
  tabs: Array<Record<string, unknown>>,
  second?: Array<Record<string, unknown>>,
) {
  const previous = await storage.getPaneLayout(workerId);
  await storage.savePaneLayout(
    workerId,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "left",
      root: second
        ? {
            kind: "split",
            id: "split",
            direction: "horizontal",
            sizes: [50, 50],
            children: [
              { kind: "leaf", id: "left", tabs, activeTabId: (tabs[0]?.id as string) ?? null },
              {
                kind: "leaf",
                id: "right",
                tabs: second,
                activeTabId: (second[0]?.id as string) ?? null,
              },
            ],
          }
        : { kind: "leaf", id: "left", tabs, activeTabId: (tabs[0]?.id as string) ?? null },
    },
    previous?.revision ?? 0,
  );
}

async function leaves() {
  const layout = await storage.getPaneLayout(workerId);
  const found: Array<{ id: string; tabs: Array<Record<string, unknown>>; activeTabId: unknown }> =
    [];
  const visit = (node: Record<string, unknown>) => {
    if (node.kind === "leaf") found.push(node as never);
    else for (const child of node.children as Array<Record<string, unknown>>) visit(child);
  };
  visit(layout!.root as Record<string, unknown>);
  return { layout: layout!, leaves: found };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-surface-actions-"));
  const checkout = path.join(root, "checkout");
  await mkdir(checkout);
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
  ])
    await runCommand("git", args, { cwd: checkout });
  await writeFile(path.join(checkout, "README.md"), "fixture\n");
  await runCommand("git", ["add", "."], { cwd: checkout });
  await runCommand("git", ["commit", "-m", "fixture"], { cwd: checkout });
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const project = await storage.addProject(createProject("remote", checkout));
  const coordinator = new CoordinatorService(storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  const snapshot = await coordinator.ensure(project.id);
  scope = {
    projectId: project.id,
    coordinatorId: snapshot.workspace.id,
    conversationId: snapshot.workspace.conversations[0]!.id,
  };
  const worker = createEnvironment(project.id, { name: "worker", environmentType: "local" });
  Object.assign(worker, { status: "running", setupPhase: "ready", worktreePath: checkout });
  await storage.addEnvironment(worker);
  workerId = worker.id;
  const home = createEnvironment(project.id, { name: "project-home", environmentType: "local" });
  Object.assign(home, { status: "running", setupPhase: "ready", projectHome: true });
  await storage.addEnvironment(home);
  homeId = home.id;
  context = { storage, coordinators: coordinator } as CommandContext;
  commands = createCommandRegistry();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("coordinator action receipts", () => {
  test("replay a completed request, refuse a changed payload, and drop a failed one", async () => {
    const input = {
      coordinatorId: scope.coordinatorId,
      projectId: scope.projectId,
      conversationId: scope.conversationId,
      requestId: "r-1",
      action: "launch-terminal" as const,
      payloadHash: "a",
    };
    const first = await storage.coordinators.admitCoordinatorActionReceipt(input);
    expect(first).toMatchObject({ claimed: true, receipt: { state: "pending" } });
    // The same live process still owns it.
    expect((await storage.coordinators.admitCoordinatorActionReceipt(input)).claimed).toBe(false);
    await storage.coordinators.completeCoordinatorActionReceipt(scope.coordinatorId, "r-1", {
      tabId: "t",
    });
    const replay = await storage.coordinators.admitCoordinatorActionReceipt(input);
    expect(replay).toMatchObject({
      claimed: false,
      receipt: { state: "completed", result: { tabId: "t" } },
    });
    await expect(
      storage.coordinators.admitCoordinatorActionReceipt({ ...input, payloadHash: "b" }),
    ).rejects.toThrow("different payload");
    await storage.coordinators.admitCoordinatorActionReceipt({ ...input, requestId: "r-2" });
    await storage.coordinators.releaseCoordinatorActionReceipt(scope.coordinatorId, "r-2");
    expect(
      (
        await storage.coordinators.admitCoordinatorActionReceipt({
          ...input,
          requestId: "r-2",
          payloadHash: "c",
        })
      ).claimed,
    ).toBe(true);
  });

  test("a pending receipt whose owner died is reclaimed by the retry", async () => {
    const input = {
      coordinatorId: scope.coordinatorId,
      projectId: scope.projectId,
      conversationId: scope.conversationId,
      requestId: "orphan",
      action: "open-browser" as const,
      payloadHash: "a",
    };
    await storage.coordinators.admitCoordinatorActionReceipt(input);
    expect((await storage.coordinators.admitCoordinatorActionReceipt(input)).claimed).toBe(false);
    // The process that admitted it is gone (a backend restart).
    const kill = process.kill;
    process.kill = (() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }) as typeof process.kill;
    try {
      expect((await storage.coordinators.admitCoordinatorActionReceipt(input)).claimed).toBe(true);
    } finally {
      process.kill = kill;
    }
  });
});

describe("launch_coordinator_terminal", () => {
  test("runs a command once per requestId in a worker, never the project home", async () => {
    const launch = mock(async (args: Record<string, unknown>) => ({
      jobId: "job",
      environmentId: args.environmentId,
      tabId: "terminal-job-x",
      tabType: args.tabType,
      status: "started",
    }));
    commands.set("launch_terminal_job", launch as unknown as CommandHandler);
    const input = { requestId: "tests", environmentId: workerId, command: "bun test" };
    const first = await call("launch_coordinator_terminal", { input });
    expect(first).toMatchObject({
      environmentId: workerId,
      tabId: "terminal-job-x",
      tabType: "plain",
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0]).toMatchObject({
      environmentId: workerId,
      tabType: "plain",
      data: "bun test\n",
      activateTab: true,
    });
    expect(String(launch.mock.calls[0]![0].requestId)).toStartWith("coordinator:");
    expect(await call("launch_coordinator_terminal", { input })).toMatchObject({ replayed: true });
    expect(launch).toHaveBeenCalledTimes(1);
    await expect(
      call("launch_coordinator_terminal", { input: { ...input, command: "rm -rf ." } }),
    ).rejects.toThrow("different payload");
    await expect(
      call("launch_coordinator_terminal", {
        input: { ...input, requestId: "home", environmentId: homeId },
      }),
    ).rejects.toThrow("project checkout");
    await expect(
      call("launch_coordinator_terminal", { input: { requestId: "x", environmentId: workerId } }),
    ).rejects.toThrow("needs a command");
  });

  test("starts an agent CLI with its prompt", async () => {
    const launch = mock(async (_args: Record<string, unknown>) => ({
      tabId: "t",
      status: "started",
    }));
    commands.set("launch_terminal_job", launch as unknown as CommandHandler);
    await call("launch_coordinator_terminal", {
      input: { requestId: "cli", environmentId: workerId, tabType: "claude", prompt: "hello" },
    });
    const args = launch.mock.calls[0]![0];
    expect(args.tabType).toBe("claude");
    expect(String(args.data)).toStartWith("claude ");
    expect(String(args.data)).toContain("hello");
  });
});

describe("open_coordinator_browser", () => {
  test("opens a worker preview tab, navigates it, and refuses the open web", async () => {
    await expect(
      call("open_coordinator_browser", {
        input: { requestId: "web", environmentId: workerId, url: "https://example.com" },
      }),
    ).rejects.toThrow();
    const opened = await call<{ ui: { tabId: string; paneId: string } }>(
      "open_coordinator_browser",
      {
        input: { requestId: "b-1", environmentId: workerId, url: "http://localhost:3000/" },
      },
    );
    let { leaves: panes } = await leaves();
    const tab = panes[0]!.tabs.find((candidate) => candidate.id === opened.ui.tabId)!;
    expect(tab.type).toBe("browser");
    const data = tab.browserData as Record<string, unknown>;
    expect(String(data.url)).toStartWith("orkestrator-preview://intent/");
    expect(String(data.url)).toContain("agent-link");
    expect(panes[0]!.activeTabId).toBe(opened.ui.tabId);
    // Retrying the same request does not open a second tab.
    await call("open_coordinator_browser", {
      input: { requestId: "b-1", environmentId: workerId, url: "http://localhost:3000/" },
    });
    await call("open_coordinator_browser", {
      input: {
        requestId: "b-2",
        environmentId: workerId,
        url: "http://localhost:3000/settings",
        tabId: opened.ui.tabId,
      },
    });
    ({ leaves: panes } = await leaves());
    expect(panes[0]!.tabs).toHaveLength(1);
    const navigated = panes[0]!.tabs[0]!.browserData as Record<string, unknown>;
    expect(decodeURIComponent(String(navigated.url))).toContain("/settings");
    expect(navigated.navigationRequestId).not.toBe(data.navigationRequestId);
  });
});

describe("edit_coordinator_worker_tab", () => {
  test("focuses, moves and closes tabs, tearing down what the tab owned", async () => {
    await saveLayout(
      [
        { id: "shell", type: "plain", backendTerminalSessionId: "pty-1" },
        { id: "docs", type: "browser", browserData: { url: "" } },
      ],
      [{ id: "notes", type: "file" }],
    );
    const teardown = mock(async () => ({ ok: true }));
    commands.set("teardown_tab", teardown as unknown as CommandHandler);
    const edit = (input: Record<string, unknown>) =>
      call("edit_coordinator_worker_tab", { input: { environmentId: workerId, ...input } });

    expect(await edit({ tabId: "docs", operation: "focus" })).toMatchObject({
      changed: true,
      paneId: "left",
    });
    expect((await leaves()).leaves[0]!.activeTabId).toBe("docs");
    expect(await edit({ tabId: "docs", operation: "move", toPaneId: "right" })).toMatchObject({
      paneId: "right",
      changed: true,
    });
    let state = await leaves();
    expect(state.leaves[1]!.tabs.map((tab) => tab.id)).toEqual(["notes", "docs"]);
    expect(state.layout.activePaneId).toBe("right");
    await expect(edit({ tabId: "docs", operation: "move", toPaneId: "nowhere" })).rejects.toThrow(
      "Pane not found",
    );

    expect(await edit({ tabId: "shell", operation: "close" })).toMatchObject({ changed: true });
    expect(teardown).toHaveBeenCalledWith(
      { environmentId: workerId, tabId: "shell", kind: "terminal", sessionId: "pty-1" },
      context,
    );
    state = await leaves();
    expect(state.leaves[0]!.tabs).toEqual([]);
    // Already gone: a retry is harmless and tears nothing down again.
    expect(await edit({ tabId: "shell", operation: "close" })).toMatchObject({ changed: false });
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  test("refuses to close a tab a coordinator is waiting on, and the project home", async () => {
    await saveLayout([{ id: "agent", type: "plain" }]);
    const association = await storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "assoc",
      ...scope,
      kind: "environment",
      resourceId: workerId,
      requestId: "delegation:job",
      createdAt: new Date().toISOString(),
    });
    await storage.coordinators.openCoordinatorDelegation(association.id, "agent");
    await expect(
      call("edit_coordinator_worker_tab", {
        input: { environmentId: workerId, tabId: "agent", operation: "close" },
      }),
    ).rejects.toThrow("waiting on this tab");
    expect((await leaves()).leaves[0]!.tabs).toHaveLength(1);
    await expect(
      call("edit_coordinator_worker_tab", {
        input: { environmentId: homeId, tabId: "agent", operation: "focus" },
      }),
    ).rejects.toThrow("project checkout");
  });
});

describe("looped review", () => {
  test("starts once with the caller's agent and opens its tab", async () => {
    const start = mock(async (input: Record<string, unknown>) => ({ ...input, id: "looped-1" }));
    context = {
      ...context,
      loopedReviews: { start } as unknown as CommandContext["loopedReviews"],
    } as CommandContext;
    const input = {
      requestId: "loop",
      environmentId: workerId,
      agent: "codex",
      model: "gpt-5.6",
      allowance: 3,
    };
    const result = await call("start_coordinator_looped_review", { input });
    expect(result).toMatchObject({
      workflowId: "looped-1",
      reused: false,
      ui: { status: "opened" },
    });
    expect(start.mock.calls[0]![0]).toMatchObject({
      environmentId: workerId,
      projectId: scope.projectId,
      agent: "codex",
      model: "gpt-5.6",
      targetBranch: "main",
      allowance: 3,
    });
    const { leaves: panes } = await leaves();
    expect(panes[0]!.tabs[0]).toMatchObject({
      id: "looped-review:looped-1",
      type: "looped-review",
      loopedReviewTabData: { environmentId: workerId, workflowId: "looped-1", isLocal: true },
    });
    expect(await call("start_coordinator_looped_review", { input })).toMatchObject({
      replayed: true,
    });
    expect(start).toHaveBeenCalledTimes(1);
    await expect(
      call("start_coordinator_looped_review", {
        input: { ...input, requestId: "home", environmentId: homeId },
      }),
    ).rejects.toThrow("project checkout");
  });
});

describe("feature plan launch", () => {
  test("creates a plan and starts planning once per request", async () => {
    const startPlanning = mock(async (args: Record<string, unknown>) => ({
      featureId: args.featureId,
      phase: "dispatching",
    }));
    commands.set("start_feature_planning", startPlanning as unknown as CommandHandler);
    const input = { requestId: "plan", message: "Add dark mode" };
    const launched = await call<{ featureId: string }>("launch_coordinator_feature_plan", {
      input,
    });
    expect(launched).toMatchObject({ phase: "dispatching", reused: false });
    expect(startPlanning.mock.calls[0]![0]).toEqual({
      featureId: launched.featureId,
      kind: "feature",
      userMessage: "Add dark mode",
    });
    expect(await call("launch_coordinator_feature_plan", { input })).toMatchObject({
      replayed: true,
    });
    expect(startPlanning).toHaveBeenCalledTimes(1);
    expect((await storage.kanban.getFeaturePlans(scope.projectId)).length).toBe(1);
    expect(
      await call("get_coordinator_feature_plan", { featureId: launched.featureId }),
    ).toMatchObject({ featureId: launched.featureId, status: "collecting" });
    await expect(
      call("launch_coordinator_feature_plan", {
        input: { requestId: "other", message: "x", featureId: "not-a-plan" },
      }),
    ).rejects.toThrow("not found");
  });
});

describe("request_coordinator_root_changes", () => {
  test("creates one user-approved request naming the worker and the asking conversation", async () => {
    commands.set("get_node_status", (async () => ({ nodeId: "self-node" })) as CommandHandler);
    const create = mock(async (_args: Record<string, unknown>) => ({ requestId: "approval-1" }));
    commands.set("create_node_action_request", create as unknown as CommandHandler);
    const input = {
      requestId: "changes",
      environmentId: workerId,
      files: ["src/a.ts"],
      reason: "Start from my edits",
    };
    expect(await call("request_coordinator_root_changes", { input })).toMatchObject({
      approvalRequestId: "approval-1",
      state: "pending",
    });
    const workspace = await storage.coordinators.getCoordinatorWorkspaceById(scope.coordinatorId);
    expect(create.mock.calls[0]![0]).toMatchObject({
      kind: "apply-root-changes",
      targets: [
        {
          nodeId: "self-node",
          environmentId: workerId,
          projectId: scope.projectId,
          files: ["src/a.ts"],
        },
      ],
      requestedBy: {
        coordinatorEnvironmentId: coordinatorRuntimeId(scope.coordinatorId, scope.conversationId),
        coordinatorTabId: workspace!.conversations[0]!.tabId,
        projectId: scope.projectId,
      },
    });
    expect(await call("request_coordinator_root_changes", { input })).toMatchObject({
      replayed: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
    await expect(
      call("request_coordinator_root_changes", {
        input: { ...input, requestId: "escape", files: ["../outside"] },
      }),
    ).rejects.toThrow("inside the project");
  });
});

const cleanReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: ["src/a.ts"],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Change",
    before: "Before",
    after: "After",
    keyCodeChanges: [],
    userImpact: "Impact",
  },
  riskProfile: {
    changeTypes: ["feature"],
    riskAreas: [],
    overallRisk: "medium",
    reasoning: "Changed",
  },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change",
  reviewSummary: "Clean",
};

describe("Multi Review custom fix and reviewer tabs", () => {
  async function readyReview(): Promise<MultiReviewWorkflow> {
    const timestamp = new Date().toISOString();
    const workflow = {
      id: "review-1",
      version: 1,
      controller: "backend",
      environmentId: workerId,
      projectId: scope.projectId,
      targetBranch: "main",
      reviewers: [
        {
          id: "reviewer-a",
          agent: "codex",
          model: "default",
          status: "completed",
          providerSessionId: "s-a",
          report: cleanReport,
        },
        { id: "reviewer-b", agent: "claude", model: "default", status: "pending" },
      ],
      reviewModel: { agent: "codex", model: "default" },
      fixModel: { agent: "codex", model: "default" },
      phase: "ready",
      consolidatedReport: cleanReport,
      backendRevision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    } as unknown as MultiReviewWorkflow;
    await storage.createMultiReviewWorkflowIfNoActive(workflow.id, workerId, 1, workflow);
    return workflow;
  }

  test("starts a custom fix once with the review's fix model by default", async () => {
    const workflow = await readyReview();
    const customFix = mock(async (input: Record<string, unknown>) => ({
      ...workflow,
      phase: "interactive",
      addressPromptPending: true,
      customFixInstruction: input.instruction,
    }));
    context = {
      ...context,
      multiReviews: { customFix } as unknown as CommandContext["multiReviews"],
    } as CommandContext;
    const input = { requestId: "fix-1", workflowId: workflow.id, instruction: "Only the tests" };
    const first = await call<MultiReviewActionResult>(
      "custom_fix_coordinator_multi_review_action",
      {
        input,
      },
    );
    expect(first.outcome).toBe("pending");
    expect(customFix.mock.calls[0]![0]).toEqual({
      workflowId: workflow.id,
      instruction: "Only the tests",
      fixModel: { agent: "codex", model: "default" },
    });
    const replay = await call<MultiReviewActionResult & { replayed?: boolean }>(
      "custom_fix_coordinator_multi_review_action",
      { input },
    );
    expect(replay).toMatchObject({
      outcome: "pending",
      replayed: true,
      workflow: { id: workflow.id },
    });
    expect(customFix).toHaveBeenCalledTimes(1);
    await expect(
      call("custom_fix_coordinator_multi_review_action", {
        input: { ...input, fixModel: { agent: "claude", model: "opus" } },
      }),
    ).rejects.toThrow("different payload");
  });

  test("opens a reviewer's transcript subtab, and explains one that has not started", async () => {
    const workflow = await readyReview();
    const opened = await call<MultiReviewActionResult>("open_coordinator_multi_review", {
      workflowId: workflow.id,
      reviewerId: "reviewer-a",
    });
    expect(opened).toMatchObject({
      outcome: "opened",
      ui: { status: "opened", tabId: "multi-review:review-1:reviewer:reviewer-a" },
    });
    const { leaves: panes } = await leaves();
    expect(panes[0]!.tabs[0]).toMatchObject({
      type: "multi-review",
      displayTitle: "Reviewer 1",
      multiReviewTabData: { workflowId: workflow.id, reviewerId: "reviewer-a" },
    });
    const pending = await call<MultiReviewActionResult>("open_coordinator_multi_review", {
      workflowId: workflow.id,
      reviewerId: "reviewer-b",
    });
    expect(pending.outcome).toBe("partial");
    expect(pending.recovery).toContain("has not started a session");
    await expect(
      call("open_coordinator_multi_review", { workflowId: workflow.id, reviewerId: "nobody" }),
    ).rejects.toThrow("Reviewer not found");
  });
});
