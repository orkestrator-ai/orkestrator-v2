import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionPreferencesDir, setClaudeHomeForTesting } from "./claude-home.js";
import { recordedOwnerState, resetProcessIdentityCacheForTesting } from "./process-identity.js";
import {
  readSessionPreferences,
  setPreferenceLockTimeoutForTesting,
  updateSessionPreferences,
} from "./session-preferences.js";

const PID = 999_999_999;
const START = Date.UTC(2026, 9, 28, 2, 27, 14);
const MATCH = "Wed Oct 28 02:27:14 2026\n";
const REUSED = "Wed Oct 28 03:27:14 2026\n";
const owner = { pid: PID, instance: "previous-bridge", processStartedAt: START };
const slowPath = { slowPath: true };

function psResult(stdout: string, status: number | null = 0, error?: Error) {
  return { stdout, status, error } as ReturnType<typeof childProcess.spawnSync>;
}

const probe = mock<typeof childProcess.spawnSync>(() => psResult(MATCH));
const readProc = mock<typeof fs.readFileSync>(() => {
  throw Object.assign(new Error("proc is unreadable"), { code: "EACCES" });
});

// These tests simulate kernel identity and ps on every host, including Darwin.
// No real process is signalled, and no global module replacement is installed.
describe("process identity probes", () => {
  beforeEach(() => {
    resetProcessIdentityCacheForTesting();
    probe.mockReset();
    probe.mockImplementation(() => psResult(MATCH));
    readProc.mockReset();
    readProc.mockImplementation(() => {
      throw Object.assign(new Error("proc is unreadable"), { code: "EACCES" });
    });
    spyOn(process, "kill").mockReturnValue(true);
    spyOn(childProcess, "spawnSync").mockImplementation(probe);
    spyOn(fs, "readFileSync").mockImplementation(readProc);
  });

  afterEach(() => {
    mock.restore();
    resetProcessIdentityCacheForTesting();
  });

  test("rechecks a matching owner after exit and PID reuse without observing the free PID", () => {
    expect(recordedOwnerState(owner, slowPath)).toBe("alive");
    // The writer exits and the kernel reuses its pid between checks. kill(0)
    // still succeeds, but ps now identifies the replacement process.
    probe.mockReturnValue(psResult(REUSED));
    expect(recordedOwnerState(owner, slowPath)).toBe("dead");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(recordedOwnerState(owner, slowPath)).toBe("dead");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test("a cached match cannot survive an observed exit and subsequent PID reuse", () => {
    expect(recordedOwnerState(owner, slowPath)).toBe("alive");
    spyOn(process, "kill").mockImplementationOnce(() => {
      throw Object.assign(new Error("exited"), { code: "ESRCH" });
    });
    expect(recordedOwnerState(owner, slowPath)).toBe("dead");
    probe.mockReturnValue(psResult(REUSED));
    expect(recordedOwnerState(owner, slowPath)).toBe("dead");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test("falls back to ps when a recorded proc entry cannot be read", () => {
    expect(recordedOwnerState({ ...owner, procStart: "12345" }, slowPath)).toBe("alive");
    expect(readProc).toHaveBeenCalledWith(`/proc/${PID}/stat`, "utf8");
    probe.mockReturnValue(psResult(REUSED));
    expect(recordedOwnerState({ ...owner, procStart: "12345" }, slowPath)).toBe("dead");
    expect(probe).toHaveBeenCalledWith("ps", ["-o", "lstart=", "-p", String(PID)], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  test.each(["failure", "timeout", "throw", "empty", "malformed"])(
    "protects an unverified owner after ps %s and retries at the interval boundary",
    (failure) => {
      let now = START;
      spyOn(Date, "now").mockImplementation(() => now);
      if (failure === "throw") {
        probe.mockImplementationOnce(() => {
          throw new Error("ps unavailable");
        });
      } else {
        probe.mockReturnValueOnce(
          failure === "failure"
            ? psResult(REUSED, 1)
            : failure === "timeout"
              ? psResult("", null, Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
              : psResult(failure === "empty" ? "" : "not a start time"),
        );
      }
      expect(recordedOwnerState(owner, slowPath)).toBe("unverified");
      now += 59_999;
      expect(recordedOwnerState(owner, slowPath)).toBe("unverified");
      expect(probe).toHaveBeenCalledTimes(1);
      now += 1;
      expect(recordedOwnerState(owner, slowPath)).toBe("alive");
      expect(probe).toHaveBeenCalledTimes(2);
    },
  );

  test("compares Linux proc start and boot identity on every host", () => {
    readProc.mockImplementation((path) => {
      if (String(path).endsWith("/boot_id")) return "test-boot\n";
      // Fields 3 through 21 precede starttime (22); comm may contain spaces/parentheses.
      return `42 (command with ) spaces) ${Array(19).fill("0").join(" ")} 12345 0`;
    });
    const linuxOwner = { ...owner, procStart: "12345", bootId: "test-boot" };
    expect(recordedOwnerState(linuxOwner, { slowPath: false })).toBe("alive");
    expect(recordedOwnerState({ ...linuxOwner, procStart: "54321" }, slowPath)).toBe("dead");
    expect(recordedOwnerState({ ...linuxOwner, bootId: "previous-boot" }, slowPath)).toBe("dead");
    expect(probe).not.toHaveBeenCalled();
  });

  test("recovers a stale lock after its previously matching ps owner is replaced", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-reused-ps-owner-"));
    setClaudeHomeForTesting(home);
    setPreferenceLockTimeoutForTesting(1_000);
    try {
      const sessionId = "123e4567-e89b-42d3-a456-426614174000";
      await updateSessionPreferences(sessionId, { planMode: false });
      const lockPath = join(claudeSessionPreferencesDir(), `${sessionId}.json.lock`);
      await writeFile(lockPath, JSON.stringify({ ...owner, token: "old-lock" }));
      const stale = new Date(Date.now() - 60_000);
      await utimes(lockPath, stale, stale);
      expect(recordedOwnerState(owner, slowPath)).toBe("alive");
      probe.mockReturnValue(psResult(REUSED));

      await updateSessionPreferences(sessionId, { planMode: true });

      expect(await readSessionPreferences(sessionId)).toEqual({ planMode: true });
      expect(await readdir(claudeSessionPreferencesDir())).toEqual([`${sessionId}.json`]);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      setPreferenceLockTimeoutForTesting(null);
      setClaudeHomeForTesting(null);
      await rm(home, { recursive: true, force: true });
    }
  });
});
