/**
 * Reads Claude Code and Codex conversations from their own history files on
 * this machine and reduces each to what the insight stage needs: the messages
 * people and agents wrote, the agents' replies, which tools ran (names and
 * counts only), tool errors and interruptions. Tool inputs and outputs, file
 * contents and thinking are never kept.
 *
 * Read-only. Sources:
 * - Claude: `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`) and each
 *   Orkestrator-managed Claude account's `projects/` under the data directory.
 * - Codex: `${CODEX_HOME:-~/.codex}/sessions/`.
 */
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/** A history file larger than this is read from its end only. */
export const MAX_TRANSCRIPT_BYTES = 24 * 1024 * 1024;
const MAX_FILES = 5000;

export type Provider = "claude" | "codex";

/** Who wrote a user-side message: a person typing, the system, or another agent. */
export type Origin = "typed" | "system" | "agent";

export interface UserMessage {
  role: "user";
  at: number;
  origin: Origin;
  text: string;
}

export interface AgentReply {
  role: "assistant";
  at: number;
  text: string;
  tools: Record<string, number>;
  toolErrors: number;
}

export interface Interruption {
  role: "interrupt";
  at: number;
}

export type TranscriptEntry = UserMessage | AgentReply | Interruption;

export interface Conversation {
  /** Provider-scoped id: `claude:<session>` or `codex:<thread>`. */
  id: string;
  provider: Provider;
  file: string;
  cwd: string;
  project: string;
  startedAt: number;
  lastAt: number;
  entries: TranscriptEntry[];
}

export interface TranscriptSources {
  claudeProjectDirs: string[];
  codexSessionDirs: string[];
}

/** Where this machine's histories are, given the app's data directory (for its managed Claude accounts). */
export function defaultSources(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): TranscriptSources {
  const home = os.homedir();
  const claudeAccounts = path.join(dataDir, "agent-accounts", "claude");
  let accounts: string[] = [];
  try {
    accounts = readdirSync(claudeAccounts).map((name) =>
      path.join(claudeAccounts, name, "projects"),
    );
  } catch {
    accounts = [];
  }
  return {
    claudeProjectDirs: [
      path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects"),
      ...accounts,
    ],
    codexSessionDirs: [path.join(env.CODEX_HOME || path.join(home, ".codex"), "sessions")],
  };
}

/**
 * The project a working directory belongs to: an Orkestrator worktree's
 * `<project>-<date>-<time>-<id>` folder names its project; otherwise the folder name.
 */
export function projectOf(cwd: string): string {
  const base = path.basename(cwd.replace(/\/+$/, ""));
  const worktree = /^(.+)-\d{8}-\d{6}-[0-9a-f]{12}$/.exec(base);
  if (worktree) return worktree[1]!;
  const parts = cwd.split(path.sep);
  const index = parts.lastIndexOf("workspaces");
  if (index >= 0 && parts[index + 1]) {
    const named = /^(.+)-\d{8}-\d{6}-[0-9a-f]{12}$/.exec(parts[index + 1]!);
    if (named) return named[1]!;
  }
  return base || "unknown";
}

function listJsonl(root: string, depth: number, out: string[], seen: Set<string>): void {
  if (out.length >= MAX_FILES || depth < 0) return;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(root, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) listJsonl(full, depth - 1, out, seen);
    else if (name.endsWith(".jsonl") && stat.isFile()) {
      let real = full;
      try {
        real = realpathSync(full);
      } catch {
        real = full;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(real);
      if (out.length >= MAX_FILES) return;
    }
  }
}

export interface TranscriptFile {
  provider: Provider;
  file: string;
  mtimeMs: number;
  size: number;
}

/** Every history file, deduplicated by real path, with its modification time. */
export function listTranscriptFiles(sources: TranscriptSources): TranscriptFile[] {
  const seen = new Set<string>();
  const result: TranscriptFile[] = [];
  const add = (provider: Provider, roots: string[], depth: number) => {
    const files: string[] = [];
    for (const root of roots) listJsonl(root, depth, files, seen);
    for (const file of files) {
      try {
        const stat = statSync(file);
        result.push({ provider, file, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // Gone since it was listed.
      }
    }
  };
  // Claude keeps `<project>/<session>.jsonl` (sub-agents one level deeper, skipped as sidechains).
  add("claude", sources.claudeProjectDirs, 2);
  // Codex keeps `YYYY/MM/DD/rollout-*.jsonl`.
  add("codex", sources.codexSessionDirs, 4);
  return result;
}

function readTail(file: string): string {
  const size = statSync(file).size;
  if (size <= MAX_TRANSCRIPT_BYTES) return readFileSync(file, "utf8");
  const buffer = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, MAX_TRANSCRIPT_BYTES, size - MAX_TRANSCRIPT_BYTES);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  return text.slice(text.indexOf("\n") + 1);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Text with injected reminders removed; empty when nothing a person wrote is left. */
function cleanUserText(text: string): string {
  return text.replace(SYSTEM_REMINDER, "").trim();
}

/** A whole part that is a tagged context block (`<environment_context>…`), not a message. */
function isContextBlock(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("<") && trimmed.endsWith(">") && !trimmed.startsWith("<orkestrator")) ||
    trimmed.startsWith("# AGENTS.md instructions")
  );
}

class EntryBuilder {
  readonly entries: TranscriptEntry[] = [];
  private reply: AgentReply | null = null;

  user(at: number, origin: Origin, text: string): void {
    this.reply = null;
    this.entries.push({ role: "user", at, origin, text });
  }

  interrupt(at: number): void {
    this.reply = null;
    this.entries.push({ role: "interrupt", at });
  }

  private current(at: number): AgentReply {
    if (!this.reply) {
      this.reply = { role: "assistant", at, text: "", tools: {}, toolErrors: 0 };
      this.entries.push(this.reply);
    }
    return this.reply;
  }

  text(at: number, text: string): void {
    const reply = this.current(at);
    reply.text = reply.text ? `${reply.text}\n${text}` : text;
  }

  tool(at: number, name: string): void {
    const reply = this.current(at);
    reply.tools[name] = (reply.tools[name] ?? 0) + 1;
  }

  toolError(at: number): void {
    if (this.reply) this.reply.toolErrors += 1;
    else this.current(at).toolErrors += 1;
  }
}

const INTERRUPTED = /^\[Request interrupted by user/;

export function parseClaude(file: string, text: string): Conversation | null {
  const builder = new EntryBuilder();
  let sessionId = path.basename(file, ".jsonl");
  let cwd = "";
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> | null;
    try {
      row = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!row || (row.type !== "user" && row.type !== "assistant") || row.isSidechain === true)
      continue;
    const at = Date.parse(String(row.timestamp ?? ""));
    if (!Number.isFinite(at)) continue;
    if (typeof row.sessionId === "string") sessionId = row.sessionId;
    if (typeof row.cwd === "string" && !cwd) cwd = row.cwd;
    first = Math.min(first, at);
    last = Math.max(last, at);
    const message = record(row.message);
    const content = message?.content;
    if (row.type === "user") {
      const originKind = record(row.origin)?.kind;
      const systemish = originKind === "task-notification" || row.promptSource === "system";
      const parts: string[] = [];
      if (typeof content === "string") parts.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) {
          const item = record(block);
          if (!item) continue;
          if (item.type === "tool_result") {
            if (item.is_error === true) builder.toolError(at);
          } else if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
          else if (item.type === "image") parts.push("[image]");
        }
      }
      for (const part of parts) {
        if (INTERRUPTED.test(part.trim())) {
          builder.interrupt(at);
          continue;
        }
        const cleaned = cleanUserText(part);
        if (!cleaned) continue;
        const origin: Origin = systemish
          ? "system"
          : cleaned.startsWith("<orkestrator") || cleaned.startsWith("<agent-mail")
            ? "agent"
            : isContextBlock(cleaned)
              ? "system"
              : "typed";
        builder.user(at, origin, cleaned);
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const item = record(block);
        if (!item) continue;
        if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
          builder.text(at, item.text.trim());
        } else if (item.type === "tool_use" && typeof item.name === "string") {
          builder.tool(at, item.name);
        }
      }
    }
  }
  if (!Number.isFinite(first) || builder.entries.length === 0) return null;
  return {
    id: `claude:${sessionId}`,
    provider: "claude",
    file,
    cwd,
    project: projectOf(cwd),
    startedAt: first,
    lastAt: last,
    entries: builder.entries,
  };
}

export function parseCodex(file: string, text: string): Conversation | null {
  const builder = new EntryBuilder();
  let threadId = path.basename(file, ".jsonl");
  let cwd = "";
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> | null;
    try {
      row = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!row) continue;
    const at = Date.parse(String(row.timestamp ?? ""));
    if (!Number.isFinite(at)) continue;
    const payload = record(row.payload);
    if (!payload) continue;
    if (row.type === "session_meta") {
      if (typeof payload.id === "string") threadId = payload.id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      continue;
    }
    if (row.type === "event_msg") {
      if (payload.type === "turn_aborted") {
        builder.interrupt(at);
        first = Math.min(first, at);
        last = Math.max(last, at);
      }
      continue;
    }
    if (row.type !== "response_item") continue;
    first = Math.min(first, at);
    last = Math.max(last, at);
    if (payload.type === "message") {
      const parts = Array.isArray(payload.content) ? payload.content : [];
      const texts = parts
        .map(record)
        .filter(
          (part): part is Record<string, unknown> => part !== null && typeof part.text === "string",
        )
        .map((part) => String(part.text));
      if (payload.role === "user") {
        for (const part of texts) {
          const cleaned = cleanUserText(part);
          if (!cleaned || isContextBlock(cleaned)) continue;
          const origin: Origin =
            cleaned.startsWith("<orkestrator") || cleaned.startsWith("<agent-mail")
              ? "agent"
              : "typed";
          builder.user(at, origin, cleaned);
        }
      } else if (payload.role === "assistant") {
        for (const part of texts) if (part.trim()) builder.text(at, part.trim());
      }
    } else if (
      (payload.type === "function_call" || payload.type === "custom_tool_call") &&
      typeof payload.name === "string"
    ) {
      builder.tool(at, payload.name);
    }
  }
  if (!Number.isFinite(first) || builder.entries.length === 0) return null;
  return {
    id: `codex:${threadId}`,
    provider: "codex",
    file,
    cwd,
    project: projectOf(cwd),
    startedAt: first,
    lastAt: last,
    entries: builder.entries,
  };
}

export function readConversation(file: TranscriptFile): Conversation | null {
  let text: string;
  try {
    text = readTail(file.file);
  } catch {
    return null;
  }
  return file.provider === "claude" ? parseClaude(file.file, text) : parseCodex(file.file, text);
}
