import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineLoadReport } from "@orkestrator/protocol/machine-load";
import { OrkestratorBackend } from "./index.js";
import { MACHINE_LOAD_COARSE_BUCKET_MS } from "./machine-load.js";
import { readStoredValue, seedStore } from "./storage/test-support.js";

const FILE = "machine-load-history.json";
const MINUTE = 60_000;

function createBackend(dataDir: string): OrkestratorBackend {
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

async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-backend-machine-load-"));
  try {
    await run(dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test("a started backend reports the load history its previous run stored", async () => {
  await withDataDir(async (dataDir) => {
    // Two hours of 30% CPU that ended an hour ago: one coarse bucket and the
    // minutes after it, as the previous process would have written them.
    const end = Date.now() - 60 * MINUTE;
    const coarseEnd = end - 60 * MINUTE;
    const coarseStart = coarseEnd - MACHINE_LOAD_COARSE_BUCKET_MS;
    const fine = Array.from({ length: 60 }, (_, index) => {
      const startMs = coarseEnd + index * MINUTE;
      return [startMs, startMs + MINUTE, MINUTE, 30 * MINUTE, 50 * MINUTE];
    });
    const coarseMs = coarseEnd - coarseStart;
    seedStore(dataDir, FILE, {
      local: {
        version: 1,
        coarse: [[coarseStart, coarseEnd, coarseMs, 30 * coarseMs, 50 * coarseMs]],
        fine,
      },
    });

    const backend = createBackend(dataDir);
    try {
      await backend.init();
      const report = await backend.invoke<MachineLoadReport>("get_machine_load");
      const longest = report.load.find((entry) => entry.window === "24h")!;
      expect(longest.coveredSeconds).toBe(75 * 60);
      expect(longest.cpuPercent).toBe(30);
      // The hour the backend was down is no history.
      expect(report.load.find((entry) => entry.window === "5m")!.coveredSeconds).toBe(0);
    } finally {
      await backend.shutdown();
    }
  });
});

test("shutdown writes the history before storage closes, replacing a corrupt document", async () => {
  await withDataDir(async (dataDir) => {
    seedStore(dataDir, FILE, { local: { version: 1, fine: "not buckets", coarse: [] } });
    const backend = createBackend(dataDir);
    try {
      await backend.init();
    } finally {
      await backend.shutdown();
    }
    expect(readStoredValue(dataDir, FILE)).toEqual({
      local: { version: 1, fine: [], coarse: [] },
    });
  });
});
