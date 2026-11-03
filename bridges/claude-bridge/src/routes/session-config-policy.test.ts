// POST /session/:id/config is narrow-only for the execution policy (H4).
// Drives the route through the bridge's real composition root and the real
// session manager, with only the Claude SDK and filesystem edges mocked.
import { afterAll, describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import { createSession, track } from "../services/session-manager-test-harness.js";

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

function configure(sessionId: string, body: unknown) {
  return app.request(`/session/${sessionId}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sessionUnder(name: string, policy: NativeAgentExecutionPolicy | undefined) {
  const session = createSession(name);
  track(session.id);
  session.executionPolicy = policy ? structuredClone(policy) : undefined;
  return session;
}

describe("POST /session/:id/config execution policy", () => {
  test("refuses widening an ask session to auto-approve without a sandbox, and changes nothing", async () => {
    const session = sessionUnder("config-policy-widen", askPolicy);

    const response = await configure(session.id, {
      policy: { ...askPolicy, approvals: "auto-approve", sandbox: "none" },
      model: "claude-other-model",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "policy-widening-refused",
      widened: ["approvals", "sandbox"],
    });
    expect(session.executionPolicy).toEqual(askPolicy);
  });

  test.each([
    ["network access", { networkAccess: "full" }],
    ["project resources", { projectResources: true }],
    ["the policy id", { id: "interactive-host" }],
  ] as const)("refuses widening %s", async (label, patch) => {
    const session = sessionUnder(`config-policy-widen-${label}`, askPolicy);
    const response = await configure(session.id, { policy: { ...askPolicy, ...patch } });
    expect(response.status).toBe(403);
    expect(session.executionPolicy).toEqual(askPolicy);
  });

  test("narrowing is applied and reported", async () => {
    const session = sessionUnder("config-policy-narrow", askPolicy);
    const narrower: NativeAgentExecutionPolicy = {
      ...askPolicy,
      approvals: "deny",
      capabilityPolicy: { deny: ["network"] },
    };

    const response = await configure(session.id, { policy: narrower });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(session.executionPolicy).toEqual(narrower);
  });

  test("re-sending the same policy (a resume) is accepted", async () => {
    const session = sessionUnder("config-policy-same", askPolicy);
    const response = await configure(session.id, { policy: askPolicy });
    expect(response.status).toBe(200);
    expect(session.executionPolicy).toEqual(askPolicy);
  });

  test("a session with no policy yet (restored after a restart) takes the backend's policy", async () => {
    const session = sessionUnder("config-policy-unset", undefined);
    const response = await configure(session.id, { policy: askPolicy });
    expect(response.status).toBe(200);
    expect(session.executionPolicy).toEqual(askPolicy);
  });

  test("a request without a policy leaves the policy alone", async () => {
    const session = sessionUnder("config-policy-absent", askPolicy);
    const response = await configure(session.id, { fastMode: true });
    expect(response.status).toBe(200);
    expect(session.executionPolicy).toEqual(askPolicy);
  });
});
