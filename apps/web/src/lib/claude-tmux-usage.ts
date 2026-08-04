import type { TmuxAgentUsageSummary } from "@orkestrator/protocol/tmux-observation";
import type { ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";

interface IndexedUsageSummary extends TmuxAgentUsageSummary {
  index: number;
  normalizedName: string;
}

function normalizeAgentName(value: string | undefined): string {
  return (value ?? "")
    .replace(/\([^)]*\)\s*$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function readString(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isAgentTool(part: ClaudeMessagePart): boolean {
  const toolName = part.toolName?.trim().toLowerCase();
  return toolName === "agent" || toolName === "task";
}

function isTerminalToolState(state: ClaudeMessagePart["toolState"]): boolean {
  return state === "success" || state === "failure";
}

function agentNameCandidates(part: ClaudeMessagePart): string[] {
  return [
    readString(part.toolArgs, "agent_name", "agentName", "name"),
    readString(part.toolArgs, "description"),
    part.content,
    part.toolTitle,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function candidateMatches(candidate: string, summary: IndexedUsageSummary): boolean {
  const normalized = normalizeAgentName(candidate);
  if (!normalized || !summary.normalizedName) return false;
  if (["agent", "task", "subagent"].includes(normalized)) return false;
  return normalized === summary.normalizedName
    || normalized.includes(summary.normalizedName)
    || summary.normalizedName.includes(normalized);
}

function indexedSummaries(summaries: TmuxAgentUsageSummary[]): IndexedUsageSummary[] {
  return summaries.map((summary, index) => ({
    ...summary,
    index,
    normalizedName: normalizeAgentName(summary.name),
  }));
}

function findMatchingSummary(
  part: ClaudeMessagePart,
  summaries: IndexedUsageSummary[],
  used: Set<number>,
  agentIndex: number,
  allowOrdinalFallback: boolean,
): IndexedUsageSummary | undefined {
  const candidates = agentNameCandidates(part);
  const exact = summaries.find(
    (summary) => !used.has(summary.index)
      && candidates.some((candidate) => candidateMatches(candidate, summary)),
  );
  if (exact) return exact;
  if (!allowOrdinalFallback) return undefined;
  const ordinal = summaries[agentIndex];
  return ordinal && !used.has(ordinal.index) ? ordinal : undefined;
}

/** Apply backend-parsed usage facts to renderer message parts. */
export function applyTmuxAgentUsageSummaries(
  messages: ClaudeMessage[],
  summaries: TmuxAgentUsageSummary[],
): ClaudeMessage[] {
  if (summaries.length === 0) return messages;
  const indexed = indexedSummaries(summaries);
  const used = new Set<number>();
  let agentIndex = 0;
  let changed = false;

  const nextMessages = messages.map((message) => {
    let partsChanged = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool-invocation" || !isAgentTool(part)) return part;
      const allowOrdinalFallback = !isTerminalToolState(part.toolState);
      const summary = findMatchingSummary(
        part,
        indexed,
        used,
        agentIndex,
        allowOrdinalFallback,
      );
      if (allowOrdinalFallback) agentIndex += 1;
      if (!summary) return part;
      used.add(summary.index);
      if (
        (summary.toolUseCount === undefined || part.toolUseCount === summary.toolUseCount)
        && part.tokenCount === summary.tokenCount
        && part.tokenCountText === summary.tokenCountText
        && part.agentUsageDisplay === "token-only"
        && part.agentState === "active"
      ) return part;

      changed = true;
      partsChanged = true;
      return {
        ...part,
        ...(summary.toolUseCount === undefined ? {} : { toolUseCount: summary.toolUseCount }),
        tokenCount: summary.tokenCount,
        tokenCountText: summary.tokenCountText,
        agentUsageDisplay: "token-only" as const,
        agentState: "active" as const,
      };
    });
    return partsChanged ? { ...message, parts } : message;
  });
  return changed ? nextMessages : messages;
}
