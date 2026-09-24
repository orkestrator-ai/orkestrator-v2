/**
 * What a saved MCP configuration change does to a live session's MCP state.
 *
 * Split from `agent-session.test.ts`, which is near the repository's file-size
 * limit. Two rules are pinned here:
 *
 * - A configuration reattach retires the previous generation's MCP evidence,
 *   so a server the edit removed is no longer reported as connected.
 * - A token rotation that coincides with a configuration change is still a
 *   configuration reattach: a failed resume keeps the conversation rather than
 *   silently starting a new one.
 *
 * SDK surfaces are injected through the bridge's test seams, as in the owner.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Agent, LocalAgentStore } from "@cursor/sdk";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const previousApiKey = process.env.CURSOR_API_KEY;
const previousStateDir = process.env.CURSOR_BRIDGE_STATE_DIR;
const previousCredentialFile = process.env.CURSOR_BRIDGE_AUTH_FILE;
const bridgeStateRoot = join(tmpdir(), `cursor-bridge-mcp-reattach-test-${process.pid}`);
process.env.CURSOR_BRIDGE_STATE_DIR = bridgeStateRoot;
process.env.CURSOR_BRIDGE_AUTH_FILE = join(bridgeStateRoot, "missing-auth.json");

let resumeFails = false;
const created: Array<Record<string, unknown>> = [];
const resumed: string[] = [];

function fakeSdkAgent(agentId: string) {
  return {
    agentId,
    send: async () => undefined,
    getUsage: async () => ({ usage: {}, runs: [] }),
    [Symbol.asyncDispose]: async () => undefined,
  };
}

const testAgent = {
  create: async (options: Record<string, unknown>) => {
    created.push(options);
    return fakeSdkAgent(`created-agent-${created.length}`);
  },
  resume: async (agentId: string) => {
    resumed.push(agentId);
    if (resumeFails) throw new Error("no such agent");
    return fakeSdkAgent(agentId);
  },
  list: async () => ({ items: [] }),
  listRuns: async () => ({ items: [] }),
} as unknown as typeof Agent;

const testStore = {
  agents: { get: async () => undefined, update: async () => undefined },
  checkpoints: {},
  runs: { list: async () => ({ items: [], nextCursor: undefined }), delete: async () => {} },
  runEvents: { delete: async () => undefined },
} as unknown as LocalAgentStore;

const {
  detachAgent,
  ensureAgent,
  newSessionState,
  setCursorMcpConfigHomeForTests,
  setCursorMcpFingerprintForTests,
  useCursorAgentForTests,
} = await import("./agent-session.js");
const {
  publicCursorMcpServers,
  recordObservedMcpTool,
  retireMcpObservations,
  setCursorMcpTransportForTests,
} = await import("./mcp.js");
const {
  resetCursorSandboxBootstrapForTests,
  useCursorLocalAgentStoreForTests,
  useCursorSdkRuntimeForTests,
} = await import("./sdk-runtime.js");
const { resetPlanAccountWindowsForTests } = await import("./plan-usage.js");
const { useCursorModelsForTests } = await import("./models.js");
const { useCursorCredentialRuntimeForTests } = await import("./credentials.js");
const { clientSessionKeys, sessions } = await import("./state.js");

let restoreAgent: () => void;
let restoreModels: () => void;
let restoreRuntime: () => void;
let restoreCredentials: () => void;
let previousStore: LocalAgentStore;

beforeAll(() => {
  restoreAgent = useCursorAgentForTests(testAgent);
  restoreModels = useCursorModelsForTests({
    list: async () => [],
  } as unknown as typeof import("@cursor/sdk").Cursor.models);
  restoreRuntime = useCursorSdkRuntimeForTests({
    configureStore: () => undefined,
    createPlatform: (async () => ({
      prewarmLocalWorkspace: async () => async () => {},
    })) as unknown as typeof import("@cursor/sdk").createAgentPlatform,
  });
  previousStore = useCursorLocalAgentStoreForTests(testStore);
  restoreCredentials = useCursorCredentialRuntimeForTests({
    store: {
      load: async () => undefined,
      save: async () => undefined,
      clear: async () => undefined,
    },
    auth: { login: async () => undefined, logout: async () => undefined } as never,
  });
});

const configHome = join(bridgeStateRoot, "config-home");

/** Status of one server; attached sessions also list the injected Orkestrator one. */
function statusOf(state: Parameters<typeof publicCursorMcpServers>[0], id: string) {
  return publicCursorMcpServers(state).find((server) => server.id === id)?.status;
}

async function saveUserMcpConfig(servers: Record<string, unknown>): Promise<void> {
  await mkdir(join(configHome, ".cursor"), { recursive: true });
  await writeFile(join(configHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

beforeEach(async () => {
  // The fingerprint must never read the operator's home.
  await rm(configHome, { recursive: true, force: true });
  setCursorMcpConfigHomeForTests(configHome);
  setCursorMcpFingerprintForTests();
  setCursorMcpTransportForTests();
  resetPlanAccountWindowsForTests();
  resetCursorSandboxBootstrapForTests();
  sessions.clear();
  clientSessionKeys.clear();
  process.env.CURSOR_API_KEY = "test-key";
  resumeFails = false;
  created.length = 0;
  resumed.length = 0;
});

afterAll(async () => {
  sessions.clear();
  setCursorMcpConfigHomeForTests();
  restoreRuntime();
  useCursorLocalAgentStoreForTests(previousStore);
  restoreModels();
  restoreAgent();
  restoreCredentials();
  if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = previousApiKey;
  if (previousStateDir === undefined) delete process.env.CURSOR_BRIDGE_STATE_DIR;
  else process.env.CURSOR_BRIDGE_STATE_DIR = previousStateDir;
  if (previousCredentialFile === undefined) delete process.env.CURSOR_BRIDGE_AUTH_FILE;
  else process.env.CURSOR_BRIDGE_AUTH_FILE = previousCredentialFile;
  await rm(bridgeStateRoot, { recursive: true, force: true });
});

describe("retireMcpObservations", () => {
  test("a retired call keeps its server listed but no longer connected", () => {
    const state = newSessionState();
    state.mcpServerNames = [];
    recordObservedMcpTool(state, "mcp__paper__list_files");
    expect(publicCursorMcpServers(state)).toEqual([
      { id: "paper", name: "paper", status: "connected", actions: [] },
    ]);

    retireMcpObservations(state);
    expect(state.observedMcpTools.size).toBe(0);
    expect(publicCursorMcpServers(state)).toEqual([
      { id: "paper", name: "paper", status: "unknown", actions: [] },
    ]);

    // Fresh evidence under the new configuration counts again.
    recordObservedMcpTool(state, "mcp__paper__list_files");
    expect(publicCursorMcpServers(state)[0]?.status).toBe("connected");
  });

  test("a retired run inventory stops counting until the next run replaces it", () => {
    const state = newSessionState();
    state.mcpServerNames = [];
    state.runTools = ["shell", "mcp__docs__search"];
    expect(publicCursorMcpServers(state)).toMatchObject([
      { id: "docs", status: "connected", toolCount: 1 },
    ]);

    retireMcpObservations(state);
    expect(publicCursorMcpServers(state)).toEqual([
      { id: "docs", name: "docs", status: "unknown", actions: [] },
    ]);

    // What the prompt path does when the next run starts: a new array.
    state.runTools = ["shell"];
    expect(publicCursorMcpServers(state)).toEqual([]);
    state.runTools = ["shell", "mcp__docs__search"];
    expect(publicCursorMcpServers(state)).toMatchObject([{ id: "docs", status: "connected" }]);
  });

  test("history stays bounded however many generations retire", () => {
    const state = newSessionState();
    state.mcpServerNames = [];
    for (let generation = 0; generation < 4; generation += 1) {
      for (let index = 0; index < 512; index += 1) {
        recordObservedMcpTool(state, `mcp__server-${generation}-${index}__tool`);
      }
      retireMcpObservations(state);
    }
    expect(state.retiredMcpTools?.size).toBe(512);
  });
});

describe("ensureAgent configuration reattach", () => {
  test("a saved configuration change retires the previous generation's MCP evidence", async () => {
    const state = newSessionState();
    await ensureAgent(state);
    recordObservedMcpTool(state, "mcp__removed__lookup");
    expect(statusOf(state, "removed")).toBe("connected");

    await saveUserMcpConfig({});
    await ensureAgent(state, { atTurnStart: true });

    expect(resumed).toHaveLength(1);
    expect(statusOf(state, "removed")).toBe("unknown");
  });

  test("an unchanged configuration keeps the current evidence", async () => {
    const state = newSessionState();
    await ensureAgent(state);
    recordObservedMcpTool(state, "mcp__kept__lookup");
    await ensureAgent(state, { atTurnStart: true });
    expect(resumed).toEqual([]);
    expect(statusOf(state, "kept")).toBe("connected");
  });

  test("a rotation alone does not retire evidence the server set still backs", async () => {
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-a" };
    await ensureAgent(state);
    recordObservedMcpTool(state, "mcp__kept__lookup");
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-b" };
    await ensureAgent(state);
    expect(resumed).toHaveLength(1);
    expect(state.configResumePending).toBeUndefined();
    expect(state.retiredMcpTools).toBeUndefined();
  });
});

describe("token rotation with a configuration change", () => {
  test("a failed resume keeps the conversation instead of starting a new one", async () => {
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-a" };
    await ensureAgent(state);
    const agentId = state.agentId;
    recordObservedMcpTool(state, "mcp__removed__lookup");

    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-b" };
    await saveUserMcpConfig({ added: { url: "https://a.example/mcp" } });
    resumeFails = true;

    await expect(ensureAgent(state)).rejects.toThrow("conversation was kept");
    expect(state.agentId).toBe(agentId);
    expect(created).toHaveLength(1);
    expect(state.configResumePending).toBe(true);
    expect(statusOf(state, "removed")).toBe("unknown");

    // The retry reopens the same conversation and clears the mark.
    resumeFails = false;
    expect(await ensureAgent(state)).toMatchObject({ agentId });
    expect(state.configResumePending).toBeUndefined();
    expect(created).toHaveLength(1);
  });

  test("a rotation alone may still fall back to a new agent", async () => {
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-a" };
    await ensureAgent(state);
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-b" };
    resumeFails = true;
    expect(await ensureAgent(state)).toMatchObject({ agentId: "created-agent-2" });
    expect(state.configResumePending).toBeUndefined();
  });

  test("a rotation whose fingerprint read loses a race never detaches the replacement", async () => {
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-a" };
    await ensureAgent(state);
    const baseline = "baseline";
    let release!: (value: string) => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    // Attach recorded the real fingerprint; make every read differ from it so
    // the rotation branch treats this as a configuration change too.
    setCursorMcpFingerprintForTests(async () => {
      reading();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-b" };
    const first = ensureAgent(state);
    await started;

    // Meanwhile another path detaches and reattaches on the new credential.
    setCursorMcpFingerprintForTests(async () => baseline);
    await detachAgent(state);
    const replacement = await ensureAgent(state);

    release("changed");
    expect(await first).toBe(replacement);
    expect(state.agent).toBe(replacement);
    expect(state.configResumePending).toBeUndefined();
  });
});
