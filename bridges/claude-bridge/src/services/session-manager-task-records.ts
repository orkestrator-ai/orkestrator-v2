// Claude's task lifecycle records (`task_started`, `task_progress`,
// `task_updated`, `task_notification`), read from a live frame or a rollout
// line into one validated shape, and the reducer that folds them into the
// task map when a session is materialized from its rollout.

import type {
  BackgroundTaskSnapshot,
  BackgroundTaskUsage,
  BackgroundWorkflowAgent,
} from "../types/index.js";
import {
  LIVE_BACKGROUND_TASK_STATUSES,
  RUN_SCOPED_TASK_METADATA_RESET,
  boundBackgroundTaskHistory,
  carriedTaskMetadata,
  resumeOrphanScanOutcome,
  taskMessageMetadata,
} from "./session-manager-background-tasks.js";
import { parseWorkflowProgress, taskEdgeDescription } from "./background-task-workflow.js";

export interface BackgroundTaskSystemMessage {
  subtype: "task_started" | "task_progress" | "task_updated" | "task_notification";
  task_id: string;
  tool_use_id?: string;
  description?: string;
  summary?: string;
  status?: "completed" | "failed" | "stopped";
  /** Only on `task_notification`. */
  output_file?: string;
  /** On `task_progress` and `task_notification`; already validated. */
  usage?: BackgroundTaskUsage;
  /** Only on `task_started`. */
  task_type?: string;
  parent_task_id?: string;
  prompt?: string;
  workflow_name?: string;
  /** Only on `task_progress`. */
  last_tool_name?: string;
  /** Only on `task_notification`. */
  reason?: "worker_restart";
  ambient?: boolean;
  /** A workflow's agents, from `workflow_progress`; see `background-task-workflow.ts`. */
  workflow_agents?: BackgroundWorkflowAgent[];
  workflow_agents_omitted?: number;
  patch?: {
    status?: BackgroundTaskSnapshot["status"];
    description?: string;
    end_time?: number;
    error?: string;
    is_backgrounded?: boolean;
    total_paused_ms?: number;
  };
}

export const MAX_PERSISTED_BACKGROUND_TASK_ID_LENGTH = 512;
export const MAX_PERSISTED_BACKGROUND_TASK_TEXT_LENGTH = 4_096;
export const MAX_PERSISTED_BACKGROUND_TASK_PATH_LENGTH = 4_096;
export const MAX_PERSISTED_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * A task's output path, exactly as the CLI reported it.
 *
 * Unlike {@link persistedTaskText} nothing is stripped: a path with a control
 * character removed names a different file, so such a path is dropped whole.
 */
export function persistedTaskPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PERSISTED_BACKGROUND_TASK_PATH_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

/** SDK task usage (`total_tokens`, `tool_uses`, `duration_ms`), or nothing. */
export function persistedTaskUsage(value: unknown): BackgroundTaskUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const count = (field: unknown): number | undefined =>
    typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined;
  const totalTokens = count(usage.total_tokens);
  const toolUses = count(usage.tool_uses);
  const durationMs = count(usage.duration_ms);
  if (totalTokens === undefined || toolUses === undefined || durationMs === undefined) {
    return undefined;
  }
  return { totalTokens, toolUses, durationMs };
}

export function persistedTaskIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PERSISTED_BACKGROUND_TASK_ID_LENGTH
  ) {
    return undefined;
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PERSISTED_BACKGROUND_TASK_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

export const MAX_PERSISTED_BACKGROUND_TASK_NAME_LENGTH = 256;

/**
 * A name the CLI chose (a task kind, a tool, a workflow). Like a path, one
 * that is too long or carries control characters is dropped rather than cut
 * down to a different name.
 */
export function persistedTaskName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length > 0 &&
    name.length <= MAX_PERSISTED_BACKGROUND_TASK_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(name)
    ? name
    : undefined;
}

/** A non-negative duration in milliseconds, or nothing. */
export function persistedTaskDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function persistedTaskText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let normalized = value
    .slice(0, MAX_PERSISTED_BACKGROUND_TASK_TEXT_LENGTH + 1)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_PERSISTED_BACKGROUND_TASK_TEXT_LENGTH);
  // Do not expose a dangling UTF-16 high surrogate when the byte-unaware
  // bound cuts immediately between an emoji's two code units.
  if (/[\ud800-\udbff]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function persistedTaskStatus(value: unknown): BackgroundTaskSnapshot["status"] | undefined {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "killed" ||
    value === "paused"
    ? value
    : undefined;
}

export function persistedNotificationStatus(
  value: unknown,
): "completed" | "failed" | "stopped" | undefined {
  return value === "completed" || value === "failed" || value === "stopped" ? value : undefined;
}

export function persistedTimestamp(value: unknown, now: number): number | undefined {
  const timestamp =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) &&
    timestamp >= 0 &&
    timestamp <= now + MAX_PERSISTED_TIMESTAMP_FUTURE_SKEW_MS
    ? timestamp
    : undefined;
}

export function persistedBackgroundTaskMessage(raw: {
  message: unknown;
}): BackgroundTaskSystemMessage | undefined {
  // Current SDK session reads place the original transcript payload in
  // `message`. Accept the outer record too so older/custom SessionStore
  // adapters that return system fields directly remain readable.
  for (const candidate of [raw.message, raw]) {
    if (!candidate || typeof candidate !== "object") continue;
    const message = candidate as Record<string, unknown>;
    if (
      message.subtype !== "task_started" &&
      message.subtype !== "task_progress" &&
      message.subtype !== "task_updated" &&
      message.subtype !== "task_notification"
    ) {
      continue;
    }
    const taskId = persistedTaskIdentifier(message.task_id);
    if (!taskId) continue;
    const notificationStatus =
      message.subtype === "task_notification"
        ? persistedNotificationStatus(message.status)
        : undefined;
    // A malformed terminal record is not evidence of success. Ignore it and
    // let a preceding live edge reconcile to killed when hydration observes
    // that its owning process is gone.
    if (message.subtype === "task_notification" && !notificationStatus) {
      continue;
    }
    const rawPatch =
      message.patch && typeof message.patch === "object" && !Array.isArray(message.patch)
        ? (message.patch as Record<string, unknown>)
        : undefined;
    const patchStatus = persistedTaskStatus(rawPatch?.status);
    const patchDescription = persistedTaskText(rawPatch?.description);
    const patchEndTime = persistedTimestamp(rawPatch?.end_time, Date.now());
    const patchError = persistedTaskText(rawPatch?.error);
    const patchIsBackgrounded =
      typeof rawPatch?.is_backgrounded === "boolean" ? rawPatch.is_backgrounded : undefined;
    const patchPausedMs = persistedTaskDuration(rawPatch?.total_paused_ms);
    const hasPatch =
      patchStatus !== undefined ||
      patchDescription !== undefined ||
      patchEndTime !== undefined ||
      patchError !== undefined ||
      patchIsBackgrounded !== undefined ||
      patchPausedMs !== undefined;
    const taskType = persistedTaskName(message.task_type);
    const parentTaskId = persistedTaskIdentifier(message.parent_task_id);
    // Bounded like every task text: the whole map is re-sent on each edge.
    const prompt = persistedTaskText(message.prompt);
    const workflowName = persistedTaskName(message.workflow_name);
    const lastToolName = persistedTaskName(message.last_tool_name);
    const workflow = parseWorkflowProgress(
      message.workflow_progress,
      message.workflow_progress_omitted,
    );
    return {
      subtype: message.subtype,
      task_id: taskId,
      tool_use_id: persistedTaskIdentifier(message.tool_use_id),
      description: persistedTaskText(message.description),
      summary: persistedTaskText(message.summary),
      status: notificationStatus,
      output_file: persistedTaskPath(message.output_file),
      usage: persistedTaskUsage(message.usage),
      ...(taskType ? { task_type: taskType } : {}),
      ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
      ...(prompt ? { prompt } : {}),
      ...(workflowName ? { workflow_name: workflowName } : {}),
      ...(lastToolName ? { last_tool_name: lastToolName } : {}),
      ...(message.reason === "worker_restart" ? { reason: "worker_restart" as const } : {}),
      ...(message.ambient === true || message.skip_transcript === true ? { ambient: true } : {}),
      ...(workflow
        ? { workflow_agents: workflow.agents, workflow_agents_omitted: workflow.omitted }
        : {}),
      ...(hasPatch
        ? {
            patch: {
              status: patchStatus,
              description: patchDescription,
              end_time: patchEndTime,
              error: patchError,
              is_backgrounded: patchIsBackgrounded,
              ...(patchPausedMs !== undefined ? { total_paused_ms: patchPausedMs } : {}),
            },
          }
        : {}),
    };
  }
  return undefined;
}

/**
 * When a persisted record was written, in epoch milliseconds.
 *
 * `fallback` is the position the caller already assigned this record on the
 * materialization's synthetic scale, for a record that carries no clock of its
 * own. Reading `Date.now()` instead would answer on a different scale from the
 * rows around it, and the renderer resolves a settled card's position by
 * comparing a task's terminal edge against those rows — so the card would land
 * wherever this loop happened to have reached, not where the task stopped.
 */
export function persistedRecordTime(raw: { message: unknown }, fallback?: number): number {
  const now = Date.now();
  const outerTimestamp = (raw as { timestamp?: unknown }).timestamp;
  const innerTimestamp =
    raw.message && typeof raw.message === "object"
      ? (raw.message as { timestamp?: unknown }).timestamp
      : undefined;
  for (const candidate of [innerTimestamp, outerTimestamp]) {
    const parsed = persistedTimestamp(candidate, now);
    if (parsed !== undefined) return parsed;
  }
  return fallback ?? now;
}

export function reducePersistedBackgroundTaskMessage(
  tasks: Record<string, BackgroundTaskSnapshot> | undefined,
  message: BackgroundTaskSystemMessage,
  timestamp: number,
): Record<string, BackgroundTaskSnapshot> {
  const stored = tasks?.[message.task_id];
  // A new launch under a finished task's id starts a fresh run, just as in
  // the live iterator. Late progress from the old run must not revive it.
  const resumedRun =
    message.subtype === "task_started" &&
    stored !== undefined &&
    !LIVE_BACKGROUND_TASK_STATUSES.has(stored.status) &&
    message.tool_use_id !== undefined &&
    message.tool_use_id !== stored.toolUseId;
  const previous = resumedRun
    ? {
        ...stored,
        ...RUN_SCOPED_TASK_METADATA_RESET,
        status: "running" as const,
        startedAt: timestamp,
        endedAt: undefined,
        error: undefined,
        summary: undefined,
        outputFile: undefined,
        usage: undefined,
      }
    : stored;
  if (message.subtype === "task_notification") {
    if (!message.status) return tasks ?? {};
    // As on the live edge: the resume scan does not relabel an ending this
    // replay already read, and marks a task it has no record of as cleanup.
    const orphanScan = resumeOrphanScanOutcome(message, previous);
    if (orphanScan === "already-settled") return tasks ?? {};
    const startedAt = previous?.startedAt ?? timestamp;
    const endedAt = timestamp >= startedAt ? timestamp : previous?.endedAt;
    const terminalStatus: BackgroundTaskSnapshot["status"] =
      message.status === "failed"
        ? "failed"
        : message.status === "stopped"
          ? "killed"
          : message.status === "completed"
            ? "completed"
            : "killed";
    return boundBackgroundTaskHistory({
      ...tasks,
      [message.task_id]: {
        id: message.task_id,
        toolUseId: message.tool_use_id ?? previous?.toolUseId,
        description: previous?.description ?? message.description ?? message.summary,
        status: terminalStatus,
        isBackgrounded: previous?.isBackgrounded,
        startedAt,
        endedAt,
        error: terminalStatus === "failed" ? (message.summary ?? previous?.error) : previous?.error,
        summary: message.summary ?? previous?.summary,
        outputFile: message.output_file ?? previous?.outputFile,
        usage: message.usage ?? previous?.usage,
        subagentType: previous?.subagentType,
        ...carriedTaskMetadata(previous),
        ...taskMessageMetadata(message, previous),
        ...(orphanScan === "cleanup" ? { endReason: "resume_cleanup" as const } : {}),
      },
    });
  }

  const patchStatus = message.patch?.status;
  const nextStatus =
    previous &&
    !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status) &&
    (patchStatus === undefined || LIVE_BACKGROUND_TASK_STATUSES.has(patchStatus))
      ? previous.status
      : (patchStatus ?? previous?.status ?? "running");
  const startedAt = previous?.startedAt ?? timestamp;
  const patchedEndTime =
    message.patch?.end_time !== undefined && message.patch.end_time >= startedAt
      ? message.patch.end_time
      : undefined;
  return boundBackgroundTaskHistory({
    ...tasks,
    [message.task_id]: {
      id: message.task_id,
      toolUseId: message.tool_use_id ?? previous?.toolUseId,
      description: taskEdgeDescription(message, previous),
      status: nextStatus,
      isBackgrounded: message.patch?.is_backgrounded ?? previous?.isBackgrounded ?? true,
      startedAt,
      endedAt: patchedEndTime ?? previous?.endedAt,
      error: message.patch?.error ?? previous?.error,
      summary: previous?.summary,
      outputFile: previous?.outputFile,
      // A terminal report is authoritative over delayed progress for that run.
      usage:
        previous && !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status) && previous.usage
          ? previous.usage
          : (message.usage ?? previous?.usage),
      subagentType: previous?.subagentType,
      ...carriedTaskMetadata(previous),
      ...taskMessageMetadata(message, previous),
    },
  });
}
