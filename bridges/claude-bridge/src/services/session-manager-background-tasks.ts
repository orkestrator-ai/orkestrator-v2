// Session Manager Service
// Handles session state and interacts with Claude Agent SDK

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ImageBlockParam,
  TextBlockParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  ModelInfo,
  SessionState,
  NormalizedMessage,
  NormalizedPart,
  ToolDiffMetadata,
  QuestionInfo,
  QuestionRequest,
  PlanApprovalRequest,
  PromptOptions,
  SessionInitData,
  McpServerRuntimeStatus,
  PluginRuntimeStatus,
  SdkMessageBase,
  SdkCompactBoundaryMessage,
  SdkResultMessage,
  SdkSystemMessage,
  TaskListSnapshot,
  MessagePatchEventData,
  SessionUsageSnapshot,
  BackgroundTaskSnapshot,
  SessionRateLimitWindow,
  StopBackgroundTaskResult,
} from "../types/index.js";
import { isSdkCompactBoundaryMessage, isSdkResultMessage } from "../types/index.js";
import { TaskRegistry, isTaskListTool } from "@orkestrator/protocol/task-list";
import { AGENT_INTERACTION_DEFAULT_TIMEOUT_MS } from "@orkestrator/protocol/agent-interactions";
import { isRootAssistantRecord, normalizeBackendModelId } from "@orkestrator/protocol/model-id";
import {
  structuredOutputFailure,
  type StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { eventEmitter } from "./event-emitter.js";
import {
  deleteSessionPreferences,
  MAX_DISPATCHED_REQUEST_IDS,
  readSessionPreferences,
  sessionPreferencesUnavailable,
  updateSessionPreferences,
  type SessionPreferences,
} from "./session-preferences.js";
import { runtimeEnvironmentForAgentQuery } from "./runtime-env.js";
import { debugLog, isDebugLoggingEnabled } from "./logger.js";
import { applyDiffBudget, applyToolResultBudget } from "./part-budget.js";
import { getMcpRuntimeConfig } from "./mcp-config.js";
import { getPluginsForSdk } from "./plugin-config.js";
import type { McpToolMetadata } from "../types/mcp.js";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, type Stats } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import * as core from "./session-manager-core.js";
import { sessions } from "./session-manager-core.js";
type BackgroundTaskLaunch = {
  id: string;
  toolUseId?: string;
  description?: string;
};
const PROVISIONAL_BACKGROUND_TASK_PREFIX = "pending-bash:";
const MAX_BACKGROUND_TASK_CANDIDATES = 128;
function provisionalBackgroundTaskId(toolUseId: string): string {
  return `${PROVISIONAL_BACKGROUND_TASK_PREFIX}${toolUseId}`;
}

/** Statuses from which a background task can still be doing work. */
export const LIVE_BACKGROUND_TASK_STATUSES = new Set<BackgroundTaskSnapshot["status"]>([
  "pending",
  "running",
  "paused",
]);

/**
 * Track one unresolved Bash invocation, up to a bound.
 *
 * Past the bound the invocation is simply not tracked. Throwing here would
 * propagate out of the message loop into the turn's error path, which marks
 * the session failed *and* settles every live background task the query owned
 * — destroying real work to protect a map of at most 128 short strings. Not
 * tracking degrades to the pre-candidate behaviour for that one command: its
 * stdin may close early, which is the smaller harm by a wide margin.
 */
export function registerBackgroundTaskCandidate(
  session: SessionState,
  toolUseId: string,
  control: NonNullable<SessionState["queryControl"]>,
): void {
  const candidates = (session.backgroundTaskCandidates ??= new Map());
  if (!candidates.has(toolUseId) && candidates.size >= MAX_BACKGROUND_TASK_CANDIDATES) {
    console.warn("[session-manager] Ignoring an unresolved Bash call past the candidate bound:", {
      sessionId: session.id,
      bound: MAX_BACKGROUND_TASK_CANDIDATES,
    });
    return;
  }
  candidates.set(toolUseId, control);
}

export function takeBackgroundTaskCandidate(
  session: SessionState,
  toolUseId: string | undefined,
): NonNullable<SessionState["queryControl"]> | undefined {
  if (!toolUseId) return undefined;
  const owner = session.backgroundTaskCandidates?.get(toolUseId);
  session.backgroundTaskCandidates?.delete(toolUseId);
  if (session.backgroundTaskCandidates?.size === 0) {
    session.backgroundTaskCandidates = undefined;
  }
  return owner;
}

export function removeBackgroundTaskCandidatesOwnedBy(
  session: SessionState,
  control: NonNullable<SessionState["queryControl"]>,
): void {
  for (const [toolUseId, owner] of session.backgroundTaskCandidates ?? []) {
    if (owner === control) session.backgroundTaskCandidates?.delete(toolUseId);
  }
  if (session.backgroundTaskCandidates?.size === 0) {
    session.backgroundTaskCandidates = undefined;
  }
}

export function takeProvisionalBackgroundTask(
  session: SessionState,
  toolUseId: string | undefined,
): {
  task?: BackgroundTaskSnapshot;
  owner?: NonNullable<SessionState["queryControl"]>;
} {
  const candidateOwner = takeBackgroundTaskCandidate(session, toolUseId);
  if (!toolUseId) return { owner: candidateOwner };
  const provisionalId = provisionalBackgroundTaskId(toolUseId);
  const task = session.backgroundTasks?.[provisionalId];
  const owner = session.backgroundTaskControls?.get(provisionalId) ?? candidateOwner;
  if (task) {
    const nextTasks = { ...session.backgroundTasks };
    delete nextTasks[provisionalId];
    session.backgroundTasks = Object.keys(nextTasks).length > 0 ? nextTasks : undefined;
  }
  session.backgroundTaskControls?.delete(provisionalId);
  if (session.backgroundTaskControls?.size === 0) {
    session.backgroundTaskControls = undefined;
  }
  return { task, owner };
}

/**
 * Publish a background launch before the delayed lifecycle stream catches up.
 * A terminal record always wins over this launch edge: SDK ordering is
 * explicitly unspecified, so a late tool result must never resurrect work that
 * already reported completion or failure.
 */
export function recordBackgroundTaskLaunch(
  session: SessionState,
  launch: BackgroundTaskLaunch,
  control: NonNullable<SessionState["queryControl"]>,
): void {
  takeBackgroundTaskCandidate(session, launch.toolUseId);
  const provisionalId = launch.toolUseId
    ? provisionalBackgroundTaskId(launch.toolUseId)
    : undefined;
  const provisional =
    provisionalId && provisionalId !== launch.id
      ? session.backgroundTasks?.[provisionalId]
      : undefined;
  const previous = session.backgroundTasks?.[launch.id] ?? provisional;
  const status = previous?.status ?? "running";
  const nextTasks = { ...session.backgroundTasks };
  if (provisionalId && provisionalId !== launch.id) {
    delete nextTasks[provisionalId];
    session.backgroundTaskControls?.delete(provisionalId);
  }
  session.backgroundTasks = boundBackgroundTaskHistory({
    ...nextTasks,
    [launch.id]: {
      id: launch.id,
      toolUseId: launch.toolUseId ?? previous?.toolUseId,
      description: launch.description ?? previous?.description,
      status,
      isBackgrounded: previous?.isBackgrounded ?? true,
      startedAt: previous?.startedAt ?? Date.now(),
      endedAt: previous?.endedAt,
      error: previous?.error,
    },
  });
  if (LIVE_BACKGROUND_TASK_STATUSES.has(status)) {
    (session.backgroundTaskControls ??= new Map()).set(launch.id, control);
  }
  emitBackgroundTaskSnapshot(session);
}

/**
 * Terminal task snapshots retained for launch correlation and restart display.
 *
 * Live membership is separately bounded by the provider's replacement set.
 * Keeping only the most recent terminal bookends prevents long sessions that
 * delegate repeatedly from growing the authoritative session snapshot without
 * limit.
 */
export const MAX_TERMINAL_BACKGROUND_TASKS = 128;

export function boundBackgroundTaskHistory(
  tasks: Record<string, BackgroundTaskSnapshot>,
): Record<string, BackgroundTaskSnapshot> {
  const terminalEntries = Object.entries(tasks)
    .map(([id, task], index) => ({ id, task, index }))
    .filter(({ task }) => !LIVE_BACKGROUND_TASK_STATUSES.has(task.status));
  if (terminalEntries.length <= MAX_TERMINAL_BACKGROUND_TASKS) return tasks;

  const retainedTerminalIds = new Set(
    terminalEntries
      .sort(
        (left, right) =>
          (right.task.endedAt ?? right.task.startedAt ?? 0) -
            (left.task.endedAt ?? left.task.startedAt ?? 0) || right.index - left.index,
      )
      .slice(0, MAX_TERMINAL_BACKGROUND_TASKS)
      .map(({ id }) => id),
  );
  return Object.fromEntries(
    Object.entries(tasks).filter(
      ([id, task]) => LIVE_BACKGROUND_TASK_STATUSES.has(task.status) || retainedTerminalIds.has(id),
    ),
  );
}

/**
 * Tasks that may be awaiting a terminal edge at once.
 *
 * Each entry is one short snapshot held only for the gap between the level
 * signal and the edge — normally microseconds, at most one watchdog window.
 * Past the bound the snapshot is simply not parked: the edge then lands the
 * task with provider-supplied metadata instead of the original description,
 * which is a cosmetic loss rather than a lost continuation.
 */
export const MAX_SETTLING_BACKGROUND_TASKS = 128;

/**
 * Hold a dropped task's metadata until its `task_notification` explains it.
 *
 * The caller has already removed the task from the live set; this only keeps
 * what the edge cannot reconstruct (description, `startedAt`, `toolUseId`).
 */
export function parkSettlingBackgroundTask(
  session: SessionState,
  task: BackgroundTaskSnapshot,
  owner: NonNullable<SessionState["queryControl"]>,
): void {
  const settling = (session.settlingBackgroundTasks ??= new Map());
  if (!settling.has(task.id) && settling.size >= MAX_SETTLING_BACKGROUND_TASKS) {
    console.warn("[session-manager] Ignoring a settling task past the bound:", {
      sessionId: session.id,
      bound: MAX_SETTLING_BACKGROUND_TASKS,
    });
    return;
  }
  settling.set(task.id, { task, owner });
}

export function takeSettlingBackgroundTask(
  session: SessionState,
  taskId: string,
): { task: BackgroundTaskSnapshot; owner: NonNullable<SessionState["queryControl"]> } | undefined {
  const parked = session.settlingBackgroundTasks?.get(taskId);
  if (!parked) return undefined;
  session.settlingBackgroundTasks!.delete(taskId);
  if (session.settlingBackgroundTasks!.size === 0) {
    session.settlingBackgroundTasks = undefined;
  }
  return parked;
}

/**
 * Drop every parked snapshot belonging to `owner`.
 *
 * Called when that control can no longer deliver an edge — the watchdog
 * expired, or the query ended. The tasks are already absent from the live set,
 * so this only releases the retained metadata.
 */
export function forgetSettlingBackgroundTasksOwnedBy(
  session: SessionState,
  owner: NonNullable<SessionState["queryControl"]> | undefined,
): void {
  if (!owner || !session.settlingBackgroundTasks) return;
  for (const [taskId, parked] of session.settlingBackgroundTasks) {
    if (parked.owner === owner) session.settlingBackgroundTasks.delete(taskId);
  }
  if (session.settlingBackgroundTasks.size === 0) {
    session.settlingBackgroundTasks = undefined;
  }
}

export const NO_CONTROL_CHANNEL: StopBackgroundTaskResult = {
  ok: false,
  reason: "no_control_channel",
  message: "No live Claude control channel can reach this task",
};

/**
 * Move one task to a terminal state and release the handle that owned it.
 *
 * Used wherever the bridge learns a task can no longer be running *without*
 * being told by a `task_notification` — a stop it issued itself, or a provider
 * process that went away. The snapshot is the only thing `GET /session/:id`
 * serves, so leaving it at `running` is indistinguishable from live work.
 */
export function settleBackgroundTask(
  session: SessionState,
  taskId: string,
  status: BackgroundTaskSnapshot["status"],
  error?: string,
): boolean {
  const previous = session.backgroundTasks?.[taskId];
  if (!previous || !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status)) return false;
  session.backgroundTasks = boundBackgroundTaskHistory({
    ...session.backgroundTasks,
    [taskId]: {
      ...previous,
      status,
      endedAt: previous.endedAt ?? Date.now(),
      ...(error !== undefined ? { error: previous.error ?? error } : {}),
    },
  });
  const owner = session.backgroundTaskControls?.get(taskId);
  session.backgroundTaskControls?.delete(taskId);
  if (session.backgroundTaskControls?.size === 0) {
    session.backgroundTaskControls = undefined;
  }
  closeQueryControlIfUnused(session, owner);
  session.finishTurnInputIfSettled?.();
  return true;
}

/**
 * Settle every live task that `control` owned, plus any live task no handle
 * owns at all.
 *
 * Called when a turn's iterator is finished with. The `for await` loop is the
 * only consumer of the stream and it ends either exhausted or through an
 * abrupt exit — and an abrupt exit invokes the iterator's `return()`, which the
 * SDK implements as `cleanup()` → `transport.close()`. So by the time this
 * runs the provider process behind `control` is gone: no further
 * `task_notification` can arrive and `stopTask` has nothing to talk to. A task
 * left at `running` here wedges there for the lifetime of the bridge.
 */
export function settleTasksOwnedByClosedControl(
  session: SessionState,
  control: NonNullable<SessionState["queryControl"]>,
  reason: string,
): boolean {
  let changed = false;
  for (const task of Object.values(session.backgroundTasks ?? {})) {
    if (!LIVE_BACKGROUND_TASK_STATUSES.has(task.status)) continue;
    const owner = session.backgroundTaskControls?.get(task.id);
    // An owner that is some *other* live control keeps the task addressable.
    if (owner !== undefined && owner !== control) continue;
    changed = settleBackgroundTask(session, task.id, "killed", reason) || changed;
  }
  return changed;
}

export async function stopBackgroundTask(
  sessionId: string,
  taskId: string,
): Promise<StopBackgroundTaskResult> {
  const session = sessions.get(sessionId);
  if (!session) {
    return { ok: false, reason: "session_not_found", message: "Session not found" };
  }
  const task = session.backgroundTasks?.[taskId];
  if (!task) {
    return { ok: false, reason: "task_not_found", message: "Task not found" };
  }
  // Strictly the handle that owns this task. Falling back to whatever control
  // is current asked a *later* turn's provider process to stop a task it never
  // started — it answers `ok` for a task id it has never heard of, so the user
  // was told the work had stopped when nothing had been reached at all.
  const control = session.backgroundTaskControls?.get(taskId);
  const stopTask = control?.stopTask;
  if (typeof stopTask !== "function") {
    return NO_CONTROL_CHANNEL;
  }
  try {
    await stopTask.call(control, taskId);
  } catch (error) {
    // A terminal provider notification can win the race with the rejected stop
    // request. That notification is authoritative: the task completed (or
    // failed) naturally, so preserve it and report that the requested outcome
    // is already settled instead of rewriting it to killed.
    const latest = session.backgroundTasks?.[taskId];
    if (latest && !LIVE_BACKGROUND_TASK_STATUSES.has(latest.status)) {
      return { ok: true };
    }
    // The handle outlived its transport (the CLI exited, the query was closed).
    // That is a conflict the user can understand, not a bridge fault, and it
    // must not surface as a 500 on `POST /:id/tasks/:taskId/stop`.
    console.error(
      "[session-manager] Background task stop failed on a closed control channel:",
      error instanceof Error ? error.message : String(error),
    );
    if (
      settleBackgroundTask(
        session,
        taskId,
        "killed",
        "The Claude control channel for this task is no longer available",
      )
    ) {
      emitBackgroundTaskSnapshot(session);
    }
    return NO_CONTROL_CHANNEL;
  }
  // The SDK answers a stop with a `task_notification` of status `stopped`, but
  // only the turn's `for await` loop reads that — a stop issued after the turn
  // has no reader, so the snapshot is patched here rather than waited for. The
  // notification, if one does arrive, lands on the same terminal state.
  if (settleBackgroundTask(session, taskId, "killed")) {
    emitBackgroundTaskSnapshot(session);
  }
  return { ok: true };
}

export function emitBackgroundTaskSnapshot(session: SessionState): void {
  eventEmitter.emit({
    type: "session.updated",
    sessionId: session.id,
    data: { backgroundTasks: session.backgroundTasks },
  });
}

/**
 * Release a session's control handle, closing the underlying query if the SDK
 * exposes a way to. Called when the session is deleted or explicitly aborted —
 * the two points at which the user has said the background work should stop.
 */
export function releaseQueryControl(session: SessionState): void {
  void releaseQueryControls(session);
}

export async function closeQueryControl(
  control: NonNullable<SessionState["queryControl"]>,
): Promise<void> {
  if (typeof control.close !== "function") return;
  try {
    await control.close();
  } catch (error) {
    debugLog("[session-manager] Failed to close query control:", error);
  }
}

export async function releaseQueryControls(session: SessionState): Promise<void> {
  const controls = new Set<NonNullable<SessionState["queryControl"]>>();
  if (session.queryControl) controls.add(session.queryControl);
  for (const control of session.backgroundTaskControls?.values() ?? []) {
    controls.add(control);
  }
  for (const control of session.backgroundTaskCandidates?.values() ?? []) {
    controls.add(control);
  }
  // A control retained across a background-task notification is a live writer
  // like any other. Deletion and abort are the two points at which the user has
  // said that work should stop, so the pending continuation does not exempt it.
  for (const control of session.retainedQueryControls ?? []) {
    controls.add(control);
  }
  session.queryControl = undefined;
  session.backgroundTaskControls = undefined;
  session.backgroundTaskCandidates = undefined;
  session.retainedQueryControls = undefined;
  session.settlingBackgroundTasks = undefined;
  await Promise.all(Array.from(controls, closeQueryControl));
}

/**
 * Keep `control` addressable while its released turn waits for the continuation
 * a background-task notification triggers.
 *
 * The control is deliberately not closed there, so without this it would belong
 * to none of the session's collections: `releaseQueryControls` could not reach
 * it and the CLI would outlive the session that owns it.
 */
export function retainQueryControl(
  session: SessionState,
  control: NonNullable<SessionState["queryControl"]>,
): void {
  (session.retainedQueryControls ??= new Set()).add(control);
}

export function forgetRetainedQueryControl(
  session: SessionState,
  control: NonNullable<SessionState["queryControl"]> | undefined,
): void {
  if (!control || !session.retainedQueryControls) return;
  session.retainedQueryControls.delete(control);
  if (session.retainedQueryControls.size === 0) {
    session.retainedQueryControls = undefined;
  }
}

export function closeQueryControlIfUnused(
  session: SessionState,
  control: NonNullable<SessionState["queryControl"]> | undefined,
): void {
  if (!control || session.queryControl === control) return;
  if (Array.from(session.backgroundTaskControls?.values() ?? []).includes(control)) return;
  if (Array.from(session.backgroundTaskCandidates?.values() ?? []).includes(control)) return;
  if (session.retainedQueryControls?.has(control)) return;
  void closeQueryControl(control);
}
