import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { PlanCardScope } from "@/components/chat/plan-card-context";
import {
  buildPlanRevisionIndex,
  implementPlanPrompt,
  type PlanRevision,
} from "@/lib/plan-revisions";

interface AgentPlanCardScopeInput {
  messages: readonly NativeMessage[];
  historyComplete: boolean;
  reviewApplies: boolean;
  pending: boolean;
  switchPlanToBuild: (prompt?: string) => Promise<void>;
}

export function useAgentPlanCardScope({
  messages,
  historyComplete,
  reviewApplies,
  pending,
  switchPlanToBuild,
}: AgentPlanCardScopeInput) {
  const index = useMemo(
    () => buildPlanRevisionIndex(messages, { historyComplete }),
    [historyComplete, messages],
  );
  const reviewPlan =
    reviewApplies && index.reviewKey ? index.byKey.get(index.reviewKey) : undefined;
  const actionable = reviewPlan?.state === "current" ? reviewPlan : undefined;
  const committed = useRef<PlanRevision | undefined>(undefined);
  useLayoutEffect(() => {
    committed.current = actionable;
    return () => {
      committed.current = undefined;
    };
  }, [actionable]);

  const implement = useCallback(
    async (revision: PlanRevision, markdown: string) => {
      const selected = committed.current;
      if (revision !== selected) {
        toast.error(
          "This plan is no longer available for implementation. Review the current plan.",
        );
        return;
      }
      if (!markdown.trim()) return;
      await switchPlanToBuild(implementPlanPrompt(selected, markdown));
    },
    [switchPlanToBuild],
  );
  const switchToBuild = useCallback(() => switchPlanToBuild(), [switchPlanToBuild]);
  const [visibleRevision, setVisibleRevision] = useState<PlanRevision>();
  const reportVisibility = useCallback((revision: PlanRevision, visible: boolean) => {
    setVisibleRevision((previous) =>
      visible ? revision : previous === revision ? undefined : previous,
    );
  }, []);

  const scope = useMemo<PlanCardScope>(
    () => ({
      index,
      ...(actionable
        ? {
            actions: {
              planKey: actionable.key,
              pending,
              implement,
              switchToBuild,
              reportVisibility,
            },
          }
        : {}),
    }),
    [actionable, implement, index, pending, reportVisibility, switchToBuild],
  );

  return {
    scope,
    reviewPlan,
    actionsVisible: actionable !== undefined && visibleRevision === actionable,
  };
}
