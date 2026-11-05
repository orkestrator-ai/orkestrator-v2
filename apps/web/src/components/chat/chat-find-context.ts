import { createContext } from "react";
import type { SearchRoot } from "@/lib/chat/rich-markdown/search-segments";
import { rootAt } from "@/lib/chat/rich-markdown/search-segments";
import type { AgentChatFindMatch } from "./AgentChatFind";

/** Temporarily reveal clipped content in the row selected by transcript find. */
export const ChatFindActiveContext = createContext(false);

/**
 * What an open Find bar asks of the static documents in its transcript: the
 * query, and which document holds the active match at which occurrence. Null
 * outside an open search. It reaches a card here and the card's own frame from
 * there; nothing else reads it, and it is never stored or logged.
 */
export interface StaticDocumentFind {
  query: string;
  activePublicationId: string | null;
  activeOccurrence: number | null;
}

export const StaticDocumentFindContext = createContext<StaticDocumentFind | null>(null);

/**
 * The publication whose body holds `current` and the match's occurrence within
 * that body, counted by the same matches Find counts. Null for a match anywhere
 * else in the row.
 */
export function activeDocumentOccurrence(
  roots: readonly SearchRoot[] | undefined,
  matches: readonly AgentChatFindMatch[],
  current: AgentChatFindMatch,
): { publicationId: string; occurrence: number } | null {
  const root = rootAt(roots, current.characterIndex);
  if (!root?.publicationId) return null;
  let occurrence = 0;
  for (const match of matches) {
    if (
      match.itemIndex === current.itemIndex &&
      match.characterIndex >= root.start &&
      match.characterIndex < current.characterIndex
    )
      occurrence += 1;
  }
  return { publicationId: root.publicationId, occurrence };
}

/** Bubbles from a static document's iframe when its match has a new position. */
export const STATIC_FIND_MATCH_EVENT = "orkestrator:static-find-match";

const FRAME_WITH_MATCH = "iframe[data-find-match-top]";

/** Where a frame says its active match is, in its own viewport. Numbers only. */
export function recordStaticFindMatch(
  iframe: HTMLIFrameElement,
  match: { top: number; height: number } | null,
): void {
  if (!match || match.height === 0) {
    delete iframe.dataset.findMatchTop;
    delete iframe.dataset.findMatchHeight;
    return;
  }
  iframe.dataset.findMatchTop = String(match.top);
  iframe.dataset.findMatchHeight = String(match.height);
  iframe.dispatchEvent(new CustomEvent(STATIC_FIND_MATCH_EVENT, { bubbles: true }));
}

/**
 * The on-screen box of the match inside the document beside `mirror`, when its
 * frame has reported one. Without one (a deferred card, a chart's labels), the
 * caller scrolls to the card, as it always has.
 */
export function staticDocumentMatchRect(mirror: Element): DOMRect | null {
  const body = mirror.closest("[data-artifact-search-body]")?.parentElement;
  const iframe = body?.querySelector<HTMLIFrameElement>(FRAME_WITH_MATCH);
  if (!iframe) return null;
  const frame = iframe.getBoundingClientRect();
  const top = Number(iframe.dataset.findMatchTop);
  const height = Number(iframe.dataset.findMatchHeight);
  // Host rectangles include ancestor CSS zoom; frame reports use its own CSS pixels.
  const scale = iframe.offsetHeight > 0 ? frame.height / iframe.offsetHeight : 1;
  return new DOMRect(
    frame.left,
    frame.top + (iframe.clientTop + top) * scale,
    frame.width,
    height * scale,
  );
}
