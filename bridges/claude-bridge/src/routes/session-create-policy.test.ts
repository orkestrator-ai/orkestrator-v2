// POST /session/create is narrow-only when the client key names a resident
// session (H4). Same composition as `session-config-policy.test.ts`: the real
// bridge app and session manager, with only the SDK and filesystem edges mocked.
import { afterAll, describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import { getSession } from "../services/session-manager.js";
import { track } from "../services/session-manager-test-harness.js";

const envKeys = ["CLAUDE_BRIDGE_NO_SERVER", "CLAUDE_BRIDGE_AUTH_DISABLED_FOR_TESTING"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) process.env[key] = "1";
const { app } = await import("../index.js");

afterAll(() => {
  for (const key of envKeys) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

const askPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-container",
  sandbox: "provider",
  approvals: "ask",
  projectResources: false,
  networkAccess: "restricted",
};

function create(clientSessionKey: string, policy?: unknown) {
  return app.request("/session/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientSessionKey, ...(policy === undefined ? {} : { policy }) }),
  });
}

async function liveSession(key: string, policy: NativeAgentExecutionPolicy | undefined) {
  const response = await create(key, policy);
  expect(response.status).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  track(sessionId);
  return getSession(sessionId)!;
}

describe("POST /session/create recovery execution policy", () => {
  test("refuses a wider policy for a resident session, and changes nothing", async () => {
    const session = await liveSession("create-policy-wider", askPolicy);

    const response = await create("create-policy-wider", {
      ...askPolicy,
      approvals: "auto-approve",
      sandbox: "none",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "policy-widening-refused",
      widened: ["approvals", "sandbox"],
    });
    expect(session.executionPolicy).toEqual(askPolicy);
  });

  test("applies a narrower policy", async () => {
    const session = await liveSession("create-policy-narrower", askPolicy);
    const narrower: NativeAgentExecutionPolicy = { ...askPolicy, approvals: "deny" };

    const response = await create("create-policy-narrower", narrower);

    expect(response.status).toBe(201);
    expect(((await response.json()) as { sessionId: string }).sessionId).toBe(session.id);
    expect(session.executionPolicy).toEqual(narrower);
  });

  test("accepts an equal policy (a retried create)", async () => {
    const session = await liveSession("create-policy-equal", askPolicy);

    const response = await create("create-policy-equal", structuredClone(askPolicy));

    expect(response.status).toBe(201);
    expect(session.executionPolicy).toEqual(askPolicy);
  });

  test("a request with no policy, or an unusable one, cannot clear a live policy", async () => {
    const session = await liveSession("create-policy-absent", askPolicy);

    expect((await create("create-policy-absent")).status).toBe(201);
    expect(session.executionPolicy).toEqual(askPolicy);
    expect((await create("create-policy-absent", { approvals: "whatever" })).status).toBe(201);
    expect(session.executionPolicy).toEqual(askPolicy);
  });

  test("a session with no live policy takes the one it is given", async () => {
    const session = await liveSession("create-policy-unset", undefined);
    expect(session.executionPolicy).toBeUndefined();
    const wide: NativeAgentExecutionPolicy = {
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
    };

    const response = await create("create-policy-unset", wide);

    expect(response.status).toBe(201);
    expect(session.executionPolicy).toEqual(wide);
    // It is live now, so the same route refuses to widen it past that.
    expect((await create("create-policy-unset", { ...wide, id: "pipeline" })).status).toBe(403);
    expect(session.executionPolicy).toEqual(wide);
  });
});
