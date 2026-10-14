import { describe, expect, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const { ptyProcesses, waitForCondition, waitForPtyProcessCount } = await createCommandFixtures();

// These helpers are the failure reporting path for most of the async tests in
// this file, so their timeout messages are the first thing a developer reads
// when a suite goes red. Pinning them keeps that diagnostic from silently
// regressing to Bun's generic per-test timeout.
describe("async test wait helpers", () => {
  test("reports the condition that never became true", async () => {
    await expect(waitForCondition(() => false, "a condition that never holds", 20)).rejects.toThrow(
      "Timed out waiting for a condition that never holds",
    );
  });

  test("reports both the expected and observed PTY process counts", async () => {
    ptyProcesses.splice(0);
    await expect(waitForPtyProcessCount(2, 20)).rejects.toThrow(
      "Timed out waiting for 2 PTY process(es), saw 0",
    );
  });

  test("returns as soon as the condition holds without exhausting the timeout", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 10);
    const start = Date.now();
    await waitForCondition(() => ready, "a condition that becomes true", 5_000);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
