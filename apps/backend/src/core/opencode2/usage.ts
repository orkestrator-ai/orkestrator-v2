/**
 * OpenCode 2.x usage and cost (docs/todo/agent-engines/0008-opencode-v2.md,
 * build plan phase 4).
 *
 * 2.x keeps the cumulative ledger itself: `Session.Info.tokens` and `cost`
 * are the session's lifetime totals, summed server-side as each response
 * settles (`SessionUsage.record`). That is the authoritative consumption
 * figure, so it is read from the session rather than re-summed from a
 * bounded transcript window, which under-counts a long job. Context
 * occupancy (`usedTokens`) is the newest response's own prompt size, read
 * from its assistant row.
 *
 * Cost source: 2.x prices every response from the model's catalogue rate
 * (`SessionUsage.calculateCost(model.cost, tokens)` at 2.2.6), as 1.x did,
 * so a cost is an `estimate`. GitHub Copilot is the one provider whose 1.x
 * figure could come from the provider's own billing metadata; its source is
 * left unknown on 2.x too rather than called either.
 */
import type {
  NativeAgentContextUsage,
  NativeAgentCostSource,
  NativeAgentTurnUsage,
} from "@orkestrator/protocol/native-agent";
import { asRecord, nonEmptyString } from "../agent-provider-runtime.js";
import type { OpenCode2Message, OpenCode2Session } from "./types.js";

/** Recent per-response entries kept on a usage value, as every provider does. */
/** Per-response entries a usage report carries, matching every other provider. */
export const OPENCODE2_USAGE_TURN_LIMIT = 20;
const MAX_TURNS = OPENCODE2_USAGE_TURN_LIMIT;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function openCode2CostSource(
  providerId: string | undefined,
): NativeAgentCostSource | undefined {
  return providerId?.startsWith("github-copilot") ? undefined : "estimate";
}

type Tokens = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

function tokens(value: unknown): Tokens {
  const record = asRecord(value);
  const cache = asRecord(record?.cache);
  return {
    input: count(record?.input),
    output: count(record?.output),
    reasoning: count(record?.reasoning),
    cacheRead: count(cache?.read),
    cacheWrite: count(cache?.write),
  };
}

function total(value: Tokens): number {
  return value.input + value.output + value.cacheRead + value.cacheWrite;
}

function modelOf(row: Record<string, unknown> | null): { id?: string; provider?: string } {
  const model = asRecord(row?.model);
  const provider = nonEmptyString(model?.providerID) ?? undefined;
  const id = nonEmptyString(model?.id);
  return {
    ...(provider ? { provider } : {}),
    ...(provider && id ? { id: `${provider}/${id}` } : {}),
  };
}

/** Per-response usage of the assistant rows given, newest last, bounded to the last twenty. */
export function openCode2TurnUsage(messages: readonly OpenCode2Message[]): NativeAgentTurnUsage[] {
  const turns: NativeAgentTurnUsage[] = [];
  for (const message of messages) {
    const row = asRecord(message);
    if (row?.type !== "assistant" || !asRecord(row.tokens)) continue;
    const id = nonEmptyString(row.id);
    if (!id) continue;
    const used = tokens(row.tokens);
    const model = modelOf(row);
    const costUsd =
      typeof row.cost === "number" && Number.isFinite(row.cost) ? row.cost : undefined;
    const costSource = costUsd === undefined ? undefined : openCode2CostSource(model.provider);
    const time = asRecord(row.time);
    const at = iso(time?.completed) ?? iso(time?.created);
    const created = time?.created;
    const completed = time?.completed;
    turns.push({
      turnId: id,
      ...(at ? { at } : {}),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(costSource ? { costSource } : {}),
      inputTokens: used.input,
      outputTokens: used.output,
      reasoningTokens: used.reasoning,
      cacheReadTokens: used.cacheRead,
      cacheWriteTokens: used.cacheWrite,
      totalTokens: total(used),
      ...(typeof created === "number" && typeof completed === "number" && completed >= created
        ? { durationMs: completed - created }
        : {}),
      ...(model.id ? { modelId: model.id } : {}),
    });
  }
  return turns.slice(-MAX_TURNS);
}

/**
 * The session's usage: lifetime totals from the session, context occupancy
 * and recent per-response entries from the newest assistant rows given
 * (oldest first). Undefined while nothing has been spent.
 */
export function openCode2ContextUsage(
  session: Pick<OpenCode2Session, "tokens" | "cost" | "model" | "time"> | undefined,
  recentAssistantRows: readonly OpenCode2Message[] = [],
): NativeAgentContextUsage | undefined {
  const turns = openCode2TurnUsage(recentAssistantRows);
  const lifetime = tokens(session?.tokens);
  const costUsd = count(session?.cost);
  const sessionTokens = total(lifetime);
  const latest = turns.at(-1);
  if (sessionTokens <= 0 && costUsd <= 0 && !latest) return undefined;
  // Context occupancy is the prompt the newest response was given.
  const usedTokens = latest
    ? (latest.inputTokens ?? 0) + (latest.cacheReadTokens ?? 0) + (latest.cacheWriteTokens ?? 0)
    : 0;
  const sessionModel = modelOf(asRecord(session ?? null));
  const modelId = latest?.modelId ?? sessionModel.id;
  const provider = modelId?.split("/")[0];
  const costSource = costUsd > 0 ? openCode2CostSource(provider) : undefined;
  return {
    usedTokens,
    ...(latest ? { lastTurnTokens: latest.totalTokens } : {}),
    inputTokens: lifetime.input,
    outputTokens: lifetime.output,
    reasoningTokens: lifetime.reasoning,
    cacheReadTokens: lifetime.cacheRead,
    cacheWriteTokens: lifetime.cacheWrite,
    sessionTokens,
    costUsd,
    ...(costSource ? { costSource } : {}),
    estimated: false,
    source: "opencode",
    ...(modelId ? { modelId } : {}),
    // From the transcript, never the wall clock, so an unchanged session
    // keeps an identical value (the state token hashes it).
    ...(latest?.at ? { updatedAt: latest.at } : {}),
    ...(turns.length > 0 ? { turns } : {}),
  };
}
