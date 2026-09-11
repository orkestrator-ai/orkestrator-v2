/**
 * Attaching, resuming, and replaying an existing agent's history.
 *
 * Resume is the path a user reaches through the session picker, and its replay
 * is best-effort by design — the model keeps its own context regardless of what
 * this transcript shows, so a history read that fails must still leave a
 * working session rather than a failed resume. That "degrade, never throw"
 * rule is only worth anything if it is actually exercised, which is what this
 * file does.
 *
 * SDK surfaces are injected through the bridge's test seams so this owner is
 * independent of Bun's process-wide module registry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Agent, type CursorAgentPlatform, type LocalAgentStore } from "@cursor/sdk";
import { join } from "node:path";
import { tmpdir } from "node:os";

const previousApiKey = process.env.CURSOR_API_KEY;
const previousStateDir = process.env.CURSOR_BRIDGE_STATE_DIR;
const previousCredentialFile = process.env.CURSOR_BRIDGE_AUTH_FILE;
const previousExecutionPolicy = process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
const bridgeStateRoot = join(tmpdir(), `cursor-bridge-sdk-test-${process.pid}`);
process.env.CURSOR_BRIDGE_STATE_DIR = bridgeStateRoot;
process.env.CURSOR_BRIDGE_AUTH_FILE = join(bridgeStateRoot, "missing-auth.json");

let listed: { items: unknown[] } = { items: [] };
let runs: { items: unknown[] } = { items: [] };
let listRunsFails = false;
let resumeFails = false;
const created: Array<Record<string, unknown>> = [];
const resumed: string[] = [];
const resumedOptions: Array<Record<string, unknown>> = [];
let storedRuns: Array<Record<string, unknown>> = [];
const deletedRunBatches: string[][] = [];
let updatedAgent: Record<string, unknown> | undefined;
const configuredStores: unknown[] = [];
const platformOptions: Array<Record<string, unknown>> = [];
const prewarmOptions: Array<Record<string, unknown>> = [];
const sandboxBootstrapOptions: Array<Record<string, unknown>> = [];
let prewarmFails = false;
let warmWorkspaceReleases = 0;

function fakeSdkAgent(agentId: string) {
  return {
    agentId,
    send: async () => undefined,
    getUsage: async () => ({
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 100,
      },
      cost: { rawCostCents: 5, chargedCents: 5 },
      runs: [],
    }),
    [Symbol.asyncDispose]: async () => undefined,
  };
}

class FakeJsonlLocalAgentStore {
  readonly agents = {
    get: async () => ({ agentId: "agent-1", latestCheckpoint: "latest" }),
    update: async ({ agent }: { agent: Record<string, unknown> }) => {
      updatedAgent = agent;
    },
  };
  readonly checkpoints = {};
  readonly runs = {
    list: async () => ({ items: storedRuns, nextCursor: undefined }),
    delete: async ({ filter }: { filter: { runIds: string[] } }) => {
      deletedRunBatches.push(filter.runIds);
    },
  };
  readonly runEvents = { delete: async () => undefined };

  constructor(_root: string) {}
}

const createTestPlatform = async (options: Record<string, unknown>) => {
  platformOptions.push(options);
  return {
    prewarmLocalWorkspace: async (options: Record<string, unknown>) => {
      // Sandbox discovery has no model, tools or MCP configuration and
      // releases its own lease before the session's workspace is warmed.
      if (!("model" in options)) {
        sandboxBootstrapOptions.push(options);
        return async () => {};
      }
      prewarmOptions.push(options);
      if (prewarmFails) throw new Error("workspace scan unavailable");
      return async () => {
        warmWorkspaceReleases += 1;
      };
    },
  };
};

const testAgent = {
  create: async (options: Record<string, unknown>) => {
    created.push(options);
    return fakeSdkAgent("created-agent");
  },
  resume: async (agentId: string, options: Record<string, unknown>) => {
    resumed.push(agentId);
    resumedOptions.push(options);
    if (resumeFails) throw new Error("no such agent");
    return fakeSdkAgent(agentId);
  },
  list: async () => listed,
  listRuns: async () => {
    if (listRunsFails) throw new Error("history unavailable");
    return runs;
  },
} as unknown as typeof Agent;

const { MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_TITLE_BYTES, workingDirectory } =
  await import("./config.js");
const {
  applyComposerPatch,
  createSession,
  cursorDeniedTools,
  detachAgent,
  ensureAgent,
  listResumableSessions,
  newSessionState,
  resolveCursorExecutionPolicy,
  resumeSession,
  rewindSessionHistory,
  useCursorAgentForTests,
} = await import("./agent-session.js");
const { refreshAgentUsage } = await import("./prompt.js");
const {
  resetCursorSandboxBootstrapForTests,
  useCursorLocalAgentStoreForTests,
  useCursorSdkRuntimeForTests,
} = await import("./sdk-runtime.js");
const { resetPlanAccountWindowsForTests } = await import("./plan-usage.js");
const { useCursorModelsForTests } = await import("./models.js");
const { clientSessionKeys, sessions } = await import("./state.js");

const testStore = new FakeJsonlLocalAgentStore(
  join(bridgeStateRoot, "cursor-sdk"),
) as unknown as LocalAgentStore;
let restoreAgent: () => void;
let restoreModels: () => void;
let restoreRuntime: () => void;
let previousStore: LocalAgentStore;

beforeAll(() => {
  restoreAgent = useCursorAgentForTests(testAgent);
  restoreModels = useCursorModelsForTests({
    list: async () => [],
  } as typeof import("@cursor/sdk").Cursor.models);
  restoreRuntime = useCursorSdkRuntimeForTests({
    configureStore: (store) => configuredStores.push(store),
    createPlatform:
      createTestPlatform as unknown as typeof import("@cursor/sdk").createAgentPlatform,
  });
  previousStore = useCursorLocalAgentStoreForTests(testStore);
});

beforeEach(() => {
  resetPlanAccountWindowsForTests();
  // The barrier is primed once per process by design, so without this only
  // the first attaching test could observe whether an attach primes it.
  resetCursorSandboxBootstrapForTests();
  sessions.clear();
  clientSessionKeys.clear();
  process.env.CURSOR_API_KEY = "test-key";
  listed = { items: [] };
  runs = { items: [] };
  listRunsFails = false;
  resumeFails = false;
  created.length = 0;
  resumed.length = 0;
  resumedOptions.length = 0;
  storedRuns = [];
  deletedRunBatches.length = 0;
  updatedAgent = undefined;
  prewarmOptions.length = 0;
  sandboxBootstrapOptions.length = 0;
  prewarmFails = false;
  warmWorkspaceReleases = 0;
  delete process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
});

test("restoring injected runtime dependencies reinstates the prior SDK configure callback", () => {
  const innerConfigured: unknown[] = [];
  const restore = useCursorSdkRuntimeForTests({
    configureStore: (store) => innerConfigured.push(store),
    createPlatform:
      createTestPlatform as unknown as typeof import("@cursor/sdk").createAgentPlatform,
  });
  const replacement = new FakeJsonlLocalAgentStore("unused") as unknown as LocalAgentStore;
  const replaced = useCursorLocalAgentStoreForTests(replacement);
  expect(innerConfigured).toEqual([replacement]);

  restore();
  const configuredBeforeRestore = configuredStores.length;
  useCursorLocalAgentStoreForTests(replaced);
  expect(configuredStores.slice(configuredBeforeRestore)).toEqual([testStore]);
});

describe("rewindSessionHistory", () => {
  test("uses the selected message run id instead of its bounded transcript position", async () => {
    const state = newSessionState();
    state.agentId = "agent-1";
    state.droppedMessages = 20;
    state.transcriptTruncated = true;
    state.messages = [
      {
        id: "selected",
        role: "user",
        content: "later",
        parts: [],
        createdAt: "now",
        runId: "run-2",
      },
      { id: "answer", role: "assistant", content: "ok", parts: [], createdAt: "now" },
    ];
    storedRuns = [
      { runId: "unsupported", turnNumber: 0, startCheckpointRef: "cp-0" },
      { runId: "run-1", turnNumber: 1, startCheckpointRef: "cp-1" },
      { runId: "run-2", turnNumber: 2, startCheckpointRef: "cp-2" },
      { runId: "run-3", turnNumber: 3, startCheckpointRef: "cp-3" },
    ];

    await rewindSessionHistory(state, "selected");

    expect(updatedAgent?.latestCheckpoint).toBe("cp-2");
    expect(deletedRunBatches).toEqual([["run-2", "run-3"]]);
  });

  test("fails closed when a message has no originating run id", async () => {
    const state = newSessionState();
    state.agentId = "agent-1";
    state.messages = [{ id: "legacy", role: "user", content: "old", parts: [], createdAt: "now" }];

    await expect(rewindSessionHistory(state, "legacy")).rejects.toThrow("cannot safely map");
    expect(deletedRunBatches).toEqual([]);
  });
});

test("a Cursor model change clears parameters from the previous model", () => {
  const state = newSessionState();
  state.composer.selectedModelId = "model-a";
  state.composer.parameterValues = { variant: "special", thinking: "high" };

  applyComposerPatch(state, { modelId: "model-b" });

  expect(state.composer.parameterValues).toEqual({});
});

afterAll(() => {
  sessions.clear();
  restoreRuntime();
  useCursorLocalAgentStoreForTests(previousStore);
  restoreModels();
  restoreAgent();
  if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = previousApiKey;
  if (previousStateDir === undefined) delete process.env.CURSOR_BRIDGE_STATE_DIR;
  else process.env.CURSOR_BRIDGE_STATE_DIR = previousStateDir;
  if (previousCredentialFile === undefined) delete process.env.CURSOR_BRIDGE_AUTH_FILE;
  else process.env.CURSOR_BRIDGE_AUTH_FILE = previousCredentialFile;
  if (previousExecutionPolicy === undefined) delete process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY;
  else process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = previousExecutionPolicy;
});

/** A conversation turn in the shape `run.conversation()` returns. */
function conversationRun(turns: unknown[], supports = true) {
  return {
    supports: () => supports,
    conversation: async () => turns,
  };
}

/** The container boundary a pipeline session runs behind. */
const containerPolicy = {
  id: "pipeline",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "restricted",
} as const;

describe("ensureAgent", () => {
  test("translates denied capabilities into Cursor's SDK tool vocabulary", () => {
    expect(
      cursorDeniedTools({
        id: "pipeline",
        sandbox: "provider",
        approvals: "auto-approve",
        projectResources: false,
        capabilityPolicy: {
          deny: ["file.write", "file.patch", "shell.mutate", "network"],
        },
        toolPolicy: { deny: ["Write", "apply_patch", "unknown-provider-tool"] },
        networkAccess: "restricted",
      }),
    ).toEqual(["edit", "delete", "applyAgentDiff", "task", "shell", "webFetch", "webSearch"]);
  });

  test("refuses to attach without a credential, with a message naming the fix", async () => {
    delete process.env.CURSOR_API_KEY;
    const state = newSessionState();
    expect(ensureAgent(state)).rejects.toThrow(/Settings/);
  });

  /**
   * Attach is reachable from the prompt route, the config route and the
   * explicit attach route, so two callers racing is ordinary rather than a
   * corner case. Without the shared in-flight promise each would see a null
   * agent and start a second one.
   */
  test("two concurrent callers share one attach", async () => {
    const state = newSessionState();
    const [first, second] = await Promise.all([ensureAgent(state), ensureAgent(state)]);
    expect(first).toBe(second);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ local: { cwd: workingDirectory } });
    expect(platformOptions).toEqual([
      expect.objectContaining({
        localStore: testStore,
        workspaceRef: workingDirectory,
        scopedWorkspaceRef: workingDirectory,
      }),
    ]);
    expect(prewarmOptions).toHaveLength(1);
    const { name: _name, ...createdOptions } = created[0]!;
    expect(prewarmOptions[0]).toEqual(createdOptions);
    expect(prewarmOptions[0]).toMatchObject({
      local: { sandboxOptions: { enabled: true } },
    });
    expect(state.workspaceWarmRelease).toBeFunction();
    // The session's own warm-up is sandbox-enabled and registers the helper,
    // so no probe precedes it. Probing anyway would repeat the workspace scan,
    // the dominant cost of the first attach on a large checkout.
    expect(sandboxBootstrapOptions).toEqual([]);

    await detachAgent(state);
    expect(warmWorkspaceReleases).toBe(1);
    expect(state.workspaceWarmRelease).toBeUndefined();
  });

  test("primes sandbox discovery before an unsandboxed preparation", async () => {
    const state = newSessionState(undefined, {
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: false,
      networkAccess: "full",
    });

    await ensureAgent(state);

    expect(sandboxBootstrapOptions).toEqual([
      {
        apiKey: "test-key",
        local: {
          cwd: workingDirectory,
          settingSources: [],
          sandboxOptions: { enabled: true },
          autoReview: false,
        },
      },
    ]);
    expect(prewarmOptions).toHaveLength(1);

    await detachAgent(state);
    expect(warmWorkspaceReleases).toBe(1);
    expect(state.workspaceWarmRelease).toBeUndefined();
  });

  test("a provider attach leaves the barrier available for a later unsandboxed attach", async () => {
    const providerState = newSessionState();
    const unsandboxedState = newSessionState(undefined, {
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: false,
      networkAccess: "full",
    });

    await ensureAgent(providerState);
    expect(prewarmOptions[0]).toMatchObject({
      local: { sandboxOptions: { enabled: true } },
    });
    expect(sandboxBootstrapOptions).toEqual([]);

    await ensureAgent(unsandboxedState);
    expect(prewarmOptions[1]).toMatchObject({
      local: { sandboxOptions: { enabled: false } },
    });
    expect(sandboxBootstrapOptions).toHaveLength(1);

    await Promise.all([detachAgent(providerState), detachAgent(unsandboxedState)]);
    expect(warmWorkspaceReleases).toBe(2);
  });

  test("continues attaching when the optional workspace warm-up fails", async () => {
    const state = newSessionState();
    prewarmFails = true;

    await expect(ensureAgent(state)).resolves.toMatchObject({ agentId: "created-agent" });
    expect(prewarmOptions).toHaveLength(1);
    expect(state.workspaceWarmRelease).toBeUndefined();
  });

  test("reports unsupported approval semantics and fails deny-mode escalation closed", async () => {
    const ask = resolveCursorExecutionPolicy({
      id: "interactive-host",
      sandbox: "provider",
      approvals: "ask",
      projectResources: false,
      networkAccess: "full",
    });
    expect(ask.approvals).toBe("auto-approve");
    expect(ask.note).toContain("cannot surface interactive approvals");

    const denied = newSessionState(undefined, {
      id: "interactive-host",
      sandbox: "provider",
      approvals: "deny",
      projectResources: false,
      networkAccess: "restricted",
    });
    await expect(ensureAgent(denied)).rejects.toThrow("refused before attach");
    expect(created).toHaveLength(0);
  });

  test("forces the provider sandbox for restricted network policy", () => {
    const effective = resolveCursorExecutionPolicy({
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: false,
      networkAccess: "restricted",
    });
    expect(effective.sandbox).toBe("provider");
    expect(effective.note).toContain("restricted network access");
  });

  test("uses an SDK-valid allowlist with the outer container boundary for read-only sessions", async () => {
    const state = newSessionState(undefined, {
      id: "pipeline",
      sandbox: "container",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "restricted",
    });
    state.readOnly = true;

    await ensureAgent(state);

    expect(created[0]).toMatchObject({
      local: {
        sandboxOptions: { enabled: false },
      },
      tools: [
        "read",
        "grep",
        "glob",
        "ls",
        "readLints",
        "semSearch",
        "readTodos",
        "askQuestion",
        "await",
      ],
    });
    expect(created[0]).not.toHaveProperty("disallowedTools");
    expect(sandboxBootstrapOptions).toHaveLength(0);
  });

  test("local read-only reviews retain the provider sandbox and closed tool allowlist", async () => {
    const state = newSessionState(undefined, {
      id: "pipeline",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: false,
      networkAccess: "full",
    });
    state.readOnly = true;

    await ensureAgent(state);

    for (const tool of ["shell", "edit", "task", "webFetch", "webSearch"]) {
      expect(created[0]?.tools).not.toContain(tool);
    }
    expect(created[0]).toMatchObject({
      local: { sandboxOptions: { enabled: true }, autoReview: false },
      tools: expect.arrayContaining(["read", "grep", "glob", "ls"]),
    });
  });

  test("the coordinator process override does not re-enable a nested container sandbox", async () => {
    process.env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY = "coordinator-read-only";
    const state = newSessionState(undefined, {
      id: "pipeline",
      sandbox: "container",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "restricted",
    });
    state.readOnly = true;

    await ensureAgent(state);

    expect(created[0]).toMatchObject({
      local: { sandboxOptions: { enabled: false } },
      tools: expect.arrayContaining(["read", "grep", "glob", "ls"]),
    });
  });

  test("a session created read-only warms its first agent behind the allowlist", async () => {
    const state = await createSession(undefined, undefined, containerPolicy, true);

    await ensureAgent(state);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      local: { sandboxOptions: { enabled: false } },
      tools: expect.arrayContaining(["read", "grep", "glob", "ls"]),
    });
    expect(created[0]).not.toHaveProperty("disallowedTools");
    expect(created[0]?.tools).not.toEqual(expect.arrayContaining(["write", "shell"]));
  });

  test("a replacement agent for a read-only session resumes behind the allowlist", async () => {
    const state = await createSession("tab-1", undefined, containerPolicy, false);
    await ensureAgent(state);
    expect(created[0]?.tools).toBeUndefined();

    // What the create route and the prompt route both do when the boundary
    // moves: drop the agent, then let the next attach rebuild it.
    await detachAgent(state);
    state.readOnly = true;
    await ensureAgent(state);

    // The session already holds an agent id, so the replacement comes back
    // through resume — which has to carry the new boundary just as create does.
    expect(resumed).toEqual(["created-agent"]);
    expect(resumedOptions[0]?.tools).toEqual(
      expect.arrayContaining(["read", "grep", "glob", "ls"]),
    );
    expect(resumedOptions[0]).not.toHaveProperty("disallowedTools");
  });

  test("a failed attach does not poison the next one", async () => {
    const state = newSessionState();
    delete process.env.CURSOR_API_KEY;
    await ensureAgent(state).catch(() => undefined);
    process.env.CURSOR_API_KEY = "test-key";
    await expect(ensureAgent(state)).resolves.toMatchObject({ agentId: "created-agent" });
  });

  test("resumes the agent id it already holds, keeping the model's own context", async () => {
    const state = newSessionState();
    state.agentId = "prior-agent";
    await ensureAgent(state);
    expect(resumed).toEqual(["prior-agent"]);
    expect(created).toHaveLength(0);
  });

  /**
   * The id may name an agent the store no longer has. A new agent carrying the
   * transcript we already hold is a far better outcome than a tab that can
   * never send again.
   */
  test("a resume that fails falls back to a new agent rather than failing the tab", async () => {
    const state = newSessionState();
    state.agentId = "gone";
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      sessionTokens: 1_000,
      sessionTokenFloor: 1_100,
      costUsd: 0.4,
      updatedAt: new Date(1).toISOString(),
    };
    const revision = state.revision;
    resumeFails = true;
    const replacement = await ensureAgent(state);
    expect(replacement).toMatchObject({ agentId: "created-agent" });
    expect(state.agentId).toBe("created-agent");
    expect(state.usage).toMatchObject({
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });
    expect(state.usage?.sessionTokens).toBeUndefined();
    expect(state.usage?.sessionTokenFloor).toBeUndefined();
    expect(state.usage?.costUsd).toBeUndefined();
    expect(state.revision).toBe(revision + 1);

    expect(await refreshAgentUsage(state, replacement, state.promptSequence, 100, 100)).toBe(
      "retry",
    );
    expect(state.usage?.sessionTokens).toBe(100);
    expect(state.usage?.costUsd).toBe(0.05);
  });
});

describe("listResumableSessions", () => {
  test("restoring an injected Agent reinstates the prior session catalogue", async () => {
    listed = { items: [{ agentId: "outer", status: "idle" }] };
    const restore = useCursorAgentForTests({
      ...testAgent,
      list: async () => ({ items: [{ agentId: "inner", status: "idle" }] }),
    } as typeof Agent);

    try {
      expect(await listResumableSessions()).toEqual([{ id: "inner", status: "idle" }]);
    } finally {
      restore();
    }

    expect(await listResumableSessions()).toEqual([{ id: "outer", status: "idle" }]);
  });

  test("is empty rather than an error when nothing is signed in", async () => {
    delete process.env.CURSOR_API_KEY;
    expect(await listResumableSessions()).toEqual([]);
  });

  test("normalizes an entry onto the shared resume shape", async () => {
    listed = {
      items: [
        {
          agentId: "a1",
          name: "  Fix the parser  ",
          createdAt: 1_000,
          lastModified: 2_000,
          status: "running",
          summary: "  did things  ",
        },
      ],
    };
    expect(await listResumableSessions()).toEqual([
      {
        id: "a1",
        title: "Fix the parser",
        createdAt: new Date(1_000).toISOString(),
        updatedAt: new Date(2_000).toISOString(),
        status: "running",
        detail: "did things",
      },
    ]);
  });

  test("maps an unrecognized status to idle rather than passing it through", async () => {
    listed = { items: [{ agentId: "a1", status: "something-new" }] };
    expect(await listResumableSessions()).toEqual([{ id: "a1", status: "idle" }]);
  });
});

describe("resumeSession", () => {
  test("replays user text, assistant prose, reasoning and tool calls", async () => {
    runs = {
      items: [
        conversationRun([
          {
            type: "conversationTurn",
            turn: {
              userMessage: { text: "what changed?" },
              steps: [
                { type: "thinkingMessage", message: { text: "considering" } },
                { type: "assistantMessage", message: { text: "One file." } },
                {
                  type: "toolCall",
                  message: {
                    type: "read",
                    args: { path: "a.ts" },
                    result: { status: "success", value: { content: "body" } },
                  },
                },
              ],
            },
          },
        ]),
      ],
    };

    const state = await resumeSession("agent-1", undefined);

    expect(state.agentId).toBe("agent-1");
    expect(sessions.get(state.id)).toBe(state);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "what changed?" });

    const assistant = state.messages[1]!;
    // Only prose belongs in the flat body; reasoning is its own part and tool
    // calls are their own cards.
    expect(assistant.content).toBe("One file.");
    expect(assistant.parts.map((part) => part.type)).toEqual([
      "thinking",
      "text",
      "tool-invocation",
    ]);
    expect(assistant.parts[2]).toMatchObject({ toolName: "read", toolState: "success" });
    expect(assistant.planReview).toBeUndefined();
  });

  test("historic createPlan turns are marked for plan review", async () => {
    runs = {
      items: [
        conversationRun([
          {
            type: "conversationTurn",
            turn: {
              userMessage: { text: "plan the split" },
              steps: [
                {
                  type: "toolCall",
                  message: {
                    type: "createPlan",
                    args: { plan: "# Split\n\nDo it." },
                    result: { status: "success", value: {} },
                  },
                },
              ],
            },
          },
        ]),
      ],
    };

    const state = await resumeSession("agent-1", undefined);
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({ planReview: true });
    expect(assistant?.parts[0]).toMatchObject({
      toolName: "createPlan",
      toolOutput: "# Split\n\nDo it.",
    });
    expect(assistant?.parts[0]).not.toMatchObject({ toolArgs: { plan: expect.anything() } });
  });

  test("historic createPlan variants are marked consistently with the renderer", async () => {
    runs = {
      items: [
        conversationRun([
          {
            type: "conversationTurn",
            turn: {
              steps: ["CreatePlan", "create_plan"].map((type) => ({
                type: "toolCall",
                message: {
                  type,
                  args: { plan: `# ${type}\n\nDo it.` },
                  result: { status: "success", value: {} },
                },
              })),
            },
          },
        ]),
      ],
    };

    const state = await resumeSession("agent-1", undefined);
    const assistant = state.messages.find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({ planReview: true });
    expect(
      assistant?.parts.map((part) => part.type === "tool-invocation" && part.toolName),
    ).toEqual(["CreatePlan", "create_plan"]);
  });

  test("historic createPlan metadata stays inside the configured byte bounds", async () => {
    runs = {
      items: [
        conversationRun([
          {
            type: "conversationTurn",
            turn: {
              steps: [
                {
                  type: "toolCall",
                  message: {
                    type: "createPlan",
                    args: { name: "n".repeat(MAX_TOOL_TITLE_BYTES * 2), plan: "# Plan" },
                    result: { status: "success", value: {} },
                  },
                },
                {
                  type: "toolCall",
                  message: {
                    type: "createPlan",
                    args: { plan: `# ${"h".repeat(MAX_TOOL_TITLE_BYTES * 2)}` },
                    result: { status: "success", value: {} },
                  },
                },
              ],
            },
          },
        ]),
      ],
    };

    const state = await resumeSession("agent-1", undefined);
    const assistant = state.messages.find((message) => message.role === "assistant");
    const plans = assistant?.parts.filter((part) => part.type === "tool-invocation") ?? [];
    expect(plans).toHaveLength(2);
    expect(
      plans.every((plan) => Buffer.byteLength(plan.toolTitle ?? "") <= MAX_TOOL_TITLE_BYTES),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(plans[0]!.toolArgs))).toBeLessThanOrEqual(
      MAX_TOOL_ARGUMENT_BYTES,
    );
    expect(plans[1]!.toolArgs).toBeUndefined();
  });

  test("settles replayed sub-agents rather than showing them as running", async () => {
    runs = {
      items: [
        conversationRun([
          {
            type: "conversationTurn",
            turn: {
              steps: [
                {
                  type: "toolCall",
                  message: {
                    type: "task",
                    args: { description: "audit" },
                    result: { status: "success", value: { isBackground: true } },
                  },
                },
              ],
            },
          },
        ]),
      ],
    };

    const state = await resumeSession("agent-1", undefined);
    // Replayed history is settled by definition: whatever these children were
    // doing, they are not doing it on this bridge's watch.
    expect(state.messages[0]!.parts[0]).toMatchObject({ agentState: "finished" });
    expect(state.activeSubagentDescriptors.size).toBe(0);
  });

  test("renders a shell turn from its own record", async () => {
    runs = {
      items: [
        conversationRun([
          {
            type: "shellConversationTurn",
            turn: {
              shellCommand: { command: "bun test" },
              shellOutput: { stdout: "ok" },
            },
          },
        ]),
      ],
    };

    const state = await resumeSession("agent-1", undefined);
    expect(state.messages[0]!.parts[0]).toMatchObject({
      toolName: "shell",
      toolState: "success",
    });
  });

  test("skips a run whose conversation the SDK says it cannot serve", async () => {
    runs = { items: [conversationRun([{ type: "conversationTurn", turn: {} }], false)] };
    const state = await resumeSession("agent-1", undefined);
    expect(state.messages).toEqual([]);
  });

  /**
   * A resumed conversation whose history could not be read is still a working
   * session, so a failed replay degrades to an empty transcript rather than a
   * failed resume.
   */
  test("a history read that throws still yields a usable session", async () => {
    listRunsFails = true;
    const state = await resumeSession("agent-1", undefined);
    expect(state.agentId).toBe("agent-1");
    expect(state.messages).toEqual([]);
    expect(sessions.get(state.id)).toBe(state);
  });

  test("a malformed turn is ignored rather than fatal", async () => {
    runs = {
      items: [conversationRun([null, "nonsense", { type: "conversationTurn" }, { turn: 7 }])],
    };
    const state = await resumeSession("agent-1", undefined);
    expect(state.messages).toEqual([]);
  });

  test("carries the caller's composer selection into the resumed session", async () => {
    const state = await resumeSession("agent-1", { modelId: "composer-2.5", modeId: "plan" });
    expect(state.composer.selectedModelId).toBe("composer-2.5");
    expect(state.composer.selectedModeId).toBe("plan");
  });

  test("applies the backend policy before adopting a resumed agent", async () => {
    const state = await resumeSession("agent-1", undefined, {
      id: "interactive-container",
      sandbox: "container",
      approvals: "deny",
      projectResources: true,
      networkAccess: "restricted",
    });
    expect(state.policy).toMatchObject({
      id: "interactive-container",
      approvals: "deny",
      projectResources: true,
    });
  });
});
