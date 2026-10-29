import { create } from "zustand";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type {
  GraphRunArtifactView,
  GraphRunSummary,
  GraphRunTranscriptView,
} from "@orkestrator/protocol/graphs/run-view";
import {
  getGraphRun,
  getGraphRunArtifact,
  getGraphRunTranscript,
  listGraphRuns,
} from "@/lib/backend/graph-runs";

/**
 * Graph runs as the run view and the runs list see them (item 211).
 *
 * Everything here is a backend snapshot (invariant 1): a run is re-read with
 * `graph_run_get` when a view mounts, when a `graph-run` change is announced
 * and on view safety checks, and a snapshot replaces the held one only when
 * its revision is newer, so a late answer can never move a run backwards.
 * `knownRevision` makes the refetch an `unchanged` answer when nothing moved.
 * Nothing here cancels or changes a run on unmount; actions go through the
 * backend and apply the snapshot it returns.
 *
 * Bounded: artifacts are immutable apart from their live/superseded mark and
 * are kept for the newest {@link MAX_CACHED_ARTIFACTS}; transcripts for the
 * newest {@link MAX_CACHED_TRANSCRIPTS} activations.
 */

export type GraphRunLoadStatus = "idle" | "loading" | "ready" | "missing" | "error";

export interface GraphRunEntry {
  run: GraphRun | null;
  status: GraphRunLoadStatus;
  error: string | null;
}

export interface GraphRunListEntry {
  runs: GraphRunSummary[];
  status: GraphRunLoadStatus;
  error: string | null;
}

export interface GraphRunTranscriptEntry {
  view: GraphRunTranscriptView | null;
  status: GraphRunLoadStatus;
  error: string | null;
  /** The stored transcript's display revision the view was read for. */
  revision: number | null;
}

export interface GraphRunArtifactEntry {
  view: GraphRunArtifactView | null;
  status: GraphRunLoadStatus;
  error: string | null;
}

export const MAX_CACHED_ARTIFACTS = 200;
export const MAX_CACHED_TRANSCRIPTS = 32;

interface GraphRunState {
  runs: Map<string, GraphRunEntry>;
  lists: Map<string, GraphRunListEntry>;
  transcripts: Map<string, GraphRunTranscriptEntry>;
  artifacts: Map<string, GraphRunArtifactEntry>;
  /** Re-reads a run; applies the snapshot only when it is newer. */
  loadRun: (runId: string) => Promise<void>;
  /** Applies a snapshot an action returned (newer revisions only). */
  applyRun: (run: GraphRun) => void;
  loadList: (environmentId: string) => Promise<void>;
  /** Reads an activation's transcript for `revision`; a no-op when that revision is held. */
  loadTranscript: (runId: string, activationKey: string, revision: number | null) => Promise<void>;
  loadArtifact: (runId: string, artifactId: string, options?: { force?: boolean }) => Promise<void>;
}

export const EMPTY_GRAPH_RUN: GraphRunEntry = { run: null, status: "idle", error: null };
export const EMPTY_GRAPH_RUN_LIST: GraphRunListEntry = { runs: [], status: "idle", error: null };

export function graphRunCacheKey(runId: string, id: string): string {
  return `${runId}\u0000${id}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The backend refuses an unknown run with `not-found` (the gateway may drop the code). */
export function isGraphRunNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "not-found") return true;
  return /graph run does not exist/i.test(errorText(error));
}

/** Map with `key` set last (newest), dropping the oldest entries past `max`. */
function boundedSet<V>(map: Map<string, V>, key: string, value: V, max: number): Map<string, V> {
  const next = new Map(map);
  next.delete(key);
  next.set(key, value);
  while (next.size > max) next.delete(next.keys().next().value!);
  return next;
}

/** In-flight reads per run, so a burst of change events costs one read at a time. */
const inFlight = new Map<string, { promise: Promise<void>; again: boolean }>();

export const useGraphRunStore = create<GraphRunState>()((set, get) => {
  const setRun = (runId: string, patch: Partial<GraphRunEntry>) =>
    set((state) => {
      const runs = new Map(state.runs);
      runs.set(runId, { ...(state.runs.get(runId) ?? EMPTY_GRAPH_RUN), ...patch });
      return { runs };
    });

  const readRun = async (runId: string): Promise<void> => {
    const held = get().runs.get(runId);
    if (!held?.run) setRun(runId, { status: held?.status === "ready" ? "ready" : "loading" });
    try {
      const result = await getGraphRun(runId, held?.run?.revision);
      if (result.status === "unchanged") {
        setRun(runId, { status: "ready", error: null });
        return;
      }
      get().applyRun(result.run);
    } catch (error) {
      if (isGraphRunNotFound(error)) {
        setRun(runId, { run: null, status: "missing", error: null });
        return;
      }
      // A failed refresh keeps the last snapshot on screen.
      setRun(runId, {
        status: get().runs.get(runId)?.run ? "ready" : "error",
        error: errorText(error),
      });
    }
  };

  return {
    runs: new Map(),
    lists: new Map(),
    transcripts: new Map(),
    artifacts: new Map(),

    loadRun: (runId) => {
      const current = inFlight.get(runId);
      if (current) {
        // Changes that land during a read are covered by one more read after it.
        current.again = true;
        return current.promise;
      }
      const entry = { promise: Promise.resolve(), again: false };
      entry.promise = (async () => {
        try {
          do {
            entry.again = false;
            await readRun(runId);
          } while (entry.again);
        } finally {
          inFlight.delete(runId);
        }
      })();
      inFlight.set(runId, entry);
      return entry.promise;
    },

    applyRun: (run) => {
      const held = get().runs.get(run.id)?.run;
      if (held && held.revision > run.revision) return;
      setRun(run.id, { run, status: "ready", error: null });
      // Keep a list that shows this run current without a second read.
      set((state) => {
        let changed = false;
        const lists = new Map(state.lists);
        for (const [environmentId, list] of state.lists) {
          const index = list.runs.findIndex((summary) => summary.id === run.id);
          if (index < 0) continue;
          const summary = list.runs[index]!;
          if (summary.revision >= run.revision) continue;
          const runs = [...list.runs];
          runs[index] = {
            ...summary,
            status: run.status,
            revision: run.revision,
            updatedAt: run.updatedAt,
            ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
            ...(run.error !== undefined ? { error: run.error } : {}),
            usage: { ...run.usage },
          };
          lists.set(environmentId, { ...list, runs });
          changed = true;
        }
        return changed ? { lists } : {};
      });
    },

    loadList: async (environmentId) => {
      const held = get().lists.get(environmentId) ?? EMPTY_GRAPH_RUN_LIST;
      set((state) => {
        const lists = new Map(state.lists);
        lists.set(environmentId, {
          ...held,
          status: held.status === "ready" ? "ready" : "loading",
        });
        return { lists };
      });
      try {
        const runs = await listGraphRuns(environmentId);
        set((state) => {
          const lists = new Map(state.lists);
          lists.set(environmentId, { runs, status: "ready", error: null });
          return { lists };
        });
      } catch (error) {
        set((state) => {
          const lists = new Map(state.lists);
          const previous = state.lists.get(environmentId) ?? EMPTY_GRAPH_RUN_LIST;
          lists.set(environmentId, {
            ...previous,
            status: previous.runs.length > 0 ? "ready" : "error",
            error: errorText(error),
          });
          return { lists };
        });
      }
    },

    loadTranscript: async (runId, activationKey, revision) => {
      const key = graphRunCacheKey(runId, activationKey);
      const held = get().transcripts.get(key);
      if (
        held &&
        held.revision === revision &&
        (held.status === "ready" || held.status === "loading")
      ) {
        return;
      }
      set((state) => ({
        transcripts: boundedSet(
          state.transcripts,
          key,
          { view: held?.view ?? null, status: "loading", error: null, revision },
          MAX_CACHED_TRANSCRIPTS,
        ),
      }));
      try {
        const view = await getGraphRunTranscript(runId, activationKey);
        set((state) => {
          // A newer revision was asked for meanwhile: that read owns the entry.
          if (state.transcripts.get(key)?.revision !== revision) return {};
          return {
            transcripts: boundedSet(
              state.transcripts,
              key,
              { view, status: "ready", error: null, revision },
              MAX_CACHED_TRANSCRIPTS,
            ),
          };
        });
      } catch (error) {
        set((state) => {
          if (state.transcripts.get(key)?.revision !== revision) return {};
          return {
            transcripts: boundedSet(
              state.transcripts,
              key,
              { view: held?.view ?? null, status: "error", error: errorText(error), revision },
              MAX_CACHED_TRANSCRIPTS,
            ),
          };
        });
      }
    },

    loadArtifact: async (runId, artifactId, options = {}) => {
      const key = graphRunCacheKey(runId, artifactId);
      const held = get().artifacts.get(key);
      if (!options.force && held && (held.status === "ready" || held.status === "loading")) return;
      set((state) => ({
        artifacts: boundedSet(
          state.artifacts,
          key,
          { view: held?.view ?? null, status: "loading", error: null },
          MAX_CACHED_ARTIFACTS,
        ),
      }));
      try {
        const view = await getGraphRunArtifact(runId, artifactId);
        set((state) => ({
          artifacts: boundedSet(
            state.artifacts,
            key,
            { view, status: "ready", error: null },
            MAX_CACHED_ARTIFACTS,
          ),
        }));
      } catch (error) {
        set((state) => ({
          artifacts: boundedSet(
            state.artifacts,
            key,
            {
              view: held?.view ?? null,
              status: isGraphRunNotFound(error) ? "missing" : "error",
              error: errorText(error),
            },
            MAX_CACHED_ARTIFACTS,
          ),
        }));
      }
    },
  };
});
