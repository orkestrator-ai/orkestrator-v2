/**
 * Process ids for fake child processes.
 *
 * Production Orkestrator runs on the same host as the test suites, as the same
 * user. A fake child handed to real termination code (a supervisor's stop path,
 * `terminateProcessTree`, a group reaper) gets its pid signalled for real, and
 * often as a group: `process.kill(-pid, "SIGKILL")`. A plausible pid such as
 * 1001 or 4242 can name a live process or process group on the host, so a test
 * that forgets to stub termination kills something it never started.
 *
 * Every pid here lies above every platform's `pid_max`, so no process or
 * process group can ever hold it and a signal sent to it fails with ESRCH.
 * They also stay below 2^31, so `-pid` is still a valid 32-bit `pid_t` and the
 * failure is ESRCH rather than an argument error that a caller might treat
 * differently.
 */

/**
 * The first fake pid. Linux caps `kernel.pid_max` at 4_194_304 (2^22, its
 * `PID_MAX_LIMIT` on 64-bit); macOS uses 99_999; FreeBSD 99_999. 2.1e9 sits far
 * above all of them and leaves ~47 million fake pids below `UNMAPPED_PID`.
 */
export const FAKE_PID_BASE = 2_100_000_000;

/**
 * One pid guaranteed not to be a live process: for a test that needs "a pid
 * nothing maps to" rather than a family of distinct fakes. It is the largest
 * value `fakePid` will never return.
 */
export const UNMAPPED_PID = 2_147_483_646;

/**
 * The `n`th fake pid (`FAKE_PID_BASE + n`). Distinct `n` give distinct pids, so
 * tests can still tell their fakes apart. Throws for a negative, fractional or
 * too-large `n`, any of which could land on a real pid or on `UNMAPPED_PID`.
 */
export function fakePid(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`fakePid needs a non-negative integer, got ${n}`);
  }
  const pid = FAKE_PID_BASE + n;
  if (pid >= UNMAPPED_PID) {
    throw new RangeError(`fakePid(${n}) would reach UNMAPPED_PID (${UNMAPPED_PID})`);
  }
  return pid;
}
