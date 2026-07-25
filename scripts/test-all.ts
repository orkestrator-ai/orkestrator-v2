/**
 * Runs the whole test suite.
 *
 * Two levels of parallelism, because the suite is dominated by I/O waits (tests
 * that boot real backend processes, bind ports, and drive happy-dom) rather than
 * CPU:
 *
 *  1. **Within a group** — `bun test --parallel=N` runs test *files* across an
 *     explicitly bounded worker pool. This is where almost all of the win is.
 *  2. **Across groups** — the workspace, root and bridge suites are independent,
 *     so they run concurrently instead of one after another.
 *
 * Group output is buffered and printed as a labelled block. Interleaving three
 * concurrent `bun test` streams would make failures much harder to read, and a
 * test log is only useful if you can tell which suite a failure came from.
 *
 * Unlike the previous sequential runner this does **not** stop at the first
 * failing group: with concurrency the others have already run anyway, so
 * reporting every failure saves a second full run.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dir, "..");

export interface CommandResult {
  status: number | null;
  /** Combined stdout/stderr. */
  output?: string;
}

export interface TestGroup {
  name: string;
  command: string;
  args: string[];
}

export interface TestAllDependencies {
  /** Runs one group to completion, capturing its output. */
  runGroup: (group: TestGroup, env: NodeJS.ProcessEnv) => Promise<CommandResult>;
  exists: (target: string) => boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  root: string;
  /** Logical cores, used to size the per-group worker pools. */
  cores: number;
  log: (message: string) => void;
}

export function defaultRunGroup(
  group: TestGroup,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(group.command, group.args, {
      cwd: root,
      env,
      // Captured rather than inherited so concurrent groups do not interleave.
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: string[] = [];
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: string) => chunks.push(chunk));

    child.once("error", (error) => {
      resolve({ status: 1, output: `${chunks.join("")}\n${error.message}` });
    });
    child.once("close", (code) => {
      resolve({ status: code, output: chunks.join("") });
    });
  });
}

const defaultDependencies: TestAllDependencies = {
  runGroup: defaultRunGroup,
  exists: existsSync,
  platform: process.platform,
  env: process.env,
  root,
  cores: availableParallelism(),
  log: (message) => process.stdout.write(`${message}\n`),
};

/**
 * Splits the available cores across the concurrent groups and the package tasks
 * inside the workspace Turbo group.
 *
 * Left to itself each group would spawn one worker per core, so three groups
 * would oversubscribe the machine threefold — tolerable on an 18-core
 * workstation, liable to thrash a 2-core CI runner. The root suite gets the
 * largest share because it is by far the biggest and slowest.
 */
export interface WorkerPlan {
  /** Bun workers used by each active workspace package task. */
  workspace: number;
  /** Maximum workspace package tasks Turbo may execute at once. */
  workspaceConcurrency: number;
  root: number;
  bridges: number;
}

/**
 * UI suites retain a substantial happy-dom/React graph per worker. On larger
 * developer machines, matching every logical core can exhaust memory while the
 * root and bridge groups are alive alongside Turbo's package tasks. Keep a
 * measured amount of parallelism without allowing core count alone to multiply
 * the suite's peak heap indefinitely.
 */
export const MAX_AGGREGATE_TEST_WORKERS = 10;

export function planWorkers(cores: number): WorkerPlan {
  // Three independent groups execute concurrently, so three workers is the
  // irreducible minimum. Above that, never plan more Bun workers than logical
  // cores across root + bridges + active workspace package tasks.
  const budget = Math.min(
    MAX_AGGREGATE_TEST_WORKERS,
    Math.max(3, Number.isFinite(cores) ? Math.floor(cores) : 1),
  );
  const workspaceConcurrency = Math.min(
    3,
    Math.max(1, Math.floor(budget / 4)),
  );
  const remainingAfterWorkspaceMinimum = budget - workspaceConcurrency;
  const bridges = Math.max(1, Math.floor(remainingAfterWorkspaceMinimum * 0.2));
  let root = Math.max(1, Math.floor(remainingAfterWorkspaceMinimum * 0.6));
  const workspace = Math.max(
    1,
    Math.floor((budget - root - bridges) / workspaceConcurrency),
  );
  const used = root + bridges + workspace * workspaceConcurrency;
  root += budget - used;
  return { workspace, workspaceConcurrency, root, bridges };
}

export function buildConcurrentGroups(cores: number): TestGroup[] {
  const workers = planWorkers(cores);
  return [
    {
      name: "workspace (web, backend, web-public)",
      command: "turbo",
      args: [
        "run", "test:workspace",
        "--cwd", ".",
        "--filter=@orkestrator/web",
        "--filter=@orkestrator/backend",
        "--filter=@orkestrator/web-public",
        `--concurrency=${workers.workspaceConcurrency}`,
        "--cache-dir", ".turbo",
        "--",
        `--parallel=${workers.workspace}`,
      ],
    },
    {
      name: "root (tests/)",
      command: "bun",
      args: ["test", "tests", `--parallel=${workers.root}`],
    },
    {
      // The bridge packages have no `test` script of their own, so they are not
      // part of the turbo run above. Without this their suites never execute.
      name: "bridges",
      command: "bun",
      args: ["test", "bridges", `--parallel=${workers.bridges}`],
    },
  ];
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export async function runAllTests(
  overrides: Partial<TestAllDependencies> = {},
): Promise<number> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const groups = buildConcurrentGroups(dependencies.cores);

  dependencies.log(`Running ${groups.length} test groups concurrently…`);
  const startedAt = Date.now();

  const results = await Promise.all(
    groups.map(async (group) => {
      const groupStartedAt = Date.now();
      const result = await dependencies.runGroup(group, dependencies.env);
      return { group, result, elapsedMs: Date.now() - groupStartedAt };
    }),
  );

  // Printed in declaration order, not completion order, so the log reads the
  // same between runs even though groups finish in whatever order they finish.
  let firstFailure = 0;
  for (const { group, result, elapsedMs } of results) {
    const status = result.status ?? 1;
    const banner = "=".repeat(72);
    dependencies.log(
      `\n${banner}\n${status === 0 ? "PASS" : "FAIL"}  ${group.name}  (${formatDuration(elapsedMs)})\n${banner}`,
    );
    if (result.output) dependencies.log(result.output.trimEnd());
    if (status !== 0 && firstFailure === 0) firstFailure = status;
  }

  dependencies.log(`\nTest groups finished in ${formatDuration(Date.now() - startedAt)}`);

  if (firstFailure !== 0) {
    const failed = results
      .filter(({ result }) => (result.status ?? 1) !== 0)
      .map(({ group }) => group.name);
    dependencies.log(`Failing groups: ${failed.join(", ")}`);
    return firstFailure;
  }

  // iOS runs last and alone: it drives a simulator, a single shared machine
  // resource that cannot be used alongside anything else.
  const xcodeDeveloperDirectory =
    dependencies.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
  if (dependencies.platform === "darwin" && dependencies.exists(xcodeDeveloperDirectory)) {
    const iosGroup: TestGroup = {
      name: "ios",
      command: "bun",
      args: ["scripts/test-ios.ts"],
    };
    dependencies.log(`\nRunning ${iosGroup.name}…`);
    const result = await dependencies.runGroup(iosGroup, dependencies.env);
    if (result.output) dependencies.log(result.output.trimEnd());
    return result.status ?? 1;
  }

  return 0;
}

export async function main(
  overrides: Partial<TestAllDependencies> = {},
  exit: (status: number) => void = (status) => process.exit(status),
): Promise<void> {
  const status = await runAllTests(overrides);
  if (status !== 0) {
    exit(status);
  }
}

if (import.meta.main) await main();
