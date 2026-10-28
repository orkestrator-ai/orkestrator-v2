import {
  normalizeNativeAgentTurnActivity,
  READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS,
  type NativeAgentBackgroundTaskKind,
  type NativeAgentBackgroundTaskSummary,
  type NativeAgentBackgroundTaskUsage,
  type NativeAgentTurnActivity,
} from "@orkestrator/protocol/native-agent";
import { asRecord } from "./agent-provider-runtime.js";

/**
 * The turn activity a Claude bridge snapshot reports: `activity` names what the
 * CLI said it is doing (only `compacting` today) and `thinkingTokens` is the
 * live thinking estimate. Absent unless the session is running, so an estimate
 * left over from a finished turn can never decorate an idle tab.
 */
export function claudeTurnActivityFromPayload(
  payload: Record<string, unknown> | undefined,
): NativeAgentTurnActivity | undefined {
  if (!payload || payload.status !== "running") return undefined;
  return normalizeNativeAgentTurnActivity({
    compacting: payload.activity === "compacting",
    thinkingTokens: payload.thinkingTokens,
  });
}

function isoFromEpoch(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function startedAtField(startedAt: unknown): { startedAt?: string } {
  const value = isoFromEpoch(startedAt);
  return value ? { startedAt: value } : {};
}

function isLiveTaskStatus(status: unknown): boolean {
  return status === "pending" || status === "running" || status === "paused";
}

function settledAtFromEndedAt(endedAt: unknown, status: unknown): { settledAt?: string } {
  if (isLiveTaskStatus(status)) return {};
  const settledAt = isoFromEpoch(endedAt);
  return settledAt ? { settledAt } : {};
}

const BACKGROUND_TASK_TEXT_MAX_LENGTH = 4_096;
const BACKGROUND_TASK_PATH_MAX_LENGTH = 4_096;

function textField<
  K extends "error" | "summary" | "prompt" | "command" | "outputTail" | "progressSummary",
>(key: K, value: unknown): Partial<Record<K, string>> {
  if (typeof value !== "string") return {};
  const text = value.trim().slice(0, BACKGROUND_TASK_TEXT_MAX_LENGTH);
  return text ? ({ [key]: text } as Partial<Record<K, string>>) : {};
}

/** A path is passed whole or not at all: a truncated path names another file. */
function outputFileField(value: unknown): { outputFile?: string } {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= BACKGROUND_TASK_PATH_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? { outputFile: value }
    : {};
}

const BACKGROUND_TASK_AGENT_ROLE_MAX_LENGTH = 256;

/**
 * Claude's `subagentType` (a `local_agent` task's agent type, or `main-session`
 * for a backgrounded main session) is the neutral `agentRole`. A role is a
 * name, so one that is too long or carries control characters is dropped
 * rather than cut down to a different name.
 */
function agentRoleField(value: unknown): { agentRole?: string } {
  return nameField("agentRole", value);
}

/** A name passes whole or not at all, for the reason {@link agentRoleField} gives. */
function nameField<K extends "agentRole" | "parentTaskId" | "workflowName" | "lastToolName">(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  if (typeof value !== "string") return {};
  const name = value.trim();
  return name.length > 0 &&
    name.length <= BACKGROUND_TASK_AGENT_ROLE_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(name)
    ? ({ [key]: name } as Partial<Record<K, string>>)
    : {};
}

/** Claude's CLI task kinds, in the protocol's neutral terms. */
const CLAUDE_TASK_KINDS: Record<string, NativeAgentBackgroundTaskKind> = {
  local_bash: "shell",
  local_agent: "agent",
  local_workflow: "workflow",
  remote_agent: "remote-agent",
  mcp_task: "mcp",
  monitor_mcp: "mcp",
  in_process_teammate: "teammate",
};

function kindField(taskType: unknown): { kind?: NativeAgentBackgroundTaskKind } {
  if (typeof taskType !== "string" || taskType.length === 0) return {};
  return {
    kind: Object.hasOwn(CLAUDE_TASK_KINDS, taskType) ? CLAUDE_TASK_KINDS[taskType] : "other",
  };
}

/** The bridge's end reasons, in the protocol's spelling. */
function endReasonField(value: unknown): Pick<NativeAgentBackgroundTaskSummary, "endReason"> {
  if (value === "worker_restart") return { endReason: "process-restart" };
  if (value === "resume_cleanup") return { endReason: "resume-cleanup" };
  return {};
}

function pausedMsField(value: unknown): { pausedMs?: number } {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? { pausedMs: value }
    : {};
}

function usageField(value: unknown): { usage?: NativeAgentBackgroundTaskUsage } {
  const usage = asRecord(value);
  if (!usage) return {};
  const count = (field: unknown): number | undefined =>
    typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined;
  const totalTokens = count(usage.totalTokens);
  const toolUses = count(usage.toolUses);
  const durationMs = count(usage.durationMs);
  if (totalTokens === undefined || toolUses === undefined || durationMs === undefined) return {};
  return { usage: { totalTokens, toolUses, durationMs } };
}

export function normalizeClaudeBackgroundTasks(
  value: unknown,
): NativeAgentBackgroundTaskSummary[] | undefined {
  const tasks = asRecord(value);
  if (!tasks) return undefined;
  const allowed = new Set(["pending", "running", "completed", "failed", "killed", "paused"]);
  return Object.entries(tasks)
    .slice(0, 256)
    .flatMap(([id, raw]) => {
      const task = asRecord(raw);
      if (!task || !allowed.has(String(task.status))) return [];
      return [
        {
          id,
          status: task.status as NativeAgentBackgroundTaskSummary["status"],
          ...(typeof task.description === "string"
            ? { description: task.description.slice(0, 1_000) }
            : {}),
          ...(typeof task.toolUseId === "string" && task.toolUseId.length <= 512
            ? { toolUseId: task.toolUseId }
            : {}),
          ...startedAtField(task.startedAt),
          ...settledAtFromEndedAt(task.endedAt, task.status),
          ...textField("error", task.error),
          ...textField("summary", task.summary),
          ...outputFileField(task.outputFile),
          ...usageField(task.usage),
          ...agentRoleField(task.subagentType),
          ...kindField(task.taskType),
          ...nameField("parentTaskId", task.parentTaskId),
          ...textField("prompt", task.prompt),
          ...textField("command", task.command),
          ...textField("outputTail", task.outputTail),
          ...nameField("workflowName", task.workflowName),
          ...(task.ambient === true ? { ambient: true } : {}),
          ...nameField("lastToolName", task.lastToolName),
          ...textField("progressSummary", task.progressSummary),
          ...pausedMsField(task.pausedMs),
          ...endReasonField(task.endReason),
        },
      ];
    });
}

/**
 * Whether a session snapshot still holds a background task that can do work.
 *
 * Claude releases a turn to `idle` as soon as its root result arrives, even
 * when that turn launched background agents or commands. The SDK re-enters the
 * same session once they settle, so an idle session with live tasks has not
 * finished the work its prompt asked for.
 */
export function hasLiveClaudeBackgroundTask(value: unknown): boolean {
  return (normalizeClaudeBackgroundTasks(value) ?? []).some((task) =>
    isLiveTaskStatus(task.status),
  );
}

export function claudeBackgroundObservation(body: Record<string, unknown>, status: string) {
  if (status !== "idle") return {};
  const ids = body.retainedContinuationRequestIds;
  return {
    ...(hasLiveClaudeBackgroundTask(body.backgroundTasks) ? { backgroundWorkLive: true } : {}),
    ...(Array.isArray(ids)
      ? { retainedContinuationRequestIds: ids.filter((id): id is string => typeof id === "string") }
      : {}),
  };
}

/**
 * Why the session's latest read-only turn ran its commands with the CLI's
 * sandbox off, as a Claude bridge reports it: the probe found no
 * working sandbox where the bridge runs, so the read-only hook was the whole
 * boundary. Bounded, and absent for any other shape or an older bridge.
 */
export function claudeReadOnlySandboxObservation(body: Record<string, unknown>): {
  commandSandboxOff?: string;
} {
  const reported = asRecord(body.readOnlyCommandSandbox);
  if (reported?.state !== "off" || typeof reported.reason !== "string") return {};
  const reason = reported.reason.trim();
  if (!reason) return {};
  return {
    commandSandboxOff:
      reason.length > READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS
        ? `${reason.slice(0, READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS - 1)}…`
        : reason,
  };
}
