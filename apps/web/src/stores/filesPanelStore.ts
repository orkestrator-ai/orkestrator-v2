import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { GitFileChange, FileNode, FileSubtree } from "@/lib/backend";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import type { CreateFileTabOptions } from "@/contexts/TerminalContext";
import {
  gitHubPullRequestKey,
  isGitHubPullRequestRef,
  type GitHubPullRequestRef,
  type GitHubPullRequestState,
  type GitHubPullRequestViewTab,
} from "@orkestrator/protocol/github-pull-requests";

/** `pull-request:<key>` selects one open pull request tab (see `gitHubPullRequestKey`). */
export type FilesPanelTab = "changes" | "all-files" | "pull-requests" | `pull-request:${string}`;

/** The two tabs that read the target's files; pull request tabs read GitHub. */
export function isFilesPanelFileTab(tab: FilesPanelTab): tab is "changes" | "all-files" {
  return tab === "changes" || tab === "all-files";
}

export function pullRequestFilesPanelTab(ref: GitHubPullRequestRef): FilesPanelTab {
  return `pull-request:${gitHubPullRequestKey(ref)}`;
}

/** A pull request opened as a closable tab in the panel. */
export interface FilesPanelPullRequestTab {
  key: string;
  ref: GitHubPullRequestRef;
  /** View to show; bumping `openRequest` re-applies it to a mounted view. */
  view: GitHubPullRequestViewTab;
  openRequest: number;
  title?: string;
  state?: GitHubPullRequestState;
  isDraft?: boolean;
}

/**
 * Pull request tabs are kept per panel target (an environment, or a project
 * root), so switching environments shows that environment's own tabs.
 */
export const MAX_PULL_REQUEST_TABS_PER_TARGET = 8;
const MAX_PULL_REQUEST_TAB_TARGETS = 50;
/** Showing a pull request widens a narrower panel to this. */
export const PULL_REQUEST_PANEL_MIN_WIDTH_PX = 480;
export const PULL_REQUEST_PANEL_WIDTH_PX = 560;

/**
 * A file the user opened from a view that has no editor panes of its own (the
 * project board shows the project root). The named environment's pane layout
 * opens it once that environment is active and able to host file tabs.
 */
export interface PendingFileOpen {
  environmentId: string;
  filePath: string;
  options?: CreateFileTabOptions;
}

interface FilesPanelState {
  // Panel visibility
  isOpen: boolean;

  // Panel width (persisted)
  panelWidth: number;

  // Active tab
  activeTab: FilesPanelTab;

  // Expanded folder paths in the tree (persisted). Folders are collapsed by default.
  expandedFolders: string[];

  // Git changes data
  changes: GitFileChange[];
  isLoadingChanges: boolean;

  // File tree data
  fileTree: FileNode[];
  isLoadingTree: boolean;

  // Truncated tree directories read on expansion, for the target identified by
  // `fileSubtreeKey` (not persisted). Views graft them onto `fileTree`.
  fileSubtreeKey: string;
  fileSubtrees: Record<string, FileSubtree>;
  loadingFolders: string[];
  folderLoadTokens: Map<string, symbol>;
  failedFolders: string[];

  // Target branch for diff comparison (e.g., "main")
  targetBranch: string;

  // File open waiting for its environment's panes to mount (not persisted)
  pendingFileOpens: PendingFileOpen[];

  // Open pull request tabs by panel target id (persisted, bounded)
  pullRequestTabs: Record<string, FilesPanelPullRequestTab[]>;

  // Actions
  togglePanel: () => void;
  /** Opens the panel on "All files", for a target with nothing to review yet. */
  openPanelOnAllFiles: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setActiveTab: (tab: FilesPanelTab) => void;
  setPanelWidth: (width: number) => void;
  setFolderExpanded: (path: string, expanded: boolean) => void;
  setChanges: (changes: GitFileChange[]) => void;
  setFileTree: (tree: FileNode[]) => void;
  setLoadingChanges: (loading: boolean) => void;
  setLoadingTree: (loading: boolean) => void;
  /** Forgets every directory read unless they are already `key`'s, and tracks `key`. */
  resetFileSubtrees: (key: string) => void;
  /**
   * Marks `path` loading for `key`, returning its unique completion token.
   * Null for another target, an active read, or (unless `reload`) loaded/failed.
   */
  beginFolderLoad: (key: string, path: string, reload: boolean) => symbol | null;
  /** Accepts only the active token; `null` keeps earlier contents and marks failure. */
  finishFolderLoad: (
    key: string,
    path: string,
    token: symbol,
    subtree: FileSubtree | null,
  ) => boolean;
  retryFolderLoad: (path: string) => void;
  setTargetBranch: (branch: string) => void;
  requestFileOpen: (request: PendingFileOpen) => void;
  /** Clears the pending open, but only if it is still `request`. */
  clearPendingFileOpen: (request: PendingFileOpen) => void;
  /** Opens (or focuses) a pull request tab for `targetId` and shows the panel. */
  openPullRequest: (
    targetId: string,
    ref: GitHubPullRequestRef,
    view?: GitHubPullRequestViewTab,
  ) => void;
  closePullRequest: (targetId: string, key: string) => void;
  updatePullRequestTab: (
    targetId: string,
    key: string,
    summary: Pick<FilesPanelPullRequestTab, "title" | "state" | "isDraft">,
  ) => void;
}

function boundedTargets(
  tabs: Record<string, FilesPanelPullRequestTab[]>,
  targetId: string,
  next: FilesPanelPullRequestTab[],
): Record<string, FilesPanelPullRequestTab[]> {
  const { [targetId]: _previous, ...rest } = tabs;
  if (next.length === 0) return rest;
  // Most recently touched target last; drop the oldest beyond the bound.
  const entries = Object.entries(rest).filter(([, list]) => list.length > 0);
  entries.push([targetId, next]);
  return Object.fromEntries(entries.slice(-MAX_PULL_REQUEST_TAB_TARGETS));
}

function sanitizePersistedPullRequestTabs(
  value: unknown,
): Record<string, FilesPanelPullRequestTab[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, FilesPanelPullRequestTab[]> = {};
  for (const [targetId, list] of Object.entries(value).slice(-MAX_PULL_REQUEST_TAB_TARGETS)) {
    if (!Array.isArray(list)) continue;
    const tabs = list
      .filter(
        (tab): tab is FilesPanelPullRequestTab =>
          typeof tab === "object" && tab !== null && isGitHubPullRequestRef(tab.ref),
      )
      .slice(0, MAX_PULL_REQUEST_TABS_PER_TARGET)
      .map((tab) => ({
        key: gitHubPullRequestKey(tab.ref),
        ref: { owner: tab.ref.owner, repo: tab.ref.repo, number: tab.ref.number },
        view: "summary" as const,
        openRequest: 0,
        title: typeof tab.title === "string" ? tab.title.slice(0, 300) : undefined,
        state:
          tab.state === "open" || tab.state === "closed" || tab.state === "merged"
            ? tab.state
            : undefined,
        isDraft: tab.isDraft === true,
      }));
    if (tabs.length > 0) result[targetId] = tabs;
  }
  return result;
}

export const useFilesPanelStore = create<FilesPanelState>()(
  persist(
    (set, get) => ({
      // Initial state
      isOpen: false,
      panelWidth: 320,
      activeTab: "changes",
      expandedFolders: [],
      changes: [],
      isLoadingChanges: false,
      fileTree: [],
      isLoadingTree: false,
      fileSubtreeKey: "",
      fileSubtrees: {},
      loadingFolders: [],
      folderLoadTokens: new Map(),
      failedFolders: [],
      targetBranch: "main",
      pendingFileOpens: [],
      pullRequestTabs: {},

      // Actions
      togglePanel: () => set((state) => ({ isOpen: !state.isOpen })),
      openPanelOnAllFiles: () => set({ isOpen: true, activeTab: "all-files" }),
      openPanel: () => set({ isOpen: true }),
      closePanel: () => set({ isOpen: false }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setPanelWidth: (width) => set({ panelWidth: width }),
      setFolderExpanded: (path, expanded) =>
        set((state) => {
          if (expanded) {
            return state.expandedFolders.includes(path)
              ? {}
              : { expandedFolders: [...state.expandedFolders, path] };
          }
          // Forget the whole branch, including pending reads. Descendants may
          // keep their expansion preference, but reopening must read them afresh.
          const inBranch = (candidate: string) =>
            candidate === path || candidate.startsWith(`${path}/`);
          return {
            expandedFolders: state.expandedFolders.filter((p) => p !== path),
            fileSubtrees: Object.fromEntries(
              Object.entries(state.fileSubtrees).filter(([p]) => !inBranch(p)),
            ),
            failedFolders: state.failedFolders.filter((p) => !inBranch(p)),
            loadingFolders: state.loadingFolders.filter((p) => !inBranch(p)),
            folderLoadTokens: new Map([...state.folderLoadTokens].filter(([p]) => !inBranch(p))),
          };
        }),
      setChanges: (changes) => set({ changes }),
      setFileTree: (tree) => set({ fileTree: tree }),
      setLoadingChanges: (loading) => set({ isLoadingChanges: loading }),
      setLoadingTree: (loading) => set({ isLoadingTree: loading }),
      resetFileSubtrees: (key) =>
        set((state) =>
          state.fileSubtreeKey === key
            ? {}
            : {
                fileSubtreeKey: key,
                fileSubtrees: {},
                loadingFolders: [],
                folderLoadTokens: new Map(),
                failedFolders: [],
              },
        ),
      beginFolderLoad: (key, path, reload) => {
        const state = get();
        if (state.fileSubtreeKey !== key || state.folderLoadTokens.has(path)) return null;
        if (
          !reload &&
          (Object.hasOwn(state.fileSubtrees, path) || state.failedFolders.includes(path))
        ) {
          return null;
        }
        const token = Symbol(path);
        set({
          loadingFolders: [...state.loadingFolders, path],
          folderLoadTokens: new Map(state.folderLoadTokens).set(path, token),
        });
        return token;
      },
      finishFolderLoad: (key, path, token, subtree) => {
        const state = get();
        if (state.fileSubtreeKey !== key || state.folderLoadTokens.get(path) !== token)
          return false;
        const folderLoadTokens = new Map(state.folderLoadTokens);
        folderLoadTokens.delete(path);
        const loading = {
          folderLoadTokens,
          loadingFolders: state.loadingFolders.filter((p) => p !== path),
        };
        if (!state.expandedFolders.includes(path)) {
          set(loading);
          return false;
        }
        set(
          subtree
            ? {
                ...loading,
                fileSubtrees: { ...state.fileSubtrees, [path]: subtree },
                failedFolders: state.failedFolders.filter((failed) => failed !== path),
              }
            : {
                ...loading,
                failedFolders: state.failedFolders.includes(path)
                  ? state.failedFolders
                  : [...state.failedFolders, path],
              },
        );
        return true;
      },
      retryFolderLoad: (path) =>
        set((state) => {
          const { [path]: _dropped, ...fileSubtrees } = state.fileSubtrees;
          return { fileSubtrees, failedFolders: state.failedFolders.filter((p) => p !== path) };
        }),
      setTargetBranch: (branch) => set({ targetBranch: branch }),
      requestFileOpen: (request) =>
        set((state) => {
          if (state.pendingFileOpens.length >= 100 || request.filePath.length > 4096) {
            throw new Error("Too many pending file opens; wait for the editor to open");
          }
          return { pendingFileOpens: [...state.pendingFileOpens, request] };
        }),
      clearPendingFileOpen: (request) =>
        set((state) => ({
          pendingFileOpens: state.pendingFileOpens.filter((pending) => pending !== request),
        })),
      openPullRequest: (targetId, ref, view = "summary") =>
        set((state) => {
          const key = gitHubPullRequestKey(ref);
          const current = state.pullRequestTabs[targetId] ?? [];
          const existing = current.find((tab) => tab.key === key);
          const opened: FilesPanelPullRequestTab = existing
            ? { ...existing, view, openRequest: existing.openRequest + 1 }
            : {
                key,
                ref: { owner: ref.owner, repo: ref.repo, number: ref.number },
                view,
                openRequest: 0,
              };
          let next = existing
            ? current.map((tab) => (tab.key === key ? opened : tab))
            : [...current, opened];
          // Past the bound the oldest tab that is not this one closes.
          if (next.length > MAX_PULL_REQUEST_TABS_PER_TARGET) next = next.slice(1);
          return {
            isOpen: true,
            activeTab: `pull-request:${key}`,
            pullRequestTabs: boundedTargets(state.pullRequestTabs, targetId, next),
          };
        }),
      closePullRequest: (targetId, key) =>
        set((state) => {
          const current = state.pullRequestTabs[targetId] ?? [];
          const index = current.findIndex((tab) => tab.key === key);
          if (index < 0) return {};
          const next = current.filter((tab) => tab.key !== key);
          const closingActive = state.activeTab === `pull-request:${key}`;
          const neighbour = next[Math.min(index, next.length - 1)];
          return {
            pullRequestTabs: boundedTargets(state.pullRequestTabs, targetId, next),
            ...(closingActive
              ? {
                  activeTab: neighbour
                    ? (`pull-request:${neighbour.key}` as const)
                    : ("pull-requests" as const),
                }
              : {}),
          };
        }),
      updatePullRequestTab: (targetId, key, summary) =>
        set((state) => {
          const current = state.pullRequestTabs[targetId];
          const tab = current?.find((candidate) => candidate.key === key);
          if (
            !current ||
            !tab ||
            (tab.title === summary.title &&
              tab.state === summary.state &&
              tab.isDraft === summary.isDraft)
          ) {
            return {};
          }
          return {
            pullRequestTabs: {
              ...state.pullRequestTabs,
              [targetId]: current.map((candidate) =>
                candidate.key === key ? { ...candidate, ...summary } : candidate,
              ),
            },
          };
        }),
    }),
    {
      name: desktopConnectionStorageKey("files-panel-storage"),
      partialize: (state) => ({
        panelWidth: state.panelWidth,
        expandedFolders: state.expandedFolders,
        pullRequestTabs: state.pullRequestTabs,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<FilesPanelState>;
        return {
          ...current,
          ...stored,
          pullRequestTabs: sanitizePersistedPullRequestTabs(stored.pullRequestTabs),
        };
      },
    },
  ),
);
