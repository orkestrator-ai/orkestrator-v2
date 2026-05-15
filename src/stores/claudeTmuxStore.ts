// State for the Claude tmux mode tabs.
//
// We deliberately emit `ClaudeMessage` (the same shape used by Claude native
// mode) so the same `<ClaudeMessage>` renderer can be reused — that's what
// gives tmux mode visual parity with the native Agent SDK tab.
//
// Keyed by tabId (each tab owns its own claude session); the underlying
// environmentId is recorded on each tab's state so consumers don't need to
// thread it through separately.

import { create } from "zustand";
import type {
  HookEventKind,
  TranscriptLine,
  TranscriptContent,
} from "@/lib/claude-tmux-client";
import type {
  ClaudeMessage,
  ClaudeMessagePart,
  ToolDiffMetadata,
} from "@/lib/claude-client";

/** A blocking PreToolUse hook event awaiting the user's decision. */
export interface TmuxPendingApproval {
  eventId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  payload: unknown;
  receivedAt: string;
}

/** An informational hook event (Notification / Stop / etc.). */
export interface TmuxInfoEvent {
  id: string;
  kind: HookEventKind;
  message: string;
  receivedAt: string;
}

interface TmuxTabState {
  /** Workspace this tab belongs to. */
  environmentId: string | null;
  /** Claude Code session ID assigned (or resumed) by the backend. */
  sessionId: string | null;
  /** True once the tmux session is up. */
  running: boolean;
  /** Native-shaped messages, ready for `<ClaudeMessage>`. */
  messages: ClaudeMessage[];
  pendingApprovals: TmuxPendingApproval[];
  infoEvents: TmuxInfoEvent[];
  /** True if this tab is replaying a previously-recorded session. */
  resumed: boolean;
  /**
   * True while we believe Claude is mid-turn (between a `UserPromptSubmit`
   * hook — or an optimistic flip on local submit — and the next `Stop` or
   * `SubagentStop` hook). Drives the "Claude is thinking…" indicator,
   * mirroring native mode's `session.isLoading`.
   */
  busy: boolean;
  /** Wall-clock when busy flipped to true, for the elapsed counter. */
  busyStartedAt: number | null;
}

const emptyTabState = (): TmuxTabState => ({
  environmentId: null,
  sessionId: null,
  running: false,
  messages: [],
  pendingApprovals: [],
  infoEvents: [],
  resumed: false,
  busy: false,
  busyStartedAt: null,
});

interface ClaudeTmuxState {
  tabs: Map<string, TmuxTabState>;

  setRunning: (
    tabId: string,
    running: boolean,
    info?: {
      environmentId?: string | null;
      sessionId?: string | null;
      resumed?: boolean;
    },
  ) => void;
  resetTab: (tabId: string) => void;
  applyTranscriptLine: (tabId: string, line: TranscriptLine) => void;
  addPendingApproval: (tabId: string, approval: TmuxPendingApproval) => void;
  removePendingApproval: (tabId: string, eventId: string) => void;
  pushInfoEvent: (tabId: string, event: TmuxInfoEvent) => void;
  dismissInfoEvent: (tabId: string, id: string) => void;
  setBusy: (tabId: string, busy: boolean) => void;

  getTab: (tabId: string) => TmuxTabState;
}

function patchTab(
  state: ClaudeTmuxState,
  tabId: string,
  patch: (s: TmuxTabState) => TmuxTabState,
): { tabs: Map<string, TmuxTabState> } {
  const next = new Map(state.tabs);
  const current = next.get(tabId) ?? emptyTabState();
  next.set(tabId, patch(current));
  return { tabs: next };
}

export const useClaudeTmuxStore = create<ClaudeTmuxState>()((set, get) => ({
  tabs: new Map(),

  setRunning: (tabId, running, info) =>
    set((state) =>
      patchTab(state, tabId, (s) => ({
        ...s,
        running,
        environmentId: info?.environmentId ?? s.environmentId,
        sessionId:
          info?.sessionId === undefined ? s.sessionId : info.sessionId,
        resumed: info?.resumed ?? s.resumed,
      })),
    ),

  resetTab: (tabId) =>
    set((state) => patchTab(state, tabId, () => emptyTabState())),

  applyTranscriptLine: (tabId, line) =>
    set((state) =>
      patchTab(state, tabId, (s) => applyLine(s, line)),
    ),

  addPendingApproval: (tabId, approval) =>
    set((state) =>
      patchTab(state, tabId, (s) => {
        if (s.pendingApprovals.some((a) => a.eventId === approval.eventId)) {
          return s;
        }
        return { ...s, pendingApprovals: [...s.pendingApprovals, approval] };
      }),
    ),

  removePendingApproval: (tabId, eventId) =>
    set((state) =>
      patchTab(state, tabId, (s) => ({
        ...s,
        pendingApprovals: s.pendingApprovals.filter(
          (a) => a.eventId !== eventId,
        ),
      })),
    ),

  pushInfoEvent: (tabId, event) =>
    set((state) =>
      patchTab(state, tabId, (s) => ({
        ...s,
        infoEvents: [...s.infoEvents.slice(-19), event],
      })),
    ),

  dismissInfoEvent: (tabId, id) =>
    set((state) =>
      patchTab(state, tabId, (s) => ({
        ...s,
        infoEvents: s.infoEvents.filter((e) => e.id !== id),
      })),
    ),

  setBusy: (tabId, busy) =>
    set((state) =>
      patchTab(state, tabId, (s) => {
        if (s.busy === busy) return s;
        return {
          ...s,
          busy,
          busyStartedAt: busy ? Date.now() : null,
        };
      }),
    ),

  getTab: (tabId) => get().tabs.get(tabId) ?? emptyTabState(),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Apply a JSONL transcript line to the tab state. Two distinct flows:
 *
 *  - `user` lines that carry *only* `tool_result` parts are merged into the
 *    parts array of the previous assistant message (so the result is shown
 *    inline under the tool invocation), instead of appearing as a separate
 *    "USER" bubble.
 *  - Everything else replaces or appends a message keyed by `uuid`.
 */
function applyLine(state: TmuxTabState, line: TranscriptLine): TmuxTabState {
  if (line.type !== "user" && line.type !== "assistant" && line.type !== "system") {
    return state;
  }

  const id = lineId(line);
  const role = (line.message?.role ?? line.type) as ClaudeMessage["role"];
  const content =
    (line.message?.content as TranscriptLine["content"]) ?? line.content;
  const timestamp =
    typeof line.timestamp === "string" ? line.timestamp : new Date().toISOString();

  const parts = contentToParts(content);

  const allToolResults =
    role === "user" &&
    parts.length > 0 &&
    parts.every((p) => p.type === "tool-result");
  if (allToolResults) {
    const merged = mergeToolResultsIntoPrior(state.messages, parts);
    if (merged) return { ...state, messages: merged };
  }

  if (role === "user" && parts.length === 0) {
    return state;
  }

  const newMessage: ClaudeMessage = {
    id,
    role,
    content: textOfParts(parts),
    parts,
    timestamp,
  };

  const existingIdx = state.messages.findIndex((m) => m.id === id);
  if (existingIdx >= 0) {
    const updated = [...state.messages];
    updated[existingIdx] = mergeMessage(updated[existingIdx]!, newMessage);
    return { ...state, messages: updated };
  }
  return { ...state, messages: [...state.messages, newMessage] };
}

function lineId(line: TranscriptLine): string {
  if (typeof line.uuid === "string" && line.uuid) return line.uuid;
  if (typeof line.timestamp === "string" && line.timestamp) return line.timestamp;
  return stableHash(line);
}

function contentToParts(
  content: TranscriptLine["content"],
): ClaudeMessagePart[] {
  if (typeof content === "string") {
    const cleaned = cleanUserText(content);
    return cleaned.length > 0 ? [{ type: "text", content: cleaned }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts: ClaudeMessagePart[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as TranscriptContent;
    switch (c.type) {
      case "text": {
        if (!c.text) break;
        const cleaned = cleanUserText(c.text);
        if (cleaned.length > 0) {
          parts.push({ type: "text", content: cleaned });
        }
        break;
      }
      case "thinking":
        if (c.thinking) parts.push({ type: "thinking", content: c.thinking });
        break;
      case "tool_use": {
        const toolArgs = (c.input ?? {}) as Record<string, unknown>;
        parts.push({
          type: "tool-invocation",
          toolName: c.name,
          toolUseId: c.id,
          toolArgs,
          toolState: "pending",
          toolTitle: c.name,
          toolDiff: buildToolDiff(c.name, toolArgs),
        });
        break;
      }
      case "tool_result": {
        const txt = toolResultText(c.content);
        parts.push({
          type: "tool-result",
          toolUseId: c.tool_use_id,
          toolState: c.is_error ? "failure" : "success",
          toolOutput: c.is_error ? undefined : txt,
          toolError: c.is_error ? txt : undefined,
        });
        break;
      }
    }
  }
  return parts;
}

/**
 * Strip Claude Code's slash-command meta wrappers and any embedded ANSI
 * escape sequences from a user-channel text payload, returning the trimmed
 * remainder. When a user runs a CLI slash command (e.g. `/model`), Claude
 * Code injects synthetic user-role JSONL lines containing tags like
 * `<command-name>`, `<command-message>`, `<command-args>`,
 * `<local-command-caveat>`, and `<local-command-stdout>` (often with raw
 * terminal escape bytes inside). Those tags are noise from the chat
 * renderer's point of view — if a "user" message contains nothing but
 * those, we drop it; otherwise we surface only the cleaned remainder.
 */
function cleanUserText(text: string): string {
  // Remove the known wrapper tag pairs (and any nested content).
  const stripped = text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, "")
    .replace(/<command-stdout>[\s\S]*?<\/command-stdout>/g, "")
    .replace(/<command-stderr>[\s\S]*?<\/command-stderr>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    // Strip ANSI/CSI escape sequences (e.g. "\x1b[1m") in case any leaked
    // through — these otherwise render as Unicode replacement glyphs.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    // Defensive fallback for stripped-ESC byte that arrived as plain text.
    .replace(/�\[[0-9;?]*[A-Za-z]/g, "");
  return stripped.trim();
}

/**
 * Derive `toolDiff` metadata from a raw `tool_use.input` payload so the
 * `EditToolPart` renderer can show the file path and diff/line-count.
 */
function buildToolDiff(
  toolName: string | undefined,
  input: Record<string, unknown>,
): ToolDiffMetadata | undefined {
  if (!toolName) return undefined;
  const name = toolName.toLowerCase();

  const filePath =
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.notebook_path === "string" && input.notebook_path) ||
    (typeof input.path === "string" && input.path) ||
    undefined;

  switch (name) {
    case "edit":
    case "file_edit":
    case "str_replace_editor":
    case "replace": {
      const before =
        typeof input.old_string === "string" ? input.old_string : undefined;
      const after =
        typeof input.new_string === "string" ? input.new_string : undefined;
      return { filePath, before, after };
    }
    case "write":
    case "create_file": {
      const after = typeof input.content === "string" ? input.content : undefined;
      return { filePath, before: "", after };
    }
    case "multiedit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const beforeChunks: string[] = [];
      const afterChunks: string[] = [];
      for (const edit of edits) {
        if (!edit || typeof edit !== "object") continue;
        const e = edit as Record<string, unknown>;
        if (typeof e.old_string === "string") beforeChunks.push(e.old_string);
        if (typeof e.new_string === "string") afterChunks.push(e.new_string);
      }
      return {
        filePath,
        before: beforeChunks.join("\n"),
        after: afterChunks.join("\n"),
      };
    }
    case "notebookedit": {
      const after =
        typeof input.new_source === "string" ? input.new_source : undefined;
      return { filePath, after };
    }
    default:
      return filePath ? { filePath } : undefined;
  }
}

function toolResultText(
  raw: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  return raw
    .map((c) => ("text" in c && c.text) || "")
    .filter((t) => t.length > 0)
    .join("\n");
}

function textOfParts(parts: ClaudeMessagePart[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.content ?? "")
    .join("\n");
}

function mergeToolResultsIntoPrior(
  messages: ClaudeMessage[],
  resultParts: ClaudeMessagePart[],
): ClaudeMessage[] | null {
  const resultIds = new Set(
    resultParts
      .map((p) => p.toolUseId)
      .filter((x): x is string => typeof x === "string"),
  );
  if (resultIds.size === 0) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const hasMatch = msg.parts.some(
      (p) => p.type === "tool-invocation" && p.toolUseId && resultIds.has(p.toolUseId),
    );
    if (!hasMatch) continue;

    const updatedParts: ClaudeMessagePart[] = [];
    for (const p of msg.parts) {
      updatedParts.push(p);
      if (p.type === "tool-invocation" && p.toolUseId && resultIds.has(p.toolUseId)) {
        const match = resultParts.find((r) => r.toolUseId === p.toolUseId);
        if (match) {
          updatedParts[updatedParts.length - 1] = {
            ...p,
            toolState: match.toolState,
            toolOutput: match.toolOutput ?? p.toolOutput,
            toolError: match.toolError ?? p.toolError,
          };
          updatedParts.push(match);
        }
      }
    }

    const seen = new Set<string>();
    const deduped: ClaudeMessagePart[] = [];
    for (let j = updatedParts.length - 1; j >= 0; j--) {
      const p = updatedParts[j]!;
      if (p.type === "tool-result" && p.toolUseId) {
        if (seen.has(p.toolUseId)) continue;
        seen.add(p.toolUseId);
      }
      deduped.unshift(p);
    }

    const newMessages = [...messages];
    newMessages[i] = { ...msg, parts: deduped };
    return newMessages;
  }
  return null;
}

function mergeMessage(prev: ClaudeMessage, next: ClaudeMessage): ClaudeMessage {
  const parts = next.parts.length > 0 ? next.parts : prev.parts;
  return {
    ...prev,
    role: next.role || prev.role,
    content: textOfParts(parts),
    parts,
    timestamp: next.timestamp || prev.timestamp,
  };
}

function stableHash(line: TranscriptLine): string {
  const json = JSON.stringify(line);
  let h = 5381;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h + json.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(36)}`;
}

/** Build a `TmuxPendingApproval` from a hook payload. */
export function payloadToApproval(
  eventId: string,
  payload: unknown,
): TmuxPendingApproval {
  const p = (payload ?? {}) as Record<string, unknown>;
  const toolName =
    (typeof p.tool_name === "string" && p.tool_name) ||
    (typeof p.toolName === "string" && p.toolName) ||
    "tool";
  const toolInput =
    (p.tool_input as Record<string, unknown> | undefined) ??
    (p.toolInput as Record<string, unknown> | undefined) ??
    {};
  return {
    eventId,
    toolName,
    toolInput,
    payload,
    receivedAt: new Date().toISOString(),
  };
}

/** Build a `TmuxInfoEvent` from a non-blocking hook payload. */
export function payloadToInfoEvent(
  eventId: string,
  kind: HookEventKind,
  payload: unknown,
): TmuxInfoEvent {
  const p = (payload ?? {}) as Record<string, unknown>;
  const message =
    (typeof p.message === "string" && p.message) ||
    (typeof p.notification === "string" && p.notification) ||
    kind;
  return {
    id: eventId,
    kind,
    message,
    receivedAt: new Date().toISOString(),
  };
}
