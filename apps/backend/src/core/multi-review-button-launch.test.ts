import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  MultiReviewActionResult,
  MultiReviewWorkflow,
  StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { StorageService, createEnvironment, createProject } from "./storage.js";

/**
 * `launch_multi_review`: the renderer's Multi Review button, the same durable
 * launch a CLI `review.launch` runs. The tab is written into the environment's
 * pane layout here, so no renderer has to survive the launch.
 */
const row = { agent: "codex" as const, model: "gpt-5.6-codex" };

let root: string;
let storage: StorageService;
let environmentId: string;
let context: CommandContext;
let launch: CommandHandler;
let start: ReturnType<typeof mock<(input: StartMultiReviewInput, id?: string) => Promise<unknown>>>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-review-button-"));
  storage = new StorageService(root);
  await storage.init();
  const project = await storage.addProject(createProject("remote", path.join(root, "checkout")));
  await storage.saveConfig({
    ...(await storage.loadConfig()),
    repositories: { [project.id]: { prBaseBranch: "release" } },
  } as Parameters<StorageService["saveConfig"]>[0]);
  const environment = createEnvironment(project.id, { name: "fixture", environmentType: "local" });
  Object.assign(environment, { status: "running", setupPhase: "ready", worktreePath: root });
  await storage.addEnvironment(environment);
  environmentId = environment.id;
  start = mock(async (input: StartMultiReviewInput, id = "review-primitive") => {
    const timestamp = new Date().toISOString();
    const workflow: MultiReviewWorkflow = {
      ...input,
      id,
      version: 1,
      controller: "backend",
      controllerFence: "private-test-fence",
      reviewers: input.reviewers.map((reviewer, index) => ({
        ...reviewer,
        id: `reviewer-${index}`,
        status: "pending",
      })),
      phase: "preparing",
      backendRevision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await storage.createMultiReviewWorkflowIfNoActive(id, input.environmentId, 1, workflow);
    return workflow;
  });
  context = {
    storage,
    multiReviews: { start, cancel: mock(async () => ({})) },
  } as unknown as CommandContext;
  launch = createCommandRegistry().get("launch_multi_review")!;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const request = (requestId: string, overrides: Record<string, unknown> = {}) => ({
  input: {
    requestId,
    environmentId,
    reviewers: [row, row],
    reviewModel: row,
    fixModel: row,
    ...overrides,
  },
  reservedId: requestId,
});

test("starts under the reserved id, fills saved defaults and writes the tab", async () => {
  const result = (await launch(request("review-1"), context)) as MultiReviewActionResult;

  expect(result).toMatchObject({ reused: false, outcome: "opened", ui: { status: "opened" } });
  expect(result.workflow.id).toBe("review-1");
  const started = start.mock.calls[0]![0];
  // The renderer no longer sends these: the saved repository default fills them.
  expect(started.targetBranch).toBe("release");
  expect(started.projectId).toBe(result.workflow.projectId);

  // The tab is in the authoritative layout before any renderer acts on the answer.
  const layout = await storage.getPaneLayout(environmentId);
  expect(JSON.stringify(layout)).toContain(result.ui.tabId!);
  expect(JSON.stringify(layout)).toContain('"workflowId":"review-1"');
});

test("reattaches to the active review instead of starting a second one", async () => {
  await launch(request("review-1"), context);
  const second = (await launch(request("review-2"), context)) as MultiReviewActionResult;

  expect(second.reused).toBe(true);
  expect(second.workflow.id).toBe("review-1");
  expect(start).toHaveBeenCalledTimes(1);
});

test("a retried request returns the review it already started", async () => {
  const first = (await launch(request("review-1"), context)) as MultiReviewActionResult;
  const retried = (await launch(request("review-1"), context)) as MultiReviewActionResult;

  expect(retried).toMatchObject({ reused: true, ui: { tabId: first.ui.tabId } });
  expect(start).toHaveBeenCalledTimes(1);
});

test("refuses before starting anything when the environment cannot host the tab", async () => {
  const environment = (await storage.getEnvironment(environmentId))!;
  await storage.updateEnvironment(environmentId, { ...environment, status: "stopped" });

  await expect(launch(request("review-1"), context)).rejects.toThrow(
    "Start the environment and finish setup",
  );
  expect(start).not.toHaveBeenCalled();
  expect(await storage.getMultiReviewWorkflow("review-1")).toBeNull();
});

test("future Address Findings choices reach the button start and override saved automation", async () => {
  const config = await storage.loadConfig();
  await storage.saveConfig({
    ...config,
    global: {
      ...config.global,
      agentSettings: {
        ...config.global.agentSettings,
        multiReview: { ...config.global.agentSettings?.multiReview, autoFix: true },
      },
    },
  });
  const addressModel = { agent: "claude", model: "address-model" };
  const { fixModel: _formerModel, ...input } = request("future-review").input;
  const result = (await launch(
    {
      reservedId: "future-review",
      input: { ...input, addressFindingsModel: addressModel, autoAddressFindings: false },
    },
    context,
  )) as MultiReviewActionResult;

  expect(result.ui.status).toBe("opened");
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]![0]).toMatchObject({ fixModel: addressModel, autoFix: false });
  expect(start.mock.calls[0]![0]).not.toHaveProperty("addressFindingsModel");
  expect(start.mock.calls[0]![0]).not.toHaveProperty("autoAddressFindings");
});

for (const malformed of [
  { addressFindingsModel: { agent: "unknown" } },
  { addressFindingsModel: row, autoAddressFindings: "false" },
]) {
  test(`the button rejects malformed future choices ${JSON.stringify(malformed)} before starting`, async () => {
    const { fixModel: _formerModel, ...input } = request("invalid-future-review").input;
    await expect(
      launch({ reservedId: "invalid-future-review", input: { ...input, ...malformed } }, context),
    ).rejects.toThrow("Invalid Multi Review button action");
    expect(start).not.toHaveBeenCalled();
    expect(await storage.getMultiReviewWorkflow("invalid-future-review")).toBeNull();
  });
}
