import { FileText, Check, ArrowRight, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CodexPlanModeCardProps {
  className?: string;
  isSubmitting?: boolean;
  onApproveAndBuild: () => Promise<void> | void;
  onSwitchToBuild: () => Promise<void> | void;
  onDismiss: () => void;
}

export function CodexPlanModeCard({
  className,
  isSubmitting = false,
  onApproveAndBuild,
  onSwitchToBuild,
  onDismiss,
}: CodexPlanModeCardProps) {
  return (
    <div
      className={cn(
        "mx-4 my-3 overflow-hidden rounded-lg border border-border bg-card shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-4 py-2.5">
        <FileText className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-medium text-foreground">Plan Mode</span>
        <span className="ml-auto text-xs text-muted-foreground">
          Review the latest plan, then keep planning or switch back to build mode
        </span>
      </div>

      <div className="space-y-3 px-4 py-4">
        <p className="text-sm leading-relaxed text-foreground">
          Codex is in planning-only mode. It should analyze, propose a plan, and avoid making
          changes until you approve the approach.
        </p>
        <p className="text-xs text-muted-foreground">
          Approving switches the session back to build mode and sends a follow-up prompt telling
          Codex to implement the approved plan.
        </p>
      </div>

      <div className="flex items-center justify-between border-t border-border bg-muted/30 px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          disabled={isSubmitting}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="mr-1.5 h-3.5 w-3.5" />
          Dismiss
        </Button>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onSwitchToBuild()}
            disabled={isSubmitting}
          >
            {isSubmitting
              ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              : <ArrowRight className="mr-1.5 h-3.5 w-3.5" />}
            Switch To Build
          </Button>
          <Button
            size="sm"
            onClick={() => void onApproveAndBuild()}
            disabled={isSubmitting}
          >
            {isSubmitting
              ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              : <Check className="mr-1.5 h-3.5 w-3.5" />}
            Approve Plan
          </Button>
        </div>
      </div>
    </div>
  );
}
