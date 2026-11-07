import type { StateStorage } from "zustand/middleware";
import { windowStorageKey } from "./desktop-storage-key";
import { COMMAND_STORAGE_NODE, nodeStorageKey, type StorageNode } from "./persistence-keys";

/** A node's persisted UI state: project ids are only unique on their node. */
export const UI_NODE_PERSISTED_FIELDS = [
  "collapsedProjects",
  "projectCollapseChoices",
  "collapsedProjectFolders",
  "recentProjectIds",
] as const;

type Persisted = { state?: Record<string, unknown>; version?: number } | null;

function read(key: string): Persisted {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as Persisted;
  } catch {
    return null;
  }
}

function hasNodeFields(record: Persisted): boolean {
  return UI_NODE_PERSISTED_FIELDS.some((field) => record?.state?.[field] !== undefined);
}

/**
 * The window's chrome (`uiChromeStore`) under `windowStorageKey("ui-storage")`.
 *
 * An earlier release kept the command node's project fields in this record
 * too, before they had a key of their own; a write keeps them until the
 * command node's store has moved them (`createUIStateStorage`), so they are
 * never lost to a chrome write that happens first.
 */
export function createUIWindowStateStorage(): StateStorage {
  const windowKey = windowStorageKey("ui-storage");
  return {
    getItem: () => localStorage.getItem(windowKey),
    setItem: (_key, value) => {
      const parsed = JSON.parse(value) as { state: Record<string, unknown>; version?: number };
      const existing = read(windowKey);
      const state = { ...parsed.state };
      if (hasNodeFields(existing)) {
        for (const field of UI_NODE_PERSISTED_FIELDS) {
          if (existing?.state?.[field] !== undefined) state[field] = existing.state[field];
        }
      }
      localStorage.setItem(windowKey, JSON.stringify({ ...parsed, state }));
    },
    removeItem: () => localStorage.removeItem(windowKey),
  };
}

/**
 * `node`'s collapsed projects, folders and recents (the scoped `uiStore`),
 * under `nodeStorageKey("ui-project-storage", node)`.
 *
 * With no record there yet it adopts what an earlier release stored for this
 * node: the command node's fields from the window record (moved out of it on
 * the first write), or a record already under this node's own `ui-storage`
 * namespace (which earlier releases' per-node workspace frames wrote).
 */
export function createUIStateStorage(node: StorageNode = COMMAND_STORAGE_NODE): StateStorage {
  const windowKey = windowStorageKey("ui-storage");
  const projectKey = nodeStorageKey("ui-project-storage", node);
  // Adopt only state already stored under this node's namespace: for the
  // command node that is the window record itself.
  const legacyKey = nodeStorageKey("ui-storage", node);
  return {
    getItem: () => {
      const projects = read(projectKey) ?? read(legacyKey);
      const state: Record<string, unknown> = {};
      for (const field of UI_NODE_PERSISTED_FIELDS) state[field] = projects?.state?.[field] ?? [];
      return JSON.stringify({ state, version: 0 });
    },
    setItem: (_key, value) => {
      const parsed = JSON.parse(value) as { state: Record<string, unknown>; version?: number };
      const projects: Record<string, unknown> = {};
      for (const field of UI_NODE_PERSISTED_FIELDS) projects[field] = parsed.state[field];
      localStorage.setItem(projectKey, JSON.stringify({ ...parsed, state: projects }));
      if (legacyKey !== windowKey) return;
      // The fields now have their own key: retire the window record's copy.
      const windowRecord = read(windowKey);
      if (!hasNodeFields(windowRecord)) return;
      const chrome = { ...windowRecord?.state };
      for (const field of UI_NODE_PERSISTED_FIELDS) delete chrome[field];
      localStorage.setItem(windowKey, JSON.stringify({ ...windowRecord, state: chrome }));
    },
    removeItem: () => localStorage.removeItem(projectKey),
  };
}
