import { bridgeDiagnosticPayloads } from "@orkestrator/protocol/testing/bridge-diagnostic-lines";
import { expect, test } from "bun:test";
import { BRIDGE_LOG_POLICY_ROUTE } from "@orkestrator/protocol/log-policy";
import { parseLogRecordLine } from "@orkestrator/protocol/logger";
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
    const snapshots = bridgeDiagnosticPayloads(chunks.join("").split("\n"));
    // Lifecycle is written either way; the flag only adds the per-minute looks.
    const closed = snapshots.find((entry) => entry.event === "closed");
    expect(closed).toBeDefined();
    expect(closed.bridge).toBe("acp");
    expect(closed.counters.requestsSent).toBeGreaterThan(0);
    expect(closed.counters.responsesReceived).toBeGreaterThan(0);
    expect(closed.metrics.pendingRequests).toBe(0);
    expect(closed.stream).toBe("resolved");
    expect(chunks.join("")).not.toContain("integration-test-token");
    if (!enabled) expect(snapshots.filter((entry) => entry.event === "heartbeat")).toHaveLength(0);
  },
);

test("turning detail on reaches a running bridge process with no restart", async () => {
  const { child, base, headers } = await spawnBridge({
    env: { ORKESTRATOR_BRIDGE_DEBUG: "0" },
  });
  const chunks: string[] = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  const snapshots = () =>
    bridgeDiagnosticPayloads(chunks.join("").split("\n")).filter(
      (entry) => entry.event === "heartbeat",
    );
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
    expect(snapshot?.event).toBe("heartbeat");
    expect(snapshot?.bridge).toBe("acp");
    expect(snapshot?.counters.requestsSent).toBeGreaterThan(0);
    expect(chunks.join("")).not.toContain("integration-test-token");
  } finally {
    await stopChild(child);
  }
});

test("a bridge relaying to the backend keeps writing parseable records after a change", async () => {
  const { child, base, headers } = await spawnBridge({
    env: { ORKESTRATOR_BRIDGE_DEBUG: "0", ORKESTRATOR_BRIDGE_LOG_RELAY: "1" },
  });
  const chunks: string[] = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  const records = () =>
    chunks
      .join("")
      .split("\n")
      .flatMap((line) => parseLogRecordLine(line) ?? [])
      .filter((record) => record.area === "bridge.diagnostics" && record.event === "heartbeat");
  try {
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers });
    expect(created.status).toBe(201);
    expect(records()).toHaveLength(0);

    const applied = await nativeFetch(`${base}${BRIDGE_LOG_POLICY_ROUTE}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ seq: 1, level: "info", areaLevels: { bridge: "debug" } }),
    });
    expect(applied.status).toBe(200);
    for (let waited = 0; waited < 2_000 && records().length === 0; waited += 20) {
      await Bun.sleep(20);
    }
    expect(records()[0]).toMatchObject({ level: "info", event: "heartbeat" });
    expect(records()[0]?.fields?.bridge).toBe("acp");
  } finally {
    await stopChild(child);
  }
});
