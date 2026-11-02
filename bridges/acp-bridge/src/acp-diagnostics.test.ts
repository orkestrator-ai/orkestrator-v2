import { bridgeDiagnosticPayloads } from "@orkestrator/protocol/testing/bridge-diagnostic-lines";
import { expect, test } from "bun:test";
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
    if (enabled) {
      const closed = snapshots.find((entry) => entry.event === "closed");
      expect(closed).toBeDefined();
      expect(closed.bridge).toBe("acp");
      expect(closed.counters.requestsSent).toBeGreaterThan(0);
      expect(closed.counters.responsesReceived).toBeGreaterThan(0);
      expect(closed.metrics.pendingRequests).toBe(0);
      expect(closed.stream).toBe("resolved");
      expect(chunks.join("")).not.toContain("integration-test-token");
    } else {
      expect(snapshots).toHaveLength(0);
    }
  },
);
