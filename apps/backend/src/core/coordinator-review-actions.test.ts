import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService, createEnvironment, createProject } from "./storage.js";
import { CoordinatorService } from "./coordinator-service.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { runCommand } from "./shell.js";
import type {
  MultiReviewWorkflow,
  MultiReviewActionResult,
  StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { PaneLayoutMergeInput } from "@orkestrator/protocol/pane-layout-merge";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { openMultiReviewTab } from "./workflow-tab-actions.js";

let root: string;
let storage: StorageService;
let context: CommandContext;
let scope: { projectId: string; coordinatorId: string; conversationId: string };
let environmentId: string;
let commands: ReturnType<typeof createCommandRegistry>;
let changes: ResourceChange[];
const selection = { agent: "codex" as const, model: "default", reasoningEffort: "high" };
let start: ReturnType<
  typeof mock<(input: StartMultiReviewInput, id?: string) => Promise<MultiReviewWorkflow>>
>;
let cancel: ReturnType<typeof mock<(id: string) => Promise<MultiReviewWorkflow>>>;
const input = () => ({
  environmentId,
  requestId: "button-1",
  reviewers: [selection],
  fixModel: selection,
});
const launch = (overrides = {}) =>
  commands.get("launch_coordinator_multi_review_action")!(
    { scope, input: { ...input(), ...overrides } },
    context,
  ) as Promise<MultiReviewActionResult>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-review-actions-"));
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
  const environment = createEnvironment(project.id, { name: "fixture", environmentType: "local" });
  Object.assign(environment, { status: "running", setupPhase: "ready", worktreePath: checkout });
  await storage.addEnvironment(environment);
  environmentId = environment.id;
  changes = [];
  storage.setResourceChangeListener((change) => changes.push(change));
  start = mock(async (input: StartMultiReviewInput, id = "primitive-review") => {
    const timestamp = new Date().toISOString();
    const workflow: MultiReviewWorkflow = {
      ...input,
      id,
      version: 1,
      controller: "backend",
      controllerFence: "private-test-fence",
      reviewers: input.reviewers.map((row, i) => ({
        ...row,
        id: `reviewer-${i}`,
        status: "pending",
      })),
      phase: "preparing",
      backendRevision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const saved = await storage.createMultiReviewWorkflowIfNoActive(
      id,
      input.environmentId,
      1,
      workflow,
    );
    if (!saved) throw new Error("Another review won admission");
    return { ...workflow, backendRevision: saved.revision };
  });
  cancel = mock(async (id) => {
    const saved = await storage.getMultiReviewWorkflow(id);
    return {
      ...(saved!.snapshot as MultiReviewWorkflow),
      phase: "cancelling",
      cancellingSince: new Date().toISOString(),
    };
  });
  context = {
    storage,
    coordinators: coordinator,
    multiReviews: { start, cancel } as unknown as CommandContext["multiReviews"],
  } as CommandContext;
  commands = createCommandRegistry();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("launch persists the root and selection, announces both resources, and rehydrates without a renderer", async () => {
  const outcome = await launch();
  expect(outcome).toMatchObject({
    outcome: "opened",
    reused: false,
    ui: { status: "opened", paneId: "default" },
  });
  expect(outcome.workflow.controllerFence).toBeUndefined();
  const restored = new StorageService(storage.getDataDir());
  await restored.init();
  expect((await restored.getMultiReviewWorkflow(outcome.workflow.id))?.snapshot).toMatchObject({
    id: outcome.workflow.id,
    fixModel: selection,
  });
  expect((await restored.getPaneLayout(environmentId))?.root).toMatchObject({
    activeTabId: outcome.ui.tabId,
    tabs: [
      {
        id: outcome.ui.tabId,
        type: "multi-review",
        multiReviewTabData: { workflowId: outcome.workflow.id, environmentId, isLocal: true },
      },
    ],
  });
  expect(changes.some((change) => change.resource === "multi-review")).toBe(true);
  expect(changes.some((change) => change.resource === "pane-layout")).toBe(true);
});

test("concurrent retries and a fresh registry use the same durable identity and reject changed payloads", async () => {
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => launch()));
  commands = createCommandRegistry();
  expect((await launch()).workflow.id).toBe(outcomes[0]!.workflow.id);
  expect(start).toHaveBeenCalledTimes(1);
  await expect(launch({ targetBranch: "changed" })).rejects.toThrow("different payload");
  expect((await storage.getPaneLayout(environmentId))?.root).toMatchObject({
    tabs: [{ type: "multi-review" }],
  });
});

test("a pending receipt recovers the exact saved workflow after receipt completion failed", async () => {
  const complete = storage.completeCoordinatorWorkflowAssociation.bind(storage);
  storage.completeCoordinatorWorkflowAssociation = mock(async () => {
    throw new Error("disk unavailable");
  });
  const failed = await launch();
  expect(failed.outcome).toBe("partial");
  expect(failed.recovery).toContain("same requestId");
  storage.completeCoordinatorWorkflowAssociation = complete;
  commands = createCommandRegistry();
  expect((await launch()).workflow.id).toBe(failed.workflow.id);
  expect(start).toHaveBeenCalledTimes(1);
});

test("existing active workflows reattach even with a different model selection and full tabs focus their existing root", async () => {
  const first = await launch();
  await fullLayout(first.workflow.id, first.ui.tabId);
  const second = await launch({
    requestId: "new-click",
    fixModel: { agent: "claude", model: "default" },
  });
  expect(second).toMatchObject({
    outcome: "opened",
    reused: true,
    workflow: { id: first.workflow.id },
    ui: { tabId: first.ui.tabId },
  });
  expect(start).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
});

async function fullLayout(workflowId?: string, tabId?: string) {
  const previous = await storage.getPaneLayout(environmentId);
  await storage.savePaneLayout(
    environmentId,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        activeTabId: "tab-8",
        tabs: Array.from({ length: 9 }, (_, i) =>
          i === 0 && workflowId
            ? {
                id: tabId,
                type: "multi-review",
                multiReviewTabData: { environmentId, workflowId, isLocal: true },
              }
            : { id: `tab-${i}`, type: "plain" },
        ),
      },
    },
    previous?.revision ?? 0,
  );
}

test("tab limit and environment readiness fail before launch", async () => {
  await fullLayout();
  await expect(launch()).rejects.toThrow("maximum 9");
  expect(start).not.toHaveBeenCalled();
  await storage.updateEnvironment(environmentId, { status: "stopped" });
  await expect(launch()).rejects.toThrow("Start the environment");
  expect(start).not.toHaveBeenCalled();
});

test("saved branch and review instruction defaults match the environment button", async () => {
  await storage.updateRepositoryConfig(scope.projectId, {
    defaultBranch: "main",
    prBaseBranch: "develop",
  });
  await storage.updateGlobalConfig({
    ...(await storage.loadConfig()).global,
    reviewInstruction: "Check failure recovery",
  });
  const outcome = await launch();
  expect(outcome.workflow).toMatchObject({
    targetBranch: "develop",
    reviewInstruction: "Check failure recovery",
    reviewers: [expect.objectContaining(selection)],
    fixModel: selection,
  });
});

test("reattach failure never cancels the already running review", async () => {
  const started = await launch();
  await fullLayout();
  const outcome = await launch({ requestId: "reattach" });
  expect(outcome).toMatchObject({
    outcome: "partial",
    reused: true,
    workflow: { id: started.workflow.id },
  });
  expect(cancel).not.toHaveBeenCalled();
});

test("a generation/readiness change during launch requests cancellation and retains recovery state", async () => {
  const implementation = start.getMockImplementation()!;
  start.mockImplementation(async (input, id) => {
    const workflow = await implementation(input, id);
    await storage.updateEnvironment(environmentId, { status: "stopped" });
    return workflow;
  });
  expect(await launch()).toMatchObject({ outcome: "partial", workflow: { phase: "cancelling" } });
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("immediate cancellation after publication failure is reported without deleting the idempotency evidence", async () => {
  const implementation = start.getMockImplementation()!;
  start.mockImplementation(async (input, id) => {
    const workflow = await implementation(input, id);
    await fullLayout();
    return workflow;
  });
  cancel.mockImplementation(async (id) => ({
    ...((await storage.getMultiReviewWorkflow(id))!.snapshot as MultiReviewWorkflow),
    phase: "cancelled",
  }));
  const outcome = await launch();
  expect(outcome.recovery).toContain("was cancelled");
  expect(await storage.getMultiReviewWorkflow(outcome.workflow.id)).not.toBeNull();
  expect((await storage.listCoordinatorWorkflowAssociations(scope.projectId))[0]?.resourceId).toBe(
    outcome.workflow.id,
  );
});

test("launch failure creates no orphan tab and retry retains the reserved identity", async () => {
  const implementation = start.getMockImplementation()!;
  start.mockImplementationOnce(async () => {
    throw new Error("Git unavailable");
  });
  await expect(launch()).rejects.toThrow("Git unavailable");
  expect(await storage.getPaneLayout(environmentId)).toBeNull();
  start.mockImplementation(implementation);
  await launch();
  expect(start.mock.calls[0]![1]).toBe(start.mock.calls[1]![1]);
});

test.each([false, true])(
  "publication failure reports cancellation truthfully (cancel fails: %s)",
  async (cancelFails) => {
    const implementation = start.getMockImplementation()!;
    start.mockImplementation(async (input, id) => {
      const workflow = await implementation(input, id);
      await fullLayout();
      return workflow;
    });
    if (cancelFails)
      cancel.mockImplementation(async () => {
        throw new Error("bridge unavailable");
      });
    const outcome = await launch();
    expect(outcome).toMatchObject({ outcome: "partial", ui: { status: "unavailable" } });
    expect(outcome.recovery).toContain(
      cancelFails ? "Cancellation could not be confirmed" : "Cancellation is still in progress",
    );
    expect(await storage.getMultiReviewWorkflow(outcome.workflow.id)).not.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);

test("CAS retries preserve a concurrent tab addition and a stale renderer intent preserves the review", async () => {
  const save = storage.savePaneLayout.bind(storage);
  let raced = false;
  storage.savePaneLayout = async (id, layout, revision) => {
    if (!raced) {
      raced = true;
      await save(
        id,
        {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "concurrent", type: "plain" }],
            activeTabId: "concurrent",
          },
        },
        0,
      );
    }
    return save(id, layout, revision);
  };
  const outcome = await launch();
  const base: PaneLayoutMergeInput = {
    version: PANE_LAYOUT_VERSION,
    containerId: null,
    activePaneId: "default",
    root: {
      kind: "leaf",
      id: "default",
      tabs: [{ id: "concurrent", type: "plain" }],
      activeTabId: "concurrent",
    },
  };
  const desired = structuredClone(base);
  if (desired.root.kind === "leaf") desired.root.tabs.push({ id: "renderer-new", type: "plain" });
  const merged = await storage.applyPaneLayoutIntent(environmentId, base, desired);
  expect(JSON.stringify(merged.root)).toContain(outcome.ui.tabId!);
  expect(JSON.stringify(merged.root)).toContain("renderer-new");
  expect(JSON.stringify(merged.root)).toContain("concurrent");
});

test("root open focuses a legacy ID across panes without confusing reviewer subtabs", async () => {
  const outcome = await launch();
  const previous = await storage.getPaneLayout(environmentId);
  await storage.savePaneLayout(
    environmentId,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "left",
      root: {
        kind: "split",
        id: "split",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          {
            kind: "leaf",
            id: "left",
            activeTabId: "reviewer",
            tabs: [
              {
                id: "reviewer",
                type: "multi-review",
                multiReviewTabData: { workflowId: outcome.workflow.id, reviewerId: "reviewer-0" },
              },
            ],
          },
          {
            kind: "leaf",
            id: "right",
            activeTabId: "plain",
            tabs: [
              {
                id: "legacy-root",
                type: "multi-review",
                multiReviewTabData: { workflowId: outcome.workflow.id },
              },
              { id: "plain", type: "plain" },
            ],
          },
        ],
      },
    },
    previous!.revision,
  );
  const opened = (await commands.get("open_coordinator_multi_review")!(
    { scope, workflowId: outcome.workflow.id },
    context,
  )) as MultiReviewActionResult;
  expect(opened.ui).toMatchObject({ status: "opened", paneId: "right", tabId: "legacy-root" });
  expect(start).toHaveBeenCalledTimes(1);
});

test("scoped launch/open reject another project and another conversation", async () => {
  const first = await launch();
  await expect(
    commands.get("open_coordinator_multi_review")!(
      { scope: { ...scope, projectId: "other" }, workflowId: first.workflow.id },
      context,
    ),
  ).rejects.toThrow("identity");
  const other = await context.coordinators!.createConversation(scope.projectId, "Other");
  await expect(
    commands.get("open_coordinator_multi_review")!(
      {
        scope: { ...scope, conversationId: other.workspace.selectedConversationId },
        workflowId: first.workflow.id,
      },
      context,
    ),
  ).rejects.toThrow("Adopt");
  const env = createEnvironment("another-project", { name: "other", environmentType: "local" });
  await storage.addEnvironment(env);
  await expect(launch({ environmentId: env.id })).rejects.toThrow("this project");
});

test("Fix opening is presentation-only, stable, and refuses pending handoffs", async () => {
  const launched = await launch();
  const workflow = {
    ...launched.workflow,
    fixSession: {
      ...selection,
      providerSessionId: "provider-1",
      sessionKey: "fix-session",
      status: "idle" as const,
      requestIds: [],
      startedAt: new Date().toISOString(),
    },
  };
  const first = await openMultiReviewTab(storage, workflow, "fix");
  const second = await openMultiReviewTab(storage, workflow, "fix");
  expect(second.tabId).toBe(first.tabId);
  expect(JSON.stringify((await storage.getPaneLayout(environmentId))?.root)).toContain(
    "provider-1",
  );
  await expect(
    openMultiReviewTab(storage, { ...workflow, addressPromptPending: true }, "fix"),
  ).rejects.toThrow("pending");
  expect(start).toHaveBeenCalledTimes(1);
});

test("address opens the root before persisting a handoff and reports pending without claiming delivery", async () => {
  const launched = await launch();
  const report = {
    reviewScope: {
      targetBranch: "main",
      baseRef: "origin/main...HEAD",
      commit: null,
      filesReviewed: [],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [],
      commandsNotRun: [],
      limitations: [],
    },
    whatChanged: {
      overview: "Fixture",
      before: "Before",
      after: "After",
      keyCodeChanges: [],
      userImpact: "None",
    },
    riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "Fixture" },
    testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
    strengths: [],
    issues: [],
    testCoverageGaps: [],
    verdict: { ready: "yes", reasoning: "Fixture" },
    summaryOfChange: "Fixture",
    reviewSummary: "Fixture",
  };
  const ready = {
    ...launched.workflow,
    phase: "ready",
    consolidatedReport: report,
    fixSession: {
      ...selection,
      providerSessionId: "provider-1",
      sessionKey: "fix-session",
      status: "idle",
      requestIds: [],
      startedAt: new Date().toISOString(),
    },
  };
  await storage.saveMultiReviewWorkflow(
    ready.id,
    environmentId,
    1,
    ready,
    launched.workflow.backendRevision,
  );
  let handoffs = 0;
  const address = mock(async (id) => {
    expect(JSON.stringify((await storage.getPaneLayout(environmentId))?.root)).toContain(
      launched.ui.tabId!,
    );
    const saved = (await storage.getMultiReviewWorkflow(id))!;
    const current = saved.snapshot as MultiReviewWorkflow;
    if (current.addressPromptPending) return current;
    handoffs += 1;
    const pending: MultiReviewWorkflow = {
      ...current,
      phase: "interactive",
      addressPromptPending: true,
      addressSessionKey: `multi-review:${id}:interactive`,
      addressRequestId: `multi-review-address:${id}`,
      addressTabId: `multi-review-fix:${id}`,
    };
    const written = await storage.saveMultiReviewWorkflow(
      id,
      environmentId,
      1,
      pending,
      saved.revision,
    );
    return { ...pending, backendRevision: written.revision };
  });
  context.multiReviews!.address = address;
  const command = commands.get("address_coordinator_multi_review_action")!;
  for (let retry = 0; retry < 2; retry += 1) {
    const outcome = (await command(
      { scope, workflowId: ready.id },
      context,
    )) as MultiReviewActionResult;
    expect(outcome).toMatchObject({
      outcome: "pending",
      ui: { status: "opened", tabId: launched.ui.tabId },
      workflow: {
        addressPromptPending: true,
        addressRequestId: `multi-review-address:${ready.id}`,
      },
    });
    expect(outcome.recovery).toContain("Do not send a separate fix prompt");
  }
  expect(handoffs).toBe(1);
});

test("address does not arm hidden work when the root cannot be presented", async () => {
  const launched = await launch();
  await fullLayout();
  const address = mock(async () => launched.workflow);
  context.multiReviews!.address = address;
  expect(
    await commands.get("address_coordinator_multi_review_action")!(
      { scope, workflowId: launched.workflow.id },
      context,
    ),
  ).toMatchObject({ outcome: "partial" });
  expect(address).not.toHaveBeenCalled();
});

test("terminal workflows remain idempotent and an explicitly deleted workflow is not relaunched", async () => {
  const launched = await launch();
  await storage.saveMultiReviewWorkflow(
    launched.workflow.id,
    environmentId,
    1,
    { ...launched.workflow, phase: "cancelled" },
    launched.workflow.backendRevision,
  );
  expect((await launch()).workflow.phase).toBe("cancelled");
  await storage.deleteMultiReviewWorkflow(launched.workflow.id);
  await expect(launch()).rejects.toThrow("removed");
  expect(start).toHaveBeenCalledTimes(1);
});

test("a competing renderer launch wins admission once and is reopened", async () => {
  const implementation = start.getMockImplementation()!;
  start.mockImplementation(async (input) => {
    await implementation(input, "renderer-winner");
    throw new Error("Another review won admission");
  });
  const outcome = await launch();
  expect(outcome).toMatchObject({
    outcome: "opened",
    reused: true,
    workflow: { id: "renderer-winner" },
  });
  expect((await launch()).workflow.id).toBe("renderer-winner");
  expect(start).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
});
