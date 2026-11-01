import { expect, test } from "bun:test";
import { BRIDGE_LOG_POLICY_ROUTE } from "@orkestrator/protocol/log-policy";
import { nativeFetch, spawnBridge, stopChild } from "./acp-test-harness.js";

test.each([false, true])(
  "ACP transport diagnostics follow the shared flag (debug=%s)",
  async (enabled) => {
    const { child, base, headers } = await spawnBridge({
      env: { ORKESTRATOR_BRIDGE_DEBUG: enabled ? "1" : "0" },
    });
    const chunks: string[] = [];
    child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
    try {
      const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers });
      expect(created.status).toBe(201);
    } finally {
      await stopChild(child);
    }
    const lines = chunks
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("[bridge-diagnostics] "));
    if (enabled) {
      const closed = lines
        .map((line) => JSON.parse(line.slice("[bridge-diagnostics] ".length)))
        .find((entry) => entry.event === "closed");
      expect(closed).toBeDefined();
      expect(closed.bridge).toBe("acp");
      expect(closed.counters.requestsSent).toBeGreaterThan(0);
      expect(closed.counters.responsesReceived).toBeGreaterThan(0);
      expect(closed.metrics.pendingRequests).toBe(0);
      expect(closed.stream).toBe("resolved");
      expect(lines.join("\n")).not.toContain("integration-test-token");
    } else {
      expect(lines).toHaveLength(0);
    }
  },
);

test("turning detail on reaches a running bridge process with no restart", async () => {
  const { child, base, headers } = await spawnBridge({
    env: { ORKESTRATOR_BRIDGE_DEBUG: "0" },
  });
  const chunks: string[] = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  const snapshots = () =>
    chunks
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("[bridge-diagnostics] "))
      .map((line) => JSON.parse(line.slice("[bridge-diagnostics] ".length)));
  try {
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers });
    expect(created.status).toBe(201);
    expect(snapshots()).toHaveLength(0);

    const applied = await nativeFetch(`${base}${BRIDGE_LOG_POLICY_ROUTE}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ seq: 1, level: "info", areaLevels: { bridge: "debug" } }),
    });
    expect(await applied.json()).toEqual({ applied: true, seq: 1, diagnostics: true });

    // The process scope opened while detail was off, and has counted since.
    for (let waited = 0; waited < 2_000 && snapshots().length === 0; waited += 20) {
      await Bun.sleep(20);
    }
    const [snapshot] = snapshots();
    expect(snapshot.event).toBe("heartbeat");
    expect(snapshot.bridge).toBe("acp");
    expect(snapshot.counters.requestsSent).toBeGreaterThan(0);
    expect(chunks.join("")).not.toContain("integration-test-token");
  } finally {
    await stopChild(child);
  }
});
