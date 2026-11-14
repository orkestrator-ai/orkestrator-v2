/**
 * Standalone attempts to reproduce Bun's lost child event (to-do 6900), with
 * the strict probe (`probe.ts`) and nothing from this repository's runtime.
 * Children run through `node:child_process` with `stdio: "pipe"` and settle on
 * `close`, as the old pipe-based `runCommand` did. macOS and Linux.
 *
 *   bun scripts/lost-child-event/reduction.ts pattern [iterations=1000] [--host] [--abort=MS]
 *   bun scripts/lost-child-event/reduction.ts replay <schedule.json> [iterations=100]
 *
 * Either mode takes `--block=MS` (`startBlocking`) and `--fs=MS`
 * (`startFsTraffic`). Neither loses events: the trigger is a nested event-loop
 * tick (`nested-tick.ts`, to-do 6900 task 3), which these modes never make.
 *
 * `pattern`: each iteration dirties a Git repository and runs `status`,
 * `rev-parse`, `merge-base`, `for-each-ref` and `diff` at once, then
 * `checkout`; every tenth also runs a `git clone`. `--host` adds a long-lived
 * `bun -e` child that watches the repository recursively and streams batched
 * events back over a pipe, as the backend's macOS watch helper does.
 * `--abort=MS` SIGKILLs half the scan children's process groups (the five
 * scans and the clone) and destroys their streams 0 to MS ms after spawn, as
 * an aborted scan does. The fixture's own commands (`init`, `add`, `commit`,
 * the per-iteration `checkout`) are never aborted and must succeed, so an
 * abort cannot leave the scans running against a broken repository; a lock
 * file a killed scan leaves behind is removed before the `checkout`.
 *
 * `replay`: runs a version 2 schedule the probe recorded from the real test
 * (`LOST_CHILD_PROBE_SCHEDULE`, first line) against a fresh copy of the test's
 * directories each iteration. It makes the test's recorded file writes, gives
 * each command its recorded Git identity, starts each entry at its recorded
 * offset once every entry that had finished before it in the recording has
 * finished, and substitutes each recorded revision with the one the replay's
 * own command printed. It never aborts. A schedule with a write it cannot
 * make (recorded without its content, being over 64 KiB, neither text nor
 * bytes, or made through a descriptor rather than a path; or outside the
 * test's directories) is refused before anything runs
 * (`IncompleteScheduleError`), since leaving the write out would replay a
 * different repository and workload.
 *
 * Every command's outcome is checked: in `pattern` a scan that was not aborted
 * must succeed, and in `replay` each command must exit as it did when it was
 * recorded. A mismatch is printed (`PATTERN_FAILURE`, `REPLAY_MISMATCH`, with
 * the command's label only) and the script exits 1, because a run whose
 * commands failed is not the workload it claims to be. A refused schedule
 * also exits 1.
 *
 * Prints probe records, then one summary line per mode, then the probe's
 * summary. See to-do 6900 for the counts.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  promises as fsPromises,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commandLabel,
  holdUntilClosed,
  mark,
  openFds,
  type ScheduleCommand,
  type ScheduleEntry,
  type ScheduleFile,
  SCHEDULE_VERSION,
  track,
} from "./probe";

const [mode = "pattern", ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
const positional = rest.filter((arg) => !arg.startsWith("--"));
const abortMs = Number(
  [...flags].find((flag) => flag.startsWith("--abort="))?.slice("--abort=".length) ?? 0,
);
let root = "";

type RunOptions = {
  /** May be picked for `--abort`. Only the measured workload is. */
  abortable?: boolean;
  env?: Record<string, string>;
  /** Keep up to 4 KiB of stdout (for a revision the command prints). */
  captureStdout?: boolean;
};
export type Outcome = {
  code: number | null;
  signal: string | null;
  aborted: boolean;
  /** Still not closed after 15 s. */
  timedOut: boolean;
  stdout: string;
};

/** Runs one command; resolves on `close`, or after 15 s, with how it ended. */
function run(argv: string[], cwd: string | undefined, options: RunOptions = {}): Promise<Outcome> {
  const env = options.env ? { ...process.env, ...options.env } : undefined;
  const before = openFds();
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    detached: true,
    stdio: "pipe",
    ...(env ? { env } : {}),
  });
  track(child, argv, before, cwd, options.env);
  const outcome: Outcome = {
    code: null,
    signal: null,
    aborted: false,
    timedOut: false,
    stdout: "",
  };
  if (options.captureStdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (outcome.stdout.length < 4096) outcome.stdout += chunk.slice(0, 4096);
    });
  } else child.stdout.resume();
  child.stderr.resume();
  child.on("error", () => undefined);
  child.stdin.end();
  child.once("exit", (code, signal) => {
    outcome.code = code;
    outcome.signal = signal;
  });
  if (options.abortable && abortMs > 0 && Math.random() < 0.5) {
    setTimeout(
      () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        outcome.aborted = true;
        mark(child.pid, "aborted");
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // Already gone.
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      },
      Math.floor(Math.random() * abortMs),
    );
  }
  return new Promise((resolve) => {
    const settle = setTimeout(() => {
      outcome.timedOut = true;
      resolve(outcome);
    }, 15_000);
    child.once("close", () => {
      clearTimeout(settle);
      resolve(outcome);
    });
  });
}

const git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid"];

/** A fixture command: never aborted, and it has to succeed. */
async function setup(argv: string[], cwd: string | undefined): Promise<void> {
  const outcome = await run(argv, cwd);
  if (outcome.code !== 0)
    throw new Error(
      `fixture command ${commandLabel(argv)} failed (exit ${outcome.code ?? outcome.signal})`,
    );
}

async function pattern(iterations: number): Promise<number> {
  const repo = path.join(root, "repo");
  await setup(["git", "init", "-q", "-b", "main", repo], root);
  writeFileSync(path.join(repo, "README.md"), "# r\n");
  await setup([...git, "-C", repo, "add", "."], root);
  await setup([...git, "-C", repo, "commit", "-qm", "r"], root);
  await setup(["git", "-C", repo, "rev-parse", "--verify", "-q", "HEAD"], root);
  let helper: ReturnType<typeof spawn> | null = null;
  if (flags.has("--host")) {
    helper = spawn(process.execPath, ["-e", WATCH_HELPER], {
      cwd: "/",
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    helper.stdout!.resume();
    helper.stdin!.write(`${JSON.stringify({ path: repo })}\n`);
  }
  const counts = { children: 0, aborted: 0, failures: 0, staleLocksRemoved: 0 };
  const check = (argv: string[], outcome: Outcome) => {
    counts.children++;
    if (outcome.aborted) counts.aborted++;
    else if (outcome.code !== 0 || outcome.timedOut) {
      counts.failures++;
      console.log(
        JSON.stringify({
          kind: "PATTERN_FAILURE",
          label: commandLabel(argv),
          exit: outcome.code,
          signal: outcome.signal,
          timedOut: outcome.timedOut,
        }),
      );
    }
  };
  const scan = (argv: string[], cwd?: string) =>
    run(argv, cwd, { abortable: true }).then((outcome) => check(argv, outcome));
  const lock = path.join(repo, ".git", "index.lock");
  const background: Promise<void>[] = [];
  for (let index = 0; index < iterations; index++) {
    writeFileSync(path.join(repo, "README.md"), `dirty ${index}\n`);
    if (index % 10 === 5) {
      const target = path.join(root, `clone-${index}`);
      background.push(
        scan(["git", "clone", "-q", repo, target], root).then(() =>
          rmSync(target, { recursive: true, force: true }),
        ),
      );
    }
    await Promise.all([
      scan(["git", "-C", repo, "status", "--porcelain=v2", "-z"]),
      scan(["git", "-C", repo, "rev-parse", "HEAD"]),
      scan(["git", "-C", repo, "merge-base", "HEAD", "main"]),
      scan(["git", "-C", repo, "for-each-ref", "refs/heads"]),
      scan(["git", "-C", repo, "diff", "--numstat", "HEAD"]),
    ]);
    // Every scan in this repository has closed (a clone takes no lock in it),
    // so a lock left now is a killed `status`'s, which would fail the checkout.
    if (existsSync(lock)) {
      rmSync(lock, { force: true });
      counts.staleLocksRemoved++;
    }
    await setup(["git", "-C", repo, "checkout", "-q", "--", "README.md"], undefined);
  }
  await Promise.all(background);
  helper?.stdin?.end();
  console.log(JSON.stringify({ kind: "PATTERN", iterations, abortMs, ...counts }));
  return counts.failures;
}

/** The backend's watch helper, reduced: one recursive watch, events batched every 50 ms. */
const WATCH_HELPER = String.raw`
const { watch } = require("node:fs");
let pending = [];
let timer = null;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split("\n");
  input = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    watch(JSON.parse(line).path, { recursive: true, persistent: true }, (type, name) => {
      pending.push([type, name]);
      timer ??= setTimeout(() => {
        timer = null;
        process.stdout.write(JSON.stringify({ events: pending.splice(0) }) + "\n");
      }, 50);
    });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const OID = /\b(?:[0-9a-f]{64}|[0-9a-f]{40})\b/g;

/** Reads a schedule, refusing one recorded before outcomes and writes were. */
export function readSchedule(text: string): ScheduleEntry[] {
  const parsed = JSON.parse(text.split("\n")[0]!) as ScheduleFile | unknown[];
  if (Array.isArray(parsed) || parsed.version !== SCHEDULE_VERSION)
    throw new Error(
      "this schedule predates version 2: it holds no file writes, Git identity, exit statuses or revisions, so a replay of it is not the recorded workload. Record it again with the current probe.",
    );
  return parsed.entries;
}

/** A schedule a replay cannot make faithfully; nothing has run when it is thrown. */
export class IncompleteScheduleError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `this schedule cannot be replayed as the recorded workload: ${problems.join("; ")}. Record it again with every write under 64 KiB of text or bytes.`,
    );
    this.name = "IncompleteScheduleError";
  }
}

/**
 * The writes a replay of `entries` could not make, by entry index and reason
 * (never a path or content): one recorded without its content, or one outside
 * `recordedRoot`, the recorded test's directories.
 */
export function incompleteWrites(
  entries: readonly ScheduleEntry[],
  recordedRoot: string,
): string[] {
  return entries.flatMap((entry, index) => {
    if ("argv" in entry) return [];
    if (entry.content === undefined && entry.contentBase64 === undefined)
      return [
        `entry ${index} is a write recorded without its content (${entry.skipped ?? "none"})`,
      ];
    if (!entry.write.startsWith(`${recordedRoot}/`))
      return [`entry ${index} writes outside the recorded test's directories`];
    return [];
  });
}

/** Runs one replayed command; `run` by default, or a capture under test. */
export type ReplayRunner = (
  argv: string[],
  cwd: string | undefined,
  options: { env?: Record<string, string>; captureStdout?: boolean },
) => Promise<Pick<Outcome, "code" | "timedOut" | "stdout">>;

/**
 * Replays a schedule file `iterations` times under `parent` (a fresh
 * directory each time). Exported so a scratch `bun test` file can replay it
 * inside the test runner, through the capture under test.
 */
export async function replay(
  file: string,
  iterations: number,
  runner: ReplayRunner = run,
  parent: string = root,
): Promise<number> {
  const schedule = readSchedule(readFileSync(file, "utf8"));
  const commands = schedule.filter((entry): entry is ScheduleCommand => "argv" in entry);
  // The recorded run's root: the directory holding its `repos/` and `origins/`.
  const sample = commands.find((entry) => entry.cwd.includes("/repos/"))?.cwd;
  if (!sample) throw new Error("the schedule has no command run in a repos/ directory");
  const recordedRoot = sample.slice(0, sample.indexOf("/repos/"));
  const incomplete = incompleteWrites(schedule, recordedRoot);
  if (incomplete.length > 0) throw new IncompleteScheduleError(incomplete);
  const counts = { commands: 0, writes: 0, mismatches: 0, unmappedRevisions: 0 };
  const mismatch = (iteration: number, index: number, detail: Record<string, unknown>) => {
    counts.mismatches++;
    console.log(JSON.stringify({ kind: "REPLAY_MISMATCH", iteration, index, ...detail }));
  };
  for (let iteration = 0; iteration < iterations; iteration++) {
    const base = mkdtempSync(path.join(parent, "replay-"));
    const remap = (value: string) => value.split(recordedRoot).join(base);
    /** Recorded revision → the replay's own. */
    const revisions = new Map<string, string>();
    const done: Array<Promise<void> | undefined> = [];
    const started = Date.now();
    for (const [index, entry] of schedule.entries()) {
      // Whatever had finished before this entry in the recording finishes first here.
      const open = new Set(entry.open);
      await Promise.all(done.slice(0, index).filter((_, earlier) => !open.has(earlier)));
      const wait = entry.at - (Date.now() - started);
      if (wait > 0) await Bun.sleep(wait);
      if (!("argv" in entry)) {
        // `incompleteWrites` has checked that every write has its content.
        const content = entry.content ?? Buffer.from(entry.contentBase64!, "base64");
        mkdirSync(path.dirname(remap(entry.write)), { recursive: true });
        writeFileSync(remap(entry.write), content);
        counts.writes++;
        done[index] = Promise.resolve();
        continue;
      }
      const argv = entry.argv.map((arg) =>
        remap(arg).replace(OID, (oid) => {
          const replayed = revisions.get(oid);
          if (replayed) return replayed;
          counts.unmappedRevisions++;
          return oid;
        }),
      );
      const cwd = entry.cwd ? remap(entry.cwd) : undefined;
      if (cwd) mkdirSync(cwd, { recursive: true });
      counts.commands++;
      done[index] = runner(argv, cwd, { env: entry.env, captureStdout: Boolean(entry.oid) }).then(
        (outcome) => {
          const label = commandLabel(entry.argv);
          if (entry.exit !== undefined && (outcome.timedOut || outcome.code !== entry.exit))
            mismatch(iteration, index, {
              label,
              recordedExit: entry.exit,
              replayedExit: outcome.code,
              timedOut: outcome.timedOut,
            });
          if (entry.oid) {
            const line = outcome.stdout.split("\n")[0]!.trim();
            if (/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(line)) revisions.set(entry.oid, line);
            else mismatch(iteration, index, { label, revision: "not printed" });
          }
        },
      );
    }
    await Promise.all(done);
    rmSync(base, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ kind: "REPLAY", iterations, ...counts }));
  return counts.mismatches;
}

const blockMs = Number(
  [...flags].find((flag) => flag.startsWith("--block="))?.slice("--block=".length) ?? 0,
);

/**
 * `--block=MS`: every 5 to 15 ms, holds the event loop in a busy-wait of 0 to
 * MS ms, as the backend's synchronous work (SQLite, sync file reads) does, so
 * children exit while the loop is not polling.
 */
function startBlocking(): () => void {
  if (blockMs <= 0) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const until = performance.now() + Math.random() * blockMs;
    while (performance.now() < until) {
      // Busy-wait: the loop is held, as by synchronous work.
    }
    timer = setTimeout(tick, 5 + Math.random() * 10);
  };
  timer = setTimeout(tick, 5);
  return () => clearTimeout(timer);
}

const fsMs = Number(
  [...flags].find((flag) => flag.startsWith("--fs="))?.slice("--fs=".length) ?? 0,
);

/**
 * `--fs=MS`: every 0 to MS ms, one `fs.promises` call (`stat`, `lstat` or
 * `access`) on the run's root, as the diff-stats service makes between its
 * commands. Each runs on Bun's thread pool and completes through the event
 * loop's wakeup, which the replay's commands alone never use.
 */
function startFsTraffic(): () => void {
  if (fsMs <= 0) return () => undefined;
  let stopped = false;
  const calls = [fsPromises.stat, fsPromises.lstat, fsPromises.access] as const;
  const tick = () => {
    if (stopped) return;
    const call = calls[Math.floor(Math.random() * calls.length)]!;
    (call as (target: string) => Promise<unknown>)(root).then(
      () => setTimeout(tick, Math.random() * fsMs),
      () => setTimeout(tick, Math.random() * fsMs),
    );
  };
  tick();
  return () => {
    stopped = true;
  };
}

if (import.meta.main) {
  root = mkdtempSync(path.join(os.tmpdir(), "bun-lost-child-event-"));
  const stopBlocking = startBlocking();
  const stopFsTraffic = startFsTraffic();
  let failures = 0;
  try {
    if (mode === "pattern") failures = await pattern(Number(positional[0] ?? 1000));
    else if (mode === "replay")
      failures = await replay(positional[0]!, Number(positional[1] ?? 100));
    else throw new Error(`unknown mode ${mode}: use pattern or replay`);
    stopBlocking();
    stopFsTraffic();
    await holdUntilClosed(30_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(failures > 0 ? 1 : 0);
}
