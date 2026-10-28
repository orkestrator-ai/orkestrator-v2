import { create } from "zustand";
import { persist } from "zustand/middleware";
import { desktopConnectionStorageKey } from "@/lib/desktop-storage-key";
import type { DeclinedUpstreamMerge } from "@/lib/coordinator-upstream-merge";

/** Projects whose declined upstream merge is remembered (least recently answered dropped first). */
export const MAX_REMEMBERED_UPSTREAM_DECLINES = 50;

interface RememberedDecline extends DeclinedUpstreamMerge {
  projectId: string;
}

interface CoordinatorUpstreamDeclineState {
  declines: RememberedDecline[];
  decline: (projectId: string, decline: DeclinedUpstreamMerge) => void;
}

/**
 * Durable renderer preference: the upstream tip the user last chose not to
 * merge before messaging a project's coordinator. It survives a reload so the
 * same question is not asked again for the same commits, and the storage key is
 * per machine, so a node's project is never answered for by another's.
 */
export const useCoordinatorUpstreamDeclineStore = create<CoordinatorUpstreamDeclineState>()(
  persist(
    (set) => ({
      declines: [],
      decline: (projectId, { upstream, upstreamCommit }) =>
        set((state) => ({
          declines: [
            ...state.declines
              .filter((entry) => entry.projectId !== projectId)
              .slice(-(MAX_REMEMBERED_UPSTREAM_DECLINES - 1)),
            { projectId, upstream, upstreamCommit },
          ],
        })),
    }),
    {
      name: desktopConnectionStorageKey("coordinator-upstream-declines"),
      partialize: (state) => ({ declines: state.declines }),
      merge: (persisted, current) => {
        const raw = (persisted as { declines?: unknown } | undefined)?.declines;
        const isId = (value: unknown, max: number): value is string =>
          typeof value === "string" && value.length > 0 && value.length <= max;
        const declines = Array.isArray(raw)
          ? raw.slice(-MAX_REMEMBERED_UPSTREAM_DECLINES).flatMap((entry): RememberedDecline[] => {
              if (!entry || typeof entry !== "object") return [];
              const record = entry as Record<string, unknown>;
              if (
                !isId(record.projectId, 200) ||
                !isId(record.upstream, 1024) ||
                !isId(record.upstreamCommit, 128)
              )
                return [];
              return [
                {
                  projectId: record.projectId,
                  upstream: record.upstream,
                  upstreamCommit: record.upstreamCommit,
                },
              ];
            })
          : [];
        return {
          ...current,
          declines: declines.filter(
            (entry, index) =>
              declines.findLastIndex((candidate) => candidate.projectId === entry.projectId) ===
              index,
          ),
        };
      },
    },
  ),
);

export function selectDeclinedUpstreamMerge(projectId: string) {
  return (state: CoordinatorUpstreamDeclineState): DeclinedUpstreamMerge | undefined =>
    state.declines.find((entry) => entry.projectId === projectId);
}
