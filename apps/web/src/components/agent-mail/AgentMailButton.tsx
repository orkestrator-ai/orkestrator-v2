import { useEffect, useMemo } from "react";
import { Inbox } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useConfigStore } from "@/stores/configStore";

/**
 * The title-bar entry to agent mail. It opens the messages panel
 * (`AgentMailPanel`); its badge counts only mail that needs the person —
 * failed or held deliveries and unseen mail from outside the project — not
 * the agents' own traffic.
 */
export function AgentMailButton() {
  const summary = useAgentMailStore((state) => state.summary);
  const failedSent = useAgentMailStore((state) => state.failedSent);
  const clearFailedSent = useAgentMailStore((state) => state.clearFailedSent);
  const openPanel = useAgentMailStore((state) => state.openPanel);
  const messagingEnabled = useConfigStore(
    (state) => state.config.global.agentMessaging?.enabled === true,
  );
  const attention = useMemo(
    () =>
      Array.from(summary.values()).reduce(
        (total, entry) => total + (entry.attentionCount ?? entry.failedInjectCount),
        0,
      ),
    [summary],
  );

  useEffect(() => {
    if (failedSent.size === 0) return;
    for (const message of failedSent.values())
      toast.error("Agent message delivery failed", {
        description: message.placementReason || "The recipient rejected delivery.",
      });
    clearFailedSent();
  }, [clearFailedSent, failedSent]);

  if (!messagingEnabled) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative h-7 w-7"
      aria-label={
        attention
          ? `Agent messages, ${attention} need${attention === 1 ? "s" : ""} you`
          : "Agent messages"
      }
      onClick={() => openPanel({})}
    >
      <Inbox className="h-4 w-4" />
      {attention > 0 && (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-amber-400 px-1 font-mono text-[9px] leading-4 text-zinc-950">
          {attention > 99 ? "99+" : attention}
        </span>
      )}
    </Button>
  );
}
