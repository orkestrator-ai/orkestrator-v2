/**
 * The palette's History provider: the conversation, terminal and view tabs
 * the shown machine has open, by environment, as stable destinations
 * (machine, project, environment, tab). Opening one goes through the same
 * worker-tab target a mail tile or attention line uses.
 *
 * It reads only what the pane layouts already hold (tab ids, types and their
 * chrome titles), never a transcript, prompt or file content, and it is
 * bounded: at most `scanLimit` tabs are looked at and `resultLimit`
 * returned, yielding to input between chunks. Searching message text across
 * past sessions is a separate provider (plan item 11) that can be added
 * behind the same interface.
 */
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
  tabs: readonly TabInfo[];
}

export interface HistoryResult {
  /** Unique in the palette, qualified by machine: `history:<machine>:<environment>:<tab>`. */
  rowId: string;
  title: string;
  kind: string;
  machine: PaletteMachine | null;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  tabId: string;
  score: number;
}

const TAB_KIND_LABELS: Readonly<Record<TabType, string>> = {
  plain: "Terminal",
  root: "Root terminal",
  claude: "Claude terminal",
  opencode: "OpenCode terminal",
  codex: "Codex terminal",
  cursor: "Cursor terminal",
  grok: "Grok terminal",
  pi: "Pi terminal",
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
  sources: () => readonly HistoryTabSource[];
  /** The machine the sources are on, read with them. */
  machine: () => PaletteMachine | null;
  scanLimit?: number;
  resultLimit?: number;
}): PaletteProvider<HistoryResult> {
  return {
    search: async (query, signal) => {
      const tokens = parseProjectSearchQuery(query);
      const owner = machine();
      const rows: HistoryResult[] = [];
      let scanned = 0;
      let truncated = false;
      outer: for (const source of sources()) {
        for (const tab of source.tabs) {
          // An embedded tab is shown inside its design canvas, not on its own.
          if (tab.embeddedIn) continue;
          if (scanned >= scanLimit) {
            truncated = true;
            break outer;
          }
          scanned += 1;
          if (scanned % HISTORY_CHUNK === 0) await yieldToInput(signal);
          const { title, kind } = paletteTabTitle(tab);
          const score = scoreHaystacks(
            [title, kind, source.environmentName, source.projectName],
            tokens,
          );
          if (score === null) continue;
          rows.push({
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
