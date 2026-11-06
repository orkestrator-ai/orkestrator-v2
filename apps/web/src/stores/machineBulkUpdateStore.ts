import { create } from "zustand";

/** Where "Update app to latest" got to on one machine. */
export type BulkUpdateOutcome =
  | { state: "checking" }
  /** The host accepted an update job; its snapshot reports the rest. */
  | { state: "requested"; version: string | null }
  | { state: "current"; version: string }
  /** An update was already running there. */
  | { state: "busy" }
  | { state: "skipped"; reason: string }
  | { state: "failed"; error: string };

interface MachineBulkUpdateState {
  /** Keyed by machine list key. */
  outcomes: Record<string, BulkUpdateOutcome>;
  running: boolean;
  start: (keys: string[]) => void;
  report: (key: string, outcome: BulkUpdateOutcome) => void;
  finish: () => void;
}

/**
 * The bulk update outlives the Machines page: the requests keep going when
 * Settings closes, and the rows show where each machine got to when it
 * opens again. Once a host accepts a job, its own maintenance snapshot is
 * the authority on progress.
 */
export const useMachineBulkUpdateStore = create<MachineBulkUpdateState>((set) => ({
  outcomes: {},
  running: false,
  start: (keys) =>
    set({
      running: true,
      outcomes: Object.fromEntries(keys.map((key) => [key, { state: "checking" } as const])),
    }),
  report: (key, outcome) => set((state) => ({ outcomes: { ...state.outcomes, [key]: outcome } })),
  finish: () => set({ running: false }),
}));
