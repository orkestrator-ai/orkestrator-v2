import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CoordinatorSnapshot, ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import {
  classifyViewSnapshotResponse,
  isUnknownViewCommandError,
  type ViewRevisionStamp,
} from "@orkestrator/protocol/view-sync";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import * as backend from "@/lib/backend";
import { onResourceChanged, onViewSafetyCheck } from "@/lib/resource-sync";

/**
 * Low-frequency probe for Git changes made outside Orkestrator (a terminal
 * checkout, a push from another machine). Only while the panel is open and the
 * document visible; the read coordinator pauses it otherwise.
 */
export const GIT_STATUS_PROBE_INTERVAL_MS = 60_000;
/** Conservative coordinator polling kept for backends without the view command. */
export const LEGACY_COORDINATOR_POLL_INTERVAL_MS = 60_000;
/**
 * Focus and visibility both fire when a window is brought back; one probe per
 * this window serves both, and a read that already ran recently serves them.
 */
export const COORDINATOR_FOCUS_PROBE_MIN_INTERVAL_MS = 10_000;

export function isCoordinatorSnapshot(value: unknown): value is CoordinatorSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const workspace = candidate.workspace as Record<string, unknown> | null | undefined;
  return (
    typeof workspace === "object" &&
    workspace !== null &&
    typeof workspace.projectId === "string" &&
    Array.isArray(workspace.conversations) &&
    typeof candidate.providerAvailability === "object" &&
    candidate.providerAvailability !== null &&
    Array.isArray(candidate.workflows)
  );
}

interface CoordinatorViewValue {
  projectId: string;
  /** `undefined`: unchanged (keep the body held); `null`: the workspace is gone. */
  snapshot: CoordinatorSnapshot | null | undefined;
  stamp: ViewRevisionStamp | null;
  /** Direct-answer sequence when the read started (see `directSeq`). */
  directSeq: number;
  /** Legacy reads cannot report a removal; `null` there means "keep". */
  legacy: boolean;
}

/**
 * Coordinator panel data: the coordinator snapshot and the project's Git status.
 *
 * **Ownership.** Panel-owned, not an always-mounted store: this panel is the
 * only consumer, it rehydrates on every mount, and the read coordinator
 * re-reads it after a transport reconnect or server switch. The backend stays
 * authoritative; every mutation remains a direct command whose answer is
 * applied through {@link CoordinatorPanelData.applySnapshot}.
 *
 * **Coordinator view.** Subscribes to scoped `coordinator` resource changes
 * (and `config`, which decides provider availability) before hydrating; an
 * event that arrives while the workspace is still being ensured is replayed as
 * one read once the view is live. Reads are conditional
 * (`get_project_coordinator_view`): an unchanged snapshot costs a bodiless
 * answer and no render. Missed events are recovered by the resource-sync
 * safety cadence (five-minute interval and resource revision gaps), transport
 * reconnects and focus. A backend without the command keeps the previous
 * 60-second full poll.
 *
 * **Repository status.** Separate: an external Git command does not emit a
 * coordinator event. A 60-second visible-only probe, a guarded focus probe,
 * and explicit fetch/sync/switch keep it current; a newer status persisted by
 * any client or backend path also arrives inside the coordinator snapshot and
 * is adopted from there. Status reads never fetch; fetch-on-open stays subject
 * to the backend's shared fetch cooldown.
 *
 * **Fencing.** Every answer carries its project identity and is dropped if the
 * panel has moved to another project; a view body read before a direct answer
 * was applied is discarded and re-read rather than overwriting newer state.
 */
export interface CoordinatorPanelData {
  snapshot: CoordinatorSnapshot | null;
  git: ProjectGitStatus | null;
  loading: boolean;
  error: string | null;
  /** Ensures the workspace, then reads status and requests a policy-bound fetch. */
  load: () => Promise<void>;
  /** Applies a direct (mutation) answer for the current project. */
  applySnapshot: (snapshot: CoordinatorSnapshot | null | undefined) => void;
  applyGit: (status: ProjectGitStatus | null | undefined) => void;
  /** Coalesced hint that the coordinator snapshot may have changed. */
  invalidateView: () => void;
  /** Explicit refresh: resolves after a coordinator read started after the call. */
  refreshView: () => Promise<void>;
}

export function useCoordinatorPanelData(projectId: string): CoordinatorPanelData {
  const instance = useId();
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const [snapshot, setSnapshot] = useState<CoordinatorSnapshot | null>(null);
  const [git, setGit] = useState<ProjectGitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readyProject, setReadyProject] = useState<string | null>(null);
  const ready = readyProject === projectId;
  const legacyRef = useRef(false);
  const stampRef = useRef<ViewRevisionStamp | null>(null);
  const directSeqRef = useRef(0);
  const gitRef = useRef<ProjectGitStatus | null>(null);
  const liveRef = useRef(false);
  const pendingViewReadRef = useRef(false);
  const lastProbeRef = useRef(0);

  const applyGit = useCallback((next: ProjectGitStatus | null | undefined) => {
    if (!next || next.projectId !== projectRef.current) return;
    const current = gitRef.current;
    // Status revisions only grow per project; an older answer arriving late
    // (a slow fetch racing a newer status read) must not roll the view back.
    if (current && current.projectId === next.projectId && next.revision < current.revision) {
      return;
    }
    gitRef.current = next;
    setGit(next);
  }, []);

  const adoptSnapshot = useCallback(
    (next: CoordinatorSnapshot) => {
      setSnapshot(next);
      // The persisted status inside the snapshot is adopted only when strictly
      // newer: the backend keeps the revision when the material is unchanged,
      // so an equal revision carries nothing this panel has not already read.
      const persisted = next.workspace.repositoryStatus;
      const current = gitRef.current;
      if (persisted && (!current || persisted.revision > current.revision)) applyGit(persisted);
    },
    [applyGit],
  );

  const applySnapshot = useCallback(
    (next: CoordinatorSnapshot | null | undefined) => {
      if (!next || next.workspace.projectId !== projectRef.current) return;
      // A direct answer is not stamped: forget the held stamp so the next view
      // read sends a body, and discard view reads that started before it.
      directSeqRef.current += 1;
      stampRef.current = null;
      adoptSnapshot(next);
    },
    [adoptSnapshot],
  );

  const view = useCoordinatedRead<CoordinatorViewValue>({
    key: { resource: "coordinator-view", target: projectId, view: instance },
    enabled: ready,
    readOnSubscribe: false,
    demand: {
      active: ready,
      intervalMs: LEGACY_COORDINATOR_POLL_INTERVAL_MS,
      priority: "standard",
    },
    read: async () => {
      const pid = projectId;
      const sent = stampRef.current;
      const directSeq = directSeqRef.current;
      if (!legacyRef.current) {
        try {
          const answer = await backend.getProjectCoordinatorView(pid, sent);
          const classified = classifyViewSnapshotResponse(answer, isCoordinatorSnapshot);
          if (classified.kind === "invalid") {
            throw new Error("The backend returned an invalid coordinator view");
          }
          if (classified.kind !== "outcome") {
            return {
              projectId: pid,
              snapshot: classified.snapshot,
              stamp: null,
              directSeq,
              legacy: false,
            };
          }
          const outcome = classified.outcome;
          const stamp = { generation: outcome.generation, revision: outcome.revision };
          if (outcome.status === "unchanged") {
            // Only meaningful for the exact stamp that was sent.
            if (!sent || sent.generation !== stamp.generation || sent.revision !== stamp.revision) {
              throw new Error("The backend confirmed a coordinator view this client did not send");
            }
            return { projectId: pid, snapshot: undefined, stamp, directSeq, legacy: false };
          }
          if (outcome.status === "deleted") {
            return { projectId: pid, snapshot: null, stamp, directSeq, legacy: false };
          }
          return { projectId: pid, snapshot: outcome.snapshot, stamp, directSeq, legacy: false };
        } catch (cause) {
          if (!isUnknownViewCommandError(cause, backend.COORDINATOR_VIEW_COMMAND)) throw cause;
          legacyRef.current = true;
        }
      }
      const full = await backend.getProjectCoordinator(pid);
      return { projectId: pid, snapshot: full, stamp: null, directSeq, legacy: true };
    },
    onState: (state) => {
      if (state.status !== "current" || !state.value) return;
      const value = state.value;
      if (value.projectId !== projectRef.current) return;
      if (value.directSeq !== directSeqRef.current) {
        // A direct answer landed while this read was out; it may be newer.
        stampRef.current = null;
        view.invalidate();
        return;
      }
      stampRef.current = value.stamp;
      if (value.snapshot === undefined) return;
      if (value.snapshot === null) {
        if (!value.legacy) setSnapshot(null);
        return;
      }
      if (value.snapshot.workspace.projectId !== projectRef.current) return;
      adoptSnapshot(value.snapshot);
    },
  });

  const gitRead = useCoordinatedRead<ProjectGitStatus>({
    key: { resource: "project-git-status", target: projectId },
    enabled: ready,
    readOnSubscribe: false,
    demand: { active: ready, intervalMs: GIT_STATUS_PROBE_INTERVAL_MS, priority: "auxiliary" },
    read: () => {
      lastProbeRef.current = Date.now();
      return backend.getProjectGitStatus(projectId);
    },
    onState: (state) => {
      if (state.status === "current") applyGit(state.value);
    },
  });

  const invalidateView = view.invalidate;
  const requestViewRead = useCallback(() => {
    if (!liveRef.current) {
      pendingViewReadRef.current = true;
      return;
    }
    invalidateView();
  }, [invalidateView]);

  // Subscribe before hydrating. Declared ahead of the load effect so a change
  // announced while the workspace is being ensured is never lost.
  useEffect(() => {
    const offCoordinator = onResourceChanged("coordinator", (change) => {
      if (change.id === projectRef.current || change.projectId === projectRef.current) {
        requestViewRead();
      }
    });
    // Provider availability is derived from configuration.
    const offConfig = onResourceChanged("config", () => requestViewRead());
    const offSafety = onViewSafetyCheck(() => {
      if (!legacyRef.current) requestViewRead();
    });
    return () => {
      offCoordinator();
      offConfig();
      offSafety();
    };
  }, [requestViewRead]);

  const load = useCallback(async () => {
    const pid = projectId;
    setLoading(true);
    setError(null);
    try {
      const coordinator = await backend.ensureProjectCoordinator(pid);
      if (projectRef.current !== pid) return;
      applySnapshot(coordinator);
      setReadyProject(pid);
      lastProbeRef.current = Date.now();
      applyGit(await backend.getProjectGitStatus(pid));
      // Fetch-on-open: the backend's fetch cooldown decides whether this
      // reaches the remote; an in-flight fetch from another client is joined.
      void backend
        .fetchProjectGit(pid)
        .then(applyGit)
        .catch(() => undefined);
    } catch (cause) {
      if (projectRef.current !== pid) return;
      setError(cause instanceof Error ? cause.message : "Coordinator could not be opened");
    } finally {
      if (projectRef.current === pid) setLoading(false);
    }
  }, [applyGit, applySnapshot, projectId]);

  useEffect(() => {
    // A new project starts from nothing; nothing from the previous one applies.
    liveRef.current = false;
    pendingViewReadRef.current = false;
    stampRef.current = null;
    gitRef.current = null;
    setSnapshot(null);
    setGit(null);
    setReadyProject(null);
    void load();
  }, [load]);

  // Runs after `useCoordinatedRead` subscribed for the ready project, so an
  // invalidation queued during hydration reaches a live subscription.
  useEffect(() => {
    liveRef.current = ready;
    if (!ready || !pendingViewReadRef.current) return;
    pendingViewReadRef.current = false;
    invalidateView();
  }, [invalidateView, ready]);

  const invalidateGit = gitRead.invalidate;
  useEffect(() => {
    if (!ready) return;
    const probe = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastProbeRef.current < COORDINATOR_FOCUS_PROBE_MIN_INTERVAL_MS) return;
      lastProbeRef.current = now;
      invalidateGit();
      invalidateView();
    };
    window.addEventListener("focus", probe);
    document.addEventListener("visibilitychange", probe);
    return () => {
      window.removeEventListener("focus", probe);
      document.removeEventListener("visibilitychange", probe);
    };
  }, [invalidateGit, invalidateView, ready]);

  const viewRefresh = view.refresh;
  const refreshView = useCallback(async () => {
    await viewRefresh();
  }, [viewRefresh]);

  return {
    snapshot: snapshot && snapshot.workspace.projectId === projectId ? snapshot : null,
    git: git && git.projectId === projectId ? git : null,
    loading,
    error,
    load,
    applySnapshot,
    applyGit,
    invalidateView: requestViewRead,
    refreshView,
  };
}
