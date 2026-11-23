/**
 * The palette's History provider: the conversation, terminal and view tabs
 * the shown machine has open, by environment, as stable destinations
 * (machine, project, environment, tab). Opening one goes through the same
 * worker-tab target a mail tile or attention line uses.
 *
 * It reads only what the pane layouts already hold (tab ids, types and their
 * chrome titles), never a transcript, prompt or file content, and it is
 * bounded: at most `scanLimit` tabs are looked at and `resultLimit`
 * returned, yielding to input between chunks.
 *
 * Two more History sources answer through the same provider interface, each
 * with its own status: messages already loaded in open agent tabs
 * (`history-messages.ts`) and the frozen environment's past conversations
 * (`history-sessions.ts`).
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { TabType } from "@/contexts/TerminalContext";
import type { TabInfo } from "@/types/paneLayout";
import { parseProjectSearchQuery, scoreHaystacks } from "@/lib/project-search";
import type { PaletteMachine } from "./model";
import { yieldToInput, type PaletteProvider } from "./providers";

export const HISTORY_SCAN_LIMIT = 400;
export const HISTORY_RESULT_LIMIT = 20;
const HISTORY_CHUNK = 100;

/** One environment's open tabs, with the names the rows show. */
export interface HistoryTabSource {
  environmentId: string;
  environmentName: string;
  projectId: string;
  projectName: string;
  tabs: Iterable<TabInfo>;
}

interface HistoryResultBase {
  /** Unique in the palette and qualified by machine (`history:<machine>:…`). */
  rowId: string;
  title: string;
  kind: string;
  machine: PaletteMachine | null;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  score: number;
}

/** An open tab. */
export interface TabHistoryResult extends HistoryResultBase {
  source: "tab";
  tabId: string;
}

/** One message already loaded in an open agent tab; opening it scrolls there. */
export interface MessageHistoryResult extends HistoryResultBase {
  source: "message";
  tabId: string;
  messageId: string;
  /**
   * A short excerpt around the match, shown in the row only. Never logged,
   * stored or put in the command registry.
   */
  snippet: string;
}

/** A conversation the environment's agent can resume; opening it resumes it in a new tab. */
export interface SessionHistoryResult extends HistoryResultBase {
  source: "session";
  platform: AgentPlatform;
  /** The provider's resumable session id, as the resume picker lists it. */
  sessionId: string;
  activityAt: string | null;
}

export type HistoryResult = TabHistoryResult | MessageHistoryResult | SessionHistoryResult;
export type HistorySource = HistoryResult["source"];

const TAB_KIND_LABELS: Readonly<Record<TabType, string>> = {
  plain: "Terminal",
  root: "Root terminal",
  claude: "Claude terminal",
  opencode: "OpenCode terminal",
  codex: "Codex terminal",
  cursor: "Cursor terminal",
  grok: "Grok terminal",
  pi: "Pi terminal",
  // Never a terminal: an Antigravity tab is always native.
  antigravity: "Antigravity",
  "agent-native": "Agent",
  "auto-pipeline": "Auto-pipeline",
  browser: "Browser",
  "design-canvas": "Design",
  "graph-designer": "Graph designer",
  "graph-run": "Graph run",
  file: "File",
  "claude-tmux": "Claude",
  "claude-build": "Build",
  "key-information": "Key information",
  "multi-review": "Multi Review",
  "pull-request": "Pull request",
};

/** A tab's title from its chrome fields only; its type when it has none. */
export function paletteTabTitle(tab: TabInfo): { title: string; kind: string } {
  const kind = TAB_KIND_LABELS[tab.type] ?? "Tab";
  if (tab.type === "pull-request" && tab.pullRequestData) {
    const { ref, title } = tab.pullRequestData;
    return { title: title ? `#${ref.number} ${title}` : `${ref.repo} #${ref.number}`, kind };
  }
  if (tab.type === "file" && tab.fileData) {
    const parts = tab.fileData.filePath.split("/").filter(Boolean);
    return { title: parts.at(-1) ?? tab.fileData.filePath, kind };
  }
  const title = tab.displayTitle?.trim();
  return { title: title || kind, kind };
}

export function historyRowId(
  machine: PaletteMachine | null,
  environmentId: string,
  tabId: string,
): string {
  return `history:${machine?.connectionId ?? "this"}:${environmentId}:${tabId}`;
}

/**
 * Searches the tabs `sources()` lists when asked (read at search time, so a
 * tab opened since the palette opened is found). The first source is the
 * palette's own environment, so an empty query lists its tabs first.
 */
export function createTabHistoryProvider({
  sources,
  machine,
  scanLimit = HISTORY_SCAN_LIMIT,
  resultLimit = HISTORY_RESULT_LIMIT,
}: {
  sources: () => Iterable<HistoryTabSource | null>;
  /** The machine the sources are on, read with them. */
  machine: () => PaletteMachine | null;
  scanLimit?: number;
  resultLimit?: number;
}): PaletteProvider<TabHistoryResult> {
  return {
    search: async (query, signal) => {
      const tokens = parseProjectSearchQuery(query);
      const owner = machine();
      const rows: TabHistoryResult[] = [];
      let scanned = 0;
      let layouts = 0;
      let truncated = false;
      signal.throwIfAborted();
      outer: for (const source of sources()) {
        if (++layouts > scanLimit) {
          truncated = true;
          break;
        }
        if (layouts % HISTORY_CHUNK === 0) await yieldToInput(signal);
        if (!source) continue;
        for (const tab of source.tabs) {
          if (++scanned > scanLimit) {
            truncated = true;
            break outer;
          }
          if (scanned % HISTORY_CHUNK === 0) await yieldToInput(signal);
          // Embedded tabs only open inside their design canvas.
          if (tab.embeddedIn) continue;
          const { title, kind } = paletteTabTitle(tab);
          const score = scoreHaystacks(
            [title, kind, source.environmentName, source.projectName],
            tokens,
          );
          if (score === null) continue;
          rows.push({
            source: "tab",
            rowId: historyRowId(owner, source.environmentId, tab.id),
            title,
            kind,
            machine: owner,
            projectId: source.projectId,
            projectName: source.projectName,
            environmentId: source.environmentId,
            environmentName: source.environmentName,
            tabId: tab.id,
            score,
          });
        }
      }
      // Stable: equal scores keep the sources' order (this environment first).
      const ranked = rows
        .map((row, index) => ({ row, index }))
        .sort((left, right) => right.row.score - left.row.score || left.index - right.index)
        .map(({ row }) => row);
      return {
        rows: ranked.slice(0, resultLimit),
        partial: truncated || ranked.length > resultLimit,
      };
    },
  };
}
