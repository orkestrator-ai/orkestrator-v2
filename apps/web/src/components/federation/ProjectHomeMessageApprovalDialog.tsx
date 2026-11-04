import { useState } from "react";
import { House, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { resolveNodeActionRequest, type NodeActionRequestView } from "@/lib/portal/portal-store";

/**
 * The main coordinator wants to message the project home, the user's own
 * checkout, and has not messaged it in the last three hours. The user reads
 * the message and the coordinator's reason for not using an isolated
 * environment, then approves (the message is sent as written) or declines
 * (nothing is sent, and the coordinator is told).
 */
export function ProjectHomeMessageApprovalDialog({
  request,
  onSettled,
}: {
  request: NodeActionRequestView;
  onSettled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const target = request.targets[0];
  const message = request.projectHomeMessage;
  const home = target?.environmentName ?? target?.environmentId ?? "the project home";

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      const resolved = await resolveNodeActionRequest(request.requestId, decision);
      if (decision === "approve") {
        if (resolved.state === "executed") toast.success(resolved.result?.message ?? "Sent.");
        else toast.warning("Message not sent", { description: resolved.result?.message });
      }
    } catch (error) {
      toast.error("Could not resolve the request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
      onSettled();
    }
  };

  return (
    // Like the other coordinator requests, it stays until approved or declined.
    <Dialog open>
      <DialogContent size="lg" data-testid="project-home-message-request" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Send the coordinator&apos;s message to the project home “{home}”?
          </DialogTitle>
          <DialogDescription>
            The project home is your own checkout. An agent working there can conflict with your own
            changes, so the coordinator normally uses an isolated environment. Nothing is sent
            unless you approve; approving also lets its further messages to the project home through
            without asking for the next 3 hours.
          </DialogDescription>
        </DialogHeader>

        <section aria-label="Why not an isolated environment" className="space-y-1">
          <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Coordinator&apos;s reason
          </h3>
          <p className="text-sm leading-relaxed text-foreground" data-testid="project-home-reason">
            {request.reason ?? "No reason given."}
          </p>
        </section>

        <section
          aria-label="Message"
          className="max-h-[50vh] overflow-y-auto rounded-lg border border-border/70 bg-zinc-900/90"
        >
          <div className="flex items-center gap-2 border-b border-border/60 bg-white/[0.02] px-3 py-2">
            <House className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 truncate text-xs font-medium text-foreground">
              {message?.subject ?? "Message"}
            </span>
            {message?.deliverNow ? (
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                Deliver now
              </span>
            ) : null}
          </div>
          <pre
            className="px-3 py-3 font-sans text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground"
            data-testid="project-home-message-body"
          >
            {message?.body ?? "This request carries no message."}
          </pre>
          {message?.attachments?.length ? (
            <p
              className="border-t border-border/60 px-3 py-2 text-xs break-words text-muted-foreground"
              data-testid="project-home-message-attachments"
            >
              With {message.attachments.length === 1 ? "an image" : "images"}, given to the project
              home if you approve (kept outside your checkout, and removed with the project home):{" "}
              {message.attachments.join(", ")}
            </p>
          ) : null}
        </section>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void decide("reject")}
          >
            Decline
          </Button>
          <Button type="button" disabled={busy || !message} onClick={() => void decide("approve")}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Approve and send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
