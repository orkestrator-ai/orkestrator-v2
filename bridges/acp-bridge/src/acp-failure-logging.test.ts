/**
 * What a saved log says when an agent process or a route fails. These run the
 * real bridge, because the lines are the bridge's own stderr, which is all a
 * container's log file ever receives.
 */
import { describe, expect, test } from "bun:test";

import { LOG_FORMAT_ENV } from "@orkestrator/protocol/node/logger-environment";

import { nativeFetch, spawnBridge, waitFor } from "./acp-test-harness.js";

/** Starts a bridge writing JSON lines, as a container bridge does, so a line carries its level. */
async function spawnLoggingBridge(env: NodeJS.ProcessEnv = {}) {
  const bridge = await spawnBridge({ env: { ...env, [LOG_FORMAT_ENV]: "json" } });
  let output = "";
  bridge.child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  bridge.child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  return {
    ...bridge,
    output: () => output,
    record: async (event: string) =>
      JSON.parse(
        await waitFor(
          async () => output.split("\n").find((line) => line.includes(`"event":"${event}"`)) ?? "",
          (line) => line.length > 0,
        ),
      ) as { level: string; area: string; event: string; fields: Record<string, unknown> },
  };
}

describe("ACP failure logging", () => {
  test("an agent that dies mid-turn warns with its code and signal", async () => {
    const { base, headers, output, record } = await spawnLoggingBridge();
    const { id } = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };
    await nativeFetch(`${base}/session/${id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CRASH now", requestId: "crash-1" }),
    });

    expect(await record("agent.exited")).toMatchObject({
      level: "warn",
      area: "bridge.acp",
      fields: { code: 9, signal: null },
    });
    expect(output()).not.toContain("ACP process exited");
    expect(output()).not.toContain("CRASH now");
  });

  test("an agent the bridge closes normally is no failure", async () => {
    const { base, headers, output } = await spawnLoggingBridge();
    const { id } = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };
    const closed = await nativeFetch(`${base}/session/${id}/close`, { method: "POST", headers });
    expect(closed.status).toBe(200);

    expect(output()).not.toContain("agent.exited");
  });

  test("a route that answers 500 warns without the error's message", async () => {
    const { base, headers, output, record } = await spawnLoggingBridge({
      ACP_PROVIDER: "grok",
      FAKE_ACP_PROTOCOL_VERSION: "2",
    });
    const response = await nativeFetch(`${base}/session/create`, { method: "POST", headers });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("unsupported ACP protocol version 2");

    expect(await record("http.route-failed")).toMatchObject({
      level: "warn",
      fields: { method: "POST", error: { name: "Error" } },
    });
    expect(output()).not.toContain("unsupported ACP protocol version");
  });

  test("a deliberate client error is not a route failure", async () => {
    const { base, headers, output } = await spawnLoggingBridge();
    const response = await nativeFetch(`${base}/session/missing/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(output()).not.toContain("http.route-failed");
  });
});
