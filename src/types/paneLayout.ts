import type { TabType } from "@/contexts";

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

// Data for OpenCode native chat tabs
export interface OpenCodeNativeData {
  /** Container ID for the environment (undefined for local environments) */
  containerId?: string;
  /** Environment ID */
  environmentId: string;
  /** Host port for the OpenCode server (assigned on server start) */
  hostPort?: number;
  /** Active session ID */
  sessionId?: string;
  /** Whether this is a local environment (no container) */
  isLocal?: boolean;
}

// Data for Claude native chat tabs
export interface ClaudeNativeData {
  /** Container ID for the environment (undefined for local environments) */
  containerId?: string;
  /** Environment ID */
  environmentId: string;
  /** Host port for the Claude bridge server (assigned on server start) */
  hostPort?: number;
  /** Active session ID */
  sessionId?: string;
  /** Whether this is a local environment (no container) */
  isLocal?: boolean;
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

// Data for Codex native chat tabs
export interface CodexNativeData {
  /** Container ID for the environment (undefined for local environments) */
  containerId?: string;
  /** Environment ID */
  environmentId: string;
  /** Host port for the Codex bridge server (assigned on server start) */
  hostPort?: number;
  /** Active session ID */
  sessionId?: string;
  /** Whether this is a local environment (no container) */
  isLocal?: boolean;
}

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

// Tab information stored in pane leaves
export interface TabInfo {
  id: string;
  type: TabType;
  fileData?: FileTabData;
  /** Data for opencode-native tabs */
  openCodeNativeData?: OpenCodeNativeData;
  /** Data for claude-native tabs */
  claudeNativeData?: ClaudeNativeData;
  /** Data for claude-tmux tabs */
  claudeTmuxData?: ClaudeTmuxData;
  /** Data for codex-native tabs */
  codexNativeData?: CodexNativeData;
  /** Data for claude-build tabs */
  buildTabData?: BuildTabData;
  /** Initial prompt to send to agent (only for claude/opencode tabs) */
  initialPrompt?: string;
  /** Initial commands to execute (only for plain terminal tabs) */
  initialCommands?: string[];
  /** Optional tab chrome title; the tab number is appended by the tab bar. */
  displayTitle?: string;
  /** True when the tab was launched from the review workflow. */
  isReviewTab?: boolean;
  /** Whether this tab runs setup scripts (used to track completion) */
  isSetupTab?: boolean;
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
export function parseEdgeDroppableId(id: string): { paneId: string; direction: EdgeDirection } | null {
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
