import { bridgeDiagnosticPayloads } from "@orkestrator/protocol/testing/bridge-diagnostic-lines";
import { expect, test } from "bun:test";
import { BRIDGE_LOG_POLICY_ROUTE } from "@orkestrator/protocol/log-policy";
import { parseLogRecordLine } from "@orkestrator/protocol/logger";
import { resolve } from "node:path";
import {
  here,
  nativeFetch,
  spawnBridge,
  stopChild,
  temporaryDirectory,
} from "./acp-test-harness.js";

test("a cancelled ACP process stays idle and detects a later pending request stall", async () => {
  const directory = await temporaryDirectory();
  const script = `
    import { expect } from "bun:test";
    import { BridgeRunDiagnostics, BRIDGE_DIAGNOSTICS_INTERVAL_MS as TICK } from "@orkestrator/protocol/node/bridge-diagnostics";
    import { configureLogger } from "@orkestrator/protocol/logger";
    import { AcpProcess } from ${JSON.stringify(resolve(here, "acp-context.ts"))};
    let now = Date.now();
    Date.now = () => now;
    let scope;
    const report = BridgeRunDiagnostics.prototype.report;
    BridgeRunDiagnostics.prototype.report = function(event) {
      scope = this;
      return report.call(this, event);
    };
    const snapshots = [];
    configureLogger({ level: "info", sink: ({ record }) => {
      if (record?.area === "bridge.diagnostics") snapshots.push(JSON.parse(record.fields.payload));
    } });
    const child = new AcpProcess();
    let updated;
    let update = new Promise(resolve => { updated = resolve; });
    child.onUpdate = () => updated();
    const heartbeat = () => { now += TICK; scope.report("heartbeat"); };
    const heartbeats = () => snapshots.filter(entry => entry.event === "heartbeat");
    try {
      const { sessionId } = await child.request("session/new", {});
      const prompt = child.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "HOLD" }] });
      await update;
      child.notify("session/cancel", { sessionId });
      expect(await prompt).toMatchObject({ stopReason: "cancelled" });
      // An idle process is no stall, and what changed since attaching is not stall evidence.
      heartbeat();
      const settled = heartbeats().length;
      expect(settled).toBeLessThanOrEqual(1);
      for (let i = 0; i < 3; i++) heartbeat();
      expect(heartbeats()).toHaveLength(settled);
      update = new Promise(resolve => { updated = resolve; });
      const later = child.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "HOLD" }] });
      await update;
      heartbeat(); // the request appearing is not stall evidence
      expect(heartbeats()).toHaveLength(settled);
      heartbeat(); // two quiet minutes waiting on it are
      expect(heartbeats()).toHaveLength(settled + 1);
      expect(heartbeats().at(-1)).toMatchObject({ phase: "cancelling", pendingToolCount: 1, lastDeltaAgoMs: 120000 });
      child.notify("session/cancel", { sessionId });
      await later;
      heartbeat(); // clearing the genuine stall is recorded
      expect(heartbeats()).toHaveLength(settled + 2);
      for (let i = 0; i < 3; i++) heartbeat();
      expect(heartbeats()).toHaveLength(settled + 2);
    } finally {
      await child.close();
    }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: resolve(here, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CWD: directory,
      ACP_STATE_DIR: directory,
      ORKESTRATOR_BRIDGE_DEBUG: "0",
      ACP_PROVIDER_CONFIG: JSON.stringify({
        id: "cursor",
        name: "Cancellation fixture",
        executable: resolve(here, "testing/fake-agent-close.ts"),
        argv: [],
        env: {},
        requiresAuthenticate: false,
        modeMap: {},
        extensionPrefixes: [],
        acknowledgedExtensionMethods: [],
        modelUpdateMethods: [],
        sessionUpdateMethods: [],
      }),
      FAKE_CLOSE_LOG: "",
      FAKE_CLOSE_STORE: "",
      FAKE_CLOSE_IGNORE_CANCEL: "0",
      FAKE_CLOSE_CANCEL_DELAY_MS: "0",
    },
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    expect(await child.exited).toBe(0);
    expect(await stdout).toBe("");
    expect(await stderr).toBe("");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

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
