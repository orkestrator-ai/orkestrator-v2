// Session Manager Service
// Handles session state and interacts with Claude Agent SDK

import type {
  SessionState,
  BackgroundTaskSnapshot,
  StopBackgroundTaskResult,
} from "../types/index.js";
import { MAX_SHELL_TASK_DETAILS, updateSessionPreferences } from "./session-preferences.js";
import { eventEmitter } from "./event-emitter.js";
import { debugLog } from "./logger.js";
import { sessions } from "./session-manager-core.js";
import type { BackgroundTaskSystemMessage } from "./session-manager-messages.js";

type BackgroundTaskLaunch = {
  id: string;
  toolUseId?: string;
  description?: string;
  /** Agent type, when the launch is a subagent's `SubagentStart` hook. */
  subagentType?: string;
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
 * The summary Claude Code puts on each task its resume scan marks.
 *
 * On resume the CLI looks through the previous process's transcript for
 * background shells, Monitors, workflows and agents with no completion record.
 * When it finds several, it stops each one with this exact summary and reports
 * them together to the model in one aggregate notice. Nothing else in the CLI
 * emits this text. The scan also catches tasks that ended long before. A
 * Monitor that expires leaves a notice with no `<status>`, which the scan does
 * not count as an ending.
 */
export const CLAUDE_RESUME_ORPHAN_SUMMARY =
  "Orphaned by a previous Claude Code process exit and reported in an aggregate summary.";

/**
 * What a terminal edge from the CLI's resume scan means here, if it is one.
 *
 * `cleanup`: a task this session has no record of. It ran in a process that is
 * gone, so the edge carries no name and no real end time, and is housekeeping
 * rather than work the reader saw. `already-settled`: a task whose ending this
 * session already recorded, which the scan has no grounds to relabel stopped.
 * A task still live here is not claimed: it keeps the ordinary stopped edge.
 *
 * Only `stopped` edges qualify. The scan marks agents `failed`, because their
 * in-process state really was lost, and that stays visible.
 */
export function resumeOrphanScanOutcome(
  message: Pick<BackgroundTaskSystemMessage, "subtype" | "status" | "summary">,
  previous: BackgroundTaskSnapshot | undefined,
): "cleanup" | "already-settled" | undefined {
  if (
    message.subtype !== "task_notification" ||
    message.status !== "stopped" ||
    message.summary !== CLAUDE_RESUME_ORPHAN_SUMMARY
  ) {
    return undefined;
  }
  if (!previous) return "cleanup";
  return LIVE_BACKGROUND_TASK_STATUSES.has(previous.status) ? undefined : "already-settled";
}

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

// Hook-restarted runs have an authoritative stop hook. Stream frames have no run
// identity, so they cannot end that run while its hook still says it is live.
// Weak membership follows immutable snapshots without retaining task history.
const hookRunningTasks = new WeakSet<BackgroundTaskSnapshot>();

export function isHookRunningBackgroundTask(task: BackgroundTaskSnapshot | undefined): boolean {
  return !!task && LIVE_BACKGROUND_TASK_STATUSES.has(task.status) && hookRunningTasks.has(task);
}

export function inheritBackgroundTaskHookRun(
  previous: BackgroundTaskSnapshot | undefined,
  next: BackgroundTaskSnapshot,
): void {
  if (isHookRunningBackgroundTask(previous)) hookRunningTasks.add(next);
}

type BackgroundTaskMetadata = Pick<
  BackgroundTaskSnapshot,
  | "taskType"
  | "parentTaskId"
  | "prompt"
  | "command"
  | "outputTail"
  | "workflowName"
  | "ambient"
  | "lastToolName"
  | "progressSummary"
  | "pausedMs"
  | "endReason"
>;

const BACKGROUND_TASK_METADATA_KEYS = [
  "taskType",
  "parentTaskId",
  "prompt",
  "command",
  "outputTail",
  "workflowName",
  "ambient",
  "lastToolName",
  "progressSummary",
  "pausedMs",
  "endReason",
] as const satisfies ReadonlyArray<keyof BackgroundTaskMetadata>;

/**
 * What a task record says beyond its lifecycle, carrying only fields it has.
 *
 * Every edge rebuilds the snapshot field by field, so each one spreads this to
 * keep what an earlier edge (or hook) learned about the task.
 */
export function carriedTaskMetadata(
  task: BackgroundTaskSnapshot | undefined,
): BackgroundTaskMetadata {
  if (!task) return {};
  const carried: Record<string, unknown> = {};
  for (const key of BACKGROUND_TASK_METADATA_KEYS) {
    if (task[key] !== undefined) carried[key] = task[key];
  }
  return carried as BackgroundTaskMetadata;
}

/** Metadata that belongs to one run of a task, cleared when a resume starts another. */
export const RUN_SCOPED_TASK_METADATA_RESET = {
  outputTail: undefined,
  lastToolName: undefined,
  progressSummary: undefined,
  pausedMs: undefined,
  endReason: undefined,
} as const satisfies BackgroundTaskMetadata;

/** The metadata one parsed task message reports, carrying only fields it has. */
export function taskMessageMetadata(message: BackgroundTaskSystemMessage): BackgroundTaskMetadata {
  return {
    ...(message.task_type ? { taskType: message.task_type } : {}),
    ...(message.parent_task_id ? { parentTaskId: message.parent_task_id } : {}),
    ...(message.prompt ? { prompt: message.prompt } : {}),
    ...(message.workflow_name ? { workflowName: message.workflow_name } : {}),
    ...(message.ambient ? { ambient: true } : {}),
    ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
    // On every other subtype `summary` is the terminal report, not a status.
    ...(message.subtype === "task_progress" && message.summary
      ? { progressSummary: message.summary }
      : {}),
    ...(message.patch?.total_paused_ms !== undefined
      ? { pausedMs: message.patch.total_paused_ms }
      : {}),
    ...(message.reason ? { endReason: message.reason } : {}),
  };
}

const MAX_SHELL_COMMANDS = MAX_SHELL_TASK_DETAILS;
const MAX_SHELL_COMMAND_LENGTH = 4_000;
const SHELL_OUTPUT_TAIL_LENGTH = 2_000;

function boundedShellText(text: string, keep: "head" | "tail", maxLength: number): string {
  const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (cleaned.length <= maxLength) return cleaned.trim();
  // `…` marks the cut so a bounded command is never mistaken for the whole one.
  return keep === "head"
    ? `${cleaned.slice(0, maxLength).trimEnd()}…`
    : `…${cleaned.slice(-maxLength).trimStart()}`;
}

function backgroundTaskByToolUseId(
  session: SessionState,
  toolUseId: string,
): BackgroundTaskSnapshot | undefined {
  return Object.values(session.backgroundTasks ?? {}).find((task) => task.toolUseId === toolUseId);
}

function patchBackgroundTask(
  session: SessionState,
  task: BackgroundTaskSnapshot,
  patch: Partial<BackgroundTaskSnapshot>,
): void {
  const next = { ...task, ...patch };
  inheritBackgroundTaskHookRun(task, next);
  session.backgroundTasks = { ...session.backgroundTasks, [task.id]: next };
  emitBackgroundTaskSnapshot(session);
}

async function persistShellTaskFields(
  session: SessionState,
  toolUseId: string,
  fields: { command?: string; outputTail?: string; error?: string },
): Promise<void> {
  if (!session.sdkSessionId) return;
  const { command, outputTail, error } = fields;
  try {
    await updateSessionPreferences(session.sdkSessionId, {
      shellTaskDetails: [
        {
          toolUseId,
          ...(command !== undefined ? { command } : {}),
          ...(outputTail !== undefined ? { outputTail } : {}),
          ...(error !== undefined ? { error } : {}),
        },
      ],
    });
  } catch {
    // Content-free: hook payloads must never reach logs.
    console.warn("[session-manager] Could not persist shell task details");
  }
}

function cacheShellTaskFields(
  session: SessionState,
  toolUseId: string,
  fields: Pick<BackgroundTaskSnapshot, "command" | "outputTail" | "error"> & {
    completed?: boolean;
  },
): void {
  const commands = (session.shellCommands ??= new Map());
  const previous = commands.get(toolUseId);
  commands.delete(toolUseId);
  while (commands.size >= MAX_SHELL_COMMANDS) {
    const oldest = commands.keys().next().value;
    if (oldest === undefined) break;
    commands.delete(oldest);
  }
  commands.set(toolUseId, { ...previous, ...fields });
}

/**
 * Remember the command one Bash call runs, so a task the CLI registers for it
 * can say what it runs. Oldest entries go first past the bound.
 */
export async function recordShellCommand(
  session: SessionState,
  toolUseId: string,
  command: string,
): Promise<void> {
  if (toolUseId.length === 0 || toolUseId.length > 512) return;
  const bounded = boundedShellText(command, "head", MAX_SHELL_COMMAND_LENGTH);
  if (!bounded) return;
  cacheShellTaskFields(session, toolUseId, { command: bounded });
  // The task edge normally follows the hook, but nothing orders the two.
  const task = backgroundTaskByToolUseId(session, toolUseId);
  if (task) patchBackgroundTask(session, task, takeShellTaskFields(session, toolUseId));
  await persistShellTaskFields(session, toolUseId, { command: bounded });
}

/** Consume a completed call only once a task has correlated its launching id. */
export function takeShellTaskFields(
  session: SessionState,
  toolUseId: string | undefined,
): Pick<BackgroundTaskSnapshot, "command" | "outputTail" | "error"> {
  const fields = toolUseId ? session.shellCommands?.get(toolUseId) : undefined;
  if (!fields) return {};
  const { completed, ...metadata } = fields;
  if (completed) session.shellCommands?.delete(toolUseId!);
  return metadata;
}

/**
 * Attach how a shell task's command ended to its task.
 *
 * A backgrounded call's result only says the command was moved to the
 * background; its output is in the task's output file instead, so that result
 * attaches nothing. A failed call's error names the exit code first.
 */
export async function recordShellResult(
  session: SessionState,
  toolUseId: string,
  result: { output?: string; failure?: string; interrupted?: boolean; backgrounded?: boolean },
): Promise<void> {
  if (result.backgrounded || toolUseId.length === 0 || toolUseId.length > 512) return;
  const task = backgroundTaskByToolUseId(session, toolUseId);
  const [firstLine = "", ...rest] = (result.failure ?? "").split("\n");
  const exitLine = /^exit code \d+/i.test(firstLine.trim()) ? firstLine.trim() : undefined;
  const output =
    result.failure !== undefined ? (exitLine ? rest.join("\n") : result.failure) : result.output;
  const outputTail = output ? boundedShellText(output, "tail", SHELL_OUTPUT_TAIL_LENGTH) : "";
  const patch: Partial<BackgroundTaskSnapshot> = {
    ...(outputTail ? { outputTail } : {}),
    ...(result.failure !== undefined && task?.error === undefined
      ? {
          error: exitLine
            ? boundedShellText(exitLine, "head", 255)
            : result.interrupted
              ? "Interrupted"
              : "Command failed",
        }
      : {}),
  };
  const fields = { ...session.shellCommands?.get(toolUseId), ...patch, completed: true };
  cacheShellTaskFields(session, toolUseId, fields);
  if (task) patchBackgroundTask(session, task, takeShellTaskFields(session, toolUseId));
  await persistShellTaskFields(session, toolUseId, fields);
}

/** Publish a launch, preserving terminal records unless a start hook names a new run. */
export function recordBackgroundTaskLaunch(
  session: SessionState,
  launch: BackgroundTaskLaunch,
  control: NonNullable<SessionState["queryControl"]>,
  options?: { newRun?: boolean },
): void {
  takeBackgroundTaskCandidate(session, launch.toolUseId);
  const provisionalId = launch.toolUseId
    ? provisionalBackgroundTaskId(launch.toolUseId)
    : undefined;
  const provisional =
    provisionalId && provisionalId !== launch.id
      ? session.backgroundTasks?.[provisionalId]
      : undefined;
  const parked = options?.newRun ? takeSettlingBackgroundTask(session, launch.id) : undefined;
  const stored = session.backgroundTasks?.[launch.id] ?? provisional ?? parked?.task;
  const restarted =
    options?.newRun === true &&
    stored !== undefined &&
    (!LIVE_BACKGROUND_TASK_STATUSES.has(stored.status) || parked !== undefined);
  // The finished run's parked snapshot must not describe this one.
  const previous = restarted
    ? {
        ...stored,
        ...RUN_SCOPED_TASK_METADATA_RESET,
        startedAt: Date.now(),
        endedAt: undefined,
        error: undefined,
        summary: undefined,
        outputFile: undefined,
        usage: undefined,
      }
    : stored;
  const status = restarted ? "running" : (previous?.status ?? "running");
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
      // A hook names only the agent type; the original launch said what the
      // work was, and a woken run is still that work.
      description: restarted
        ? (previous?.description ?? launch.description)
        : (launch.description ?? previous?.description),
      status,
      isBackgrounded: previous?.isBackgrounded ?? true,
      startedAt: previous?.startedAt ?? Date.now(),
      endedAt: previous?.endedAt,
      error: previous?.error,
      summary: previous?.summary,
      outputFile: previous?.outputFile,
      usage: previous?.usage,
      subagentType: launch.subagentType ?? previous?.subagentType,
      ...carriedTaskMetadata(previous),
    },
  });
  const task = session.backgroundTasks[launch.id]!;
  if (restarted) hookRunningTasks.add(task);
  else inheritBackgroundTaskHookRun(stored, task);
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
 * Move one task to a terminal state and forget which handle owned it.
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
  session.backgroundTaskControls?.delete(taskId);
  if (session.backgroundTaskControls?.size === 0) {
    session.backgroundTaskControls = undefined;
  }
  // The process that owned it stays up; its idle window decides when it goes.
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
  // is current could ask a different provider process (one started after the
  // owner exited) to stop a task it never started — it answers `ok` for a task
  // id it has never heard of, so the user would be told the work had stopped
  // when nothing had been reached at all.
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

/**
 * Per-session count of published background-task snapshots, for the no-touch
 * activity read's content revision. A task's progress, output tail or end
 * changes the session view without changing its activity or transcript, and
 * the backend needs a cheap way to see that it moved. Held off `SessionState`
 * so it is never persisted.
 */
const backgroundTaskRevisions = new WeakMap<SessionState, number>();

/** Record a change to `session.backgroundTasks`; call where it is published. */
export function noteBackgroundTasksChanged(session: SessionState): void {
  backgroundTaskRevisions.set(session, (backgroundTaskRevisions.get(session) ?? 0) + 1);
}

/** How many background-task changes this session object has published. */
export function backgroundTaskRevision(session: SessionState): number {
  return backgroundTaskRevisions.get(session) ?? 0;
}

export function emitBackgroundTaskSnapshot(session: SessionState): void {
  noteBackgroundTasksChanged(session);
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
  await Promise.all(Array.from(takeQueryControls(session), closeQueryControl));
}

/**
 * Detach every query control the session owns and hand them to the caller.
 *
 * Deletion closes them best-effort through `releaseQueryControls`; tab close
 * closes them itself because it must report a close it could not confirm.
 */
export function takeQueryControls(
  session: SessionState,
): Set<NonNullable<SessionState["queryControl"]>> {
  const controls = new Set<NonNullable<SessionState["queryControl"]>>();
  if (session.queryControl) controls.add(session.queryControl);
  // The session's CLI, including while it is idle between turns running
  // background work that no other collection names.
  if (session.claudeRuntime && session.claudeRuntime.state !== "ended") {
    const runtime = session.claudeRuntime;
    runtime.state = "draining";
    runtime.input.close();
    runtime.abortController.abort();
    session.queryControlDraining = runtime.control;
    controls.add(runtime.control);
  }
  for (const control of session.backgroundTaskControls?.values() ?? []) {
    controls.add(control);
  }
  for (const control of session.backgroundTaskCandidates?.values() ?? []) {
    controls.add(control);
  }
  session.queryControl = undefined;
  session.backgroundTaskControls = undefined;
  session.backgroundTaskCandidates = undefined;
  session.settlingBackgroundTasks = undefined;
  return controls;
}

/**
 * Whether `runtime`'s process owns work that must outlive the response
 * boundary: a live task it started, or a Bash call that may yet become one.
 */
export function claudeRuntimeOwnsLiveWork(
  session: SessionState,
  runtime: { control: NonNullable<SessionState["queryControl"]> },
): boolean {
  const { control } = runtime;
  for (const task of Object.values(session.backgroundTasks ?? {}) as BackgroundTaskSnapshot[]) {
    if (
      LIVE_BACKGROUND_TASK_STATUSES.has(task.status) &&
      session.backgroundTaskControls?.get(task.id) === control
    ) {
      return true;
    }
  }
  for (const owner of session.backgroundTaskCandidates?.values() ?? []) {
    if (owner === control) return true;
  }
  return false;
}
