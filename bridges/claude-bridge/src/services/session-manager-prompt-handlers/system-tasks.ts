import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTaskSnapshot, SessionState } from "../../types/index.js";
import { eventEmitter } from "../event-emitter.js";
import {
  LIVE_BACKGROUND_TASK_STATUSES,
  RUN_SCOPED_TASK_METADATA_RESET,
  boundBackgroundTaskHistory,
  carriedTaskMetadata,
  inheritBackgroundTaskHookRun,
  isHookRunningBackgroundTask,
  noteBackgroundTasksChanged,
  parkSettlingBackgroundTask,
  takeShellTaskFields,
  takeProvisionalBackgroundTask,
  takeSettlingBackgroundTask,
  taskMessageMetadata,
} from "../session-manager-background-tasks.js";
import {
  persistedBackgroundTaskMessage,
  persistedTaskIdentifier,
  persistedTaskName,
  persistedTaskUsage,
} from "../session-manager-messages.js";
import { waitForContinuationAfterNotification } from "../session-manager-prompt-turn-lifecycle.js";
import type { TurnState } from "../session-manager-prompt-turn.js";

// The `system` subtypes that track a task's lifecycle. A handler answers
// `"stop"` where the frame must not reach the rest of the `system` handling:
// it says nothing about the turn, so it must not settle its input either.

/** The fields of the task subtypes this bridge reads. */
interface TaskSystemMessage {
  subtype?: string;
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  summary?: string;
  /** Only on `task_notification`; the terminal edge of a task. */
  status?: "completed" | "failed" | "stopped";
  /** Only on `task_notification`; where the CLI wrote the full output. */
  output_file?: unknown;
  /** On `task_progress` and `task_notification`. */
  usage?: unknown;
  /** Only on `background_tasks_changed`; the full live set. */
  tasks?: Array<{
    task_id?: string;
    task_type?: string;
    description?: string;
    /** Agent SDK 0.3.296+: agent type, or `main-session`. */
    subagent_type?: unknown;
    parent_task_id?: unknown;
    ambient?: unknown;
    skip_transcript?: unknown;
  }>;
  patch?: {
    status?: BackgroundTaskSnapshot["status"];
    description?: string;
    end_time?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
}

function emitBackgroundTasks(turn: TurnState): void {
  noteBackgroundTasksChanged(turn.session);
  eventEmitter.emit({
    type: "session.updated",
    sessionId: turn.sessionId,
    data: { backgroundTasks: turn.session.backgroundTasks },
  });
}

/** What an edge says about its task beyond its lifecycle, validated as on replay. */
function taskEdgeMetadata(message: SDKMessage): ReturnType<typeof taskMessageMetadata> {
  const parsed = persistedBackgroundTaskMessage({ message });
  return parsed ? taskMessageMetadata(parsed) : {};
}

/** `task_started`, `task_progress` and `task_updated`: one run of a task changing state. */
export function handleTaskEdge(turn: TurnState, message: SDKMessage): void | "stop" {
  const { session } = turn;
  const taskMessage = message as TaskSystemMessage;
  if (!taskMessage.task_id) return;
  if (
    isHookRunningBackgroundTask(session.backgroundTasks?.[taskMessage.task_id]) &&
    taskMessage.patch?.status &&
    !LIVE_BACKGROUND_TASK_STATUSES.has(taskMessage.patch.status)
  )
    return "stop";
  const correlated = takeProvisionalBackgroundTask(session, taskMessage.tool_use_id);
  const stored = session.backgroundTasks?.[taskMessage.task_id] ?? correlated.task;
  // A `SendMessage` resume re-runs a finished agent under its old task
  // id, announced by a `task_started` from the resuming call. That is a
  // new run, not a late edge of the old one: left terminal, nothing
  // held this query's input open for it, and the CLI stopped the agent
  // once its idle wind-down ran out.
  const resumedRun =
    taskMessage.subtype === "task_started" &&
    stored !== undefined &&
    !LIVE_BACKGROUND_TASK_STATUSES.has(stored.status) &&
    typeof taskMessage.tool_use_id === "string" &&
    taskMessage.tool_use_id !== stored.toolUseId;
  if (resumedRun) {
    // The finished run's parked snapshot must not describe this one.
    takeSettlingBackgroundTask(session, taskMessage.task_id);
  }
  const previous = resumedRun
    ? {
        ...stored,
        ...RUN_SCOPED_TASK_METADATA_RESET,
        status: "running" as const,
        startedAt: Date.now(),
        endedAt: undefined,
        error: undefined,
        summary: undefined,
        outputFile: undefined,
        usage: undefined,
      }
    : stored;
  const patchedStatus = taskMessage.patch?.status ?? previous?.status ?? "running";
  // Within one run, level and edge messages may be delivered in either
  // order, so a late start/progress edge must enrich a terminal record
  // rather than resurrect it.
  const status =
    previous &&
    !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status) &&
    LIVE_BACKGROUND_TASK_STATUSES.has(patchedStatus)
      ? previous.status
      : patchedStatus;
  const task: BackgroundTaskSnapshot = {
    id: taskMessage.task_id,
    toolUseId: taskMessage.tool_use_id ?? previous?.toolUseId,
    description: taskMessage.patch?.description ?? taskMessage.description ?? previous?.description,
    status,
    isBackgrounded: taskMessage.patch?.is_backgrounded ?? previous?.isBackgrounded,
    startedAt: previous?.startedAt ?? Date.now(),
    endedAt: taskMessage.patch?.end_time ?? previous?.endedAt,
    error: taskMessage.patch?.error ?? previous?.error,
    summary: previous?.summary,
    outputFile: previous?.outputFile,
    subagentType: previous?.subagentType,
    // Terminal usage wins over an older progress frame delivered late.
    usage:
      previous && !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status) && previous.usage
        ? previous.usage
        : (persistedTaskUsage(taskMessage.usage) ?? previous?.usage),
    ...carriedTaskMetadata(previous),
    ...taskEdgeMetadata(message),
  };
  Object.assign(
    task,
    takeShellTaskFields(session, task.toolUseId),
    task.error ? { error: task.error } : {},
  );
  inheritBackgroundTaskHookRun(previous, task);
  session.backgroundTasks = boundBackgroundTaskHistory({
    ...session.backgroundTasks,
    [task.id]: task,
  });
  if (LIVE_BACKGROUND_TASK_STATUSES.has(task.status)) {
    (session.backgroundTaskControls ??= new Map()).set(task.id, turn.queryIteratorControl!);
  } else {
    const owner = session.backgroundTaskControls?.get(task.id) ?? correlated.owner;
    session.backgroundTaskControls?.delete(task.id);
    // A finishing task sends its terminal patch before the
    // `task_notification` edge, while the CLI is still queueing the
    // notification it will answer. For a released turn this is the
    // same boundary as that edge, so the turn waits for the reply the
    // model promised rather than ending here.
    if (
      owner === turn.queryIteratorControl &&
      turn.turnReleasedToBackgroundTasks &&
      previous !== undefined &&
      LIVE_BACKGROUND_TASK_STATUSES.has(previous.status)
    ) {
      turn.receivedResult = false;
      waitForContinuationAfterNotification(turn);
    }
  }
  emitBackgroundTasks(turn);
}

/** `task_notification`: the terminal edge of a task. */
export function handleTaskNotification(turn: TurnState, message: SDKMessage): void | "stop" {
  const { session } = turn;
  const taskMessage = message as TaskSystemMessage;
  if (!taskMessage.task_id) return;
  const notification = persistedBackgroundTaskMessage({ message: taskMessage });
  // Invalid terminal statuses are not completion evidence, live or on replay.
  if (!notification) return "stop";
  // A same-id wake can happen while usage settlement holds the JSONL
  // consumer. This frame may belong to the preceding run; only the
  // current run's stop hook can retire its live control.
  if (isHookRunningBackgroundTask(session.backgroundTasks?.[notification.task_id])) {
    return "stop";
  }
  // A task notification can re-enter the root agent loop after an
  // earlier result. That earlier result is only the response boundary
  // before the notification, not permission to close streaming input.
  // Wait for the resumed loop's own result; otherwise stdin EOF lands
  // between its final tool result and final assistant message and the
  // rollout records `[Request interrupted by user]`.
  turn.receivedResult = false;
  // The terminal edge. Without it nothing ever leaves `running`, so
  // `GET /session/:id` reported a finished task as live indefinitely.
  const correlated = takeProvisionalBackgroundTask(session, notification.tool_use_id);
  // A level signal that preceded this edge has already removed the task
  // from the live set; its parked snapshot is the only remaining source
  // of the original description and start time.
  const parked = takeSettlingBackgroundTask(session, notification.task_id);
  const previous =
    session.backgroundTasks?.[notification.task_id] ?? parked?.task ?? correlated.task;
  const terminalStatus: BackgroundTaskSnapshot["status"] =
    notification.status === "failed"
      ? "failed"
      : notification.status === "stopped"
        ? "killed"
        : "completed";
  const task: BackgroundTaskSnapshot = {
    id: notification.task_id,
    toolUseId: notification.tool_use_id ?? previous?.toolUseId,
    description: previous?.description ?? notification.description ?? notification.summary,
    status: terminalStatus,
    isBackgrounded: previous?.isBackgrounded,
    startedAt: previous?.startedAt ?? Date.now(),
    endedAt: Date.now(),
    error:
      terminalStatus === "failed" ? (notification.summary ?? previous?.error) : previous?.error,
    summary: notification.summary ?? previous?.summary,
    outputFile: notification.output_file ?? previous?.outputFile,
    usage: notification.usage ?? previous?.usage,
    subagentType: previous?.subagentType,
    ...carriedTaskMetadata(previous),
    ...taskMessageMetadata(notification),
  };
  Object.assign(
    task,
    takeShellTaskFields(session, task.toolUseId),
    task.error ? { error: task.error } : {},
  );
  session.backgroundTasks = boundBackgroundTaskHistory({
    ...session.backgroundTasks,
    [task.id]: task,
  });
  const owner = session.backgroundTaskControls?.get(task.id) ?? parked?.owner ?? correlated.owner;
  session.backgroundTaskControls?.delete(task.id);
  // The notification is injected into the same root loop and may be
  // followed by another assistant/result boundary, which a released turn
  // waits for before it ends.
  if (owner === turn.queryIteratorControl && turn.turnReleasedToBackgroundTasks) {
    waitForContinuationAfterNotification(turn);
  }
  emitBackgroundTasks(turn);
}

/** `background_tasks_changed`: the live set, as a level signal. */
export function handleBackgroundTasksChanged(turn: TurnState, message: SDKMessage): void {
  const { session } = turn;
  const taskMessage = message as TaskSystemMessage;
  if (!Array.isArray(taskMessage.tasks)) return;
  // A level signal replaces live membership only. Terminal bookends
  // are retained (within the bounded history) because the SDK permits
  // this level to arrive after the terminal edge for the same
  // transition; replacing the whole snapshot here erased failures and
  // could even resurrect the task as running.
  const replacement: Record<string, BackgroundTaskSnapshot> = Object.fromEntries(
    (
      Object.entries(session.backgroundTasks ?? {}) as Array<[string, BackgroundTaskSnapshot]>
    ).filter(([, task]) => !LIVE_BACKGROUND_TASK_STATUSES.has(task.status)),
  ) as Record<string, BackgroundTaskSnapshot>;
  const previousControls = session.backgroundTaskControls;
  const replacementControls = new Map<string, NonNullable<SessionState["queryControl"]>>();
  // The SDK documents this level signal as per-process. Every turn runs
  // on the session's one CLI, so it normally speaks for every live
  // task; a member owned by another control (a CLI still exiting while
  // its successor starts) is preserved, and only this query's slice is
  // replaced.
  const previouslyLiveOwnedByThisQuery: BackgroundTaskSnapshot[] = [];
  for (const [id, task] of Object.entries(session.backgroundTasks ?? {}) as Array<
    [string, BackgroundTaskSnapshot]
  >) {
    if (!LIVE_BACKGROUND_TASK_STATUSES.has(task.status)) continue;
    const owner = previousControls?.get(id);
    if ((owner && owner !== turn.queryIteratorControl!) || isHookRunningBackgroundTask(task)) {
      replacement[id] = task;
      if (owner) replacementControls.set(id, owner);
      continue;
    }
    // Owned by this query (or by no handle at all, which only this
    // query can still speak for). Whether it survives depends on the
    // payload below.
    previouslyLiveOwnedByThisQuery.push(task);
  }
  for (const entry of taskMessage.tasks) {
    const id = entry?.task_id;
    if (typeof id !== "string" || id.length === 0) continue;
    const previous = session.backgroundTasks?.[id];
    if (previous && !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status)) {
      replacement[id] = previous;
      continue;
    }
    // Only the level names the agent type (the edges do not), and it
    // never changes within a run, so an earlier value stands in for a
    // CLI that predates the field.
    const subagentType =
      typeof entry.subagent_type === "string" && entry.subagent_type.length > 0
        ? entry.subagent_type
        : previous?.subagentType;
    const taskType = persistedTaskName(entry.task_type);
    const parentTaskId = persistedTaskIdentifier(entry.parent_task_id);
    replacement[id] = {
      id,
      toolUseId: previous?.toolUseId,
      description: entry.description ?? previous?.description,
      status: LIVE_BACKGROUND_TASK_STATUSES.has(previous?.status ?? "running")
        ? (previous?.status ?? "running")
        : "running",
      isBackgrounded: previous?.isBackgrounded ?? true,
      startedAt: previous?.startedAt ?? Date.now(),
      ...(previous?.usage ? { usage: previous.usage } : {}),
      ...(previous?.error ? { error: previous.error } : {}),
      ...(subagentType ? { subagentType } : {}),
      ...carriedTaskMetadata(previous),
      ...(taskType ? { taskType } : {}),
      parentTaskId,
      ambient: entry.ambient === true || entry.skip_transcript === true,
    };
    inheritBackgroundTaskHookRun(previous, replacement[id]!);
    // An id already owned by another live control keeps that owner:
    // only the process that started a task can stop it, and a control
    // asked to stop an id it never started answers `ok` without
    // reaching anything. This query claims genuinely new ids only.
    replacementControls.set(id, previousControls?.get(id) ?? turn.queryIteratorControl!);
  }
  session.backgroundTasks = boundBackgroundTaskHistory(replacement);
  session.backgroundTaskControls = replacementControls.size > 0 ? replacementControls : undefined;
  // Anything this query owned that the level no longer lists has
  // stopped running, but the level says nothing about *how* it ended.
  // The edge that does may still be on its way (the SDK leaves the
  // order unspecified; an edge that already landed made the task
  // terminal, so it is not in this list), so the query still owes a
  // continuation, and the released turn must wait for it rather than
  // end here — ending is what silently dropped the "I'll report back
  // when it finishes" reply the model had already promised.
  const droppedByThisQuery = previouslyLiveOwnedByThisQuery.filter(
    (task) => replacement[task.id] === undefined,
  );
  if (droppedByThisQuery.length > 0 && turn.turnReleasedToBackgroundTasks) {
    for (const task of droppedByThisQuery) {
      parkSettlingBackgroundTask(session, task, turn.queryIteratorControl!);
    }
    // Mirrors the `task_notification` branch: the earlier result is
    // only the boundary before this transition, not the end of the turn.
    turn.receivedResult = false;
    waitForContinuationAfterNotification(turn);
  }
  emitBackgroundTasks(turn);
}
