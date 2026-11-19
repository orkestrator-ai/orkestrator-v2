import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { PlanCardScope } from "@/components/chat/plan-card-context";
import { buildPlanRevisionIndex, implementPlanPrompt } from "@/lib/plan-revisions";

interface AgentPlanCardScopeInput {
  /** The rows the transcript renders, so card keys and index keys agree. */
  messages: readonly NativeMessage[];
  /** The whole conversation is loaded; revision numbers are only shown then. */
  historyComplete: boolean;
  /** The provider's plan review applies now (plan mode, idle, plan on screen). */
  reviewApplies: boolean;
  /** Id of the latest assistant row, to tell whether the current plan is in it. */
  latestAssistantMessageId: string | undefined;
  pending: boolean;
  /** Leaves plan mode, then sends `prompt` when one is given. */
  switchPlanToBuild: (prompt?: string) => Promise<void>;
}

export interface AgentPlanCardScope {
  scope: PlanCardScope;
  /** The current plan's card carries the actions and is the latest reply. */
  actionsOnLatestCard: boolean;
  /** The prompt the pinned review card sends: bound to the current plan when one exists. */
  pinnedImplementPrompt: string | undefined;
}

/**
 * Orders the conversation's plans and hands the current one its actions.
 *
 * The implementation action is bound to a plan key. A click is honoured only
 * while that key is still the current plan, so a plan that a newer revision
 * replaced can be read and copied but never implemented by mistake.
 */
export function useAgentPlanCardScope({
  messages,
  historyComplete,
  reviewApplies,
  latestAssistantMessageId,
  pending,
  switchPlanToBuild,
}: AgentPlanCardScopeInput): AgentPlanCardScope {
  const index = useMemo(
    () => buildPlanRevisionIndex(messages, { historyComplete }),
    [historyComplete, messages],
  );
  const currentKey = index.currentKey;
  const current = currentKey !== undefined ? index.byKey.get(currentKey) : undefined;

  const implement = useCallback(
    async (planKey: string, title: string | undefined) => {
      if (planKey !== currentKey) {
        toast.error("A newer plan replaced this one. Review the current plan before implementing.");
        return;
      }
      await switchPlanToBuild(implementPlanPrompt(title));
    },
    [currentKey, switchPlanToBuild],
  );
  const switchToBuild = useCallback(() => switchPlanToBuild(), [switchPlanToBuild]);

  const scope = useMemo<PlanCardScope>(
    () => ({
      index,
      ...(reviewApplies && currentKey !== undefined
        ? { actions: { planKey: currentKey, pending, implement, switchToBuild } }
        : {}),
    }),
    [currentKey, implement, index, pending, reviewApplies, switchToBuild],
  );

  return {
    scope,
    actionsOnLatestCard:
      scope.actions !== undefined &&
      current !== undefined &&
      current.messageId === latestAssistantMessageId,
    pinnedImplementPrompt: current ? implementPlanPrompt(current.title) : undefined,
  };
}
