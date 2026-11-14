import { expect, test } from "bun:test";
import { join } from "node:path";

// Runs the pinned Claude CLI for real (no credentials, a local scripted model).
// To-do 0005 closed the warm first turn on what a spare does and refuses; when
// one of these fails after a Claude bump, that decision is worth reopening.
// Timings are printed by `mise run measure:claude:first-turn`, not asserted;
// only the slowest MCP variant's lower bound is, and overlap can only raise it.
// The probe runs its variants concurrently here (each on its own endpoint,
// home and bridge), which the measurement task leaves off to keep timings clean.

const RESULT_SENTINEL = "__FIRST_TURN_RESULT__";
const CLI_PID_SENTINEL = "__FIRST_TURN_CLI_PID__";
const STALLED_SENTINEL = "__FIRST_TURN_STALLED__";
const PROBE = join(import.meta.dir, "claude-first-turn.live-probe.ts");
/**
 * How long a failed probe may take to clean up and exit. Its CLI gets 2 s
 * after SIGTERM and 2 s after SIGKILL; the rest is start-up headroom.
 */
const FAILED_PROBE_EXIT_MS = 45_000;

test("a parked spare calls no model, keeps a session id and refuses a resume", async () => {
  // A clean process: the probe clears its own environment of any login.
  const probe = Bun.spawn([process.execPath, PROBE, "1", "concurrent"], {
    cwd: join(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
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

/**
 * The probe in its `stall` fault mode: the endpoint holds every model request,
 * so the one cold run fails with its CLI still running. `stalled` settles once
 * the first request is held, which is also after that CLI has started.
 */
function stalledProbe(turnDeadlineMs: number) {
  const probe = Bun.spawn(
    [process.execPath, PROBE, "1", "serial", "stall", String(turnDeadlineMs)],
    {
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let stderr = "";
  let onStalled: (() => void) | undefined;
  const stalled = new Promise<void>((resolve) => {
    onStalled = resolve;
  });
  const drained = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of probe.stderr) {
      stderr += decoder.decode(chunk, { stream: true });
      if (stderr.includes(STALLED_SENTINEL)) onStalled?.();
    }
  })();
  const stdout = new Response(probe.stdout).text();
  const startedAt = performance.now();
  let killedByDeadline = false;
  const deadline = setTimeout(() => {
    killedByDeadline = true;
    probe.kill("SIGKILL");
  }, FAILED_PROBE_EXIT_MS);
  const exited = (async () => {
    const exitCode = await probe.exited;
    clearTimeout(deadline);
    await Promise.all([drained, stdout]);
    const cliPids = [...stderr.matchAll(new RegExp(`${CLI_PID_SENTINEL}(\\d+)`, "g"))].map(
      (match) => Number(match[1]),
    );
    return {
      exitCode,
      stderr,
      stdout: await stdout,
      elapsedMs: performance.now() - startedAt,
      killedByDeadline,
      cliPids,
    };
  })();
  return { probe, stalled, exited };
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 only checks that the pid exists.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pids still alive once a short reaping window has passed. */
async function survivors(pids: number[]): Promise<number[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!pids.some(isAlive)) return [];
    await Bun.sleep(50);
  }
  return pids.filter(isAlive);
}

test("a turn that fails with its CLI still running reports the failure and stops the CLI", async () => {
  const { probe, exited } = stalledProbe(1_000);
  try {
    const run = await exited;
    expect(run.killedByDeadline, run.stderr).toBe(false);
    expect(run.exitCode, run.stderr).not.toBe(0);
    // The original failure is what the probe reports, not a cleanup error.
    expect(run.stderr).toContain("No turn result in 1000 ms");
    expect(run.stdout).not.toContain(RESULT_SENTINEL);
    expect(run.cliPids.length).toBeGreaterThan(0);
    expect(await survivors(run.cliPids)).toEqual([]);
  } finally {
    if (probe.exitCode === null) probe.kill("SIGKILL");
  }
}, 60_000);

test("SIGTERM mid-turn stops the probe and its CLI within the cleanup budget", async () => {
  // A turn deadline far past the test's, so only the signal can end the run.
  const { probe, stalled, exited } = stalledProbe(600_000);
  try {
    // An early exit means the fault never took hold; its stderr says why.
    const early = await Promise.race([stalled.then(() => undefined), exited]);
    expect(early).toBeUndefined();
    probe.kill("SIGTERM");
    const run = await exited;
    expect(run.killedByDeadline, run.stderr).toBe(false);
    expect(run.exitCode, run.stderr).toBe(143);
    expect(run.cliPids.length).toBeGreaterThan(0);
    expect(await survivors(run.cliPids)).toEqual([]);
  } finally {
    if (probe.exitCode === null) probe.kill("SIGKILL");
  }
}, 60_000);
