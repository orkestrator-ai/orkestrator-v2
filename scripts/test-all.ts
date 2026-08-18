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
 * Group output streams directly to a private per-group file while only a
 * bounded tail is retained in memory. Passing groups print a compact summary;
 * failing groups print that tail and retain a compressed artifact.
 *
 * Unlike the previous sequential runner this does **not** stop at the first
 * failing group: with concurrency the others have already run anyway, so
 * reporting every failure saves a second full run.
 */
import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const root = path.resolve(import.meta.dir, "..");

export interface CommandResult {
  status: number | null;
  /** Bounded tail of combined stdout/stderr for the console summary. */
  output?: string;
  /** Complete output up to the explicit safety limit. */
  logPath?: string;
  outputBytes?: number;
  outputLimitExceeded?: boolean;
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

export const TEST_LOG_DIRECTORY_ENV = "ORKESTRATOR_TEST_LOG_DIR";
export const TEST_MAX_OUTPUT_BYTES_ENV = "ORKESTRATOR_TEST_MAX_OUTPUT_BYTES";
export const INCLUDE_IOS_TESTS_ENV = "ORKESTRATOR_INCLUDE_IOS";
export const MAX_GROUP_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_GROUP_OUTPUT_TAIL_BYTES = 256 * 1024;
export const TEST_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const TEST_LOG_DIRECTORY_PREFIX = "orkestrator-test-run.";
const TEST_LOG_SENTINEL = ".orkestrator-test-log";

function safeLogName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "group"
  );
}

export function createTestLogDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), TEST_LOG_DIRECTORY_PREFIX));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(directory, TEST_LOG_SENTINEL),
    `${JSON.stringify({ version: 1, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  return directory;
}

export async function pruneExpiredTestLogDirectories(now = Date.now()): Promise<void> {
  const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEST_LOG_DIRECTORY_PREFIX)) continue;
    const target = path.join(tmpdir(), entry.name);
    const sentinel = path.join(target, TEST_LOG_SENTINEL);
    const summary = path.join(target, "summary.json");
    const [sentinelText, summaryInfo] = await Promise.all([
      readFile(sentinel, "utf8").catch(() => ""),
      stat(summary).catch(() => null),
    ]);
    let createdAt: number;
    try {
      const parsed = JSON.parse(sentinelText) as { version?: unknown; createdAt?: unknown };
      if (parsed.version !== 1) continue;
      createdAt = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAt)) continue;
    } catch {
      continue;
    }
    const retentionTimestamp = summaryInfo?.mtimeMs ?? createdAt;
    if (now - retentionTimestamp < TEST_LOG_RETENTION_MS) continue;
    await rm(target, { recursive: true, force: true });
  }
}

export function defaultRunGroup(group: TestGroup, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    const logDirectory = env[TEST_LOG_DIRECTORY_ENV] || createTestLogDirectory();
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    const logPath = path.join(logDirectory, `${safeLogName(group.name)}.log`);
    const log = createWriteStream(logPath, { flags: "w", mode: 0o600 });
    const configuredLimit = Number(env[TEST_MAX_OUTPUT_BYTES_ENV]);
    const maxOutputBytes =
      Number.isSafeInteger(configuredLimit) && configuredLimit > 0
        ? configuredLimit
        : MAX_GROUP_OUTPUT_BYTES;
    const child = spawn(group.command, group.args, {
      cwd: root,
      env,
      // Captured rather than inherited so concurrent groups do not interleave.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let outputBytes = 0;
    let persistedBytes = 0;
    let outputLimitExceeded = false;
    let outputTail = Buffer.alloc(0);
    let spawnError: Error | undefined;
    let logError: Error | undefined;
    let childStatus: number | null = 1;
    let childFinished = false;
    let logFinished = false;
    let resolved = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const appendTail = (chunk: Buffer) => {
      outputTail =
        chunk.byteLength >= MAX_GROUP_OUTPUT_TAIL_BYTES
          ? chunk.subarray(chunk.byteLength - MAX_GROUP_OUTPUT_TAIL_BYTES)
          : Buffer.concat([outputTail, chunk]).subarray(-MAX_GROUP_OUTPUT_TAIL_BYTES);
    };
    const consume = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      outputBytes += chunk.byteLength;
      appendTail(chunk);
      if (outputLimitExceeded || logError) return;
      const remaining = maxOutputBytes - persistedBytes;
      if (remaining > 0) {
        const persisted = chunk.subarray(0, remaining);
        persistedBytes += persisted.byteLength;
        log.write(persisted);
      }
      if (chunk.byteLength > remaining || outputBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        const marker = Buffer.from(
          `\n[orkestrator-test-runner] Output exceeded ${maxOutputBytes} bytes; terminating the group.\n`,
        );
        log.write(marker);
        appendTail(marker);
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceKill.unref();
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);

    const maybeResolve = () => {
      if (resolved || !childFinished || !logFinished) return;
      resolved = true;
      if (forceKill) clearTimeout(forceKill);
      const errors = [spawnError, logError]
        .filter((error): error is Error => Boolean(error))
        .map((error) => error.message);
      resolve({
        status: outputLimitExceeded || errors.length > 0 ? 1 : childStatus,
        output:
          `${outputTail.toString("utf8")}${errors.length ? `\n${errors.join("\n")}` : ""}`.trim(),
        logPath,
        outputBytes,
        outputLimitExceeded,
      });
    };
    const finishChild = (status: number | null) => {
      if (childFinished) return;
      childFinished = true;
      childStatus = status;
      if (forceKill) clearTimeout(forceKill);
      if (!logError) log.end();
      maybeResolve();
    };

    log.once("finish", () => {
      logFinished = true;
      maybeResolve();
    });
    log.once("error", (error) => {
      logError = error;
      logFinished = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
      maybeResolve();
    });

    child.once("error", (error) => {
      spawnError = error;
      finishChild(1);
    });
    child.once("close", (code) => {
      finishChild(code);
    });
  });
}

export type CompletedGroup = {
  group: TestGroup;
  result: CommandResult;
  elapsedMs: number;
};

export async function finalizeTestLogs(
  logDirectory: string | undefined,
  completed: readonly CompletedGroup[],
  succeeded: boolean,
): Promise<string | undefined> {
  if (!logDirectory) return undefined;
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });

  const groups = [];
  for (const entry of completed) {
    let artifact: string | undefined;
    let artifactError: string | undefined;
    if (entry.result.logPath) {
      if (!existsSync(entry.result.logPath)) {
        artifactError = `Log file unavailable during finalization: ${entry.result.logPath}`;
      } else {
        try {
          if (succeeded) {
            await unlink(entry.result.logPath);
          } else {
            artifact = `${entry.result.logPath}.gz`;
            await pipeline(
              createReadStream(entry.result.logPath),
              createGzip({ level: 1 }),
              createWriteStream(artifact, { mode: 0o600 }),
            );
            await unlink(entry.result.logPath);
          }
        } catch (error) {
          artifactError = error instanceof Error ? error.message : String(error);
          if (artifact) await rm(artifact, { force: true }).catch(() => undefined);
          artifact = undefined;
        }
      }
    }
    groups.push({
      name: entry.group.name,
      status: entry.result.status ?? 1,
      elapsedMs: entry.elapsedMs,
      outputBytes: entry.result.outputBytes ?? 0,
      outputLimitExceeded: entry.result.outputLimitExceeded ?? false,
      artifact: artifact ? path.basename(artifact) : undefined,
      artifactError,
    });
  }
  await writeFile(
    path.join(logDirectory, "summary.json"),
    `${JSON.stringify(
      {
        version: 1,
        succeeded: succeeded && groups.every((group) => !group.artifactError),
        groups,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return logDirectory;
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
export const MAX_AGGREGATE_TEST_WORKERS = 12;

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
export const ALLOW_MISSING_PROTOCOL_BINARY_ENV = "CODEX_PROTOCOL_CHECK_ALLOW_MISSING_BINARY";

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
  const bridges = MIN_BRIDGE_WORKERS;
  // Two package tasks at a time keep the React-heavy workspace tests from
  // multiplying peak heap while leaving enough capacity for the root long pole.
  const workspaceConcurrency = budget >= 8 ? 2 : 1;
  const workspace = budget >= 10 ? 2 : 1;
  // Root absorbs the remaining capacity. Its six-worker run is ~41% faster
  // than four workers on an 18-core host (81.7s versus 137.9s).
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
        "run",
        "test:workspace",
        "--cwd",
        ".",
        "--filter=@orkestrator/web",
        "--filter=@orkestrator/backend",
        "--filter=@orkestrator/desktop",
        "--filter=@orkestrator/web-public",
        "--filter=orkestrator",
        "--filter=@orkestrator/protocol",
        `--concurrency=${workers.workspaceConcurrency}`,
        "--cache-dir",
        ".turbo",
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
        "--only-failures",
        `--parallel=${workers.root}`,
      ],
    },
    {
      // The bridge packages have no `test` script of their own, so they are not
      // part of the turbo run above. Without this their suites never execute.
      name: "bridges",
      command: "bun",
      args: ["test", "bridges", "--only-failures", `--parallel=${workers.bridges}`],
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

export async function runAllTests(overrides: Partial<TestAllDependencies> = {}): Promise<number> {
  const dependencies = { ...defaultDependencies, ...overrides };
  await pruneExpiredTestLogDirectories().catch(() => undefined);
  const groups = buildConcurrentGroups(dependencies.cores);
  const usesDefaultRunner = dependencies.runGroup === defaultRunGroup;
  const configuredLogDirectory = dependencies.env[TEST_LOG_DIRECTORY_ENV];
  const logDirectory = usesDefaultRunner
    ? configuredLogDirectory || createTestLogDirectory()
    : undefined;
  const runEnvironment = logDirectory
    ? { ...dependencies.env, [TEST_LOG_DIRECTORY_ENV]: logDirectory }
    : dependencies.env;

  dependencies.log(`Running ${groups.length} test groups concurrently…`);
  const startedAt = Date.now();

  const results: CompletedGroup[] = await Promise.all(
    groups.map(async (group) => {
      const groupStartedAt = Date.now();
      const result = await dependencies.runGroup(
        group,
        group.env ? { ...runEnvironment, ...group.env } : runEnvironment,
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
    if (status !== 0 && result.output) dependencies.log(result.output.trimEnd());
    if (result.outputLimitExceeded) {
      dependencies.log(`Diagnostic output limit exceeded in ${group.name}.`);
    }
    if (status !== 0 && firstFailure === 0) firstFailure = status;
  }

  dependencies.log(`\nTest groups finished in ${formatDuration(Date.now() - startedAt)}`);

  if (firstFailure !== 0) {
    const failed = results
      .filter(({ result }) => (result.status ?? 1) !== 0)
      .map(({ group }) => group.name);
    dependencies.log(`Failing groups: ${failed.join(", ")}`);
    const artifacts = await finalizeTestLogs(logDirectory, results, false);
    if (artifacts) dependencies.log(`Failure artifacts: ${artifacts}`);
    return firstFailure;
  }

  // iOS runs last and alone: it drives a simulator, a single shared machine
  // resource that cannot be used alongside anything else.
  const xcodeDeveloperDirectory =
    dependencies.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
  if (
    dependencies.env[INCLUDE_IOS_TESTS_ENV] === "1" &&
    dependencies.platform === "darwin" &&
    dependencies.exists(xcodeDeveloperDirectory)
  ) {
    const iosGroup: TestGroup = {
      name: "ios",
      command: "bun",
      args: ["scripts/test-ios.ts"],
    };
    dependencies.log(`\nRunning ${iosGroup.name}…`);
    const startedAt = Date.now();
    const result = await dependencies.runGroup(iosGroup, runEnvironment);
    const ios = { group: iosGroup, result, elapsedMs: Date.now() - startedAt };
    results.push(ios);
    const status = result.status ?? 1;
    if (status !== 0 && result.output) dependencies.log(result.output.trimEnd());
    const artifacts = await finalizeTestLogs(logDirectory, results, status === 0);
    if (artifacts && status !== 0) dependencies.log(`Failure artifacts: ${artifacts}`);
    return status;
  }

  await finalizeTestLogs(logDirectory, results, true);
  return 0;
}

export async function main(
  overrides: Partial<TestAllDependencies> = {},
  // Not `process.exit`: setting the code lets the runtime drain the bounded
  // failure summary and finish pending artifact writes before exiting.
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
