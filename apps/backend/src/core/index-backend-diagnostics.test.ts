import { expect, test, spyOn } from "bun:test";
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
