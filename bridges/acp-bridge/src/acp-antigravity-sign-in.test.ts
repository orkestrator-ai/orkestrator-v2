import { describe, expect, test } from "bun:test";
import { nativeFetch, sharedBridge } from "./acp-test-harness.js";

// Its own bridge: a recorded sign-in refusal is process-wide for a minute.
const shared = sharedBridge({ ACP_PROVIDER: "antigravity" });

describe("Antigravity without a login", () => {
  test("a refused session/new leaves a deferred session that reports sign-in required", async () => {
    await shared.agentEnv({ FAKE_ACP_NEW_AUTH_REQUIRED: "1" });
    const { base, headers } = shared;
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    shared.track(id);
    const status = (await nativeFetch(`${base}/session/${id}/status`, { headers }).then(
      (response) => response.json(),
    )) as { readiness?: { state: string; message: string; signIn?: { hint?: string } } };
    expect(status.readiness).toMatchObject({
      state: "authentication-required",
      signIn: { hint: "Open a terminal and run agy acp --login." },
    });
    // Fixed text, never the agent's own words.
    expect(status.readiness?.message).toContain("agy acp --login");
    const auth = (await nativeFetch(`${base}/global/auth`, { headers }).then((response) =>
      response.json(),
    )) as { state: string };
    expect(auth.state).toBe("needs-auth");
  });
});

describe("Antigravity account catalogue", () => {
  const discovery = sharedBridge({ ACP_PROVIDER: "antigravity" });
  test("model discovery does not reuse a catalogue after the current login fails", async () => {
    const { base, headers } = discovery;
    const models = await nativeFetch(`${base}/global/models`, { headers });
    expect(models.ok).toBe(true);
    expect(((await models.json()) as { models: unknown[] }).models.length).toBeGreaterThan(0);
    await discovery.agentEnv({ FAKE_ACP_NEW_AUTH_REQUIRED: "1" });
    const refused = await nativeFetch(`${base}/global/models`, { headers });
    expect(refused.status).toBe(401);
  });
});
