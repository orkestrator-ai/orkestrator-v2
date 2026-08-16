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
import { AGENT_INTERACTION_DEFAULT_TIMEOUT_MS } from "@orkestrator/protocol/agent-interactions";
import {
  parseTmuxAgentObservation,
  parseTmuxSelectionPrompt,
  tmuxSelectionPromptFingerprint,
  type TmuxAgentObservation,
} from "@orkestrator/protocol/tmux-observation";

export type CommandHandler = (args: JsonRecord, context: CommandContext) => Promise<unknown> | unknown;
export type RegisterCommand = (name: string, handler: CommandHandler) => void;

export type ExecOutput = {
  status: number;
  stdout: string;
  stderr: string;
};

export type BackendKind = "local" | "container";

export const CLAUDE_TMUX_EVENT = "claude-tmux:event";
export const POLL_INTERVAL_MS = 250;
/** Hidden tabs still need selection prompts, but pane capture is comparatively expensive. */
export const TMUX_OBSERVATION_INTERVAL_MS = 3_000;
export const TMUX_BUSY_OBSERVATION_INTERVAL_MS = 500;
/**
 * How many poll ticks pass between `tmux has-session` checks. Hooks and
 * transcript appends still arrive every tick; only the liveness probe — which
 * costs its own process spawn and can only ever report a session that has
 * already stopped — runs on this slower cadence.
 */
export const LIVENESS_CHECK_EVERY_TICKS = 8;
// The hook process owns the shared five-minute timeout. Renderers receive the
// resulting absolute timestamps and only display them.
if (
  !Number.isSafeInteger(AGENT_INTERACTION_DEFAULT_TIMEOUT_MS)
  || AGENT_INTERACTION_DEFAULT_TIMEOUT_MS <= 0
  || AGENT_INTERACTION_DEFAULT_TIMEOUT_MS % 1_000 !== 0
) {
  throw new Error("Agent interaction timeout must be a positive whole number of seconds");
}
export const HOOK_TIMEOUT_SECS = Math.trunc(AGENT_INTERACTION_DEFAULT_TIMEOUT_MS / 1_000);
export const COMMAND_IDLE_TIMEOUT_MS = 8_000;
export const COMMAND_NO_HOOK_SETTLE_MS = 2_000;
export const COMMAND_AFTER_IDLE_SETTLE_MS = 400;
export const PERMISSION_MODE_SWITCH_TIMEOUT_MS = 1_500;
export const PERMISSION_MODE_POLL_MS = 100;
export const FAST_MODE_SWITCH_TIMEOUT_MS = 2_500;
export const FAST_MODE_POLL_MS = 100;
export const FAST_MODE_TMUX_OPTION = "@orkestrator_fast_mode";
export const BACKUP_SENTINEL_NO_ORIGINAL = "__orkestrator_no_original__";
export const CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN = ".claude/settings.local.json";
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

export function runtimeRootPrefixForContext(context: CommandContext): string {
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
export const THINKING_MODE_ARGS = ["--thinking", "adaptive"] as const;
export const THINKING_DISPLAY_FLAG = "--thinking-display";
export const THINKING_DISPLAY_VALUE = "summarized";
/** Never a valid `--thinking-display` choice, so the CLI has to reject it. */
export const THINKING_DISPLAY_PROBE_VALUE = "__orkestrator_probe__";
/** A capability probe that has not answered by now is not going to. */
export const THINKING_DISPLAY_PROBE_TIMEOUT_MS = 10_000;

export const HOOK_EVENT_KINDS = new Set([
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

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${name} to be a string`);
  return value;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Expected ${name} to be a boolean`);
  return value;
}

export function asPositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected ${name} to be a positive number`);
  }
  return Math.floor(value);
}

export function asNonNegativeInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected ${name} to be a non-negative integer`);
  }
  return value;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function shellDq(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

export function readableIdPrefix(id: string): string {
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

export function isBlockingHook(kind: string): boolean {
  return kind === "PreToolUse" || kind === "PermissionRequest" || kind === "Elicitation";
}

export function parseEventFilename(name: string): { kind: string; id: string } {
  const stem = name.endsWith(".json") ? name.slice(0, -5) : name;
  const dash = stem.indexOf("-");
  if (dash < 0) return { kind: stem, id: "" };
  return { kind: stem.slice(0, dash), id: stem.slice(dash + 1) };
}

export function responseFilename(kind: string, id: string): string {
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

export function pathDirname(kind: BackendKind, filePath: string): string {
  return kind === "container" ? path.posix.dirname(filePath) : path.dirname(filePath);
}

export function bytesPayload(text: string, full = false): { text: string; full: boolean } {
  return { text, full };
}

export function countNewlines(buffer: Buffer): number {
  let count = 0;
  let index = buffer.indexOf(0x0a);
  while (index >= 0) {
    count += 1;
    index = buffer.indexOf(0x0a, index + 1);
  }
  return count;
}

/** Like {@link ExecOutput}, but with stdout still in bytes. */
export type RawExecOutput = {
  status: number;
  stdout: Buffer;
  stderr: string;
};

export async function execWithOutput(
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
export async function execWithRawOutput(
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
export const POLL_SNAPSHOT_PENDING_MARKER = "__ork_pending__";
export const POLL_SNAPSHOT_TIMEOUT_MARKER = "__ork_timeout__";
export const POLL_SNAPSHOT_SIZE_MARKER = "__ork_size__";

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
export const TRANSCRIPT_HEAD_MARKER = "__ork_head__";

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
export const MAX_PREVIOUS_SESSIONS = 50;
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



export type SessionHookPaths = {
  sessionDir: string;
  pendingDir: string;
  responseDir: string;
  timeoutDir: string;
  timingDir: string;
};

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

export const INTERACTIVE_KEY_SEQUENCES: ReadonlyArray<readonly [string, string[]]> = [
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

export async function sendInteractiveData(
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
        await flushLiteral();
        await sendKeys(["Enter"]);
        break;
      case "\n":
        await flushLiteral();
        await sendKeys(["C-j"]);
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



export {
  existsSync,
  fs,
  path,
  os,
  createHash,
  randomUUID,
  spawn,
  delay,
  ORKESTRATOR_AGENT_MCP_SERVER_NAME,
  runCommand,
  TranscriptTaskTracker,
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  parseTmuxAgentObservation,
  parseTmuxSelectionPrompt,
  tmuxSelectionPromptFingerprint,
};

export type {
  CommandContext,
  AgentToolConnection,
  Environment,
  JsonRecord,
  TaskListSnapshot,
  TmuxAgentObservation,
};
