import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeEpoll,
  epollState,
  openFds,
  parseEpollRegistrations,
  stdioFdsSince,
  type ScheduleEntry,
} from "../../scripts/lost-child-event/probe";
import { runPool } from "../../scripts/lost-child-event/pool";
import {
  IncompleteScheduleError,
  incompleteWrites,
  readSchedule,
  replay,
  type ReplayRunner,
} from "../../scripts/lost-child-event/reduction";

const PROBE = path.resolve(import.meta.dirname, "../../scripts/lost-child-event/probe.ts");

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

describe("lost-child-event schedule recording", () => {
  test("records a write it cannot keep as skipped, so the replay refuses it", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "lost-child-event-test-"));
    temporary.push(directory);
    const scheduleFile = path.join(directory, "schedule.json");
    const root = path.join(directory, "run");
    const script = `
      const { holdUntilClosed, recordWrite } = await import(${JSON.stringify(PROBE)});
      const root = ${JSON.stringify(root)};
      recordWrite(root + "/repos/r/small", "dirty\\n");
      recordWrite(root + "/repos/r/bytes", new Uint8Array([1, 2, 3]));
      recordWrite(root + "/repos/r/large", "x".repeat(64 * 1024 + 1));
      recordWrite(root + "/repos/r/object", { not: "content" });
      recordWrite(7, "through a descriptor");
      await holdUntilClosed(0);
    `;
    const child = spawn(process.execPath, ["-e", script], {
      env: {
        ...process.env,
        LOST_CHILD_PROBE_SCHEDULE: scheduleFile,
        LOST_CHILD_PROBE_OUT: path.join(directory, "probe.jsonl"),
      },
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(0);
    const entries = readSchedule(readFileSync(scheduleFile, "utf8"));
    expect(entries.map((entry) => ("skipped" in entry ? entry.skipped : "kept"))).toEqual([
      "kept",
      "kept",
      "too-large",
      "unsupported-content",
      "unsupported-target",
    ]);
    expect(incompleteWrites(entries, root)).toEqual([
      "entry 2 is a write recorded without its content (too-large)",
      "entry 3 is a write recorded without its content (unsupported-content)",
      "entry 4 is a write recorded without its content (unsupported-target)",
    ]);
  }, 20_000);
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

// An epoll descriptor's fdinfo as Linux 7.2 prints it (Bun 1.4.4, one child on pipes).
const FDINFO = [
  "pos:\t0",
  "flags:\t02000002",
  "mnt_id:\t19",
  "ino:\t109",
  "tfd:        7 events: 40000019 data:  80005769ffa1850  pos:0 ino:3cdfead sdev:a",
  "tfd:       11 events:       19 data:  80005769ffa1828  pos:0 ino:3aa2532 sdev:6",
  "tfd:        6 events: 40000000 data:  80005769ffa1800  pos:0 ino:3cdfeac sdev:a",
  "tfd:        4 events: 80000019 data:      5769f6e0740  pos:0 ino:6d sdev:11",
  "",
].join("\n");

describe("lost-child-event probe epoll state", () => {
  test("parses every registration in an epoll descriptor's fdinfo", () => {
    expect(parseEpollRegistrations(FDINFO)).toEqual([
      { tfd: 7, events: "40000019", data: "80005769ffa1850" },
      { tfd: 11, events: "19", data: "80005769ffa1828" },
      { tfd: 6, events: "40000000", data: "80005769ffa1800" },
      { tfd: 4, events: "80000019", data: "5769f6e0740" },
    ]);
  });

  test("reports a disarmed one-shot, an unwatched end and a shared data word", () => {
    const registrations = [
      ...parseEpollRegistrations(FDINFO).map((r) => ({ ...r, epfd: 3 })),
      // A second descriptor registered with the same poll object as fd 6.
      { tfd: 20, events: "40000019", data: "80005769ffa1800", epfd: 3 },
    ];
    expect(describeEpoll([6, 9], registrations)).toEqual({
      entries: ["3:6:40000000", "9:unregistered"],
      sameData: ["3:20:40000019"],
    });
  });

  test.if(process.platform === "linux")(
    "reads this process's own epoll registrations for a child's ends",
    async () => {
      const before = openFds();
      const child = spawn("sleep", ["0.3"], { stdio: "pipe" });
      const fds = stdioFdsSince(before);
      child.stdout.on("data", () => undefined);
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      try {
        await Bun.sleep(50);
        const { entries } = epollState(fds);
        expect(entries).toHaveLength(fds.length);
        for (const entry of entries) expect(entry).toMatch(/^\d+:(\d+:[0-9a-f]+|unregistered)$/);
        // stdout has a data listener and the child has not exited, so Bun is
        // watching it: an epoll lookup that found no eventpoll descriptor
        // would report every end unregistered and pass the checks above.
        expect(entries.filter((entry) => !entry.endsWith(":unregistered")).length).toBeGreaterThan(
          0,
        );
      } finally {
        await closed;
      }
    },
    10_000,
  );
});

describe("lost-child-event scratch worker pool", () => {
  test("runs every task, at most `jobs` at a time", async () => {
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    await runPool(7, 3, async (index) => {
      started.push(index);
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
    });
    expect(started.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  test("after a failure it starts nothing new and waits for started tasks", async () => {
    const started: number[] = [];
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => (releaseHeld = resolve));
    let failing!: () => void;
    const failed = new Promise<void>((resolve) => (failing = resolve));
    let heldDone = false;
    const first = new Error("spawn failed");
    let settled = false;
    const pool = runPool(10, 2, async (index) => {
      started.push(index);
      if (index === 1) {
        await held;
        heldDone = true;
        return;
      }
      if (index === 2) {
        failing();
        throw first;
      }
      throw new Error("a later failure");
    }).finally(() => (settled = true));
    await failed;
    // A macrotask turn: every microtask the failure queued has run, so a pool
    // that settled on the first rejection would have settled by now.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Task 2 failed, task 1 is still running: no new task, and not settled.
    expect(started).toEqual([1, 2]);
    expect(settled).toBe(false);
    releaseHeld();
    await expect(pool).rejects.toBe(first);
    expect(heldDone).toBe(true);
    expect(started).toEqual([1, 2]);
  });
});
