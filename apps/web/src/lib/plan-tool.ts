import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";

const PLAN_TOOL_NAMES = new Set(["createplan", "create_plan"]);

function normalizeToolName(toolName?: string): string | undefined {
  return typeof toolName === "string" ? toolName.trim().toLowerCase() : undefined;
}

/** Cursor `createPlan` (and snake_case variants). Not ACP's generic `plan` tool. */
export function isPlanTool(toolName?: string): boolean {
  const normalized = normalizeToolName(toolName);
  return typeof normalized === "string" && PLAN_TOOL_NAMES.has(normalized);
}

export function getPlanToolLabel(toolName?: string, toolTitle?: string): string {
  if (toolTitle?.trim() && toolTitle.trim().toLowerCase() !== normalizeToolName(toolName)) {
    return toolTitle.trim();
  }
  return "Plan";
}

/**
 * Recover the markdown body from a createPlan card.
 *
 * Newer transcripts keep the plan only in `toolOutput`. Older ones dumped it
 * into `toolArgs.plan` or serialized `{ plan: "..." }` as the output, so those
 * shapes are unwrapped rather than shown as escaped JSON.
 */
export function extractPlanMarkdown(
  toolArgs?: Record<string, unknown>,
  toolOutput?: string,
): string {
  if (typeof toolArgs?.plan === "string" && toolArgs.plan.trim()) return toolArgs.plan;
  if (!toolOutput) return "";
  const unwrapped = unwrapPlanJson(toolOutput);
  return unwrapped ?? toolOutput;
}

export function firstMarkdownHeading(plan: string): string | undefined {
  const match = /^#{1,6}\s+(.+)$/m.exec(plan);
  const heading = match?.[1]?.trim();
  return heading ? heading : undefined;
}

function unwrapPlanJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { plan?: unknown }).plan === "string"
    ) {
      return (parsed as { plan: string }).plan;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function nativeMessageHasPlanTool(message: NativeMessage): boolean {
  return partsHavePlanTool(message.parts);
}

function partsHavePlanTool(parts: readonly NativeMessagePart[]): boolean {
  for (const part of parts) {
    if (part.type === "tool-invocation" && isPlanTool(part.toolName)) return true;
    if (part.type === "tool-group" || part.type === "agent-group") {
      if (partsHavePlanTool(part.parts)) return true;
    }
    if (part.type === "task-group" && partsHavePlanTool([part.task, ...part.childTools])) {
      return true;
    }
    if (
      part.type === "subagent" &&
      part.subagentActions &&
      partsHavePlanTool(part.subagentActions)
    ) {
      return true;
    }
  }
  return false;
}
