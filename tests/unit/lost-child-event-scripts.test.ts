import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFds, stdioFdsSince, type ScheduleEntry } from "../../scripts/lost-child-event/probe";
import {
  IncompleteScheduleError,
  replay,
  type ReplayRunner,
} from "../../scripts/lost-child-event/reduction";

// The lost-child-event scripts (to-do 6900) are run by hand against a scratch
// worktree; these pin the parts whose mistakes would make their evidence say
// something it does not: a replay that leaves out a write, and descriptors
// attributed to a child that are not its stdio.

const RECORDED = "/recorded/run";
const REPO = `${RECORDED}/repos/r`;
const RECORDED_OID = "a".repeat(40);
const REPLAYED_OID = "b".repeat(40);

/** A schedule shaped like test 1's: a command, a write, a revision and its use. */
function schedule(write: Partial<Extract<ScheduleEntry, { write: string }>>): ScheduleEntry[] {
  return [
    { at: 0, cwd: REPO, argv: ["git", "init", "-q"], open: [], exit: 0 },
    { at: 0, write: `${REPO}/README.md`, open: [], ...write },
    { at: 0, cwd: REPO, argv: ["git", "rev-parse", "HEAD"], open: [], exit: 0, oid: RECORDED_OID },
    { at: 0, cwd: REPO, argv: ["git", "cat-file", "-p", RECORDED_OID], open: [], exit: 0 },
  ];
}

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scheduleFile(entries: ScheduleEntry[]): { file: string; parent: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "lost-child-event-test-"));
  temporary.push(directory);
  const file = path.join(directory, "schedule.json");
  writeFileSync(file, `${JSON.stringify({ version: 2, entries })}\n`);
  return { file, parent: directory };
}

type Call = { argv: string[]; readme: boolean };

/** A runner that spawns nothing: every command exits 0, `rev-parse` prints a new id. */
function fakeRunner(calls: Call[], exitOf: (argv: string[]) => number = () => 0): ReplayRunner {
  return async (argv, cwd) => {
    calls.push({ argv, readme: cwd !== undefined && existsSync(path.join(cwd, "README.md")) });
    return {
      code: exitOf(argv),
      timedOut: false,
      stdout: argv.includes("rev-parse") ? `${REPLAYED_OID}\n` : "",
    };
  };
}

describe("lost-child-event replay", () => {
  test("replays a complete schedule: makes its write and maps the recorded revision", async () => {
    const { file, parent } = scheduleFile(schedule({ content: "# r\n" }));
    const calls: Call[] = [];
    expect(await replay(file, 1, fakeRunner(calls), parent)).toBe(0);
    expect(calls.map((call) => call.argv.slice(0, 2).join(" "))).toEqual([
      "git init",
      "git rev-parse",
      "git cat-file",
    ]);
    // The write was made before the commands recorded after it.
    expect(calls.map((call) => call.readme)).toEqual([false, true, true]);
    expect(calls[2]!.argv).toContain(REPLAYED_OID);
    expect(calls[2]!.argv).not.toContain(RECORDED_OID);
  });

  test("refuses a schedule with a write recorded without its content, running nothing", async () => {
    // Every command would still exit as recorded, so only the refusal shows the gap.
    const { file, parent } = scheduleFile(schedule({ skipped: "too-large" }));
    const calls: Call[] = [];
    const replayed = replay(file, 1, fakeRunner(calls), parent);
    await expect(replayed).rejects.toBeInstanceOf(IncompleteScheduleError);
    await expect(replayed).rejects.toThrow(
      "entry 1 is a write recorded without its content (too-large)",
    );
    expect(calls).toEqual([]);
  });

  test("refuses a schedule with a write outside the recorded test's directories", async () => {
    const { file, parent } = scheduleFile([
      ...schedule({ content: "# r\n" }),
      { at: 0, write: "/elsewhere/file", content: "x", open: [] },
    ]);
    const calls: Call[] = [];
    await expect(replay(file, 1, fakeRunner(calls), parent)).rejects.toThrow(
      "entry 4 writes outside the recorded test's directories",
    );
    expect(calls).toEqual([]);
  });

  test("counts a command that exits differently from the recording as a mismatch", async () => {
    const { file, parent } = scheduleFile(schedule({ content: "# r\n" }));
    const runner = fakeRunner([], (argv) => (argv.includes("cat-file") ? 128 : 0));
    expect(await replay(file, 1, runner, parent)).toBe(1);
  });

  test("refuses a version 1 schedule", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "lost-child-event-test-"));
    temporary.push(directory);
    const file = path.join(directory, "schedule.json");
    writeFileSync(file, `${JSON.stringify([{ at: 0, cwd: REPO, argv: ["git", "status"] }])}\n`);
    await expect(replay(file, 1, fakeRunner([]), directory)).rejects.toThrow("predates version 2");
  });
});

describe("lost-child-event probe descriptors", () => {
  test("lists only descriptors still open, never the listing's own", () => {
    const listed = openFds();
    expect(openFds()).toEqual(listed);
    for (const fd of listed) expect(() => fstatSync(fd)).not.toThrow();
  });

  test("attributes to a child only the pipes or sockets opened across its spawn", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "lost-child-event-test-"));
    temporary.push(directory);
    const before = openFds();
    // Opened alongside the spawn: neither is the child's stdio.
    const directoryFd = openSync(directory, "r");
    const fileFd = openSync(path.join(directory, "file"), "w");
    const child = spawn("true", [], { stdio: "pipe" });
    const fds = stdioFdsSince(before);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      expect(fds).toHaveLength(3);
      expect(fds).not.toContain(directoryFd);
      expect(fds).not.toContain(fileFd);
      for (const fd of fds) {
        const stat = fstatSync(fd);
        expect(stat.isFIFO() || stat.isSocket()).toBe(true);
      }
    } finally {
      closeSync(directoryFd);
      closeSync(fileFd);
      await closed;
    }
  }, 10_000);
});
