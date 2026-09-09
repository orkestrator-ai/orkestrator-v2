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
      expect(lines.join("\n")).not.toContain("integration-test-token");
    } else {
      expect(lines).toHaveLength(0);
    }
  },
);
