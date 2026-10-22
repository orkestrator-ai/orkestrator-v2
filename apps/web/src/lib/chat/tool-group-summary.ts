import { isPlanTool } from "@/lib/plan-tool";
import { parseQuestionToolArgs } from "@/lib/question-tool";
import type { NativeMessagePart, NativeToolInvocationPart } from "./native-message-types";

/**
 * Fewest tool calls a group needs before it folds to one summary line. One or
 * two calls already fit in about the space the summary takes, so folding them
 * would only add a click.
 */
export const TOOL_GROUP_FOLD_MIN_CALLS = 3;

export interface ToolGroupSummary {
  /** Tool calls in the group, not counting reasoning rows between them. */
  toolCount: number;
  /** The newest call, which the folded line previews. */
  latestTool: NativeToolInvocationPart;
  pendingCount: number;
  failureCount: number;
  /**
   * From the first call's start to the last call's end, in milliseconds.
   *
   * A call's end is its start plus its reported runtime; a call without one
   * (still running, or a provider that does not report runtimes) ends where it
   * started. Undefined when no call carries a timestamp. Never a live clock: a
   * call left pending by an interrupted turn would otherwise tick forever.
   */
  spanMs?: number;
}

function toolCalls(parts: readonly NativeMessagePart[]): NativeToolInvocationPart[] {
  return parts.filter((part): part is NativeToolInvocationPart => part.type === "tool-invocation");
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function summarizeToolGroup(
  parts: readonly NativeMessagePart[],
): ToolGroupSummary | undefined {
  const tools = toolCalls(parts);
  const latestTool = tools.at(-1);
  if (!latestTool) return undefined;

  let pendingCount = 0;
  let failureCount = 0;
  let startMs: number | undefined;
  let endMs: number | undefined;
  for (const tool of tools) {
    if (tool.toolState === "pending") pendingCount += 1;
    if (tool.toolState === "failure" || tool.toolDenied) failureCount += 1;

    const start = timestampMs(tool.createdAt);
    if (start === undefined) continue;
    const duration =
      tool.toolState !== "pending" &&
      typeof tool.toolDurationMs === "number" &&
      Number.isFinite(tool.toolDurationMs) &&
      tool.toolDurationMs > 0
        ? tool.toolDurationMs
        : 0;
    startMs = startMs === undefined ? start : Math.min(startMs, start);
    endMs = endMs === undefined ? start + duration : Math.max(endMs, start + duration);
  }

  return {
    toolCount: tools.length,
    latestTool,
    pendingCount,
    failureCount,
    ...(startMs !== undefined && endMs !== undefined ? { spanMs: endMs - startMs } : {}),
  };
}

/**
 * Whether a tool group opens folded. A plan call never hides inside one: the
 * plan is what the reader is asked to review, so its group stays open. Pending
 * questions also stay visible until answered or denied.
 */
export function shouldFoldToolGroup(parts: readonly NativeMessagePart[]): boolean {
  const tools = toolCalls(parts);
  return (
    tools.length >= TOOL_GROUP_FOLD_MIN_CALLS &&
    !tools.some(
      (tool) =>
        !tool.toolDenied &&
        (isPlanTool(tool.toolName) ||
          (tool.toolState === "pending" &&
            (tool.toolName === "AskUserQuestion" ||
              parseQuestionToolArgs(tool.toolArgs) !== null))),
    )
  );
}
