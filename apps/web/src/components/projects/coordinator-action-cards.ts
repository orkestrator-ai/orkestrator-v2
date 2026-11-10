import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";

export interface CoordinatorActionCard {
  id: string;
  anchorId: string;
  index: number;
  kind: "topic" | "question" | "pr";
  title: string;
  state?: string;
  done: boolean;
  completeOnUser?: boolean;
  /** When the action was raised, where the transcript records it. */
  createdAt?: string | number;
}

/** Provider spellings of this server only; foreign MCP tools cannot create marks. */
export function coordinatorToolName(name?: string): string | undefined {
  if (!name) return undefined;
  for (const prefix of [
    "mcp__orkestrator__",
    "orkestrator/",
    "orkestrator_",
    "mcp__orkestrator.",
  ]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return /[/.]|__/.test(name) ? undefined : name;
}

function* flatParts(parts: readonly NativeMessagePart[]): Generator<NativeMessagePart> {
  for (const part of parts) {
    yield part;
    if (part.type === "tool-group") yield* flatParts(part.parts);
  }
}

/** Replay only structured notices and successful marks; never infer actions
 * from arbitrary assistant prose. Later PR notices revise the original card. */
export function coordinatorActionCards(
  messages: readonly NativeMessage[],
  answeredQuestionIds: ReadonlySet<string> = new Set(),
  interactions: readonly AgentInteractionRequest[] = [],
): CoordinatorActionCard[] {
  const cards: CoordinatorActionCard[] = [];
  const prs = new Map<string, CoordinatorActionCard>();
  let user: { id: string; index: number; createdAt?: string } | undefined;
  let topicMarked = false;
  for (const [index, message] of messages.entries()) {
    if (
      message.role === "user" &&
      !message.peerMail &&
      !message.goalTurn &&
      !message.promptPresentation
    ) {
      for (const card of cards) if (card.completeOnUser) card.done = true;
      user = { id: message.id, index, createdAt: message.createdAt };
      topicMarked = false;
    }
    const mail = message.peerMail;
    const notice = mail?.notice;
    if (
      notice &&
      (notice.resource.kind === "pull-request" ||
        notice.resource.kind === "watched-pull-request" ||
        notice.state.startsWith("pr-"))
    ) {
      // Structured status bodies carry the same PR URL across workflow handoffs.
      const url =
        notice.pullRequest?.url ??
        mail?.body.match(/(?:Pull request: |URL: )(https?:\/\/[^\s)]+)/)?.[1];
      const number =
        notice.pullRequest?.number ??
        url?.match(/\/pull\/(\d+)/)?.[1] ??
        notice.resource.id.match(/#(\d+)$/)?.[1];
      const prTitle = notice.pullRequest?.title;
      const title = prTitle
        ? `#${number} ${prTitle}`
        : number
          ? `#${number}`
          : (notice.resource.label ?? "Pull request");
      if (
        !url &&
        notice.resource.kind !== "pull-request" &&
        notice.resource.kind !== "watched-pull-request"
      )
        continue;
      const key = url
        ? `${notice.resource.nodeId ?? ""}:pr:${url}`
        : `${notice.resource.nodeId ?? ""}:pr:${notice.resource.environmentId ?? notice.resource.id}`;
      const state = notice.state.replace(/^pr-/, "");
      const done = /^(merged|closed|gone)$/.test(state);
      if (/^(started|failed)$/.test(state)) continue;
      const existing = prs.get(key);
      if (existing) {
        if (prTitle) existing.title = title;
        existing.state = state;
        existing.done = done;
      } else {
        const card: CoordinatorActionCard = {
          id: key,
          anchorId: message.id,
          index,
          kind: "pr",
          title,
          state,
          done,
          createdAt: message.createdAt,
        };
        cards.push(card);
        prs.set(key, card);
      }
    }
    for (const [ordinal, part] of Array.from(flatParts(message.parts)).entries()) {
      if (part.type === "async-question") {
        cards.push({
          id: part.asyncQuestion.itemId,
          anchorId: message.id,
          index,
          kind: "question",
          title: part.asyncQuestion.questions.map((q) => q.title).join(" · "),
          done: answeredQuestionIds.has(part.asyncQuestion.itemId),
          createdAt: message.createdAt,
        });
      }
      const tool = coordinatorToolName(part.toolName);
      if (tool && /^(AskUserQuestion|request_user_input|ask_question|question)$/.test(tool)) {
        const questions = part.toolArgs?.questions;
        const question = Array.isArray(questions) ? questions[0] : undefined;
        const title =
          question && typeof question === "object"
            ? (question.question ?? question.header ?? question.title)
            : part.toolTitle;
        cards.push({
          id: part.toolUseId ?? `${message.id}:question:${ordinal}`,
          anchorId: message.id,
          index,
          kind: "question",
          title: typeof title === "string" ? title : "Question for you",
          done: part.toolState === "success",
          createdAt: message.createdAt,
        });
      }

      if (
        (tool !== "mark_topic" && tool !== "mark_question") ||
        part.toolState !== "success" ||
        part.toolError
      )
        continue;
      const title = part.toolArgs?.title;
      if (typeof title !== "string" || !title.trim() || title.length > 120) continue;
      const kind = tool === "mark_topic" ? "topic" : "question";
      if (kind === "topic" && (!user || topicMarked)) continue;
      if (kind === "topic") topicMarked = true;
      cards.push({
        id: `${message.id}:${ordinal}`,
        kind,
        title,
        completeOnUser: kind === "question",
        anchorId: kind === "topic" ? user!.id : message.id,
        index: kind === "topic" ? user!.index : index,
        done: false,
        createdAt: kind === "topic" ? user!.createdAt : message.createdAt,
      });
    }
  }
  for (const interaction of interactions) {
    if (interaction.kind !== "question") continue;
    const existing = cards.find((card) => card.id === interaction.id);
    const done = !["pending", "answering"].includes(interaction.state);
    if (existing) {
      existing.done = done;
      continue;
    }
    const index = Math.max(
      0,
      messages.findLastIndex((message) => Date.parse(message.createdAt) <= interaction.createdAt),
    );
    const anchor = messages[index];
    if (!anchor) continue;
    cards.push({
      id: interaction.id,
      anchorId: anchor.id,
      index,
      kind: "question",
      title:
        interaction.presentation.questions.map((question) => question.prompt).join(" · ") ||
        interaction.presentation.title,
      done,
      createdAt: interaction.createdAt,
    });
  }
  return cards.sort((a, b) => a.index - b.index);
}

export function visibleCoordinatorCards(
  cards: readonly CoordinatorActionCard[],
  end: number,
): CoordinatorActionCard[] {
  return cards.filter((card) => card.index <= end).slice(-10);
}
