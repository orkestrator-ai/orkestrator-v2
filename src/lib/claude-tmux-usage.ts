import type { ClaudeMessage, ClaudeMessagePart } from "@/lib/claude-client";

export interface TmuxAgentUsageSummary {
  name: string;
  role?: string;
  toolUseCount?: number;
  tokenCount: number;
  tokenCountText: string;
}

interface IndexedUsageSummary extends TmuxAgentUsageSummary {
  index: number;
  normalizedName: string;
}

const AGENT_USAGE_RE =
  /^(?<name>.+?)\s*[·•]\s*(?<toolUseCount>\d[\d,]*)\s+tools?\s+uses?\s*[·•]\s*(?<tokens>\d[\d,.]*(?:[kKmMbB])?)\s+tokens?\b/;
const AGENT_TOKEN_USAGE_RE =
  /^(?:(?<role>[\p{L}\p{N}_ -]{1,48}?)\s{2,})?(?<name>.+?)\s+(?:(?<duration>(?:\d+\s*[hms]\s*)+)\s*)?(?:[·•]\s*)?[↓↑↕]?\s*(?<tokens>\d[\d,.]*(?:[kKmMbB])?)\s+tokens?\b/iu;
const AGENT_HEADER_RE = /\bRunning\s+\d+\s+(?<role>.+?)\s+agents?\b/i;

function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function stripTreePrefix(line: string): string {
  return line.trim().replace(/^[│├└┌┐┘┴┬─╭╰╮╯┼┤○●◦∙\s]+/, "").trim();
}

function hasAgentLineMarker(line: string): boolean {
  return /^[│├└┌┐┘┴┬─╭╰╮╯┼┤○●◦∙\s]*[├└○●◦∙]/u.test(line);
}

function parseCompactNumber(value: string): number | null {
  const cleaned = value.trim().replaceAll(",", "");
  const match = /^(?<amount>\d+(?:\.\d+)?)(?<suffix>[kKmMbB])?$/.exec(cleaned);
  if (!match?.groups) return null;

  const amount = Number(match.groups.amount);
  if (!Number.isFinite(amount)) return null;

  const suffix = match.groups.suffix?.toLowerCase();
  const multiplier =
    suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return Math.round(amount * multiplier);
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
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
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
  if (normalized === "agent" || normalized === "task" || normalized === "subagent") {
    return false;
  }
  return (
    normalized === summary.normalizedName ||
    normalized.includes(summary.normalizedName) ||
    summary.normalizedName.includes(normalized)
  );
}

function indexedSummaries(
  summaries: TmuxAgentUsageSummary[],
): IndexedUsageSummary[] {
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
    (summary) =>
      !used.has(summary.index) &&
      candidates.some((candidate) => candidateMatches(candidate, summary)),
  );
  if (exact) return exact;

  if (!allowOrdinalFallback) return undefined;

  const ordinal = summaries[agentIndex];
  return ordinal && !used.has(ordinal.index) ? ordinal : undefined;
}

export function parseTmuxAgentUsageSummaries(
  snapshot: string,
): TmuxAgentUsageSummary[] {
  const summaries: TmuxAgentUsageSummary[] = [];
  let currentRole: string | undefined;

  for (const rawLine of stripAnsi(snapshot).split("\n")) {
    const line = stripTreePrefix(rawLine);
    if (!line) continue;

    const headerMatch = AGENT_HEADER_RE.exec(line);
    if (headerMatch?.groups?.role) {
      currentRole = headerMatch.groups.role.trim();
    }

    const match = AGENT_USAGE_RE.exec(line);
    if (match?.groups) {
      const name = match.groups.name;
      const toolUseCountText = match.groups.toolUseCount;
      const tokens = match.groups.tokens;
      if (!name || !toolUseCountText || !tokens) continue;

      const toolUseCount = Number(toolUseCountText.replaceAll(",", ""));
      const tokenCount = parseCompactNumber(tokens);
      if (!Number.isFinite(toolUseCount) || tokenCount === null) continue;

      summaries.push({
        name: name.trim(),
        role: currentRole,
        toolUseCount,
        tokenCount,
        tokenCountText: `${tokens} tokens`,
      });
      continue;
    }

    const tokenOnlyMatch = AGENT_TOKEN_USAGE_RE.exec(line);
    if (!tokenOnlyMatch?.groups) continue;

    const inlineRole = tokenOnlyMatch.groups.role?.trim();
    if (!inlineRole && !currentRole && !hasAgentLineMarker(rawLine)) continue;

    const name = tokenOnlyMatch.groups.name?.replace(/\s*[·•]\s*$/, "").trim();
    const tokens = tokenOnlyMatch.groups.tokens;
    if (!name || !tokens) continue;

    const tokenCount = parseCompactNumber(tokens);
    if (tokenCount === null) continue;

    summaries.push({
      name,
      role: inlineRole ?? currentRole,
      tokenCount,
      tokenCountText: `${tokens} tokens`,
    });
  }

  return summaries;
}

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
        (summary.toolUseCount === undefined || part.toolUseCount === summary.toolUseCount) &&
        part.tokenCount === summary.tokenCount &&
        part.tokenCountText === summary.tokenCountText &&
        part.agentUsageDisplay === "token-only"
      ) {
        return part;
      }

      changed = true;
      partsChanged = true;
      return {
        ...part,
        ...(summary.toolUseCount === undefined ? {} : { toolUseCount: summary.toolUseCount }),
        tokenCount: summary.tokenCount,
        tokenCountText: summary.tokenCountText,
        agentUsageDisplay: "token-only" as const,
      };
    });

    return partsChanged ? { ...message, parts } : message;
  });

  return changed ? nextMessages : messages;
}
