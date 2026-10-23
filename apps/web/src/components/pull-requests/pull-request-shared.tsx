import { useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertCircle, Loader2, RefreshCw, Send, UserRound } from "lucide-react";
import { toast } from "sonner";
import type { GitHubPullRequestUser } from "@orkestrator/protocol/github-pull-requests";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { writeText } from "@/lib/native/clipboard";
import { cn } from "@/lib/utils";
import { isCredentialError } from "./pull-request-format";

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    await writeText(text);
    toast.success(`${label} copied`, { description: text });
  } catch (error) {
    console.error("[pull-requests] Failed to copy:", error);
    toast.error(`Could not copy ${label.toLowerCase()}`);
  }
}

export function UserAvatar({
  user,
  className,
}: {
  user: Pick<GitHubPullRequestUser, "login" | "avatarUrl"> | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const base = cn("size-5 shrink-0 rounded-full bg-muted", className);
  if (!user?.avatarUrl || failed) {
    return (
      <span className={cn(base, "inline-flex items-center justify-center")} aria-hidden>
        <UserRound className="size-3 text-muted-foreground" />
      </span>
    );
  }
  return (
    <img
      src={user.avatarUrl}
      alt=""
      aria-hidden
      loading="lazy"
      className={cn(base, "object-cover")}
      onError={() => setFailed(true)}
    />
  );
}

export function userLogin(user: GitHubPullRequestUser | null): string {
  return user?.login ?? "ghost";
}

export function ErrorNotice({
  message,
  onRetry,
  retrying,
  className,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const credential = isCredentialError(message);
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="break-words">{message}</p>
          {credential && (
            <p className="text-xs text-destructive/80">
              The pull request viewer uses the GitHub credentials configured in Settings → GitHub.
              Add a token there (or enable host GitHub CLI credentials) and retry.
            </p>
          )}
        </div>
      </div>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-7 text-xs"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Retry
        </Button>
      )}
    </div>
  );
}

export function SkeletonLines({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className="h-3 animate-pulse rounded bg-muted"
          style={{ width: `${90 - ((index * 17) % 45)}%` }}
        />
      ))}
    </div>
  );
}

export function MarkdownBody({ body, className }: { body: string; className?: string }) {
  if (!body.trim()) {
    return <p className={cn("text-xs italic text-muted-foreground", className)}>No description.</p>;
  }
  return (
    <div className={cn("min-w-0 text-sm break-words", className)}>
      <MessageMarkdown content={body} />
    </div>
  );
}

/**
 * Textarea with ⌘/Ctrl+Enter to submit. Clears itself after a successful
 * submit; keeps the text when `onSubmit` throws.
 */
export function CommentComposer({
  placeholder = "Leave a comment",
  submitLabel = "Comment",
  onSubmit,
  onCancel,
  autoFocus,
  extraActions,
  initialValue = "",
  className,
  ariaLabel,
  allowEmpty = false,
}: {
  allowEmpty?: boolean;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
  extraActions?: ReactNode;
  initialValue?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    const body = value.trim();
    if ((!body && !allowEmpty) || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(body);
      setValue("");
    } catch (error) {
      toast.error(errorMessage(error, "Could not post the comment."));
    } finally {
      setSubmitting(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };
  return (
    <div className={cn("space-y-2", className)}>
      <Textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoFocus={autoFocus}
        disabled={submitting}
        className="min-h-20 resize-y text-sm"
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-muted-foreground">⌘/Ctrl+Enter to send</span>
        {extraActions}
        {onCancel && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => void submit()}
          disabled={(!value.trim() && !allowEmpty) || submitting}
        >
          {submitting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** Small "N ago" text with the absolute time as a tooltip. */
export function RelativeTime({ value, className }: { value: string; className?: string }) {
  const date = new Date(value);
  return (
    <time
      dateTime={value}
      title={Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()}
      className={cn("whitespace-nowrap text-muted-foreground", className)}
    >
      {formatRelativeTime(value)}
    </time>
  );
}
