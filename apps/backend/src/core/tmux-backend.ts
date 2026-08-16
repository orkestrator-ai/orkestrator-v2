import * as shared from "./tmux-shared.js";
const {
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
  CLAUDE_TMUX_EVENT,
  POLL_INTERVAL_MS,
  TMUX_OBSERVATION_INTERVAL_MS,
  TMUX_BUSY_OBSERVATION_INTERVAL_MS,
  LIVENESS_CHECK_EVERY_TICKS,
  HOOK_TIMEOUT_SECS,
  COMMAND_IDLE_TIMEOUT_MS,
  COMMAND_NO_HOOK_SETTLE_MS,
  COMMAND_AFTER_IDLE_SETTLE_MS,
  PERMISSION_MODE_SWITCH_TIMEOUT_MS,
  PERMISSION_MODE_POLL_MS,
  FAST_MODE_SWITCH_TIMEOUT_MS,
  FAST_MODE_POLL_MS,
  FAST_MODE_TMUX_OPTION,
  BACKUP_SENTINEL_NO_ORIGINAL,
  CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN,
  RUNTIME_ROOT_PREFIX,
  claudeTmuxRuntimeRootPrefix,
  agentMcpConfigJson,
  agentToolConnectionTarget,
  runtimeRootPrefixForContext,
  isMissingTmuxSessionError,
  THINKING_MODE_ARGS,
  THINKING_DISPLAY_FLAG,
  THINKING_DISPLAY_VALUE,
  THINKING_DISPLAY_PROBE_VALUE,
  THINKING_DISPLAY_PROBE_TIMEOUT_MS,
  HOOK_EVENT_KINDS,
  containerExecArgs,
  asString,
  asOptionalString,
  asBoolean,
  asPositiveInt,
  asNonNegativeInt,
  asStringArray,
  shellArg,
  shellDq,
  readableIdPrefix,
  tmuxSessionName,
  tmuxSessionNamePrefix,
  parseTmuxSessionNames,
  selectReapableTmuxSessions,
  isBlockingHook,
  parseEventFilename,
  responseFilename,
  pathDirname,
  bytesPayload,
  countNewlines,
  execWithOutput,
  execWithRawOutput,
  POLL_SNAPSHOT_PENDING_MARKER,
  POLL_SNAPSHOT_TIMEOUT_MARKER,
  POLL_SNAPSHOT_SIZE_MARKER,
  pollSnapshotScript,
  parsePollSnapshotOutput,
  parsePollSnapshotExecOutput,
  tailFromOffsetCommand,
  TRANSCRIPT_HEAD_MARKER,
  transcriptHeadCommand,
  parseTranscriptHeadOutput,
  MAX_PREVIOUS_SESSIONS,
  PREVIOUS_SESSION_STAT_CONCURRENCY,
  jsonlByMtimeFindCommand,
  isDirectJsonlChild,
  listLocalJsonlByMtime,
  parseFreshJsonlFindOutput,
  INTERACTIVE_KEY_SEQUENCES,
  sendInteractiveData,
} = Object.assign({}, shared);
void [existsSync, fs, path, os, createHash, randomUUID, spawn, delay, ORKESTRATOR_AGENT_MCP_SERVER_NAME, runCommand, TranscriptTaskTracker, AGENT_INTERACTION_DEFAULT_TIMEOUT_MS, parseTmuxAgentObservation, parseTmuxSelectionPrompt, tmuxSelectionPromptFingerprint, CLAUDE_TMUX_EVENT, POLL_INTERVAL_MS, TMUX_OBSERVATION_INTERVAL_MS, TMUX_BUSY_OBSERVATION_INTERVAL_MS, LIVENESS_CHECK_EVERY_TICKS, HOOK_TIMEOUT_SECS, COMMAND_IDLE_TIMEOUT_MS, COMMAND_NO_HOOK_SETTLE_MS, COMMAND_AFTER_IDLE_SETTLE_MS, PERMISSION_MODE_SWITCH_TIMEOUT_MS, PERMISSION_MODE_POLL_MS, FAST_MODE_SWITCH_TIMEOUT_MS, FAST_MODE_POLL_MS, FAST_MODE_TMUX_OPTION, BACKUP_SENTINEL_NO_ORIGINAL, CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN, RUNTIME_ROOT_PREFIX, claudeTmuxRuntimeRootPrefix, agentMcpConfigJson, agentToolConnectionTarget, runtimeRootPrefixForContext, isMissingTmuxSessionError, THINKING_MODE_ARGS, THINKING_DISPLAY_FLAG, THINKING_DISPLAY_VALUE, THINKING_DISPLAY_PROBE_VALUE, THINKING_DISPLAY_PROBE_TIMEOUT_MS, HOOK_EVENT_KINDS, containerExecArgs, asString, asOptionalString, asBoolean, asPositiveInt, asNonNegativeInt, asStringArray, shellArg, shellDq, readableIdPrefix, tmuxSessionName, tmuxSessionNamePrefix, parseTmuxSessionNames, selectReapableTmuxSessions, isBlockingHook, parseEventFilename, responseFilename, pathDirname, bytesPayload, countNewlines, execWithOutput, execWithRawOutput, POLL_SNAPSHOT_PENDING_MARKER, POLL_SNAPSHOT_TIMEOUT_MARKER, POLL_SNAPSHOT_SIZE_MARKER, pollSnapshotScript, parsePollSnapshotOutput, parsePollSnapshotExecOutput, tailFromOffsetCommand, TRANSCRIPT_HEAD_MARKER, transcriptHeadCommand, parseTranscriptHeadOutput, MAX_PREVIOUS_SESSIONS, PREVIOUS_SESSION_STAT_CONCURRENCY, jsonlByMtimeFindCommand, isDirectJsonlChild, listLocalJsonlByMtime, parseFreshJsonlFindOutput, INTERACTIVE_KEY_SEQUENCES, sendInteractiveData];
type CommandContext = shared.CommandContext;
type AgentToolConnection = shared.AgentToolConnection;
type Environment = shared.Environment;
type JsonRecord = shared.JsonRecord;
type TaskListSnapshot = shared.TaskListSnapshot;
type TmuxAgentObservation = shared.TmuxAgentObservation;
type TranscriptTaskTracker = shared.TranscriptTaskTracker;
type CommandHandler = shared.CommandHandler;
type RegisterCommand = shared.RegisterCommand;
type ExecOutput = shared.ExecOutput;
type BackendKind = shared.BackendKind;
type RawExecOutput = shared.RawExecOutput;
type TmuxPollSnapshot = shared.TmuxPollSnapshot;
type SessionHookPaths = shared.SessionHookPaths;
export type BackendTmuxLayerTypes = [
  CommandContext,
  AgentToolConnection,
  Environment,
  JsonRecord,
  TaskListSnapshot,
  TmuxAgentObservation,
  TranscriptTaskTracker,
  CommandHandler,
  RegisterCommand,
  ExecOutput,
  BackendKind,
  RawExecOutput,
  TmuxPollSnapshot,
  SessionHookPaths,
];
export class TmuxBackend {
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

  /**
   * At most `maxBytes` of `filePath`, or undefined when it does not exist.
   *
   * Hook payloads are written by an agent this process does not control, so the
   * read that feeds the retained snapshot and every SSE subscriber has to be
   * bounded at the source rather than trimmed afterwards.
   */
  async readBoundedFile(
    filePath: string,
    maxBytes: number,
  ): Promise<{ content: string; truncated: boolean } | undefined> {
    if (this.kind === "local") {
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try {
        handle = await fs.open(filePath, "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      try {
        const buffer = Buffer.allocUnsafe(maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return {
          content: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
          truncated: bytesRead > maxBytes,
        };
      } finally {
        await handle.close().catch(() => undefined);
      }
    }

    const probe = await this.exec(["test", "-f", filePath]);
    if (probe.status !== 0) return undefined;
    const out = await this.exec(["head", "-c", String(maxBytes + 1), filePath]);
    if (out.status !== 0) throw new Error(out.stderr || `failed to read ${filePath}`);
    const buffer = Buffer.from(out.stdout);
    return {
      content: buffer.subarray(0, maxBytes).toString("utf8"),
      truncated: buffer.byteLength > maxBytes,
    };
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



