/**
 * Narrow-only execution policy (H4) through Cursor's real router. A fake agent
 * stands in for the SDK, so no provider is ever called.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cursor } from "@cursor/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { createSession, ensureAgent, resolveCursorExecutionPolicy } from "./agent-session.js";
import { authToken } from "./config.js";
import { useCursorCredentialRuntimeForTests } from "./credentials.js";
import { route } from "./http.js";
import { useCursorModelsForTests } from "./models.js";
import { loadPersistedState, persistBarrier } from "./persistence.js";
import { clientSessionKeys, sessions, type SessionState } from "./state.js";
import { attachFake } from "./testing/fake-agent.js";

let server: Server;
let baseUrl: string;
let restoreModels: () => void;
let restoreCredentials: () => void;

beforeEach(async () => {
  restoreModels = useCursorModelsForTests({ list: async () => [] } as never);
  restoreCredentials = useCursorCredentialRuntimeForTests({
    store: {
      load: async () => undefined,
      save: async () => undefined,
      clear: async () => undefined,
    } as never,
    auth: Cursor.auth,
  });
  sessions.clear();
  clientSessionKeys.clear();
  server = createServer((request, response) => {
    void route(request, response, new AbortController().signal);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sessions.clear();
  clientSessionKeys.clear();
  restoreCredentials();
  restoreModels();
});

// Cursor reports `ask` as the auto-approved mode it really runs, so `deny` is the
// only stricter approvals step, and the sandbox carries the rest of the axes.
const livePolicy: NativeAgentExecutionPolicy = {
  id: "interactive-container",
  sandbox: "provider",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "restricted",
};
const widerPolicy: NativeAgentExecutionPolicy = {
  ...livePolicy,
  sandbox: "container",
  networkAccess: "full",
};
const narrowerPolicy: NativeAgentExecutionPolicy = { ...livePolicy, approvals: "deny" };

const nativeFetch = Bun.fetch;

function post(path: string, body: unknown): Promise<Response> {
  return nativeFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
}

async function expectRefused(response: Response, widened: string[]): Promise<void> {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "policy-widening-refused", widened });
}

async function liveSession(clientSessionKey: string): Promise<SessionState> {
  const response = await post("/session/create", { clientSessionKey, policy: livePolicy });
  expect(response.status).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  return sessions.get(sessionId)!;
}

describe.each([
  [
    "POST /session/create with a client key",
    "narrow-create",
    (policy: NativeAgentExecutionPolicy) => ({ clientSessionKey: "narrow-create", policy }),
    "/session/create",
  ],
  [
    "POST /session/resume of an adopted agent",
    "narrow-resume",
    (policy: NativeAgentExecutionPolicy) => ({ sessionId: "narrow-resume-agent", policy }),
    "/session/resume",
  ],
] as const)("%s", (_label, key, body, path) => {
  async function attached() {
    const state = await liveSession(key);
    const agent = attachFake(state);
    state.agentId = "narrow-resume-agent";
    return { state, agent };
  }

  test("refuses a wider policy, and the attached agent stays", async () => {
    const { state, agent } = await attached();
    const before = state.policy;

    await expectRefused(await post(path, body(widerPolicy)), ["sandbox", "networkAccess"]);

    expect(state.policy).toBe(before);
    expect(state.agent).toBe(agent);
  });

  test("applies a narrower policy, detaching so the next attach uses it", async () => {
    const { state } = await attached();

    const response = await post(path, body(narrowerPolicy));

    expect(response.status).toBe(201);
    expect(state.policy).toEqual(resolveCursorExecutionPolicy(narrowerPolicy));
    expect(state.agent).toBeNull();
  });

  test("accepts an equal policy without detaching", async () => {
    const { state, agent } = await attached();
    const before = structuredClone(state.policy);

    const response = await post(path, body(livePolicy));

    expect(response.status).toBe(201);
    expect(state.policy).toEqual(before);
    expect(state.agent).toBe(agent);
  });

  test("a narrower policy cannot move a session in the middle of a turn", async () => {
    const { state } = await attached();
    const before = state.policy;
    state.status = "running";

    const response = await post(path, body(narrowerPolicy));

    expect(response.status).toBe(409);
    expect(state.policy).toBe(before);
    state.status = "idle";
  });
});

describe("POST /session/:id/prompt", () => {
  test("refuses a prompt naming a wider policy before it reaches the agent", async () => {
    const state = await liveSession("prompt-wider");
    const agent = attachFake(state);
    const before = state.policy;

    await expectRefused(
      await post(`/session/${state.id}/prompt`, {
        prompt: "go",
        requestId: "wider",
        policy: widerPolicy,
      }),
      ["sandbox", "networkAccess"],
    );

    expect(agent.sends).toEqual([]);
    expect(state.promptJournal.has("wider")).toBe(false);
    expect(state.policy).toBe(before);
  });

  test.each([
    ["narrower", narrowerPolicy],
    ["equal", livePolicy],
  ] as const)("runs one naming a %s policy, and the session's own stays", async (label, policy) => {
    const state = await liveSession(`prompt-${label}`);
    const agent = attachFake(state);
    const before = state.policy;

    const response = await post(`/session/${state.id}/prompt`, {
      prompt: "go",
      requestId: label,
      policy,
    });

    expect(response.status).toBe(202);
    expect(state.promptJournal.has(label)).toBe(true);
    expect(agent.sends.length).toBeLessThanOrEqual(1);
    expect(state.policy).toBe(before);
  });
});

describe("a bridge restart", () => {
  test("a restored session takes the backend's policy once; a prompt also makes its copy live", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "cursor-bridge-policy-restart-"));
    const previous = process.env.CURSOR_BRIDGE_STATE_DIR;
    process.env.CURSOR_BRIDGE_STATE_DIR = stateDir;
    try {
      await liveSession("restored-create");
      await liveSession("restored-prompt");
      sessions.clear();
      clientSessionKeys.clear();
      await loadPersistedState();
      const restored = (key: string) => sessions.get(clientSessionKeys.get(key)!)!;
      expect(restored("restored-create").policyPending).toBe(true);
      const held = restored("restored-create").policy;
      expect(held).toEqual(resolveCursorExecutionPolicy(livePolicy));

      const taken = await post("/session/create", {
        clientSessionKey: "restored-create",
        policy: widerPolicy,
      });
      expect(taken.status).toBe(201);
      expect(restored("restored-create").policy).toEqual(resolveCursorExecutionPolicy(widerPolicy));
      await expectRefused(
        await post("/session/create", {
          clientSessionKey: "restored-create",
          policy: { ...widerPolicy, projectResources: true },
        }),
        ["projectResources"],
      );

      const prompted = restored("restored-prompt");
      attachFake(prompted);
      const turn = await post(`/session/${prompted.id}/prompt`, {
        prompt: "go",
        requestId: "restored-turn",
      });
      expect(turn.status).toBe(202);
      expect(prompted.policyPending).toBe(false);
      await expectRefused(
        await post("/session/create", { clientSessionKey: "restored-prompt", policy: widerPolicy }),
        ["sandbox", "networkAccess"],
      );
    } finally {
      await persistBarrier().catch(() => undefined);
      if (previous === undefined) delete process.env.CURSOR_BRIDGE_STATE_DIR;
      else process.env.CURSOR_BRIDGE_STATE_DIR = previous;
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("policy replacement fences prompts and attaches throughout disposal", async () => {
  const state = await liveSession("held-policy");
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const agent = attachFake(state);
  agent[Symbol.asyncDispose] = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = createSession("held-policy", undefined, narrowerPolicy);
  await entered.promise;
  try {
    await expect(ensureAgent(state)).rejects.toThrow("policy is changing");
    expect(
      (await post(`/session/${state.id}/prompt`, { prompt: "go", requestId: "held" })).status,
    ).toBe(409);
    expect(state.agent).toBeNull();
  } finally {
    release.resolve();
  }
  await pending;
  expect(state.policy).toEqual(resolveCursorExecutionPolicy(narrowerPolicy));
  expect(state.dispatching).toBe(false);
});

test.each([narrowerPolicy, widerPolicy])("concurrent create checks each policy", async (policy) => {
  const key = "join-policy";
  const first = createSession(key, undefined, livePolicy);
  const second = createSession(key, undefined, policy);
  if (policy === widerPolicy) {
    await expect(second).rejects.toThrow();
    expect((await first).policy).toEqual(resolveCursorExecutionPolicy(livePolicy));
  } else {
    expect((await second).policy).toEqual(resolveCursorExecutionPolicy(policy));
    expect(await first).toBe(await second);
  }
});

test("policy replacement reserves admission while an existing attach settles", async () => {
  const state = await liveSession("attaching-policy");
  const agent = attachFake(state);
  const release = Promise.withResolvers<typeof agent>();
  state.attaching = release.promise;
  const pending = createSession("attaching-policy", undefined, narrowerPolicy);
  try {
    await expect(ensureAgent(state)).rejects.toThrow("policy is changing");
    expect(
      (await post(`/session/${state.id}/prompt`, { prompt: "go", requestId: "attaching" })).status,
    ).toBe(409);
    expect(state.agent).toBe(agent);
  } finally {
    release.resolve(agent);
  }
  await pending;
  expect(state.agent).toBeNull();
  expect(state.policy).toEqual(resolveCursorExecutionPolicy(narrowerPolicy));
});
