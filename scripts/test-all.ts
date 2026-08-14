/**
 * Runs the whole test suite.
 *
 * Two levels of parallelism, because the suite is dominated by I/O waits (tests
 * that boot real backend processes, bind ports, and drive happy-dom) rather than
 * CPU:
 *
 *  1. **Within a group** — `bun test --parallel=N` runs test *files* across an
 *     explicitly bounded worker pool. This is where almost all of the win is.
 *     The Turbo group receives its bound through `ORKESTRATOR_TEST_WORKERS`
 *     rather than Turbo's `--` passthrough, which would be hashed into the
 *     dependency `build` tasks and split the build cache in two.
 *  2. **Across groups** — the workspace, root, bridge, and protocol checks are
 *     independent, so they run concurrently instead of one after another.
 *
 * Group output is buffered and printed as a labelled block. Interleaving
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
  /** Extra variables layered over the inherited environment for this group. */
  env?: Record<string, string>;
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
 * Left to itself each Bun test group would spawn one worker per core, so the
 * three worker-consuming groups would oversubscribe the machine threefold —
 * tolerable on an 18-core workstation, liable to thrash a 2-core CI runner.
 * The protocol check does not allocate a Bun test worker pool. The root suite
 * gets the largest share because it is by far the biggest and slowest.
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

/**
 * The bridge suites are ~50 files. A single worker made that group the long pole
 * of the whole run, so it gets a hard floor rather than a proportional share:
 * within `MAX_AGGREGATE_TEST_WORKERS` every proportional share of 20% rounds
 * down to one, which is how the floor was silently lost.
 */
export const MIN_BRIDGE_WORKERS = 2;

/** root(1) + bridges(2) + one worker for one workspace package task. */
export const MIN_AGGREGATE_TEST_WORKERS = 1 + MIN_BRIDGE_WORKERS + 1;

/**
 * The env var carrying the planned per-package worker count into the Turbo
 * group. It is deliberately *not* passed after Turbo's `--` separator: turbo
 * folds passthrough arguments into the hash of the requested task **and its
 * dependencies**, so `bun run build` and `bun run test` would compute different
 * `build` hashes and re-run `tsc && vite build` on every alternation.
 *
 * turbo.json declares it under `test:workspace.passThroughEnv`, which forwards
 * it in strict env mode while keeping it out of the hash.
 */
export const WORKSPACE_WORKERS_ENV = "ORKESTRATOR_TEST_WORKERS";
export const ALLOW_MISSING_PROTOCOL_BINARY_ENV =
  "CODEX_PROTOCOL_CHECK_ALLOW_MISSING_BINARY";

export function planWorkers(cores: number): WorkerPlan {
  // Never plan more Bun workers than logical cores across root + bridges +
  // active workspace package tasks, and never fewer than one per group.
  const budget = Math.min(
    MAX_AGGREGATE_TEST_WORKERS,
    Math.max(
      MIN_AGGREGATE_TEST_WORKERS,
      Number.isFinite(cores) ? Math.floor(cores) : MIN_AGGREGATE_TEST_WORKERS,
    ),
  );
  const bridges = Math.max(MIN_BRIDGE_WORKERS, Math.round(budget * 0.2));
  // Each concurrent package task costs at least one whole worker, so widen
  // Turbo's concurrency only once the budget can pay for it.
  const workspaceConcurrency = Math.min(3, Math.max(1, Math.floor(budget / 4)));
  // The root suite is the largest single group, so it takes its share off the
  // top instead of the remainder, and no package task may out-size it.
  const rootShare = Math.max(1, Math.floor(budget * 0.4));
  const workspace = Math.max(
    1,
    Math.min(
      rootShare,
      Math.floor((budget - rootShare - bridges) / workspaceConcurrency),
    ),
  );
  // Root also absorbs whatever the integer division above left unallocated, so
  // the plan spends exactly the budget rather than under-subscribing.
  const root = Math.max(1, budget - bridges - workspace * workspaceConcurrency);
  return { workspace, workspaceConcurrency, root, bridges };
}

export function buildConcurrentGroups(cores: number): TestGroup[] {
  const workers = planWorkers(cores);
  return [
    {
      name: "workspace (web, backend, desktop, web-public, cli, protocol)",
      command: "turbo",
      args: [
        "run", "test:workspace",
        "--cwd", ".",
        "--filter=@orkestrator/web",
        "--filter=@orkestrator/backend",
        "--filter=@orkestrator/desktop",
        "--filter=@orkestrator/web-public",
        "--filter=orkestrator",
        "--filter=@orkestrator/protocol",
        `--concurrency=${workers.workspaceConcurrency}`,
        "--cache-dir", ".turbo",
      ],
      env: { [WORKSPACE_WORKERS_ENV]: String(workers.workspace) },
    },
    {
      name: "root and agent-support tests",
      command: "bun",
      // A bare `tests` is a Bun substring filter and also matches
      // packages/*/tests. An explicit relative path confines discovery to the
      // repository's root tests and prevents package build/test races.
      args: [
        "test",
        "./tests",
        "./e2e/agent-testing/artifact-sanitizer.test.ts",
        "./test-fixtures/agent-project/server.test.ts",
        `--parallel=${workers.root}`,
      ],
    },
    {
      // The bridge packages have no `test` script of their own, so they are not
      // part of the turbo run above. Without this their suites never execute.
      name: "bridges",
      command: "bun",
      args: ["test", "bridges", `--parallel=${workers.bridges}`],
    },
    {
      // Always validates the committed TypeScript lockfile. On developer
      // machines with the pinned binary it additionally regenerates and checks
      // the full TypeScript + JSON Schema contract. Minimal CI environments may
      // lack that managed binary, so the generator has an explicit offline
      // fallback for this pipeline only.
      name: "codex protocol lockfile",
      command: "bun",
      args: ["run", "codex:protocol:check"],
      env: { [ALLOW_MISSING_PROTOCOL_BINARY_ENV]: "1" },
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
      const result = await dependencies.runGroup(
        group,
        group.env ? { ...dependencies.env, ...group.env } : dependencies.env,
      );
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
  // Not `process.exit`. Every group's output is buffered and printed in one
  // block, and a pipe — which is what the documented `| tee` workflow makes
  // stdout — accepts that write asynchronously. `process.exit` tears the
  // process down mid-flush, truncating the failing group's output at whatever
  // fits in the pipe buffer, which is precisely the text that explains the
  // failure. Setting the code lets the runtime drain stdout and exit on its own.
  exit: (status: number) => void = (status) => {
    process.exitCode = status;
  },
): Promise<void> {
  const status = await runAllTests(overrides);
  if (status !== 0) {
    exit(status);
  }
}

if (import.meta.main) await main();
