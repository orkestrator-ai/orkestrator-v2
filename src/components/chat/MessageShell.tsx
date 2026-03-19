import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface MessageShellProps {
  isUser: boolean;
  authorLabel: string;
  timestampLabel: string;
  showHeader?: boolean;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}

export function MessageShell({
  isUser,
  authorLabel,
  timestampLabel,
  showHeader = true,
  className,
  contentClassName,
  children,
}: MessageShellProps) {
  return (
    <div
      className={cn(
        "px-4 py-3",
        isUser ? "bg-muted/30" : "bg-transparent",
        className,
      )}
    >
      <div className={cn("max-w-3xl mx-auto", contentClassName)}>
        {showHeader && (
          <div className="mb-1.5">
            <span
              className={cn(
                "text-xs font-medium",
                isUser ? "text-primary" : "text-muted-foreground",
              )}
            >
              {authorLabel}
            </span>
            <span className="text-[10px] text-muted-foreground/60 ml-2">
              {timestampLabel}
            </span>
          </div>
        )}

        <div className="space-y-2">{children}</div>
      </div>
    </div>
  );
}

interface MessageErrorAlertProps {
  content: string;
  timestampLabel: string;
}

export function MessageErrorAlert({
  content,
  timestampLabel,
}: MessageErrorAlertProps) {
  return (
    <div className="px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
          <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm text-destructive whitespace-pre-wrap break-words">
              {content}
            </div>
            <div className="text-[10px] text-destructive/60 mt-1">
              {timestampLabel}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
