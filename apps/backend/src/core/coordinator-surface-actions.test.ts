import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { isLoopedReviewWorkflow } from "@orkestrator/protocol/review-workflow";
import { NodeActionRequests } from "./nodes/node-action-requests.js";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type {
  MultiReviewActionResult,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { CoordinatorService } from "./coordinator-service.js";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";
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
  context = {
    storage,
    coordinators: coordinator,
    runtime: { environments: { fence: new EnvironmentMutationFence() } },
  } as CommandContext;
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
    const start = mock(async (input: Record<string, unknown>, _workflowId?: string) => ({
      ...input,
      id: "looped-1",
    }));
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

describe("create_coordinator_pr", () => {
  function stubPrLaunch() {
    const launch = mock(async (args: Record<string, unknown>) => ({
      status: "accepted",
      tabId: `pr-tab:${String(args.requestId)}`,
    }));
    const watch = mock(async () => ({}));
    commands.set("launch_native_agent_job", launch as unknown as CommandHandler);
    commands.set("pr_monitor_watch", watch as unknown as CommandHandler);
    return { launch, watch };
  }

  test("opens the worker's PR tab once per request, against the PR base branch", async () => {
    const { launch, watch } = stubPrLaunch();
    const input = { requestId: "pr", environmentId: workerId };
    const result = await call("create_coordinator_pr", { input });
    expect(result).toMatchObject({
      environmentId: workerId,
      status: "launched",
      tabId: expect.stringMatching(/^pr-tab:coordinator-pr:/),
      targetBranch: "main",
    });
    expect(launch.mock.calls[0]![0]).toMatchObject({
      environmentId: workerId,
      title: "PR",
      conversationMode: "build",
      activateTab: false,
      prompt: expect.stringContaining("main"),
    });
    expect(watch).toHaveBeenCalledWith(
      { environmentId: workerId, mode: "create-pending" },
      context,
    );
    expect(await call("create_coordinator_pr", { input })).toMatchObject({ replayed: true });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, "release/next"])(
    "uses repository PR defaults and an explicit target %p",
    async (targetBranch) => {
      const { launch } = stubPrLaunch();
      await storage.updateRepositoryConfig(scope.projectId, {
        defaultBranch: "main",
        prBaseBranch: "develop",
      });
      const result = await call("create_coordinator_pr", {
        input: { requestId: "branch", environmentId: workerId, targetBranch },
      });
      expect(result.targetBranch).toBe(targetBranch ?? "develop");
      expect(launch.mock.calls[0]![0].prompt).toContain(targetBranch ?? "develop");
    },
  );

  test.each(["deleted", "fork", "failed", "complete"])(
    "allows a worker left by a %s pipeline",
    async (kind) => {
      const { launch } = stubPrLaunch();
      const worker = createEnvironment(scope.projectId, {
        name: "pipeline-leftover",
        environmentType: "local",
        buildPipelineId: "old-pipeline",
      });
      await storage.addEnvironment(worker);
      expect((await storage.getEnvironment(worker.id))?.buildPipelineId).toBe("old-pipeline");
      if (kind !== "deleted")
        await storage.saveBuildPipeline(
          "old-pipeline",
          scope.projectId,
          kind === "fork" ? homeId : worker.id,
          1,
          { phase: kind === "fork" ? "building" : kind },
        );
      expect(
        await call("create_coordinator_pr", {
          input: { requestId: "orphan", environmentId: worker.id },
        }),
      ).toMatchObject({ status: "launched" });
      expect(launch).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["rejected", "throw", "pending", "unacknowledged"])(
    "releases a %s launch receipt and retries the same durable job",
    async (kind) => {
      const { launch, watch } = stubPrLaunch();
      const jobIds = new Set<string>();
      commands.set("launch_native_agent_job", async (args) => {
        jobIds.add(String(args.requestId));
        if (jobIds.size !== 1) throw new Error("duplicate job identity");
        // Even a lost answer after a job starts must reuse the same job ID.
        if (launch.mock.calls.length === 0) {
          await launch(args);
          if (kind === "throw") throw new Error("lost acknowledgement");
          return kind === "unacknowledged" ? {} : { status: kind, error: "not ready" };
        }
        return launch(args);
      });
      const input = { requestId: "retry", environmentId: workerId };
      await expect(call("create_coordinator_pr", { input })).rejects.toThrow(
        kind === "throw"
          ? "lost acknowledgement"
          : kind === "unacknowledged"
            ? "did not acknowledge"
            : "not ready",
      );

      expect(watch).not.toHaveBeenCalled();
      expect(await call("create_coordinator_pr", { input })).toMatchObject({ status: "launched" });
      expect(jobIds.size).toBe(1);
      expect(await call("create_coordinator_pr", { input })).toMatchObject({ replayed: true });
      expect(launch).toHaveBeenCalledTimes(2);
    },
  );

  test("leaves a build pipeline's PR to the pipeline and an existing PR alone", async () => {
    const { launch } = stubPrLaunch();
    await expect(
      call("create_coordinator_pr", { input: { requestId: "home", environmentId: homeId } }),
    ).rejects.toThrow("project checkout");
    const pipelineWorker = createEnvironment(scope.projectId, {
      name: "pipeline-worker",
      environmentType: "local",
      buildPipelineId: "pipeline-1",
    });
    await storage.addEnvironment(pipelineWorker);
    await storage.saveBuildPipeline("pipeline-1", scope.projectId, pipelineWorker.id, 1, {
      phase: "building",
    });
    await expect(
      call("create_coordinator_pr", {
        input: { requestId: "pipe", environmentId: pipelineWorker.id },
      }),
    ).rejects.toThrow("build pipeline");
    await storage.updateEnvironment(workerId, { prUrl: "https://github.com/acme/repo/pull/7" });
    expect(
      await call("create_coordinator_pr", {
        input: { requestId: "exists", environmentId: workerId },
      }),
    ).toMatchObject({ status: "skipped", prUrl: "https://github.com/acme/repo/pull/7" });
    expect(launch).not.toHaveBeenCalled();
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
      operationId: expect.stringMatching(/^planning-coordinator-/),
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

  for (const blocker of ["tab", "handoff", "readiness"])
    test(`custom fix retries the same request after ${blocker} failure`, async () => {
      const workflow = await readyReview();
      const customFix = mock(async () => ({
        ...workflow,
        phase: "interactive",
        addressPromptPending: true,
      }));
      context.multiReviews = { customFix } as unknown as CommandContext["multiReviews"];
      const input = { requestId: "retry-fix", workflowId: workflow.id, instruction: "Fix tests" };
      const open =
        blocker === "tab"
          ? spyOn(storage, "savePaneLayout").mockRejectedValueOnce(new Error("no room"))
          : null;
      if (blocker === "handoff") customFix.mockRejectedValueOnce(new Error("not ready"));
      if (blocker === "readiness") await storage.updateEnvironment(workerId, { status: "stopped" });
      await expect(call("custom_fix_coordinator_multi_review_action", { input })).rejects.toThrow(
        "same requestId",
      );
      open?.mockRestore();
      if (blocker === "readiness") await storage.updateEnvironment(workerId, { status: "running" });
      expect(await call("custom_fix_coordinator_multi_review_action", { input })).toMatchObject({
        outcome: "pending",
      });
      await call("custom_fix_coordinator_multi_review_action", { input });
      expect(customFix).toHaveBeenCalledTimes(blocker === "handoff" ? 2 : 1);
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

// Simulate owner death at the receipt-completion boundary while retaining effects.
async function crashBeforeReceiptCompletion(operation: () => Promise<unknown>) {
  const complete = spyOn(
    storage.coordinators,
    "completeCoordinatorActionReceipt",
  ).mockRejectedValueOnce(new Error("owner died"));
  await expect(operation()).rejects.toThrow("owner died");
  complete.mockRestore();
}
async function reclaim<T>(operation: () => Promise<T>): Promise<T> {
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  try {
    return await operation();
  } finally {
    kill.mockRestore();
  }
}

test("grok refuses unsupported launch options before starting a terminal", async () => {
  const launch = mock(async () => ({}));
  commands.set("launch_terminal_job", launch as unknown as CommandHandler);
  for (const option of [{ prompt: "hello" }, { model: "grok" }, { reasoningEffort: "high" }])
    await expect(
      call("launch_coordinator_terminal", {
        input: { requestId: "grok", environmentId: workerId, tabType: "grok", ...option },
      }),
    ).rejects.toThrow("do not support");
  expect(launch).not.toHaveBeenCalled();
});

for (const phase of ["running", "waiting", "projection-error", "missing", "idle", "error"]) {
  test(`native close handles ${phase} safely`, async () => {
    await saveLayout([
      { id: "native", type: "agent-native", nativeAgentData: { platform: "codex" } },
    ]);
    const teardown = mock(async () => ({}));
    commands.set("teardown_tab", teardown as unknown as CommandHandler);
    context.nativeAgents = {
      getProjection: async () => {
        if (phase === "projection-error") throw new Error("offline");
        if (phase === "missing") return null;
        return {
          turn: { phase: phase === "waiting" ? "idle" : phase },
          interactions: phase === "waiting" ? [{}] : [],
        };
      },
    } as unknown as CommandContext["nativeAgents"];
    const close = call("edit_coordinator_worker_tab", {
      input: { environmentId: workerId, tabId: "native", operation: "close" },
    });
    if (["idle", "error", "missing"].includes(phase)) {
      await close;
      expect(teardown).toHaveBeenCalledTimes(1);
    } else {
      await expect(close).rejects.toThrow("busy or waiting");
      expect(teardown).not.toHaveBeenCalled();
      expect((await leaves()).leaves[0]!.tabs).toHaveLength(1);
    }
  });
}

test("close reserves prompt and delegation admission through delayed durable layout removal", async () => {
  await saveLayout([{ id: "shell", type: "plain", backendTerminalSessionId: "pty" }]);
  commands.set("teardown_tab", (async () => ({})) as CommandHandler);
  let resume!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const original = storage.savePaneLayout.bind(storage);
  const save = spyOn(storage, "savePaneLayout").mockImplementation(async (...args) => {
    entered();
    await gate;
    return original(...args);
  });
  const close = call("edit_coordinator_worker_tab", {
    input: { environmentId: workerId, tabId: "shell", operation: "close" },
  });
  await waiting;
  expect(() => context.runtime.environments.fence.beginAgentWork(workerId)).toThrow(
    "tab is being closed",
  );
  const association = await storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "race",
    ...scope,
    kind: "environment",
    resourceId: workerId,
    requestId: "race",
    createdAt: new Date().toISOString(),
  });
  await expect(
    storage.coordinators.openCoordinatorDelegation(association.id, "shell"),
  ).rejects.toThrow("being closed");
  resume();
  await close;
  save.mockRestore();
  const release = context.runtime.environments.fence.beginAgentWork(workerId);
  release();
});

test("failed teardown retains the original resource for a same-close retry", async () => {
  await saveLayout([{ id: "shell", type: "plain", backendTerminalSessionId: "original-pty" }]);
  const teardown = mock(async () => ({})).mockRejectedValueOnce(
    new Error("intent persistence failed"),
  );
  commands.set("teardown_tab", teardown as unknown as CommandHandler);
  const close = () =>
    call("edit_coordinator_worker_tab", {
      input: { environmentId: workerId, tabId: "shell", operation: "close" },
    });
  await expect(close()).rejects.toThrow("intent persistence failed");
  expect((await leaves()).leaves[0]!.tabs[0]!.backendTerminalSessionId).toBe("original-pty");
  await close();
  expect(teardown).toHaveBeenCalledTimes(2);
  expect((teardown.mock.calls as unknown[])[1]).toEqual([
    { environmentId: workerId, tabId: "shell", kind: "terminal", sessionId: "original-pty" },
    context,
  ]);
});

test("failed planning startup reuses the same empty plan", async () => {
  const planning = mock(async () => ({ phase: "dispatching" })).mockRejectedValueOnce(
    new Error("not ready"),
  );
  commands.set("start_feature_planning", planning as unknown as CommandHandler);
  const launch = () =>
    call("launch_coordinator_feature_plan", {
      input: { requestId: "failed-plan", message: "Plan it" },
    });
  await expect(launch()).rejects.toThrow("not ready");
  await launch();
  expect(await storage.kanban.getFeaturePlans(scope.projectId)).toHaveLength(1);
  expect(planning.mock.calls[0]).toEqual(planning.mock.calls[1]);
});

for (const followup of [false, true])
  for (const terminal of [false, true]) {
    test(`planning crash recovery reuses ${followup ? "follow-up" : "new plan"} operation while ${terminal ? "complete" : "running"}`, async () => {
      const plan = followup ? await storage.kanban.createFeaturePlan(scope.projectId) : undefined;
      const start = mock(async (args: Record<string, unknown>) => {
        const now = new Date().toISOString();
        await storage.kanban.startFeaturePlanning({
          version: 1,
          operationId: args.operationId as string,
          featureId: args.featureId as string,
          projectId: scope.projectId,
          kind: "feature",
          userMessage: args.userMessage as string,
          phase: "dispatching",
          startedAt: now,
          updatedAt: now,
          backendRevision: 0,
        });
        return { phase: "dispatching" };
      });
      commands.set("start_feature_planning", start as unknown as CommandHandler);
      const launch = () =>
        call("launch_coordinator_feature_plan", {
          input: {
            requestId: "crash-plan",
            message: "same message",
            ...(plan ? { featureId: plan.id } : {}),
          },
        });
      await crashBeforeReceiptCompletion(launch);
      const saved = (await storage.kanban.getFeaturePlans(scope.projectId))[0]!;
      if (terminal)
        await storage.kanban.clearFeaturePlanning(saved.id, saved.planning!.operationId);
      expect(await reclaim(launch)).toMatchObject({ featureId: saved.id, reused: true });
      expect(start).toHaveBeenCalledTimes(1);
      expect(
        (await storage.kanban.getFeaturePlan(saved.id))!.messages.filter(
          (message) => message.role === "user",
        ),
      ).toHaveLength(1);
    });
  }

for (const phase of ["preparing", "completed", "cancelled", "failed"]) {
  test(`looped review recovery reattaches in ${phase}`, async () => {
    const start = mock(async (input: Record<string, unknown>, id: string) => {
      const now = new Date().toISOString();
      const workflow = {
        ...input,
        id,
        version: 2,
        controller: "backend",
        phase,
        ...(phase === "failed"
          ? {
              failure: {
                code: "provider",
                message: "failed",
                retryPhase: "preparing",
                occurredAt: now,
              },
            }
          : {}),
        createdAt: now,
        updatedAt: now,
        backendRevision: 0,
        startingAllowance: 1,
        currentAllowance: 1,
        currentRound: 1,
        currentPass: 0,
        rounds: [{ round: 1, allowance: 1, status: "preparing", passes: [], startedAt: now }],
        sessions: [],
        activePool: { issues: [], coverageGaps: [] },
        archivedPools: [],
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        pr: { status: "pending" },
      };
      expect(isLoopedReviewWorkflow(workflow)).toBe(true);
      await storage.saveLoopedReviewWorkflow(id, workerId, 2, workflow, 0);
      return workflow;
    });
    context.loopedReviews = { start } as unknown as CommandContext["loopedReviews"];
    const launch = () =>
      call("start_coordinator_looped_review", {
        input: {
          requestId: "crashed-review",
          environmentId: workerId,
          agent: "codex",
          model: "default",
        },
      });
    await crashBeforeReceiptCompletion(launch);
    expect(await reclaim(launch)).toMatchObject({ reused: true });
    expect(start).toHaveBeenCalledTimes(1);
  });
}

test("root-change receipt recovery reuses one approval and delivers one outcome", async () => {
  const notices: string[] = [];
  const requests = new NodeActionRequests({
    load: async () => [],
    save: async () => {},
    emit: () => {},
    executors: { "apply-root-changes": async () => ({ code: "applied", message: "Applied" }) },
    notify: async (request) => {
      notices.push(request.requestId);
    },
  });
  commands.set("get_node_status", (async () => ({ nodeId: "self" })) as CommandHandler);
  commands.set("create_node_action_request", (async (args) =>
    requests.create(
      args as unknown as Parameters<NodeActionRequests["create"]>[0],
    )) as CommandHandler);
  const launch = () =>
    call<{ approvalRequestId: string }>("request_coordinator_root_changes", {
      input: { requestId: "crashed-approval", environmentId: workerId, reason: "Apply my changes" },
    });
  await crashBeforeReceiptCompletion(launch);
  const recovered = await reclaim(launch);
  expect(await requests.list()).toHaveLength(1);
  await requests.resolve(recovered.approvalRequestId, "approve");
  expect(await launch()).toMatchObject({
    approvalRequestId: recovered.approvalRequestId,
    replayed: true,
  });
  expect(notices).toEqual([recovered.approvalRequestId]);
});

test("close refuses work already admitted before its safety read", async () => {
  await saveLayout([{ id: "shell", type: "plain" }]);
  const release = context.runtime.environments.fence.beginAgentWork(workerId);
  try {
    await expect(
      call("edit_coordinator_worker_tab", {
        input: { environmentId: workerId, tabId: "shell", operation: "close" },
      }),
    ).rejects.toThrow("submission is in progress");
    expect((await leaves()).leaves[0]!.tabs).toHaveLength(1);
  } finally {
    release();
  }
});

test("worker browser uses the agent-link policy for empty and wildcard addresses", async () => {
  for (const url of ["", "http://0.0.0.0:3000/"])
    await expect(
      call("open_coordinator_browser", {
        input: { requestId: "invalid-url", environmentId: workerId, url },
      }),
    ).rejects.toThrow();
  expect(await storage.getPaneLayout(workerId)).toBeNull();
});

test("persisted pending teardown prevents a new delegation while allowing close retry", async () => {
  await saveLayout([{ id: "shell", type: "plain", backendTerminalSessionId: "pty-pending" }]);
  await storage.setTabTeardownIntent(workerId, {
    tabId: "shell",
    kind: "terminal",
    sessionId: "pty-pending",
    createdAt: new Date().toISOString(),
  });
  const association = await storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "pending-close",
    ...scope,
    kind: "environment",
    resourceId: workerId,
    requestId: "pending-close",
    createdAt: new Date().toISOString(),
  });
  await expect(
    storage.coordinators.openCoordinatorDelegation(association.id, "shell"),
  ).rejects.toThrow("pending teardown");
  const teardown = mock(async () => ({}));
  commands.set("teardown_tab", teardown as unknown as CommandHandler);
  expect(
    await call("edit_coordinator_worker_tab", {
      input: { environmentId: workerId, tabId: "shell", operation: "close" },
    }),
  ).toMatchObject({ changed: true });
  expect(teardown).toHaveBeenCalledTimes(1);
});
