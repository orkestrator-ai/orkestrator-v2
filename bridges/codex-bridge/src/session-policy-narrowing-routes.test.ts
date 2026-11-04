/**
 * Narrow-only execution policy (H4) through the real Codex bridge router.
 *
 * `app-server-runtime-policy-narrowing.test.ts` drives the same rule against a
 * scripted app-server; this file proves what each route answers.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompressionStream as NodeCompressionStream } from "node:stream/web";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { AppServerEngine } from "./engine/app-server-engine.js";

const codexHome = mkdtempSync(join(tmpdir(), "ork-codex-policy-routes-"));
const previousEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_BRIDGE_NO_ENGINE: process.env.CODEX_BRIDGE_NO_ENGINE,
  CODEX_BRIDGE_NO_SERVER: process.env.CODEX_BRIDGE_NO_SERVER,
  CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING: process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING,
};
process.env.CODEX_HOME = codexHome;
process.env.CODEX_BRIDGE_NO_ENGINE = "1";
process.env.CODEX_BRIDGE_NO_SERVER = "1";
process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING = "1";

// The UI-test preload replaces browser globals before the bridge module is
// evaluated. Hono captures this constructor while installing its middleware.
const originalCompressionStream = globalThis.CompressionStream;
globalThis.CompressionStream = NodeCompressionStream as typeof CompressionStream;
const { app, __testing } = await import("./index.js");
const runtime = __testing.runtimeForTesting();
const registry = runtime.getRegistry();

afterAll(() => {
  globalThis.CompressionStream = originalCompressionStream;
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(codexHome, { recursive: true, force: true });
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

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function liveSession(policy: NativeAgentExecutionPolicy) {
  const response = await post("/session/create", { mode: "build", policy });
  expect(response.status).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  return registry.getSession(sessionId)!;
}

async function expectRefused(response: Response, widened: string[]) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "policy-widening-refused", widened });
}

describe("POST /session/:id/config", () => {
  test("refuses a wider policy and changes nothing", async () => {
    const session = await liveSession(askPolicy);
    const before = session.config;

    await expectRefused(await post(`/session/${session.id}/config`, { policy: widerPolicy }), [
      "approvals",
      "sandbox",
    ]);

    expect(session.config).toBe(before);
    expect(session.config.policy).toEqual(askPolicy);
    expect(session.config.approvalPolicy).toBe("on-request");
  });

  test("applies a narrower policy", async () => {
    const session = await liveSession(askPolicy);
    const response = await post(`/session/${session.id}/config`, { policy: narrowerPolicy });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "updated" });
    expect(session.config.policy).toEqual(narrowerPolicy);
  });

  test("accepts an equal policy", async () => {
    const session = await liveSession(askPolicy);
    const response = await post(`/session/${session.id}/config`, { policy: askPolicy });
    expect(response.status).toBe(200);
    expect(session.config.policy).toEqual(askPolicy);
  });

  test("a request with no policy leaves it alone, and an unusable one is refused", async () => {
    const session = await liveSession(askPolicy);
    expect((await post(`/session/${session.id}/config`, { mode: "plan" })).status).toBe(200);
    expect(session.config.policy).toEqual(askPolicy);
    const invalid = await post(`/session/${session.id}/config`, { policy: "auto-approve" });
    expect(invalid.status).toBe(400);
    expect(session.config.policy).toEqual(askPolicy);
  });

  test("a session restored from disk takes the policy it is given, then holds it", async () => {
    const session = await liveSession(askPolicy);
    session.policyPending = true;

    const taken = await post(`/session/${session.id}/config`, { policy: widerPolicy });

    expect(taken.status).toBe(200);
    expect(session.config.policy).toEqual(widerPolicy);
    expect(session.policyPending).toBe(false);
    await expectRefused(
      await post(`/session/${session.id}/config`, {
        policy: { ...widerPolicy, projectResources: true },
      }),
      ["projectResources"],
    );
    expect(session.config.policy).toEqual(widerPolicy);
  });
});

describe("POST /session/:id/prompt", () => {
  // The dispatch itself is the runtime's; these only ask whether the route
  // lets the request reach it. A prompt has no way to change the policy.
  const dispatch = () =>
    spyOn(runtime, "prompt").mockResolvedValue({
      ok: true,
      result: { status: "processing" },
    } as never);

  afterEach(() => {
    (runtime.prompt as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test("refuses a prompt naming a wider policy before dispatching it", async () => {
    const session = await liveSession(askPolicy);
    const prompt = dispatch();

    await expectRefused(
      await post(`/session/${session.id}/prompt`, {
        prompt: "go",
        requestId: "wider",
        policy: widerPolicy,
      }),
      ["approvals", "sandbox"],
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(session.config.policy).toEqual(askPolicy);
  });

  test.each([
    ["narrower", narrowerPolicy],
    ["equal", askPolicy],
  ] as const)("dispatches one naming a %s policy, whose own stays", async (label, policy) => {
    const session = await liveSession(askPolicy);
    const prompt = dispatch();

    const response = await post(`/session/${session.id}/prompt`, {
      prompt: "go",
      requestId: label,
      policy,
    });

    expect(response.status).toBe(202);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(session.config.policy).toEqual(askPolicy);
  });
});

describe("POST /session/resume", () => {
  const engine = (runtime as unknown as { context: { options: { engine: AppServerEngine } } })
    .context.options.engine;
  // Resuming a thread whose rollout is gone needs no app-server, and still
  // registers the new session under the policy it was given.
  const rolloutGone = () =>
    spyOn(engine, "resumeThread").mockRejectedValue(
      new Error("thread/resume failed: no rollout found for thread id"),
    );

  function boundSession(threadId: string, policyPending = false) {
    return registry.createSession({
      id: `bound-${threadId}`,
      threadId,
      config: { mode: "build", policy: askPolicy },
      policyPending,
    });
  }

  afterEach(() => {
    (engine.resumeThread as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test("refuses a wider policy for a thread a live session holds", async () => {
    const live = boundSession("thread-wider");
    const resume = rolloutGone();
    const sessions = registry.listSessions().length;

    await expectRefused(
      await post("/session/resume", { threadId: "thread-wider", policy: widerPolicy }),
      ["approvals", "sandbox"],
    );

    expect(resume).not.toHaveBeenCalled();
    expect(registry.listSessions()).toHaveLength(sessions);
    expect(live.config.policy).toEqual(askPolicy);
  });

  test.each([
    ["narrower", narrowerPolicy],
    ["equal", askPolicy],
  ] as const)("accepts a %s policy for that thread", async (label, policy) => {
    const live = boundSession(`thread-${label}`);
    rolloutGone();

    const response = await post("/session/resume", { threadId: `thread-${label}`, policy });

    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(registry.getSession(sessionId)?.config.policy).toEqual(policy);
    expect(live.config.policy).toEqual(askPolicy);
  });

  test("a resume with no policy inherits the live one rather than the host default", async () => {
    boundSession("thread-absent");
    rolloutGone();

    const response = await post("/session/resume", { threadId: "thread-absent" });

    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(registry.getSession(sessionId)?.config.policy).toEqual(askPolicy);
  });

  test("a thread held only by a session restored from disk takes the policy given", async () => {
    boundSession("thread-restored", true);
    rolloutGone();

    const response = await post("/session/resume", {
      threadId: "thread-restored",
      policy: widerPolicy,
    });

    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(registry.getSession(sessionId)?.config.policy).toEqual(widerPolicy);
  });

  test("a thread no session holds takes the policy given", async () => {
    rolloutGone();
    const response = await post("/session/resume", {
      threadId: "thread-free",
      policy: widerPolicy,
    });
    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(registry.getSession(sessionId)?.config.policy).toEqual(widerPolicy);
  });
});

describe("POST /session/create", () => {
  test("an existing client key keeps its policy, whatever the retry names", async () => {
    const create = (policy: NativeAgentExecutionPolicy) =>
      post("/session/create", { mode: "build", clientSessionKey: "create-keeps", policy });
    const first = await create(askPolicy);
    const { sessionId } = (await first.json()) as { sessionId: string };

    expect((await create(widerPolicy)).status).toBe(201);

    expect(registry.getSession(sessionId)?.config.policy).toEqual(askPolicy);
  });
});
