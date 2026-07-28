import { BlockingPromptCard } from "@/components/chat/BlockingPromptCard";
import { useCallback, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  replyToPermission,
  type PermissionReply,
  type PermissionRequest,
  type OpencodeClient,
} from "@/lib/opencode-client";
import { useOpenCodeStore } from "@/stores/openCodeStore";

interface OpenCodePermissionCardProps {
  permission: PermissionRequest;
  client: OpencodeClient;
}

const REPLY_FAILURE_TITLE = "Failed to send permission decision";
/**
 * Shown when the server answered but did not accept the reply. There is no
 * error object to quote, and the turn stays blocked until a decision lands.
 */
const RETRY_HINT = "OpenCode is still waiting for a decision. Please try again.";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function OpenCodePermissionCard({
  permission,
  client,
}: OpenCodePermissionCardProps) {
  const { removePendingPermission } = useOpenCodeStore();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleReply = useCallback(
    async (reply: PermissionReply) => {
      if (isSubmitting) return;

      setIsSubmitting(true);
      try {
        const success = await replyToPermission(client, permission.id, reply);
        if (success) {
          removePendingPermission(permission.id);
        } else {
          // The card stays retryable, but the turn is fully blocked on this
          // answer: without a toast the user has no signal it never landed.
          console.error("[OpenCodePermissionCard] Permission reply was not delivered");
          toast.error(REPLY_FAILURE_TITLE, { description: RETRY_HINT });
        }
      } catch (error) {
        console.error("[OpenCodePermissionCard] Failed to submit permission reply:", error);
        toast.error(REPLY_FAILURE_TITLE, { description: describeError(error) });
      } finally {
        setIsSubmitting(false);
      }
    },
    [client, permission.id, removePendingPermission, isSubmitting],
  );

  const canAlwaysAllow = permission.always.length > 0;

  return (
    <BlockingPromptCard>
      <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/50 border-b border-border">
        <ShieldAlert className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Permission Required</span>
      </div>

      <div className="p-4 space-y-3">
        <p className="text-sm text-foreground leading-relaxed">
          OpenCode needs approval to continue this tool call.
        </p>

        <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground">Permission</p>
          <p className="text-sm font-mono text-foreground">{permission.permission}</p>
        </div>

        {permission.patterns.length > 0 && (
          <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
            <p className="text-xs text-muted-foreground mb-1">Requested paths</p>
            <div className="space-y-1">
              {permission.patterns.map((pattern) => (
                <p key={pattern} className="text-xs font-mono text-foreground/90 break-all">
                  {pattern}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-4 py-3 bg-muted/30 border-t border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleReply("reject")}
          disabled={isSubmitting}
          className="text-muted-foreground hover:text-foreground"
        >
          Reject
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleReply("once")}
          disabled={isSubmitting}
        >
          {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Allow Once"}
        </Button>
        {canAlwaysAllow && (
          <Button
            size="sm"
            onClick={() => handleReply("always")}
            disabled={isSubmitting}
          >
            Always Allow
          </Button>
        )}
      </div>
    </BlockingPromptCard>
  );
}
