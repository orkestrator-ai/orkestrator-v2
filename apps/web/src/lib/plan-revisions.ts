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
  partId?: string;
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
  keyByPart: WeakMap<PlanPart, string>;
  /** The last plan attempt since the latest user message. */
  reviewKey?: string;
  /** Key of the current plan, when the loaded transcript has one. */
  currentKey?: string;
  /** Number of finished plans, when the whole conversation is loaded. */
  total?: number;
}

/** Use source identity when available and a display-row path for legacy parts. */
function planCardKey(part: PlanPart, messageId: string, path: readonly number[]): string {
  if (part.toolUseId) return `tool:${part.toolUseId}`;
  if (part.sourcePartId) {
    return `source:${JSON.stringify([part.sourceMessageId ?? messageId, part.sourcePartId])}`;
  }
  return `part:${JSON.stringify([messageId, path])}`;
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
function sessionPlanParts(
  parts: readonly NativeMessagePart[],
  visit: (part: PlanPart, path: number[]) => void,
  parent: number[] = [],
): void {
  for (const [index, part] of parts.entries()) {
    if (part.type === "tool-invocation" && !part.toolDenied && isPlanTool(part.toolName)) {
      visit(part, [...parent, index]);
    } else if (part.type === "tool-group") {
      sessionPlanParts(part.parts, visit, [...parent, index]);
    }
  }
}

export function buildPlanRevisionIndex(
  messages: readonly NativeMessage[],
  options: { historyComplete: boolean },
): PlanRevisionIndex {
  const entries: Array<{ key: string; messageId: string; part: PlanPart }> = [];
  const keyByPart = new WeakMap<PlanPart, string>();
  let reviewKey: string | undefined;
  for (const message of messages) {
    if (message.role === "user") reviewKey = undefined;
    if (message.role !== "assistant") continue;
    sessionPlanParts(message.parts, (part, path) => {
      const key = planCardKey(part, message.id, path);
      keyByPart.set(part, key);
      entries.push({ key, messageId: message.id, part });
      reviewKey = key;
    });
  }

  const byKey = new Map<string, PlanRevision>();
  let finished = 0;
  let currentKey: string | undefined;
  for (const { key, messageId, part } of entries) {
    const identity = { key, messageId, partId: part.toolUseId ?? part.sourcePartId };
    const title = planDisplayTitle(
      part.toolName,
      part.toolTitle,
      extractPlanMarkdown(part.toolArgs, part.toolOutput),
    );
    if (part.toolState === "failure") {
      byKey.set(key, { ...identity, state: "failed", title });
      continue;
    }
    if (part.toolState === "pending") {
      byKey.set(key, { ...identity, state: "drafting", title });
      continue;
    }
    finished += 1;
    if (currentKey !== undefined) {
      const previous = byKey.get(currentKey);
      if (previous) byKey.set(currentKey, { ...previous, state: "superseded" });
    }
    currentKey = key;
    byKey.set(key, {
      ...identity,
      state: "current",
      title,
      ...(options.historyComplete ? { revision: finished } : {}),
    });
  }

  return {
    byKey,
    keyByPart,
    reviewKey,
    ...(currentKey !== undefined ? { currentKey } : {}),
    ...(options.historyComplete && finished > 0 ? { total: finished } : {}),
  };
}

/** Send the exact reviewed body. Cursor does not resolve renderer revision keys. */
export function implementPlanPrompt(revision: PlanRevision, markdown: string): string {
  const target =
    revision.revision === undefined ? "this plan" : `plan revision ${revision.revision}`;
  return `Exit plan mode and implement ${target} (reference ${JSON.stringify(revision.key)}). Use the reviewed Markdown between the markers.\n\n<<< BEGIN PLAN >>>\n${markdown}\n<<< END PLAN >>>`;
}
