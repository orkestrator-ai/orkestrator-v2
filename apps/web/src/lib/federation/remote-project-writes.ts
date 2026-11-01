import { createStore } from "zustand/vanilla";
import type { BackendId } from "@orkestrator/protocol/federation";
import { MAX_SUMMARY_PROJECTS } from "@orkestrator/protocol/node-summaries";
import type { PortalStore } from "@/lib/portal/portal-store";
import {
  normalizeProjectFolderName,
  type ProjectArrangement,
  type ProjectArrangementIntent,
} from "@/lib/project-folders";
import { isUnknownBackendCommand } from "@/lib/portal/unknown-command";
import type { FederatedProject } from "./summaries";

const OPTIMISTIC_ARRANGEMENT_MS = 10_000;

type Write = {
  nodeId: BackendId;
  arrangement: ProjectArrangement;
  onError: (error: unknown) => void;
};
type Pending = {
  latest: Write;
  writing: boolean;
  /** Gestures the owner has yet to apply, in the order the user made them. */
  intents: ProjectArrangementIntent[];
  cleanup?: () => void;
};

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

/** What the owner actually holds, as an overlay the summary can later confirm. */
function arrangementFromOwner(result: unknown): ProjectArrangement | null {
  if (!Array.isArray(result)) return null;
  const projects = result as Array<{ id: string; order: number; folder?: string | null }>;
  const folders: Record<string, string | null> = {};
  for (const project of projects) folders[project.id] = project.folder ?? null;
  return {
    projectIds: [...projects].sort((a, b) => a.order - b.order).map((project) => project.id),
    folders,
  };
}

/**
 * Project arrangements on other machines ("by machine"). A gesture is sent to
 * the owner as an intent with `arrange_projects_by_intent`, which resolves it
 * against the owner's current projects; each one is delivered in order, one at
 * a time. An owner that predates the command gets the latest arrangement
 * through `arrange_projects` instead, which also covers everything still queued.
 * The arrangement is shown until the owner's summary reflects it.
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
    if (nodeId === state.selfId)
      return state.self && !state.self.truncated ? state.self.projects : null;
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
    const whole = (): Promise<unknown> =>
      portal.invokeOnNode(write.nodeId, "arrange_projects", {
        projectIds: [...write.arrangement.projectIds],
        folders: { ...write.arrangement.folders },
      });
    const intent = entry.intents.shift();
    const request: Promise<unknown> = intent
      ? portal
          .invokeOnNode(write.nodeId, "arrange_projects_by_intent", { intent })
          .catch((error: unknown) => {
            if (!isUnknownBackendCommand(error, "arrange_projects_by_intent")) throw error;
            entry.intents.length = 0;
            return whole();
          })
      : whole();
    void request.then(
      (result) => {
        entry.writing = false;
        if (entry.latest !== write || entry.intents.length > 0) {
          send(entry, entry.latest);
          return;
        }
        // The owner resolved the gesture against its own state, which may differ
        // from this client's preview. Show that, or the overlay would wait out
        // its deadline for a summary that will never match.
        const owner = intent ? arrangementFromOwner(result) : null;
        const settled = owner ? { ...write, arrangement: owner } : write;
        if (owner) store.setState((current) => new Map(current).set(write.nodeId, owner), true);
        settle(entry, settled);
      },
      (error: unknown) => {
        forget(write.nodeId, entry);
        write.onError(error);
      },
    );
  };

  return {
    store,
    submit(
      nodeId: BackendId,
      arrangement: ProjectArrangement,
      onError: Write["onError"],
      intent?: ProjectArrangementIntent,
    ) {
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
        entry = { latest: write, writing: false, intents: [] };
        pending.set(nodeId, entry);
      }
      if (intent) entry.intents.push(intent);
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
