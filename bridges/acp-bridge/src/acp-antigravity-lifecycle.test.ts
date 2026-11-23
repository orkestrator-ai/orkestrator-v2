import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  nativeFetch,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";

type Bridge = Awaited<ReturnType<typeof spawnBridge>>;

function read(bridge: Bridge, path: string): Promise<Response> {
  return nativeFetch(bridge.base + path, { headers: bridge.headers });
}

function post(bridge: Bridge, path: string, payload: object = {}): Promise<Response> {
  return nativeFetch(bridge.base + path, {
    headers: bridge.headers,
    method: "POST",
    body: JSON.stringify(payload),
  });
}

const provider = { ACP_PROVIDER: "antigravity" };

test("applies thinking against the configuration returned by the model switch", async () => {
  const directory = await temporaryDirectory();
  const requests = join(directory, "config");
  const bridge = await spawnBridge({
    env: { ...provider, FAKE_ACP_CONFIG_REQUEST_FILE: requests },
  });
  const { id } = (await post(bridge, "/session/create").then((response) => response.json())) as {
    id: string;
  };
  const changed = await post(bridge, `/session/${id}/config`, {
    modelId: "gpt-5.5",
    reasoningId: "max",
  });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({
    selectedModelId: "gpt-5.5",
    selectedReasoningId: "max",
  });
  expect(await readFile(requests, "utf8")).toContain('"configId":"effort-for-gpt","value":"max"');
  const refused = await post(bridge, `/session/${id}/prompt`, {
    prompt: "never forwarded",
    modelId: "removed",
  });
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(await refused.text()).toContain("selected Antigravity model is unavailable");
  expect(
    await read(bridge, `/session/${id}/messages`).then((response) => response.text()),
  ).not.toContain("never forwarded");
});

test("the login banner is handled as a sign-in refusal without exposing its URL", async () => {
  const bridge = await spawnBridge({ env: { ...provider, FAKE_ACP_NEW_LOGIN_BANNER: "1" } });
  const { id } = (await post(bridge, "/session/create").then((response) => response.json())) as {
    id: string;
  };
  const status = await read(bridge, `/session/${id}/status`).then((response) => response.text());
  expect(status).toContain("authentication-required");
  expect(status).not.toContain("private-login-link");
});

test("uses the explicitly configured auth method and confirms a session login", async () => {
  const directory = await temporaryDirectory();
  const requests = join(directory, "auth");
  const bridge = await spawnBridge({
    env: {
      ...provider,
      ORKESTRATOR_ANTIGRAVITY_AUTH_METHOD: "gemini-api-key",
      FAKE_ACP_AUTH_REQUEST_FILE: requests,
    },
  });
  const auth = () => read(bridge, "/global/auth").then((response) => response.json());
  expect(await auth()).toMatchObject({ state: "unknown" });
  expect((await post(bridge, "/session/create")).status).toBe(201);
  expect(await auth()).toMatchObject({ state: "signed-in" });
  expect(await readFile(requests, "utf8")).toContain('"methodId":"gemini-api-key"');
});

test.each(["unsupported transport", "resume refusal", "success"])(
  "restores an Antigravity transcript across a restart with %s",
  async (outcome) => {
    const stateDirectory = await temporaryDirectory();
    const requests = join(stateDirectory, "requests");
    const first = await spawnBridge({ stateDirectory, env: provider });
    const { id } = (await post(first, "/session/create").then((response) => response.json())) as {
      id: string;
    };
    expect(
      (await post(first, `/session/${id}/prompt`, { prompt: 'SESSION_INFO:{"title":"Retained"}' }))
        .status,
    ).toBe(202);
    await waitFor(
      () =>
        read(first, `/session/${id}/activity`).then((response) => response.json()) as Promise<{
          activity: string;
        }>,
      (value) => value.activity === "idle",
    );
    const before = await read(first, `/session/${id}/messages`).then((response) => response.json());
    await stopChild(first.child);
    const env = {
      ...provider,
      FAKE_ACP_SESSION_REQUEST_FILE: requests,
      ...(outcome === "unsupported transport" ? { FAKE_ACP_NO_HTTP_MCP: "1" } : {}),
      ...(outcome === "resume refusal" ? { FAKE_ACP_FAIL_RESUME: "1" } : {}),
    };
    const second = await spawnBridge({ stateDirectory, env });
    const route = `/session/${id}`;
    const attach = (token: string) =>
      post(second, `${route}/attach`, { agentMcp: { token, url: "http://127.0.0.1:1/mcp" } });
    expect(await read(second, `${route}/messages`).then((response) => response.json())).toEqual(
      before,
    );
    const resumed = await attach("fixture-a");
    if (outcome === "unsupported transport") {
      expect(resumed.status).toBe(424);
      expect(await resumed.text()).toContain("HTTP MCP transport");
      expect(await Bun.file(requests).exists()).toBe(false);
      return;
    }
    if (outcome === "resume refusal") {
      expect(resumed.ok).toBe(false);
      expect(await read(second, `${route}/messages`).then((response) => response.json())).toEqual(
        before,
      );
      return;
    }
    expect(resumed.ok).toBe(true);
    expect(await read(second, `${route}/config`).then((response) => response.json())).toMatchObject(
      {
        selectedModelId: "composer-2.5",
      },
    );
    expect((await attach("fixture-a")).ok).toBe(true);
    expect((await attach("fixture-b")).ok).toBe(true);
    const calls = (await readFile(requests, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map(({ method }) => method)).toEqual(["session/resume", "session/resume"]);
    expect(calls[0].mcpServers[0].headers[0].value).toBe("Bearer fixture-a");
    expect(calls[1].mcpServers[0].headers[0].value).toBe("Bearer fixture-b");
    expect(calls[0].pid).not.toBe(calls[1].pid);
    expect(
      await read(second, `${route}/messages`).then((response) => response.json()),
    ).toMatchObject({
      messages: before.messages,
      totalMessages: before.totalMessages,
    });
  },
);
