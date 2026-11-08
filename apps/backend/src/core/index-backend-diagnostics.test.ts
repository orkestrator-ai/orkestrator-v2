import { expect, mock, test, spyOn } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import { readHealthRows } from "./health-summary.js";
import { openBackendDatabase } from "./storage-stores.js";

function createBackend(dataDir: string) {
  return new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: {
      start: async () => undefined,
      stop: async () => undefined,
      connection: () => ({ url: "http://127.0.0.1:43210/mcp", token: "test-token" }),
      revokeEnvironment: () => undefined,
    },
    startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
  });
}

test("a real backend reports its database figures and leaves a clean-exit marker on shutdown", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-diagnostics-"));
  try {
    const backend = createBackend(dataDir);
    await backend.init();
    // The gateway reaches these through optional methods, so a type cannot catch a gap.
    expect(backend.databaseStats().main?.fileBytes).toBeGreaterThan(0);
    expect(backend.databaseStats().leaseWaits.bucketsMs.length).toBeGreaterThan(0);
    const gatewaySnapshot = { gateway: true };
    backend.attachGatewayMetrics(() => gatewaySnapshot);
    expect(backend.diagnostics.metricsSnapshot()).toBe(gatewaySnapshot);

    // Off under the test runner by default, like snapshots.
    backend.diagnostics.health.start();
    backend.diagnostics.health.sample();
    await backend.shutdown();

    const database = openBackendDatabase(dataDir);
    try {
      expect(readHealthRows(database).map((row) => row.kind)).toEqual([
        "started",
        "sample",
        "clean-exit",
      ]);
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("a failed shutdown drain closes diagnostics without a clean-exit marker", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-diagnostics-failed-"));
  try {
    const backend = createBackend(dataDir);
    await backend.init();
    backend.diagnostics.health.start();
    const close = spyOn(backend.diagnostics, "close");
    const drain = spyOn(backend["runtime"].localServers, "shutdown").mockRejectedValue(
      new Error("fixture drain failure"),
    );
    await expect(backend.shutdown()).rejects.toThrow("fixture drain failure");
    expect(close).toHaveBeenCalledWith({ clean: false });
    drain.mockRestore();
    close.mockRestore();
    const database = openBackendDatabase(dataDir);
    try {
      expect(readHealthRows(database).map((row) => row.kind)).toEqual(["started"]);
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("a rejecting Control MCP stop and a throwing earlier stop still close diagnostics and storage", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-diagnostics-close-"));
  const logs = captureLogs();
  try {
    const backend = createBackend(dataDir);
    await backend.init();
    backend.diagnostics.health.start();
    // A synchronous stop before the drain, then an awaited close after it.
    spyOn(backend["machineLoad"], "stop").mockImplementation(() => {
      throw new Error("fixture sampler failure");
    });
    spyOn(backend["controlMcp"], "stop").mockRejectedValue(new Error("fixture control failure"));
    const agentToolsStop = spyOn(backend["agentTools"], "stop");
    const diagnosticsClose = spyOn(backend.diagnostics, "close");
    const storageClose = spyOn(backend["context"].storage, "close");

    // The drain succeeded, so the first failed close fails the attempt.
    await expect(backend.shutdown()).rejects.toThrow("fixture control failure");
    expect(agentToolsStop).toHaveBeenCalledTimes(1);
    expect(diagnosticsClose).toHaveBeenCalledWith({ clean: true });
    expect(storageClose).toHaveBeenCalledTimes(1);
    expect(
      logs
        .records()
        .filter((record) => record.event === "shutdown.step-failed")
        .map((record) => record.fields?.step),
    ).toEqual(["machine-load", "control-mcp"]);
    const database = openBackendDatabase(dataDir);
    try {
      expect(readHealthRows(database).map((row) => row.kind)).toEqual(["started", "clean-exit"]);
    } finally {
      database.close();
    }
  } finally {
    logs.restore();
    mock.restore();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

test("shutdown clears the web annotation close cap once close settles", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-annotation-cap-"));
  const capTimers: unknown[] = [];
  const cleared = new Set<unknown>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  try {
    const backend = createBackend(dataDir);
    await backend.init();
    const annotationsClose = spyOn(backend["webAnnotations"], "close");
    spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const timer = realSetTimeout(handler, ms, ...args);
      if (ms === 5_000) capTimers.push(timer);
      return timer;
    }) as typeof setTimeout);
    spyOn(globalThis, "clearTimeout").mockImplementation(((timer?: unknown) => {
      cleared.add(timer);
      realClearTimeout(timer as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout);

    await backend.shutdown();

    expect(annotationsClose).toHaveBeenCalledTimes(1);
    expect(capTimers.length).toBeGreaterThan(0);
    // The former `Promise.race` left its 5 s timer pending after every shutdown.
    expect(capTimers.filter((timer) => !cleared.has(timer))).toEqual([]);
  } finally {
    mock.restore();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);
