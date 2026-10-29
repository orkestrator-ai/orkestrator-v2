import { create } from "zustand";
import type {
  GraphDescribeJobView,
  GraphDescribeStartInput,
} from "@orkestrator/protocol/graphs/describe";
import {
  cancelGraphDescribe,
  dismissGraphDescribe,
  getGraphDescribeStatus,
  startGraphDescribe,
} from "@/lib/backend/graph-describe";

/**
 * "Describe a graph" jobs (item 215), one per environment. The backend owns
 * each job; this store only mirrors its latest snapshot, re-read when the
 * designer mounts, on `graph-describe` change hints and on view safety checks
 * (root `AGENTS.md`, invariants 1-3). Switching tabs or reloading loses
 * nothing: the next read shows the job where the backend has it.
 */

export interface GraphDescribeEntry {
  /** The backend's latest job for the environment; null when it has none. */
  job: GraphDescribeJobView | null;
  loaded: boolean;
  /** The last read or command that failed. */
  error: string | null;
  busy: "start" | "cancel" | "dismiss" | null;
  /** Read sequence: a response for an older read is dropped. */
  request: number;
}

export const EMPTY_GRAPH_DESCRIBE_ENTRY: GraphDescribeEntry = Object.freeze({
  job: null,
  loaded: false,
  error: null,
  busy: null,
  request: 0,
});

interface GraphDescribeState {
  entries: Map<string, GraphDescribeEntry>;
  refresh: (environmentId: string) => Promise<void>;
  /** Starts a job; rejects with the backend's reason (also kept in `error`). */
  start: (input: GraphDescribeStartInput) => Promise<GraphDescribeJobView>;
  cancel: (environmentId: string) => Promise<void>;
  /** Forgets a finished job (after its draft was opened, or on Dismiss). */
  dismiss: (environmentId: string, jobId: string) => Promise<void>;
  clearError: (environmentId: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useGraphDescribeStore = create<GraphDescribeState>()((set, get) => {
  const entry = (environmentId: string) =>
    get().entries.get(environmentId) ?? EMPTY_GRAPH_DESCRIBE_ENTRY;
  const patch = (environmentId: string, next: Partial<GraphDescribeEntry>) =>
    set((state) => {
      const entries = new Map(state.entries);
      entries.set(environmentId, { ...entry(environmentId), ...next });
      return { entries };
    });

  return {
    entries: new Map(),

    refresh: async (environmentId) => {
      const request = entry(environmentId).request + 1;
      patch(environmentId, { request });
      try {
        const job = await getGraphDescribeStatus(environmentId);
        if (entry(environmentId).request !== request) return;
        patch(environmentId, { job, loaded: true });
      } catch (error) {
        if (entry(environmentId).request !== request) return;
        patch(environmentId, { loaded: true, error: errorText(error) });
      }
    },

    start: async (input) => {
      const environmentId = input.environmentId;
      patch(environmentId, { busy: "start", error: null });
      try {
        const job = await startGraphDescribe(input);
        // Supersedes any read still in flight.
        patch(environmentId, {
          job,
          loaded: true,
          busy: null,
          request: entry(environmentId).request + 1,
        });
        return job;
      } catch (error) {
        patch(environmentId, { busy: null, error: errorText(error) });
        throw error;
      }
    },

    cancel: async (environmentId) => {
      patch(environmentId, { busy: "cancel", error: null });
      try {
        const job = await cancelGraphDescribe(environmentId);
        patch(environmentId, { job, busy: null, request: entry(environmentId).request + 1 });
      } catch (error) {
        patch(environmentId, { busy: null, error: errorText(error) });
      }
    },

    dismiss: async (environmentId, jobId) => {
      patch(environmentId, { busy: "dismiss", error: null });
      try {
        await dismissGraphDescribe(environmentId, jobId);
        const current = entry(environmentId).job;
        patch(environmentId, {
          job: current?.id === jobId ? null : current,
          busy: null,
          request: entry(environmentId).request + 1,
        });
      } catch (error) {
        patch(environmentId, { busy: null, error: errorText(error) });
      }
    },

    clearError: (environmentId) => patch(environmentId, { error: null }),
  };
});
