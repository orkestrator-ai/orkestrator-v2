/**
 * Runs the in-process reduction (`in-process.ts`, to-do 6900) on the old pipe
 * capture, without that capture ever reaching a branch:
 *
 *   bun scripts/lost-child-event/scratch.ts [runs=100] [--keep] [--in-tree]
 *     [--jobs=N] [--hold=MS] [--no-expect]
 *
 * 1. `git worktree add --detach` of HEAD under this checkout's git-ignored
 *    `output/agent-testing/lost-child-event-scratch-<time>/`, then
 *    `bun install --frozen-lockfile`.
 * 2. Copies this directory's files over the worktree's copy, so uncommitted
 *    edits here are what runs.
 * 3. Splices `pipe-runner.ts` into the worktree's
 *    `packages/protocol/src/node/command-capture.ts`: `executeCommandBytes`
 *    becomes a call to `runPipe`. That function's name and the
 *    `runCommandBytes` after it are the markers; the script refuses to run if
 *    either has moved.
 *    With `--in-tree` it also copies `in-process.ts` to the worktree's
 *    `apps/backend/src/core/lost-child-event-reduction.test.ts`, its imports
 *    rewritten to `./`, where test 1 itself lives, and runs that copy.
 * 4. Runs `in-process.ts` once per process, `runs` times, from the worktree's
 *    `apps/backend` with the strict probe, appending its records to
 *    `output/agent-testing/lost-child-event-scratch-<time>.jsonl`, and prints
 *    the totals. `--jobs=N` runs N processes at a time (default 1); each run
 *    writes its own file, appended after its `RUN` line when it ends, so a
 *    record still belongs to the run that made it. `--hold=MS` shortens the
 *    probe's 30 s wait after the test (`LOST_CHILD_PROBE_HOLD_MS`): 7000
 *    still records every loss, since a loss is recorded 5 s after it, but no
 *    longer shows whether a late event came. `--no-expect` sets
 *    `LOST_CHILD_NO_EXPECT=1`, so `in-process.ts` waits on its `cat-file`
 *    without `expect(...).rejects` (to-do 6900, task 3).
 * 5. Removes the worktree (`--keep` leaves it for a look).
 *
 * The records hold command labels and timings only (`probe.ts`). macOS and
 * Linux.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const runs = Number(args.find((arg) => !arg.startsWith("--")) ?? 100);
const keep = args.includes("--keep");
const inTree = args.includes("--in-tree");
const noExpect = args.includes("--no-expect");
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const jobs = Number(option("jobs") ?? 1);
const hold = option("hold");
if (!Number.isSafeInteger(runs) || runs <= 0) throw new Error("runs must be a positive integer");
if (!Number.isSafeInteger(jobs) || jobs <= 0) throw new Error("--jobs must be a positive integer");
if (hold !== undefined && !(Number(hold) >= 0)) throw new Error("--hold must be a number of ms");

const here = import.meta.dir;
const repo = path.resolve(here, "../..");
const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
const worktree = path.join(repo, "output", "agent-testing", `lost-child-event-scratch-${stamp}`);
const out = `${worktree}.jsonl`;

function sh(command: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv): number {
  const result = spawnSync(command, argv, { cwd, env, stdio: ["ignore", "ignore", "inherit"] });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const START = "function executeCommandBytes(";
const END = "async function runCommandBytes(";
const SPLICE = `function executeCommandBytes(
  command: string,
  args: string[],
  options: RunCommandOptions,
  timeoutMs: number,
  outputLimit: number,
  stderrLimit: number,
): Promise<ExecBufferResult> {
  // Spliced by scripts/lost-child-event/scratch.ts in a throwaway worktree (to-do 6900).
  const env = command === "git" ? nonInteractiveGitEnv(options.env) : options.env;
  return runPipe(
    command,
    args,
    { ...options, timeoutMs, maxOutputBytes: outputLimit, maxStderrBytes: stderrLimit },
    env,
  );
}

`;

function splice(file: string): void {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start < 0 || end < start)
    throw new Error(`${file} no longer has ${START} before ${END}; update scratch.ts`);
  const runner = path.join(worktree, "scripts/lost-child-event/pipe-runner.ts");
  writeFileSync(
    file,
    `import { runPipe } from ${JSON.stringify(runner)};\n` +
      source.slice(0, start) +
      SPLICE +
      source.slice(end),
  );
}

let failed = false;
if (sh("git", ["worktree", "add", "--detach", "--quiet", worktree, "HEAD"], repo) !== 0)
  throw new Error("git worktree add failed");
try {
  if (sh(process.execPath, ["install", "--frozen-lockfile"], worktree) !== 0)
    throw new Error("bun install failed in the scratch worktree");
  for (const name of readdirSync(here))
    if (name.endsWith(".ts"))
      copyFileSync(path.join(here, name), path.join(worktree, "scripts/lost-child-event", name));
  splice(path.join(worktree, "packages/protocol/src/node/command-capture.ts"));
  const backend = path.join(worktree, "apps/backend");
  let testFile = "../../scripts/lost-child-event/in-process.ts";
  if (inTree) {
    testFile = "src/core/lost-child-event-reduction.test.ts";
    const source = readFileSync(path.join(here, "in-process.ts"), "utf8");
    writeFileSync(
      path.join(backend, testFile),
      source.replaceAll("../../apps/backend/src/core/", "./"),
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (hold !== undefined) env.LOST_CHILD_PROBE_HOLD_MS = hold;
  if (noExpect) env.LOST_CHILD_NO_EXPECT = "1";
  let passed = 0;
  let next = 1;
  const once = (run: number) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "test",
          "--preload",
          "../../tests/setup-node.ts",
          "--preload",
          "../../scripts/lost-child-event/preload.ts",
          testFile,
        ],
        {
          cwd: backend,
          env: { ...env, LOST_CHILD_PROBE_OUT: `${out}.${run}` },
          stdio: ["ignore", "ignore", jobs === 1 ? "inherit" : "ignore"],
        },
      );
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  const worker = async () => {
    while (next <= runs) {
      const run = next++;
      const status = await once(run);
      if (status === 0) passed++;
      const records = `${out}.${run}`;
      appendFileSync(out, `${JSON.stringify({ kind: "RUN", run, status })}\n`);
      if (existsSync(records)) {
        appendFileSync(out, readFileSync(records));
        rmSync(records);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, runs) }, worker));
  const rows = readFileSync(out, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; tracked?: number; seq?: number });
  const count = (kind: string) => rows.filter((row) => row.kind === kind).length;
  const lostRuns = new Set<number>();
  let current = 0;
  for (const row of rows) {
    if (row.kind === "RUN") current = (row as unknown as { run: number }).run;
    else if (row.kind === "LOST_EXIT" || row.kind === "LOST_CLOSE") lostRuns.add(current);
  }
  console.log(
    JSON.stringify({
      kind: "SCRATCH",
      runs,
      jobs,
      noExpect,
      passed,
      children: rows.reduce((sum, row) => sum + (row.kind === "SUMMARY" ? row.tracked! : 0), 0),
      lostExit: count("LOST_EXIT"),
      lostClose: count("LOST_CLOSE"),
      runsWithLoss: lostRuns.size,
      // Each lost child's position among its run's children.
      positions: rows
        .filter((row) => row.kind === "LOST_EXIT" || row.kind === "LOST_CLOSE")
        .map((row) => row.seq)
        .sort((a, b) => a! - b!),
      records: out,
    }),
  );
  failed = passed < runs;
} finally {
  if (!keep) sh("git", ["worktree", "remove", "--force", worktree], repo);
}
process.exit(failed ? 1 : 0);
