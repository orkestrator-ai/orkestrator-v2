import { createStore } from "zustand/vanilla";
import type { BackendId } from "@orkestrator/protocol/federation";
import { MAX_SUMMARY_PROJECTS } from "@orkestrator/protocol/node-summaries";
import type { PortalStore } from "@/lib/portal/portal-store";
import { normalizeProjectFolderName, type ProjectArrangement } from "@/lib/project-folders";
import type { FederatedProject } from "./summaries";

const OPTIMISTIC_ARRANGEMENT_MS = 10_000;

type Write = {
  nodeId: BackendId;
  arrangement: ProjectArrangement;
  onError: (error: unknown) => void;
};
type Pending = { latest: Write; writing: boolean; cleanup?: () => void };

/**
 * Another machine's projects with an arrangement applied: its order and the
 * folders it moves projects into.
 */
export function withArrangement(
  projects: readonly FederatedProject[],
  arrangement: ProjectArrangement | undefined,
): FederatedProject[] {
  const ordered = [...projects].sort((left, right) => left.order - right.order);
  if (!arrangement) return ordered;
  const position = new Map(arrangement.projectIds.map((id, index) => [id, index]));
  return ordered
    .map((project) => {
      const id = project.ref.projectId;
      if (!Object.hasOwn(arrangement.folders, id)) return project;
      const folder = normalizeProjectFolderName(arrangement.folders[id]);
      const { folder: _previous, ...rest } = project;
      return folder ? { ...rest, folder } : rest;
    })
    .sort(
      (left, right) =>
        (position.get(left.ref.projectId) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(right.ref.projectId) ?? Number.MAX_SAFE_INTEGER),
    );
}

function reflects(projects: readonly FederatedProject[], arrangement: ProjectArrangement): boolean {
  const ordered = [...projects].sort((left, right) => left.order - right.order);
  const byId = new Map(ordered.map((project) => [project.ref.projectId, project]));
  const order = ordered.map((project) => project.ref.projectId);
  const expected = arrangement.projectIds.filter((id) => byId.has(id));
  if (expected.some((id, index) => order[index] !== id)) return false;
  return Object.entries(arrangement.folders).every(([id, folder]) => {
    const project = byId.get(id);
    return (
      !project || normalizeProjectFolderName(project.folder) === normalizeProjectFolderName(folder)
    );
  });
}

/**
 * Project arrangements on other machines ("by machine"), written to the
 * owner with `arrange_projects`. One active write and one latest pending
 * arrangement per machine, shown until the owner's summary reflects it.
 * Owned by the portal, like environment reorders.
 */
export function createRemoteProjectWrites(portal: PortalStore) {
  const store = createStore<ReadonlyMap<string, ProjectArrangement>>(() => new Map());
  const pending = new Map<string, Pending>();

  const forget = (nodeId: string, entry: Pending) => {
    if (pending.get(nodeId) !== entry) return;
    entry.cleanup?.();
    pending.delete(nodeId);
    store.setState((current) => {
      const next = new Map(current);
      next.delete(nodeId);
      return next;
    }, true);
  };

  const projectsOf = (nodeId: BackendId): FederatedProject[] | null => {
    const state = portal.getState();
    if (nodeId === state.selfId) return state.self?.projects ?? null;
    const node = portal.node(nodeId);
    return node && !node.truncated ? node.projects : null;
  };

  const settle = (entry: Pending, write: Write) => {
    const reconcile = () => {
      const projects = projectsOf(write.nodeId);
      if (projects && reflects(projects, write.arrangement)) forget(write.nodeId, entry);
    };
    // Subscribe first, then read the authoritative snapshot.
    const unsubscribe = portal.store.subscribe(reconcile);
    const timer = setTimeout(() => forget(write.nodeId, entry), OPTIMISTIC_ARRANGEMENT_MS);
    entry.cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
    };
    reconcile();
  };

  const send = (entry: Pending, write: Write) => {
    entry.writing = true;
    void portal
      .invokeOnNode(write.nodeId, "arrange_projects", {
        projectIds: [...write.arrangement.projectIds],
        folders: { ...write.arrangement.folders },
      })
      .then(
        () => {
          entry.writing = false;
          if (entry.latest !== write) send(entry, entry.latest);
          else settle(entry, write);
        },
        (error: unknown) => {
          forget(write.nodeId, entry);
          write.onError(error);
        },
      );
  };

  return {
    store,
    submit(nodeId: BackendId, arrangement: ProjectArrangement, onError: Write["onError"]) {
      if (arrangement.projectIds.length > MAX_SUMMARY_PROJECTS) {
        onError(new Error("This project order is too large to submit."));
        return;
      }
      // Folder moves accumulate over writes the owner has not reflected yet.
      const previous = store.getState().get(nodeId);
      const merged: ProjectArrangement = {
        projectIds: [...arrangement.projectIds],
        folders: { ...previous?.folders, ...arrangement.folders },
      };
      const write: Write = { nodeId, arrangement: merged, onError };
      let entry = pending.get(nodeId);
      if (entry) {
        entry.cleanup?.();
        entry.cleanup = undefined;
        entry.latest = write;
      } else {
        entry = { latest: write, writing: false };
        pending.set(nodeId, entry);
      }
      store.setState((current) => new Map(current).set(nodeId, merged), true);
      if (!entry.writing) send(entry, write);
    },
  };
}

const controllers = new WeakMap<PortalStore, ReturnType<typeof createRemoteProjectWrites>>();

export function remoteProjectsFor(portal: PortalStore) {
  let controller = controllers.get(portal);
  if (!controller) {
    controller = createRemoteProjectWrites(portal);
    controllers.set(portal, controller);
  }
  return controller;
}
