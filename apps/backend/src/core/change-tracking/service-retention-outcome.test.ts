import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { createHarness, type Harness } from "./service-test-support.js";

let harness: Harness;
let logs: LogCapture;

beforeEach(() => {
  logs = captureLogs();
  harness = createHarness({ repo: false });
});

afterEach(() => {
  logs.restore();
  harness.cleanup();
});

describe("the last retention pass", () => {
  test("is null before the first pass, then holds its report", async () => {
    expect(harness.service.lastRetention()).toBeNull();
    await harness.service.runRetentionPass();
    const last = harness.service.lastRetention();
    expect(last).toMatchObject({ outcome: "completed", failedPasses: 0 });
    expect(last?.report?.storedBytes).toBeGreaterThanOrEqual(0);
    expect(Date.parse(last!.at)).toBeGreaterThan(0);
  });

  test("a failed pass is logged and counted rather than discarded", async () => {
    harness.service.retention.run = () => Promise.reject(new Error("/home/someone/secret"));
    await expect(harness.service.runRetentionPass()).resolves.toBeUndefined();
    expect(harness.service.lastRetention()).toMatchObject({
      outcome: "failed",
      failedPasses: 1,
      report: null,
    });
    const line = logs.records().find((record) => record.event === "retention.failed");
    expect(line?.level).toBe("warn");
    expect(JSON.stringify(line)).not.toContain("secret");
  });
});
