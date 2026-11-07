import { useEffect, useMemo, useState } from "react";
import {
  coordinatorIdFromRuntimeId,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import type { CoordinatorCheckoutTurn } from "@orkestrator/protocol/coordinator-activity";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import {
  activeCoordinatorTurnLabel,
  PROJECT_HOME_TURN_LABEL,
  projectHomeEnvironmentIds,
} from "@/lib/coordinator-active-turn";
import { subscribeNativeObservationInvalidations } from "@/lib/native-observation-events";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/** Re-read while a turn holds the checkout, so a hint that never came cannot hold the controls. */
export const CHECKOUT_TURN_BUSY_POLL_MS = 30_000;

const NO_ENVIRONMENTS: ReadonlySet<string> = new Set();

function sameCheckoutTurn(a: CoordinatorCheckoutTurn | null, b: CoordinatorCheckoutTurn | null) {
  if (a?.kind !== b?.kind) return false;
  return a?.kind !== "conversation" || a.conversationId === (b as typeof a).conversationId;
}

function checkoutTurnLabel(
  turn: CoordinatorCheckoutTurn,
  workspace: CoordinatorWorkspace | undefined,
): string {
  if (turn.kind === "project-home") return PROJECT_HOME_TURN_LABEL;
  return (
    workspace?.conversations.find((item) => item.id === turn.conversationId)?.title ??
    "Another conversation"
  );
}

/**
 * Who is holding the project's checkout with a running turn, by name, or null:
 * what the backend refuses a branch switch or sync over, read early so the
 * controls can say so instead of the backend refusing after the user confirms.
 *
 * Only the front tab of each group is mounted, and only a mounted tab keeps its
 * projection current, so projections alone would miss a turn a behind tab started
 * and would hold the controls for ever over one that finished there. So the
 * backend answers for everything, and the mounted conversations' projections add
 * what it has not observed yet. A backend without the command, or one that has
 * not answered, leaves only the projections.
 */
export function useCoordinatorActiveTurn(
  projectId: string,
  workspace: CoordinatorWorkspace | undefined,
  mountedConversationIds: ReadonlySet<string>,
): string | null {
  const nodeBackend = useScopeBackend();
  const [answer, setAnswer] = useState<{
    projectId: string;
    turn: CoordinatorCheckoutTurn | null;
  } | null>(null);
  const current = answer?.projectId === projectId ? answer : null;
  const read = useCoordinatedRead<CoordinatorCheckoutTurn | null>({
    key: { resource: "coordinator-checkout-turn", target: projectId },
    // Rehydrates on every mount. A retained answer counts as fresh for as long as
    // nothing polls, and a turn that started while the panel was away sends no
    // further hint, so it would stay unseen for the whole turn.
    retainOnDispose: false,
    demand: {
      intervalMs: current?.turn ? CHECKOUT_TURN_BUSY_POLL_MS : null,
      priority: "auxiliary",
    },
    read: () => nodeBackend.getCoordinatorCheckoutTurn(projectId),
    onState: (state) => {
      if (state.status === "unsupported") setAnswer(null);
      if (state.status !== "current") return;
      const turn = state.value ?? null;
      // Most reads answer what the last one did; those cost the panel no render.
      setAnswer((held) =>
        held?.projectId === projectId && sameCheckoutTurn(held.turn, turn)
          ? held
          : { projectId, turn },
      );
    },
  });

  // Selected as a key, so a write to any other environment renders nothing here.
  const homeKey = useEnvironmentStore((state) =>
    Array.from(projectHomeEnvironmentIds(state.environments, projectId)).sort().join("\u0000"),
  );
  const homeIds = useMemo<ReadonlySet<string>>(
    () => (homeKey ? new Set(homeKey.split("\u0000")) : NO_ENVIRONMENTS),
    [homeKey],
  );
  const workspaceId = workspace?.id;
  const invalidate = read.invalidate;
  useEffect(() => {
    const concerned = (environmentId: string) =>
      homeIds.has(environmentId) ||
      (workspaceId !== undefined && coordinatorIdFromRuntimeId(environmentId) === workspaceId);
    const subscriptions = [
      subscribeNativeObservationInvalidations((invalidation) => {
        if (invalidation.kind === "all" || concerned(invalidation.environmentId)) invalidate();
      }),
      onResourceChanged("native-agent-session", (change) => {
        if (concerned(change.id)) invalidate();
      }),
      onResourceChanged("coordinator", (change) => {
        if (change.id === projectId || change.projectId === projectId) invalidate();
      }),
      onResourceResync(() => invalidate()),
      onViewSafetyCheck(() => invalidate()),
    ];
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [homeIds, invalidate, projectId, workspaceId]);

  const local = useNativeAgentProjectionStore((state) =>
    activeCoordinatorTurnLabel({
      workspace,
      ...(current ? { conversationIds: mountedConversationIds } : {}),
      homeEnvironmentIds: current ? NO_ENVIRONMENTS : homeIds,
      projections: state.projections,
    }),
  );
  return current?.turn ? checkoutTurnLabel(current.turn, workspace) : local;
}
