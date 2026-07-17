import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandContext } from "./commands.js";
import type { Environment } from "./models.js";
import type { JsonRecord } from "./storage.js";
import { runCommand } from "./shell.js";

type CommandHandler = (args: JsonRecord, context: CommandContext) => Promise<unknown> | unknown;
type RegisterCommand = (name: string, handler: CommandHandler) => void;

type ExecOutput = {
  status: number;
  stdout: string;
  stderr: string;
};

type BackendKind = "local" | "container";

const CLAUDE_TMUX_EVENT = "claude-tmux:event";
const POLL_INTERVAL_MS = 250;
const HOOK_TIMEOUT_SECS = 600;
const COMMAND_IDLE_TIMEOUT_MS = 8_000;
const COMMAND_NO_HOOK_SETTLE_MS = 2_000;
const COMMAND_AFTER_IDLE_SETTLE_MS = 400;
const PERMISSION_MODE_SWITCH_TIMEOUT_MS = 1_500;
const PERMISSION_MODE_POLL_MS = 100;
const BACKUP_SENTINEL_NO_ORIGINAL = "__orkestrator_no_original__";
const CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN = ".claude/settings.local.json";
const RUNTIME_ROOT_PREFIX = "/tmp/orkestrator-v2-claude-tmux";

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

function bytesPayload(text: string): number[] {
  return Array.from(Buffer.from(text, "utf8"));
}

async function execWithOutput(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number } = {},
): Promise<ExecOutput> {
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
        stdout: Buffer.concat(stdout).toString(),
        stderr: timedOut ? `${stderrText}\nCommand timed out`.trim() : stderrText,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
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
    const dockerArgs = ["exec", "-u", "node", "-w", "/workspace"];
    if (stdin !== undefined) dockerArgs.push("-i");
    dockerArgs.push(this.containerId, ...args);
    return execWithOutput("docker", dockerArgs, { stdin, timeoutMs });
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
  const backup = await backend.readFile(paths.claudeSettingsBackup);
  if (backup === BACKUP_SENTINEL_NO_ORIGINAL) {
    await backend.removeFile(paths.claudeSettings);
  } else if (backup !== undefined) {
    await backend.writeFile(paths.claudeSettings, backup);
  }
  await backend.removeFile(paths.claudeSettingsBackup).catch(() => undefined);
  await backend.removeDir(paths.root).catch(() => undefined);
}

async function ensureSessionDirs(backend: TmuxBackend, paths: SessionHookPaths): Promise<void> {
  await backend.ensureDir(paths.sessionDir);
  await backend.ensureDir(paths.pendingDir);
  await backend.ensureDir(paths.responseDir);
  await backend.ensureDir(paths.timeoutDir);
}

async function drainTimeouts(backend: TmuxBackend, paths: SessionHookPaths): Promise<Array<{ kind: string; id: string }>> {
  const names = await backend.listDir(paths.timeoutDir);
  const out: Array<{ kind: string; id: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseEventFilename(name);
    await backend.removeFile(`${paths.timeoutDir}/${name}`).catch(() => undefined);
    out.push(parsed);
  }
  return out;
}

async function drainPending(
  backend: TmuxBackend,
  paths: SessionHookPaths,
  alreadyEmitted: Set<string>,
): Promise<PendingHookEvent[]> {
  const names = (await backend.listDir(paths.pendingDir)).filter((name) => name.endsWith(".json")).sort();
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
 * emitting `<mtime> <path>` lines. Relies on GNU `find` (`-printf`/`-newermt`), which is
 * available inside the Linux container backend.
 */
export function newestJsonlFindCommand(dirPath: string, minMtimeUnix: number): string {
  return `find ${shellArg(dirPath)}/ -mindepth 1 -maxdepth 1 -type f -name '*.jsonl' -newermt @${minMtimeUnix} -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
}

/**
 * Parses `find -printf '%T@ %p'` output into `{ path, mtime }` records, skipping lines
 * that lack a path or a finite mtime. Shared by the container and local discovery paths.
 */
export function parseFreshJsonlFindOutput(findOutput: string): Array<{ path: string; mtime: number }> {
  return findOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const firstSpace = line.indexOf(" ");
      if (firstSpace < 0) return [];
      const mtime = Number.parseFloat(line.slice(0, firstSpace));
      const candidatePath = line.slice(firstSpace + 1).trim();
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
    candidates = parseFreshJsonlFindOutput(out.stdout);
  } else {
    const names = await backend.listDir(dirPath);
    candidates = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const fullPath = `${dirPath}/${name}`;
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
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      if (jsonContainsSessionId(JSON.parse(trimmed), sessionId)) return true;
    } catch {
      continue;
    }
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

async function listPreviousSessions(
  backend: TmuxBackend,
  claudeHome: string,
  cwd: string,
): Promise<Array<{ session_id: string; title: string | null; last_activity_unix: number; message_count: number; transcript_path: string }>> {
  const projectDir = `${claudeHome}/projects/${encodeCwd(cwd)}`;
  const names = await backend.listDir(projectDir);
  const candidates: Array<{ mtime: number; fullPath: string; sessionId: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -6);
    const fullPath = `${projectDir}/${name}`;
    candidates.push({
      mtime: await backend.fileMtimeUnix(fullPath),
      fullPath,
      sessionId,
    });
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const candidate of candidates.slice(0, 50)) {
    const content = await backend.readFile(candidate.fullPath) ?? "";
    const summary = summarizeTranscript(content);
    out.push({
      session_id: candidate.sessionId,
      title: summary.title,
      last_activity_unix: candidate.mtime,
      message_count: summary.messageCount,
      transcript_path: candidate.fullPath,
    });
  }
  return out;
}

function summarizeTranscript(content: string): { title: string | null; messageCount: number } {
  let messageCount = 0;
  let title: string | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    messageCount += 1;
    if (title !== null) continue;

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
    if (text?.trim()) title = truncateTitle(text.trim(), 80);
  }
  return { title, messageCount };
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

class TranscriptTail {
  private offset = 0;
  private partial = "";

  constructor(private readonly filePath: string) {}

  async readNew(backend: TmuxBackend): Promise<unknown[]> {
    const size = await backend.fileSize(this.filePath);
    if (size <= this.offset) return [];
    const full = await backend.readFile(this.filePath) ?? "";
    const bytes = Buffer.from(full, "utf8");
    const newChunk = bytes.subarray(this.offset).toString("utf8");
    this.offset = Buffer.byteLength(full);
    const combined = `${this.partial}${newChunk}`;
    this.partial = "";

    const lines: unknown[] = [];
    let lastNewline = 0;
    for (let index = 0; index < combined.length; index += 1) {
      if (combined.charCodeAt(index) !== 10) continue;
      const line = combined.slice(lastNewline, index).trim();
      lastNewline = index + 1;
      if (!line) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // Ignore malformed JSONL fragments.
      }
    }
    if (lastNewline < combined.length) this.partial = combined.slice(lastNewline);
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
  private busy = false;
  private permissionMode = "bypassPermissions";
  private readonly inputMutex = new AsyncMutex();

  constructor(
    readonly environmentId: string,
    readonly tabId: string,
    readonly backend: TmuxBackend,
    resumeSessionId?: string,
    claudeCommand?: string,
  ) {
    this.resumed = resumeSessionId !== undefined;
    this.sessionId = resumeSessionId ?? randomUUID();
    this.tmuxSession = tmuxSessionName(environmentId, tabId);
    this.workspace = backend.kind === "local" ? backend.cwd ?? process.cwd() : "/workspace";
    this.claudeHome = backend.kind === "local" ? localClaudeHome() : "/home/node/.claude";
    this.workspaceHookPaths = workspaceHookPaths(`${RUNTIME_ROOT_PREFIX}/${environmentId}`, this.workspace);
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
    const lines: unknown[] = [];
    for (const raw of content.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const line = JSON.parse(trimmed);
        lines.push(line);
        const permissionMode = permissionModeFromTranscriptLine(line);
        if (permissionMode) this.permissionMode = permissionMode;
      } catch {
        // Continue reading later lines.
      }
    }
    return lines;
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
      const claudeCmd = this.claudeLaunchCommand(claudeCommand, helpText, model, effort);
      const wrapped = `${claudeCmd}; echo '[claude exited]'; exec bash`;
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
    }

    this.spawnPollLoop(context);
    context.emit(CLAUDE_TMUX_EVENT, {
      kind: "started",
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      resumed: this.resumed,
    });

    if (initialPrompt?.trim()) {
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

    void (async () => {
      try {
        while (!this.stopRequested) {
          await delay(POLL_INTERVAL_MS);
          if (this.stopRequested) break;

          try {
            const events = await drainPending(this.backend, this.sessionHookPaths, emittedBlockingIds);
            for (const event of events) this.emitHook(context, event);
          } catch (error) {
            console.warn("[tmux] drainPending failed", error);
          }

          try {
            const timeouts = await drainTimeouts(this.backend, this.sessionHookPaths);
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

          if (!tail) {
            try {
              const transcriptPath = await this.discoverTranscriptPath();
              if (transcriptPath) tail = new TranscriptTail(transcriptPath);
            } catch (error) {
              console.warn("[tmux] transcript discovery failed", error);
            }
          }

          if (tail) {
            try {
              const lines = await tail.readNew(this.backend);
              for (const line of lines) {
                const permissionMode = permissionModeFromTranscriptLine(line);
                if (permissionMode) this.setPermissionMode(permissionMode, context);
                context.emit(CLAUDE_TMUX_EVENT, {
                  kind: "transcript-line",
                  tab_id: this.tabId,
                  environment_id: this.environmentId,
                  session_id: this.sessionId,
                  line,
                });
              }
            } catch (error) {
              console.warn("[tmux] transcript tail failed", error);
            }
          }

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

  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.backend.exec([this.tmuxCommand, "kill-session", "-t", this.tmuxSession]).catch(() => undefined);
    await this.backend.removeDir(this.sessionHookPaths.sessionDir).catch(() => undefined);
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

type InteractiveTerminalSession = {
  id: string;
  tmux: TmuxSession;
  interval?: NodeJS.Timeout;
  lastSnapshot?: string;
  cols: number;
  rows: number;
};

class InteractiveTmuxTerminalManager {
  private readonly terminals = new Map<string, InteractiveTerminalSession>();

  create(tmux: TmuxSession, cols: number, rows: number): string {
    const id = `tmux:${tmux.environmentId}:${tmux.tabId}:${randomUUID()}`;
    this.terminals.set(id, { id, tmux, cols, rows });
    return id;
  }

  async start(id: string, context: CommandContext): Promise<void> {
    const terminal = this.require(id);
    await terminal.tmux.resize(terminal.cols, terminal.rows);
    await this.emitSnapshot(terminal, context, true);
    if (terminal.interval) clearInterval(terminal.interval);
    terminal.interval = setInterval(() => {
      void this.emitSnapshot(terminal, context, false).catch((error) => {
        console.debug("[tmux] interactive snapshot failed", error);
      });
    }, 250);
  }

  async write(id: string, data: string): Promise<void> {
    await this.require(id).tmux.writeInteractive(data);
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
    if (terminal.interval) clearInterval(terminal.interval);
    this.terminals.delete(id);
  }

  private require(id: string): InteractiveTerminalSession {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error("tmux interactive terminal session not found");
    return terminal;
  }

  private async emitSnapshot(terminal: InteractiveTerminalSession, context: CommandContext, force: boolean): Promise<void> {
    const snapshot = await terminal.tmux.capturePane({ ansi: true, joinWrapped: false });
    if (!force && snapshot === terminal.lastSnapshot) return;
    terminal.lastSnapshot = snapshot;
    context.emit(`terminal-output-${terminal.id}`, bytesPayload(`\x1b[H\x1b[2J${snapshot.replaceAll("\n", "\r\n")}`));
  }
}

const interactiveTerminals = new InteractiveTmuxTerminalManager();

const INTERACTIVE_KEY_SEQUENCES = new Map<string, string[]>([
  ["\x1b[A", ["Up"]],
  ["\x1b[B", ["Down"]],
  ["\x1b[C", ["Right"]],
  ["\x1b[D", ["Left"]],
  ["\x1b[3~", ["Delete"]],
  ["\x1b[H", ["Home"]],
  ["\x1b[1~", ["Home"]],
  ["\x1b[F", ["End"]],
  ["\x1b[4~", ["End"]],
]);

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
    const matched = Array.from(INTERACTIVE_KEY_SEQUENCES.entries()).find(([sequence]) => data.startsWith(sequence, index));
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

class ClaudeStatePollManager {
  private readonly polls = new Map<string, { timer: NodeJS.Timeout; lastState: string }>();

  start(containerId: string, context: CommandContext): void {
    if (this.polls.has(containerId)) return;
    const poll = { timer: undefined as unknown as NodeJS.Timeout, lastState: "" };
    poll.timer = setInterval(() => {
      void this.poll(containerId, context).catch(() => undefined);
    }, 1_000);
    this.polls.set(containerId, poll);
    void this.poll(containerId, context).catch(() => undefined);
  }

  stop(containerId: string): void {
    const poll = this.polls.get(containerId);
    if (!poll) return;
    clearInterval(poll.timer);
    this.polls.delete(containerId);
  }

  private async poll(containerId: string, context: CommandContext): Promise<void> {
    const poll = this.polls.get(containerId);
    if (!poll) return;
    const state = (await runCommand("docker", ["exec", containerId, "cat", "/tmp/.claude-state"], { timeoutMs: 5_000 })
      .then((result) => result.stdout.trim())
      .catch(() => "")).trim();
    if (state !== "working" && state !== "waiting" && state !== "idle") return;
    if (state === poll.lastState) return;
    poll.lastState = state;
    context.emit(`claude-state-${containerId}`, { container_id: containerId, state });
  }
}

const claudeStatePolls = new ClaudeStatePollManager();

function environmentContainerId(environment: Environment | null | undefined): string {
  return environment?.containerId ?? "";
}

export function registerTmuxBackendCommands(register: RegisterCommand): void {
  register("start_claude_state_polling", ({ containerId }, context) => {
    claudeStatePolls.start(asString(containerId, "containerId"), context);
  });
  register("stop_claude_state_polling", ({ containerId }) => {
    claudeStatePolls.stop(asString(containerId, "containerId"));
  });

  register("claude_tmux_start", async ({ tabId, environmentId, initialPrompt, model, effort, resumeSessionId }, context) => {
    const envId = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
    const resumeId = asOptionalString(resumeSessionId);
    return tmuxManager.installLock(envId).runExclusive(async () => {
      if (resumeId === undefined) {
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
    const session = tmuxManager.remove(envId, tab);
    if (!session) return;
    await session.stop();
    await tmuxManager.installLock(envId).runExclusive(async () => {
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
  register("claude_tmux_capture_pane", ({ tabId, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).capturePane(),
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
