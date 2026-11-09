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

/**
 * `get_multi_review_launch_defaults`: the rows a plain click runs, resolved by
 * this node from its saved settings and its own catalogue, for the configure
 * dialog. A window's stale copy of the catalogue never decides a model.
 */
test("launch defaults resolve saved rows against this node's own catalogue", async () => {
  const config = await storage.loadConfig();
  await storage.saveConfig({
    ...config,
    global: {
      ...config.global,
      enabledAgentPlatforms: ["claude", "codex"],
      agentSettings: {
        ...config.global.agentSettings,
        // A model this node's login no longer serves, and one it does.
        platforms: { codex: { mode: "native", model: "gpt-5.4", reasoningEffort: "high" } },
        actionDefaults: {
          review: { platform: "codex" },
          review2: { platform: "claude" },
          reviewPreparation: { platform: "codex", model: "gpt-6-luna" },
        },
        multiReview: { autoFix: true },
      },
    },
  });
  const registry = createCommandRegistry();
  // This node's own catalogue for the environment: what its login serves.
  const catalogue = mock(async () => [
    { platform: "codex", id: "gpt-6.1-sol", label: "GPT-6.1-Sol", reasoning: [{ id: "high" }] },
    { platform: "codex", id: "gpt-6-luna", label: "GPT-6-Luna", reasoning: [{ id: "high" }] },
  ]);
  registry.set("get_native_agent_model_catalog", catalogue as unknown as CommandHandler);
  const read = registry.get("get_multi_review_launch_defaults")!;

  const defaults = (await read({ environmentId }, context)) as Record<string, unknown>;

  expect(defaults).toMatchObject({
    // The stale saved `gpt-5.4` becomes the catalogue's first model here.
    reviewers: [
      { agent: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" },
      { agent: "claude" },
    ],
    reviewModel: { agent: "codex", model: "gpt-6-luna", reasoningEffort: "high" },
    fixModel: { agent: "codex", model: "gpt-6.1-sol" },
    autoFix: true,
    autoPr: false,
  });
  expect(catalogue).toHaveBeenCalledWith({ environmentId }, context);
  expect(start).not.toHaveBeenCalled();
});

test("a plain click's omitted rows start on exactly the dialog's defaults", async () => {
  const registry = createCommandRegistry();
  const defaults = (await registry.get("get_multi_review_launch_defaults")!(
    { environmentId },
    context,
  )) as Record<string, unknown>;

  await launch(
    { input: { requestId: "plain-click", environmentId }, reservedId: "plain-click" },
    context,
  );

  const started = start.mock.calls[0]![0];
  expect({
    reviewers: started.reviewers,
    reviewModel: started.reviewModel,
    fixModel: started.fixModel,
    autoFix: started.autoFix,
    autoPr: started.autoPr,
  }).toEqual(defaults as never);
});

test("launch defaults refuse an environment this node does not have", async () => {
  const read = createCommandRegistry().get("get_multi_review_launch_defaults")!;
  await expect(read({ environmentId: "missing" }, context)).rejects.toThrow(
    "That environment does not exist on this node.",
  );
});
