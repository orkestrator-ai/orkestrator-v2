import type { StateStorage } from "zustand/middleware";
import { windowStorageKey } from "./desktop-storage-key";
import { COMMAND_STORAGE_NODE, nodeStorageKey, type StorageNode } from "./persistence-keys";

const PROJECT_FIELDS = [
  "collapsedProjects",
  "projectCollapseChoices",
  "collapsedProjectFolders",
  "recentProjectIds",
] as const;

/** Window shape follows the command window; project IDs belong to `node`. */
export function createUIStateStorage(node: StorageNode = COMMAND_STORAGE_NODE): StateStorage {
  const windowKey = windowStorageKey("ui-storage");
  const projectKey = nodeStorageKey("ui-project-storage", node);
  const oldWorkspaceKey = nodeStorageKey("ui-storage", node);
  return {
    getItem: () => {
      const presentation = JSON.parse(localStorage.getItem(windowKey) ?? "null");
      let projects = JSON.parse(localStorage.getItem(projectKey) ?? "null");
      if (!projects && oldWorkspaceKey === windowKey) {
        projects = presentation;
      } else if (!projects && oldWorkspaceKey !== windowKey) {
        // Adopt only state already stored under this node's namespace.
        projects = JSON.parse(localStorage.getItem(oldWorkspaceKey) ?? "null");
      }
      const state = { ...presentation?.state };
      for (const field of PROJECT_FIELDS) state[field] = projects?.state?.[field] ?? [];
      return JSON.stringify({ state, version: 0 });
    },
    setItem: (_key, value) => {
      const parsed = JSON.parse(value);
      const presentation = { ...parsed.state };
      const projects: Record<string, unknown> = {};
      for (const field of PROJECT_FIELDS) {
        projects[field] = presentation[field];
        delete presentation[field];
      }
      localStorage.setItem(projectKey, JSON.stringify({ ...parsed, state: projects }));
      localStorage.setItem(windowKey, JSON.stringify({ ...parsed, state: presentation }));
    },
    removeItem: () => {
      localStorage.removeItem(projectKey);
      localStorage.removeItem(windowKey);
    },
  };
}
