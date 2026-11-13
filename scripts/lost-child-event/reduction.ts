/**
 * Standalone attempts to reproduce Bun's lost child event (to-do 6900), with
 * the strict probe (`probe.ts`) and nothing from this repository's runtime.
 * Children run through `node:child_process` with `stdio: "pipe"` and settle on
 * `close`, as the old pipe-based `runCommand` did. macOS and Linux.
 *
 *   bun scripts/lost-child-event/reduction.ts pattern [iterations=1000] [--host] [--abort=MS]
 *   bun scripts/lost-child-event/reduction.ts replay <schedule.json> [iterations=100]
 *
 * `pattern`: each iteration dirties a Git repository and runs `status`,
 * `rev-parse`, `merge-base`, `for-each-ref` and `diff` at once, then
 * `checkout`; every tenth also runs a `git clone`. `--host` adds a long-lived
 * `bun -e` child that watches the repository recursively and streams batched
 * events back over a pipe, as the backend's macOS watch helper does.
 * `--abort=MS` SIGKILLs half the children's process groups and destroys their
 * streams 0 to MS ms after spawn, as an aborted scan does.
 *
 * `replay`: runs a spawn schedule the probe recorded from the real test
 * (`LOST_CHILD_PROBE_SCHEDULE`, first line), at its recorded offsets, against
 * a fresh repository layout each iteration.
 *
 * Prints probe records, then one summary line. Nothing here reproduced the
 * loss on 2026-11-13; see to-do 6900 for the counts.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { holdUntilClosed, mark, openFds, track } from "./probe";

const [mode = "pattern", ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
const positional = rest.filter((arg) => !arg.startsWith("--"));
const abortMs = Number(
  [...flags].find((flag) => flag.startsWith("--abort="))?.slice("--abort=".length) ?? 0,
);
const root = mkdtempSync(path.join(os.tmpdir(), "bun-lost-child-event-"));

/** Runs one command; resolves on `close`, or once the probe would have reported it lost. */
function run(argv: string[], cwd: string | undefined): Promise<void> {
  const before = openFds();
  const child = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, stdio: "pipe" });
  track(child, argv, before, cwd);
  child.stdout.resume();
  child.stderr.resume();
  child.on("error", () => undefined);
  child.stdin.end();
  if (abortMs > 0 && Math.random() < 0.5) {
    setTimeout(
      () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
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
    const settle = setTimeout(resolve, 15_000);
    child.once("close", () => {
      clearTimeout(settle);
      resolve();
    });
  });
}

const git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid"];

async function pattern(iterations: number): Promise<void> {
  const repo = path.join(root, "repo");
  await run(["git", "init", "-q", "-b", "main", repo], root);
  writeFileSync(path.join(repo, "README.md"), "# r\n");
  await run([...git, "-C", repo, "add", "."], root);
  await run([...git, "-C", repo, "commit", "-qm", "r"], root);
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
  const background: Promise<void>[] = [];
  for (let index = 0; index < iterations; index++) {
    writeFileSync(path.join(repo, "README.md"), `dirty ${index}\n`);
    if (index % 10 === 5) {
      const target = path.join(root, `clone-${index}`);
      background.push(
        run(["git", "clone", "-q", repo, target], root).then(() =>
          rmSync(target, { recursive: true, force: true }),
        ),
      );
    }
    await Promise.all([
      run(["git", "-C", repo, "status", "--porcelain=v2", "-z"], undefined),
      run(["git", "-C", repo, "rev-parse", "HEAD"], undefined),
      run(["git", "-C", repo, "merge-base", "HEAD", "main"], undefined),
      run(["git", "-C", repo, "for-each-ref", "refs/heads"], undefined),
      run(["git", "-C", repo, "diff", "--numstat", "HEAD"], undefined),
    ]);
    await run(["git", "-C", repo, "checkout", "-q", "--", "README.md"], undefined);
  }
  await Promise.all(background);
  helper?.stdin?.end();
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

type ScheduleEntry = { at: number; cwd: string; argv: string[] };

async function replay(file: string, iterations: number): Promise<void> {
  const schedule = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as ScheduleEntry[];
  // The recorded run's root: the directory holding its `repos/` and `origins/`.
  const sample = schedule.find((entry) => entry.cwd.includes("/repos/"))?.cwd;
  if (!sample) throw new Error("the schedule has no command run in a repos/ directory");
  const recordedRoot = sample.slice(0, sample.indexOf("/repos/"));
  for (let iteration = 0; iteration < iterations; iteration++) {
    const base = mkdtempSync(path.join(root, "replay-"));
    const remap = (value: string) => value.split(recordedRoot).join(base);
    for (const entry of schedule) if (entry.cwd) mkdirSync(remap(entry.cwd), { recursive: true });
    mkdirSync(path.join(base, "origins"), { recursive: true });
    writeFileSync(path.join(remap(sample), "README.md"), "# comparison\n");
    const started = Date.now();
    const pending: Promise<void>[] = [];
    for (const entry of schedule) {
      const wait = entry.at - (Date.now() - started);
      if (wait > 0) await Bun.sleep(wait);
      pending.push(run(entry.argv.map(remap), entry.cwd ? remap(entry.cwd) : undefined));
    }
    await Promise.all(pending);
    rmSync(base, { recursive: true, force: true });
  }
}

try {
  if (mode === "pattern") await pattern(Number(positional[0] ?? 1000));
  else if (mode === "replay") await replay(positional[0]!, Number(positional[1] ?? 100));
  else throw new Error(`unknown mode ${mode}: use pattern or replay`);
  await holdUntilClosed(30_000);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
