/** Real SDK lifecycle/store; only model lookup and executor startup are stubbed. */
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as sdk from "@cursor/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdkSnapshot = { ...sdk };
const previousStateDir = process.env.CURSOR_BRIDGE_STATE_DIR;
const previousApiKey = process.env.CURSOR_API_KEY;
const root = await mkdtemp(join(tmpdir(), "cursor-initial-run-"));
process.env.CURSOR_BRIDGE_STATE_DIR = root;
process.env.CURSOR_API_KEY = "test-key";

let platform: sdk.CursorAgentPlatform;
const createdOptions: sdk.AgentOptions[] = [];
mock.module("@cursor/sdk", () => ({
  ...sdkSnapshot,
  Agent: {
    ...sdkSnapshot.Agent,
    create: async (options: sdk.AgentOptions) => {
      createdOptions.push(options);
      return platform.createAgent(options);
    },
    resume: (id: string, options: sdk.AgentOptions) => platform.resumeAgent(id, options),
  },
  createAgentPlatform: async () => ({ prewarmLocalWorkspace: async () => undefined }),
}));

const { cursorLocalAgentStore, hasUnusedInitialRun } = await import("./sdk-runtime.js");
const { newSessionState, ensureAgent, detachAgent } = await import("./agent-session.js");
const { resetPlanAccountWindowsForTests } = await import("./plan-usage.js");
platform = await sdkSnapshot.createAgentPlatform({
  localStore: cursorLocalAgentStore,
  workspaceRef: root,
  scopedWorkspaceRef: root,
});
platform.resolveLocalModelSelection = async (selection) => selection;
const executorBoundary = new Error("Reached the test executor");
platform.acquireLocalExecutor = async () => {
  throw executorBoundary;
};

beforeEach(() => {
  createdOptions.length = 0;
  resetPlanAccountWindowsForTests();
});

afterAll(async () => {
  mock.module("@cursor/sdk", () => sdkSnapshot);
  if (previousStateDir === undefined) delete process.env.CURSOR_BRIDGE_STATE_DIR;
  else process.env.CURSOR_BRIDGE_STATE_DIR = previousStateDir;
  if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = previousApiKey;
  await rm(root, { recursive: true, force: true });
});

function session() {
  return newSessionState(undefined, {
    id: "pipeline",
    sandbox: "container",
    approvals: "auto-approve",
    projectResources: false,
    networkAccess: "restricted",
  });
}

test("replaces an unused warm agent when a read-only prompt changes its policy", async () => {
  const state = session();
  const first = await ensureAgent(state);
  expect(await ensureAgent(state)).toBe(first);
  expect(await hasUnusedInitialRun(first.agentId)).toBe(true);
  // The real SDK reserves a run at create, and resume cannot admit another.
  await expect(platform.store.createFollowUpRun(first.agentId)).rejects.toThrow(
    "already has active run",
  );
  await detachAgent(state);
  state.readOnly = true;

  const replacement = await ensureAgent(state);
  expect(replacement.agentId).not.toBe(first.agentId);
  expect(state.agentId).toBe(replacement.agentId);
  expect(createdOptions.at(-1)?.tools).toContain("read");
  expect(createdOptions.at(-1)?.tools).not.toContain("shell");
  // Exercise send admission with the real SDK. Stop at executor acquisition,
  // before any model call: the placeholder must no longer reject the prompt.
  await expect(replacement.send("Review the test fixture")).rejects.toThrow(
    executorBoundary.message,
  );
  // Replacing an unused handle never deletes the SDK's durable records.
  expect(await cursorLocalAgentStore.agents.get({ agentId: first.agentId })).toBeDefined();
  await detachAgent(state);
});

test("repairs a placeholder restored after a bridge restart without changing the bridge session", async () => {
  const previous = session();
  const first = await ensureAgent(previous);
  await detachAgent(previous);
  const restored = session();
  restored.agentId = first.agentId;
  restored.readOnly = true;
  const id = restored.id;
  const replacement = await ensureAgent(restored);
  expect(replacement.agentId).not.toBe(first.agentId);
  expect(restored.id).toBe(id);
  await detachAgent(restored);
});

test.each([
  { status: "running" as const },
  { status: "finished" as const },
  { requestId: "dispatched-request" },
  { startedAt: 1 },
  { endedAt: 1 },
  { turnNumber: 2 },
  { startCheckpointRef: { schemaVersion: 1 as const, rootBlobId: "checkpoint" } },
  { latestCheckpointRef: { schemaVersion: 1 as const, rootBlobId: "checkpoint" } },
])("does not replace a run with dispatch or conversation evidence: %j", async (patch) => {
  const state = session();
  const first = await ensureAgent(state);
  const agent = (await cursorLocalAgentStore.agents.get({ agentId: first.agentId }))!;
  const run = (await cursorLocalAgentStore.runs.get({
    agentId: first.agentId,
    runId: agent.activeRunId!,
  }))!;
  await cursorLocalAgentStore.runs.update({ run: { ...run, ...patch } });
  await detachAgent(state);
  expect(await hasUnusedInitialRun(first.agentId)).toBe(false);
  const resumed = await ensureAgent(state);
  expect(resumed.agentId).toBe(first.agentId);
  expect(createdOptions).toHaveLength(1);
  await detachAgent(state);
});

test("an unreadable reservation is not evidence that replacing the agent is safe", async () => {
  const state = session();
  const first = await ensureAgent(state);
  await detachAgent(state);
  const read = spyOn(cursorLocalAgentStore.runs, "get").mockRejectedValue(
    new Error("Store unavailable"),
  );
  try {
    await expect(ensureAgent(state)).rejects.toThrow("Store unavailable");
    expect(state.agentId).toBe(first.agentId);
    expect(createdOptions).toHaveLength(1);
  } finally {
    read.mockRestore();
  }
});
