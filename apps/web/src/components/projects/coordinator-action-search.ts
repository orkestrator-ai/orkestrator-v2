import { Check, GitPullRequest, MessageCircle, Tag, type LucideIcon } from "lucide-react";
import type { CoordinatorActionCard } from "./coordinator-action-cards";

/** The icon a card and its search result show: a tick once done, else its kind. */
export function coordinatorActionIcon(card: CoordinatorActionCard): LucideIcon {
  if (card.done) return Check;
  if (card.kind === "topic") return Tag;
  if (card.kind === "pr") return GitPullRequest;
  return MessageCircle;
}

/** The status line under a card's title. */
export function coordinatorActionStatus(card: CoordinatorActionCard): string {
  if (card.done) return card.markedDone ? "Marked done" : "Done";
  return card.state ?? (card.kind === "topic" ? "Topic" : "Awaiting answer");
}

const KIND_TERMS: Record<CoordinatorActionCard["kind"], string> = {
  topic: "topic",
  question: "question",
  pr: "pr pull request",
};

/** The kind's display name in the search palette. */
export const COORDINATOR_ACTION_KIND_LABELS: Record<CoordinatorActionCard["kind"], string> = {
  topic: "Topic",
  question: "Question",
  pr: "Pull request",
};

/** Where a term may start in an action's text: its start or after a non-word character. */
function startsAWord(text: string, term: string): boolean {
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]!)) return true;
  }
  return false;
}

/**
 * Every action matching `query`, newest first. Each whitespace-separated
 * term must start a word, case-insensitively, of the title, the kind or the
 * state, so "pr merged" narrows to merged pull requests (and "pr" does not
 * match "improve"). An empty query lists all.
 */
export function searchCoordinatorActions(
  cards: readonly CoordinatorActionCard[],
  query: string,
): CoordinatorActionCard[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const newestFirst = cards
    .map((card, position) => ({ card, position }))
    .sort((a, b) => b.card.index - a.card.index || b.position - a.position)
    .map(({ card }) => card);
  if (terms.length === 0) return newestFirst;
  return newestFirst.filter((card) => {
    const text = [
      card.title,
      KIND_TERMS[card.kind],
      coordinatorActionStatus(card),
      card.state ?? "",
      card.done ? "done" : "open",
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => startsAWord(text, term));
  });
}
