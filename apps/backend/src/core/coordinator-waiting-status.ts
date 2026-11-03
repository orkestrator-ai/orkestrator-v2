/**
 * A delegated worker tab waiting on a person, as a coordinator status: what
 * it is blocked on (from its pending interactions), its last message, and
 * what the coordinator may do about it. Pure; `coordinator-status-wakes.ts`
 * decides when it is sent.
 */
import type { CoordinatorDelegation } from "@orkestrator/protocol/coordinator";
import type { CoordinatorStatus } from "./coordinator-status-wakes.js";

const MAX_DETAIL_CHARS = 400;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** One line, at most `limit` characters, never empty. */
export function boundedLine(value: string, limit = MAX_DETAIL_CHARS): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * The text of the newest assistant message in a projection page, or undefined.
 *
 * Reads the shared native message shape (`role`, `content`, text `parts`)
 * without trusting it, since it comes from a provider transcript.
 */
export function lastAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!record(message) || message.role !== "assistant") continue;
    const parts = Array.isArray(message.parts)
      ? message.parts
          .filter(
            (part) => record(part) && part.type === "text" && typeof part.content === "string",
          )
          .map((part) => (part as { content: string }).content)
      : [];
    const content = (parts.length > 0 ? parts.join("\n") : text(message.content)) ?? "";
    if (content.trim()) return boundedLine(content);
  }
  return undefined;
}

/** What a waiting worker is blocked on, read from its pending interactions. */
export type CoordinatorWaitingBlocker = "approval" | "question" | "approval-and-question";

const APPROVAL_INTERACTION_KINDS: ReadonlySet<string> = new Set([
  "plan-approval",
  "command-approval",
  "file-approval",
  "permission",
]);
const QUESTION_INTERACTION_KINDS: ReadonlySet<string> = new Set([
  "question",
  "mcp-form",
  "mcp-url",
  "elicitation",
  "terminal-selection",
]);

/**
 * Whether a worker's open interactions are approvals, questions or both.
 *
 * Only requests the turn is actually waiting on count: a non-blocking request
 * does not hold the session at `waiting`, so it cannot be why it is. Undefined
 * when nothing blocking is open (the activity state then says only "waiting").
 */
export function waitingBlocker(interactions: unknown): CoordinatorWaitingBlocker | undefined {
  if (!Array.isArray(interactions)) return undefined;
  let approval = false;
  let question = false;
  for (const interaction of interactions) {
    if (!record(interaction) || interaction.blocking === false) continue;
    if (interaction.state !== "pending" && interaction.state !== "answering") continue;
    if (typeof interaction.kind !== "string") continue;
    if (APPROVAL_INTERACTION_KINDS.has(interaction.kind)) approval = true;
    else if (QUESTION_INTERACTION_KINDS.has(interaction.kind)) question = true;
  }
  if (approval && question) return "approval-and-question";
  if (approval) return "approval";
  return question ? "question" : undefined;
}

/**
 * What the coordinator may do about a waiting question: propose an answer the
 * user confirms (`answer_worker_question`). It never answers on its own, and
 * approvals stay with the person in the worker's tab.
 */
const WAITING_RELAY_HINTS: Partial<Record<CoordinatorWaitingBlocker | "unknown", string>> = {
  question:
    "It may propose an answer with answer_worker_question (the interaction id is in get_tab_state's state.interactions); the user confirms, edits or declines it in Orkestrator, and only their approval answers the worker.",
  "approval-and-question":
    "Approvals stay with the person in the worker's tab. For the question it may propose an answer with answer_worker_question (the interaction id is in get_tab_state's state.interactions); only the user's approval in Orkestrator answers it.",
  unknown:
    "If get_tab_state shows a pending question, it may propose an answer with answer_worker_question, which the user confirms in Orkestrator before anything is sent; approvals stay in the worker's tab.",
};

const WAITING_HEADLINES: Record<CoordinatorWaitingBlocker | "unknown", string> = {
  approval: "is waiting for an approval",
  question: "is waiting for an answer to a question",
  "approval-and-question": "is waiting for an approval and an answer to a question",
  unknown: "is waiting for input or an approval",
};

/** A delegated tab that has been waiting long enough to tell its coordinator. */
export function waitingStatus(
  delegation: Pick<CoordinatorDelegation, "waiting">,
  environmentId: string,
  tabId: string,
  excerpt?: string,
  blocker?: CoordinatorWaitingBlocker,
): CoordinatorStatus | null {
  const since = delegation.waiting?.since;
  if (!since) return null;
  return {
    key: `waiting:${since}`,
    state: "waiting",
    tone: "attention",
    terminal: false,
    headline: WAITING_HEADLINES[blocker ?? "unknown"],
    details: [
      `Waiting since ${since}. A person has to answer it${blocker === "question" ? "" : " in the worker's tab"}; the coordinator cannot ${blocker === "approval-and-question" ? "approve or answer" : blocker === "question" ? "answer" : "approve"} on its behalf.`,
      ...(WAITING_RELAY_HINTS[blocker ?? "unknown"]
        ? [WAITING_RELAY_HINTS[blocker ?? "unknown"]!]
        : []),
      ...(excerpt ? [`Last message: ${boundedLine(excerpt)}`] : []),
    ],
    tools: [
      `get_tab_state { "environmentId": "${environmentId}", "tabId": "${tabId}" }`,
      `get_tab_transcript { "environmentId": "${environmentId}", "tabId": "${tabId}" }`,
    ],
    mode: "settled",
  };
}
