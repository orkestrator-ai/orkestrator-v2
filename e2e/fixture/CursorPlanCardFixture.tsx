import { useCallback, useState } from "react";
import { NativeChatShell } from "../../apps/web/src/components/chat/NativeChatShell";
import { PlanCardScopeContext } from "../../apps/web/src/components/chat/plan-card-context";
import { CodexPlanModeCard } from "../../apps/web/src/components/codex/CodexPlanModeCard";
import { useAgentPlanCardScope } from "../../apps/web/src/components/native-agent/AgentNativeTab.plan-card";
import { useVirtuosoScrollState } from "../../apps/web/src/hooks/useVirtuosoScrollState";
import type { NativeMessage } from "../../apps/web/src/lib/chat/native-message-types";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";

const markdown = "# Observe the queue\n\n- Measure wakeups.\n- Add a regression test.";
const when = "2026-11-19T10:00:00Z";
const detail = new URLSearchParams(window.location.search).get("detail");

const messages: NativeMessage[] = [
  ...Array.from({ length: 100 }, (_, index): NativeMessage => ({
    id: `history-${index}`,
    role: "assistant",
    content: "",
    createdAt: when,
    parts: [{ type: "text", content: `Earlier transcript row ${index + 1}.` }],
  })),
  {
    id: "current-plan",
    role: "assistant",
    content: "",
    createdAt: when,
    parts: [
      {
        type: "tool-invocation",
        content: "Plan",
        toolName: "createPlan",
        toolUseId: "plan",
        toolState: "success",
        ...(detail ? { detailRef: "fixture-plan" } : { toolOutput: markdown }),
      },
    ],
  },
  {
    id: "plan-prose",
    role: "assistant",
    content: "The steps above keep the existing queue.",
    createdAt: when,
    planReview: true,
    parts: [{ type: "text", content: "The steps above keep the existing queue." }],
  },
];

export function CursorPlanCardFixture() {
  const [review, setReview] = useState(true);
  const { isAtBottom, scrollToBottom, scrollToIndex, scrollProps, virtuosoRef } =
    useVirtuosoScrollState();
  const leavePlanMode = useCallback(async () => setReview(false), []);
  const planCards = useAgentPlanCardScope({
    messages,
    historyComplete: true,
    reviewApplies: review,
    pending: false,
    switchPlanToBuild: leavePlanMode,
  });
  const readDetails = useCallback(async (): Promise<NativeAgentToolDetails> => {
    if (detail === "error") throw new Error("Could not load plan details.");
    return new Promise(() => {});
  }, []);
  return (
    <main className="h-dvh bg-background text-foreground">
      <PlanCardScopeContext.Provider value={planCards.scope}>
        <NativeChatShell
          agentLabel="Cursor Agent"
          platform="cursor"
          agentExpansionScope="fixture-cursor-plan"
          isActive
          connectionState="connected"
          displayAvailable
          sessionEstablished
          onRetry={() => {}}
          centerCompose={false}
          messages={messages}
          isLoading={false}
          elapsedSeconds={null}
          finalElapsedSeconds={null}
          composer={
            <textarea className="w-full rounded-md border bg-background p-2" aria-label="Prompt" />
          }
          pinnedAccessory={
            review && !planCards.actionsVisible ? (
              <CodexPlanModeCard
                onReviewPlan={() =>
                  scrollToIndex(
                    messages.length - 2,
                    { rowKey: "current-plan", partId: "plan" },
                    "message-link",
                  )
                }
                onApproveAndBuild={leavePlanMode}
                onSwitchToBuild={leavePlanMode}
                onDismiss={() => setReview(false)}
              />
            ) : null
          }
          loadToolDetails={readDetails}
          isAtBottom={isAtBottom}
          scrollToBottom={scrollToBottom}
          scrollProps={scrollProps}
          virtuosoRef={virtuosoRef}
        />
      </PlanCardScopeContext.Provider>
    </main>
  );
}
