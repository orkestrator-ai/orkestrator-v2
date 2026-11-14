/**
 * Reading the source environment's agent tabs for the debug button
 * (`create_debug_build`).
 *
 * The tabs come from the environment's persisted pane layout, the same place
 * the public CLI resolves sessions from; the tab in front is the active tab of
 * the layout's active pane. Each tab's transcript is read through the public
 * CLI's `session.transcript` reader, page by page from the newest, so the
 * debug ticket sees exactly what `orkestrator session transcript` would: text
 * bounded per message and tool calls by name and status only, never their
 * inputs or outputs.
 *
 * The read is an explicit content access made once, when the user submits the
 * debug dialog. It is bounded by pages and by characters, and a tab whose
 * transcript cannot be read is reported as such rather than failing the
 * request.
 */
import type { DebugTranscriptMessage } from "@orkestrator/protocol/debug-build";
import {
  encodePublicSessionId,
  type PublicTranscriptPage,
} from "@orkestrator/protocol/public-api-resources";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import {
  nativeTabsOfLayout,
  sessionTranscript,
  type PublicActionContext,
} from "../public-api/index.js";
import type { StorageService } from "../storage.js";

/** Pages read per tab at most (100 messages each). */
export const DEBUG_TRANSCRIPT_MAX_PAGES = 50;

export interface DebugSourceTab {
  tabId: string;
  agent: string;
  title: string | null;
  front: boolean;
}

export type DebugTabTranscript =
  | { status: "read"; messages: DebugTranscriptMessage[]; complete: boolean }
  | { status: "empty" }
  | { status: "unavailable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The active tab of the layout's active pane, when it can be found. */
export function frontTabId(layout: unknown): string | null {
  if (!isRecord(layout) || typeof layout.activePaneId !== "string") return null;
  const activePaneId = layout.activePaneId;
  let found: string | null = null;
  const visit = (node: unknown, depth: number): void => {
    if (found !== null || !isRecord(node) || depth > 64) return;
    if (node.kind === "leaf") {
      if (node.id === activePaneId && typeof node.activeTabId === "string") {
        found = node.activeTabId;
      }
      return;
    }
    if (node.kind === "split" && Array.isArray(node.children)) {
      for (const child of node.children) visit(child, depth + 1);
    }
  };
  visit(layout.root, 0);
  return found;
}

/**
 * The environment's native agent tabs, the one in front first (or, when the
 * front tab is not an agent tab, in layout order).
 */
export async function debugSourceTabs(
  storage: Pick<StorageService, "getPaneLayout">,
  environmentId: string,
): Promise<DebugSourceTab[]> {
  const layout = await storage.getPaneLayout(environmentId);
  const front = frontTabId(layout);
  const tabs = nativeTabsOfLayout(layout).map((tab) => ({
    tabId: tab.tabId,
    agent: tab.agent,
    title: tab.title,
    front: tab.tabId === front,
  }));
  return [...tabs.filter((tab) => tab.front), ...tabs.filter((tab) => !tab.front)];
}

/**
 * One tab's transcript, oldest first, reading older pages until the start of
 * the conversation, {@link DEBUG_TRANSCRIPT_MAX_PAGES}, or `stopAfterChars`
 * characters of message text, whichever comes first.
 */
export async function readDebugTabTranscript(
  context: Pick<PublicActionContext, "command" | "invoke">,
  environmentId: string,
  tabId: string,
  stopAfterChars: number,
): Promise<DebugTabTranscript> {
  let sessionId: string;
  try {
    sessionId = encodePublicSessionId(environmentId, tabId);
  } catch {
    return { status: "unavailable" };
  }
  const messages: DebugTranscriptMessage[] = [];
  let chars = 0;
  let before: string | undefined;
  const seen = new Set<string>();
  try {
    for (let page = 0; page < DEBUG_TRANSCRIPT_MAX_PAGES; page++) {
      const input = sessionTranscript.parse({
        sessionId,
        limit: PUBLIC_API_LIMITS.transcriptMaxMessages,
        ...(before ? { before } : {}),
      });
      const { result } = await sessionTranscript.run(input, context as PublicActionContext);
      const read = result as PublicTranscriptPage;
      if (!Array.isArray(read.messages)) return { status: "unavailable" };
      if (page === 0 && read.freshness === "empty" && read.messages.length === 0) {
        return { status: "empty" };
      }
      messages.unshift(...read.messages);
      for (const message of read.messages) chars += message.text.length;
      if (!read.olderCursor) {
        return { status: "read", messages, complete: read.complete === true };
      }
      if (chars >= stopAfterChars || seen.has(read.olderCursor)) break;
      seen.add(read.olderCursor);
      before = read.olderCursor;
    }
  } catch {
    // Whatever was read before the failure is still evidence; nothing at all is not.
    if (messages.length === 0) return { status: "unavailable" };
  }
  return { status: "read", messages, complete: false };
}
