import { persist } from "zustand/middleware";
import type { StateCreator } from "zustand/vanilla";
import type { GitFileChange, FileNode, FileSubtree } from "@/lib/backend";
import { nodeStorageKey } from "@/lib/persistence-keys";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { useFilesPanelChromeStore } from "./filesPanelChromeStore";
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

/** Pseudo target id used for the project root before its home environment exists. */
export function projectRootFilesTargetId(projectId: string): string {
  return `project-root:${projectId}`;
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

/**
 * What the files panel shows for one node. Whether the panel is open, and
 * its width, are the window's (`filesPanelChromeStore`).
 */
export interface FilesPanelState {
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
  /** What the backend called each held directory, to ask whether it changed. */
  fileSubtreeDigests: Record<string, string>;
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
  /** Opens the window's panel on "All files", for a target with nothing to review yet. */
  openPanelOnAllFiles: () => void;
  setActiveTab: (tab: FilesPanelTab) => void;
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
  /**
   * Accepts only the active token. `null` keeps earlier contents and marks
   * failure; `"unchanged"` keeps them, and their identity, as still current.
   */
  finishFolderLoad: (
    key: string,
    path: string,
    token: symbol,
    subtree: FileSubtree | null | "unchanged",
    digest?: string,
  ) => boolean;
  retryFolderLoad: (path: string) => void;
  setTargetBranch: (branch: string) => void;
  requestFileOpen: (request: PendingFileOpen) => void;
  /** Clears the pending open, but only if it is still `request`. */
  clearPendingFileOpen: (request: PendingFileOpen) => void;
  /** Opens (or focuses) a pull request tab for `targetId` and shows the window's panel. */
  openPullRequest: (
    targetId: string,
    ref: GitHubPullRequestRef,
    view?: GitHubPullRequestViewTab,
  ) => void;
  movePullRequestTabs: (from: string, to: string) => void;
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

export function sanitizePersistedPullRequestTabs(
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

const MAX_PERSISTED_EXPANDED_FOLDERS = 10_000;

function sanitizePersistedExpandedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((path): path is string => typeof path === "string" && path.length <= 4096)
    .slice(0, MAX_PERSISTED_EXPANDED_FOLDERS);
}

/** What one node's panel keeps across reloads. */
export type PersistedFilesPanelState = Pick<FilesPanelState, "expandedFolders" | "pullRequestTabs">;

/**
 * Applies a node's stored panel state to `current`. Only the persisted fields
 * are read, each sanitized; anything else in the stored value (an earlier
 * release's `panelWidth`, now the window's) is ignored.
 */
export function mergePersistedFilesPanelState(
  persisted: unknown,
  current: FilesPanelState,
): FilesPanelState {
  const stored = (typeof persisted === "object" && persisted !== null ? persisted : {}) as Partial<
    Record<keyof PersistedFilesPanelState, unknown>
  >;
  return {
    ...current,
    expandedFolders: sanitizePersistedExpandedFolders(stored.expandedFolders),
    pullRequestTabs: sanitizePersistedPullRequestTabs(stored.pullRequestTabs),
  };
}

/**
 * The files panel's state per node (report §7.1 class (d), plan item 3007):
 * active tab, expanded folders, pull request tabs and the loaded files of the
 * target the panel shows. Folder paths and pull request targets are node-local
 * ids, so each node keeps its own, persisted under that node's key
 * (`nodeStorageKey("files-panel-storage", scope)`).
 */
export const filesPanelStore = defineScopedStore<FilesPanelState>("files-panel", (scope) => {
  const creator: StateCreator<
    FilesPanelState,
    [],
    [["zustand/persist", PersistedFilesPanelState]]
  > = persist(
    (set, get) => ({
      // Initial state
      activeTab: "changes",
      expandedFolders: [],
      changes: [],
      isLoadingChanges: false,
      fileTree: [],
      isLoadingTree: false,
      fileSubtreeKey: "",
      fileSubtrees: {},
      fileSubtreeDigests: {},
      loadingFolders: [],
      folderLoadTokens: new Map(),
      failedFolders: [],
      targetBranch: "main",
      pendingFileOpens: [],
      pullRequestTabs: {},

      // Actions
      openPanelOnAllFiles: () => {
        set({ activeTab: "all-files" });
        useFilesPanelChromeStore.getState().openPanel();
      },
      setActiveTab: (tab) => set({ activeTab: tab }),
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
            fileSubtreeDigests: Object.fromEntries(
              Object.entries(state.fileSubtreeDigests).filter(([p]) => !inBranch(p)),
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
                fileSubtreeDigests: {},
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
      finishFolderLoad: (key, path, token, subtree, digest) => {
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
        if (subtree === "unchanged") {
          set({
            ...loading,
            failedFolders: state.failedFolders.includes(path)
              ? state.failedFolders.filter((failed) => failed !== path)
              : state.failedFolders,
          });
          return true;
        }
        const { [path]: _previousDigest, ...otherDigests } = state.fileSubtreeDigests;
        set(
          subtree
            ? {
                ...loading,
                fileSubtrees: { ...state.fileSubtrees, [path]: subtree },
                fileSubtreeDigests: digest ? { ...otherDigests, [path]: digest } : otherDigests,
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
          const { [path]: _droppedDigest, ...fileSubtreeDigests } = state.fileSubtreeDigests;
          return {
            fileSubtrees,
            fileSubtreeDigests,
            failedFolders: state.failedFolders.filter((p) => p !== path),
          };
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
      openPullRequest: (targetId, ref, view = "summary") => {
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
            activeTab: `pull-request:${key}`,
            pullRequestTabs: boundedTargets(state.pullRequestTabs, targetId, next),
          };
        });
        useFilesPanelChromeStore.getState().openPanel();
      },
      // Project-home activation changes the panel identity without changing
      // the checkout the reader sees. Carry its PR tabs across that transition.
      movePullRequestTabs: (from, to) =>
        set((state) => {
          const source = state.pullRequestTabs[from];
          if (from === to || !source?.length) return {};
          const keys = new Set(source.map((tab) => tab.key));
          const merged = [
            ...(state.pullRequestTabs[to] ?? []).filter((tab) => !keys.has(tab.key)),
            ...source,
          ].slice(-MAX_PULL_REQUEST_TABS_PER_TARGET);
          const remaining = { ...state.pullRequestTabs };
          delete remaining[from];
          return { pullRequestTabs: boundedTargets(remaining, to, merged) };
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
      name: nodeStorageKey("files-panel-storage", scope),
      partialize: (state) => ({
        expandedFolders: state.expandedFolders,
        pullRequestTabs: state.pullRequestTabs,
      }),
      merge: mergePersistedFilesPanelState,
    },
  );
  // `persist` adds its `persist` API to the store; nothing here reads it.
  return creator as StateCreator<FilesPanelState>;
});

/**
 * Reads the nearest node scope's files panel state; other code uses
 * `scope.store(filesPanelStore)`.
 */
export const useFilesPanelStore = scopedStoreHook(filesPanelStore);
