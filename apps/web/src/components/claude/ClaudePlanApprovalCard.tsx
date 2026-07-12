import { useState, useCallback, useMemo } from "react";
import { FileText, Check, X, ChevronRight } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ClaudePlanApprovalRequest, ClaudeClient, ClaudeMessage } from "@/lib/claude-client";
import { respondToPlanApproval } from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";

interface ClaudePlanApprovalCardProps {
  approval: ClaudePlanApprovalRequest;
  client: ClaudeClient;
  sessionId: string;
  messages: ClaudeMessage[];
}

/**
 * Check if a file path looks like a plan file.
 * Matches common plan file patterns used by Claude in plan mode.
 */
function isPlanFilePath(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  const fileName = lowerPath.split("/").pop() ?? "";

  // Check for common plan file patterns
  const planPatterns = [
    /plan\.md$/,
    /implementation[-_]?plan\.md$/,
    /[-_]plan\.md$/,
    /plan[-_].*\.md$/,
  ];

  if (planPatterns.some((pattern) => pattern.test(fileName))) {
    return true;
  }

  // Check for plan files in common directories
  const planDirectories = [".claude/", "docs/plans/", "plans/"];
  if (planDirectories.some((dir) => lowerPath.includes(dir)) && lowerPath.endsWith(".md")) {
    return true;
  }

  return false;
}

/**
 * Extract plan content from messages by finding the most recent Write tool
 * that wrote a plan file (matching specific plan file patterns).
 */
function extractPlanContent(messages: ClaudeMessage[]): string | null {
  // Search messages in reverse order (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;

    // Search parts in reverse order within each message
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j];
      if (!part || part.type !== "tool-invocation") continue;
      if (part.toolName?.toLowerCase() !== "write") continue;

      // Check if this is a plan file (not just any .md file)
      const filePath = part.toolArgs?.file_path as string | undefined;
      if (!filePath || !isPlanFilePath(filePath)) continue;

      // Extract the content that was written
      const content = part.toolArgs?.content as string | undefined;
      if (content) {
        return content;
      }
    }
  }

  return null;
}

export function ClaudePlanApprovalCard({
  approval,
  client,
  sessionId,
  messages,
}: ClaudePlanApprovalCardProps) {
  const { removePendingPlanApproval } = useClaudeStore();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [isPlanExpanded, setIsPlanExpanded] = useState(true);

  // Extract plan content from messages
  const planContent = useMemo(() => extractPlanContent(messages), [messages]);

  const handleApprove = useCallback(async () => {
    setIsSubmitting(true);
    try {
      const success = await respondToPlanApproval(client, sessionId, approval.id, true);
      if (success) {
        removePendingPlanApproval(approval.id);
        // Plan mode will be disabled via the plan.exit-requested event from the server
      } else {
        // Request expired - remove the card since it's no longer actionable
        console.warn("[ClaudePlanApprovalCard] Plan approval request expired, removing card");
        removePendingPlanApproval(approval.id);
      }
    } catch (err) {
      console.error("[ClaudePlanApprovalCard] Failed to approve plan:", err);
      // On error, also remove the card - it's likely no longer valid
      removePendingPlanApproval(approval.id);
    } finally {
      setIsSubmitting(false);
    }
  }, [client, sessionId, approval.id, removePendingPlanApproval]);

  const handleReject = useCallback(async () => {
    if (!showFeedback) {
      // Show feedback input first
      setShowFeedback(true);
      return;
    }

    setIsSubmitting(true);
    try {
      const success = await respondToPlanApproval(
        client,
        sessionId,
        approval.id,
        false,
        feedback.trim() || undefined
      );
      if (success) {
        removePendingPlanApproval(approval.id);
        // Keep plan mode enabled so Claude can revise the plan
        // The plan.exit-requested event will NOT be sent on rejection
      } else {
        // Request expired - remove the card since it's no longer actionable
        console.warn("[ClaudePlanApprovalCard] Plan rejection request expired, removing card");
        removePendingPlanApproval(approval.id);
      }
    } catch (err) {
      console.error("[ClaudePlanApprovalCard] Failed to reject plan:", err);
      // On error, also remove the card - it's likely no longer valid
      removePendingPlanApproval(approval.id);
    } finally {
      setIsSubmitting(false);
    }
  }, [client, sessionId, approval.id, feedback, showFeedback, removePendingPlanApproval]);

  const handleDismiss = useCallback(() => {
    // Dismissing is treated as rejection without feedback
    setIsSubmitting(true);
    respondToPlanApproval(client, sessionId, approval.id, false)
      .then((success) => {
        // Always remove the card on dismiss - either it succeeded or it expired
        removePendingPlanApproval(approval.id);
        if (!success) {
          console.warn("[ClaudePlanApprovalCard] Plan dismiss request expired, card removed anyway");
        }
      })
      .catch((err) => {
        console.error("[ClaudePlanApprovalCard] Failed to dismiss plan:", err);
        // On error, also remove the card - user explicitly wanted to dismiss
        removePendingPlanApproval(approval.id);
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  }, [client, sessionId, approval.id, removePendingPlanApproval]);

  return (
    <div className="mx-4 my-3 rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-500/10 border-b border-border">
        <FileText className="w-4 h-4 text-amber-500" />
        <span className="text-sm font-medium text-foreground">Plan Ready for Review</span>
        <span className="text-xs text-muted-foreground ml-auto">
          Review the plan above and approve or request changes
        </span>
      </div>

      {/* Plan Content */}
      {planContent && (
        <Collapsible open={isPlanExpanded} onOpenChange={setIsPlanExpanded}>
          <CollapsibleTrigger className="flex items-center gap-2 w-full px-4 py-2 text-xs text-muted-foreground hover:bg-muted/30 transition-colors cursor-pointer border-b border-border">
            <ChevronRight
              className={cn(
                "w-3 h-3 transition-transform shrink-0",
                isPlanExpanded && "rotate-90"
              )}
            />
            <span className="font-medium">Implementation Plan</span>
            <span className="text-muted-foreground/60 ml-auto">
              {isPlanExpanded ? "Click to collapse" : "Click to expand"}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="max-h-[400px] overflow-y-auto px-4 py-3 bg-muted/20">
              <div className="text-sm text-foreground leading-relaxed prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-headings:my-3 prose-headings:text-foreground prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2 prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-muted prose-pre:p-3 prose-pre:rounded-md">
                <Markdown remarkPlugins={[remarkGfm]}>{planContent}</Markdown>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Content */}
      <div className="p-4 space-y-3">
        {!planContent && (
          <p className="text-sm text-foreground leading-relaxed">
            Claude has created a plan for your task. Please review the plan in the conversation
            above and decide whether to approve it or request revisions.
          </p>
        )}

        {showFeedback && (
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              What changes would you like? (optional)
            </label>
            <Textarea
              placeholder="Describe what you'd like Claude to change about the plan..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              className="min-h-[80px] text-sm bg-transparent border-muted-foreground/20 focus:border-primary resize-none"
              disabled={isSubmitting}
            />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/30 border-t border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          disabled={isSubmitting}
          className="text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReject}
            disabled={isSubmitting}
            className={cn(
              "gap-1.5",
              showFeedback && "text-destructive hover:text-destructive"
            )}
          >
            <X className="w-3.5 h-3.5" />
            {showFeedback ? "Submit Feedback" : "Request Changes"}
          </Button>
          <Button
            size="sm"
            onClick={handleApprove}
            disabled={isSubmitting}
            className="gap-1.5 bg-green-600 hover:bg-green-700"
          >
            <Check className="w-3.5 h-3.5" />
            {isSubmitting ? "Approving..." : "Approve Plan"}
          </Button>
        </div>
      </div>
    </div>
  );
}
