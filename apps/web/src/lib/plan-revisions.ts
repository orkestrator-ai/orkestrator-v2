import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import {
  extractPlanMarkdown,
  firstMarkdownHeading,
  getPlanToolLabel,
  isPlanTool,
} from "./plan-tool";

/**
 * Where a plan card stands among the plans of one conversation.
 *
 * - `current`: the newest plan the agent finished writing.
 * - `superseded`: an earlier finished plan a newer one replaced.
 * - `drafting`: a plan still being written. Until it finishes, the previous
 *   finished plan stays current, because the draft may still fail.
 * - `failed`: a plan call that failed. It replaces nothing.
 *
 * None of these says the provider approved or authorised anything; they only
 * order what the agent wrote. Approval stays the provider's own business.
 */
export type PlanRevisionState = "current" | "superseded" | "drafting" | "failed";

export interface PlanRevision {
  key: string;
  messageId: string;
  state: PlanRevisionState;
  /** Display title, the same one the card shows. */
  title?: string;
  /**
   * 1-based position among the finished plans, or undefined when it is not
   * known: a failed or drafting plan, or a transcript whose earlier history is
   * not loaded (numbering would shift once it is).
   */
  revision?: number;
}

export interface PlanRevisionIndex {
  byKey: ReadonlyMap<string, PlanRevision>;
  /** Key of the current plan, when the loaded transcript has one. */
  currentKey?: string;
  /** Number of finished plans, when the whole conversation is loaded. */
  total?: number;
}

/**
 * The identity a plan card and the index agree on. A provider call id is
 * stable across streaming and reloads; a part without one falls back to its
 * display row, which holds at most one plan in practice.
 */
export function planCardKey(toolUseId: string | undefined, messageId: string | undefined): string {
  if (toolUseId) return `tool:${toolUseId}`;
  return `message:${messageId ?? ""}`;
}

/** The title a plan card shows: the tool's own title, else the plan's first heading. */
export function planDisplayTitle(
  toolName: string | undefined,
  toolTitle: string | undefined,
  plan: string,
): string | undefined {
  const label = getPlanToolLabel(toolName, toolTitle);
  if (label !== "Plan") return label;
  return firstMarkdownHeading(plan);
}

type PlanPart = Extract<NativeMessagePart, { type: "tool-invocation" }>;

/**
 * The agent's own plans in a message, in order. Plans a sub-agent or a task
 * wrote are not the session's plan, so only top-level parts and tool groups
 * (which merely bundle the agent's own calls) count.
 */
function sessionPlanParts(parts: readonly NativeMessagePart[], into: PlanPart[]): void {
  for (const part of parts) {
    if (part.type === "tool-invocation") {
      if (!part.toolDenied && isPlanTool(part.toolName)) into.push(part);
    } else if (part.type === "tool-group") {
      sessionPlanParts(part.parts, into);
    }
  }
}

export function buildPlanRevisionIndex(
  messages: readonly NativeMessage[],
  options: { historyComplete: boolean },
): PlanRevisionIndex {
  const entries: Array<{ key: string; messageId: string; part: PlanPart }> = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const parts: PlanPart[] = [];
    sessionPlanParts(message.parts, parts);
    for (const part of parts) {
      entries.push({ key: planCardKey(part.toolUseId, message.id), messageId: message.id, part });
    }
  }

  const byKey = new Map<string, PlanRevision>();
  let finished = 0;
  let currentKey: string | undefined;
  for (const { key, messageId, part } of entries) {
    const title = planDisplayTitle(
      part.toolName,
      part.toolTitle,
      extractPlanMarkdown(part.toolArgs, part.toolOutput),
    );
    if (part.toolState === "failure") {
      byKey.set(key, { key, messageId, state: "failed", title });
      continue;
    }
    if (part.toolState === "pending") {
      byKey.set(key, { key, messageId, state: "drafting", title });
      continue;
    }
    finished += 1;
    if (currentKey !== undefined) {
      const previous = byKey.get(currentKey);
      if (previous) byKey.set(currentKey, { ...previous, state: "superseded" });
    }
    currentKey = key;
    byKey.set(key, {
      key,
      messageId,
      state: "current",
      title,
      ...(options.historyComplete ? { revision: finished } : {}),
    });
  }

  return {
    byKey,
    ...(currentKey !== undefined ? { currentKey } : {}),
    ...(options.historyComplete && finished > 0 ? { total: finished } : {}),
  };
}

/**
 * The prompt that asks the agent to implement one specific plan. It names the
 * plan the user acted on, so the transcript records which one was meant.
 */
export function implementPlanPrompt(title: string | undefined): string {
  const named = title?.trim().replace(/\s+/g, " ").slice(0, 200);
  return named
    ? `The plan "${named}" is approved. Exit plan mode and implement it.`
    : "The latest plan you proposed is approved. Exit plan mode and implement it.";
}
