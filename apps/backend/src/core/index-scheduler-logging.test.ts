import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import type { ScheduledJobServiceOptions, ScheduledJobWarning } from "./scheduled-jobs/service.js";
import { OrkestratorBackend } from "./index.js";

test("scheduled service warnings reach the production scheduler logger", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-scheduler-logging-"));
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => {},
    agentTools: {
      start: async () => {},
      stop: async () => {},
      connection: () => ({ url: "http://127.0.0.1:43210/mcp", token: "test-token" }),
      revokeEnvironment: () => {},
    },
  });
  const logs = captureLogs();
  try {
    const { log } = (
      backend as unknown as { scheduledJobs: { options: ScheduledJobServiceOptions } }
    ).scheduledJobs.options;
    expect(log).toBeDefined();
    const warnings: ScheduledJobWarning[] = [
      { event: "tick.failed" },
      { event: "job.claim-failed", jobId: "job-1" },
      { event: "fire.heartbeat-failed", fireId: "fire-1" },
      { event: "fire.outcome-record-failed", fireId: "fire-1" },
    ];
    const error = Object.assign(new Error("storage failed"), { code: "EIO" });
    for (const warning of warnings) log!(warning, error);
    const records = logs.records();
    expect(records).toHaveLength(warnings.length);
    for (const [index, { event, ...ids }] of warnings.entries()) {
      expect(records[index]).toMatchObject({
        area: "scheduler",
        level: "warn",
        event,
        fields: { ...ids, error: { name: "Error", code: "EIO", message: "storage failed" } },
      });
      expect(records[index]?.fields).not.toHaveProperty("detail");
    }
    log!({ event: "tick.failed" });
    expect(logs.records().at(-1)?.fields).not.toHaveProperty("error");
  } finally {
    logs.restore();
    try {
      await backend.shutdown();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }
});
