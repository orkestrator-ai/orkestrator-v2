/**
 * The palette's message History source: the messages already loaded in the
 * shown machine's open agent tabs, matched by their text. Opening a result
 * opens its tab and scrolls to the message through the same
 * `conversationScrollTargetStore` request "Open full conversation" uses.
 *
 * It reads only what this window already holds (each tab's projection in
 * the node scope's `nativeAgentProjectionStore`): it never fetches a
 * transcript, so a conversation's earlier pages, or a tab that has not
 * loaded, are not searched. It is bounded in tabs, messages and characters
 * per message, yields to input between chunks and returns a short excerpt
 * for display only. Neither the query nor the excerpt is logged or stored.
 */
import { parseProjectSearchQuery } from "@/lib/project-search";
import type { MessageHistoryResult } from "./history";
import type { PaletteMachine } from "./model";
import { yieldToInput, type PaletteProvider } from "./providers";

/** At most this many messages are read per search, across every tab. */
export const MESSAGE_SCAN_LIMIT = 2_000;
/** Only this much of a message's text is searched. */
export const MESSAGE_TEXT_LIMIT = 8_000;
export const MESSAGE_RESULT_LIMIT = 12;
/** One conversation cannot fill the group. */
export const MESSAGE_RESULTS_PER_TAB = 3;
/** Characters of context kept either side of the match in an excerpt. */
const SNIPPET_RADIUS = 48;
const MESSAGE_CHUNK = 200;

/** One open agent tab and the messages its projection holds now. */
export interface MessageHistorySource {
  environmentId: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  tabId: string;
  tabTitle: string;
  /** Read at search time; null when the tab has loaded nothing. */
  messages: () => readonly unknown[] | null | undefined;
}

interface SearchableMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/** A transcript row's own text, or null for anything that is not a user or agent message. */
function searchableMessage(value: unknown): SearchableMessage | null {
  if (!value || typeof value !== "object") return null;
  const { id, role, content } = value as { id?: unknown; role?: unknown; content?: unknown };
  if (typeof id !== "string" || !id || typeof content !== "string" || !content) return null;
  if (role !== "user" && role !== "assistant") return null;
  // Synthesised rows (errors, notices) are not the conversation.
  if (id.startsWith("system-") || id.startsWith("error-")) return null;
  return { id, role, content };
}

/** A one-line excerpt around the first token, with ellipses where it was cut. */
export function messageSnippet(content: string, token: string): string {
  const text = content.slice(0, MESSAGE_TEXT_LIMIT);
  const at = Math.max(0, text.toLowerCase().indexOf(token));
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + token.length + SNIPPET_RADIUS);
  const excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < content.length ? "…" : ""}`;
}

export function messageHistoryRowId(
  machine: PaletteMachine | null,
  environmentId: string,
  tabId: string,
  messageId: string,
): string {
  return `history-message:${machine?.connectionId ?? "this"}:${environmentId}:${tabId}:${messageId}`;
}

/**
 * Searches the loaded messages of the tabs `sources()` lists, newest first in
 * each tab. Every token must appear in the message. An empty query matches
 * nothing: message text is only searched for words the user typed.
 */
export function createMessageHistoryProvider({
  sources,
  machine,
  scanLimit = MESSAGE_SCAN_LIMIT,
  resultLimit = MESSAGE_RESULT_LIMIT,
}: {
  sources: () => Iterable<MessageHistorySource>;
  machine: () => PaletteMachine | null;
  scanLimit?: number;
  resultLimit?: number;
}): PaletteProvider<MessageHistoryResult> {
  return {
    search: async (query, signal) => {
      const tokens = parseProjectSearchQuery(query);
      signal.throwIfAborted();
      if (tokens.length === 0) return { rows: [], partial: false };
      const owner = machine();
      const rows: MessageHistoryResult[] = [];
      let scanned = 0;
      let truncated = false;
      outer: for (const source of sources()) {
        const messages = source.messages();
        if (!messages || messages.length === 0) continue;
        let inTab = 0;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (++scanned > scanLimit) {
            truncated = true;
            break outer;
          }
          if (scanned % MESSAGE_CHUNK === 0) await yieldToInput(signal);
          const message = searchableMessage(messages[index]);
          if (!message) continue;
          const haystack = message.content.slice(0, MESSAGE_TEXT_LIMIT).toLowerCase();
          if (!tokens.every((token) => haystack.includes(token))) continue;
          if (inTab >= MESSAGE_RESULTS_PER_TAB || rows.length >= resultLimit) {
            truncated = true;
            if (rows.length >= resultLimit) break outer;
            break;
          }
          inTab += 1;
          rows.push({
            source: "message",
            rowId: messageHistoryRowId(owner, source.environmentId, source.tabId, message.id),
            title: source.tabTitle,
            kind: message.role === "user" ? "Your message" : "Agent reply",
            machine: owner,
            projectId: source.projectId,
            projectName: source.projectName,
            environmentId: source.environmentId,
            environmentName: source.environmentName,
            tabId: source.tabId,
            messageId: message.id,
            snippet: messageSnippet(message.content, tokens[0]!),
            score: 0,
          });
        }
      }
      return { rows, partial: truncated };
    },
  };
}
