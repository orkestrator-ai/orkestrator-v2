/**
 * Narrow-only execution policy (H4) through a real ACP bridge process, against
 * the fake agent the harness spawns. Nothing here reaches a provider.
 */
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import {
  nativeFetch,
  sharedBridge,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitFor,
  type SharedBridge,
  type SpawnedBridge,
} from "./acp-test-harness.js";

// `sandbox`, `networkAccess` and `projectResources` are reported as they apply,
// which on this bridge is fixed, so assertions read approvals and the tool list.
const askPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "provider",
  approvals: "ask",
  projectResources: false,
  toolPolicy: { deny: ["shell"] },
  networkAccess: "restricted",
};
const widerPolicy: NativeAgentExecutionPolicy = { ...askPolicy, approvals: "auto-approve" };
const narrowerPolicy: NativeAgentExecutionPolicy = { ...askPolicy, approvals: "deny" };

type Bridge = SpawnedBridge | SharedBridge;

async function post(bridge: Bridge, path: string, body: unknown): Promise<Response> {
  const response = await nativeFetch(`${bridge.base}${path}`, {
    method: "POST",
    headers: bridge.headers,
    body: JSON.stringify(body),
  });
  // A shared bridge closes what each test opened, so the next test's keys are free.
  if ("track" in bridge && path === "/session/create" && response.status === 201) {
    bridge.track(((await response.clone().json()) as { id: string }).id);
  }
  return response;
}

async function reportedApprovals(bridge: Bridge, sessionId: string): Promise<string | undefined> {
  const status = (await nativeFetch(`${bridge.base}/session/${sessionId}/status`, {
    headers: bridge.headers,
  }).then((response) => response.json())) as { policy?: { approvals?: string } };
  return status.policy?.approvals;
}

async function expectRefused(response: Response, widened: string[]): Promise<void> {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "policy-widening-refused", widened });
}

async function liveSession(bridge: Bridge, clientSessionKey: string): Promise<string> {
  const response = await post(bridge, "/session/create", { clientSessionKey, policy: askPolicy });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function idle(bridge: Bridge, sessionId: string): Promise<void> {
  await waitFor(
    () =>
      nativeFetch(`${bridge.base}/session/${sessionId}/status`, { headers: bridge.headers }).then(
        (response) => response.json() as Promise<{ status: string }>,
      ),
    (session) => session.status === "idle",
  );
}

async function agentStarts(lifecycleFile: string): Promise<number> {
  return ((await fs.readFile(lifecycleFile, "utf8").catch(() => "")).match(/^start:/gm) ?? [])
    .length;
}

// One bridge for every test that does not restart it; each opens its own session.
const shared = sharedBridge();

describe("the routes that take a policy for a live session", () => {
  test("create and resume refuse a wider policy, and keep the running agent", async () => {
    const lifecycleFile = resolve(await temporaryDirectory(), "wider.log");
    await shared.agentEnv({ FAKE_ACP_LIFECYCLE_FILE: lifecycleFile });
    const bridge = shared;
    const sessionId = await liveSession(bridge, "wider");
    const starts = await agentStarts(lifecycleFile);
    // The shared bridge's agent took this test's switches.
    expect(starts).toBeGreaterThan(0);

    await expectRefused(
      await post(bridge, "/session/create", { clientSessionKey: "wider", policy: widerPolicy }),
      ["approvals"],
    );
    await expectRefused(await post(bridge, "/session/resume", { sessionId, policy: widerPolicy }), [
      "approvals",
    ]);

    expect(await reportedApprovals(bridge, sessionId)).toBe("ask");
    expect(await agentStarts(lifecycleFile)).toBe(starts);
  });

  test("create applies a narrower policy by respawning the agent under it", async () => {
    const lifecycleFile = resolve(await temporaryDirectory(), "create-narrower.log");
    await shared.agentEnv({ FAKE_ACP_LIFECYCLE_FILE: lifecycleFile });
    const bridge = shared;
    const sessionId = await liveSession(bridge, "create-narrower");

    const response = await post(bridge, "/session/create", {
      clientSessionKey: "create-narrower",
      policy: narrowerPolicy,
    });

    expect(response.status).toBe(201);
    expect(await reportedApprovals(bridge, sessionId)).toBe("deny");
  });

  test("resume applies a narrower policy", async () => {
    const bridge = shared;
    const sessionId = await liveSession(bridge, "resume-narrower");

    const response = await post(bridge, "/session/resume", { sessionId, policy: narrowerPolicy });

    expect(response.status).toBe(201);
    expect(await reportedApprovals(bridge, sessionId)).toBe("deny");
  });

  test("create and resume accept an equal policy without respawning", async () => {
    const lifecycleFile = resolve(await temporaryDirectory(), "equal.log");
    await shared.agentEnv({ FAKE_ACP_LIFECYCLE_FILE: lifecycleFile });
    const bridge = shared;
    const sessionId = await liveSession(bridge, "equal");
    const starts = await agentStarts(lifecycleFile);
    // The shared bridge's agent took this test's switches.
    expect(starts).toBeGreaterThan(0);

    expect(
      (
        await post(bridge, "/session/create", {
          clientSessionKey: "equal",
          policy: structuredClone(askPolicy),
        })
      ).status,
    ).toBe(201);
    expect(
      (await post(bridge, "/session/resume", { sessionId, policy: structuredClone(askPolicy) }))
        .status,
    ).toBe(201);

    expect(await reportedApprovals(bridge, sessionId)).toBe("ask");
    expect(await agentStarts(lifecycleFile)).toBe(starts);
  });

  test("a request with no policy leaves it alone", async () => {
    const bridge = shared;
    const sessionId = await liveSession(bridge, "absent");

    expect((await post(bridge, "/session/create", { clientSessionKey: "absent" })).status).toBe(
      201,
    );
    expect((await post(bridge, "/session/resume", { sessionId })).status).toBe(201);

    expect(await reportedApprovals(bridge, sessionId)).toBe("ask");
  });

  test("a session with no policy takes the first it is sent", async () => {
    const bridge = shared;
    const created = await post(bridge, "/session/create", { clientSessionKey: "none" });
    const sessionId = ((await created.json()) as { id: string }).id;
    expect(await reportedApprovals(bridge, sessionId)).toBeUndefined();

    const taken = await post(bridge, "/session/create", {
      clientSessionKey: "none",
      policy: widerPolicy,
    });

    expect(taken.status).toBe(201);
    expect(await reportedApprovals(bridge, sessionId)).toBe("auto-approve");
  });

  test("a prompt naming a wider policy is refused; narrower and equal run under the session's own", async () => {
    const bridge = shared;
    const sessionId = await liveSession(bridge, "prompt");
    const prompt = (requestId: string, policy: NativeAgentExecutionPolicy) =>
      post(bridge, `/session/${sessionId}/prompt`, { prompt: "DIRECT:go", requestId, policy });

    await expectRefused(await prompt("wider", widerPolicy), ["approvals"]);

    for (const [requestId, policy] of [
      ["narrower", narrowerPolicy],
      ["equal", askPolicy],
    ] as const) {
      expect((await prompt(requestId, policy)).status).toBe(202);
      await idle(bridge, sessionId);
      expect(await reportedApprovals(bridge, sessionId)).toBe("ask");
    }
  });
});

describe("a bridge restart", () => {
  test("a restored session takes the backend's policy once, then holds it", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const sessionId = await liveSession(first, "restored");
    await stopChild(first.child);

    const restarted = await spawnBridge({ stateDirectory });
    expect(await reportedApprovals(restarted, sessionId)).toBe("ask");

    const taken = await post(restarted, "/session/create", {
      clientSessionKey: "restored",
      policy: widerPolicy,
    });
    expect(taken.status).toBe(201);
    expect(await reportedApprovals(restarted, sessionId)).toBe("auto-approve");

    await expectRefused(
      await post(restarted, "/session/resume", {
        sessionId,
        policy: { ...widerPolicy, id: "pipeline" },
      }),
      ["id"],
    );
    expect(await reportedApprovals(restarted, sessionId)).toBe("auto-approve");
  });

  test("a prompt makes the restored copy live, so it cannot be widened afterwards", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const sessionId = await liveSession(first, "restored-prompt");
    await stopChild(first.child);

    const restarted = await spawnBridge({ stateDirectory });
    const turn = await post(restarted, `/session/${sessionId}/prompt`, {
      prompt: "DIRECT:go",
      requestId: "restored-turn",
    });
    expect(turn.status).toBe(202);
    await idle(restarted, sessionId);

    await expectRefused(
      await post(restarted, "/session/create", {
        clientSessionKey: "restored-prompt",
        policy: widerPolicy,
      }),
      ["approvals"],
    );
    expect(await reportedApprovals(restarted, sessionId)).toBe("ask");
  });
});

test.each([narrowerPolicy, widerPolicy])(
  "concurrent create checks the joining policy",
  async (policy) => {
    const directory = await temporaryDirectory();
    const release = resolve(directory, "release-new");
    const requests = resolve(directory, "new-requests");
    await shared.agentEnv({
      FAKE_ACP_NEW_RELEASE_FILE: release,
      FAKE_ACP_SESSION_REQUEST_FILE: requests,
    });
    const bridge = shared;
    const first = post(bridge, "/session/create", { clientSessionKey: "join", policy: askPolicy });
    await waitFor(
      () => fs.readFile(requests, "utf8").catch(() => ""),
      (text) => text.includes("session/new"),
    );
    const second = post(bridge, "/session/create", { clientSessionKey: "join", policy });
    // Keep the first child held while the second HTTP request reaches admission.
    await Bun.sleep(30);
    await fs.writeFile(release, "release");
    const created = await first;
    expect(created.status).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;
    expect((await second).status).toBe(policy === widerPolicy ? 403 : 201);
    expect(await reportedApprovals(bridge, sessionId)).toBe(
      policy === widerPolicy ? "ask" : "deny",
    );
  },
);

test("narrowing a running ACP turn refuses without closing its child", async () => {
  const directory = await temporaryDirectory();
  const release = resolve(directory, "release-turn");
  const lifecycle = resolve(directory, "lifecycle");
  await shared.agentEnv({ FAKE_ACP_HOLD_TURN_FILE: release, FAKE_ACP_LIFECYCLE_FILE: lifecycle });
  const bridge = shared;
  const sessionId = await liveSession(bridge, "busy-policy");
  const starts = await agentStarts(lifecycle);
  expect(starts).toBeGreaterThan(0);
  expect(
    (await post(bridge, `/session/${sessionId}/prompt`, { prompt: "go", requestId: "busy" }))
      .status,
  ).toBe(202);
  try {
    for (const [path, body] of [
      ["/session/create", { clientSessionKey: "busy-policy", policy: narrowerPolicy }],
      ["/session/resume", { sessionId, policy: narrowerPolicy }],
    ] as const) {
      expect((await post(bridge, path, body)).status).toBe(409);
    }
    expect(await reportedApprovals(bridge, sessionId)).toBe("ask");
    expect(await agentStarts(lifecycle)).toBe(starts);
  } finally {
    await fs.writeFile(release, "release");
  }
});
