import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CURSOR_BACKGROUND_CONTINUATION_PREFIX,
  MAX_CURSOR_CHILD_RESULT_BYTES,
  MAX_MESSAGE_TEXT_BYTES,
  isObject,
  provider,
  workingDirectory,
  type SessionState,
} from "./acp-context.js";
import { schedulePersist } from "./acp-persist-writer.js";
import { boundTranscript, truncateUtf8 } from "./acp-transcript.js";
import { terminalAgentState } from "./acp-tools.js";

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_POLL_MS = 250;

export interface WatchableCursorChild {
  toolUseId: string;
  agentId: string;
  description?: string;
  transcriptPath: string;
}

export interface CursorChildWaitOutcome {
  toolUseId: string;
  agentId: string;
  description?: string;
  agentState: "finished" | "failed";
  resultText: string;
  timedOut: boolean;
}

/**
 * Cursor-only. Default on so a background Task's parent generation stays
 * running until the child's transcript ends. Tests force this off in
 * `spawnBridge` unless they opt in. Grok settles through `subagent_finished`
 * and must not enter this path even when the env var is set.
 */
export function cursorBackgroundContinueEnabled(): boolean {
  if (provider !== "cursor") return false;
  const raw = process.env.ACP_CURSOR_BACKGROUND_CONTINUE?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}

export function cursorTranscriptRoot(cwd: string = workingDirectory): string {
  const override = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR?.trim();
  if (override) return override;
  const slug = cwd.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\//g, "-");
  return join(homedir(), ".cursor", "projects", slug, "agent-transcripts");
}

export function cursorChildTranscriptPath(
  agentId: string,
  cwd: string = workingDirectory,
): string {
  return join(cursorTranscriptRoot(cwd), agentId, `${agentId}.jsonl`);
}

export function listWatchableCursorChildren(state: SessionState): WatchableCursorChild[] {
  const children: WatchableCursorChild[] = [];
  for (const toolUseId of state.activeSubagentToolIds) {
    const descriptor = state.activeSubagentDescriptors.get(toolUseId);
    const agentId = descriptor?.agentId?.trim();
    if (!descriptor || !agentId) continue;
    children.push({
      toolUseId,
      agentId,
      ...(descriptor.description ? { description: descriptor.description } : {}),
      transcriptPath: cursorChildTranscriptPath(agentId),
    });
  }
  return children;
}

export function cursorTranscriptTerminalState(
  contents: string,
): "finished" | "failed" | undefined {
  const lines = contents.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!isObject(parsed)) continue;
      if (parsed.type !== "turn_ended" && parsed.type !== "result") continue;
      const status = typeof parsed.status === "string"
        ? parsed.status
        : typeof parsed.subtype === "string"
          ? parsed.subtype
          : undefined;
      if (parsed.is_error === true) return "failed";
      return terminalAgentState(status) ?? "finished";
    } catch {
      // A tail read can start mid-line; skip anything that is not a record.
    }
  }
  return undefined;
}

export function cursorTranscriptAssistantText(contents: string): string {
  const chunks: string[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isObject(parsed)) continue;
      const text = assistantRecordText(parsed);
      if (text) chunks.push(text);
    } catch {
      // Same mid-line skip as the terminal-state scan.
    }
  }
  return truncateUtf8(chunks.join("\n\n").trim(), MAX_CURSOR_CHILD_RESULT_BYTES);
}

export async function waitForCursorChildTranscript(
  transcriptPath: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<"finished" | "failed" | "timeout" | "cancelled"> {
  const inspect = (): "finished" | "failed" | undefined => {
    if (!existsSync(transcriptPath)) return undefined;
    try {
      return cursorTranscriptTerminalState(readTranscriptTail(transcriptPath));
    } catch {
      return undefined;
    }
  };
  const immediate = inspect();
  if (immediate) return immediate;
  if (signal.aborted) return "cancelled";

  return await new Promise((resolvePromise) => {
    let settled = false;
    let watcher: FSWatcher | undefined;
    let dirWatcher: FSWatcher | undefined;
    const finish = (value: "finished" | "failed" | "timeout" | "cancelled"): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      watcher?.close();
      dirWatcher?.close();
      resolvePromise(value);
    };
    const onAbort = (): void => finish("cancelled");
    signal.addEventListener("abort", onAbort);
    const poll = setInterval(() => {
      const terminal = inspect();
      if (terminal) finish(terminal);
    }, TRANSCRIPT_POLL_MS);
    poll.unref();
    const timer = setTimeout(() => finish("timeout"), Math.max(0, timeoutMs));
    timer.unref();
    try {
      const directory = dirname(transcriptPath);
      if (existsSync(directory)) {
        dirWatcher = watch(directory, () => {
          const terminal = inspect();
          if (terminal) finish(terminal);
        });
      }
      if (existsSync(transcriptPath)) {
        watcher = watch(transcriptPath, () => {
          const terminal = inspect();
          if (terminal) finish(terminal);
        });
      }
    } catch {
      // Polling is enough when the platform cannot watch the path.
    }
  });
}

export async function waitForWatchableCursorChildren(
  children: WatchableCursorChild[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CursorChildWaitOutcome[]> {
  const started = Date.now();
  return Promise.all(children.map(async (child) => {
    const remaining = Math.max(0, timeoutMs - (Date.now() - started));
    const waited = await waitForCursorChildTranscript(child.transcriptPath, remaining, signal);
    const contents = existsSync(child.transcriptPath)
      ? readTranscriptTail(child.transcriptPath)
      : "";
    const timedOut = waited === "timeout";
    const cancelled = waited === "cancelled";
    const agentState = waited === "finished"
      ? "finished"
      : "failed";
    const resultText = timedOut
      ? "The child's transcript did not report completion within the wait budget. Treat the result as unavailable."
      : cancelled
        ? "The parent turn was cancelled before the child reported completion."
        : cursorTranscriptAssistantText(contents)
          || (waited === "failed"
            ? "The child ended without a text result."
            : "");
    return {
      toolUseId: child.toolUseId,
      agentId: child.agentId,
      ...(child.description ? { description: child.description } : {}),
      agentState,
      resultText,
      timedOut,
    };
  }));
}

export function formatCursorBackgroundContinuation(
  outcomes: CursorChildWaitOutcome[],
): string {
  const body = outcomes.map((outcome) => {
    const lines = [
      `Id: ${outcome.agentId}`,
      ...(outcome.description ? [`Task: ${outcome.description}`] : []),
      `Status: ${outcome.timedOut ? "timeout" : outcome.agentState}`,
      "",
      outcome.resultText,
    ];
    return lines.join("\n");
  }).join("\n\n");
  return [
    CURSOR_BACKGROUND_CONTINUATION_PREFIX,
    "",
    body,
    "",
    "Continue the original request. Do not relaunch these subagents. Use the results above.",
  ].join("\n");
}

export function pushContinuationUserMessage(state: SessionState, text: string): void {
  const content = truncateUtf8(text, MAX_MESSAGE_TEXT_BYTES);
  const userMessageId = randomBytes(12).toString("hex");
  state.messages.push({
    id: userMessageId,
    role: "user",
    content,
    parts: [{
      type: "text",
      content,
      sourcePartId: `${userMessageId}:0`,
      sourceMessageId: userMessageId,
    }],
    createdAt: new Date().toISOString(),
  });
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
}

function assistantRecordText(parsed: Record<string, unknown>): string | undefined {
  const role = parsed.role === "assistant" || parsed.type === "assistant";
  if (!role) return undefined;
  const message = isObject(parsed.message) ? parsed.message : parsed;
  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .map((part) => {
      if (!isObject(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (isObject(part.content) && typeof part.content.text === "string") {
        return part.content.text;
      }
      return "";
    })
    .join("");
  return text.trim() || undefined;
}

function readTranscriptTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
