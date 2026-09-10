/** Real SDK lifecycle/store; only model lookup and executor startup are stubbed. */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as sdk from "@cursor/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousStateDir = process.env.CURSOR_BRIDGE_STATE_DIR;
const previousApiKey = process.env.CURSOR_API_KEY;
const root = await mkdtemp(join(tmpdir(), "cursor-initial-run-"));
process.env.CURSOR_BRIDGE_STATE_DIR = root;

/**
 * The store is built here and installed in `beforeAll`, not selected through
 * `CURSOR_BRIDGE_STATE_DIR`. `sdk-runtime.js` is a process-wide singleton, so
 * direct injection keeps this owner independent of which suite imported it
 * first without replacing `@cursor/sdk` in Bun's shared module registry.
 */
const store: sdk.LocalAgentStore = new sdk.JsonlLocalAgentStore(join(root, "cursor-sdk"));

let platform: sdk.CursorAgentPlatform;
let listedAgents: sdk.SDKAgentInfo[] = [];
const createdOptions: sdk.AgentOptions[] = [];
const testAgent = {
  ...sdk.Agent,
  create: async (options: sdk.AgentOptions) => {
    createdOptions.push(options);
    return platform.createAgent(options);
  },
  resume: (id: string, options: sdk.AgentOptions) => platform.resumeAgent(id, options),
  list: async () => ({ items: listedAgents, nextCursor: undefined }),
} as typeof sdk.Agent;

const { hasUnusedInitialRun, useCursorLocalAgentStoreForTests, useCursorSdkRuntimeForTests } =
  await import("./sdk-runtime.js");
const { newSessionState, ensureAgent, detachAgent, listResumableSessions, useCursorAgentForTests } =
  await import("./agent-session.js");
const { resetPlanAccountWindowsForTests } = await import("./plan-usage.js");
platform = await sdk.createAgentPlatform({
  localStore: store,
  workspaceRef: root,
  scopedWorkspaceRef: root,
});
platform.resolveLocalModelSelection = async (selection) => selection;
const executorBoundary = new Error("Reached the test executor");
platform.acquireLocalExecutor = async () => {
  throw executorBoundary;
};

let replacedStore: sdk.LocalAgentStore;
let restoreAgent: () => void;
let restoreRuntime: () => void;

beforeAll(() => {
  restoreAgent = useCursorAgentForTests(testAgent);
  restoreRuntime = useCursorSdkRuntimeForTests({
    configureStore: (configuredStore) =>
      sdk.Cursor.configure({ local: { store: configuredStore } }),
    createPlatform: (async () => ({
      prewarmLocalWorkspace: async () => undefined,
    })) as unknown as typeof sdk.createAgentPlatform,
  });
  replacedStore = useCursorLocalAgentStoreForTests(store);
  process.env.CURSOR_API_KEY = "test-key";
});

beforeEach(() => {
  createdOptions.length = 0;
  listedAgents = [];
  resetPlanAccountWindowsForTests();
});

afterAll(async () => {
  restoreRuntime();
  useCursorLocalAgentStoreForTests(replacedStore);
  restoreAgent();
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

/** The active run the SDK reserved for an agent's first turn. */
async function reservation(agentId: string) {
  const agent = (await store.agents.get({ agentId }))!;
  const run = (await store.runs.get({ agentId, runId: agent.activeRunId! }))!;
  return { agent, run };
}

/** One picker row, carrying only the fields `listResumableSessions` reads. */
function listedAgent(agentId: string): sdk.SDKAgentInfo {
  return { agentId, name: "Orkestrator", status: "idle" } as unknown as sdk.SDKAgentInfo;
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
  expect(await store.agents.get({ agentId: first.agentId })).toBeDefined();
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

test("the transcript survives a replacement while agent-scoped usage is rebased", async () => {
  const state = session();
  const first = await ensureAgent(state);
  await detachAgent(state);
  state.messages = [{ id: "asked", role: "user", content: "hello", parts: [], createdAt: "now" }];
  // `getUsage()` is scoped to one SDK agent, so a replacement restarts these
  // counters from zero. Anything not scoped to the agent is history worth keeping.
  state.usage = {
    modelId: "model-x",
    sessionTokens: 100,
    sessionTokenFloor: 90,
    costUsd: 1.5,
    updatedAt: "then",
  };
  const revision = state.revision;
  state.readOnly = true;

  const replacement = await ensureAgent(state);

  expect(replacement.agentId).not.toBe(first.agentId);
  expect(state.messages).toHaveLength(1);
  expect(state.usage).toMatchObject({ modelId: "model-x" });
  expect(state.usage?.sessionTokens).toBeUndefined();
  expect(state.usage?.sessionTokenFloor).toBeUndefined();
  expect(state.usage?.costUsd).toBeUndefined();
  expect(state.revision).toBe(revision + 1);
  await detachAgent(state);
});

test("the picker stops offering a warm agent that was replaced before its first send", async () => {
  const state = session();
  const abandoned = await ensureAgent(state);
  await detachAgent(state);
  state.readOnly = true;
  const replacement = await ensureAgent(state);
  await detachAgent(state);
  // Give the replacement the dispatch evidence a real first turn would leave,
  // so the two rows differ only in whether anything ever ran on them.
  const { run } = await reservation(replacement.agentId);
  await store.runs.update({ run: { ...run, startedAt: 1 } });

  listedAgents = [listedAgent(abandoned.agentId), listedAgent(replacement.agentId)];

  expect((await listResumableSessions()).map((entry) => entry.id)).toEqual([replacement.agentId]);
});

test("a picker row whose reservation cannot be read is still offered", async () => {
  const state = session();
  const first = await ensureAgent(state);
  await detachAgent(state);
  listedAgents = [listedAgent(first.agentId)];
  const read = spyOn(store.runs, "get").mockRejectedValue(new Error("Store unavailable"));
  try {
    expect((await listResumableSessions()).map((entry) => entry.id)).toEqual([first.agentId]);
  } finally {
    read.mockRestore();
  }
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
  const { run } = await reservation(first.agentId);
  await store.runs.update({ run: { ...run, ...patch } });
  await detachAgent(state);
  expect(await hasUnusedInitialRun(first.agentId)).toBe(false);
  const resumed = await ensureAgent(state);
  expect(resumed.agentId).toBe(first.agentId);
  expect(createdOptions).toHaveLength(1);
  await detachAgent(state);
});

test("an agent the store has never heard of is not a replaceable reservation", async () => {
  expect(await hasUnusedInitialRun("agent-that-was-never-stored")).toBe(false);
});

test("an agent that is not idle is not a replaceable reservation", async () => {
  const state = session();
  const first = await ensureAgent(state);
  await detachAgent(state);
  const { agent } = await reservation(first.agentId);
  await store.agents.update({ agent: { ...agent, status: "running" } });

  expect(await hasUnusedInitialRun(first.agentId)).toBe(false);
});

test("a rewound conversation is not a replaceable reservation", async () => {
  const state = session();
  const first = await ensureAgent(state);
  await detachAgent(state);
  // What `rewindSessionHistory` leaves behind: an idle agent holding the
  // checkpoint the next turn must resume from. Its history is the whole point.
  const { agent } = await reservation(first.agentId);
  await store.agents.update({
    agent: { ...agent, latestCheckpoint: { schemaVersion: 1, rootBlobId: "checkpoint" } },
  });

  expect(await hasUnusedInitialRun(first.agentId)).toBe(false);
});

test("an unreadable reservation is not evidence that replacing the agent is safe", async () => {
  const state = session();
  const first = await ensureAgent(state);
  await detachAgent(state);
  const read = spyOn(store.runs, "get").mockRejectedValue(new Error("Store unavailable"));
  try {
    await expect(ensureAgent(state)).rejects.toThrow("Store unavailable");
    expect(state.agentId).toBe(first.agentId);
    expect(createdOptions).toHaveLength(1);
  } finally {
    read.mockRestore();
  }
});
