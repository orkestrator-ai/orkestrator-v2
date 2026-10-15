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
   * Applies a snapshot unless it is older than what we hold. Revisions only
   * order snapshots of one backend process (`generation`); a snapshot from
   * another process (a restart) always applies. An authoritative read also
   * replaces a snapshot of the same revision, an event does not.
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
    if (current?.generation !== undefined && current.generation === snapshot.generation) {
      const older = authoritative
        ? snapshot.revision < current.revision
        : snapshot.revision <= current.revision;
      if (older) return "stale";
    }
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
