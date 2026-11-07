import { persist } from "zustand/middleware";
import type { StateCreator } from "zustand/vanilla";
import {
  gitHubPullRequestKey,
  isGitHubPullRequestRef,
  type GitHubPullRequestRef,
  type GitHubPullRequestViewTab,
} from "@orkestrator/protocol/github-pull-requests";
import { nodeStorageKey } from "@/lib/persistence-keys";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import type { FilesPanelPullRequestTab } from "./filesPanelStore";

const MAX_TABS_PER_PROJECT = 10;
const MAX_PROJECTS = 50;

export interface ProjectPullRequestTabs {
  tabs: FilesPanelPullRequestTab[];
  /** Key of the shown pull request; null shows the list. */
  activeKey: string | null;
}

export interface ProjectPullRequestsState {
  projects: Record<string, ProjectPullRequestTabs>;
  openPullRequest: (
    projectId: string,
    ref: GitHubPullRequestRef,
    view?: GitHubPullRequestViewTab,
  ) => void;
  closePullRequest: (projectId: string, key: string) => void;
  /** Shows the list (`null`) or an open pull request. */
  setActive: (projectId: string, key: string | null) => void;
  updateTab: (
    projectId: string,
    key: string,
    summary: Pick<FilesPanelPullRequestTab, "title" | "state" | "isDraft">,
  ) => void;
}

const EMPTY: ProjectPullRequestTabs = { tabs: [], activeKey: null };

function withProject(
  projects: Record<string, ProjectPullRequestTabs>,
  projectId: string,
  next: ProjectPullRequestTabs,
): Record<string, ProjectPullRequestTabs> {
  const { [projectId]: _previous, ...rest } = projects;
  const entries = Object.entries(rest);
  entries.push([projectId, next]);
  return Object.fromEntries(entries.slice(-MAX_PROJECTS));
}

function sanitize(value: unknown): Record<string, ProjectPullRequestTabs> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, ProjectPullRequestTabs> = {};
  for (const [projectId, entry] of Object.entries(value).slice(-MAX_PROJECTS)) {
    if (typeof entry !== "object" || entry === null || !Array.isArray(entry.tabs)) continue;
    const tabs: FilesPanelPullRequestTab[] = (entry.tabs as unknown[])
      .filter(
        (tab): tab is FilesPanelPullRequestTab =>
          typeof tab === "object" &&
          tab !== null &&
          isGitHubPullRequestRef((tab as FilesPanelPullRequestTab).ref),
      )
      .slice(0, MAX_TABS_PER_PROJECT)
      .map((tab) => ({
        key: gitHubPullRequestKey(tab.ref),
        ref: { owner: tab.ref.owner, repo: tab.ref.repo, number: tab.ref.number },
        view: "summary",
        openRequest: 0,
        title: typeof tab.title === "string" ? tab.title.slice(0, 300) : undefined,
        state:
          tab.state === "open" || tab.state === "closed" || tab.state === "merged"
            ? tab.state
            : undefined,
        isDraft: tab.isDraft === true,
      }));
    const activeKey =
      typeof entry.activeKey === "string" && tabs.some((tab) => tab.key === entry.activeKey)
        ? entry.activeKey
        : null;
    if (tabs.length > 0) result[projectId] = { tabs, activeKey };
  }
  return result;
}

/** Applies a node's stored tabs to `current`, sanitized and bounded. */
export function mergePersistedProjectPullRequests(
  persisted: unknown,
  current: ProjectPullRequestsState,
): ProjectPullRequestsState {
  return {
    ...current,
    projects: sanitize((persisted as { projects?: unknown } | undefined)?.projects),
  };
}

/**
 * Pull requests opened as tabs on a project's "Pull requests" page, per node
 * (plan item 3007): project ids and pull request keys are the node's, so each
 * node keeps its own under its key (`nodeStorageKey("project-pull-requests", scope)`).
 */
export const projectPullRequestsStore = defineScopedStore<ProjectPullRequestsState>(
  "project-pull-requests",
  (scope) => {
    const creator: StateCreator<
      ProjectPullRequestsState,
      [],
      [["zustand/persist", Pick<ProjectPullRequestsState, "projects">]]
    > = persist(
      (set) => ({
        projects: {},
        openPullRequest: (projectId, ref, view = "summary") =>
          set((state) => {
            const current = state.projects[projectId] ?? EMPTY;
            const key = gitHubPullRequestKey(ref);
            const existing = current.tabs.find((tab) => tab.key === key);
            const opened: FilesPanelPullRequestTab = existing
              ? { ...existing, view, openRequest: existing.openRequest + 1 }
              : {
                  key,
                  ref: { owner: ref.owner, repo: ref.repo, number: ref.number },
                  view,
                  openRequest: 0,
                };
            let tabs = existing
              ? current.tabs.map((tab) => (tab.key === key ? opened : tab))
              : [...current.tabs, opened];
            if (tabs.length > MAX_TABS_PER_PROJECT) tabs = tabs.slice(1);
            return { projects: withProject(state.projects, projectId, { tabs, activeKey: key }) };
          }),
        closePullRequest: (projectId, key) =>
          set((state) => {
            const current = state.projects[projectId];
            if (!current) return {};
            const index = current.tabs.findIndex((tab) => tab.key === key);
            if (index < 0) return {};
            const tabs = current.tabs.filter((tab) => tab.key !== key);
            const activeKey =
              current.activeKey === key
                ? (tabs[Math.min(index, tabs.length - 1)]?.key ?? null)
                : current.activeKey;
            return { projects: withProject(state.projects, projectId, { tabs, activeKey }) };
          }),
        setActive: (projectId, key) =>
          set((state) => {
            const current = state.projects[projectId] ?? EMPTY;
            if (key !== null && !current.tabs.some((tab) => tab.key === key)) return {};
            if (current.activeKey === key) return {};
            return {
              projects: withProject(state.projects, projectId, { ...current, activeKey: key }),
            };
          }),
        updateTab: (projectId, key, summary) =>
          set((state) => {
            const current = state.projects[projectId];
            const tab = current?.tabs.find((candidate) => candidate.key === key);
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
              projects: {
                ...state.projects,
                [projectId]: {
                  ...current,
                  tabs: current.tabs.map((candidate) =>
                    candidate.key === key ? { ...candidate, ...summary } : candidate,
                  ),
                },
              },
            };
          }),
      }),
      {
        name: nodeStorageKey("project-pull-requests", scope),
        partialize: (state) => ({ projects: state.projects }),
        merge: mergePersistedProjectPullRequests,
      },
    );
    // `persist` adds its `persist` API to the store; nothing here reads it.
    return creator as StateCreator<ProjectPullRequestsState>;
  },
);

/**
 * Reads the nearest node scope's project pull request tabs; other code uses
 * `scope.store(projectPullRequestsStore)`.
 */
export const useProjectPullRequestsStore = scopedStoreHook(projectPullRequestsStore);

export function selectProjectPullRequestTabs(
  state: ProjectPullRequestsState,
  projectId: string,
): ProjectPullRequestTabs {
  return state.projects[projectId] ?? EMPTY;
}
