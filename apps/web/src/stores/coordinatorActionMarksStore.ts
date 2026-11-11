import { useCallback, useEffect, useMemo } from "react";
import {
  COORDINATOR_ACTION_MARK_LIMITS,
  type CoordinatorActionMarks,
} from "@orkestrator/protocol/coordinator-action-marks";
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
  /**
   * What the panel shows: the newest confirmed backend marks with this
   * client's unanswered changes laid over them.
   */
  cardIds: readonly string[];
  /** The backend revision of the confirmed marks under `cardIds`. */
  revision: number;
  status: CoordinatorActionMarksStatus;
}

export interface CoordinatorActionMarksState {
  /** Keyed by {@link coordinatorActionMarksKey}. */
  entries: Record<string, CoordinatorActionMarksEntry>;
  /** Reads a conversation's marks; called when its Actions panel mounts. */
  hydrate: (projectId: string, conversationId: string) => Promise<void>;
  /**
   * Applies a mark at once and saves it. Rejects when the backend refused it
   * or could not be reached; the change is then dropped and the stored marks
   * read again.
   *
   * `reclaimable` names marked cards the transcript has since finished: their
   * marks change nothing on screen. When the conversation is at its mark limit,
   * some of them are cleared first so a new mark still fits.
   */
  setMark: (
    projectId: string,
    conversationId: string,
    cardId: string,
    done: boolean,
    reclaimable?: readonly string[],
  ) => Promise<void>;
  /** Stops subscriptions and forgets every conversation; scope dispose and tests. */
  reset: () => void;
}

export function coordinatorActionMarksKey(projectId: string, conversationId: string): string {
  return `${projectId}\u0000${conversationId}`;
}

/** Redundant marks cleared at once when a conversation is full. */
export const COORDINATOR_ACTION_MARK_RECLAIM_BATCH = 25;

function marksApi(scope: NodeScope) {
  return createCoordinatorApi(scopeBackendClient(scope));
}

interface ConfirmedMarks {
  cardIds: readonly string[];
  revision: number;
}

/** A change this client sent and has not had answered; `seq` names the latest send. */
interface PendingMark {
  done: boolean;
  seq: number;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Coordinator action cards marked done by hand, per conversation and per
 * node, mirrored from the backend (`get/set_coordinator_action_mark(s)`), so
 * every window and client showing a conversation agrees.
 *
 * Two layers are kept apart. `confirmed` is the newest snapshot the backend
 * gave (from a read or a save's answer, whichever has the higher revision);
 * `pending` holds this client's unanswered changes, one per card. What the
 * panel shows is `pending` laid over `confirmed`, so a snapshot that arrives
 * during a save is kept rather than dropped, answers that arrive out of order
 * cannot roll a mark back, and a save that fails simply drops its change:
 * nothing unconfirmed outlives its own request.
 *
 * Changes from other clients arrive as `coordinator-action-marks` hints and
 * through the resync and periodic safety check, which also read again a
 * conversation whose first read failed.
 */
export const coordinatorActionMarksStore = defineScopedStore<CoordinatorActionMarksState>(
  "coordinator-action-marks",
  (scope) => (set, get) => {
    let stopSubscriptions: Array<() => void> | null = null;
    const hydrating = new Map<string, Promise<void>>();
    const confirmed = new Map<string, ConfirmedMarks>();
    const pending = new Map<string, Map<string, PendingMark>>();
    let sequence = 0;
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

    /** Publishes `pending` over `confirmed`; keeps `cardIds` when nothing moved. */
    const render = (key: string) => {
      const base = confirmed.get(key);
      if (!base) return;
      const local = pending.get(key);
      let cardIds: readonly string[] = base.cardIds;
      if (local?.size) {
        const shown = base.cardIds.filter((id) => local.get(id)?.done !== false);
        for (const [id, mark] of local) if (mark.done && !shown.includes(id)) shown.push(id);
        cardIds = shown;
      }
      const current = get().entries[key];
      if (
        current?.status === "ready" &&
        current.revision === base.revision &&
        sameIds(current.cardIds, cardIds)
      ) {
        return;
      }
      patch(key, {
        cardIds:
          current && sameIds(current.cardIds, cardIds) ? current.cardIds : Array.from(cardIds),
        revision: base.revision,
        status: "ready",
      });
    };

    /** Keeps the newer of the held and the answered snapshot. */
    const adopt = (key: string, marks: CoordinatorActionMarks) => {
      const held = confirmed.get(key);
      if (!held || marks.revision >= held.revision) {
        confirmed.set(key, { cardIds: marks.cardIds, revision: marks.revision });
      }
      render(key);
    };

    const refresh = async (key: string) => {
      const target = scopes.get(key);
      if (!target) return;
      const started = generation;
      try {
        const marks = await marksApi(scope).getCoordinatorActionMarks(
          target.projectId,
          target.conversationId,
        );
        if (!live(started)) return;
        if (marks) adopt(key, marks);
        else if (!confirmed.has(key)) patch(key, { status: "unavailable" });
      } catch {
        // Kept as it was; the next hint or resync reads again.
        if (live(started) && !confirmed.has(key)) patch(key, { status: "unavailable" });
      }
    };

    const reconcileAll = async () => {
      await Promise.all(Array.from(scopes.keys()).map((key) => refresh(key)));
    };

    /** Sends one change; resolves with the failure, if any, once it is settled here. */
    const save = async (
      key: string,
      projectId: string,
      conversationId: string,
      cardId: string,
      done: boolean,
    ): Promise<unknown> => {
      const seq = (sequence += 1);
      const local = pending.get(key) ?? new Map<string, PendingMark>();
      pending.set(key, local);
      local.set(cardId, { done, seq });
      render(key);
      const started = generation;
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
      if (!live(started)) return failure;
      // A later change to the same card stays in front until its own answer.
      if (pending.get(key)?.get(cardId)?.seq === seq) {
        local.delete(cardId);
        if (local.size === 0 && pending.get(key) === local) pending.delete(key);
      }
      if (answer) {
        adopt(key, answer);
        return null;
      }
      // Refused, unreachable or unreadable: the change is gone from the view
      // at once, and whatever the backend did keep is read again.
      render(key);
      await refresh(key);
      return failure ?? new Error("Could not save the mark");
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
      setMark: async (projectId, conversationId, cardId, done, reclaimable = []) => {
        const key = coordinatorActionMarksKey(projectId, conversationId);
        const current = get().entries[key];
        if (current?.status !== "ready") throw new Error("Action marks are not available");
        if (current.cardIds.includes(cardId) === done) return;
        if (done && current.cardIds.length >= COORDINATOR_ACTION_MARK_LIMITS.marksPerConversation) {
          // Oldest first, as stored. Only marks that change nothing on screen
          // are cleared, so no card the user marked reopens.
          const redundant = new Set(reclaimable);
          const release = current.cardIds
            .filter((id) => id !== cardId && redundant.has(id))
            .slice(0, COORDINATOR_ACTION_MARK_RECLAIM_BATCH);
          await Promise.all(release.map((id) => save(key, projectId, conversationId, id, false)));
        }
        const failure = await save(key, projectId, conversationId, cardId, done);
        if (failure) {
          throw failure instanceof Error ? failure : new Error("Could not save the mark");
        }
      },
      reset: () => {
        unsubscribe();
        hydrating.clear();
        confirmed.clear();
        pending.clear();
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
  /** See {@link CoordinatorActionMarksState.setMark} for `reclaimable`. */
  setMark: (cardId: string, done: boolean, reclaimable?: readonly string[]) => Promise<void>;
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
    (cardId: string, done: boolean, reclaimable?: readonly string[]) => {
      if (!projectId || !conversationId) {
        return Promise.reject(new Error("Not a coordinator conversation"));
      }
      return scope
        .store(coordinatorActionMarksStore)
        .getState()
        .setMark(projectId, conversationId, cardId, done, reclaimable);
    },
    [scope, projectId, conversationId],
  );
  return { available: entry?.status === "ready", marked, setMark };
}
