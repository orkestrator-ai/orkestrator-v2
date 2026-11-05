import { expect, test } from "bun:test";
import { commandInvocationCount, runCommand } from "./shell.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { runGit } from "@orkestrator/protocol/node/workspace-change-probe";

function diffScanStats() {
  return recurringWorkMetrics.snapshot().kinds["diff-scan"];
}

// The capture moved to protocol, which cannot import these metrics.
test("the backend still charges each capture to the recurring job that caused it", async () => {
  const before = diffScanStats();
  await recurringWorkMetrics.observe("diff-scan", async () => {
    await runCommand("sh", ["-c", "printf 12345"]);
  });
  const after = diffScanStats();
  expect(after?.workUnits["process-spawn"] ?? 0).toBe(
    (before?.workUnits["process-spawn"] ?? 0) + 1,
  );
  expect(after?.bytes ?? 0).toBe((before?.bytes ?? 0) + 5);
});

test("a capture protocol starts itself is charged the same way", async () => {
  const before = diffScanStats();
  const invocations = commandInvocationCount("git");
  await recurringWorkMetrics.observe("diff-scan", async () => {
    await runGit(["--version"], { cwd: process.cwd() });
  });
  expect(diffScanStats()?.workUnits["git-spawn"] ?? 0).toBe(
    (before?.workUnits["git-spawn"] ?? 0) + 1,
  );
  expect(commandInvocationCount("git")).toBe(invocations + 1);
});
