import { create } from "zustand";
import type { UpdateStatusSnapshot } from "@orkestrator/protocol/updates";

/** One update target: this app ("local") or a remote connection, by id. */
export type UpdateTargetState = {
  snapshot: UpdateStatusSnapshot | null;
  error: { code: string; message: string } | null;
  /** A command is in flight; buttons stay disabled. */
  busy: boolean;
};

const EMPTY: UpdateTargetState = { snapshot: null, error: null, busy: false };

type UpdateStore = {
  targets: Map<string, UpdateTargetState>;
  /** The local update dialog (title-bar indicator, menu, toast). */
  dialogOpen: boolean;
  setDialogOpen(open: boolean): void;
  /**
   * An event snapshot applies only when it is newer than what we hold; an
   * authoritative read always replaces it. A restarted backend counts
   * revisions from zero again, so a stale-looking event asks the caller to
   * re-read instead of being trusted or silently dropped.
   */
  applySnapshot(
    key: string,
    snapshot: UpdateStatusSnapshot,
    authoritative: boolean,
  ): "applied" | "stale";
  setError(key: string, error: UpdateTargetState["error"]): void;
  setBusy(key: string, busy: boolean): void;
  forget(key: string): void;
};

function update(
  targets: Map<string, UpdateTargetState>,
  key: string,
  patch: Partial<UpdateTargetState>,
): Map<string, UpdateTargetState> {
  const next = new Map(targets);
  next.set(key, { ...(targets.get(key) ?? EMPTY), ...patch });
  return next;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  targets: new Map(),
  dialogOpen: false,
  setDialogOpen: (open) => set({ dialogOpen: open }),
  applySnapshot(key, snapshot, authoritative) {
    const current = get().targets.get(key)?.snapshot;
    if (!authoritative && current && snapshot.revision <= current.revision) return "stale";
    set((state) => ({ targets: update(state.targets, key, { snapshot, error: null }) }));
    return "applied";
  },
  setError: (key, error) => set((state) => ({ targets: update(state.targets, key, { error }) })),
  setBusy: (key, busy) => set((state) => ({ targets: update(state.targets, key, { busy }) })),
  forget: (key) =>
    set((state) => {
      const next = new Map(state.targets);
      next.delete(key);
      return { targets: next };
    }),
}));

export function selectUpdateTarget(key: string) {
  return (state: UpdateStore): UpdateTargetState => state.targets.get(key) ?? EMPTY;
}
