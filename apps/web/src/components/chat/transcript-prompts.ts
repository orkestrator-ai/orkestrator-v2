import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  GOAL_TURN_MESSAGE_PREFIX,
  PEER_MAIL_MESSAGE_PREFIX,
} from "@/lib/chat/client-only-messages";
import { userPromptDisplayText } from "@/lib/chat/user-prompt-display";
import { markdownToAgentSearchText } from "./native-message-search";

/** What a preview parses of a long message, and how much of that it can show. */
const PREVIEW_SOURCE_CHARACTERS = 2_000;
const PREVIEW_TEXT_CHARACTERS = 300;

/** One prompt the user sent, as the navigator lists it. */
export interface TranscriptPrompt {
  id: string;
  /** Markdown flattened to one line, bounded. */
  text: string;
  /** What `text` was derived from; an unchanged source keeps its derived text. */
  source: string;
}

/**
 * Whether this row is something the user typed. Agent mail and goal-loop turns
 * also carry the user role, but neither is the user's words.
 */
function isUserPrompt(message: NativeMessage): boolean {
  return (
    message.role === "user" &&
    !message.id.startsWith(PEER_MAIL_MESSAGE_PREFIX) &&
    !message.id.startsWith(GOAL_TURN_MESSAGE_PREFIX)
  );
}

function firstTextOf(message: NativeMessage): string {
  for (const part of message.parts) {
    if (part.type === "text" && part.content.trim()) return part.content;
  }
  return message.content;
}

function previewText(markdown: string): string {
  return markdownToAgentSearchText(markdown.slice(0, PREVIEW_SOURCE_CHARACTERS))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_TEXT_CHARACTERS);
}

function promptText(message: NativeMessage, source: string): string {
  const text = previewText(userPromptDisplayText(source, message.promptPresentation));
  if (text) return text;
  // An attachment-only prompt has no words of its own.
  const attachment = message.parts.find((part) => part.type === "file" || part.type === "image");
  return attachment?.content || "Attachment";
}

/**
 * The transcript's prompts in order. Runs for every transcript update while an
 * agent streams, so a prompt whose source is unchanged keeps its parsed text,
 * and `previous` itself is returned when nothing changed.
 */
export function collectTranscriptPrompts(
  messages: readonly NativeMessage[],
  previous: readonly TranscriptPrompt[],
): readonly TranscriptPrompt[] {
  const known = new Map(previous.map((prompt) => [prompt.id, prompt]));
  const prompts: TranscriptPrompt[] = [];
  let changed = false;
  for (const message of messages) {
    if (!isUserPrompt(message)) continue;
    const source = firstTextOf(message);
    const existing = known.get(message.id);
    const prompt =
      existing?.source === source
        ? existing
        : { id: message.id, text: promptText(message, source), source };
    if (previous[prompts.length] !== prompt) changed = true;
    prompts.push(prompt);
  }
  return changed || prompts.length !== previous.length ? prompts : previous;
}

/** The start of the agent's answer to one prompt, if it has written any yet. */
export function replyPreviewFor(messages: readonly NativeMessage[], promptId: string): string {
  const start = messages.findIndex((message) => message.id === promptId);
  if (start < 0) return "";
  for (const message of messages.slice(start + 1)) {
    if (isUserPrompt(message)) return "";
    if (message.role !== "assistant") continue;
    const text = previewText(firstTextOf(message));
    if (text) return text;
  }
  return "";
}

/**
 * How strongly a line stands out, from 1 under the pointer down to 0 a few
 * lines away: the rail swells around the pointer rather than at one line.
 */
export function promptLineEmphasis(distance: number): number {
  return [1, 0.55, 0.25][distance] ?? 0;
}
