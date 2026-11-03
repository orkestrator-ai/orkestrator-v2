/**
 * Narrow-only execution policy (H4) through Pi's real router. A fake
 * `AgentSession` stands in for Pi, so no provider is ever called.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

// `config.ts` reads its environment once, at import: everything below loads after this.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { authToken: TOKEN } = await import("./config.js");
const { newSessionState, setAgentSessionTestHooks } = await import("./agent-session.js");
const { sessions, clientSessionKeys } = await import("./state.js");
const { loadPersistedState, settlePersistenceForTests } = await import("./persistence.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

let origin: string;

beforeAll(async () => {
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await shutdown();
});

afterEach(async () => {
  sessions.clear();
  clientSessionKeys.clear();
  setAgentSessionTestHooks(undefined);
  await settlePersistenceForTests();
});

const askPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-container",
  sandbox: "provider",
  approvals: "ask",
  projectResources: false,
  networkAccess: "restricted",
};
const widerPolicy: NativeAgentExecutionPolicy = {
  ...askPolicy,
  approvals: "auto-approve",
  sandbox: "none",
};
const narrowerPolicy: NativeAgentExecutionPolicy = { ...askPolicy, approvals: "deny" };

function post(path: string, body: unknown): Promise<Response> {
  return nativeFetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function expectRefused(response: Response, widened: string[]): Promise<void> {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "policy-widening-refused", widened });
}

function fakeAgentSession(prompts: string[] = []): AgentSession {
  return {
    sessionId: "pi-session-test",
    sessionFile: "/tmp/pi-session-test.jsonl",
    promptTemplates: [],
    subscribe: () => () => undefined,
    dispose: () => undefined,
    prompt: (text: string, options: { preflightResult?: (disposition: string) => void }) => {
      prompts.push(text);
      options.preflightResult?.("started");
      return Promise.resolve();
    },
    abort: async () => undefined,
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh"],
  } as unknown as AgentSession;
}

function hydrateOnly(): void {
  setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
}

describe("POST /session/create with a client key that names a live session", () => {
  async function liveSession(key: string) {
    hydrateOnly();
    const created = await post("/session/create", { clientSessionKey: key, policy: askPolicy });
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    return sessions.get(sessionId)!;
  }

  test("refuses a wider policy and changes nothing, MCP credential included", async () => {
    const state = await liveSession("create-wider");
    const agentMcp = {
      url: "http://127.0.0.1:1/mcp",
      token: "rotated",
    };

    await expectRefused(
      await post("/session/create", {
        clientSessionKey: "create-wider",
        policy: widerPolicy,
        agentMcp,
      }),
      ["approvals", "sandbox"],
    );

    expect(state.policy).toEqual(askPolicy);
    expect(state.agentMcp).toBeUndefined();
  });

  test("applies a narrower policy and rebuilds the attached session", async () => {
    const state = await liveSession("create-narrower");
    let disposed = 0;
    state.session = { ...fakeAgentSession(), dispose: () => (disposed += 1) } as never;

    const response = await post("/session/create", {
      clientSessionKey: "create-narrower",
      policy: narrowerPolicy,
    });

    expect(response.status).toBe(201);
    expect(state.policy).toEqual(narrowerPolicy);
    expect(disposed).toBe(1);
    expect(state.session).toBeNull();
  });

  test("accepts an equal policy without touching the attached session", async () => {
    const state = await liveSession("create-equal");
    const attached = fakeAgentSession();
    state.session = attached;

    const response = await post("/session/create", {
      clientSessionKey: "create-equal",
      policy: askPolicy,
    });

    expect(response.status).toBe(201);
    expect(state.policy).toEqual(askPolicy);
    expect(state.session).toBe(attached);
  });

  test("a narrower policy cannot move a session in the middle of a turn", async () => {
    const state = await liveSession("create-running");
    state.status = "running";

    const response = await post("/session/create", {
      clientSessionKey: "create-running",
      policy: narrowerPolicy,
    });

    expect(response.status).toBe(409);
    expect(state.policy).toEqual(askPolicy);
    state.status = "idle";
  });

  test("a request with no policy leaves it alone", async () => {
    const state = await liveSession("create-absent");
    const response = await post("/session/create", { clientSessionKey: "create-absent" });
    expect(response.status).toBe(201);
    expect(state.policy).toEqual(askPolicy);
  });

  test("a session given no policy takes the first it is sent, then holds it", async () => {
    hydrateOnly();
    const created = await post("/session/create", { clientSessionKey: "create-fallback" });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const state = sessions.get(sessionId)!;
    expect(state.policy?.id).toBe("interactive-host");

    const response = await post("/session/create", {
      clientSessionKey: "create-fallback",
      policy: askPolicy,
    });

    expect(response.status).toBe(201);
    expect(state.policy).toEqual(askPolicy);
    await expectRefused(
      await post("/session/create", { clientSessionKey: "create-fallback", policy: widerPolicy }),
      ["approvals", "sandbox"],
    );
    expect(state.policy).toEqual(askPolicy);
  });
});

describe("POST /session/resume of a file a live session owns", () => {
  async function ownedFile() {
    const directory = await mkdtemp(join(tmpdir(), "pi-bridge-policy-resume-"));
    const sessionFile = join(directory, "owned.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "owned-pi-session",
        timestamp: "2026-11-03T00:00:00.000Z",
        cwd: process.cwd(),
      })}\n`,
      "utf8",
    );
    process.env.PI_SESSION_DIR = directory;
    const state = newSessionState(undefined, askPolicy);
    state.sessionFile = sessionFile;
    sessions.set(state.id, state);
    return {
      state,
      sessionFile,
      [Symbol.asyncDispose]: async () => {
        delete process.env.PI_SESSION_DIR;
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  test("refuses a wider policy and changes nothing", async () => {
    await using owned = await ownedFile();
    const attached = fakeAgentSession();
    owned.state.session = attached;

    await expectRefused(
      await post("/session/resume", { sessionId: owned.sessionFile, policy: widerPolicy }),
      ["approvals", "sandbox"],
    );

    expect(owned.state.policy).toEqual(askPolicy);
    expect(owned.state.session).toBe(attached);
  });

  test("applies a narrower policy", async () => {
    await using owned = await ownedFile();
    const response = await post("/session/resume", {
      sessionId: owned.sessionFile,
      policy: narrowerPolicy,
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { sessionId: string }).sessionId).toBe(owned.state.id);
    expect(owned.state.policy).toEqual(narrowerPolicy);
  });

  test("accepts an equal policy", async () => {
    await using owned = await ownedFile();
    const response = await post("/session/resume", {
      sessionId: owned.sessionFile,
      policy: askPolicy,
    });
    expect(response.status).toBe(201);
    expect(owned.state.policy).toEqual(askPolicy);
  });

  test("a resume of a file no session owns takes the policy given", async () => {
    await using owned = await ownedFile();
    sessions.delete(owned.state.id);
    hydrateOnly();

    const response = await post("/session/resume", {
      sessionId: owned.sessionFile,
      policy: widerPolicy,
    });

    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(sessions.get(sessionId)?.policy).toEqual(widerPolicy);
  });
});

describe("POST /session/:id/prompt", () => {
  function promptableSession() {
    const state = newSessionState(undefined, askPolicy);
    const prompts: string[] = [];
    state.session = fakeAgentSession(prompts);
    sessions.set(state.id, state);
    setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
    return { state, prompts };
  }

  async function settled(state: { status: string }): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (state.status !== "idle" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  test("refuses a prompt naming a wider policy before it reaches Pi", async () => {
    const { state, prompts } = promptableSession();

    await expectRefused(
      await post(`/session/${state.id}/prompt`, {
        prompt: "go",
        requestId: "wider",
        policy: widerPolicy,
      }),
      ["approvals", "sandbox"],
    );

    expect(prompts).toEqual([]);
    expect(state.promptJournal.has("wider")).toBe(false);
    expect(state.policy).toEqual(askPolicy);
  });

  test.each([
    ["narrower", narrowerPolicy],
    ["equal", askPolicy],
  ] as const)("runs one naming a %s policy, and the session's own stays", async (label, policy) => {
    const { state, prompts } = promptableSession();

    const response = await post(`/session/${state.id}/prompt`, {
      prompt: "go",
      requestId: label,
      policy,
    });

    expect(response.status).toBe(202);
    await settled(state);
    expect(prompts).toHaveLength(1);
    expect(state.policy).toEqual(askPolicy);
  });
});

describe("a bridge restart", () => {
  test("a restored session takes the backend's policy once; a prompt also makes its copy live", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-bridge-policy-restart-"));
    process.env.PI_BRIDGE_STATE_DIR = stateDir;
    hydrateOnly();
    try {
      for (const key of ["restored-create", "restored-prompt"]) {
        const created = await post("/session/create", { clientSessionKey: key, policy: askPolicy });
        expect(created.status).toBe(201);
      }
      await settlePersistenceForTests();
      sessions.clear();
      clientSessionKeys.clear();
      await loadPersistedState();

      const restored = (key: string) => sessions.get(clientSessionKeys.get(key)!)!;
      expect(restored("restored-create").policy).toEqual(askPolicy);
      expect(restored("restored-create").policyPending).toBe(true);

      const taken = await post("/session/create", {
        clientSessionKey: "restored-create",
        policy: widerPolicy,
      });
      expect(taken.status).toBe(201);
      expect(restored("restored-create").policy).toEqual(widerPolicy);
      await expectRefused(
        await post("/session/create", {
          clientSessionKey: "restored-create",
          policy: { ...widerPolicy, projectResources: true },
        }),
        ["projectResources"],
      );

      const prompted = restored("restored-prompt");
      prompted.session = fakeAgentSession();
      const turn = await post(`/session/${prompted.id}/prompt`, {
        prompt: "go",
        requestId: "restored-turn",
      });
      expect(turn.status).toBe(202);
      expect(prompted.policyPending).toBe(false);
      await expectRefused(
        await post("/session/create", {
          clientSessionKey: "restored-prompt",
          policy: widerPolicy,
        }),
        ["approvals", "sandbox"],
      );
      expect(prompted.policy).toEqual(askPolicy);
    } finally {
      delete process.env.PI_BRIDGE_STATE_DIR;
      sessions.clear();
      clientSessionKeys.clear();
      await settlePersistenceForTests();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
