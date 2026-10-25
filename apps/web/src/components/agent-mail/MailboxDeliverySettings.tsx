import { useState } from "react";
import { toast } from "sonner";
import type { MailboxDescriptor } from "@orkestrator/protocol/agent-mail";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { useAgentMailStore } from "@/stores/agentMailStore";

/** How one tab takes mail: wake it when idle or leave mail for it to pull, and mutes. */
export function MailboxDeliverySettings({ mailbox }: { mailbox: MailboxDescriptor }) {
  const refreshMailbox = useAgentMailStore((state) => state.refreshMailbox);
  const [error, setError] = useState<string>();

  const update = async (updates: {
    inject?: "inherit" | "off" | "idle";
    mutedInbound?: boolean;
    mutedOutbound?: boolean;
  }) => {
    setError(undefined);
    try {
      await backend.updateAgentMailboxPolicy({
        environmentId: mailbox.environmentId,
        tabId: mailbox.tabId,
        ...updates,
      });
      await refreshMailbox(mailbox.environmentId, mailbox.tabId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toast.error("Could not update delivery settings", { description: message });
    }
  };

  return (
    <div className="space-y-1.5 text-[11px]" data-testid="mailbox-delivery-settings">
      <div className="flex items-center gap-2">
        <select
          aria-label="Automatic delivery policy"
          value={mailbox.injectOverride ?? "inherit"}
          onChange={(event) =>
            void update({ inject: event.target.value as "inherit" | "off" | "idle" })
          }
          className="h-7 min-w-0 flex-1 rounded-md border border-border/70 bg-input-surface px-2"
        >
          <option value="inherit">
            Default ({mailbox.injectPolicy === "idle" ? "deliver when idle" : "pull only"})
          </option>
          <option value="off">Pull only</option>
          {mailbox.capabilities.canInject && <option value="idle">Deliver when idle</option>}
        </select>
        <Button
          size="sm"
          className="h-7 text-[11px]"
          variant={mailbox.mutedInbound ? "secondary" : "outline"}
          aria-pressed={mailbox.mutedInbound}
          onClick={() => void update({ mutedInbound: !mailbox.mutedInbound })}
        >
          {mailbox.mutedInbound ? "Inbound muted" : "Mute inbound"}
        </Button>
        <Button
          size="sm"
          className="h-7 text-[11px]"
          variant={mailbox.mutedOutbound ? "secondary" : "outline"}
          aria-pressed={mailbox.mutedOutbound}
          onClick={() => void update({ mutedOutbound: !mailbox.mutedOutbound })}
        >
          {mailbox.mutedOutbound ? "Outbound muted" : "Mute outbound"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
