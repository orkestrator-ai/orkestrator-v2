import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { countPiCostParts, reportedAnything, type PiCostParts } from "./cost-source.js";
import { boundedModelId, responseModelId } from "./models.js";
import { isObject, type SessionState, type TurnUsage } from "./state.js";

// undefined means no contributor yet, null means mixed or unidentified.
type UsageModel = string | null | undefined;

export interface ResponseUsage extends PiCostParts {
  tokens: TurnUsage;
  totalTokens: number;
  costUsd: number;
  modelId?: UsageModel;
  latestModelId?: string;
}

const TOKEN_FIELDS = {
  inputTokens: "input",
  outputTokens: "output",
  cacheReadTokens: "cacheRead",
  cacheWriteTokens: "cacheWrite",
  reasoningTokens: "reasoning",
} as const;

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageModel(current: UsageModel, next: string | undefined): UsageModel {
  if (current === undefined) return next ?? null;
  return current === next ? current : null;
}

function answered(message: unknown): boolean {
  return (
    isObject(message) &&
    message.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}

/** Both the completion listener and session-file fallback use the same accounting. */
export function accumulateResponseUsage(
  current: ResponseUsage | undefined,
  message: unknown,
  selectedModelId: string | undefined,
): ResponseUsage | undefined {
  if (!isObject(message) || message.role !== "assistant") return current;
  const modelId = responseModelId(message);
  const latestModelId = answered(message) ? (modelId ?? selectedModelId) : undefined;
  const usage = isObject(message.usage) ? message.usage : undefined;
  const spent = usage && reportedAnything(usage);
  if (!spent && !latestModelId) return current;
  const result = current ?? { tokens: {}, totalTokens: 0, costUsd: 0, parts: 0, providerParts: 0 };
  if (latestModelId) result.latestModelId = latestModelId;
  if (!spent) return result;

  let tokens = 0;
  for (const key of Object.keys(TOKEN_FIELDS) as (keyof TurnUsage)[]) {
    const value = usage[TOKEN_FIELDS[key]];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    result.tokens[key] = (result.tokens[key] ?? 0) + value;
    // Pi's reasoning count is already included in output.
    if (key !== "reasoningTokens") tokens += value;
  }
  result.totalTokens += numberOrZero(usage.totalTokens) || tokens;
  const cost = isObject(usage.cost) ? usage.cost : undefined;
  result.costUsd += numberOrZero(cost?.total);
  result.parts += 1;
  if (cost?.totalFromProvider === true) result.providerParts += 1;
  result.modelId = usageModel(result.modelId, modelId);
  return result;
}

export function readSessionEntries(session: AgentSession | null): SessionEntry[] | undefined {
  try {
    return session?.sessionManager?.getEntries();
  } catch {
    return undefined;
  }
}

export function readEntryCount(session: AgentSession): number | undefined {
  try {
    return session.sessionManager?.getEntryCount?.() ?? readSessionEntries(session)?.length;
  } catch {
    return undefined;
  }
}

/** The append-only log includes failed attempts and entries off the active branch. */
export function readTurnResponses(state: SessionState, entries: SessionEntry[] | undefined) {
  let stored: ResponseUsage | undefined;
  let turnId: string | undefined;
  const start = state.turnEntryOffset;
  if (entries && start !== undefined) {
    for (let index = start; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      turnId = entry.id;
      stored = accumulateResponseUsage(stored, entry.message, state.composer.selectedModelId);
    }
  }
  const live = state.currentTurnResponses;
  // A completed frame arrives before Pi writes it. Retain its usage if the
  // write failed, while the log covers responses for which we missed frames.
  const responses = (stored?.parts ?? 0) >= (live?.parts ?? 0) ? (stored ?? live) : live;
  return { turnId, responses };
}

/** The latest answer on the active branch, including after a resume. */
export function latestStoredModel(state: SessionState): string | undefined {
  try {
    const branch = state.session?.sessionManager?.getBranch() ?? [];
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index]!;
      if (entry.type === "message" && answered(entry.message)) {
        return responseModelId(entry.message) ?? state.composer.selectedModelId;
      }
    }
  } catch {
    // The finished turn or the last recorded usage can still name a model.
  }
  return undefined;
}

function entryModelId(entry: SessionEntry): string | undefined {
  if (entry.type === "message") return responseModelId(entry.message);
  if (entry.type === "usage") return boundedModelId(entry.provider, entry.model);
  return undefined;
}

function sameCost(a: number, b: number): boolean {
  return a === b || Math.abs(a - b) <= Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
}

/** Match the billed suffix to the same baseline as the session cost delta. */
export function readPiCost(
  entries: SessionEntry[] | undefined,
  previousCost: number,
  previousParts: number | undefined,
  sessionCost: number | undefined,
): { parts?: PiCostParts; modelId?: string } {
  if (!entries) return {};
  const baseline = previousParts ?? (previousCost === 0 ? 0 : undefined);
  let prefixCost = 0;
  let totalCost = 0;
  let modelId: UsageModel;
  const parts = countPiCostParts(entries, (entry, usage, index) => {
    const cost = numberOrZero(usage.cost?.total);
    if (cost === 0) return;
    totalCost += cost;
    if (baseline === undefined || index < baseline) prefixCost += cost;
    else modelId = usageModel(modelId, entryModelId(entry));
  });
  if (
    sessionCost !== undefined &&
    baseline !== undefined &&
    baseline <= parts.parts &&
    sameCost(prefixCost, previousCost) &&
    sameCost(totalCost, sessionCost) &&
    typeof modelId === "string"
  ) {
    return { parts, modelId };
  }
  return { parts };
}
