import { expect, test } from "bun:test";
import { join } from "node:path";

test("real SDK initialization fields and local model restrictions match bridge reads", async () => {
  // A clean process avoids the session harness's module-wide SDK mock.
  const probe = Bun.spawn(
    [process.execPath, join(import.meta.dir, "live-claude-control.live-probe.ts")],
    {
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = setTimeout(() => probe.kill(), 45_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("__LIVE_CONTROL_VERIFIED__");
  } finally {
    clearTimeout(deadline);
    if (probe.exitCode === null) probe.kill();
  }
}, 60_000);
