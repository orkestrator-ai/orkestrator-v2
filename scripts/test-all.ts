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
 * failing groups print that tail, then every Bun failure report seen anywhere
 * in their output, and retain a compressed artifact.
 *
 * Unlike the previous sequential runner this does **not** stop at the first
 * failing group: with concurrency the others have already run anyway, so
 * reporting every failure saves a second full run.
 *
 * Tests that wait on real processes, servers, or wall-clock time form the slow
 * tier (`test-tiers.ts`). The default run leaves them out; `mise run test:slow`
 * runs only them, and CI runs both through `mise run test:full`.
 *
 * Only one complete aggregate run holds the host at a time (see
 * `test-admission.ts`); overlapping suites slowed each other into timeouts.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGzip } from "node:zlib";
import { createTestAdmission } from "./test-admission";
import { testTier, tierArguments, type TestTier } from "./test-tiers";

const root = path.resolve(import.meta.dir, "..");

export interface CommandResult {
  status: number | null;
  infrastructureError?: boolean;
  /** Bounded tail of combined stdout/stderr for the console summary. */
  output?: string;
  /** Bun's report for each failing test, wherever it appeared in the output. */
  failureReports?: string[];
  /** Failures beyond {@link MAX_FAILURE_REPORTS}, counted but not kept. */
  omittedFailureReports?: number;
  /** Each test file Bun reported a failure in, with the Turbo task that ran it. */
  failingFiles?: FailingFile[];
  /** Complete output up to the explicit safety limit. */
  logPath?: string;
  outputBytes?: number;
  outputLimitExceeded?: boolean;
  timeoutReason?: "no-progress" | "absolute";
}

export interface TestGroup {
  name: string;
  /** Repository-relative working directory; the repository root when absent. */
  cwd?: string;
  workers?: number;
  exclusive?: boolean;
  onSpawn?: (pid: number) => void;
  command: string;
  args: string[];
  /** Extra variables layered over the inherited environment for this group. */
  env?: Record<string, string>;
  /** Absolute watchdog budget when this group is slower than a Bun suite. */
  timeoutMs?: number;
  /**
   * Wall-clock time (`Date.now()` milliseconds) by which the group must have
   * finished, queue wait included. Admission gives up queuing at this time
   * without starting the child, and once admitted shortens `timeoutMs` to
   * what is left, so a budget set before queuing still holds after it.
   */
  deadline?: number;
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
  /**
   * Runs the guard stage. Defaults to the real runner only with the real
   * group runner, so a substituted `runGroup` sees exactly the test groups.
   */
  runGuards?: (group: TestGroup, env: NodeJS.ProcessEnv) => Promise<CommandResult>;
  /**
   * Whether a failed run reruns each failing test file alone. Defaults to on
   * with the real group runner; `ORKESTRATOR_TEST_RERUN_FAILED=0` turns it off.
   */
  rerunFailedFiles?: boolean;
  /** Where and how a failing file of the task with this prefix reruns alone. */
  resolveRerun?: (taskPrefix: string) => RerunTarget | undefined;
}

export const TEST_LOG_DIRECTORY_ENV = "ORKESTRATOR_TEST_LOG_DIR";
export const TEST_MAX_OUTPUT_BYTES_ENV = "ORKESTRATOR_TEST_MAX_OUTPUT_BYTES";
export const TEST_NO_PROGRESS_TIMEOUT_MS_ENV = "ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS";
export const TEST_GROUP_TIMEOUT_MS_ENV = "ORKESTRATOR_TEST_GROUP_TIMEOUT_MS";
export const TEST_ALLOW_CONCURRENT_ENV = "ORKESTRATOR_TEST_ALLOW_CONCURRENT";
export const TEST_AFFECTED_ENV = "ORKESTRATOR_TEST_AFFECTED";
export const TEST_TIMINGS_DIRECTORY_ENV = "ORKESTRATOR_TEST_TIMINGS_DIR";
export const INCLUDE_IOS_TESTS_ENV = "ORKESTRATOR_INCLUDE_IOS";
/** `1` skips the guard stage (`scripts/guards.ts`), for a rerun after it already passed. */
export const TEST_SKIP_GUARDS_ENV = "ORKESTRATOR_TEST_SKIP_GUARDS";
export const MAX_GROUP_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_GROUP_OUTPUT_TAIL_BYTES = 256 * 1024;
export const MAX_FAILURE_REPORTS = 25;
/** Lines of the failing task's own output kept before each `(fail)` line. */
export const FAILURE_REPORT_CONTEXT_LINES = 40;
const MAX_FAILURE_REPORT_LINE_CHARS = 2_000;
/**
 * Longest line the console tail prints. One 179 KB line (a reporter's JSON in
 * an assertion message) cut the GitHub Actions log off there, hiding the
 * failure reports and summary after it. The full line stays in the group log.
 */
export const MAX_CONSOLE_TAIL_LINE_CHARS = 2_000;
/** Turbo's per-task prefix, such as `@orkestrator/web:test:workspace: `. */
const TASK_PREFIX = /^(@?[\w./-]+:[\w:-]+: )/;
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
const MAX_TASK_PREFIXES = 64;

/**
 * Keeps Bun's report for each failing test, because a noisy group can push it
 * out of the output tail long before the group exits. Bun prints the error,
 * expectation and stack before the `(fail)` line, so each report is the
 * failing task's preceding lines plus that line. Turbo interleaves streamed
 * tasks, so context comes only from lines with the failing line's task prefix.
 */
/** A test file Bun reported a failure in: its path as Bun printed it, and the Turbo task prefix. */
export interface FailingFile {
  /** The Turbo task prefix (`@orkestrator/web:test:workspace: `), or `""` for a plain Bun group. */
  taskPrefix: string;
  /** Relative to the directory Bun ran in. */
  file: string;
}

/** Bun's per-file header, printed before that file's failures: `src/a.test.ts:`. */
const BUN_FILE_HEADER = /^(\S(?:.*\S)?\.(?:test|spec)\.[cm]?[jt]sx?):$/;

export class FailureReportCollector {
  readonly reports: string[] = [];
  omitted = 0;
  /** Every file a `(fail)` line was reported under, in first-failure order, each once. */
  readonly failingFiles: FailingFile[] = [];
  private readonly currentFile = new Map<string, string>();
  private readonly decoder = new StringDecoder("utf8");
  private readonly recent = new Map<string, string[]>();
  private lastReport: { prefix: string; index: number } | undefined;
  private partial = "";

  push(chunk: Buffer): void {
    const lines = (this.partial + this.decoder.write(chunk)).split("\n");
    this.partial = (lines.pop() ?? "").slice(-MAX_FAILURE_REPORT_LINE_CHARS);
    for (const line of lines) this.line(line);
  }

  finish(): void {
    const rest = this.partial + this.decoder.end();
    this.partial = "";
    if (rest) this.line(rest);
  }

  private line(raw: string): void {
    const line = raw
      .replace(ANSI_ESCAPE, "")
      .replace(/\r$/, "")
      .slice(0, MAX_FAILURE_REPORT_LINE_CHARS);
    const prefix = TASK_PREFIX.exec(line)?.[1] ?? "";
    const body = line.slice(prefix.length);
    // Bun explains a timeout on the line after `(fail)`.
    if (this.lastReport?.prefix === prefix && /^\s*\^ this test timed out/.test(body)) {
      this.reports[this.lastReport.index] += `\n${line}`;
      return;
    }
    this.lastReport = undefined;
    // A line that only looks like a task prefix must not grow the map forever.
    const bucket = this.recent.has(prefix) || this.recent.size < MAX_TASK_PREFIXES ? prefix : "";
    const context = this.recent.get(bucket) ?? [];
    const header = BUN_FILE_HEADER.exec(body.trim());
    if (header) this.currentFile.set(bucket, header[1]!.replace(/^\.\//, ""));
    if (body.startsWith("(fail) ")) {
      const file = this.currentFile.get(bucket);
      if (
        file &&
        !this.failingFiles.some((entry) => entry.taskPrefix === prefix && entry.file === file)
      )
        this.failingFiles.push({ taskPrefix: prefix, file });
      if (this.reports.length < MAX_FAILURE_REPORTS) {
        this.lastReport = { prefix, index: this.reports.length };
        this.reports.push([...context, line].join("\n"));
      } else {
        this.omitted += 1;
      }
      context.length = 0;
    } else {
      context.push(line);
      if (context.length > FAILURE_REPORT_CONTEXT_LINES) context.shift();
    }
    this.recent.set(bucket, context);
  }
}

export function boundConsoleLines(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.length > MAX_CONSOLE_TAIL_LINE_CHARS
        ? `${line.slice(0, MAX_CONSOLE_TAIL_LINE_CHARS)}… [${line.length - MAX_CONSOLE_TAIL_LINE_CHARS} more characters in the group log]`
        : line,
    )
    .join("\n");
}

/**
 * Watchdog budgets. Groups stream their child output live (see
 * `TURBO_GROUP_OUTPUT_FLAGS`), so a five-minute gap really does mean the group
 * stopped working.
 * The absolute deadline only catches a wedged run, never a slow one. On a
 * 4-core CI runner the workspace group runs its package tasks one at a time and
 * now takes close to 30 minutes, so CI raises it through
 * `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS`.
 */
export const DEFAULT_TEST_NO_PROGRESS_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_TEST_GROUP_TIMEOUT_MS = 30 * 60 * 1_000;
/**
 * The aggregate prints only one line per finished group, so the gap after the
 * fast groups finish is as long as the slowest group runs. Wrapped in
 * `test:logged`, the aggregate is itself one watched group, and that silence
 * tripped the wrapper's no-progress watchdog on a healthy workspace group.
 * Each group keeps its own watchdogs; this line only proves the aggregate is
 * alive. It is capped at half the no-progress budget so a shortened budget is
 * still honoured.
 */
export const TEST_PROGRESS_HEARTBEAT_MS = 60 * 1_000;
/** iOS builds and boots a simulator, which is far slower than any Bun group. */
export const IOS_GROUP_TIMEOUT_MS = 60 * 60 * 1_000;
export const TEST_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const TEST_LOG_DIRECTORY_PREFIX = "orkestrator-test-run.";
const TEST_LOG_SENTINEL = ".orkestrator-test-log";
const TEST_TIMINGS_DIRECTORY_PREFIX = "orkestrator-test-timings.";

function configuredPositiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const configured = Number(environment[name]);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : fallback;
}

function gitCommonDirectory(repositoryRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : repositoryRoot;
}

function repositoryStateKey(repositoryRoot: string): string {
  return createHash("sha256").update(gitCommonDirectory(repositoryRoot)).digest("hex").slice(0, 20);
}

export function createTestTimingsDirectory(repositoryRoot: string): string {
  // Bun updates profiles in place. Linked worktrees can now execute the same
  // group concurrently, so their mutable timing files must not share a writer.
  const worktreeKey = createHash("sha256")
    .update(path.resolve(repositoryRoot))
    .digest("hex")
    .slice(0, 20);
  const directory = path.join(
    tmpdir(),
    `${TEST_TIMINGS_DIRECTORY_PREFIX}${repositoryStateKey(repositoryRoot)}.${worktreeKey}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

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

/**
 * Process-group leaders for every group still running. Groups are spawned
 * detached, so they no longer share the runner's process group and no longer
 * receive the terminal's Ctrl+C. The runner has to relay it, and it can only do
 * that if it knows which trees are live.
 */
const liveGroupLeaders = new Set<number>();

function signalGroupLeader(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    // The tree may have exited between the caller's check and this signal.
  }
}

/**
 * Signals every live group's whole process tree. Exported so the interrupt
 * path and its test can reach the same trees the watchdogs do.
 */
export function terminateActiveGroups(signal: NodeJS.Signals = "SIGTERM"): number {
  const leaders = [...liveGroupLeaders];
  for (const pid of leaders) signalGroupLeader(pid, signal);
  return leaders.length;
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
    const noProgressTimeoutMs = configuredPositiveInteger(
      env,
      TEST_NO_PROGRESS_TIMEOUT_MS_ENV,
      DEFAULT_TEST_NO_PROGRESS_TIMEOUT_MS,
    );
    const groupTimeoutMs = configuredPositiveInteger(
      env,
      TEST_GROUP_TIMEOUT_MS_ENV,
      group.timeoutMs ?? DEFAULT_TEST_GROUP_TIMEOUT_MS,
    );
    const child = spawn(group.command, group.args, {
      cwd: group.cwd ? path.join(root, group.cwd) : root,
      env,
      // Captured rather than inherited so concurrent groups do not interleave.
      stdio: ["ignore", "pipe", "pipe"],
      // A dedicated process group lets a watchdog terminate Bun/Turbo and all
      // workers or fixtures it spawned, rather than leaving descendants alive.
      detached: process.platform !== "win32",
    });
    if (child.pid) {
      liveGroupLeaders.add(child.pid);
      try {
        group.onSpawn?.(child.pid);
      } catch {
        signalGroupLeader(child.pid, "SIGKILL");
      }
    }

    let outputBytes = 0;
    let persistedBytes = 0;
    let outputLimitExceeded = false;
    let outputTail: Buffer = Buffer.alloc(0);
    const failures = new FailureReportCollector();
    let spawnError: Error | undefined;
    let logError: Error | undefined;
    let childStatus: number | null = 1;
    let childFinished = false;
    let logFinished = false;
    let resolved = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let noProgressTimer: ReturnType<typeof setTimeout> | undefined;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutReason: CommandResult["timeoutReason"];

    const appendTail = (chunk: Buffer) => {
      outputTail =
        chunk.byteLength >= MAX_GROUP_OUTPUT_TAIL_BYTES
          ? chunk.subarray(chunk.byteLength - MAX_GROUP_OUTPUT_TAIL_BYTES)
          : Buffer.concat([outputTail, chunk]).subarray(-MAX_GROUP_OUTPUT_TAIL_BYTES);
    };
    const signalProcessTree = (signal: NodeJS.Signals) => {
      if (child.pid) signalGroupLeader(child.pid, signal);
      else child.kill(signal);
    };
    const terminate = (marker: string, reason?: CommandResult["timeoutReason"]) => {
      if (forceKill) return;
      timeoutReason = reason;
      const chunk = Buffer.from(`\n[orkestrator-test-runner] ${marker}\n`);
      if (!logError) log.write(chunk);
      appendTail(chunk);
      signalProcessTree("SIGTERM");
      forceKill = setTimeout(() => signalProcessTree("SIGKILL"), 1_000);
      forceKill.unref();
    };
    const armNoProgressTimer = () => {
      if (noProgressTimer) clearTimeout(noProgressTimer);
      noProgressTimer = setTimeout(
        () =>
          terminate(
            `No output for ${noProgressTimeoutMs}ms; terminating the group process tree.`,
            "no-progress",
          ),
        noProgressTimeoutMs,
      );
      noProgressTimer.unref();
    };
    const consume = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      outputBytes += chunk.byteLength;
      appendTail(chunk);
      failures.push(chunk);
      armNoProgressTimer();
      if (outputLimitExceeded || logError) return;
      const remaining = maxOutputBytes - persistedBytes;
      if (remaining > 0) {
        const persisted = chunk.subarray(0, remaining);
        persistedBytes += persisted.byteLength;
        log.write(persisted);
      }
      if (chunk.byteLength > remaining || outputBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        terminate(`Output exceeded ${maxOutputBytes} bytes; terminating the group process tree.`);
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    armNoProgressTimer();
    absoluteTimer = setTimeout(
      () =>
        terminate(
          `Exceeded the ${groupTimeoutMs}ms group deadline; terminating the process tree.`,
          "absolute",
        ),
      groupTimeoutMs,
    );
    absoluteTimer.unref();

    const maybeResolve = () => {
      if (resolved || !childFinished || !logFinished) return;
      resolved = true;
      if (forceKill) clearTimeout(forceKill);
      if (noProgressTimer) clearTimeout(noProgressTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
      const errors = [spawnError, logError]
        .filter((error): error is Error => Boolean(error))
        .map((error) => error.message);
      failures.finish();
      resolve({
        status: outputLimitExceeded || timeoutReason || errors.length > 0 ? 1 : childStatus,
        output: boundConsoleLines(
          `${outputTail.toString("utf8")}${errors.length ? `\n${errors.join("\n")}` : ""}`.trim(),
        ),
        failureReports: failures.reports,
        failingFiles: failures.failingFiles,
        omittedFailureReports: failures.omitted,
        logPath,
        outputBytes,
        outputLimitExceeded,
        timeoutReason,
        infrastructureError: errors.length > 0 || childStatus === null,
      });
    };
    const finishChild = (status: number | null) => {
      if (childFinished) return;
      childFinished = true;
      childStatus = status;
      signalProcessTree("SIGKILL");
      if (child.pid) liveGroupLeaders.delete(child.pid);
      if (forceKill) clearTimeout(forceKill);
      if (noProgressTimer) clearTimeout(noProgressTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
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
      terminate("The group log failed; terminating the group process tree.");
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

/** Lists every failing test a group reported, including any the tail lost. */
function logFailureReports(
  dependencies: Pick<TestAllDependencies, "log">,
  groupName: string,
  result: CommandResult,
): void {
  const reports = result.failureReports ?? [];
  const omitted = result.omittedFailureReports ?? 0;
  if (reports.length === 0 && omitted === 0) return;
  const count = reports.length + omitted;
  dependencies.log(
    `\n--- Failing tests in ${groupName}: ${count}${omitted ? ` (first ${reports.length} shown)` : ""} ---`,
  );
  for (const report of reports) dependencies.log(`${report}\n`);
}

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
      timeoutReason: entry.result.timeoutReason,
      infrastructureError: entry.result.infrastructureError ?? false,
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
 * The protocol check does not allocate a Bun test worker pool. Backend and
 * desktop integration suites run in their own packages, so the backend package
 * is the slowest single task; package tasks get a second worker as soon as the
 * budget allows, and the root group (renderer and repository-contract tests)
 * takes what remains.
 */
export interface WorkerPlan {
  /** Bun workers used by each active workspace package task. */
  workspace: number;
  /**
   * Bun workers for the backend package task, which replaces one of the
   * concurrent workspace slots. It runs Node-preloaded integration suites,
   * not happy-dom UI workers, so it sits outside the UI worker budget.
   */
  backend: number;
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
export const MAX_AGGREGATE_TEST_WORKERS = 8;

/**
 * The bridge suites are ~50 files. A single worker made that group the long pole
 * of the whole run, so it gets a hard floor rather than a proportional share:
 * within `MAX_AGGREGATE_TEST_WORKERS` every proportional share of 20% rounds
 * down to one, which is how the floor was silently lost.
 */
export const MIN_BRIDGE_WORKERS = 2;

/** root(1) + bridges(2) + workspace(1) + protocol(1). */
export const MIN_AGGREGATE_TEST_WORKERS = 1 + MIN_BRIDGE_WORKERS + 1 + 1;

/**
 * The env var carrying the planned per-package worker count into the Turbo
 * group. It is deliberately *not* passed after Turbo's `--` separator: turbo
 * folds passthrough arguments into the hash of the requested task **and its
 * dependencies**, so the workspace `build` and `test` tasks would compute different
 * `build` hashes and re-run `bun check && vite build` on every alternation.
 *
 * turbo.json declares it under `test:workspace.passThroughEnv`, which forwards
 * it in strict env mode while keeping it out of the hash.
 */
export const WORKSPACE_WORKERS_ENV = "ORKESTRATOR_TEST_WORKERS";
/** Overrides {@link WORKSPACE_WORKERS_ENV} for the backend package only. */
export const BACKEND_WORKERS_ENV = "ORKESTRATOR_BACKEND_TEST_WORKERS";

/**
 * The backend package is the long pole of the default tier. Its subprocess and
 * wall-clock suites now run in the slow tier, so the rest gets a larger pool.
 */
export const MAX_BACKEND_TEST_WORKERS = 4;
/** Real-process suites retain their qualified two-worker ceiling. */
export const MAX_SLOW_BACKEND_TEST_WORKERS = 2;
export const ALLOW_MISSING_PROTOCOL_BINARY_ENV = "CODEX_PROTOCOL_CHECK_ALLOW_MISSING_BINARY";

/**
 * Selects which groups a run starts: a comma-separated list of
 * {@link TEST_GROUP_KEYS}. Unset runs every group. CI spreads the suite over
 * several runners with one selection per job, because on one four-core runner
 * the groups slowed each other past their per-test timeouts.
 *
 * `backend` and `workspace` split the workspace group: `workspace` is every
 * workspace package except the backend. Selecting both runs the combined group.
 */
export const TEST_GROUPS_ENV = "ORKESTRATOR_TEST_GROUPS";
export const TEST_GROUP_KEYS = [
  "backend",
  "workspace",
  "root",
  "bridges",
  "codex-protocol",
] as const;
export type TestGroupKey = (typeof TEST_GROUP_KEYS)[number];

export function selectedTestGroups(env: NodeJS.ProcessEnv): ReadonlySet<TestGroupKey> {
  const value = env[TEST_GROUPS_ENV];
  if (value === undefined || value.trim() === "") return new Set(TEST_GROUP_KEYS);
  const keys = value
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const unknown = keys.filter((key) => !(TEST_GROUP_KEYS as readonly string[]).includes(key));
  // A typo must not quietly run less than was asked for.
  if (unknown.length > 0 || keys.length === 0) {
    throw new Error(
      `${TEST_GROUPS_ENV} must list groups from ${TEST_GROUP_KEYS.join(", ")}; got "${value}"`,
    );
  }
  return new Set(keys as TestGroupKey[]);
}

/** Workspace packages other than the backend, in the combined group's filter order. */
const WORKSPACE_PACKAGES_BEFORE_BACKEND = ["@orkestrator/web"];
const WORKSPACE_PACKAGES_AFTER_BACKEND = [
  "@orkestrator/desktop",
  "@orkestrator/web-public",
  "orkestrator",
  "@orkestrator/protocol",
  "@orkestrator/toolchain",
];

/**
 * Output and failure handling shared by the Turbo groups.
 *
 * Both output flags keep task output streaming, which the no-progress watchdog
 * depends on. An `errors-only` output mode would buffer a whole run, and Turbo's
 * default `--log-order=auto` becomes `grouped` whenever it detects CI, holding
 * each task's output until the task exits. On a four-core CI runner the backend
 * package runs on one worker for far longer than the watchdog budget, so
 * grouped output got a healthy run killed on every push.
 *
 * `--continue=dependencies-successful` stops one failing package from
 * cancelling its siblings, so a single run reports every failure. A task whose
 * own dependency failed still does not start.
 */
export const TURBO_GROUP_OUTPUT_FLAGS = [
  "--output-logs=new-only",
  "--log-order=stream",
  "--continue=dependencies-successful",
];

export function planWorkers(cores: number, tier: TestTier = "default"): WorkerPlan {
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
  // multiplying peak heap.
  const workspaceConcurrency = budget >= 8 ? 2 : 1;
  const workspace = budget >= 6 ? 2 : 1;
  // Root absorbs the remaining capacity. The aggregate stays capped at eight:
  // higher caps repeatedly starved subprocess fixtures and produced
  // SIGTERM/SIGSEGV UI-worker crashes.
  const root = Math.max(1, budget - 1 - bridges - workspace * workspaceConcurrency);
  const backend = Math.max(
    workspace,
    Math.min(
      tier === "default" ? MAX_BACKEND_TEST_WORKERS : MAX_SLOW_BACKEND_TEST_WORKERS,
      Number.isFinite(cores) ? Math.floor(cores / 3) : 0,
    ),
  );
  return { workspace, backend, workspaceConcurrency, root, bridges };
}

/**
 * The guard stage: the repository-wide guards (`mise run guards`). It runs
 * before any test group is admitted, so a broken guard fails a run in seconds
 * instead of after the long groups. It needs no host admission: one process,
 * a few seconds, like `mise run lint`, and queueing it behind another
 * worktree's suite would defeat the point of running it first.
 */
export const GUARD_STAGE: TestGroup = {
  name: "guards",
  workers: 1,
  command: "bun",
  args: ["scripts/guards.ts"],
  // A healthy run takes seconds; this only catches a wedged one.
  timeoutMs: 5 * 60 * 1_000,
};

/**
 * Bun test files the guard stage runs whole (the documentation registers).
 * The root group leaves them out once the stage has passed in the same run.
 */
export const GUARD_STAGE_TEST_FILES = [
  "tests/unit/flaky-tests-index.test.ts",
  "tests/unit/todo-index.test.ts",
  "tests/unit/number-claims.test.ts",
] as const;

/** Whether this run starts with the guard stage: it stands in for root-group checks. */
export function runsGuardStage(
  env: NodeJS.ProcessEnv,
  tier: TestTier,
  selection: ReadonlySet<TestGroupKey>,
): boolean {
  return env[TEST_SKIP_GUARDS_ENV] !== "1" && tier !== "slow" && selection.has("root");
}

/**
 * Root test discovery. A bare `tests` is a Bun substring filter and also
 * matches packages/*\/tests. Explicit relative paths confine discovery to the
 * repository's root tests and prevent package build/test races.
 */
const ROOT_TEST_PATHS = [
  "./tests",
  "./e2e/agent-testing/artifact-sanitizer.test.ts",
  "./e2e/agent-testing/client-outage-support.test.ts",
  "./e2e/agent-testing/design-live-usage.test.ts",
  "./e2e/agent-testing/design-live-heartbeat.test.ts",
  "./e2e/agent-testing/paused-interactions-live-support.test.ts",
  "./e2e/agent-testing/mcp-apply-live-support.test.ts",
  "./e2e/agent-testing/mcp-apply-live-safety.test.ts",
  "./e2e/agent-testing/idle-observation-live-support.test.ts",
  "./e2e/agent-testing/idle-observation-fake-claude.test.ts",
  "./e2e/agent-testing/idle-observation-fake-codex.test.ts",
  "./e2e/agent-testing/idle-observation-fake-pi.test.ts",
  "./e2e/agent-testing/idle-observation-fake-models.test.ts",
  "./e2e/agent-testing/mcp-fake-model.test.ts",
  "./e2e/agent-testing/coordinator-mail-tiles.test.ts",
  "./e2e/agent-testing/bridge-builds-setup.test.ts",
  "./e2e/agent-testing/packaged-electron-app.test.ts",
  "./e2e/agent-testing/process-tree.test.ts",
  "./e2e/agent-testing/session-history-environment.test.ts",
  "./e2e/agent-testing/network-churn-report.test.ts",
  "./e2e/agent-testing/electron-startup-recovery.test.ts",
  "./e2e/agent-testing/electron-startup-recovery-live-support.test.ts",
  "./e2e/agent-testing/terminal-visible-text.test.ts",
  "./e2e/agent-testing/browser-test.test.ts",
  "./e2e/agent-testing/invoke-observer.test.ts",
  "./e2e/agent-testing/artifact-sanitizing-reporter.test.ts",
  "./e2e/agent-testing/electron-display-setup.test.ts",
  "./e2e/agent-testing/web-annotations-native-captures.test.ts",
  "./e2e/agent-testing/electron-startup-dialogs.test.ts",
  "./e2e/agent-testing/fake-anthropic-model.test.ts",
  "./e2e/agent-testing/auto-pipeline-fake-model.test.ts",
  "./e2e/agent-testing/profile-restart-args.test.ts",
  "./e2e/agent-testing/coordinator-routing-fake-model.test.ts",
  "./e2e/agent-testing/coordinator-surfaces-fake-model.test.ts",
  "./e2e/agent-testing/coordinator-node-mail-fake-model.test.ts",
  "./e2e/agent-testing/coordinator-gap-tools-fake-model.test.ts",
  "./e2e/agent-testing/pi-profile-settings.test.ts",
  "./e2e/agent-testing/coordinator-slow-remote-support.test.ts",
  "./e2e/agent-testing/container-fake-claude-api.test.ts",
  "./e2e/agent-testing/container-fake-claude-install.test.ts",
  "./e2e/agent-testing/container-fake-claude-review-api.test.ts",
  "./e2e/agent-testing/claude-warm-runtime-support.test.ts",
  "./e2e/agent-testing/opencode-fake-provider.test.ts",
  "./e2e/agent-testing/mcp-probe-server.integration.test.ts",
  "./scripts/opencode-live-compatibility-probe.test.ts",
  "./test-fixtures/agent-project/server.test.ts",
];

export function buildConcurrentGroups(
  cores: number,
  affected = false,
  timingsDirectory?: string,
  /** Which test files run; package scripts read the same tier from the environment. */
  tier: TestTier = "default",
  selection: ReadonlySet<TestGroupKey> = new Set(TEST_GROUP_KEYS),
  /** The guard stage runs first, so the root group leaves out the files it ran. */
  afterGuardStage = false,
): TestGroup[] {
  const workers = planWorkers(cores, tier);
  // Groups may queue on tiny hosts, but no individual child may exceed the
  // capacity it reserves. The plan's minimum worker floor is not a grant.
  const capacity = Math.max(1, Math.floor(cores) || 1);
  workers.root = Math.min(capacity, workers.root);
  workers.bridges = Math.min(capacity, workers.bridges);
  const withBackend = selection.has("backend");
  const withWorkspace = selection.has("workspace");
  // Alone on a host (a CI shard), the backend need not leave room for the
  // other groups; one core stays free for Turbo and the build.
  if (withBackend && selection.size === 1) {
    workers.backend = Math.min(
      tier === "default" ? MAX_BACKEND_TEST_WORKERS : MAX_SLOW_BACKEND_TEST_WORKERS,
      Math.max(1, capacity - 1),
    );
  }
  const workspaceConcurrency = withBackend && withWorkspace ? workers.workspaceConcurrency : 1;
  // The backend task occupies one of the concurrent workspace slots.
  const workspaceReservation = Math.min(
    capacity,
    withBackend
      ? workers.backend + workers.workspace * (workspaceConcurrency - 1)
      : workers.workspace,
  );
  const workspacePackages = [
    ...(withWorkspace ? WORKSPACE_PACKAGES_BEFORE_BACKEND : []),
    ...(withBackend ? ["@orkestrator/backend"] : []),
    ...(withWorkspace ? WORKSPACE_PACKAGES_AFTER_BACKEND : []),
  ];
  const changedArguments = affected ? ["--changed=main", "--pass-with-no-tests"] : [];
  const rootSelection = tierArguments(tier, root, ".", ROOT_TEST_PATHS);
  const groups: (TestGroup | false | undefined)[] = [
    workspacePackages.length > 0 && {
      name:
        withBackend && withWorkspace
          ? "workspace (web, backend, desktop, web-public, cli, protocol, toolchain)"
          : withBackend
            ? "backend"
            : "workspace (web, desktop, web-public, cli, protocol, toolchain)",
      workers: workspaceReservation,
      command: "bunx",
      args: [
        "turbo",
        "run",
        "build",
        "test:workspace",
        "--cwd",
        ".",
        ...workspacePackages.map((name) => `--filter=${name}`),
        `--concurrency=${workspaceConcurrency}`,
        ...TURBO_GROUP_OUTPUT_FLAGS,
        "--summarize",
        ...(affected ? ["--affected"] : []),
      ],
      env: {
        [WORKSPACE_WORKERS_ENV]: String(workers.workspace),
        [BACKEND_WORKERS_ENV]: String(workers.backend),
      },
    },
    selection.has("root") &&
      rootSelection && {
        name: "root and agent-support tests",
        workers: workers.root,
        command: "bun",
        args: [
          "test",
          ...rootSelection,
          ...(afterGuardStage
            ? GUARD_STAGE_TEST_FILES.map((file) => `--path-ignore-patterns=${file}`)
            : []),
          "--only-failures",
          ...changedArguments,
          ...(timingsDirectory
            ? ["--timings", path.join(timingsDirectory, "root.json"), "--update-timings"]
            : []),
          `--parallel=${workers.root}`,
        ],
      },
    selection.has("bridges") && {
      // Bridges use a separate Turbo task without a build dependency, which
      // preserves the previous cold-run shape. The task is declared
      // `"cache": false`: replaying a stored pass would let this group report
      // success having executed nothing, and a suite with a live flake register
      // cannot afford a green that proves only that the inputs are unchanged.
      // Turbo runs each script from its own package, so the scripts carry the
      // root `bunfig.toml` preloads explicitly.
      name: "bridges",
      workers: workers.bridges,
      command: "bunx",
      args: [
        "turbo",
        "run",
        "test:bridge",
        "--cwd",
        ".",
        "--filter=./bridges/*",
        `--concurrency=${workers.bridges}`,
        ...TURBO_GROUP_OUTPUT_FLAGS,
        "--summarize",
        ...(affected ? ["--affected"] : []),
      ],
      env: { [WORKSPACE_WORKERS_ENV]: "1" },
    },
    selection.has("codex-protocol") &&
      tier !== "slow" && {
        // Always validates the committed TypeScript lockfile. On developer
        // machines with the pinned binary it additionally regenerates and checks
        // the full TypeScript + JSON Schema contract. Minimal CI environments may
        // lack that managed binary, so the generator has an explicit offline
        // fallback for this pipeline only.
        name: "codex protocol lockfile",
        workers: 1,
        command: "mise",
        args: ["run", "codex:protocol:check"],
        env: { [ALLOW_MISSING_PROTOCOL_BINARY_ENV]: "1" },
      },
  ];
  return groups.filter((group): group is TestGroup => Boolean(group));
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** `0` turns off rerunning failing test files alone after a failed run. */
export const TEST_RERUN_FAILED_ENV = "ORKESTRATOR_TEST_RERUN_FAILED";
/** At most this many failing files are rerun; a broken change fails many more. */
export const MAX_RERUN_FILES = 10;
/** All reruns together stop starting new files after this long. */
export const RERUN_TIME_BUDGET_MS = 10 * 60 * 1_000;
/** One rerun file's own deadline. */
export const RERUN_FILE_TIMEOUT_MS = 5 * 60 * 1_000;

/** The directory a failing file reruns from and the Bun flags its suite passes. */
export interface RerunTarget {
  /** Repository-relative package directory, `.` for the root group. */
  directory: string;
  flags: string[];
}

/**
 * The Bun flags of a package's test script (`bun-test-tier.ts <dir> <paths>
 * -- <flags>`), for one file on one worker: shell expansions (timings, worker
 * counts) are dropped and `--parallel=1` added, so preloads stay as the suite
 * has them.
 */
export function rerunFlags(script: string): string[] {
  const tokens = script.trim().split(/\s+/);
  const separator = tokens.indexOf("--");
  const flags = (separator === -1 ? [] : tokens.slice(separator + 1)).filter(
    (token) => !/[${}]/.test(token) && !token.startsWith("--parallel"),
  );
  return [...flags, "--parallel=1"];
}

/** Resolves Turbo task prefixes to workspace and bridge packages of `repositoryRoot`. */
export function packageRerunTargets(
  repositoryRoot: string,
): (taskPrefix: string) => RerunTarget | undefined {
  let packages: Map<string, { directory: string; scripts: Record<string, string> }> | undefined;
  const load = () => {
    packages = new Map();
    for (const parent of ["apps", "packages", "bridges"]) {
      let entries: string[] = [];
      try {
        entries = readdirSync(path.join(repositoryRoot, parent));
      } catch {
        continue;
      }
      for (const entry of entries) {
        try {
          const manifest = JSON.parse(
            readFileSync(path.join(repositoryRoot, parent, entry, "package.json"), "utf8"),
          ) as { name?: string; scripts?: Record<string, string> };
          if (manifest.name)
            packages.set(manifest.name, {
              directory: `${parent}/${entry}`,
              scripts: manifest.scripts ?? {},
            });
        } catch {
          // Not a package.
        }
      }
    }
    return packages;
  };
  return (taskPrefix) => {
    if (taskPrefix === "") return { directory: ".", flags: ["--parallel=1"] };
    const task = /^(.+):(test:workspace|test:bridge): $/.exec(taskPrefix);
    if (!task) return undefined;
    const found = (packages ?? load()).get(task[1]!);
    const script = found?.scripts[task[2]!];
    return found && script ? { directory: found.directory, flags: rerunFlags(script) } : undefined;
  };
}

/**
 * After a failed run, reruns each failing test file alone, once, and says
 * which passed alone (a load flake to record) and which failed alone (a real
 * failure). Bounded by {@link MAX_RERUN_FILES} and {@link RERUN_TIME_BUDGET_MS},
 * which also bounds any wait for host capacity (see {@link TestGroup.deadline}).
 * It only classifies: the run's exit status stays the failure.
 */
async function rerunFailingFiles(
  failedGroups: readonly CompletedGroup[],
  resolve: (taskPrefix: string) => RerunTarget | undefined,
  run: (group: TestGroup) => Promise<CommandResult>,
  log: (message: string) => void,
): Promise<CompletedGroup[]> {
  const targets: { file: string; group: TestGroup }[] = [];
  for (const { group, result } of failedGroups) {
    const files = result.failingFiles ?? [];
    if (files.length === 0) {
      log(`No failing test file identified in ${group.name}; nothing to rerun there.`);
      continue;
    }
    for (const { taskPrefix, file } of files) {
      const target = resolve(taskPrefix);
      const repositoryFile = path.posix.normalize(
        target ? path.posix.join(target.directory, file) : file,
      );
      if (!target) {
        log(`Cannot rerun ${repositoryFile} alone: no suite for "${taskPrefix.trim()}".`);
        continue;
      }
      targets.push({
        file: repositoryFile,
        group: {
          name: `rerun ${repositoryFile}`,
          workers: 1,
          cwd: target.directory === "." ? undefined : target.directory,
          command: "bun",
          args: ["test", `./${file.replace(/^\.\//, "")}`, ...target.flags],
        },
      });
    }
  }
  if (targets.length === 0) return [];
  const chosen = targets.slice(0, MAX_RERUN_FILES);
  log(
    `\n--- Rerunning each failing test file alone, once (${chosen.length} of ${targets.length}${targets.length > chosen.length ? `; at most ${MAX_RERUN_FILES}` : ""}) ---`,
  );
  // One absolute deadline covers every rerun, including any wait for host
  // capacity: admission stops queuing at it and trims the child's watchdog to
  // what is left once admitted, so the budget is never exceeded by a queue.
  const budgetDeadline = Date.now() + RERUN_TIME_BUDGET_MS;
  const completed: CompletedGroup[] = [];
  for (const { file, group } of chosen) {
    const remaining = budgetDeadline - Date.now();
    if (remaining <= 0) {
      log(
        `NOT RERUN     ${file}: the ${formatDuration(RERUN_TIME_BUDGET_MS)} rerun budget is spent`,
      );
      continue;
    }
    const fileStartedAt = Date.now();
    const result = await run({
      ...group,
      timeoutMs: Math.min(RERUN_FILE_TIMEOUT_MS, remaining),
      deadline: budgetDeadline,
    });
    const elapsedMs = Date.now() - fileStartedAt;
    completed.push({ group, result, elapsedMs });
    const incomplete =
      result.infrastructureError || result.timeoutReason || result.outputLimitExceeded;
    log(
      incomplete
        ? `INCOMPLETE    ${file} (${formatDuration(elapsedMs)}): the rerun did not finish; no verdict`
        : result.status === 0
          ? `PASSED ALONE  ${file} (${formatDuration(elapsedMs)}): likely a load flake. Record it in docs/tests/flaky-tests (search the group indexes for it first); never skip or loosen it`
          : `FAILED ALONE  ${file} (${formatDuration(elapsedMs)}): a real failure; fix it`,
    );
  }
  log("The run still fails: passing alone classifies a failure, it does not excuse it.");
  return completed;
}

export async function runAllTests(overrides: Partial<TestAllDependencies> = {}): Promise<number> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const usesDefaultRunner = dependencies.runGroup === defaultRunGroup;
  const affected = dependencies.env[TEST_AFFECTED_ENV] === "1";
  let tier: TestTier;
  let selection: ReadonlySet<TestGroupKey>;
  let admission: ReturnType<typeof createTestAdmission> | undefined;
  try {
    tier = testTier(dependencies.env);
    selection = selectedTestGroups(dependencies.env);
    if (usesDefaultRunner)
      admission = createTestAdmission(dependencies.root, dependencies.env, dependencies.log, {
        // Affected runs are small; complete runs queue behind each other.
        exclusiveSuite: !affected && dependencies.env[TEST_ALLOW_CONCURRENT_ENV] !== "1",
      });
  } catch (error) {
    dependencies.log(`INCOMPLETE: ${error instanceof Error ? error.message : String(error)}`);
    return 75;
  }
  const runGroup = (group: TestGroup, env: NodeJS.ProcessEnv) =>
    admission
      ? admission.run(group, (admitted) => dependencies.runGroup(admitted, env))
      : dependencies.runGroup(group, env);

  // Groups run detached, in their own process groups, so the terminal's Ctrl+C
  // reaches this runner and nothing else. Without a relay the suite's children
  // would outlive it, keep holding ports, and race the next run that the now
  // ownerless lease no longer blocks.
  const interruptSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handleInterrupt = (signal: NodeJS.Signals) => {
    const trees = terminateActiveGroups("SIGTERM");
    dependencies.log(`\nReceived ${signal}; terminating ${trees} group process tree(s)…`);
    // Anything still alive after the grace period is not going to exit on its
    // own. A second Ctrl+C bypasses all of this: the handlers are one-shot.
    setTimeout(() => terminateActiveGroups("SIGKILL"), 2_000).unref();
    admission?.cancel();
    process.exitCode = 130;
  };
  const interruptListeners = new Map<NodeJS.Signals, () => void>();
  if (usesDefaultRunner) {
    for (const signal of interruptSignals) {
      const listener = () => handleInterrupt(signal);
      interruptListeners.set(signal, listener);
      process.once(signal, listener);
    }
  }

  const running = new Map<string, number>();
  const heartbeatMs = Math.min(
    TEST_PROGRESS_HEARTBEAT_MS,
    Math.max(
      1,
      Math.floor(
        configuredPositiveInteger(
          dependencies.env,
          TEST_NO_PROGRESS_TIMEOUT_MS_ENV,
          DEFAULT_TEST_NO_PROGRESS_TIMEOUT_MS,
        ) / 2,
      ),
    ),
  );
  const heartbeat = setInterval(() => {
    if (running.size === 0) return;
    const now = Date.now();
    const names = Array.from(
      running,
      ([name, since]) => `${name} (${formatDuration(now - since)})`,
    );
    dependencies.log(`STILL RUNNING ${names.join(", ")}`);
  }, heartbeatMs);
  heartbeat.unref();

  try {
    // A substituted runner owns no real logs. Keep simulated runner tests out
    // of unrelated host filesystem cleanup (which can outlive their deadline).
    if (usesDefaultRunner) await pruneExpiredTestLogDirectories().catch(() => undefined);
    const timingsDirectory =
      dependencies.env[TEST_TIMINGS_DIRECTORY_ENV] ||
      (usesDefaultRunner ? createTestTimingsDirectory(dependencies.root) : undefined);
    const runGuards = dependencies.runGuards ?? (usesDefaultRunner ? defaultRunGroup : undefined);
    const guardStage = runGuards !== undefined && runsGuardStage(dependencies.env, tier, selection);
    const groups = buildConcurrentGroups(
      admission?.capacity.workers ?? dependencies.cores,
      affected,
      timingsDirectory,
      tier,
      selection,
      guardStage,
    );
    if (groups.length === 0) {
      dependencies.log(
        `INCOMPLETE: ${TEST_GROUPS_ENV}="${dependencies.env[TEST_GROUPS_ENV]}" selects no ${tier}-tier test groups`,
      );
      return 75;
    }
    const configuredLogDirectory = dependencies.env[TEST_LOG_DIRECTORY_ENV];
    const logDirectory = usesDefaultRunner
      ? configuredLogDirectory || createTestLogDirectory()
      : undefined;
    const sanitizedEnvironment = { ...dependencies.env };
    // Runtime diagnostic flags change assertion inputs and must not leak from a
    // development profile into an authoritative aggregate test run.
    delete sanitizedEnvironment.ORKESTRATOR_BRIDGE_DEBUG;
    // Bun only defaults NODE_ENV to "test" when it is unset. An inherited
    // "production" (for example from an agent session launched by the packaged
    // app) loads React's production build, which has no `act`, and fails every
    // component test in groups that Turbo does not already filter.
    delete sanitizedEnvironment.NODE_ENV;
    // Test builds must stay unstamped and share their cache across commits,
    // even when the caller is running inside a stamped build environment.
    delete sanitizedEnvironment.ORKESTRATOR_BUILD_COMMIT;
    const runEnvironment: NodeJS.ProcessEnv = { ...sanitizedEnvironment };
    delete runEnvironment.ORKESTRATOR_VALIDATION_SCHEDULER_STATE;
    delete runEnvironment.ORKESTRATOR_VALIDATION_HEAD_REF;
    delete runEnvironment.ORKESTRATOR_VALIDATION_RESOURCES;
    if (logDirectory) runEnvironment[TEST_LOG_DIRECTORY_ENV] = logDirectory;
    // Every workspace and bridge package script reads this to name its own
    // durations file, so it has to reach the group environments, not just the
    // root group's argument list.
    if (timingsDirectory) runEnvironment[TEST_TIMINGS_DIRECTORY_ENV] = timingsDirectory;

    const guardResults: CompletedGroup[] = [];
    if (guardStage && runGuards) {
      dependencies.log(
        `Running the guard stage first (\`mise run guards\`; ${TEST_SKIP_GUARDS_ENV}=1 skips it)…`,
      );
      const guardStartedAt = Date.now();
      running.set(GUARD_STAGE.name, guardStartedAt);
      const result = await runGuards(GUARD_STAGE, runEnvironment).finally(() =>
        running.delete(GUARD_STAGE.name),
      );
      const completed = { group: GUARD_STAGE, result, elapsedMs: Date.now() - guardStartedAt };
      guardResults.push(completed);
      const status = result.status ?? 1;
      const incomplete =
        result.infrastructureError || result.timeoutReason || result.outputLimitExceeded;
      dependencies.log(
        `${incomplete ? "INCOMPLETE" : status === 0 ? "PASS" : "FAIL"} ${GUARD_STAGE.name} (${formatDuration(completed.elapsedMs)})`,
      );
      if (status !== 0) {
        if (result.output) dependencies.log(result.output.trimEnd());
        if (result.timeoutReason)
          dependencies.log(`Guard stage watchdog fired (${result.timeoutReason}).`);
        dependencies.log(
          `\nThe guard stage failed, so no test group was started. Fix the failures above ` +
            `(\`mise run guards\` reruns only them in seconds), or set ${TEST_SKIP_GUARDS_ENV}=1 ` +
            "to run the test groups anyway.",
        );
        const artifacts = await finalizeTestLogs(logDirectory, guardResults, false);
        if (artifacts) dependencies.log(`Failure artifacts: ${artifacts}`);
        return status;
      }
    }

    dependencies.log(
      `Running ${groups.length} ${affected ? "affected " : ""}${tier}-tier test groups concurrently…`,
    );
    if (tier === "default") {
      dependencies.log(
        "Slow-tier tests (real processes, servers, or wall-clock waits) are not included; run them with `mise run test:slow`.",
      );
    }
    const startedAt = Date.now();
    let completedCount = 0;

    const groupResults: CompletedGroup[] = await Promise.all(
      groups.map(async (group) => {
        const groupStartedAt = Date.now();
        running.set(group.name, groupStartedAt);
        const result = await runGroup(
          group,
          group.env ? { ...runEnvironment, ...group.env } : runEnvironment,
        ).finally(() => running.delete(group.name));
        const completed = { group, result, elapsedMs: Date.now() - groupStartedAt };
        completedCount += 1;
        dependencies.log(
          `${result.infrastructureError || result.timeoutReason || result.outputLimitExceeded ? "INCOMPLETE" : result.status === 0 ? "PASS" : "FAIL"} ${group.name} finished (${completedCount}/${groups.length}, ${formatDuration(completed.elapsedMs)})`,
        );
        return completed;
      }),
    );
    // The guard stage's log is retained or deleted with the groups'.
    const results = [...guardResults, ...groupResults];

    // Detailed output stays in declaration order even though completion is
    // reported live above.
    let firstFailure = 0;
    for (const { group, result, elapsedMs } of groupResults) {
      const status = result.status ?? 1;
      const banner = "=".repeat(72);
      dependencies.log(
        `\n${banner}\n${result.infrastructureError || result.timeoutReason || result.outputLimitExceeded ? "INCOMPLETE" : status === 0 ? "PASS" : "FAIL"}  ${group.name}  (${formatDuration(elapsedMs)})\n${banner}`,
      );
      if (status !== 0 && result.output) dependencies.log(result.output.trimEnd());
      if (status !== 0) logFailureReports(dependencies, group.name, result);
      if (result.outputLimitExceeded) {
        dependencies.log(`Diagnostic output limit exceeded in ${group.name}.`);
      }
      if (result.timeoutReason) {
        dependencies.log(`Group watchdog fired (${result.timeoutReason}) in ${group.name}.`);
      }
      if (status !== 0 && firstFailure === 0) firstFailure = status;
    }

    dependencies.log(`\nTest groups finished in ${formatDuration(Date.now() - startedAt)}`);

    if (firstFailure !== 0) {
      const failed = groupResults
        .filter(({ result }) => (result.status ?? 1) !== 0)
        .map(({ group }) => group.name);
      dependencies.log(`Failing groups: ${failed.join(", ")}`);
      if (
        (dependencies.rerunFailedFiles ?? usesDefaultRunner) &&
        dependencies.env[TEST_RERUN_FAILED_ENV] !== "0"
      ) {
        const reruns = await rerunFailingFiles(
          groupResults.filter(({ result }) => (result.status ?? 1) !== 0),
          dependencies.resolveRerun ?? packageRerunTargets(dependencies.root),
          (group) => {
            running.set(group.name, Date.now());
            return runGroup(group, runEnvironment).finally(() => running.delete(group.name));
          },
          dependencies.log,
        );
        results.push(...reruns);
      }
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
        exclusive: true,
        command: "bun",
        args: ["scripts/test-ios.ts"],
        timeoutMs: IOS_GROUP_TIMEOUT_MS,
      };
      dependencies.log(`\nRunning ${iosGroup.name}…`);
      const startedAt = Date.now();
      running.set(iosGroup.name, startedAt);
      const result = await runGroup(iosGroup, runEnvironment).finally(() =>
        running.delete(iosGroup.name),
      );
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
  } finally {
    clearInterval(heartbeat);
    for (const [signal, listener] of interruptListeners) process.off(signal, listener);
    admission?.close();
  }
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
