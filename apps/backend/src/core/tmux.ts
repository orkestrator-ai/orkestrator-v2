import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandContext } from "./commands.js";
import {
  ORKESTRATOR_AGENT_MCP_SERVER_NAME,
  type AgentToolConnection,
} from "./agent-tools.js";
import type { Environment } from "./models.js";
import type { JsonRecord } from "./storage.js";
import { runCommand } from "./shell.js";
import { TranscriptTaskTracker } from "./claude-transcript-tasks.js";
import type { TaskListSnapshot } from "@orkestrator/protocol/task-list";

type CommandHandler = (args: JsonRecord, context: CommandContext) => Promise<unknown> | unknown;
type RegisterCommand = (name: string, handler: CommandHandler) => void;

export type ExecOutput = {
  status: number;
  stdout: string;
  stderr: string;
};

type BackendKind = "local" | "container";

const CLAUDE_TMUX_EVENT = "claude-tmux:event";
const POLL_INTERVAL_MS = 250;
/**
 * How many poll ticks pass between `tmux has-session` checks. Hooks and
 * transcript appends still arrive every tick; only the liveness probe — which
 * costs its own process spawn and can only ever report a session that has
 * already stopped — runs on this slower cadence.
 */
export const LIVENESS_CHECK_EVERY_TICKS = 8;
const HOOK_TIMEOUT_SECS = 600;
const COMMAND_IDLE_TIMEOUT_MS = 8_000;
const COMMAND_NO_HOOK_SETTLE_MS = 2_000;
const COMMAND_AFTER_IDLE_SETTLE_MS = 400;
const PERMISSION_MODE_SWITCH_TIMEOUT_MS = 1_500;
const PERMISSION_MODE_POLL_MS = 100;
const BACKUP_SENTINEL_NO_ORIGINAL = "__orkestrator_no_original__";
const CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN = ".claude/settings.local.json";
/**
 * Machine-level base for namespaced, per-environment tmux runtime state.
 * Production paths add a data-directory hash before the environment id.
 * Exported so tests can derive the fallback path used by lightweight contexts:
 * stopping a session removes the whole environment directory, so a test that
 * guesses the path wrong cleans up nothing.
 */
export const RUNTIME_ROOT_PREFIX = "/tmp/orkestrator-v2-claude-tmux";

/**
 * Scope runtime state to one backend data directory.
 *
 * Multiple workspaces can run independent backends on the same machine. Their
 * environment registries are intentionally isolated, so a startup sweep must
 * never enumerate another instance's roots and classify them against the wrong
 * registry.
 */
export function claudeTmuxRuntimeRootPrefix(dataDir: string): string {
  const namespace = createHash("sha256")
    .update(path.resolve(dataDir))
    .digest("hex")
    .slice(0, 16);
  return path.join(RUNTIME_ROOT_PREFIX, namespace);
}

export function agentMcpConfigJson(connection: AgentToolConnection): string {
  return JSON.stringify({
    mcpServers: {
      [ORKESTRATOR_AGENT_MCP_SERVER_NAME]: {
        type: "http",
        url: connection.url,
        headers: {
          Authorization: `Bearer ${connection.token}`,
        },
      },
    },
  });
}

export function agentToolConnectionTarget(kind: BackendKind): "host" | "container" {
  return kind === "container" ? "container" : "host";
}

function runtimeRootPrefixForContext(context: CommandContext): string {
  const getDataDir = (context.storage as { getDataDir?: () => string }).getDataDir;
  return typeof getDataDir === "function"
    ? claudeTmuxRuntimeRootPrefix(getDataDir.call(context.storage))
    : RUNTIME_ROOT_PREFIX;
}

/** True when tmux confirms that a target disappeared before cleanup reached it. */
export function isMissingTmuxSessionError(value: unknown): boolean {
  const message = String(value);
  return (
    /can't find session/i.test(message)
    || /no server running/i.test(message)
    || /failed to connect to server/i.test(message)
    || /no sessions/i.test(message)
  );
}
/**
 * The thinking flags the launcher asks for. The probe below is built from these
 * same constants so the pair it validates can never drift from the pair the
 * launch command passes.
 */
const THINKING_MODE_ARGS = ["--thinking", "adaptive"] as const;
const THINKING_DISPLAY_FLAG = "--thinking-display";
const THINKING_DISPLAY_VALUE = "summarized";
/** Never a valid `--thinking-display` choice, so the CLI has to reject it. */
const THINKING_DISPLAY_PROBE_VALUE = "__orkestrator_probe__";
/** A capability probe that has not answered by now is not going to. */
const THINKING_DISPLAY_PROBE_TIMEOUT_MS = 10_000;

const HOOK_EVENT_KINDS = new Set([
  "PreToolUse",
  "PermissionRequest",
  "Elicitation",
  "ElicitationResult",
  "UserPromptExpansion",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "Notification",
  "SessionStart",
]);

/**
 * `docker exec` argv for running `args` inside a container. Every container-mode
 * command — including the launch-time capability probes — goes through here, so
 * the argv must survive the wrapper unmodified.
 */
export function containerExecArgs(containerId: string, args: string[], withStdin: boolean): string[] {
  const dockerArgs = ["exec", "-u", "node", "-w", "/workspace"];
  if (withStdin) dockerArgs.push("-i");
  dockerArgs.push(containerId, ...args);
  return dockerArgs;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${name} to be a string`);
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Expected ${name} to be a boolean`);
  return value;
}

function asPositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected ${name} to be a positive number`);
  }
  return Math.floor(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellDq(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function readableIdPrefix(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || "id";
}

export function tmuxSessionName(environmentId: string, tabId: string): string {
  const identityHash = createHash("sha256")
    .update(environmentId)
    .update("\0")
    .update(tabId)
    .digest("hex")
    .slice(0, 16);
  return `orkestrator-${readableIdPrefix(environmentId)}-${readableIdPrefix(tabId)}-${identityHash}`;
}

/**
 * The prefix every tmux session belonging to `environmentId` shares.
 *
 * A session name also carries the tab id and an identity hash, and a sweep
 * knows neither, so this prefix is the only handle a teardown has on "the
 * sessions of this environment". It is deliberately derived from
 * `tmuxSessionName` rather than duplicated: a change to the naming scheme must
 * not silently orphan the cleanup.
 */
export function tmuxSessionNamePrefix(environmentId: string): string {
  return `orkestrator-${readableIdPrefix(environmentId)}-`;
}

/** One session name per line, as `tmux list-sessions -F '#{session_name}'` prints them. */
export function parseTmuxSessionNames(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * The tmux sessions that may be killed on behalf of `environmentId`.
 *
 * `readableIdPrefix` truncates to 16 characters, so a prefix match alone could
 * in principle reach a *different* environment whose id starts the same way.
 * When any surviving environment claims the same prefix, nothing is selected:
 * a leaked tmux session is recovered on the next sweep, whereas killing a live
 * environment's agent session destroys work that cannot be recovered at all.
 */
export function selectReapableTmuxSessions(options: {
  names: readonly string[];
  environmentId: string;
  survivingEnvironmentIds: readonly string[];
}): string[] {
  const prefix = tmuxSessionNamePrefix(options.environmentId);
  const contested = options.survivingEnvironmentIds.some(
    (id) => id !== options.environmentId && tmuxSessionNamePrefix(id) === prefix,
  );
  if (contested) return [];
  return options.names.filter((name) => name.startsWith(prefix));
}

function isBlockingHook(kind: string): boolean {
  return kind === "PreToolUse" || kind === "PermissionRequest" || kind === "Elicitation";
}

function parseEventFilename(name: string): { kind: string; id: string } {
  const stem = name.endsWith(".json") ? name.slice(0, -5) : name;
  const dash = stem.indexOf("-");
  if (dash < 0) return { kind: stem, id: "" };
  return { kind: stem.slice(0, dash), id: stem.slice(dash + 1) };
}

function responseFilename(kind: string, id: string): string {
  if (!HOOK_EVENT_KINDS.has(kind)) throw new Error(`unsupported hook event kind: ${kind}`);
  if (
    id.length === 0 ||
    id.includes("..") ||
    !Array.from(id).every((char) => /[A-Za-z0-9._-]/.test(char))
  ) {
    throw new Error("invalid hook event id");
  }
  return `${kind}-${id}.json`;
}

function pathDirname(kind: BackendKind, filePath: string): string {
  return kind === "container" ? path.posix.dirname(filePath) : path.dirname(filePath);
}

function bytesPayload(text: string): { bytesBase64: string } {
  return { bytesBase64: Buffer.from(text, "utf8").toString("base64") };
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  let index = buffer.indexOf(0x0a);
  while (index >= 0) {
    count += 1;
    index = buffer.indexOf(0x0a, index + 1);
  }
  return count;
}

/** Like {@link ExecOutput}, but with stdout still in bytes. */
type RawExecOutput = {
  status: number;
  stdout: Buffer;
  stderr: string;
};

async function execWithOutput(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number } = {},
): Promise<ExecOutput> {
  const raw = await execWithRawOutput(command, args, options);
  return { status: raw.status, stdout: raw.stdout.toString(), stderr: raw.stderr };
}

/**
 * The spawn primitive, keeping stdout as bytes.
 *
 * Callers that read a *slice* of a file need the raw bytes: decoding a chunk
 * that starts or ends mid multi-byte character would replace the split
 * character with U+FFFD before the caller ever gets to rejoin the halves.
 */
async function execWithRawOutput(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number } = {},
): Promise<RawExecOutput> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    const timeout = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (timeout) clearTimeout(timeout);
      const stderrText = Buffer.concat(stderr).toString();
      resolve({
        status: timedOut ? -1 : code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: timedOut ? `${stderrText}\nCommand timed out`.trim() : stderrText,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

/** Everything one poll tick needs from the filesystem, gathered in one round trip. */
export type TmuxPollSnapshot = {
  /** Filenames in the session's pending-hook directory. */
  pending: string[];
  /** Filenames in the session's timed-out-hook directory. */
  timeouts: string[];
  /** Size of the transcript in bytes, or 0 when it has not been discovered yet. */
  transcriptSize: number;
};

/**
 * Section markers for the combined poll script. Hook files are always named
 * `<EventKind>-<id>.json`, so no listing entry can collide with one of these.
 */
const POLL_SNAPSHOT_PENDING_MARKER = "__ork_pending__";
const POLL_SNAPSHOT_TIMEOUT_MARKER = "__ork_timeout__";
const POLL_SNAPSHOT_SIZE_MARKER = "__ork_size__";

/**
 * One shell script that answers a whole poll tick: both hook directories and
 * the transcript size.
 *
 * Container mode pays a `docker exec` per backend operation, so the three
 * separate calls this replaces cost three process spawns every 250ms per open
 * tab — even with Claude completely idle.
 */
export function pollSnapshotScript(
  pendingDir: string,
  timeoutDir: string,
  transcriptPath: string | undefined,
): string {
  const size = transcriptPath
    ? `stat -c %s ${shellArg(transcriptPath)} 2>/dev/null || echo 0`
    : "echo 0";
  return [
    `echo ${POLL_SNAPSHOT_PENDING_MARKER}`,
    `ls -1 ${shellArg(pendingDir)} 2>/dev/null || true`,
    `echo ${POLL_SNAPSHOT_TIMEOUT_MARKER}`,
    `ls -1 ${shellArg(timeoutDir)} 2>/dev/null || true`,
    `echo ${POLL_SNAPSHOT_SIZE_MARKER}`,
    size,
  ].join("; ");
}

/** Parses {@link pollSnapshotScript} output back into a snapshot. */
export function parsePollSnapshotOutput(stdout: string): TmuxPollSnapshot {
  const snapshot: TmuxPollSnapshot = { pending: [], timeouts: [], transcriptSize: 0 };
  let section: "none" | "pending" | "timeouts" | "size" = "none";
  let sawPending = false;
  let sawTimeouts = false;
  let sawSize = false;
  let parsedSize = false;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line === POLL_SNAPSHOT_PENDING_MARKER) {
      sawPending = true;
      section = "pending";
      continue;
    }
    if (line === POLL_SNAPSHOT_TIMEOUT_MARKER) {
      sawTimeouts = true;
      section = "timeouts";
      continue;
    }
    if (line === POLL_SNAPSHOT_SIZE_MARKER) {
      sawSize = true;
      section = "size";
      continue;
    }
    if (section === "pending") snapshot.pending.push(line);
    else if (section === "timeouts") snapshot.timeouts.push(line);
    else if (section === "size") {
      const size = Number(line);
      if (!Number.isSafeInteger(size) || size < 0 || parsedSize) {
        throw new Error("Malformed tmux poll snapshot transcript size");
      }
      snapshot.transcriptSize = size;
      parsedSize = true;
    }
  }
  if (!sawPending || !sawTimeouts || !sawSize || !parsedSize) {
    throw new Error("Incomplete tmux poll snapshot");
  }
  return snapshot;
}

export function parsePollSnapshotExecOutput(output: ExecOutput): TmuxPollSnapshot {
  if (output.status !== 0) {
    throw new Error(output.stderr || "tmux poll snapshot command failed");
  }
  return parsePollSnapshotOutput(output.stdout);
}

/**
 * Reads `filePath` from `offset` to EOF. `tail -c +N` is 1-based, so the first
 * unread byte is `offset + 1`.
 */
export function tailFromOffsetCommand(filePath: string, offset: number): string {
  return `tail -c +${Math.max(0, Math.floor(offset)) + 1} ${shellArg(filePath)} 2>/dev/null || true`;
}

/** Separates the line count from the head bytes in {@link transcriptHeadCommand} output. */
const TRANSCRIPT_HEAD_MARKER = "__ork_head__";

/**
 * Line count plus the first `maxBytes` of a transcript, in one round trip.
 *
 * Session listings only need a title (from the first user message) and a count.
 * Reading whole rollout files to derive metadata is the anti-pattern AGENTS.md
 * calls out for the codex bridge; these files reach many megabytes and there
 * are up to fifty of them.
 */
export function transcriptHeadCommand(filePath: string, maxBytes: number): string {
  const quoted = shellArg(filePath);
  return `wc -l < ${quoted} 2>/dev/null || echo 0; echo ${TRANSCRIPT_HEAD_MARKER}; head -c ${Math.floor(maxBytes)} ${quoted} 2>/dev/null || true`;
}

/** Parses {@link transcriptHeadCommand} output. */
export function parseTranscriptHeadOutput(stdout: string): { head: string; lineCount: number } {
  const marker = `${TRANSCRIPT_HEAD_MARKER}\n`;
  const index = stdout.indexOf(marker);
  if (index < 0) return { head: "", lineCount: 0 };
  return {
    lineCount: Number.parseInt(stdout.slice(0, index).trim(), 10) || 0,
    head: stdout.slice(index + marker.length),
  };
}

/** How many sessions the resume dialog offers. */
const MAX_PREVIOUS_SESSIONS = 50;
/** Maximum local `stat` calls used while ranking transcript candidates. */
export const PREVIOUS_SESSION_STAT_CONCURRENCY = 8;

/** Lists every `.jsonl` in `dirPath` newest-first as NUL-terminated `<mtime> <path>` records. */
export function jsonlByMtimeFindCommand(dirPath: string): string {
  return `find ${shellArg(dirPath)}/ -mindepth 1 -maxdepth 1 -type f -name '*.jsonl' -printf '%T@ %p\\0' 2>/dev/null | sort -z -rn`;
}

/**
 * Whether a discovered path is a direct `.jsonl` child of `dirPath`.
 *
 * Container discovery output crosses a shell/process boundary. NUL framing
 * prevents filenames containing newlines from creating additional records,
 * while this independent check ensures even malformed output can never turn
 * into an out-of-directory read.
 */
export function isDirectJsonlChild(dirPath: string, candidatePath: string): boolean {
  if (!candidatePath || candidatePath.includes("\0")) return false;
  const normalizedDir = path.posix.normalize(dirPath);
  const normalizedCandidate = path.posix.normalize(candidatePath);
  return path.posix.isAbsolute(normalizedCandidate) === path.posix.isAbsolute(normalizedDir)
    && path.posix.dirname(normalizedCandidate) === normalizedDir
    && normalizedCandidate === candidatePath
    && path.posix.basename(normalizedCandidate).endsWith(".jsonl");
}

/**
 * Rank local transcript names with bounded filesystem concurrency.
 *
 * All names still need metadata to identify the newest files, but a directory
 * containing thousands of rollouts must not issue thousands of simultaneous
 * `stat` calls. Only the rows the resume dialog can consume are retained.
 */
export async function listLocalJsonlByMtime(
  dirPath: string,
  names: readonly string[],
  fileMtimeUnix: (filePath: string) => Promise<number>,
  limit = MAX_PREVIOUS_SESSIONS,
  concurrency = PREVIOUS_SESSION_STAT_CONCURRENCY,
): Promise<Array<{ path: string; mtime: number }>> {
  const candidates = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(dirPath, name))
    .filter((candidatePath) => isDirectJsonlChild(dirPath, candidatePath));
  const entries: Array<{ path: string; mtime: number }> = [];
  let nextIndex = 0;
  const workerCount = Math.min(
    candidates.length,
    Math.max(1, Math.floor(concurrency)),
  );
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < candidates.length) {
      const candidatePath = candidates[nextIndex++]!;
      entries.push({
        path: candidatePath,
        mtime: await fileMtimeUnix(candidatePath),
      });
    }
  }));
  return entries
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(0, Math.floor(limit)));
}

class TmuxBackend {
  readonly kind: BackendKind;
  readonly cwd?: string;
  readonly containerId?: string;

  private constructor(kind: BackendKind, options: { cwd?: string; containerId?: string }) {
    this.kind = kind;
    this.cwd = options.cwd;
    this.containerId = options.containerId;
  }

  static local(cwd: string): TmuxBackend {
    return new TmuxBackend("local", { cwd });
  }

  static container(containerId: string): TmuxBackend {
    return new TmuxBackend("container", { containerId });
  }

  async exec(args: string[], stdin?: string, timeoutMs = 60_000): Promise<ExecOutput> {
    if (args.length === 0) throw new Error("cannot execute empty command");
    if (this.kind === "local") {
      return execWithOutput(args[0]!, args.slice(1), {
        cwd: this.cwd,
        stdin,
        timeoutMs,
      });
    }

    if (!this.containerId) throw new Error("container backend has no container id");
    return execWithOutput(
      "docker",
      containerExecArgs(this.containerId, args, stdin !== undefined),
      { stdin, timeoutMs },
    );
  }

  private async execRaw(args: string[], timeoutMs = 60_000): Promise<RawExecOutput> {
    if (args.length === 0) throw new Error("cannot execute empty command");
    if (this.kind === "local") {
      return execWithRawOutput(args[0]!, args.slice(1), { cwd: this.cwd, timeoutMs });
    }
    if (!this.containerId) throw new Error("container backend has no container id");
    return execWithRawOutput("docker", containerExecArgs(this.containerId, args, false), { timeoutMs });
  }

  async readFile(filePath: string): Promise<string | undefined> {
    if (this.kind === "local") {
      try {
        return await fs.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }

    const probe = await this.exec(["test", "-f", filePath]);
    if (probe.status !== 0) return undefined;
    const out = await this.exec(["cat", filePath]);
    if (out.status !== 0) throw new Error(out.stderr || `failed to read ${filePath}`);
    return out.stdout;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (this.kind === "local") {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
      return;
    }

    await this.ensureDir(pathDirname(this.kind, filePath));
    const out = await this.exec(["sh", "-c", `cat > ${shellArg(filePath)}`], content);
    if (out.status !== 0) throw new Error(out.stderr || `failed to write ${filePath}`);
  }

  /**
   * Atomically replace a credential-bearing file with an owner-only file.
   *
   * The ordinary writeFile helper intentionally follows the caller's umask.
   * Agent MCP configs contain a project-scoped bearer token, so they must never
   * exist with those ordinary permissions, even briefly.
   */
  async writePrivateFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    if (this.kind === "local") {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      let moved = false;
      try {
        const handle = await fs.open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.chmod(tempPath, 0o600);
        const tempMode = (await fs.stat(tempPath)).mode & 0o777;
        if (tempMode !== 0o600) {
          throw new Error(`failed to secure ${filePath}`);
        }
        await fs.rename(tempPath, filePath);
        moved = true;
        const finalMode = (await fs.stat(filePath)).mode & 0o777;
        if (finalMode !== 0o600) {
          throw new Error(`failed to secure ${filePath}`);
        }
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        if (moved) await fs.rm(filePath, { force: true }).catch(() => undefined);
        throw error;
      }
      return;
    }

    await this.ensureDir(pathDirname(this.kind, filePath));
    const script = [
      "set -eu",
      "umask 077",
      `tmp=${shellArg(tempPath)}`,
      'trap \'rm -f "$tmp"\' EXIT',
      'cat > "$tmp"',
      'chmod 600 "$tmp"',
      '[ "$(stat -c %a "$tmp")" = "600" ]',
      `mv -f "$tmp" ${shellArg(filePath)}`,
      "trap - EXIT",
    ].join("\n");
    const out = await this.exec(["sh", "-c", script], content);
    if (out.status !== 0) {
      await this.removeFile(tempPath);
      throw new Error(out.stderr || `failed to securely write ${filePath}`);
    }
  }

  async removeFile(filePath: string): Promise<void> {
    if (this.kind === "local") {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      return;
    }
    await this.exec(["rm", "-f", filePath]);
  }

  async removeDir(dirPath: string): Promise<void> {
    if (this.kind === "local") {
      await fs.rm(dirPath, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    await this.exec(["rm", "-rf", dirPath]);
  }

  async ensureDir(dirPath: string): Promise<void> {
    if (this.kind === "local") {
      await fs.mkdir(dirPath, { recursive: true });
      return;
    }
    const out = await this.exec(["mkdir", "-p", dirPath]);
    if (out.status !== 0) throw new Error(out.stderr || `failed to create ${dirPath}`);
  }

  async listDir(dirPath: string): Promise<string[]> {
    if (this.kind === "local") {
      try {
        return await fs.readdir(dirPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    }

    const out = await this.exec(["sh", "-c", `ls -1 ${shellArg(dirPath)} 2>/dev/null || true`]);
    return out.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async fileSize(filePath: string): Promise<number> {
    if (this.kind === "local") {
      try {
        return (await fs.stat(filePath)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    }

    const out = await this.exec(["sh", "-c", `stat -c %s ${shellArg(filePath)} 2>/dev/null || echo 0`]);
    return Number.parseInt(out.stdout.trim(), 10) || 0;
  }

  /**
   * The bytes of `filePath` from `offset` to EOF.
   *
   * Appends are read as appends: re-reading the whole transcript on every
   * 250ms tick made the tail cost O(size²) over a session, and in container
   * mode piped every megabyte back through `docker exec` each time.
   */
  async readFileBytesFrom(filePath: string, offset: number): Promise<Buffer> {
    const start = Math.max(0, Math.floor(offset));
    if (this.kind === "local") {
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try {
        handle = await fs.open(filePath, "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
        throw error;
      }
      try {
        const length = Math.max(0, (await handle.stat()).size - start);
        if (length === 0) return Buffer.alloc(0);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close().catch(() => undefined);
      }
    }

    const out = await this.execRaw(["sh", "-c", tailFromOffsetCommand(filePath, start)]);
    return out.stdout;
  }

  /**
   * Both hook directories and the transcript size for one poll tick.
   *
   * Local reads are three cheap syscalls issued together; container reads
   * collapse into a single `docker exec`.
   */
  async pollSnapshot(paths: SessionHookPaths, transcriptPath: string | undefined): Promise<TmuxPollSnapshot> {
    if (this.kind === "local") {
      const [pending, timeouts, transcriptSize] = await Promise.all([
        this.listDir(paths.pendingDir),
        this.listDir(paths.timeoutDir),
        transcriptPath ? this.fileSize(transcriptPath) : Promise.resolve(0),
      ]);
      return { pending, timeouts, transcriptSize };
    }

    const out = await this.exec([
      "sh",
      "-c",
      pollSnapshotScript(paths.pendingDir, paths.timeoutDir, transcriptPath),
    ]);
    return parsePollSnapshotExecOutput(out);
  }

  /** Every `.jsonl` in `dirPath` as `{ path, mtime }`, newest first. */
  async listJsonlByMtime(dirPath: string): Promise<Array<{ path: string; mtime: number }>> {
    if (this.kind === "container") {
      const out = await this.exec(["sh", "-c", jsonlByMtimeFindCommand(dirPath)]);
      return parseFreshJsonlFindOutput(out.stdout)
        .filter((candidate) => isDirectJsonlChild(dirPath, candidate.path))
        .slice(0, MAX_PREVIOUS_SESSIONS);
    }

    return listLocalJsonlByMtime(
      dirPath,
      await this.listDir(dirPath),
      (filePath) => this.fileMtimeUnix(filePath),
    );
  }

  /**
   * The first `maxBytes` of a transcript plus its line count, without ever
   * materialising the whole file.
   */
  async transcriptHead(filePath: string, maxBytes: number): Promise<{ head: string; lineCount: number }> {
    if (this.kind === "container") {
      const out = await this.exec(["sh", "-c", transcriptHeadCommand(filePath, maxBytes)]);
      return parseTranscriptHeadOutput(out.stdout);
    }

    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(filePath, "r");
    } catch {
      return { head: "", lineCount: 0 };
    }
    try {
      const buffer = Buffer.allocUnsafe(maxBytes);
      const first = await handle.read(buffer, 0, maxBytes, 0);
      const head = buffer.subarray(0, first.bytesRead).toString("utf8");
      let lineCount = countNewlines(buffer.subarray(0, first.bytesRead));
      // Counting the tail streams past it rather than retaining it: the count
      // is cosmetic, but it still has to cover the whole file.
      let position = first.bytesRead;
      while (first.bytesRead === maxBytes) {
        const next = await handle.read(buffer, 0, maxBytes, position);
        if (next.bytesRead === 0) break;
        lineCount += countNewlines(buffer.subarray(0, next.bytesRead));
        position += next.bytesRead;
      }
      return { head, lineCount };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async fileMtimeUnix(filePath: string): Promise<number> {
    if (this.kind === "local") {
      try {
        return Math.floor((await fs.stat(filePath)).mtimeMs / 1000);
      } catch {
        return 0;
      }
    }

    const out = await this.exec(["sh", "-c", `stat -c %Y ${shellArg(filePath)} 2>/dev/null || echo 0`]);
    return Number.parseInt(out.stdout.trim(), 10) || 0;
  }
}

type WorkspaceHookPaths = {
  root: string;
  sessionsDir: string;
  script: string;
  claudeSettings: string;
  claudeSettingsBackup: string;
};

type SessionHookPaths = {
  sessionDir: string;
  pendingDir: string;
  responseDir: string;
  timeoutDir: string;
};

type PendingHookEvent = {
  id: string;
  kind: string;
  payload: unknown;
};

function workspaceHookPaths(runtimeRoot: string, workspace: string): WorkspaceHookPaths {
  return {
    root: runtimeRoot,
    sessionsDir: `${runtimeRoot}/sessions`,
    script: `${runtimeRoot}/hook.sh`,
    claudeSettings: `${workspace}/.claude/settings.local.json`,
    claudeSettingsBackup: `${runtimeRoot}/settings.local.json.orkestrator-v2-backup`,
  };
}

function sessionHookPaths(workspace: WorkspaceHookPaths, sessionId: string): SessionHookPaths {
  const sessionDir = `${workspace.sessionsDir}/${sessionId}`;
  return {
    sessionDir,
    pendingDir: `${sessionDir}/pending`,
    responseDir: `${sessionDir}/response`,
    timeoutDir: `${sessionDir}/timeout`,
  };
}

function hookScript(workspace: WorkspaceHookPaths): string {
  return `#!/usr/bin/env bash
# orkestrator-v2 claude-tmux hook
set -u
EVENT_KIND="\${1:-Unknown}"
SESSIONS_DIR=${shellDq(workspace.sessionsDir)}
TIMEOUT_SECS=${HOOK_TIMEOUT_SECS}

PAYLOAD="$(cat)"

SESSION_ID=""
if command -v python3 >/dev/null 2>&1; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | python3 -c 'import sys, json
try:
    d = json.loads(sys.stdin.read())
    v = d.get("session_id", "") if isinstance(d, dict) else ""
    if isinstance(v, str):
        print(v)
except Exception:
    pass' 2>/dev/null)"
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([0-9a-fA-F-]\\{8,\\}\\)".*/\\1/p' | head -1)"
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="unknown"
fi
SESSION_ID="$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9._-')"
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="unknown"
fi

SESSION_DIR="$SESSIONS_DIR/$SESSION_ID"
PENDING_DIR="$SESSION_DIR/pending"
RESPONSE_DIR="$SESSION_DIR/response"
TIMEOUT_DIR="$SESSION_DIR/timeout"
mkdir -p "$PENDING_DIR" "$RESPONSE_DIR" "$TIMEOUT_DIR" 2>/dev/null || true

ID="$(date +%s)-$$-\${RANDOM}-\${RANDOM}"
PENDING_FILE="$PENDING_DIR/\${EVENT_KIND}-\${ID}.json"
RESPONSE_FILE="$RESPONSE_DIR/\${EVENT_KIND}-\${ID}.json"
TIMEOUT_FILE="$TIMEOUT_DIR/\${EVENT_KIND}-\${ID}.json"

printf '%s' "$PAYLOAD" > "$PENDING_FILE"

case "$EVENT_KIND" in
  PreToolUse|PermissionRequest|Elicitation)
    i=0
    while [ $i -lt $((TIMEOUT_SECS * 4)) ]; do
      if [ -f "$RESPONSE_FILE" ]; then
        cat "$RESPONSE_FILE"
        rm -f "$RESPONSE_FILE" "$PENDING_FILE"
        exit 0
      fi
      sleep 0.25
      i=$((i + 1))
    done
    printf '{"timed_out":true}' > "$TIMEOUT_FILE"
    rm -f "$PENDING_FILE"
    echo '{}'
    ;;
  *)
    echo '{}'
    ;;
esac
`;
}

function hooksBlock(hookScriptPath: string): unknown {
  const commandPrefix = `bash ${shellDq(hookScriptPath)} `;
  const command = (kind: string) => `${commandPrefix}${kind}`;
  const matcherHook = (kind: string) => ({
    matcher: "*",
    hooks: [{ type: "command", command: command(kind) }],
  });
  const hook = (kind: string) => ({
    hooks: [{ type: "command", command: command(kind) }],
  });

  return {
    PreToolUse: [
      {
        matcher: "AskUserQuestion",
        hooks: [{ type: "command", command: command("PreToolUse") }],
      },
      {
        matcher: "ExitPlanMode",
        hooks: [{ type: "command", command: command("PreToolUse") }],
      },
    ],
    PermissionRequest: [matcherHook("PermissionRequest")],
    Elicitation: [hook("Elicitation")],
    ElicitationResult: [hook("ElicitationResult")],
    UserPromptExpansion: [hook("UserPromptExpansion")],
    PostToolUse: [matcherHook("PostToolUse")],
    UserPromptSubmit: [hook("UserPromptSubmit")],
    Stop: [hook("Stop")],
    SubagentStop: [hook("SubagentStop")],
    Notification: [hook("Notification")],
    SessionStart: [hook("SessionStart")],
  };
}

function mergeSettingsJson(existing: string | undefined, hookScriptPath: string): string {
  let root: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    } catch {
      root = {};
    }
  }
  root.hooks = hooksBlock(hookScriptPath);
  return `${JSON.stringify(root, null, 2)}\n`;
}

function gitExcludeSetupScript(pattern: string): string {
  return `set -e
pattern=${shellArg(pattern)}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

git_dir_raw="$(git rev-parse --git-dir)"
common_dir_raw="$(git rev-parse --git-common-dir 2>/dev/null || printf '%s' "$git_dir_raw")"

git_dir="$(cd "$git_dir_raw" 2>/dev/null && pwd -P || printf '%s' "$git_dir_raw")"
common_dir="$(cd "$common_dir_raw" 2>/dev/null && pwd -P || printf '%s' "$common_dir_raw")"

if [ "$git_dir" != "$common_dir" ]; then
  git config extensions.worktreeConfig true
  exclude_file="$(git config --worktree --get core.excludesFile 2>/dev/null || true)"
  if [ -z "$exclude_file" ]; then
    exclude_file="$git_dir/info/exclude"
    git config --worktree core.excludesFile "$exclude_file"
  fi
else
  exclude_file="$git_dir/info/exclude"
fi

case "$exclude_file" in
  "~/"*) exclude_file="$HOME/\${exclude_file#~/}" ;;
esac

mkdir -p "$(dirname "$exclude_file")"
touch "$exclude_file"

append_exclude_pattern() {
  exclude_file="$1"
  pattern="$2"
  if [ -s "$exclude_file" ] && [ "$(tail -c 1 "$exclude_file" 2>/dev/null)" != "" ]; then
    printf '\\n' >> "$exclude_file"
  fi
  printf '%s\\n' "$pattern" >> "$exclude_file"
}

if ! grep -qxF "$pattern" "$exclude_file"; then
  append_exclude_pattern "$exclude_file" "$pattern"
fi
`;
}

async function ensureClaudeSettingsGitIgnored(backend: TmuxBackend): Promise<void> {
  await backend.exec(["bash", "-lc", gitExcludeSetupScript(CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN)])
    .catch((error) => console.warn("[tmux] failed to configure git exclude", error));
}

async function installWorkspaceHooks(backend: TmuxBackend, paths: WorkspaceHookPaths): Promise<void> {
  await backend.ensureDir(paths.root);
  await backend.ensureDir(paths.sessionsDir);
  await ensureClaudeSettingsGitIgnored(backend);

  await backend.writeFile(paths.script, hookScript(paths));
  const chmod = await backend.exec(["chmod", "+x", paths.script]);
  if (chmod.status !== 0) throw new Error(chmod.stderr || "failed to chmod hook script");

  const existingBackup = await backend.readFile(paths.claudeSettingsBackup);
  const existingSettings = await backend.readFile(paths.claudeSettings);
  if (existingBackup === undefined) {
    await backend.writeFile(
      paths.claudeSettingsBackup,
      existingSettings === undefined ? BACKUP_SENTINEL_NO_ORIGINAL : existingSettings,
    );
  }

  await backend.writeFile(paths.claudeSettings, mergeSettingsJson(existingSettings, paths.script));
}

async function uninstallWorkspaceHooks(backend: TmuxBackend, paths: WorkspaceHookPaths): Promise<void> {
  await restoreWorkspaceHooks(backend, paths);
  await backend.removeFile(paths.claudeSettingsBackup).catch(() => undefined);
  await backend.removeDir(paths.root).catch(() => undefined);
}

async function restoreWorkspaceHooks(backend: TmuxBackend, paths: WorkspaceHookPaths): Promise<void> {
  const backup = await backend.readFile(paths.claudeSettingsBackup);
  if (backup === BACKUP_SENTINEL_NO_ORIGINAL) {
    await backend.removeFile(paths.claudeSettings);
  } else if (backup !== undefined) {
    await backend.writeFile(paths.claudeSettings, backup);
  }
}

async function ensureSessionDirs(backend: TmuxBackend, paths: SessionHookPaths): Promise<void> {
  await backend.ensureDir(paths.sessionDir);
  await backend.ensureDir(paths.pendingDir);
  await backend.ensureDir(paths.responseDir);
  await backend.ensureDir(paths.timeoutDir);
}

/** `names` comes from the tick's {@link TmuxPollSnapshot}, not a fresh listing. */
async function drainTimeouts(
  backend: TmuxBackend,
  paths: SessionHookPaths,
  names: string[],
): Promise<Array<{ kind: string; id: string }>> {
  const out: Array<{ kind: string; id: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseEventFilename(name);
    await backend.removeFile(`${paths.timeoutDir}/${name}`).catch(() => undefined);
    out.push(parsed);
  }
  return out;
}

/** `pendingNames` comes from the tick's {@link TmuxPollSnapshot}, not a fresh listing. */
async function drainPending(
  backend: TmuxBackend,
  paths: SessionHookPaths,
  pendingNames: string[],
  alreadyEmitted: Set<string>,
): Promise<PendingHookEvent[]> {
  const names = pendingNames.filter((name) => name.endsWith(".json")).sort();
  const stillPresent = new Set(names.map((name) => parseEventFilename(name).id));
  for (const id of Array.from(alreadyEmitted)) {
    if (!stillPresent.has(id)) alreadyEmitted.delete(id);
  }

  const events: PendingHookEvent[] = [];
  for (const name of names) {
    const full = `${paths.pendingDir}/${name}`;
    const { kind, id } = parseEventFilename(name);
    const blocking = isBlockingHook(kind);
    if (blocking && alreadyEmitted.has(id)) continue;

    const content = await backend.readFile(full);
    if (content === undefined) continue;

    let payload: unknown = content;
    try {
      payload = JSON.parse(content);
    } catch {
      payload = content;
    }

    if (blocking) {
      alreadyEmitted.add(id);
    } else {
      await backend.removeFile(full).catch(() => undefined);
    }
    events.push({ id, kind, payload });
  }
  return events;
}

async function listPendingBlocking(backend: TmuxBackend, paths: SessionHookPaths): Promise<PendingHookEvent[]> {
  const names = (await backend.listDir(paths.pendingDir)).filter((name) => name.endsWith(".json")).sort();
  const events: PendingHookEvent[] = [];
  for (const name of names) {
    const { kind, id } = parseEventFilename(name);
    if (!isBlockingHook(kind)) continue;
    if (await backend.readFile(`${paths.responseDir}/${name}`) !== undefined) continue;

    const content = await backend.readFile(`${paths.pendingDir}/${name}`);
    if (content === undefined) continue;
    let payload: unknown = content;
    try {
      payload = JSON.parse(content);
    } catch {
      payload = content;
    }
    events.push({ id, kind, payload });
  }
  return events;
}

async function replyToHook(
  backend: TmuxBackend,
  paths: SessionHookPaths,
  kind: string,
  id: string,
  response: unknown,
): Promise<void> {
  const filename = responseFilename(kind, id);
  await backend.writeFile(`${paths.responseDir}/${filename}`, JSON.stringify(response ?? {}));
  await backend.removeFile(`${paths.pendingDir}/${filename}`).catch(() => undefined);
}

function preToolUseResponse(decision: string, reason?: string): unknown {
  const permissionDecision = decision === "approve" || decision === "allow"
    ? "allow"
    : decision === "block" || decision === "deny"
      ? "deny"
      : decision;
  const hookSpecificOutput: Record<string, string> = {
    hookEventName: "PreToolUse",
    permissionDecision,
  };
  if (reason) hookSpecificOutput.permissionDecisionReason = reason;
  return { hookSpecificOutput };
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, "").replaceAll("/", "-");
}

function localClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

async function findTranscriptPath(
  backend: TmuxBackend,
  claudeHome: string,
  cwd: string,
  sessionId: string,
  minMtimeUnix?: number,
): Promise<string | undefined> {
  const projectDir = `${claudeHome}/projects/${encodeCwd(cwd)}`;
  const exact = `${projectDir}/${sessionId}.jsonl`;
  if (await backend.fileSize(exact) > 0 || await backend.readFile(exact) !== undefined) {
    return exact;
  }
  if (minMtimeUnix !== undefined) {
    return newestJsonlInDir(backend, projectDir, minMtimeUnix, sessionId);
  }
  return undefined;
}

/**
 * Builds the shell command that lists fresh `.jsonl` files in `dirPath` newest-first,
 * emitting NUL-terminated `<mtime> <path>` records. Relies on GNU `find`
 * (`-printf`/`-newermt`) and GNU `sort -z`, which are
 * available inside the Linux container backend.
 */
export function newestJsonlFindCommand(dirPath: string, minMtimeUnix: number): string {
  return `find ${shellArg(dirPath)}/ -mindepth 1 -maxdepth 1 -type f -name '*.jsonl' -newermt @${minMtimeUnix} -printf '%T@ %p\\0' 2>/dev/null | sort -z -rn`;
}

/**
 * Parses NUL-terminated `find -printf '%T@ %p\0'` output into records.
 *
 * An unterminated final record is ignored. Treating newlines as ordinary
 * filename bytes is essential: splitting on them would let one filename forge
 * another path record.
 */
export function parseFreshJsonlFindOutput(findOutput: string): Array<{ path: string; mtime: number }> {
  if (!findOutput.endsWith("\0")) return [];
  return findOutput
    .split("\0")
    .slice(0, -1)
    .flatMap((record) => {
      const firstSpace = record.indexOf(" ");
      if (firstSpace < 0) return [];
      const mtime = Number.parseFloat(record.slice(0, firstSpace));
      const candidatePath = record.slice(firstSpace + 1);
      if (!Number.isFinite(mtime) || candidatePath.length === 0) return [];
      return [{ path: candidatePath, mtime }];
    });
}

/**
 * Finds the fresh (`mtime >= minMtimeUnix`) `.jsonl` in `dirPath` whose content is owned by
 * `sessionId`. Only resolves when exactly one file claims the session, so a newly started tab
 * never binds to another tab's transcript. Returns undefined when zero or multiple files match.
 */
export async function newestJsonlInDir(
  backend: TmuxBackend,
  dirPath: string,
  minMtimeUnix: number,
  sessionId: string,
): Promise<string | undefined> {
  let candidates: Array<{ path: string; mtime: number }>;
  if (backend.kind === "container") {
    const out = await backend.exec(["sh", "-c", newestJsonlFindCommand(dirPath, minMtimeUnix)]);
    candidates = parseFreshJsonlFindOutput(out.stdout)
      .filter((candidate) => isDirectJsonlChild(dirPath, candidate.path));
  } else {
    const names = await backend.listDir(dirPath);
    candidates = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const fullPath = path.join(dirPath, name);
      if (!isDirectJsonlChild(dirPath, fullPath)) continue;
      const mtime = await backend.fileMtimeUnix(fullPath);
      if (mtime < minMtimeUnix) continue;
      candidates.push({ path: fullPath, mtime });
    }
  }

  const matches: Array<{ path: string; mtime: number }> = [];
  for (const candidate of candidates) {
    const content = await backend.readFile(candidate.path) ?? "";
    if (transcriptContainsSessionId(content, sessionId)) {
      matches.push(candidate);
    }
  }
  return matches.length === 1 ? matches[0]?.path : undefined;
}

export function transcriptContainsSessionId(content: string, sessionId: string): boolean {
  if (!content || !sessionId) return false;
  // One parse per line, not two. Claude writes the owning session id at the top
  // level of every record and the deep walk tests exactly that key before it
  // recurses, so a separate shallow pass can only ever win on a match — on a
  // miss it re-parsed the whole file for nothing. Discovery re-reads every
  // candidate in this environment's project dir on each 250ms poll tick until a
  // transcript binds, so the miss is the common case.
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (jsonContainsSessionId(value, sessionId)) return true;
  }
  return false;
}

function jsonContainsSessionId(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsSessionId(item, sessionId));
  }

  const record = value as Record<string, unknown>;
  if (record.sessionId === sessionId || record.session_id === sessionId) {
    return true;
  }
  return Object.values(record).some((item) => jsonContainsSessionId(item, sessionId));
}

/**
 * How much of a transcript the listing reads. The title is the first user
 * message, which is within the first few lines of every real transcript; a
 * session whose opening prompt somehow exceeds this is listed untitled rather
 * than costing a multi-megabyte read.
 */
export const TRANSCRIPT_HEAD_BYTES = 64 * 1024;

async function listPreviousSessions(
  backend: TmuxBackend,
  claudeHome: string,
  cwd: string,
): Promise<Array<{ session_id: string; title: string | null; last_activity_unix: number; message_count: number; transcript_path: string }>> {
  const projectDir = `${claudeHome}/projects/${encodeCwd(cwd)}`;
  const candidates = (await backend.listJsonlByMtime(projectDir)).slice(0, MAX_PREVIOUS_SESSIONS);

  const out = [];
  for (const candidate of candidates) {
    const { head, lineCount } = await backend.transcriptHead(candidate.path, TRANSCRIPT_HEAD_BYTES);
    const name = candidate.path.slice(candidate.path.lastIndexOf("/") + 1);
    out.push({
      session_id: name.endsWith(".jsonl") ? name.slice(0, -6) : name,
      title: titleFromTranscriptHead(head, head.length >= TRANSCRIPT_HEAD_BYTES),
      last_activity_unix: Math.floor(candidate.mtime),
      message_count: lineCount,
      transcript_path: candidate.path,
    });
  }
  return out;
}

/**
 * The first user message in the head of a transcript.
 *
 * When the head was truncated its final line is a fragment — possibly cut mid
 * multi-byte character — so it is dropped rather than parsed.
 */
function titleFromTranscriptHead(head: string, truncated: boolean): string | null {
  const lines = head.split("\n");
  if (truncated) lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const message = record.message && typeof record.message === "object"
      ? record.message as Record<string, unknown>
      : undefined;
    const role = typeof message?.role === "string" ? message.role : typeof record.type === "string" ? record.type : undefined;
    if (role !== "user") continue;
    const contentField = message?.content ?? record.content;
    const text = extractTextContent(contentField);
    if (text?.trim()) return truncateTitle(text.trim(), 80);
  }
  return null;
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return record.text;
  }
  return undefined;
}

function truncateTitle(value: string, maxChars: number): string {
  const singleLine = value.replaceAll("\n", " ");
  return Array.from(singleLine).length <= maxChars ? singleLine : `${Array.from(singleLine).slice(0, maxChars).join("")}...`;
}

export class TranscriptTail {
  private offset = 0;
  /**
   * The bytes after the last newline of the previous read: an unterminated
   * line, which may also stop mid multi-byte character. Held as bytes, not as
   * a string, so a character split across two reads is decoded once from the
   * rejoined halves instead of twice as two U+FFFD replacements.
   */
  private partial: Buffer = Buffer.alloc(0);

  constructor(readonly filePath: string) {}

  /**
   * Parses whatever has been appended since the last call.
   *
   * `knownSize` lets a caller that already stat'd the file (the poll loop gets
   * it in its snapshot) skip a second stat. Only the appended bytes are read:
   * transcripts reach many megabytes and this runs every 250ms.
   */
  async readNew(backend: TmuxBackend, knownSize?: number): Promise<unknown[]> {
    const size = knownSize ?? await backend.fileSize(this.filePath);
    // A transcript path may be truncated or replaced when Claude resumes or
    // rotates its writer. The previous byte offset is meaningless for the new
    // shorter file, and carrying its partial line would corrupt the first new
    // record.
    if (size < this.offset) {
      this.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    if (size <= this.offset) return [];

    const chunk = await backend.readFileBytesFrom(this.filePath, this.offset);
    if (chunk.length === 0) return [];
    this.offset += chunk.length;

    const combined = this.partial.length === 0 ? chunk : Buffer.concat([this.partial, chunk]);
    const lastNewline = combined.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // Copied, not a view: a subarray would pin the whole read buffer.
      this.partial = Buffer.from(combined);
      return [];
    }
    this.partial = Buffer.from(combined.subarray(lastNewline + 1));

    const lines: unknown[] = [];
    // A newline byte never appears inside a UTF-8 multi-byte sequence, so
    // everything up to the last one is a complete, decodable run of lines.
    for (const raw of combined.subarray(0, lastNewline).toString("utf8").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // Ignore malformed JSONL fragments.
      }
    }
    return lines;
  }
}

type TmuxStatus = {
  tab_id: string;
  environment_id: string;
  session_id: string | null;
  tmux_session: string;
  running: boolean;
  transcript_path: string | null;
  resumed: boolean;
  busy: boolean;
  permission_mode: string;
};

function permissionModeFromTranscriptLine(line: unknown): string | undefined {
  if (!line || typeof line !== "object") return undefined;
  const record = line as Record<string, unknown>;
  return record.type === "permission-mode" && typeof record.permissionMode === "string"
    ? record.permissionMode
    : undefined;
}

function permissionModeFromPane(snapshot: string): string | undefined {
  const normalized = snapshot.toLowerCase().split("\n").slice(-6).join("\n");
  if (normalized.includes("plan mode on")) return "plan";
  if (normalized.includes("bypass permissions on")) return "bypassPermissions";
  if (normalized.includes("accept edits on") || normalized.includes("edit automatically on")) return "acceptEdits";
  if (normalized.includes("auto mode on")) return "auto";
  if (normalized.includes("ask before edits on") || normalized.includes("manual mode on")) return "default";
  if (normalized.includes("don't ask on") || normalized.includes("dont ask on")) return "dontAsk";
  return undefined;
}

/**
 * How long a pane capture may be reused. Long enough that several renderers
 * polling the same session share one spawn, short enough that nobody sees a
 * pane that is visibly behind.
 */
export const CAPTURE_PANE_CACHE_MS = 200;

/** What `claude_tmux_capture_pane` answers when the caller supplied a hash. */
export type PaneCaptureResult =
  | { unchanged: true; hash: string }
  | { unchanged: false; hash: string; text: string };

export function paneHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** The `exec` surface the thinking-display probe needs, so it can be tested without a backend. */
type ProbeExec = (args: string[], stdin?: string, timeoutMs?: number) => Promise<ExecOutput>;

/**
 * The argv used to detect thinking-flag support.
 *
 * It carries the *real* `--thinking adaptive` alongside a deliberately invalid
 * `--thinking-display` value, so one probe validates both flags the launch
 * command will pass. `--version` keeps it off the API path.
 */
export function thinkingDisplayProbeArgs(claudeCommand: string): string[] {
  return [
    claudeCommand,
    ...THINKING_MODE_ARGS,
    THINKING_DISPLAY_FLAG,
    THINKING_DISPLAY_PROBE_VALUE,
    "--version",
  ];
}

/**
 * Whether a probe result means the CLI understands both thinking flags.
 *
 * Unlike `--effort`, the thinking flags are hidden from `--help`, so the
 * helpText check used elsewhere would report "unsupported" on every CLI.
 * Commander validates a *known* option's argument before doing anything else
 * and exits non-zero naming the flag, so an argument-validation failure that
 * names `--thinking-display` is the signal that both flags parsed. A CLI that
 * has never heard of either option reports `unknown option` (and would name
 * `--thinking` first), and one that ignores unknown options on the `--version`
 * path exits 0; both are read as unsupported.
 */
export function thinkingDisplayProbeIndicatesSupport(probe: ExecOutput): boolean {
  const output = `${probe.stdout}\n${probe.stderr}`;
  return (
    probe.status !== 0
    && output.includes(THINKING_DISPLAY_FLAG)
    // A future CLI that rejects an unknown option here would also name the
    // flag; only an argument-validation failure means it is supported.
    && !output.toLowerCase().includes("unknown option")
  );
}

/**
 * Run the probe, failing closed. Any spawn-level failure, timeout or
 * unrecognised output launches Claude the way it was launched before the
 * thinking flags existed, which is always safe.
 */
export async function probeThinkingDisplaySupport(
  exec: ProbeExec,
  claudeCommand: string,
): Promise<boolean> {
  try {
    const probe = await exec(
      thinkingDisplayProbeArgs(claudeCommand),
      undefined,
      THINKING_DISPLAY_PROBE_TIMEOUT_MS,
    );
    return thinkingDisplayProbeIndicatesSupport(probe);
  } catch (error) {
    console.warn("[tmux] --thinking-display probe failed; launching without it", error);
    return false;
  }
}

class TmuxSession {
  readonly sessionId: string;
  readonly tmuxSession: string;
  readonly workspaceHookPaths: WorkspaceHookPaths;
  readonly sessionHookPaths: SessionHookPaths;
  readonly claudeHome: string;
  readonly workspace: string;
  readonly resumed: boolean;
  private readonly tmuxCommand = "tmux";
  private readonly claudeCommand: string;
  private readonly startedAtUnix: number;
  private pollLoopRunning = false;
  private stopRequested = false;
  private transcriptPath: string | undefined;
  /**
   * Task list derived from this session's transcript. The backend owns it so
   * the renderer never re-derives it, and so a tab that was not mounted while
   * tasks changed can rehydrate rather than replay.
   */
  private taskTracker = new TranscriptTaskTracker();
  private busy = false;
  private permissionMode = "bypassPermissions";
  private paneCache: { text: string; hash: string; capturedAt: number } | undefined;
  private paneCaptureInFlight: Promise<{ text: string; hash: string; capturedAt: number }> | undefined;
  private readonly inputMutex = new AsyncMutex();

  constructor(
    readonly environmentId: string,
    readonly tabId: string,
    readonly backend: TmuxBackend,
    runtimeRootPrefix: string,
    resumeSessionId?: string,
    claudeCommand?: string,
  ) {
    this.resumed = resumeSessionId !== undefined;
    this.sessionId = resumeSessionId ?? randomUUID();
    this.tmuxSession = tmuxSessionName(environmentId, tabId);
    this.workspace = backend.kind === "local" ? backend.cwd ?? process.cwd() : "/workspace";
    this.claudeHome = backend.kind === "local" ? localClaudeHome() : "/home/node/.claude";
    this.workspaceHookPaths = workspaceHookPaths(
      path.join(runtimeRootPrefix, environmentId),
      this.workspace,
    );
    this.sessionHookPaths = sessionHookPaths(this.workspaceHookPaths, this.sessionId);
    this.claudeCommand = claudeCommand ?? "claude";
    this.startedAtUnix = Math.max(0, Math.floor(Date.now() / 1000) - 5);
  }

  status(running: boolean): TmuxStatus {
    return {
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      tmux_session: this.tmuxSession,
      running,
      transcript_path: this.transcriptPath ?? null,
      resumed: this.resumed,
      busy: this.busy,
      permission_mode: this.permissionMode,
    };
  }

  async discoverTranscriptPath(): Promise<string | undefined> {
    if (this.transcriptPath) return this.transcriptPath;
    const found = await findTranscriptPath(
      this.backend,
      this.claudeHome,
      this.workspace,
      this.sessionId,
      this.startedAtUnix,
    );
    if (found) this.transcriptPath = found;
    return found;
  }

  async transcriptLines(): Promise<unknown[]> {
    const transcriptPath = await this.discoverTranscriptPath();
    if (!transcriptPath) return [];
    const content = await this.backend.readFile(transcriptPath) ?? "";

    // Replay task tools from scratch: the file is authoritative for everything
    // written so far, and each historical line must carry the list as it stood
    // *then*, not as it stands now. Overlapping with the live tail is safe —
    // every operation the registry models is idempotent.
    const tracker = new TranscriptTaskTracker();
    const lines: unknown[] = [];
    for (const raw of content.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const line = JSON.parse(trimmed);
        lines.push(this.withTaskSnapshot(line, tracker));
        const permissionMode = permissionModeFromTranscriptLine(line);
        if (permissionMode) this.permissionMode = permissionMode;
      } catch {
        // Continue reading later lines.
      }
    }
    this.taskTracker = tracker;
    return lines;
  }

  /** The session's task list, for callers that want it without the transcript. */
  taskList(): TaskListSnapshot {
    return this.taskTracker.snapshot();
  }

  /**
   * Attach the resulting task list to a line that completed a task tool call,
   * keyed by `tool_use_id` so it reaches that tool's part and no other, and
   * leaving every other line untouched.
   */
  private withTaskSnapshot(line: unknown, tracker: TranscriptTaskTracker): unknown {
    const taskSnapshots = tracker.applyLine(line);
    if (!taskSnapshots || typeof line !== "object" || line === null) return line;
    return { ...(line as Record<string, unknown>), taskSnapshots };
  }

  pendingHooks(): Promise<PendingHookEvent[]> {
    return listPendingBlocking(this.backend, this.sessionHookPaths);
  }

  async startAfterHooksInstalled(
    context: CommandContext,
    initialPrompt: string | undefined,
    model: string | undefined,
    effort: string | undefined,
  ): Promise<void> {
    await ensureSessionDirs(this.backend, this.sessionHookPaths);

    const tmuxProbe = await this.backend.exec(["which", this.tmuxCommand]);
    if (tmuxProbe.status !== 0 || !tmuxProbe.stdout.trim()) {
      throw new Error("tmux is not installed in this environment. For containers, rebuild the base image; for local, install tmux on the host.");
    }

    const claudeCommand = await this.resolveClaudeCommand();
    const claudeProbe = await this.backend.exec([claudeCommand, "--version"]);
    if (claudeProbe.status !== 0) throw new Error("claude CLI not found in this environment.");

    const help = await this.backend.exec([claudeCommand, "--help"]);
    const helpText = `${help.stdout}\n${help.stderr}`;
    if (!helpText.includes("--session-id")) {
      throw new Error("Installed claude CLI does not support --session-id. Upgrade to a newer Claude Code version, or switch to terminal/native mode.");
    }
    if (this.resumed && !helpText.includes("--resume")) {
      throw new Error("Installed claude CLI does not support --resume. Upgrade to a newer Claude Code version to use the resume-session feature.");
    }

    const alive = await this.tmuxAlive();
    const launchedNew = !alive;
    if (launchedNew) {
      let agentMcpConfigPath: string | undefined;
      try {
        if (context.agentTools && helpText.includes("--mcp-config")) {
          const environment = await context.storage.getEnvironment(this.environmentId);
          if (environment) {
            const connection = context.agentTools.connection(
              environment.id,
              environment.projectId,
              agentToolConnectionTarget(this.backend.kind),
            );
            agentMcpConfigPath = `${this.workspaceHookPaths.root}/agent-mcp.json`;
            await this.backend.writePrivateFile(
              agentMcpConfigPath,
              agentMcpConfigJson(connection),
            );
          }
        }
        const thinkingDisplay = await probeThinkingDisplaySupport(
          (args, stdin, timeoutMs) => this.backend.exec(args, stdin, timeoutMs),
          claudeCommand,
        );
        const claudeCmd = this.claudeLaunchCommand(
          claudeCommand,
          helpText,
          model,
          effort,
          thinkingDisplay,
          agentMcpConfigPath,
        );
        const runtimePrefix = this.backend.kind === "container"
          ? ". /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true; "
            + "orkestrator_source_runtime_env 2>/dev/null || true; "
          : "";
        const wrapped =
          `${runtimePrefix}${claudeCmd}; echo '[claude exited]'; exec bash`;
        const out = await this.backend.exec([
          this.tmuxCommand,
          "new-session",
          "-d",
          "-s",
          this.tmuxSession,
          "-x",
          "200",
          "-y",
          "50",
          "sh",
          "-c",
          wrapped,
        ]);
        if (out.status !== 0) throw new Error(`tmux new-session failed: ${out.stderr}`);
      } catch (error) {
        if (agentMcpConfigPath) {
          await this.backend.removeFile(agentMcpConfigPath).catch(() => undefined);
        }
        throw error;
      }
    }

    this.spawnPollLoop(context);
    context.emit(CLAUDE_TMUX_EVENT, {
      kind: "started",
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      resumed: this.resumed,
    });

    // A second client attaching to this stable tab must not submit the
    // bootstrap again. The backend call that actually launched tmux owns it.
    if (launchedNew && initialPrompt?.trim()) {
      void this.sendInitialPromptWhenReady(initialPrompt, launchedNew)
        .then(() => {
          context.emit(CLAUDE_TMUX_EVENT, {
            kind: "initial-prompt-sent",
            tab_id: this.tabId,
            environment_id: this.environmentId,
            session_id: this.sessionId,
          });
        })
        .catch((error) => {
          context.emit(CLAUDE_TMUX_EVENT, {
            kind: "warning",
            tab_id: this.tabId,
            environment_id: this.environmentId,
            message: `Failed to send initial prompt: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
    }
  }

  private async resolveClaudeCommand(): Promise<string> {
    if (this.claudeCommand.includes("/")) {
      const probe = await this.backend.exec(["test", "-x", this.claudeCommand]);
      if (probe.status === 0) return this.claudeCommand;
    }
    const which = await this.backend.exec(["which", "claude"]);
    const resolved = which.stdout.trim().split("\n")[0];
    return which.status === 0 && resolved ? resolved : this.claudeCommand;
  }

  private claudeLaunchCommand(
    claudeCommand: string,
    helpText: string,
    model: string | undefined,
    effort: string | undefined,
    supportsThinkingDisplay: boolean,
    agentMcpConfigPath?: string,
  ): string {
    let command = shellArg(claudeCommand);
    if (model?.trim()) command += ` --model ${shellArg(model)}`;
    if (effort?.trim()) {
      if (helpText.includes("--effort")) {
        command += ` --effort ${shellArg(effort)}`;
      } else {
        console.warn("[tmux] claude CLI does not support --effort; launching without it");
      }
    }
    // Opus 4.7 and newer default adaptive thinking display to "omitted", which
    // writes thinking blocks to the transcript with an empty `thinking` string
    // (signature only). Native Mode opts back into "summarized" through the
    // Agent SDK; do the same here so the tmux chat tab renders reasoning too.
    if (supportsThinkingDisplay) {
      command += ` ${THINKING_MODE_ARGS.join(" ")} ${THINKING_DISPLAY_FLAG} ${THINKING_DISPLAY_VALUE}`;
    }
    if (agentMcpConfigPath) {
      command += ` --mcp-config ${shellArg(agentMcpConfigPath)}`;
    }
    command += " --dangerously-skip-permissions";
    command += this.resumed ? ` --resume ${this.sessionId}` : ` --session-id ${this.sessionId}`;
    return command;
  }

  private async sendInitialPromptWhenReady(prompt: string, launchedNew: boolean): Promise<void> {
    if (launchedNew) await delay(800);
    await this.waitForTuiInputReady();
    await this.submit(prompt);
    // Hooks fire asynchronously; set busy immediately so status() is accurate before the hook lands.
    this.busy = true;
  }

  private async waitForTuiInputReady(): Promise<void> {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      if (!await this.tmuxAlive().catch(() => false)) {
        throw new Error("tmux session stopped before Claude was ready");
      }
      const snapshot = await this.capturePane().catch(() => "");
      if (paneHasClaudeExited(snapshot)) throw new Error("Claude exited before the initial prompt was sent");
      if (!paneHasSelectionPrompt(snapshot)) return;
      await delay(500);
    }
    throw new Error("timed out waiting for Claude to leave its startup prompt");
  }

  private spawnPollLoop(context: CommandContext): void {
    if (this.pollLoopRunning) return;
    this.pollLoopRunning = true;
    this.stopRequested = false;
    const emittedBlockingIds = new Set<string>();
    let tail: TranscriptTail | undefined;

    let tick = 0;

    void (async () => {
      try {
        while (!this.stopRequested) {
          await delay(POLL_INTERVAL_MS);
          if (this.stopRequested) break;
          tick += 1;

          // Discovered before the snapshot so the same round trip can carry the
          // transcript size.
          if (!tail) {
            try {
              const transcriptPath = await this.discoverTranscriptPath();
              if (transcriptPath) tail = new TranscriptTail(transcriptPath);
            } catch (error) {
              console.warn("[tmux] transcript discovery failed", error);
            }
          }

          let snapshot: TmuxPollSnapshot | undefined;
          try {
            snapshot = await this.backend.pollSnapshot(this.sessionHookPaths, tail?.filePath);
          } catch (error) {
            console.warn("[tmux] poll snapshot failed", error);
          }

          if (snapshot) {
            try {
              const events = await drainPending(
                this.backend,
                this.sessionHookPaths,
                snapshot.pending,
                emittedBlockingIds,
              );
              for (const event of events) this.emitHook(context, event);
            } catch (error) {
              console.warn("[tmux] drainPending failed", error);
            }

            try {
              const timeouts = await drainTimeouts(this.backend, this.sessionHookPaths, snapshot.timeouts);
              for (const timeout of timeouts) {
                emittedBlockingIds.delete(timeout.id);
                context.emit(CLAUDE_TMUX_EVENT, {
                  kind: "hook-timed-out",
                  tab_id: this.tabId,
                  environment_id: this.environmentId,
                  session_id: this.sessionId,
                  event_kind: timeout.kind,
                  event_id: timeout.id,
                });
              }
            } catch (error) {
              console.warn("[tmux] drainTimeouts failed", error);
            }

            if (tail) {
              try {
                const lines = await tail.readNew(this.backend, snapshot.transcriptSize);
                for (const line of lines) {
                  const permissionMode = permissionModeFromTranscriptLine(line);
                  if (permissionMode) this.setPermissionMode(permissionMode, context);
                  context.emit(CLAUDE_TMUX_EVENT, {
                    kind: "transcript-line",
                    tab_id: this.tabId,
                    environment_id: this.environmentId,
                    session_id: this.sessionId,
                    line: this.withTaskSnapshot(line, this.taskTracker),
                  });
                }
              } catch (error) {
                console.warn("[tmux] transcript tail failed", error);
              }
            }
          }

          // Liveness is a whole extra process spawn (a `docker exec` in
          // container mode) and a session that ends stays ended, so it is
          // checked on a slower cadence than the hook and transcript reads.
          if (tick % LIVENESS_CHECK_EVERY_TICKS !== 0) continue;
          if (!await this.tmuxAlive().catch(() => false)) {
            context.emit(CLAUDE_TMUX_EVENT, {
              kind: "stopped",
              tab_id: this.tabId,
              environment_id: this.environmentId,
            });
            break;
          }
        }
      } finally {
        this.pollLoopRunning = false;
      }
    })();
  }

  private emitHook(context: CommandContext, event: PendingHookEvent): void {
    this.updateBusyFromHookKind(event.kind);
    context.emit(CLAUDE_TMUX_EVENT, {
      kind: "hook",
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      event_id: event.id,
      event_kind: event.kind,
      payload: event.payload,
    });
  }

  private updateBusyFromHookKind(kind: string): void {
    if (kind === "UserPromptSubmit") this.busy = true;
    if (kind === "Stop") this.busy = false;
  }

  async tmuxAlive(): Promise<boolean> {
    const out = await this.backend.exec([this.tmuxCommand, "has-session", "-t", this.tmuxSession]);
    return out.status === 0;
  }

  private async sendTextUnlocked(text: string): Promise<void> {
    if (!text) return;
    const bufferName = `claude-tmux-input-${this.tmuxSession}`;
    const load = await this.backend.exec([this.tmuxCommand, "load-buffer", "-b", bufferName, "-"], text);
    if (load.status !== 0) throw new Error(load.stderr || "tmux load-buffer failed");
    const paste = await this.backend.exec([
      this.tmuxCommand,
      "paste-buffer",
      "-p",
      "-d",
      "-b",
      bufferName,
      "-t",
      this.tmuxSession,
    ]);
    if (paste.status !== 0) throw new Error(paste.stderr || "tmux paste-buffer failed");
  }

  async sendText(text: string): Promise<void> {
    await this.inputMutex.runExclusive(() => this.sendTextUnlocked(text));
  }

  private async sendLiteralUnlocked(text: string): Promise<void> {
    if (!text) return;
    const out = await this.backend.exec([this.tmuxCommand, "send-keys", "-t", this.tmuxSession, "-l", text]);
    if (out.status !== 0) throw new Error(out.stderr || "tmux send-keys failed");
  }

  async sendLiteral(text: string): Promise<void> {
    await this.inputMutex.runExclusive(() => this.sendLiteralUnlocked(text));
  }

  private async sendKeysUnlocked(keys: string[]): Promise<void> {
    const out = await this.backend.exec([this.tmuxCommand, "send-keys", "-t", this.tmuxSession, "--", ...keys]);
    if (out.status !== 0) throw new Error(out.stderr || "tmux send-keys failed");
  }

  async sendKeys(keys: string[]): Promise<void> {
    await this.inputMutex.runExclusive(() => this.sendKeysUnlocked(keys));
  }

  private async submitUnlocked(text: string): Promise<void> {
    if (text) {
      await this.sendTextUnlocked(text);
      await delay(250);
    }
    await this.sendKeysUnlocked(["Enter"]);
  }

  async submit(text: string): Promise<void> {
    await this.inputMutex.runExclusive(async () => {
      await this.submitUnlocked(text);
      if (text.trim()) {
        // Hooks arrive asynchronously. Mark a submitted user turn busy before
        // releasing the input lock so a queued mode switch cannot run in the
        // gap between Enter and the UserPromptSubmit hook.
        this.busy = true;
      }
    });
  }

  async switchModel(model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed) throw new Error("model id cannot be empty");
    await this.inputMutex.runExclusive(async () => {
      await this.submitUnlocked(`/model ${trimmed}`);
      await this.waitForCommandIdle();
    });
  }

  async switchEffort(effort: string): Promise<void> {
    const trimmed = effort.trim();
    if (!trimmed) throw new Error("effort level cannot be empty");
    await this.inputMutex.runExclusive(async () => {
      await this.submitUnlocked(`/effort ${trimmed}`);
      await this.waitForCommandIdle();
    });
  }

  async switchPlanMode(planMode: boolean, context: CommandContext): Promise<string> {
    return await this.inputMutex.runExclusive(async () => {
      if (this.busy) throw new Error("Cannot switch Claude mode while a turn is running");
      const targetMode = planMode ? "plan" : "bypassPermissions";
      let observedMode = await this.capturePanePermissionMode();
      if (observedMode) this.setPermissionMode(observedMode, context);
      if (observedMode === targetMode) return targetMode;

      // `/plan` enters Plan Mode directly. This avoids cycling forward from
      // bypassPermissions into Auto Mode, which can open a first-use opt-in
      // prompt and leave the backend unable to complete the transition.
      if (observedMode !== "plan") {
        await this.submitUnlocked("/plan");
        observedMode = await this.waitForPanePermissionMode("plan");
        this.setPermissionMode(observedMode, context);
      }

      if (targetMode === "plan") return targetMode;

      // Bypass is the first optional mode after Plan in Claude's documented
      // Shift+Tab cycle because tmux sessions launch with bypass enabled.
      await this.sendKeysUnlocked(["BTab"]);
      observedMode = await this.waitForPanePermissionMode("bypassPermissions");
      this.setPermissionMode(observedMode, context);
      return targetMode;
    });
  }

  private async capturePanePermissionMode(): Promise<string | undefined> {
    const snapshot = await this.capturePane();
    if (paneHasClaudeExited(snapshot)) throw new Error("Claude exited before its mode could be changed");
    if (paneHasSelectionPrompt(snapshot)) {
      throw new Error("Finish the active Claude prompt before changing modes");
    }
    return permissionModeFromPane(snapshot);
  }

  private async waitForPanePermissionMode(targetMode: string): Promise<string> {
    const deadline = Date.now() + PERMISSION_MODE_SWITCH_TIMEOUT_MS;
    let lastObservedMode: string | undefined;
    while (Date.now() < deadline) {
      const observedMode = await this.capturePanePermissionMode();
      if (observedMode) {
        lastObservedMode = observedMode;
        if (observedMode === targetMode) return observedMode;
      }
      await delay(PERMISSION_MODE_POLL_MS);
    }
    const observed = lastObservedMode ? `; observed ${lastObservedMode}` : "";
    throw new Error(`Claude did not enter ${targetMode}${observed}`);
  }

  private setPermissionMode(permissionMode: string, context: CommandContext): void {
    if (permissionMode === this.permissionMode) return;
    this.permissionMode = permissionMode;
    context.emit(CLAUDE_TMUX_EVENT, {
      kind: "permission-mode-changed",
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      permission_mode: permissionMode,
    });
  }

  private async waitForCommandIdle(): Promise<void> {
    const started = Date.now();
    const deadline = started + COMMAND_IDLE_TIMEOUT_MS;
    const noHookDeadline = started + COMMAND_NO_HOOK_SETTLE_MS;
    let sawBusy = this.busy;
    while (Date.now() < deadline) {
      if (this.busy) {
        sawBusy = true;
      } else if (sawBusy) {
        await delay(COMMAND_AFTER_IDLE_SETTLE_MS);
        return;
      } else if (Date.now() >= noHookDeadline) {
        return;
      }
      await delay(50);
    }
    console.warn("[tmux] timed out waiting for Claude slash command to settle", this.tmuxSession);
  }

  async interrupt(): Promise<void> {
    await this.inputMutex.runExclusive(async () => {
      await this.sendKeysUnlocked(["Escape"]);
      this.busy = false;
    });
  }

  async writeInteractive(data: string): Promise<void> {
    await this.inputMutex.runExclusive(() => sendInteractiveData(
      data,
      (literal) => this.sendLiteralUnlocked(literal),
      (keys) => this.sendKeysUnlocked(keys),
    ));
  }

  async capturePane(options: { ansi?: boolean; joinWrapped?: boolean } = {}): Promise<string> {
    const args = [this.tmuxCommand, "capture-pane", "-t", this.tmuxSession, "-p"];
    if (options.ansi) args.push("-e");
    if (options.joinWrapped ?? true) args.push("-J");
    const out = await this.backend.exec(args);
    if (out.status !== 0) throw new Error(out.stderr || "tmux capture-pane failed");
    return out.stdout;
  }

  /**
   * The capture served to `claude_tmux_capture_pane`.
   *
   * Renderers poll this every 500-3000ms and several tabs can be watching one
   * session, so identical captures are coalesced inside a short window rather
   * than spawning `tmux capture-pane` per caller. A caller that remembers the
   * hash of what it already has gets an `unchanged` answer instead of the full
   * pane text; callers that pass nothing keep receiving the plain string.
   *
   * Deliberately not used by the internal capture paths: the mode-switch wait
   * loop polls at 100ms and must never see a cached pane.
   */
  async capturePaneForRequest(knownHash?: string): Promise<string | PaneCaptureResult> {
    const captured = await this.recentPaneCapture();
    if (knownHash === undefined) return captured.text;
    return knownHash === captured.hash
      ? { unchanged: true, hash: captured.hash }
      : { unchanged: false, hash: captured.hash, text: captured.text };
  }

  /**
   * The cached capture, or one shared spawn if it is stale. Concurrent callers
   * join the in-flight capture rather than each starting their own.
   */
  private async recentPaneCapture(): Promise<{ text: string; hash: string; capturedAt: number }> {
    const cached = this.paneCache;
    if (cached && Date.now() - cached.capturedAt <= CAPTURE_PANE_CACHE_MS) return cached;
    if (!this.paneCaptureInFlight) {
      this.paneCaptureInFlight = this.capturePane()
        .then((text) => {
          const entry = { text, hash: paneHash(text), capturedAt: Date.now() };
          this.paneCache = entry;
          return entry;
        })
        .finally(() => {
          this.paneCaptureInFlight = undefined;
        });
    }
    return await this.paneCaptureInFlight;
  }

  async resize(cols: number, rows: number): Promise<void> {
    const out = await this.backend.exec([
      this.tmuxCommand,
      "resize-window",
      "-t",
      this.tmuxSession,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
    if (out.status !== 0) throw new Error(out.stderr || "tmux resize-window failed");
  }

  async replyHook(kind: string, id: string, response: unknown): Promise<void> {
    await replyToHook(this.backend, this.sessionHookPaths, kind, id, response);
  }

  async answerPreToolUse(id: string, decision: string, reason?: string): Promise<void> {
    await this.replyHook("PreToolUse", id, preToolUseResponse(decision, reason));
  }

  async stop(): Promise<boolean> {
    this.stopRequested = true;
    const result = await this.backend
      .exec([this.tmuxCommand, "kill-session", "-t", this.tmuxSession])
      .catch(() => null);
    await this.backend.removeDir(this.sessionHookPaths.sessionDir).catch(() => undefined);
    if (!result) return false;
    if (result.status === 0) return true;
    return isMissingTmuxSessionError(result.stderr);
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function paneHasSelectionPrompt(snapshot: string): boolean {
  const plain = stripAnsi(snapshot);
  const lower = plain.toLowerCase();
  if (!lower.includes("esc to cancel") || !lower.includes("enter to")) return false;
  return plain.split("\n").some((line) => {
    const trimmed = line.trimStart().replace(/^[>›❯▸➜→]\s*/, "");
    const match = /^(\d+)\. /.exec(trimmed);
    return match !== null;
  });
}

function paneHasClaudeExited(snapshot: string): boolean {
  return stripAnsi(snapshot).includes("[claude exited]");
}

class AsyncMutex {
  private chain = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.chain;
    let release: () => void = () => undefined;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

class TmuxSessionManager {
  private readonly sessions = new Map<string, TmuxSession>();
  private readonly installLocks = new Map<string, AsyncMutex>();

  private key(environmentId: string, tabId: string): string {
    return `${environmentId}\u001f${tabId}`;
  }

  get(environmentId: string, tabId: string): TmuxSession | undefined {
    return this.sessions.get(this.key(environmentId, tabId));
  }

  insert(environmentId: string, tabId: string, session: TmuxSession): void {
    this.sessions.set(this.key(environmentId, tabId), session);
  }

  remove(environmentId: string, tabId: string): TmuxSession | undefined {
    const key = this.key(environmentId, tabId);
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    return session;
  }

  /** Drops and returns every session of an environment. Used by teardown. */
  removeEnvironment(environmentId: string): TmuxSession[] {
    const removed: TmuxSession[] = [];
    for (const [key, session] of this.sessions) {
      if (session.environmentId !== environmentId) continue;
      this.sessions.delete(key);
      removed.push(session);
    }
    // The install lock is deliberately kept. Teardown runs *inside* it, so
    // dropping it here would hand a concurrent start a fresh, uncontended lock
    // and let it reinstall hooks under a directory being removed.
    return removed;
  }

  sessionsInEnvironment(environmentId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.environmentId === environmentId) count += 1;
    }
    return count;
  }

  installLock(environmentId: string): AsyncMutex {
    let mutex = this.installLocks.get(environmentId);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.installLocks.set(environmentId, mutex);
    }
    return mutex;
  }
}

const tmuxManager = new TmuxSessionManager();

function workspaceAndClaudeHome(backend: TmuxBackend): { workspace: string; claudeHome: string } {
  return {
    workspace: backend.kind === "local" ? backend.cwd ?? process.cwd() : "/workspace",
    claudeHome: backend.kind === "local" ? localClaudeHome() : "/home/node/.claude",
  };
}

async function resolveBackend(environmentId: string, context: CommandContext): Promise<TmuxBackend> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`environment ${environmentId} not found`);
  if (environment.environmentType === "local") {
    if (!environment.worktreePath) throw new Error("local environment has no worktree path");
    return TmuxBackend.local(environment.worktreePath);
  }
  if (!environment.containerId) throw new Error("container environment has no container id");
  return TmuxBackend.container(environment.containerId);
}

function resolveBundledClaudePath(context: CommandContext): string | undefined {
  const candidates = [
    ...(context.toolchainBinDir ? [path.join(context.toolchainBinDir, "claude")] : []),
    path.join(context.resourceRoot, "bin", "claude"),
    path.join(context.appRoot, "binaries", "claude"),
    path.join(context.appRoot, "bin", "claude"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function resolvePinnedClaudeCommand(context: CommandContext, backend: TmuxBackend): string | undefined {
  return backend.kind === "container" ? undefined : resolveBundledClaudePath(context);
}

async function getOrCreateSession(
  context: CommandContext,
  environmentId: string,
  tabId: string,
  resumeSessionId: string | undefined,
): Promise<TmuxSession> {
  const existing = tmuxManager.get(environmentId, tabId);
  if (existing) return existing;

  const backend = await resolveBackend(environmentId, context);
  const session = new TmuxSession(
    environmentId,
    tabId,
    backend,
    runtimeRootPrefixForContext(context),
    resumeSessionId,
    resolvePinnedClaudeCommand(context, backend),
  );
  tmuxManager.insert(environmentId, tabId, session);
  return session;
}

async function killOrphanSession(context: CommandContext, environmentId: string, tabId: string): Promise<void> {
  try {
    const backend = await resolveBackend(environmentId, context);
    await backend.exec(["tmux", "kill-session", "-t", tmuxSessionName(environmentId, tabId)]).catch(() => undefined);
  } catch (error) {
    console.debug("[tmux] skipping orphan kill", error);
  }
}

/**
 * Kills every tmux session that belongs to `environmentId`, including ones this
 * process never registered — a backend restart empties `tmuxManager` while the
 * tmux server keeps running the sessions it started.
 *
 * A tmux server with no sessions exits non-zero from `list-sessions`, which is
 * the ordinary "nothing to do" case rather than a failure.
 */
async function killEnvironmentTmuxSessions(
  backend: TmuxBackend,
  environmentId: string,
  survivingEnvironmentIds: readonly string[],
): Promise<{ killed: string[]; complete: boolean }> {
  const listed = await backend
    .exec(["tmux", "list-sessions", "-F", "#{session_name}"])
    .catch(() => null);
  if (!listed) return { killed: [], complete: false };
  if (listed.status !== 0) {
    const noServer =
      /no server running/i.test(listed.stderr)
      || /failed to connect to server/i.test(listed.stderr)
      || /no sessions/i.test(listed.stderr);
    return { killed: [], complete: noServer };
  }
  const targets = selectReapableTmuxSessions({
    names: parseTmuxSessionNames(listed.stdout),
    environmentId,
    survivingEnvironmentIds,
  });
  const killed: string[] = [];
  let complete = true;
  for (const name of targets) {
    const result = await backend
      .exec(["tmux", "kill-session", "-t", name])
      .catch((error) =>
        isMissingTmuxSessionError(error)
          ? { status: 1, stdout: "", stderr: String(error) }
          : null
      );
    if (result?.status === 0) {
      killed.push(name);
    } else if (result && isMissingTmuxSessionError(result.stderr)) {
      // The one-time session listing raced a normal exit. The desired state is
      // already reached, so retaining the runtime root would create a
      // permanent retry loop.
      continue;
    } else {
      complete = false;
    }
  }
  return { killed, complete };
}

/**
 * Tears down every claude-tmux artefact an environment owns, for the deletion
 * path.
 *
 * Deleting an environment used to leave three things behind: the tmux sessions
 * themselves (a tmux server outlives the backend, so they ran forever), the
 * runtime root under `RUNTIME_ROOT_PREFIX`, and — worst — the user's own
 * `.claude/settings.local.json`, which tmux mode overwrites and only restores
 * from its backup on `claude_tmux_stop`. Deleting an environment while a tmux
 * tab was open therefore left the hook block installed in a settings file that
 * outlives the worktree (the local `.claude` directory of a repo checkout).
 *
 * Every step is best-effort and independent: this runs inside a deletion that
 * must complete, so a missing container or an unreachable tmux server must not
 * abort the removal of anything else.
 *
 * Ordering matters at the call site — this needs the container to still exist
 * and the worktree to still be on disk, so it runs before either is removed.
 */
export async function cleanupEnvironmentTmux(
  environmentId: string,
  context: CommandContext,
): Promise<void> {
  await tmuxManager.installLock(environmentId).runExclusive(async () => {
    detachInteractiveTerminalsForEnvironment(environmentId);
    const environment = await context.storage.getEnvironment(environmentId);
    if (
      environment?.environmentType === "containerized"
      && environment.status === "stopped"
    ) {
      // Nothing can be restored from inside a stopped container without
      // starting it again. Drop process-local ownership; docker rm below is
      // the authoritative cleanup for the container filesystem and sessions.
      tmuxManager.removeEnvironment(environmentId);
      return;
    }
    let cleanupComplete = true;
    for (const session of tmuxManager.removeEnvironment(environmentId)) {
      const stopped = await session.stop().catch((error) => {
        console.warn("[tmux] session stop failed during environment cleanup", error);
        return false;
      });
      if (!stopped) cleanupComplete = false;
    }

    let backend: TmuxBackend;
    try {
      backend = await resolveBackend(environmentId, context);
    } catch (error) {
      // No container id, or a local environment with no worktree: there is
      // nothing left to exec into. Dropping the in-memory sessions above is
      // the part this process still owns.
      console.debug("[tmux] skipping environment tmux cleanup", error);
      return;
    }

    let survivingEnvironmentIds: string[];
    try {
      survivingEnvironmentIds = (await context.storage.loadEnvironments())
        .map((environment) => environment.id);
    } catch (error) {
      cleanupComplete = false;
      survivingEnvironmentIds = [];
      console.warn("[tmux] failed to load environments during tmux cleanup", error);
    }

    if (cleanupComplete) {
      const result = await killEnvironmentTmuxSessions(
        backend,
        environmentId,
        survivingEnvironmentIds,
      ).catch((error) => {
        cleanupComplete = false;
        console.warn("[tmux] failed to kill environment tmux sessions", error);
        return { killed: [], complete: false };
      });
      cleanupComplete = cleanupComplete && result.complete;
    }

    const { workspace } = workspaceAndClaudeHome(backend);
    const hookPaths = workspaceHookPaths(
      path.join(runtimeRootPrefixForContext(context), environmentId),
      workspace,
    );
    // Restore the user's settings even when tmux cleanup is incomplete, but
    // retain the runtime root and its backup as durable retry attribution.
    await restoreWorkspaceHooks(backend, hookPaths).catch((error) => {
      cleanupComplete = false;
      console.warn("[tmux] uninstallWorkspaceHooks failed during environment cleanup", error);
    });
    if (cleanupComplete) {
      await backend.removeFile(hookPaths.claudeSettingsBackup).catch(() => undefined);
      await backend.removeDir(hookPaths.root).catch(() => undefined);
    } else {
      throw new Error(`claude-tmux cleanup incomplete for environment ${environmentId}`);
    }
  });
}

/** Cadence while the pane is producing output — what the user's typing feels like. */
export const INTERACTIVE_SNAPSHOT_MIN_MS = 250;
/** Cadence a pane backs off to while nothing at all changes. */
export const INTERACTIVE_SNAPSHOT_MAX_MS = 1_000;

type InteractiveTerminalSession = {
  id: string;
  tmux: TmuxSession;
  timer?: unknown;
  lastSnapshot?: string;
  cols: number;
  rows: number;
  /** Current gap between captures; doubles while the pane is static. */
  intervalMs: number;
  /** When the armed timer is due, so a reschedule can tell sooner from later. */
  nextCaptureAt?: number;
  context?: CommandContext;
};

export type InteractiveTmuxTerminalManagerOptions = {
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
};

export class InteractiveTmuxTerminalManager {
  private readonly terminals = new Map<string, InteractiveTerminalSession>();
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelTimeout: (timer: unknown) => void;

  constructor(options: InteractiveTmuxTerminalManagerOptions = {}) {
    this.scheduleTimeout = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimeout = options.cancel ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  create(tmux: TmuxSession, cols: number, rows: number): string {
    const id = `tmux:${tmux.environmentId}:${tmux.tabId}:${randomUUID()}`;
    this.terminals.set(id, { id, tmux, cols, rows, intervalMs: INTERACTIVE_SNAPSHOT_MIN_MS });
    return id;
  }

  async start(id: string, context: CommandContext): Promise<void> {
    const terminal = this.require(id);
    terminal.context = context;
    await terminal.tmux.resize(terminal.cols, terminal.rows);
    await this.emitSnapshot(terminal, context, true);
    this.schedule(terminal);
  }

  async write(id: string, data: string): Promise<void> {
    const terminal = this.require(id);
    // Input is about to produce output, so undo any backoff before it lands.
    terminal.intervalMs = INTERACTIVE_SNAPSHOT_MIN_MS;
    if (terminal.timer !== undefined) this.schedule(terminal);
    await terminal.tmux.writeInteractive(data);
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const terminal = this.require(id);
    terminal.cols = cols;
    terminal.rows = rows;
    await terminal.tmux.resize(cols, rows);
  }

  detach(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    if (terminal.timer !== undefined) this.cancelTimeout(terminal.timer);
    terminal.timer = undefined;
    this.terminals.delete(id);
  }

  detachEnvironment(environmentId: string): void {
    for (const [id, terminal] of this.terminals) {
      if (terminal.tmux.environmentId !== environmentId) continue;
      if (terminal.timer !== undefined) this.cancelTimeout(terminal.timer);
      terminal.timer = undefined;
      this.terminals.delete(id);
    }
  }

  private require(id: string): InteractiveTerminalSession {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error("tmux interactive terminal session not found");
    return terminal;
  }

  /**
   * Self-rescheduling rather than a fixed interval, so a pane nobody is looking
   * at costs one `tmux capture-pane` per second instead of four — and so a
   * capture that runs long cannot stack up behind itself.
   *
   * Only ever pulls the next capture *forward*. `write` reschedules on every
   * keystroke, so an unconditional re-arm let anything faster than one
   * character per {@link INTERACTIVE_SNAPSHOT_MIN_MS} — ordinary typing, or key
   * auto-repeat — push the deadline out for as long as the user kept typing,
   * and the pane appeared frozen exactly while they were using it.
   */
  private schedule(terminal: InteractiveTerminalSession): void {
    const dueAt = Date.now() + terminal.intervalMs;
    if (terminal.timer !== undefined) {
      if (terminal.nextCaptureAt !== undefined && terminal.nextCaptureAt <= dueAt) return;
      this.cancelTimeout(terminal.timer);
    }
    terminal.nextCaptureAt = dueAt;
    terminal.timer = this.scheduleTimeout(() => {
      terminal.nextCaptureAt = undefined;
      const context = terminal.context;
      if (!context || this.terminals.get(terminal.id) !== terminal) return;
      void this.emitSnapshot(terminal, context, false)
        .catch((error) => {
          console.debug("[tmux] interactive snapshot failed", error);
        })
        .finally(() => {
          if (this.terminals.get(terminal.id) === terminal) this.schedule(terminal);
        });
    }, terminal.intervalMs);
  }

  private async emitSnapshot(terminal: InteractiveTerminalSession, context: CommandContext, force: boolean): Promise<void> {
    const snapshot = await terminal.tmux.capturePane({ ansi: true, joinWrapped: false });
    // Detach can happen while capture-pane is in flight. Never emit the late
    // snapshot or revive its timer after the terminal has been removed.
    if (this.terminals.get(terminal.id) !== terminal) return;
    if (!force && snapshot === terminal.lastSnapshot) {
      terminal.intervalMs = Math.min(INTERACTIVE_SNAPSHOT_MAX_MS, terminal.intervalMs * 2);
      return;
    }
    // Any change snaps the cadence back: output usually arrives in bursts.
    terminal.intervalMs = INTERACTIVE_SNAPSHOT_MIN_MS;
    terminal.lastSnapshot = snapshot;
    context.emit(`terminal-output-${terminal.id}`, bytesPayload(`\x1b[H\x1b[2J${snapshot.replaceAll("\n", "\r\n")}`));
  }
}

const interactiveTerminals = new InteractiveTmuxTerminalManager();

function detachInteractiveTerminalsForEnvironment(environmentId: string): void {
  interactiveTerminals.detachEnvironment(environmentId);
}

/** A list, not a Map: it is scanned per character, so it must not be rebuilt per character. */
const INTERACTIVE_KEY_SEQUENCES: ReadonlyArray<readonly [string, string[]]> = [
  ["\x1b[A", ["Up"]],
  ["\x1b[B", ["Down"]],
  ["\x1b[C", ["Right"]],
  ["\x1b[D", ["Left"]],
  ["\x1b[3~", ["Delete"]],
  ["\x1b[H", ["Home"]],
  ["\x1b[1~", ["Home"]],
  ["\x1b[F", ["End"]],
  ["\x1b[4~", ["End"]],
];

async function sendInteractiveData(
  data: string,
  sendLiteral: (literal: string) => Promise<void>,
  sendKeys: (keys: string[]) => Promise<void>,
): Promise<void> {
  let index = 0;
  let literal = "";

  const flushLiteral = async () => {
    if (!literal) return;
    await sendLiteral(literal);
    literal = "";
  };

  while (index < data.length) {
    const matched = INTERACTIVE_KEY_SEQUENCES.find(([sequence]) => data.startsWith(sequence, index));
    if (matched) {
      await flushLiteral();
      await sendKeys(matched[1]);
      index += matched[0].length;
      continue;
    }

    const char = data[index]!;
    switch (char) {
      case "\r":
      case "\n":
        await flushLiteral();
        await sendKeys(["Enter"]);
        break;
      case "\x7f":
      case "\b":
        await flushLiteral();
        await sendKeys(["BSpace"]);
        break;
      case "\t":
        await flushLiteral();
        await sendKeys(["Tab"]);
        break;
      case "\x03":
        await flushLiteral();
        await sendKeys(["C-c"]);
        break;
      case "\x04":
        await flushLiteral();
        await sendKeys(["C-d"]);
        break;
      case "\x1b":
        await flushLiteral();
        await sendKeys(["Escape"]);
        break;
      default:
        literal += char;
        break;
    }
    index += 1;
  }
  await flushLiteral();
}

type ClaudeStatePoll = {
  timer: unknown;
  lastState: string;
  subscribers: Set<string>;
  active: boolean;
  pollRequested: boolean;
  inFlight?: Promise<void>;
  context: CommandContext;
  /** When storage last confirmed the environment still owns a running container. */
  lastRetirementCheckAt?: number;
};

export type ClaudeStatePollManagerOptions = {
  readState?: (containerId: string) => Promise<string>;
  schedule?: (callback: () => void) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => string;
  nowMs?: () => number;
};

/** How long the agent has to answer before a state read is abandoned. */
export const CLAUDE_STATE_READ_TIMEOUT_MS = 5_000;
/** Gap between state reads. Each tick coalesces behind any in-flight read. */
export const CLAUDE_STATE_POLL_INTERVAL_MS = 1_000;
/**
 * How often a poll that observed *no* change still asks storage whether its
 * environment is still running. A changed state consults storage immediately;
 * this bounds how long a poll can outlive the environment it belongs to, for
 * the case where nothing else retired it.
 */
export const CLAUDE_STATE_RETIREMENT_CHECK_MS = 15_000;

/**
 * The command that reads the agent's self-reported state out of a container.
 * Extracted so the argv is assertable without a Docker daemon — a typo here
 * degrades to "always idle" rather than to a visible failure.
 */
export function claudeStateReadCommand(containerId: string): {
  command: string;
  args: string[];
  options: { timeoutMs: number };
} {
  return {
    command: "docker",
    args: ["exec", containerId, "cat", "/tmp/.claude-state"],
    options: { timeoutMs: CLAUDE_STATE_READ_TIMEOUT_MS },
  };
}

export class ClaudeStatePollManager {
  private readonly polls = new Map<string, ClaudeStatePoll>();
  private readonly readState: (containerId: string) => Promise<string>;
  private readonly schedule: (callback: () => void) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private readonly now: () => string;
  private readonly nowMs: () => number;

  constructor(options: ClaudeStatePollManagerOptions = {}) {
    this.readState = options.readState ?? (async (containerId) => {
      const { command, args, options: runOptions } =
        claudeStateReadCommand(containerId);
      return (await runCommand(command, args, runOptions)).stdout.trim();
    });
    this.schedule = options.schedule
      ?? ((callback) => setInterval(callback, CLAUDE_STATE_POLL_INTERVAL_MS));
    this.cancel = options.cancel ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  start(
    containerId: string,
    context: CommandContext,
    subscriptionId = "legacy",
  ): void {
    const existing = this.polls.get(containerId);
    if (existing) {
      existing.subscribers.add(subscriptionId);
      // Adopt the newest caller's context. The first registrant's may belong to
      // a connection that has since gone away; a later one is at least as live.
      existing.context = context;
      return;
    }
    const poll: ClaudeStatePoll = {
      timer: undefined,
      lastState: "",
      subscribers: new Set([subscriptionId]),
      active: true,
      pollRequested: false,
      context,
    };
    poll.timer = this.schedule(() => this.requestPoll(containerId, poll));
    this.polls.set(containerId, poll);
    this.requestPoll(containerId, poll);
  }

  async stop(containerId: string, subscriptionId = "legacy"): Promise<void> {
    const poll = this.polls.get(containerId);
    if (!poll) return;
    poll.subscribers.delete(subscriptionId);
    // Polling is backend-owned once started so activity remains authoritative
    // while every renderer is inactive. A release only removes that client's
    // lease, and another client's lease still keeps it alive.
    if (poll.subscribers.size > 0) return;
    // A running environment keeps polling even with no lease at all: the whole
    // point is that activity is detected while no renderer is mounted.
    // `poll()` retires it when the environment leaves `running`.
    let environment: Environment | undefined;
    try {
      environment = (await poll.context.storage.loadEnvironments()).find(
        (candidate) => candidate.containerId === containerId,
      );
    } catch {
      // Storage is unreadable, so whether this container is still running is
      // unknown. Keeping the poll costs one read per second; retiring one that
      // is still live would silently stop detecting activity.
      return;
    }
    if (environment?.status === "running") return;
    this.deactivate(containerId, poll);
  }

  /**
   * Retire a poll immediately, regardless of leases or environment status.
   * Used when the container itself is going away, so the next `docker exec`
   * would be against something that no longer exists.
   */
  shutdown(containerId: string): void {
    const poll = this.polls.get(containerId);
    if (poll) this.deactivate(containerId, poll);
  }

  private deactivate(containerId: string, poll: ClaudeStatePoll): void {
    if (this.polls.get(containerId) !== poll) return;
    poll.active = false;
    this.cancel(poll.timer);
    this.polls.delete(containerId);
  }

  private requestPoll(containerId: string, poll: ClaudeStatePoll): void {
    if (!poll.active || this.polls.get(containerId) !== poll) return;
    if (poll.inFlight) {
      poll.pollRequested = true;
      return;
    }
    poll.inFlight = this.poll(containerId, poll)
      .catch(() => undefined)
      .finally(() => {
        poll.inFlight = undefined;
        if (
          poll.active
          && this.polls.get(containerId) === poll
          && poll.pollRequested
        ) {
          poll.pollRequested = false;
          this.requestPoll(containerId, poll);
        }
      });
  }

  private isCurrent(containerId: string, poll: ClaudeStatePoll): boolean {
    return poll.active && this.polls.get(containerId) === poll;
  }

  /**
   * Whether an unchanged tick should still confirm the environment is running.
   * Undefined means it never has, which is why the first tick always checks.
   */
  private isRetirementCheckDue(poll: ClaudeStatePoll): boolean {
    return poll.lastRetirementCheckAt === undefined
      || this.nowMs() - poll.lastRetirementCheckAt >= CLAUDE_STATE_RETIREMENT_CHECK_MS;
  }

  private async poll(containerId: string, poll: ClaudeStatePoll): Promise<void> {
    const state = (await this.readState(containerId).catch(() => "")).trim();
    if (!this.isCurrent(containerId, poll)) return;

    const known = state === "working" || state === "waiting" || state === "idle";
    const changed = known && state !== poll.lastState;
    // A tick that observed nothing new must cost nothing beyond the state read.
    // Loading environments here parses the whole environments file, once per
    // second per running container, to answer a question whose answer has not
    // changed. The retirement check below is what that read is *for*, and it
    // only has to be timely enough to stop polling a container that has gone.
    if (!changed && !this.isRetirementCheckDue(poll)) return;

    const environment = (await poll.context.storage.loadEnvironments()).find(
      (candidate) => candidate.containerId === containerId,
    );
    if (!this.isCurrent(containerId, poll)) return;
    poll.lastRetirementCheckAt = this.nowMs();
    if (!environment || environment.status !== "running") {
      this.deactivate(containerId, poll);
      return;
    }
    if (!changed) return;
    const occurredAt = this.now();
    const persisted = await poll.context.storage.setEnvironmentAgentActivity(
      environment.id,
      state,
      occurredAt,
      "claude-terminal",
    );
    if (!this.isCurrent(containerId, poll)) return;
    const persistedTerminal = persisted?.agentActivitySources?.["claude-terminal"];
    if (persistedTerminal?.state !== state) {
      // Storage rejected a stale token, or answered without the source at all.
      // Either way this observation did not land, so keep the previous observed
      // state and let a later poll retry with a fresh backend timestamp. Note
      // this must not emit: the renderer would adopt a state storage rejected.
      return;
    }
    poll.lastState = state;
    poll.context.emit(`claude-state-${containerId}`, {
      container_id: containerId,
      state,
      occurred_at: persistedTerminal.updatedAt,
    });
  }
}

const defaultClaudeStatePolls = new ClaudeStatePollManager();

/**
 * Retire state polling for a container that is being stopped or deleted.
 *
 * Polling deliberately outlives every renderer, and `poll()` only notices a
 * dead environment on its next tick. Calling this from the lifecycle commands
 * stops the read immediately instead of leaving one `docker exec` aimed at a
 * container that is already going away.
 */
export function shutdownClaudeStatePolling(containerId: string): void {
  defaultClaudeStatePolls.shutdown(containerId);
}

function environmentContainerId(environment: Environment | null | undefined): string {
  return environment?.containerId ?? "";
}

export function registerTmuxBackendCommands(
  register: RegisterCommand,
  options: { claudeStatePolls?: ClaudeStatePollManager } = {},
): void {
  // Tests inject a manager so the polling commands can be exercised without a
  // Docker daemon; production keeps the single process-wide instance.
  const claudeStatePolls = options.claudeStatePolls ?? defaultClaudeStatePolls;
  register("start_claude_state_polling", ({ containerId, subscriptionId }, context) => {
    claudeStatePolls.start(
      asString(containerId, "containerId"),
      context,
      asString(subscriptionId, "subscriptionId"),
    );
  });
  register("stop_claude_state_polling", ({ containerId, subscriptionId }) => {
    return claudeStatePolls.stop(
      asString(containerId, "containerId"),
      asString(subscriptionId, "subscriptionId"),
    );
  });

  register("claude_tmux_start", async ({
    tabId,
    environmentId,
    initialPrompt,
    model,
    effort,
    resumeSessionId,
    replaceExisting,
  }, context) => {
    const envId = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
    const resumeId = asOptionalString(resumeSessionId);
    const replace = replaceExisting === true;
    return tmuxManager.installLock(envId).runExclusive(async () => {
      const environment = await context.storage.getEnvironment(envId);
      if (!environment || environment.deletionRequestedAt) {
        throw new Error(`environment ${envId} is being deleted`);
      }
      if (replace) {
        const existing = tmuxManager.remove(envId, tab);
        if (existing) await existing.stop();
        else await killOrphanSession(context, envId, tab);
      }

      const session = await getOrCreateSession(context, envId, tab, resumeId);
      await installWorkspaceHooks(session.backend, session.workspaceHookPaths);
      await session.startAfterHooksInstalled(
        context,
        asOptionalString(initialPrompt),
        asOptionalString(model),
        asOptionalString(effort),
      );
      return session.status(await session.tmuxAlive().catch(() => false));
    });
  });

  register("claude_tmux_stop", async ({ tabId, environmentId }) => {
    const envId = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
    await tmuxManager.installLock(envId).runExclusive(async () => {
      // Start inserts its session before installing hooks and probing the
      // executables. Removing outside this lock lets stop kill "nothing" while
      // that start is paused, after which start can launch an untracked tmux
      // process. Serialize the complete stop transition with start/replace.
      const session = tmuxManager.remove(envId, tab);
      if (!session) return;
      await session.stop();
      if (tmuxManager.sessionsInEnvironment(envId) === 0) {
        await uninstallWorkspaceHooks(session.backend, session.workspaceHookPaths).catch((error) => {
          console.warn("[tmux] uninstallWorkspaceHooks failed", error);
        });
      }
    });
  });

  register("claude_tmux_interrupt", ({ tabId, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).interrupt(),
  );
  register("claude_tmux_status", async ({ tabId, environmentId }) => {
    const session = tmuxManager.get(asString(environmentId, "environmentId"), asString(tabId, "tabId"));
    return session ? session.status(await session.tmuxAlive().catch(() => false)) : null;
  });
  register("claude_tmux_transcript", ({ tabId, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).transcriptLines(),
  );
  // Authoritative task list for a tmux tab, for callers rehydrating without
  // replaying the whole transcript.
  register("claude_tmux_tasks", ({ tabId, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).taskList(),
  );
  register("claude_tmux_pending_hooks", ({ tabId, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).pendingHooks(),
  );
  register("claude_tmux_send_text", ({ tabId, text, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).sendText(asString(text, "text")),
  );
  register("claude_tmux_send_keys", ({ tabId, keys, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).sendKeys(asStringArray(keys)),
  );
  register("claude_tmux_submit", ({ tabId, text, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).submit(asString(text, "text")),
  );
  register("claude_tmux_switch_model", ({ tabId, model, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).switchModel(asString(model, "model")),
  );
  register("claude_tmux_switch_effort", ({ tabId, effort, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).switchEffort(asString(effort, "effort")),
  );
  register("claude_tmux_switch_plan_mode", ({ tabId, planMode, environmentId }, context) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).switchPlanMode(
      asBoolean(planMode, "planMode"),
      context,
    ),
  );
  // `knownHash` is optional: without it the answer is the plain pane text a
  // caller has always received, so an older renderer keeps working unchanged.
  register("claude_tmux_capture_pane", ({ tabId, environmentId, knownHash }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId"))
      .capturePaneForRequest(asOptionalString(knownHash)),
  );
  register("claude_tmux_resize", ({ tabId, cols, rows, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).resize(
      asPositiveInt(cols, "cols"),
      asPositiveInt(rows, "rows"),
    ),
  );
  register("claude_tmux_answer_pre_tool_use", ({ tabId, eventId, decision, reason, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).answerPreToolUse(
      asString(eventId, "eventId"),
      asString(decision, "decision"),
      asOptionalString(reason),
    ),
  );
  register("claude_tmux_reply_hook", ({ tabId, eventKind, eventId, response, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).replyHook(
      asString(eventKind, "eventKind"),
      asString(eventId, "eventId"),
      response,
    ),
  );
  register("claude_tmux_list_previous_sessions", async ({ environmentId }, context) => {
    const backend = await resolveBackend(asString(environmentId, "environmentId"), context);
    const paths = workspaceAndClaudeHome(backend);
    return listPreviousSessions(backend, paths.claudeHome, paths.workspace);
  });
  register("claude_tmux_create_interactive_terminal", async ({ tabId, environmentId, cols, rows }, context) => {
    const envId = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
    const session = requireSession(envId, tab);
    if (!await session.tmuxAlive()) throw new Error("tmux session not running");
    const environment = await context.storage.getEnvironment(envId);
    if (environment?.environmentType !== "local" && !environmentContainerId(environment)) {
      throw new Error("container environment has no container id");
    }
    return interactiveTerminals.create(session, asPositiveInt(cols, "cols"), asPositiveInt(rows, "rows"));
  });
  register("claude_tmux_start_interactive_terminal", ({ terminalSessionId }, context) =>
    interactiveTerminals.start(asString(terminalSessionId, "terminalSessionId"), context),
  );
  register("claude_tmux_write_interactive_terminal", ({ terminalSessionId, data }) =>
    interactiveTerminals.write(asString(terminalSessionId, "terminalSessionId"), asString(data, "data")),
  );
  register("claude_tmux_resize_interactive_terminal", ({ terminalSessionId, cols, rows }) =>
    interactiveTerminals.resize(
      asString(terminalSessionId, "terminalSessionId"),
      asPositiveInt(cols, "cols"),
      asPositiveInt(rows, "rows"),
    ),
  );
  register("claude_tmux_detach_interactive_terminal", ({ terminalSessionId }) => {
    interactiveTerminals.detach(asString(terminalSessionId, "terminalSessionId"));
  });
}

function requireSession(environmentId: string, tabId: string): TmuxSession {
  const session = tmuxManager.get(environmentId, tabId);
  if (!session) throw new Error("tmux session not running");
  return session;
}
