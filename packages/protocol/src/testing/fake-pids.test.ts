import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FAKE_PID_BASE, UNMAPPED_PID, fakePid } from "./fake-pids.js";

/** Signal 0 checks existence only; it never delivers anything. */
function probeErrorCode(pid: number): string | undefined {
  try {
    process.kill(pid, 0);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

function readPidMax(): number | undefined {
  try {
    const value = Number(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

describe("fake pids", () => {
  test("fakePid offsets from the base and keeps distinct inputs distinct", () => {
    expect(fakePid(0)).toBe(FAKE_PID_BASE);
    expect(fakePid(1)).toBe(FAKE_PID_BASE + 1);
    expect(new Set([fakePid(1), fakePid(2), fakePid(1000)]).size).toBe(3);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("fakePid(%p) throws", (n) => {
    expect(() => fakePid(n)).toThrow(RangeError);
  });

  test("fakePid never reaches UNMAPPED_PID", () => {
    expect(() => fakePid(UNMAPPED_PID - FAKE_PID_BASE)).toThrow(RangeError);
    expect(fakePid(UNMAPPED_PID - FAKE_PID_BASE - 1)).toBeLessThan(UNMAPPED_PID);
  });

  test("no process or process group answers a fake pid", () => {
    for (const pid of [fakePid(1), fakePid(1000), UNMAPPED_PID]) {
      expect(probeErrorCode(pid)).toBe("ESRCH");
      if (process.platform !== "win32") expect(probeErrorCode(-pid)).toBe("ESRCH");
    }
  });

  test("every fake pid lies above this host's pid_max, where it is readable", () => {
    const pidMax = readPidMax();
    // Linux's hard ceiling and macOS's fixed limit hold even where /proc is absent.
    expect(FAKE_PID_BASE).toBeGreaterThan(4_194_304);
    expect(FAKE_PID_BASE).toBeGreaterThan(99_999);
    if (pidMax === undefined) return;
    expect(fakePid(0)).toBeGreaterThan(pidMax);
    expect(UNMAPPED_PID).toBeGreaterThan(pidMax);
  });

  test("negated fake pids stay valid 32-bit pid_t values", () => {
    expect(-UNMAPPED_PID).toBeGreaterThanOrEqual(-(2 ** 31) + 1);
  });
});
