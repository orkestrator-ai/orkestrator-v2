// State for the Claude tmux mode tabs.
//
// We deliberately emit `ClaudeMessage` (the same shape used by Claude native
// mode), then normalize it at the UI boundary so tmux mode uses the shared
// native message renderer.
//
// Keyed by an environment-scoped tab key (each tab owns its own claude
// session); the underlying environmentId is recorded on each tab's state so
// consumers don't need to thread it through separately.

import { create } from "zustand";
import type {
  HookEventKind,
  TranscriptLine,
  TranscriptContent,
} from "@/lib/claude-tmux-client";
import {
  ERROR_MESSAGE_PREFIX,
  type ClaudeEffortLevel,
  type ClaudeMessage,
  type ClaudeMessagePart,
  type QuestionInfo,
  type ToolDiffMetadata,
} from "@/lib/claude-client";
import type { FileMention } from "@/types";

export function createClaudeTmuxStateKey(environmentId: string, tabId: string): string {
  return `env:${environmentId}:tab:${tabId}`;
}

export function getEnvironmentIdFromClaudeTmuxStateKey(stateKey: string): string | null {
  const match = stateKey.match(/^env:([^:]+):tab:/);
  return match?.[1] ?? null;
}

function findScopedTabState(
  tabs: Map<string, TmuxTabState>,
  tabId: string,
): TmuxTabState | null {
  const suffix = `:tab:${tabId}`;
  let found: TmuxTabState | null = null;
  for (const [key, value] of tabs) {
    if (!key.endsWith(suffix)) continue;
    if (found) return null;
    found = value;
  }
  return found;
}

/** A blocking PreToolUse hook event awaiting the user's decision. */
export interface TmuxPendingApproval {
  eventId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  payload: unknown;
  receivedAt: string;
}

/** Structured AskUserQuestion hook awaiting the user's answers. */
export interface TmuxPendingQuestion {
  eventId: string;
  questions: QuestionInfo[];
  toolInput: Record<string, unknown>;
  payload: unknown;
  receivedAt: string;
}

/** Structured ExitPlanMode hook awaiting plan approval. */
export interface TmuxPendingPlan {
  eventId: string;
  plan: string | null;
  planFilePath: string | null;
  allowedPrompts: unknown[];
  toolInput: Record<string, unknown>;
  payload: unknown;
  receivedAt: string;
}

/** PermissionRequest hook awaiting an allow/deny decision. */
export interface TmuxPendingPermission {
  eventId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  permissionSuggestions: unknown[];
  payload: unknown;
  receivedAt: string;
}

/** MCP Elicitation hook awaiting form/url response. */
export interface TmuxPendingElicitation {
  eventId: string;
  mcpServerName: string;
  message: string;
  mode: string | null;
  url: string | null;
  requestedSchema: Record<string, unknown> | null;
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

export interface TmuxAttachment {
  id: string;
  type: "image";
  path: string;
  previewUrl: string;
  name: string;
}

export interface TmuxQueuedMessage {
  id: string;
  text: string;
  attachments: TmuxAttachment[];
}

interface TmuxTabState {
  /** Workspace this tab belongs to. */
  environmentId: string | null;
  /** Claude Code session ID assigned (or resumed) by the backend. */
  sessionId: string | null;
  /** True once the tmux session is up. */
  running: boolean;
  /** Claude-shaped messages, normalized by native tab renderers. */
  messages: ClaudeMessage[];
  pendingApprovals: TmuxPendingApproval[];
  pendingQuestions: TmuxPendingQuestion[];
  pendingPlans: TmuxPendingPlan[];
  pendingPermissions: TmuxPendingPermission[];
  pendingElicitations: TmuxPendingElicitation[];
  infoEvents: TmuxInfoEvent[];
  /** True if this tab is replaying a previously-recorded session. */
  resumed: boolean;
  /**
   * True while we believe Claude is mid-turn (between a `UserPromptSubmit`
   * hook — or an optimistic flip on local submit — and the next top-level
   * `Stop` hook). Drives the "Claude is thinking…" indicator, mirroring native
   * mode's `session.isLoading`.
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
  pendingQuestions: [],
  pendingPlans: [],
  pendingPermissions: [],
  pendingElicitations: [],
  infoEvents: [],
  resumed: false,
  busy: false,
  busyStartedAt: null,
});

interface ClaudeTmuxState {
  tabs: Map<string, TmuxTabState>;
  attachments: Map<string, TmuxAttachment[]>;
  draftText: Map<string, string>;
  draftMentions: Map<string, FileMention[]>;
  messageQueue: Map<string, TmuxQueuedMessage[]>;
  // Effort is a per-tab *preference* (like the model default), so it
  // intentionally survives resetTab and seeds the next launch in that tab.
  effortLevels: Map<string, ClaudeEffortLevel>;

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
  replaceTranscript: (tabId: string, lines: TranscriptLine[]) => void;
  addPendingApproval: (tabId: string, approval: TmuxPendingApproval) => void;
  removePendingApproval: (tabId: string, eventId: string) => void;
  addPendingQuestion: (tabId: string, question: TmuxPendingQuestion) => void;
  removePendingQuestion: (tabId: string, eventId: string) => void;
  addPendingPlan: (tabId: string, plan: TmuxPendingPlan) => void;
  removePendingPlan: (tabId: string, eventId: string) => void;
  addPendingPermission: (tabId: string, permission: TmuxPendingPermission) => void;
  removePendingPermission: (tabId: string, eventId: string) => void;
  addPendingElicitation: (tabId: string, elicitation: TmuxPendingElicitation) => void;
  removePendingElicitation: (tabId: string, eventId: string) => void;
  replacePendingHooks: (
    tabId: string,
    pending: {
      approvals: TmuxPendingApproval[];
      questions: TmuxPendingQuestion[];
      plans: TmuxPendingPlan[];
      permissions: TmuxPendingPermission[];
      elicitations: TmuxPendingElicitation[];
    },
  ) => void;
  pushInfoEvent: (tabId: string, event: TmuxInfoEvent) => void;
  dismissInfoEvent: (tabId: string, id: string) => void;
  setBusy: (tabId: string, busy: boolean) => void;

  addAttachment: (tabId: string, attachment: TmuxAttachment) => void;
  removeAttachment: (tabId: string, attachmentId: string) => void;
  clearAttachments: (tabId: string) => void;
  getAttachments: (tabId: string) => TmuxAttachment[];

  setDraftText: (tabId: string, text: string) => void;
  getDraftText: (tabId: string) => string;
  setDraftMentions: (tabId: string, mentions: FileMention[]) => void;
  getDraftMentions: (tabId: string) => FileMention[];

  // Read via `effortLevels` directly; the "high" default lives with the
  // component's DEFAULT_EFFORT so there is a single source for it.
  setEffortLevel: (tabId: string, effort: ClaudeEffortLevel) => void;

  addToQueue: (tabId: string, message: TmuxQueuedMessage) => void;
  removeFromQueue: (tabId: string) => TmuxQueuedMessage | undefined;
  removeQueueItem: (tabId: string, messageId: string) => void;
  moveQueueItem: (tabId: string, fromIndex: number, toIndex: number) => void;
  clearQueue: (tabId: string) => void;
  getQueueLength: (tabId: string) => number;
  getQueuedMessages: (tabId: string) => TmuxQueuedMessage[];

  getTab: (tabId: string) => TmuxTabState;
}

const EMPTY_ATTACHMENTS: TmuxAttachment[] = [];
const EMPTY_MENTIONS: FileMention[] = [];
const EMPTY_QUEUE: TmuxQueuedMessage[] = [];

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
  attachments: new Map(),
  draftText: new Map(),
  draftMentions: new Map(),
  messageQueue: new Map(),
  effortLevels: new Map(),

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
    set((state) => {
      const attachments = new Map(state.attachments);
      const draftText = new Map(state.draftText);
      const draftMentions = new Map(state.draftMentions);
      const messageQueue = new Map(state.messageQueue);
      attachments.delete(tabId);
      draftText.delete(tabId);
      draftMentions.delete(tabId);
      messageQueue.delete(tabId);
      return {
        ...patchTab(state, tabId, () => emptyTabState()),
        attachments,
        draftText,
        draftMentions,
        messageQueue,
      };
    }),

  applyTranscriptLine: (tabId, line) =>
    set((state) =>
      patchTab(state, tabId, (s) => applyLine(s, line)),
    ),

  replaceTranscript: (tabId, lines) =>
    set((state) =>
      patchTab(state, tabId, (current) =>
        lines.reduce(applyLine, { ...current, messages: [] }),
      ),
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

  addPendingQuestion: (tabId, question) =>
    set((state) =>
      patchTab(state, tabId, (s) =>
        s.pendingQuestions.some((q) => q.eventId === question.eventId)
          ? s
          : { ...s, pendingQuestions: [...s.pendingQuestions, question] },
      ),
    ),

  removePendingQuestion: (tabId, eventId) =>
    set((state) =>
      patchTab(state, tabId, (s) => ({
        ...s,
        pendingQuestions: s.pendingQuestions.filter((q) => q.eventId !== eventId),
      })),
    ),

  addPendingPlan: (tabId, plan) =>
    set((state) =>
      patchTab(state, tabId, (s) =>
        s.pendingPlans.some((p) => p.eventId === plan.eventId)
          ? s
          : { ...s, pendingPlans: [...s.pendingPlans, plan] },
      ),
    ),

  removePendingPlan: (tabId, eventId) =>
    set((state) =>
      patchTab(state, tabId, (s) => ({
        ...s,
        pendingPlans: s.pendingPlans.filter((p) => p.eventId !== eventId),
      })),
    ),

  addPendingPermission: (tabId, permission) =>
    set((state) =>
      patchTab(state, tabId, (s) =>
        s.pendingPermissions.some((p) => p.eventId === permission.eventId)
          ? s
          : { ...s, pendingPermissions: [...s.pendingPermissions, permission] },
      ),
    ),

  removePendingPermission: (tabId, eventId) =>
    set((state) =>
      patchTab(state, tabId, (s) => ({
        ...s,
        pendingPermissions: s.pendingPermissions.filter(
          (p) => p.eventId !== eventId,
        ),
      })),
    ),

  addPendingElicitation: (tabId, elicitation) =>
    set((state) =>
      patchTab(state, tabId, (s) =>
        s.pendingElicitations.some((e) => e.eventId === elicitation.eventId)
          ? s
          : { ...s, pendingElicitations: [...s.pendingElicitations, elicitation] },
      ),
    ),

  removePendingElicitation: (tabId, eventId) =>
    set((state) =>
      patchTab(state, tabId, (s) => ({
        ...s,
        pendingElicitations: s.pendingElicitations.filter(
          (e) => e.eventId !== eventId,
        ),
      })),
    ),

  replacePendingHooks: (tabId, pending) =>
    set((state) =>
      patchTab(state, tabId, (s) => ({
        ...s,
        pendingApprovals: pending.approvals,
        pendingQuestions: pending.questions,
        pendingPlans: pending.plans,
        pendingPermissions: pending.permissions,
        pendingElicitations: pending.elicitations,
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

  addAttachment: (tabId, attachment) =>
    set((state) => {
      const current = state.attachments.get(tabId) ?? [];
      const next = new Map(state.attachments);
      next.set(tabId, [...current, attachment]);
      return { attachments: next };
    }),

  removeAttachment: (tabId, attachmentId) =>
    set((state) => {
      const current = state.attachments.get(tabId) ?? [];
      const filtered = current.filter((a) => a.id !== attachmentId);
      if (filtered.length === current.length) return state;
      const next = new Map(state.attachments);
      next.set(tabId, filtered);
      return { attachments: next };
    }),

  clearAttachments: (tabId) =>
    set((state) => {
      const next = new Map(state.attachments);
      next.set(tabId, []);
      return { attachments: next };
    }),

  getAttachments: (tabId) => get().attachments.get(tabId) ?? EMPTY_ATTACHMENTS,

  setDraftText: (tabId, text) =>
    set((state) => {
      const next = new Map(state.draftText);
      if (text.length > 0) {
        next.set(tabId, text);
      } else {
        next.delete(tabId);
      }
      return { draftText: next };
    }),

  getDraftText: (tabId) => get().draftText.get(tabId) ?? "",

  setDraftMentions: (tabId, mentions) =>
    set((state) => {
      const next = new Map(state.draftMentions);
      if (mentions.length > 0) {
        next.set(tabId, mentions);
      } else {
        next.delete(tabId);
      }
      return { draftMentions: next };
    }),

  setEffortLevel: (tabId, effort) =>
    set((state) => {
      const next = new Map(state.effortLevels);
      next.set(tabId, effort);
      return { effortLevels: next };
    }),

  getDraftMentions: (tabId) =>
    get().draftMentions.get(tabId) ?? EMPTY_MENTIONS,

  addToQueue: (tabId, message) =>
    set((state) => {
      const current = state.messageQueue.get(tabId) ?? [];
      const next = new Map(state.messageQueue);
      next.set(tabId, [...current, message]);
      return { messageQueue: next };
    }),

  removeFromQueue: (tabId) => {
    let removed: TmuxQueuedMessage | undefined;
    set((state) => {
      const current = state.messageQueue.get(tabId) ?? [];
      if (current.length === 0) return state;
      const [first, ...rest] = current;
      removed = first;
      const next = new Map(state.messageQueue);
      next.set(tabId, rest);
      return { messageQueue: next };
    });
    return removed;
  },

  removeQueueItem: (tabId, messageId) =>
    set((state) => {
      const current = state.messageQueue.get(tabId) ?? [];
      const filtered = current.filter((m) => m.id !== messageId);
      if (filtered.length === current.length) return state;
      const next = new Map(state.messageQueue);
      next.set(tabId, filtered);
      return { messageQueue: next };
    }),

  moveQueueItem: (tabId, fromIndex, toIndex) =>
    set((state) => {
      const current = state.messageQueue.get(tabId) ?? [];
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= current.length ||
        toIndex >= current.length ||
        fromIndex === toIndex
      ) {
        return state;
      }
      const reordered = [...current];
      const [moved] = reordered.splice(fromIndex, 1);
      if (!moved) return state;
      reordered.splice(toIndex, 0, moved);
      const next = new Map(state.messageQueue);
      next.set(tabId, reordered);
      return { messageQueue: next };
    }),

  clearQueue: (tabId) =>
    set((state) => {
      const next = new Map(state.messageQueue);
      next.set(tabId, []);
      return { messageQueue: next };
    }),

  getQueueLength: (tabId) => get().messageQueue.get(tabId)?.length ?? 0,

  getQueuedMessages: (tabId) =>
    get().messageQueue.get(tabId) ?? EMPTY_QUEUE,

  getTab: (tabId) =>
    findScopedTabState(get().tabs, tabId) ??
    get().tabs.get(tabId) ??
    emptyTabState(),
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

export function compactConsecutiveAssistantMessages(
  messages: ClaudeMessage[],
): ClaudeMessage[] {
  const compacted: ClaudeMessage[] = [];

  for (const message of messages) {
    const previous = compacted[compacted.length - 1];
    if (previous && canCompactAssistantMessages(previous, message)) {
      const parts = [...previous.parts, ...message.parts];
      compacted[compacted.length - 1] = {
        ...previous,
        content: textOfParts(parts),
        parts,
      };
    } else {
      compacted.push(message);
    }
  }

  return compacted;
}

function canCompactAssistantMessages(
  previous: ClaudeMessage,
  next: ClaudeMessage,
): boolean {
  return (
    previous.role === "assistant" &&
    next.role === "assistant" &&
    !previous.id.startsWith(ERROR_MESSAGE_PREFIX) &&
    !next.id.startsWith(ERROR_MESSAGE_PREFIX)
  );
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

export function payloadToQuestion(
  eventId: string,
  payload: unknown,
): TmuxPendingQuestion {
  const p = (payload ?? {}) as Record<string, unknown>;
  const toolInput = payloadToolInput(p);
  const questions = Array.isArray(toolInput.questions)
    ? (toolInput.questions as QuestionInfo[])
    : [];
  return {
    eventId,
    questions,
    toolInput,
    payload,
    receivedAt: new Date().toISOString(),
  };
}

export function payloadToPlan(
  eventId: string,
  payload: unknown,
): TmuxPendingPlan {
  const p = (payload ?? {}) as Record<string, unknown>;
  const toolInput = payloadToolInput(p);
  return {
    eventId,
    plan: stringField(toolInput, "plan"),
    planFilePath:
      stringField(toolInput, "planFilePath") ?? stringField(toolInput, "plan_file_path"),
    allowedPrompts: Array.isArray(toolInput.allowedPrompts)
      ? toolInput.allowedPrompts
      : Array.isArray(toolInput.allowed_prompts)
        ? toolInput.allowed_prompts
        : [],
    toolInput,
    payload,
    receivedAt: new Date().toISOString(),
  };
}

export function payloadToPermission(
  eventId: string,
  payload: unknown,
): TmuxPendingPermission {
  const p = (payload ?? {}) as Record<string, unknown>;
  return {
    eventId,
    toolName: stringField(p, "tool_name") ?? stringField(p, "toolName") ?? "tool",
    toolInput: payloadToolInput(p),
    permissionSuggestions: Array.isArray(p.permission_suggestions)
      ? p.permission_suggestions
      : Array.isArray(p.permissionSuggestions)
        ? p.permissionSuggestions
        : [],
    payload,
    receivedAt: new Date().toISOString(),
  };
}

export function payloadToElicitation(
  eventId: string,
  payload: unknown,
): TmuxPendingElicitation {
  const p = (payload ?? {}) as Record<string, unknown>;
  const requestedSchema = p.requested_schema ?? p.requestedSchema;
  return {
    eventId,
    mcpServerName:
      stringField(p, "mcp_server_name") ?? stringField(p, "mcpServerName") ?? "MCP server",
    message: stringField(p, "message") ?? "MCP server requested input",
    mode: stringField(p, "mode"),
    url: stringField(p, "url"),
    requestedSchema:
      requestedSchema && typeof requestedSchema === "object"
        ? (requestedSchema as Record<string, unknown>)
        : null,
    payload,
    receivedAt: new Date().toISOString(),
  };
}

function payloadToolInput(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.tool_input ?? payload.toolInput;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : null;
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
