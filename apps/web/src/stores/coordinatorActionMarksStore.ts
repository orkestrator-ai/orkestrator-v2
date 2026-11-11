import { useCallback, useEffect, useMemo } from "react";
import type { CoordinatorActionMarks } from "@orkestrator/protocol/coordinator-action-marks";
import { scopeBackendClient } from "@/lib/backend/client";
import { createCoordinatorApi } from "@/lib/backend/coordinator";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useNodeScope } from "@/lib/node-scope/providers";
import { defineScopedStore, scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";

/**
 * `loading` until the first read answers; `unavailable` when it failed (an
 * older backend without the commands, or a node that cannot be reached), in
 * which case the Actions panel offers no menu. Resyncs read it again.
 */
export type CoordinatorActionMarksStatus = "loading" | "ready" | "unavailable";

export interface CoordinatorActionMarksEntry {
  cardIds: readonly string[];
  /** The backend revision `cardIds` was read at; a local change waits on its answer. */
  revision: number;
  status: CoordinatorActionMarksStatus;
}

export interface CoordinatorActionMarksState {
  /** Keyed by {@link coordinatorActionMarksKey}. */
  entries: Record<string, CoordinatorActionMarksEntry>;
  /** Reads a conversation's marks; called when its Actions panel mounts. */
  hydrate: (projectId: string, conversationId: string) => Promise<void>;
  /**
   * Applies a mark at once and saves it. Rejects when the backend refused it,
   * after the stored marks have been read again.
   */
  setMark: (
    projectId: string,
    conversationId: string,
    cardId: string,
    done: boolean,
  ) => Promise<void>;
  /** Stops subscriptions and forgets every conversation; scope dispose and tests. */
  reset: () => void;
}

export function coordinatorActionMarksKey(projectId: string, conversationId: string): string {
  return `${projectId}\u0000${conversationId}`;
}

function marksApi(scope: NodeScope) {
  return createCoordinatorApi(scopeBackendClient(scope));
}

/**
 * Coordinator action cards marked done by hand, per conversation and per
 * node, mirrored from the backend (`get/set_coordinator_action_mark(s)`), so
 * every window and client showing a conversation agrees.
 *
 * A mark applies here at once and is saved in the background; while a save is
 * out, reads do not overwrite it. Changes from other clients arrive as
 * `coordinator-action-marks` hints and through the resync and periodic safety
 * check, which also read again a conversation whose first read failed.
 */
export const coordinatorActionMarksStore = defineScopedStore<CoordinatorActionMarksState>(
  "coordinator-action-marks",
  (scope) => (set, get) => {
    let stopSubscriptions: Array<() => void> | null = null;
    const hydrating = new Map<string, Promise<void>>();
    /** Local saves not yet answered, per conversation. */
    const inFlight = new Map<string, number>();
    const scopes = new Map<string, { projectId: string; conversationId: string }>();
    /** Bumped by `reset` and dispose, so a late answer writes nothing. */
    let generation = 0;
    let disposed = false;
    const live = (started: number) => !disposed && started === generation;

    const patch = (key: string, next: Partial<CoordinatorActionMarksEntry>) =>
      set((state) => {
        const current = state.entries[key] ?? { cardIds: [], revision: 0, status: "loading" };
        return { entries: { ...state.entries, [key]: { ...current, ...next } } };
      });

    /** `force`: replace a local change the backend did not take, whatever its revision. */
    const adopt = (key: string, marks: CoordinatorActionMarks, force = false) => {
      if ((inFlight.get(key) ?? 0) > 0) return;
      const current = get().entries[key];
      if (!force && current?.status === "ready" && marks.revision <= current.revision) return;
      patch(key, { cardIds: marks.cardIds, revision: marks.revision, status: "ready" });
    };

    const refresh = async (key: string, force = false) => {
      const target = scopes.get(key);
      if (!target) return;
      const started = generation;
      try {
        const marks = await marksApi(scope).getCoordinatorActionMarks(
          target.projectId,
          target.conversationId,
        );
        if (!live(started)) return;
        if (marks) adopt(key, marks, force);
        else if (get().entries[key]?.status !== "ready") patch(key, { status: "unavailable" });
      } catch {
        // Kept as it was; the next hint or resync reads again.
        if (live(started) && get().entries[key]?.status !== "ready") {
          patch(key, { status: "unavailable" });
        }
      }
    };

    const reconcileAll = async () => {
      await Promise.all(Array.from(scopes.keys()).map((key) => refresh(key)));
    };

    const subscribe = () => {
      if (stopSubscriptions) return;
      stopSubscriptions = [
        onResourceChanged(
          "coordinator-action-marks",
          (change) => {
            if (!change.projectId) return;
            const key = coordinatorActionMarksKey(change.projectId, change.id);
            if (scopes.has(key)) void refresh(key);
          },
          scope,
        ),
        // Not in the durable manifest, so both recovery paths apply.
        onResourceResync(reconcileAll, scope),
        onViewSafetyCheck(reconcileAll, scope),
      ];
    };
    const unsubscribe = () => {
      generation += 1;
      for (const stop of stopSubscriptions ?? []) stop();
      stopSubscriptions = null;
    };
    scope.onDispose("coordinator-action-marks", () => {
      disposed = true;
      unsubscribe();
    });

    return {
      entries: {},
      hydrate: (projectId, conversationId) => {
        if (disposed) return Promise.resolve();
        const key = coordinatorActionMarksKey(projectId, conversationId);
        const running = hydrating.get(key);
        if (running) return running;
        scopes.set(key, { projectId, conversationId });
        if (!get().entries[key]) patch(key, {});
        subscribe();
        const read: Promise<void> = refresh(key).finally(() => {
          if (hydrating.get(key) === read) hydrating.delete(key);
        });
        hydrating.set(key, read);
        return read;
      },
      setMark: async (projectId, conversationId, cardId, done) => {
        const key = coordinatorActionMarksKey(projectId, conversationId);
        const current = get().entries[key];
        if (current?.status !== "ready") throw new Error("Action marks are not available");
        const has = current.cardIds.includes(cardId);
        if (has === done) return;
        patch(key, {
          cardIds: done
            ? [...current.cardIds, cardId]
            : current.cardIds.filter((id) => id !== cardId),
        });
        const started = generation;
        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
        let answer: CoordinatorActionMarks | null = null;
        let failure: unknown = null;
        try {
          answer = await marksApi(scope).setCoordinatorActionMark(
            projectId,
            conversationId,
            cardId,
            done,
          );
        } catch (error) {
          failure = error;
        }
        if (!live(started)) return;
        const remaining = (inFlight.get(key) ?? 1) - 1;
        if (remaining > 0) inFlight.set(key, remaining);
        else inFlight.delete(key);
        if (remaining === 0) {
          const held = get().entries[key];
          if (answer && answer.revision >= (held?.revision ?? 0)) {
            patch(key, { cardIds: answer.cardIds, revision: answer.revision, status: "ready" });
          } else {
            // Refused, or no readable answer: the stored marks replace the
            // local change.
            await refresh(key, true);
          }
        }
        if (failure)
          throw failure instanceof Error ? failure : new Error("Could not save the mark");
      },
      reset: () => {
        unsubscribe();
        hydrating.clear();
        inFlight.clear();
        scopes.clear();
        set({ entries: {} });
      },
    };
  },
);

/**
 * Reads the nearest node scope's marks; other code uses
 * `scope.store(coordinatorActionMarksStore)`.
 */
export const useCoordinatorActionMarksStore = scopedStoreHook(coordinatorActionMarksStore);

const NO_MARKS: ReadonlySet<string> = new Set();

export interface CoordinatorActionMarksBinding {
  /** Whether marks can be read and changed for this conversation. */
  available: boolean;
  marked: ReadonlySet<string>;
  setMark: (cardId: string, done: boolean) => Promise<void>;
}

/**
 * One conversation's marks in the nearest node scope, read when the caller
 * mounts. Without both ids (not a coordinator conversation) it is unavailable.
 */
export function useCoordinatorActionMarks(
  projectId: string | undefined,
  conversationId: string | undefined,
): CoordinatorActionMarksBinding {
  const scope = useNodeScope();
  const key =
    projectId && conversationId ? coordinatorActionMarksKey(projectId, conversationId) : "";
  const entry = useCoordinatorActionMarksStore((state) => (key ? state.entries[key] : undefined));
  useEffect(() => {
    if (!projectId || !conversationId) return;
    void scope.store(coordinatorActionMarksStore).getState().hydrate(projectId, conversationId);
  }, [scope, projectId, conversationId]);
  const cardIds = entry?.cardIds;
  const marked = useMemo(() => (cardIds?.length ? new Set(cardIds) : NO_MARKS), [cardIds]);
  const setMark = useCallback(
    (cardId: string, done: boolean) => {
      if (!projectId || !conversationId) {
        return Promise.reject(new Error("Not a coordinator conversation"));
      }
      return scope
        .store(coordinatorActionMarksStore)
        .getState()
        .setMark(projectId, conversationId, cardId, done);
    },
    [scope, projectId, conversationId],
  );
  return { available: entry?.status === "ready", marked, setMark };
}
