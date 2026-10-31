/**
 * Coordinator product surfaces: the worker-facing controls a coordinator was
 * given after the parity work (terminal launch, browser preview, tab editing,
 * Multi Review and planning launches, and the user-approved copy of the
 * checkout's uncommitted changes into a worker). See
 * `docs/architecture/coordinator.md` ("Worker surfaces").
 *
 * None of them reaches the project checkout: each targets a disposable worker
 * environment, and the one that reads the checkout's changes only creates a
 * request the user approves.
 */

/**
 * One coordinator mutation's idempotency record.
 *
 * Admitted (`pending`) before any side effect, under the coordinator store
 * lock, bound to a fingerprint of the caller's payload. The same `requestId`
 * with the same payload replays the stored result; with a different payload
 * it is refused. A pending receipt whose owner process died is reclaimed by
 * the next retry, which re-runs the action's own idempotent path.
 */
export interface CoordinatorActionReceipt {
  coordinatorId: string;
  projectId: string;
  conversationId: string;
  requestId: string;
  action: CoordinatorSurfaceAction;
  payloadHash: string;
  state: "pending" | "completed";
  /** Process materializing a pending receipt; never exposed as authority. */
  claimPid?: number;
  /** Bounded, content-free result replayed to an identical retry. */
  result?: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
}

export const COORDINATOR_SURFACE_ACTIONS = Object.freeze([
  "launch-terminal",
  "open-browser",
  "create-pr",
  "custom-fix",
  "launch-feature-plan",
  "request-root-changes",
  "propose-agents-md-update",
  "fork-worker",
  "request-worker-answer",
] as const);
export type CoordinatorSurfaceAction = (typeof COORDINATOR_SURFACE_ACTIONS)[number];

export function isCoordinatorSurfaceAction(value: unknown): value is CoordinatorSurfaceAction {
  return (
    typeof value === "string" && (COORDINATOR_SURFACE_ACTIONS as readonly string[]).includes(value)
  );
}

/** Receipts kept per store; the oldest completed ones are dropped first. */
export const MAX_COORDINATOR_ACTION_RECEIPTS = 2_000;
/** A stored result larger than this is replaced by `{ truncated: true }`. */
export const MAX_COORDINATOR_ACTION_RESULT_BYTES = 16 * 1024;

/**
 * Terminal tab kinds a coordinator may open in a worker. `cursor` has no
 * terminal CLI tab; the backend's terminal job command refuses it too.
 */
export const COORDINATOR_TERMINAL_TAB_TYPES = Object.freeze([
  "plain",
  "claude-tmux",
  "claude",
  "codex",
  "grok",
  "opencode",
  "pi",
] as const);
export type CoordinatorTerminalTabType = (typeof COORDINATOR_TERMINAL_TAB_TYPES)[number];

/** Tab edits a coordinator may make in a worker's pane layout. */
export const COORDINATOR_TAB_EDIT_OPERATIONS = Object.freeze(["focus", "close", "move"] as const);
export type CoordinatorTabEditOperation = (typeof COORDINATOR_TAB_EDIT_OPERATIONS)[number];

/** A file the root checkout has changed, as offered to the user. */
export interface RootChangeFile {
  path: string;
  /** Git porcelain status: modified, added, deleted, renamed or untracked. */
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  /** For a rename, the path it had at HEAD. */
  previousPath?: string;
}

/** The outcome the coordinator is mailed after the user acts on the request. */
export interface RootChangesApplyResult {
  state: "applied" | "declined" | "failed";
  environmentId: string;
  /** Files applied, in the order the patch carried them. */
  files?: string[];
  /** Content-free failure text (a git exit, a conflicting path). */
  error?: string;
}
