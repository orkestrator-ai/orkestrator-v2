import * as shared from "./tmux-shared.js";
import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  BACKUP_SENTINEL_NO_ORIGINAL,
  CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN,
  HOOK_TIMEOUT_SECS,
  MAX_PREVIOUS_SESSIONS,
  THINKING_DISPLAY_FLAG,
  THINKING_DISPLAY_PROBE_TIMEOUT_MS,
  THINKING_DISPLAY_PROBE_VALUE,
  THINKING_MODE_ARGS,
  TranscriptTaskTracker,
  isBlockingHook,
  isDirectJsonlChild,
  os,
  parseEventFilename,
  parseFreshJsonlFindOutput,
  path,
  responseFilename,
  shellArg,
  shellDq,
} from "./tmux-shared.js";
import { TmuxBackend } from "./tmux-backend.js";
type CommandContext = shared.CommandContext;
type AgentToolConnection = shared.AgentToolConnection;
type Environment = shared.Environment;
type JsonRecord = shared.JsonRecord;
type TaskListSnapshot = shared.TaskListSnapshot;
type TmuxAgentObservation = shared.TmuxAgentObservation;
type CommandHandler = shared.CommandHandler;
type RegisterCommand = shared.RegisterCommand;
type ExecOutput = shared.ExecOutput;
type BackendKind = shared.BackendKind;
type RawExecOutput = shared.RawExecOutput;
type TmuxPollSnapshot = shared.TmuxPollSnapshot;
type SessionHookPaths = shared.SessionHookPaths;
export type HooksTmuxLayerTypes = [
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
  TmuxBackend,
];
export type WorkspaceHookPaths = {
  root: string;
  sessionsDir: string;
  script: string;
  claudeSettings: string;
  claudeSettingsBackup: string;
};

export type PendingHookEvent = {
  id: string;
  kind: string;
  payload: unknown;
  requestedAt?: number;
  expiresAt?: number;
};

/**
 * Upper bound on one hook payload file. Generous enough that a real tool-use
 * payload parses as JSON, small enough that a pathological or hostile hook file
 * cannot be held in memory and fanned out to every SSE subscriber.
 */
export const TMUX_HOOK_PAYLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** The timing sidecar is two integers. */
export const TMUX_HOOK_TIMING_MAX_BYTES = 4 * 1024;

export function blockingHookTiming(id: string): { requestedAt: number; expiresAt: number } | null {
  const timestamp = id.split("-", 1)[0] ?? "";
  if (!/^\d+$/.test(timestamp)) return null;
  const seconds = Number.parseInt(timestamp, 10);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const requestedAt = seconds * 1_000;
  const expiresAt = requestedAt + AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestedAt) || !Number.isSafeInteger(expiresAt)) return null;
  return {
    requestedAt,
    expiresAt,
  };
}

export function parseBlockingHookTiming(content: string | undefined): {
  requestedAt: number;
  expiresAt: number;
} | null {
  if (content === undefined) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const requestedAt = parsed.requestedAt;
    const expiresAt = parsed.expiresAt;
    if (
      typeof requestedAt !== "number" ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(requestedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      requestedAt <= 0 ||
      expiresAt - requestedAt !== AGENT_INTERACTION_DEFAULT_TIMEOUT_MS
    ) {
      return null;
    }
    return { requestedAt, expiresAt };
  } catch {
    return null;
  }
}

export async function readBlockingHookTiming(
  backend: TmuxBackend,
  paths: SessionHookPaths,
  filename: string,
  id: string,
): Promise<{ requestedAt: number; expiresAt: number } | null> {
  const authoritative = parseBlockingHookTiming(
    (await backend.readBoundedFile(`${paths.timingDir}/${filename}`, TMUX_HOOK_TIMING_MAX_BYTES))
      ?.content,
  );
  // Hooks installed by an older backend do not have a timing sidecar. Keep
  // their pending prompts displayable until the workspace hook is reinstalled.
  return authoritative ?? blockingHookTiming(id);
}

export function workspaceHookPaths(runtimeRoot: string, workspace: string): WorkspaceHookPaths {
  return {
    root: runtimeRoot,
    sessionsDir: `${runtimeRoot}/sessions`,
    script: `${runtimeRoot}/hook.sh`,
    claudeSettings: `${workspace}/.claude/settings.local.json`,
    claudeSettingsBackup: `${runtimeRoot}/settings.local.json.orkestrator-v2-backup`,
  };
}

export function sessionHookPaths(
  workspace: WorkspaceHookPaths,
  sessionId: string,
): SessionHookPaths {
  const sessionDir = `${workspace.sessionsDir}/${sessionId}`;
  return {
    sessionDir,
    pendingDir: `${sessionDir}/pending`,
    responseDir: `${sessionDir}/response`,
    timeoutDir: `${sessionDir}/timeout`,
    timingDir: `${sessionDir}/timing`,
  };
}

export function hookScript(workspace: WorkspaceHookPaths): string {
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
TIMING_DIR="$SESSION_DIR/timing"
mkdir -p "$PENDING_DIR" "$RESPONSE_DIR" "$TIMEOUT_DIR" "$TIMING_DIR" 2>/dev/null || true

ID="$(date +%s)-$$-\${RANDOM}-\${RANDOM}"
PENDING_FILE="$PENDING_DIR/\${EVENT_KIND}-\${ID}.json"
RESPONSE_FILE="$RESPONSE_DIR/\${EVENT_KIND}-\${ID}.json"
TIMEOUT_FILE="$TIMEOUT_DIR/\${EVENT_KIND}-\${ID}.json"
TIMING_FILE="$TIMING_DIR/\${EVENT_KIND}-\${ID}.json"

epoch_millis() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(time.time_ns() // 1000000)'
  elif command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(String(Date.now()))'
  else
    printf '%s000\n' "$(date +%s)"
  fi
}

case "$EVENT_KIND" in
  PreToolUse|PermissionRequest|Elicitation)
    REQUESTED_AT_MS="$(epoch_millis)"
    EXPIRES_AT_MS=$((REQUESTED_AT_MS + TIMEOUT_SECS * 1000))
    printf '{"requestedAt":%s,"expiresAt":%s}' "$REQUESTED_AT_MS" "$EXPIRES_AT_MS" > "$TIMING_FILE"
    printf '%s' "$PAYLOAD" > "$PENDING_FILE"
    # A single sleeper owns the deadline. Counting 1,200 quarter-second
    # polling iterations would add the loop's process and filesystem overhead
    # to the advertised five minutes, causing the published deadline and the
    # actual acceptance window to drift apart under load.
    sleep "$TIMEOUT_SECS" &
    TIMEOUT_PID=$!
    while kill -0 "$TIMEOUT_PID" 2>/dev/null; do
      if [ -f "$RESPONSE_FILE" ]; then
        kill "$TIMEOUT_PID" 2>/dev/null || true
        wait "$TIMEOUT_PID" 2>/dev/null || true
        cat "$RESPONSE_FILE"
        rm -f "$RESPONSE_FILE" "$PENDING_FILE" "$TIMING_FILE"
        exit 0
      fi
      sleep 0.25
    done
    wait "$TIMEOUT_PID" 2>/dev/null || true
    printf '{"timed_out":true}' > "$TIMEOUT_FILE"
    rm -f "$PENDING_FILE" "$TIMING_FILE"
    case "$EVENT_KIND" in
      PreToolUse)
        echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Approval timed out without a user response."}}'
        ;;
      PermissionRequest)
        echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Permission request timed out without a user response."}}}'
        ;;
      Elicitation)
        echo '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"cancel"}}'
        ;;
    esac
    ;;
  *)
    printf '%s' "$PAYLOAD" > "$PENDING_FILE"
    echo '{}'
    ;;
esac
`;
}

export function hooksBlock(hookScriptPath: string): unknown {
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

export function mergeSettingsJson(existing: string | undefined, hookScriptPath: string): string {
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

export function gitExcludeSetupScript(pattern: string): string {
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

export async function ensureClaudeSettingsGitIgnored(backend: TmuxBackend): Promise<void> {
  await backend
    .exec(["bash", "-lc", gitExcludeSetupScript(CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN)])
    .catch((error) => console.warn("[tmux] failed to configure git exclude", error));
}

export async function installWorkspaceHooks(
  backend: TmuxBackend,
  paths: WorkspaceHookPaths,
): Promise<void> {
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

export async function uninstallWorkspaceHooks(
  backend: TmuxBackend,
  paths: WorkspaceHookPaths,
): Promise<void> {
  await restoreWorkspaceHooks(backend, paths);
  await backend.removeFile(paths.claudeSettingsBackup).catch(() => undefined);
  await backend.removeDir(paths.root).catch(() => undefined);
}

export async function restoreWorkspaceHooks(
  backend: TmuxBackend,
  paths: WorkspaceHookPaths,
): Promise<void> {
  const backup = await backend.readFile(paths.claudeSettingsBackup);
  if (backup === BACKUP_SENTINEL_NO_ORIGINAL) {
    await backend.removeFile(paths.claudeSettings);
  } else if (backup !== undefined) {
    await backend.writeFile(paths.claudeSettings, backup);
  }
}

export async function ensureSessionDirs(
  backend: TmuxBackend,
  paths: SessionHookPaths,
): Promise<void> {
  await backend.ensureDir(paths.sessionDir);
  await backend.ensureDir(paths.pendingDir);
  await backend.ensureDir(paths.responseDir);
  await backend.ensureDir(paths.timeoutDir);
  await backend.ensureDir(paths.timingDir);
}

/** `names` comes from the tick's {@link TmuxPollSnapshot}, not a fresh listing. */
export async function drainTimeouts(
  backend: TmuxBackend,
  paths: SessionHookPaths,
  names: string[],
): Promise<Array<{ kind: string; id: string }>> {
  const out: Array<{ kind: string; id: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseEventFilename(name);
    await backend.removeFile(`${paths.timeoutDir}/${name}`).catch(() => undefined);
    await backend.removeFile(`${paths.timingDir}/${name}`).catch(() => undefined);
    out.push(parsed);
  }
  return out;
}

/** `pendingNames` comes from the tick's {@link TmuxPollSnapshot}, not a fresh listing. */
export async function drainPending(
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

    const read = await backend.readBoundedFile(full, TMUX_HOOK_PAYLOAD_MAX_BYTES);
    if (blocking && read?.truncated) {
      // A blocking payload that cannot be safely read must still receive an
      // answer. Leaving it pending would park the agent for five minutes;
      // truncating it could present a materially different approval request.
      await replyToHook(
        backend,
        paths,
        kind,
        id,
        failClosedHookResponse(kind, "Approval payload exceeded the safe size limit."),
      );
      alreadyEmitted.delete(id);
      continue;
    }

    const content = read?.content;
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
    events.push({
      id,
      kind,
      payload,
      ...(blocking ? ((await readBlockingHookTiming(backend, paths, name, id)) ?? {}) : {}),
    });
  }
  return events;
}

export async function listPendingBlocking(
  backend: TmuxBackend,
  paths: SessionHookPaths,
): Promise<PendingHookEvent[]> {
  const names = (await backend.listDir(paths.pendingDir))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const events: PendingHookEvent[] = [];
  for (const name of names) {
    const { kind, id } = parseEventFilename(name);
    if (!isBlockingHook(kind)) continue;
    if ((await backend.readFile(`${paths.responseDir}/${name}`)) !== undefined) continue;

    const pendingPath = `${paths.pendingDir}/${name}`;
    const read = await backend.readBoundedFile(pendingPath, TMUX_HOOK_PAYLOAD_MAX_BYTES);
    if (read?.truncated) {
      await replyToHook(
        backend,
        paths,
        kind,
        id,
        failClosedHookResponse(kind, "Approval payload exceeded the safe size limit."),
      );
      continue;
    }

    const content = read?.content;
    if (content === undefined) continue;
    let payload: unknown = content;
    try {
      payload = JSON.parse(content);
    } catch {
      payload = content;
    }
    events.push({
      id,
      kind,
      payload,
      ...(await readBlockingHookTiming(backend, paths, name, id)),
    });
  }
  return events;
}

export async function replyToHook(
  backend: TmuxBackend,
  paths: SessionHookPaths,
  kind: string,
  id: string,
  response: unknown,
): Promise<void> {
  const filename = responseFilename(kind, id);
  await backend.writeFile(`${paths.responseDir}/${filename}`, JSON.stringify(response ?? {}));
  await backend.removeFile(`${paths.pendingDir}/${filename}`).catch(() => undefined);
  await backend.removeFile(`${paths.timingDir}/${filename}`).catch(() => undefined);
}

export function preToolUseResponse(decision: string, reason?: string): unknown {
  const permissionDecision =
    decision === "approve" || decision === "allow"
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

export function failClosedHookResponse(kind: string, reason: string): unknown {
  if (kind === "PreToolUse") return preToolUseResponse("deny", reason);
  if (kind === "PermissionRequest") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: reason },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "Elicitation",
      action: "cancel",
    },
  };
}

export function encodeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, "").replaceAll("/", "-");
}

export function localClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export async function findTranscriptPath(
  backend: TmuxBackend,
  claudeHome: string,
  cwd: string,
  sessionId: string,
  minMtimeUnix?: number,
): Promise<string | undefined> {
  const projectDir = `${claudeHome}/projects/${encodeCwd(cwd)}`;
  const exact = `${projectDir}/${sessionId}.jsonl`;
  if ((await backend.fileSize(exact)) > 0 || (await backend.readFile(exact)) !== undefined) {
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
    candidates = parseFreshJsonlFindOutput(out.stdout).filter((candidate) =>
      isDirectJsonlChild(dirPath, candidate.path),
    );
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
    const content = (await backend.readFile(candidate.path)) ?? "";
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

export function jsonContainsSessionId(value: unknown, sessionId: string): boolean {
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

export async function listPreviousSessions(
  backend: TmuxBackend,
  claudeHome: string,
  cwd: string,
): Promise<
  Array<{
    session_id: string;
    title: string | null;
    last_activity_unix: number;
    message_count: number;
    transcript_path: string;
  }>
> {
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
export function titleFromTranscriptHead(head: string, truncated: boolean): string | null {
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
    const message =
      record.message && typeof record.message === "object"
        ? (record.message as Record<string, unknown>)
        : undefined;
    const role =
      typeof message?.role === "string"
        ? message.role
        : typeof record.type === "string"
          ? record.type
          : undefined;
    if (role !== "user") continue;
    const contentField = message?.content ?? record.content;
    const text = extractTextContent(contentField);
    if (text?.trim()) return truncateTitle(text.trim(), 80);
  }
  return null;
}

export function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return record.text;
  }
  return undefined;
}

export function truncateTitle(value: string, maxChars: number): string {
  const singleLine = value.replaceAll("\n", " ");
  return Array.from(singleLine).length <= maxChars
    ? singleLine
    : `${Array.from(singleLine).slice(0, maxChars).join("")}...`;
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
    const size = knownSize ?? (await backend.fileSize(this.filePath));
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

export type TmuxStatus = {
  tab_id: string;
  environment_id: string;
  session_id: string | null;
  tmux_session: string;
  running: boolean;
  transcript_path: string | null;
  resumed: boolean;
  busy: boolean;
  busy_started_at: number | null;
  permission_mode: string;
  fast_mode: boolean | null;
  observation: TmuxAgentObservation;
  info_events: Array<{
    id: string;
    kind: string;
    message: string;
    receivedAt: string;
  }>;
};

export const TMUX_INFO_EVENT_LIMIT = 20;
export const TMUX_INFO_EVENT_MESSAGE_MAX_UNITS = 2_000;

/**
 * Truncates an untrusted hook message to at most
 * {@link TMUX_INFO_EVENT_MESSAGE_MAX_UNITS} UTF-16 units without splitting a
 * surrogate pair.
 *
 * The bound is in UTF-16 units, not code points, so worst-case retained size is
 * the 4KB the previous `.slice(0, 2000)` gave rather than double it. Iteration
 * stops at the bound: `Array.from(message)` would first allocate one entry per
 * code point of the whole payload before slicing it back down.
 */
export function boundedInfoEventMessage(message: string): string {
  if (message.length <= TMUX_INFO_EVENT_MESSAGE_MAX_UNITS) return message;
  const retained: string[] = [];
  let units = 0;
  for (const codePoint of message) {
    if (units + codePoint.length > TMUX_INFO_EVENT_MESSAGE_MAX_UNITS) break;
    retained.push(codePoint);
    units += codePoint.length;
  }
  return retained.join("");
}

export function permissionModeFromTranscriptLine(line: unknown): string | undefined {
  if (!line || typeof line !== "object") return undefined;
  const record = line as Record<string, unknown>;
  return record.type === "permission-mode" && typeof record.permissionMode === "string"
    ? record.permissionMode
    : undefined;
}

export function permissionModeFromPane(snapshot: string): string | undefined {
  const normalized = snapshot.toLowerCase().split("\n").slice(-6).join("\n");
  if (normalized.includes("plan mode on")) return "plan";
  if (normalized.includes("bypass permissions on")) return "bypassPermissions";
  if (normalized.includes("accept edits on") || normalized.includes("edit automatically on"))
    return "acceptEdits";
  if (normalized.includes("auto mode on")) return "auto";
  if (normalized.includes("ask before edits on") || normalized.includes("manual mode on"))
    return "default";
  if (normalized.includes("don't ask on") || normalized.includes("dont ask on")) return "dontAsk";
  return undefined;
}

/** The `exec` surface the thinking-display probe needs, so it can be tested without a backend. */
export type ProbeExec = (args: string[], stdin?: string, timeoutMs?: number) => Promise<ExecOutput>;

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
    probe.status !== 0 &&
    output.includes(THINKING_DISPLAY_FLAG) &&
    // A future CLI that rejects an unknown option here would also name the
    // flag; only an argument-validation failure means it is supported.
    !output.toLowerCase().includes("unknown option")
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
