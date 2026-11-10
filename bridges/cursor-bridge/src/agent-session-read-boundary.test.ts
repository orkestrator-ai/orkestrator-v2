/**
 * Which attaches run Cursor's reading tools on the bridge's path-checking
 * executors (to-do 7400 task 1): a read-only coordinator's, and nothing else.
 *
 * Split from `agent-session.test.ts`, which is near the repository's file-size
 * limit. The SDK is replaced through the bridge's test seams, as in the owner,
 * and the captured executors are called the way the SDK calls them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Agent, LocalAgentStore } from "@cursor/sdk";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const previousApiKey = process.env.CURSOR_API_KEY;
const previousStateDir = process.env.CURSOR_BRIDGE_STATE_DIR;
const previousCredentialFile = process.env.CURSOR_BRIDGE_AUTH_FILE;
const bridgeStateRoot = join(tmpdir(), `cursor-bridge-read-boundary-test-${process.pid}`);
process.env.CURSOR_BRIDGE_STATE_DIR = bridgeStateRoot;
process.env.CURSOR_BRIDGE_AUTH_FILE = join(bridgeStateRoot, "missing-auth.json");

const created: Array<Record<string, unknown>> = [];

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
  resume: async (agentId: string) => fakeSdkAgent(agentId),
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
  ensureAgent,
  newSessionState,
  setCursorMcpConfigHomeForTests,
  setCursorMcpFingerprintForTests,
  useCursorAgentForTests,
} = await import("./agent-session.js");
const { setCursorMcpTransportForTests } = await import("./mcp.js");
const { CURSOR_READ_BOUNDARY_REFUSAL } = await import("./read-boundary.js");
const {
  resetCursorSandboxBootstrapForTests,
  useCursorLocalAgentStoreForTests,
  useCursorSdkRuntimeForTests,
} = await import("./sdk-runtime.js");
const { resetPlanAccountWindowsForTests } = await import("./plan-usage.js");
const { useCursorModelsForTests } = await import("./models.js");
const { useCursorCredentialRuntimeForTests } = await import("./credentials.js");
const { clientSessionKeys, sessions } = await import("./state.js");
const { drainPersistence, reopenPersistenceForTests } = await import("./persistence.js");

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
  created.length = 0;
});

afterAll(async () => {
  // Attaches schedule state-file writes that can still be queued here. Let the
  // last one land before the directory goes, or it recreates `state.json`
  // under a root nothing removes again.
  await drainPersistence();
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
  // Re-open only once the state directory no longer points here.
  reopenPersistenceForTests();
  await rm(bridgeStateRoot, { recursive: true, force: true });
});

const POLICY_ENV = "ORKESTRATOR_BRIDGE_EXECUTION_POLICY";
const DATA_DIR_ENV = "ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR";
const dataDir = join(bridgeStateRoot, "data-dir");
const secret = join(dataDir, "control-mcp.json");

const coordinatorPolicy = {
  id: "coordinator-read-only",
  sandbox: "provider",
  approvals: "deny",
  projectResources: false,
  capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
  networkAccess: "restricted",
} as const;

interface CapturedExecutor {
  execute(context: unknown, args: Record<string, unknown>): Promise<{ result: { case: string } }>;
}

function overrides(options: Record<string, unknown> | undefined) {
  const local = options?.local as { resourceProviderOptions?: Record<string, unknown> } | undefined;
  return local?.resourceProviderOptions as Record<string, CapturedExecutor> | undefined;
}

async function withEnv(env: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("read boundary executors on attach", () => {
  beforeAll(async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(secret, "FIXTURE-OPERATOR-CREDENTIAL");
  });

  test("a read-only coordinator replaces read, grep and ls with checked executors", async () => {
    await withEnv({ [POLICY_ENV]: "coordinator-read-only", [DATA_DIR_ENV]: dataDir }, async () => {
      const state = newSessionState(undefined, coordinatorPolicy);
      state.readOnly = true;

      await ensureAgent(state);

      const executors = overrides(created[0]);
      expect(Object.keys(executors ?? {}).sort()).toEqual([
        "overrideGrepExecutor",
        "overrideLsExecutor",
        "overrideReadExecutor",
      ]);
      // The tools stay on the allowlist; only how they run changed.
      expect(created[0]?.tools).toEqual(expect.arrayContaining(["read", "grep", "glob", "ls"]));
      const read = await executors!.overrideReadExecutor!.execute({}, { path: secret });
      expect(read).toEqual({
        result: {
          case: "rejected",
          value: { path: secret, reason: CURSOR_READ_BOUNDARY_REFUSAL },
        },
      });
      const grep = await executors!.overrideGrepExecutor!.execute(
        {},
        { pattern: "x", path: dataDir },
      );
      expect(grep.result.case).toBe("error");
      const ls = await executors!.overrideLsExecutor!.execute({}, { path: dataDir, ignore: [] });
      expect(ls.result.case).toBe("rejected");
      // Repeated on every send, which takes the attach's local options.
      expect(state.agentLocalOptions?.resourceProviderOptions).toBe(executors);
    });
  });

  test("a read-only session outside a coordinator keeps the SDK's executors", async () => {
    await withEnv(
      { [POLICY_ENV]: "coordinator-read-only", [DATA_DIR_ENV]: undefined },
      async () => {
        const state = newSessionState(undefined, coordinatorPolicy);
        state.readOnly = true;

        await ensureAgent(state);

        expect(overrides(created[0])).toBeUndefined();
      },
    );
  });

  test("a writable session keeps the SDK's executors even with a data directory named", async () => {
    await withEnv({ [POLICY_ENV]: undefined, [DATA_DIR_ENV]: dataDir }, async () => {
      const state = newSessionState(undefined, {
        id: "host-default",
        sandbox: "provider",
        approvals: "auto-approve",
        projectResources: false,
        networkAccess: "restricted",
      });

      await ensureAgent(state);

      expect(created).toHaveLength(1);
      expect(overrides(created[0])).toBeUndefined();
    });
  });
});
