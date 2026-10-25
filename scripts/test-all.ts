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
 * Slow area suites run only when the change can reach them; see
 * `test-areas.ts`. CI runs them all through `mise run test:full`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
import { areaIgnoreEnvironment, selectTestAreas, type AreaDecision } from "./test-areas";

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
  /** Complete output up to the explicit safety limit. */
  logPath?: string;
  outputBytes?: number;
  outputLimitExceeded?: boolean;
  timeoutReason?: "no-progress" | "absolute";
}

export interface TestGroup {
  name: string;
  workers?: number;
  exclusive?: boolean;
  onSpawn?: (pid: number) => void;
  command: string;
  args: string[];
  /** Extra variables layered over the inherited environment for this group. */
  env?: Record<string, string>;
  /** Absolute watchdog budget when this group is slower than a Bun suite. */
  timeoutMs?: number;
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
  /** Decides which area suites this change can reach (see `test-areas.ts`). */
  selectAreas: (root: string, env: NodeJS.ProcessEnv) => AreaDecision[];
}

export const TEST_LOG_DIRECTORY_ENV = "ORKESTRATOR_TEST_LOG_DIR";
export const TEST_MAX_OUTPUT_BYTES_ENV = "ORKESTRATOR_TEST_MAX_OUTPUT_BYTES";
export const TEST_NO_PROGRESS_TIMEOUT_MS_ENV = "ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS";
export const TEST_GROUP_TIMEOUT_MS_ENV = "ORKESTRATOR_TEST_GROUP_TIMEOUT_MS";
export const TEST_ALLOW_CONCURRENT_ENV = "ORKESTRATOR_TEST_ALLOW_CONCURRENT";
export const TEST_LEASE_DIRECTORY_ENV = "ORKESTRATOR_TEST_LEASE_DIRECTORY";
export const TEST_AFFECTED_ENV = "ORKESTRATOR_TEST_AFFECTED";
export const TEST_TIMINGS_DIRECTORY_ENV = "ORKESTRATOR_TEST_TIMINGS_DIR";
export const INCLUDE_IOS_TESTS_ENV = "ORKESTRATOR_INCLUDE_IOS";
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
export class FailureReportCollector {
  readonly reports: string[] = [];
  omitted = 0;
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
    if (body.startsWith("(fail) ")) {
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
 * The absolute deadline is deliberately several times the slowest group ever
 * recorded — around four minutes for the workspace group on a cold cache — so
 * it only catches a wedged run, never a slow one.
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
/** Longest a group may hold an unreadable lease before we call it contended. */
export const LEASE_HANDOVER_GRACE_MS = 30_000;
export const TEST_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const TEST_LOG_DIRECTORY_PREFIX = "orkestrator-test-run.";
const TEST_LOG_SENTINEL = ".orkestrator-test-log";
const TEST_LEASE_DIRECTORY_PREFIX = "orkestrator-test-suite.";
const TEST_TIMINGS_DIRECTORY_PREFIX = "orkestrator-test-timings.";
const TEST_LEASE_METADATA = "owner.json";

export interface FullSuiteLease {
  directory: string;
  release: () => void;
}

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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * @deprecated Legacy compatibility helper, not used by the aggregate runner.
 * Prevents linked worktrees from starting full suites concurrently on one
 * host. The system-temp lock is keyed by Git's common directory, so all of a
 * repository's worktrees contend for the same lease.
 */
export function acquireFullSuiteLease(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): FullSuiteLease | undefined {
  if (environment[TEST_ALLOW_CONCURRENT_ENV] === "1") return undefined;
  const key = repositoryStateKey(repositoryRoot);
  const directory =
    environment[TEST_LEASE_DIRECTORY_ENV] ||
    path.join(tmpdir(), `${TEST_LEASE_DIRECTORY_PREFIX}${key}.lock`);
  const metadataPath = path.join(directory, TEST_LEASE_METADATA);
  const token = randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(
        metadataPath,
        `${JSON.stringify({ version: 1, pid: process.pid, token, root: repositoryRoot, startedAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      return {
        directory,
        release: () => {
          try {
            const current = JSON.parse(readFileSync(metadataPath, "utf8")) as { token?: unknown };
            if (current.token === token) rmSync(directory, { recursive: true, force: true });
          } catch {
            // A replaced or already-cleaned lease no longer belongs to us.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: unknown; root?: unknown; startedAt?: unknown } = {};
      try {
        owner = JSON.parse(readFileSync(metadataPath, "utf8")) as typeof owner;
      } catch {
        // No readable owner. Either a live acquirer is between its `mkdir` and
        // its metadata write, or the lease is a leftover we may clear. A lease
        // that disappears underneath us is neither: fall through to the
        // cleanup-and-retry path with no owner rather than throwing its ENOENT.
        let ageMs: number | undefined;
        try {
          ageMs = Date.now() - statSync(directory).mtimeMs;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        }
        if (ageMs !== undefined && ageMs < LEASE_HANDOVER_GRACE_MS) {
          throw new Error(`Another test suite is acquiring the host lease at ${directory}.`);
        }
      }
      const ownerPid = typeof owner.pid === "number" ? owner.pid : 0;
      if (ownerPid > 0 && processIsAlive(ownerPid)) {
        const location = typeof owner.root === "string" ? ` in ${owner.root}` : "";
        const since = typeof owner.startedAt === "string" ? ` since ${owner.startedAt}` : "";
        throw new Error(
          `Another full test suite is already running (PID ${ownerPid}${location}${since}).`,
        );
      }
      const staleDirectory = `${directory}.stale.${process.pid}.${Date.now()}`;
      try {
        renameSync(directory, staleDirectory);
        rmSync(staleDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
    }
  }
  throw new Error(`Could not acquire the full-suite lease at ${directory}.`);
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
      cwd: root,
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
  selectAreas: (repositoryRoot, env) => selectTestAreas({ root: repositoryRoot, env }),
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
 * Keep port-reservation and subprocess-deadline suites at the previous pool size
 * until their higher-concurrency failure rate has been measured on an idle host.
 */
export const MAX_BACKEND_TEST_WORKERS = 2;
export const ALLOW_MISSING_PROTOCOL_BINARY_ENV = "CODEX_PROTOCOL_CHECK_ALLOW_MISSING_BINARY";

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
  // multiplying peak heap.
  const workspaceConcurrency = budget >= 8 ? 2 : 1;
  const workspace = budget >= 6 ? 2 : 1;
  // Root absorbs the remaining capacity. The aggregate stays capped at eight:
  // higher caps repeatedly starved subprocess fixtures and produced
  // SIGTERM/SIGSEGV UI-worker crashes.
  const root = Math.max(1, budget - 1 - bridges - workspace * workspaceConcurrency);
  const backend = Math.max(
    workspace,
    Math.min(MAX_BACKEND_TEST_WORKERS, Number.isFinite(cores) ? Math.floor(cores / 3) : 0),
  );
  return { workspace, backend, workspaceConcurrency, root, bridges };
}

export function buildConcurrentGroups(
  cores: number,
  affected = false,
  timingsDirectory?: string,
  /** Package-script variables that leave unselected area suites out. */
  areaEnvironment: Record<string, string> = {},
): TestGroup[] {
  const workers = planWorkers(cores);
  // Groups may queue on tiny hosts, but no individual child may exceed the
  // capacity it reserves. The plan's minimum worker floor is not a grant.
  const capacity = Math.max(1, Math.floor(cores) || 1);
  workers.root = Math.min(capacity, workers.root);
  workers.bridges = Math.min(capacity, workers.bridges);
  // The backend task occupies one of the concurrent workspace slots.
  const workspaceReservation = Math.min(
    capacity,
    workers.backend + workers.workspace * (workers.workspaceConcurrency - 1),
  );
  const changedArguments = affected ? ["--changed=main", "--pass-with-no-tests"] : [];
  return [
    {
      name: "workspace (web, backend, desktop, web-public, cli, protocol, toolchain)",
      workers: workspaceReservation,
      command: "bunx",
      args: [
        "turbo",
        "run",
        "build",
        "test:workspace",
        "--cwd",
        ".",
        "--filter=@orkestrator/web",
        "--filter=@orkestrator/backend",
        "--filter=@orkestrator/desktop",
        "--filter=@orkestrator/web-public",
        "--filter=orkestrator",
        "--filter=@orkestrator/protocol",
        "--filter=@orkestrator/toolchain",
        `--concurrency=${workers.workspaceConcurrency}`,
        ...TURBO_GROUP_OUTPUT_FLAGS,
        "--summarize",
        ...(affected ? ["--affected"] : []),
      ],
      env: {
        ...areaEnvironment,
        [WORKSPACE_WORKERS_ENV]: String(workers.workspace),
        [BACKEND_WORKERS_ENV]: String(workers.backend),
      },
    },
    {
      name: "root and agent-support tests",
      workers: workers.root,
      command: "bun",
      // A bare `tests` is a Bun substring filter and also matches
      // packages/*/tests. An explicit relative path confines discovery to the
      // repository's root tests and prevents package build/test races.
      args: [
        "test",
        "./tests",
        "./e2e/agent-testing/artifact-sanitizer.test.ts",
        "./e2e/agent-testing/design-live-usage.test.ts",
        "./e2e/agent-testing/design-live-heartbeat.test.ts",
        "./e2e/agent-testing/paused-interactions-live-support.test.ts",
        "./e2e/agent-testing/mcp-apply-live-support.test.ts",
        "./e2e/agent-testing/mcp-apply-live-safety.test.ts",
        "./e2e/agent-testing/idle-observation-live-support.test.ts",
        "./e2e/agent-testing/coordinator-mail-tiles.test.ts",
        "./scripts/opencode-live-compatibility-probe.test.ts",
        "./test-fixtures/agent-project/server.test.ts",
        "--only-failures",
        ...changedArguments,
        ...(timingsDirectory
          ? ["--timings", path.join(timingsDirectory, "root.json"), "--update-timings"]
          : []),
        `--parallel=${workers.root}`,
      ],
    },
    {
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
    {
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
}

/**
 * Logs each area decision and returns the variables that skip unselected
 * areas. A selection failure runs every area: skipping is only an optimization.
 */
function selectAreaEnvironment(dependencies: TestAllDependencies): Record<string, string> {
  try {
    const decisions = dependencies.selectAreas(dependencies.root, dependencies.env);
    for (const { area, run, reason } of decisions) {
      dependencies.log(`${run ? "AREA RUN" : "AREA SKIP"} ${area.name}: ${reason}`);
    }
    return areaIgnoreEnvironment(decisions);
  } catch (error) {
    dependencies.log(
      `AREA RUN all: selection failed (${error instanceof Error ? error.message : String(error)})`,
    );
    return {};
  }
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export async function runAllTests(overrides: Partial<TestAllDependencies> = {}): Promise<number> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const usesDefaultRunner = dependencies.runGroup === defaultRunGroup;
  let admission: ReturnType<typeof createTestAdmission> | undefined;
  try {
    if (usesDefaultRunner)
      admission = createTestAdmission(dependencies.root, dependencies.env, dependencies.log);
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
    await pruneExpiredTestLogDirectories().catch(() => undefined);
    const affected = dependencies.env[TEST_AFFECTED_ENV] === "1";
    const timingsDirectory =
      dependencies.env[TEST_TIMINGS_DIRECTORY_ENV] ||
      (usesDefaultRunner ? createTestTimingsDirectory(dependencies.root) : undefined);
    const groups = buildConcurrentGroups(
      admission?.capacity.workers ?? dependencies.cores,
      affected,
      timingsDirectory,
      selectAreaEnvironment(dependencies),
    );
    const configuredLogDirectory = dependencies.env[TEST_LOG_DIRECTORY_ENV];
    const logDirectory = usesDefaultRunner
      ? configuredLogDirectory || createTestLogDirectory()
      : undefined;
    const sanitizedEnvironment = { ...dependencies.env };
    // Runtime diagnostic flags change assertion inputs and must not leak from a
    // development profile into an authoritative aggregate test run.
    for (const name of [
      "ORKESTRATOR_BRIDGE_DEBUG",
      "CLAUDE_BRIDGE_DEBUG",
      "CODEX_BRIDGE_DEBUG",
      "ACP_BRIDGE_DEBUG",
      "PI_BRIDGE_DEBUG",
      "CURSOR_BRIDGE_DEBUG",
    ]) {
      delete sanitizedEnvironment[name];
    }
    // Bun only defaults NODE_ENV to "test" when it is unset. An inherited
    // "production" (for example from an agent session launched by the packaged
    // app) loads React's production build, which has no `act`, and fails every
    // component test in groups that Turbo does not already filter.
    delete sanitizedEnvironment.NODE_ENV;
    const runEnvironment: NodeJS.ProcessEnv = { ...sanitizedEnvironment };
    delete runEnvironment.ORKESTRATOR_VALIDATION_SCHEDULER_STATE;
    delete runEnvironment.ORKESTRATOR_VALIDATION_HEAD_REF;
    delete runEnvironment.ORKESTRATOR_VALIDATION_RESOURCES;
    if (logDirectory) runEnvironment[TEST_LOG_DIRECTORY_ENV] = logDirectory;
    // Every workspace and bridge package script reads this to name its own
    // durations file, so it has to reach the group environments, not just the
    // root group's argument list.
    if (timingsDirectory) runEnvironment[TEST_TIMINGS_DIRECTORY_ENV] = timingsDirectory;

    dependencies.log(
      `Running ${groups.length} ${affected ? "affected " : ""}test groups concurrently…`,
    );
    const startedAt = Date.now();
    let completedCount = 0;

    const results: CompletedGroup[] = await Promise.all(
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

    // Detailed output stays in declaration order even though completion is
    // reported live above.
    let firstFailure = 0;
    for (const { group, result, elapsedMs } of results) {
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
