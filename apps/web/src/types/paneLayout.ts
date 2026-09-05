import type { TabType } from "@/contexts";
import {
  isNativeAgentTabData,
  type NativeAgentTabData as ProtocolNativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
export {
  LEGACY_PANE_LAYOUT_VERSION,
  PANE_LAYOUT_VERSION,
  PROVIDER_NATIVE_PANE_LAYOUT_VERSION,
} from "@orkestrator/protocol/pane-layout";

/**
 * Version 2 makes pane and tab selection authoritative in the shared layout.
 * Version 1 records used canonical first-pane/first-tab pointers and kept the
 * user's real selection in renderer-local storage.
 */
export interface PersistedPaneLayout {
  version: number;
  environmentId: string;
  containerId: string | null;
  activePaneId: string;
  root: unknown;
  updatedAt: string;
  revision: number;
}

export interface PersistedPaneLayoutInput {
  version: number;
  containerId: string | null;
  activePaneId: string;
  root: PaneNode;
}

// Git file status for diff context
export type GitFileStatus = "M" | "A" | "D" | "?" | "R" | "C";

// Valid git status values for type guard
const VALID_GIT_STATUSES: readonly string[] = ["M", "A", "D", "?", "R", "C"];

/** Type guard to validate if a string is a valid GitFileStatus */
export function isGitFileStatus(value: unknown): value is GitFileStatus {
  return typeof value === "string" && VALID_GIT_STATUSES.includes(value);
}

// File data for file viewer tabs
export interface FileTabData {
  filePath: string;
  /** Latest one-based source location requested by a transcript link. */
  lineNumber?: number;
  columnNumber?: number;
  /** Changes on every navigation so repeated clicks reveal the location again. */
  navigationRequestId?: number;
  /** Container ID (for containerized environments) */
  containerId?: string;
  /** Worktree path (for local environments) */
  worktreePath?: string;
  /** Whether this is a local environment */
  isLocalEnvironment?: boolean;
  language?: string;
  // Diff-related fields
  /** Whether to show diff view instead of regular file view */
  isDiff?: boolean;
  /** Git status of the file (M=modified, A=added, D=deleted, ?=untracked) */
  gitStatus?: GitFileStatus;
  /** Target branch for comparison (e.g., "main") */
  baseBranch?: string;
}

// Data for Claude tmux chat tabs (CLI driven under tmux, native-style UI)
export interface ClaudeTmuxData {
  /** Container ID for the environment (undefined for local environments) */
  containerId?: string;
  /** Environment ID */
  environmentId: string;
  /** Whether this is a local environment (no container) */
  isLocal?: boolean;
}

/** Canonical provider-neutral data for every native agent tab. */
export type NativeAgentData = ProtocolNativeAgentTabData;
/** @deprecated Test/controller compatibility only; pane records use NativeAgentData. */
export type ClaudeNativeData = NativeAgentData;
/** @deprecated Test/controller compatibility only; pane records use NativeAgentData. */
export type CodexNativeData = NativeAgentData;
/** @deprecated Test/controller compatibility only; pane records use NativeAgentData. */
export type OpenCodeNativeData = NativeAgentData;

// Data for build pipeline tabs
export interface BuildTabData {
  /** Environment ID */
  environmentId: string;
  /** Build pipeline ID (links to buildPipelineStore) */
  pipelineId: string;
  /** Source ticket ID used by the build pipeline */
  taskId: string;
  /** Whether this is a local environment (no container) */
  isLocal?: boolean;
}

export interface LoopedReviewTabData {
  environmentId: string;
  workflowId: string;
  isLocal?: boolean;
}

export interface MultiReviewTabData {
  environmentId: string;
  workflowId: string;
  /** Opens the read-only provider transcript for one reviewer when present. */
  reviewerId?: string;
  isLocal?: boolean;
}

// Data for backend-local browser preview tabs
export interface BrowserTabData {
  /** User-facing backend-local URL. An empty string opens the browser start screen. */
  url: string;
  /**
   * Durable navigation history for the iframe preview. A native (Electron)
   * preview keeps its history in Chromium, so `BrowserTab` neither maintains
   * nor reads this there; see `boundBrowserHistory` for the shared bounds.
   */
  history?: string[];
  historyIndex?: number;
}

// Tab information stored in pane leaves
export interface TabInfo {
  id: string;
  type: TabType;
  fileData?: FileTabData;
  /** Data for claude-tmux tabs */
  claudeTmuxData?: ClaudeTmuxData;
  /** The only native-agent identity. `platform: undefined` is unassigned. */
  nativeAgentData?: NativeAgentData;
  /** Data for claude-build tabs */
  buildTabData?: BuildTabData;
  /** Data for dedicated structured/looped review tabs. */
  loopedReviewTabData?: LoopedReviewTabData;
  /** Data for backend-owned Multi Review tabs. */
  multiReviewTabData?: MultiReviewTabData;
  /** Data for browser tabs */
  browserData?: BrowserTabData;
  /** Initial prompt to send to agent (only for claude/opencode tabs) */
  initialPrompt?: string;
  /** Initial commands to execute (only for plain terminal tabs) */
  initialCommands?: string[];
  /** Optional tab chrome title; the tab number is appended by the tab bar. */
  displayTitle?: string;
  /** True when the tab was launched from the review workflow. */
  isReviewTab?: boolean;
  /** One-shot model selected when the agent tab was created. */
  initialAgentModel?: string;
  /** One-shot reasoning effort or provider variant selected at creation. */
  initialReasoningEffort?: string;
  /** One-shot Build/Plan selection applied when the agent tab is locked. */
  initialConversationMode?: "build" | "plan";
  /** One-shot fast-mode selection applied when the agent tab is locked. */
  initialFastMode?: boolean;
  /** One-shot execution profile applied before the opening prompt is sent. */
  initialExecutionProfileId?: string;
  /**
   * Durable provider-to-provider conversation handoff rendered ahead of this
   * tab's native transcript. The pane layout stores only this small reference;
   * the sensitive transcript lives in backend handoff storage.
   */
  agentHandoffId?: string;
  /**
   * A handoff this tab dispatched whose snapshot has been deleted, retained so
   * the bootstrap prompt stays hidden. Resuming another session detaches (and
   * deletes) the imported transcript, but that prompt remains the destination
   * session's first message; without the id it would render as a raw JSON blob.
   */
  consumedAgentHandoffId?: string;
  /** Whether this tab runs setup scripts (used to track completion) */
  isSetupTab?: boolean;
  /** Backend owns PTY creation and bootstrap; the renderer may only attach. */
  backendManagedTerminal?: boolean;
  /** Exact backend-owned PTY identity to attach to. */
  backendTerminalSessionId?: string;
}

/** Validate the one canonical identity before it reaches the adapter registry. */
export function getNativeAgentData(tab: TabInfo): NativeAgentData | null {
  return tab.type === "agent-native" && isNativeAgentTabData(tab.nativeAgentData)
    ? tab.nativeAgentData
    : null;
}

// A leaf pane contains tabs and content
export interface PaneLeaf {
  kind: "leaf";
  id: string;
  tabs: TabInfo[];
  activeTabId: string | null;
}

// A split pane contains exactly two children (either leaves or nested splits)
export interface PaneSplit {
  kind: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: [PaneNode, PaneNode]; // Always exactly 2 children
  sizes: [number, number]; // Percentages (should sum to 100)
  depth: number; // Track nesting depth (max 9)
}

// A pane node is either a leaf or a split
export type PaneNode = PaneLeaf | PaneSplit;

// Direction for edge drop zones
export type EdgeDirection = "left" | "right" | "top" | "bottom";

// Droppable ID types for drag-and-drop
export type DroppableId =
  | `tabbar:${string}` // For tab reorder/move within tabbar
  | `edge:${string}:${EdgeDirection}`; // For edge drops to create splits

// Draggable ID type for tabs
export type DraggableTabId = `tab:${string}:pane:${string}`;

// Helper type guards
export function isPaneLeaf(node: PaneNode): node is PaneLeaf {
  return node.kind === "leaf";
}

export function isPaneSplit(node: PaneNode): node is PaneSplit {
  return node.kind === "split";
}

// Helper to parse draggable tab ID
export function parseDraggableTabId(id: string): { tabId: string; paneId: string } | null {
  const match = id.match(/^tab:(.+):pane:(.+)$/);
  if (!match) return null;
  return { tabId: match[1]!, paneId: match[2]! };
}

// Helper to parse edge droppable ID
export function parseEdgeDroppableId(
  id: string,
): { paneId: string; direction: EdgeDirection } | null {
  const match = id.match(/^edge:(.+):(left|right|top|bottom)$/);
  if (!match) return null;
  return { paneId: match[1]!, direction: match[2] as EdgeDirection };
}

// Helper to create IDs
export function createDraggableTabId(tabId: string, paneId: string): DraggableTabId {
  return `tab:${tabId}:pane:${paneId}`;
}

export function createEdgeDroppableId(paneId: string, direction: EdgeDirection): DroppableId {
  return `edge:${paneId}:${direction}`;
}

export function createTabbarDroppableId(paneId: string): DroppableId {
  return `tabbar:${paneId}`;
}

// Maximum nesting depth for splits
export const MAX_SPLIT_DEPTH = 9;
