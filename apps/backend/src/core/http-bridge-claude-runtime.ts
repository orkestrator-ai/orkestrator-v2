import {
  normalizeNativeAgentTurnActivity,
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

function textField<K extends "error" | "summary">(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
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
