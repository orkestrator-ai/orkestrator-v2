import { expect, test } from "bun:test";
import { join } from "node:path";

// Runs the pinned Claude CLI for real (no credentials, a local scripted model).
// To-do 0005 closed the warm first turn on what a spare does and refuses; when
// one of these fails after a Claude bump, that decision is worth reopening.
// Timings are printed by `mise run measure:claude:first-turn`, not asserted.

const RESULT_SENTINEL = "__FIRST_TURN_RESULT__";

test("a parked spare calls no model, keeps a session id and refuses a resume", async () => {
  // A clean process: the probe clears its own environment of any login.
  const probe = Bun.spawn(
    [process.execPath, join(import.meta.dir, "claude-first-turn.live-probe.ts"), "1"],
    { cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" },
  );
  const deadline = setTimeout(() => probe.kill(), 170_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const report = JSON.parse(
      stdout.slice(stdout.indexOf(RESULT_SENTINEL) + RESULT_SENTINEL.length),
    );
    for (const variant of report.sdk) {
      expect(variant.parkedRequests.filter((path: string) => path.endsWith("/messages"))).toEqual(
        [],
      );
    }
    const { sessionIdOption, resumeOption } = report.sessionBinding;
    expect(sessionIdOption.sessionId).toBe(sessionIdOption.asked);
    expect(resumeOption.refused).toContain("resume");
    // A spare does not connect an MCP server for the first turn ahead of time.
    const slow = report.sdk.find((variant: { name: string }) =>
      variant.name.includes("MCP server given inline"),
    );
    expect(slow.medianSpareFirstMs).toBeGreaterThanOrEqual(1_500);
  } finally {
    clearTimeout(deadline);
    if (probe.exitCode === null) probe.kill();
  }
}, 180_000);
