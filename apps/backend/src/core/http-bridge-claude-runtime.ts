import type { NativeAgentBackgroundTaskSummary } from "@orkestrator/protocol/native-agent";
import { asRecord } from "./agent-provider-runtime.js";

function isoFromEpoch(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function startedAtField(startedAt: unknown): { startedAt?: string } {
  const value = isoFromEpoch(startedAt);
  return value ? { startedAt: value } : {};
}

function settledAtFromEndedAt(endedAt: unknown, status: unknown): { settledAt?: string } {
  const live = status === "pending" || status === "running" || status === "paused";
  if (live) return {};
  const settledAt = isoFromEpoch(endedAt);
  return settledAt ? { settledAt } : {};
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
        },
      ];
    });
}
