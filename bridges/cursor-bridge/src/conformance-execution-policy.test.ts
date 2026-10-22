/**
 * The shared execution-policy conformance suite (`tests/conformance/execution-policy`)
 * over the Cursor bridge.
 *
 * The session is created and attached through the bridge's own code with the
 * SDK replaced at its test seams, and the observation is read from the options
 * `Agent.create` receives. The reported policy is the session's, which
 * `publicSession` and `publicStatus` return and Agent Info renders.
 */
import { afterAll, beforeAll, beforeEach } from "bun:test";
import type { Agent, LocalAgentStore } from "@cursor/sdk";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runExecutionPolicyConformance,
  type AdapterEffects,
} from "../../../tests/conformance/execution-policy/suite.js";

const ENV_KEYS = [
  "CURSOR_API_KEY",
  "CURSOR_BRIDGE_STATE_DIR",
  "CURSOR_BRIDGE_AUTH_FILE",
  "ORKESTRATOR_BRIDGE_EXECUTION_POLICY",
  "ORKESTRATOR_AGENT_MCP_URL",
  "ORKESTRATOR_AGENT_MCP_TOKEN",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const stateRoot = join(tmpdir(), `cursor-policy-conformance-${process.pid}`);
for (const key of ENV_KEYS) delete process.env[key];
process.env.CURSOR_BRIDGE_STATE_DIR = stateRoot;
process.env.CURSOR_BRIDGE_AUTH_FILE = join(stateRoot, "missing-auth.json");
process.env.CURSOR_API_KEY = "test-key";

const created: Array<Record<string, unknown>> = [];
const fakeAgent = {
  create: async (options: Record<string, unknown>) => {
    created.push(options);
    return { agentId: "created-agent", send: async () => undefined };
  },
  resume: async () => {
    throw new Error("No agent to resume");
  },
  list: async () => ({ items: [] }),
  listRuns: async () => ({ items: [] }),
} as unknown as typeof Agent;

// `config.ts` reads its environment once, at import.
const { createSession, ensureAgent, setCursorMcpConfigHomeForTests, useCursorAgentForTests } =
  await import("./agent-session.js");
const { useCursorSdkRuntimeForTests, useCursorLocalAgentStoreForTests } =
  await import("./sdk-runtime.js");
const { useCursorModelsForTests } = await import("./models.js");
const { useCursorCredentialRuntimeForTests } = await import("./credentials.js");
const { clientSessionKeys, sessions } = await import("./state.js");

const restores: Array<() => void> = [];
beforeAll(() => {
  restores.push(useCursorAgentForTests(fakeAgent));
  restores.push(useCursorModelsForTests({ list: async () => [] } as never));
  restores.push(
    useCursorSdkRuntimeForTests({
      configureStore: () => undefined,
      createPlatform: (async () => ({
        prewarmLocalWorkspace: async () => async () => undefined,
      })) as never,
    }),
  );
  const previousStore = useCursorLocalAgentStoreForTests({
    agents: { get: async () => undefined, update: async () => undefined },
    checkpoints: {},
    runs: { list: async () => ({ items: [] }), delete: async () => undefined },
    runEvents: { delete: async () => undefined },
  } as unknown as LocalAgentStore);
  restores.push(() => useCursorLocalAgentStoreForTests(previousStore));
  restores.push(
    useCursorCredentialRuntimeForTests({
      store: {
        load: async () => undefined,
        save: async () => undefined,
        clear: async () => undefined,
      },
      auth: { login: async () => undefined, logout: async () => undefined } as never,
    }),
  );
  // The MCP fingerprint must never read the operator's home.
  setCursorMcpConfigHomeForTests(join(stateRoot, "home"));
});

beforeEach(() => {
  created.length = 0;
  sessions.clear();
  clientSessionKeys.clear();
});

afterAll(async () => {
  sessions.clear();
  for (const restore of restores.reverse()) restore();
  setCursorMcpConfigHomeForTests();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(stateRoot, { recursive: true, force: true });
});

const NETWORK_TOOLS = ["shell", "webFetch", "webSearch"];

function observeCursor(options: Record<string, unknown>): AdapterEffects {
  const local = options.local as {
    settingSources?: string[];
    sandboxOptions?: { enabled?: boolean };
    autoReview?: boolean;
  };
  const providerSandbox = local.sandboxOptions?.enabled === true;
  const tools = options.tools as string[] | undefined;
  return {
    providerSandbox,
    // No approval callback exists. Unsandboxed, nothing escalates and every
    // tool runs; sandboxed, auto-review decides an escalation or it fails.
    approvals: !providerSandbox ? "auto-approve" : local.autoReview ? "auto-approve" : "deny",
    projectResources: local.settingSources?.includes("project") === true,
    // Its sandbox is its network control; a closed toolset with no shell or
    // fetch reaches nothing either.
    restrictsNetwork:
      providerSandbox ||
      (tools !== undefined && !tools.some((tool) => NETWORK_TOOLS.includes(tool))),
  };
}

runExecutionPolicyConformance({
  platform: "cursor",
  async apply(shape) {
    const state = await createSession(undefined, undefined, shape.policy);
    // What `publicSession` and `publicStatus` report.
    const reported = state.policy!;
    try {
      await ensureAgent(state);
    } catch (error) {
      return { reported, observed: { refused: (error as Error).message } };
    }
    return { reported, observed: observeCursor(created.at(-1)!) };
  },
});
