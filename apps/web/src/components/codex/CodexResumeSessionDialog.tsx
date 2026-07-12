import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, MessageSquare, Clock } from "lucide-react";
import {
  listSessions,
  type CodexClient,
  type CodexStoredSession,
} from "@/lib/codex-client";
import { cn } from "@/lib/utils";

interface CodexResumeSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: CodexClient;
  onResume: (threadId: string) => void;
  currentSessionId?: string;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

export function CodexResumeSessionDialog({
  open,
  onOpenChange,
  client,
  onResume,
  currentSessionId,
}: CodexResumeSessionDialogProps) {
  const [sessions, setSessions] = useState<CodexStoredSession[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const allSessions = await listSessions(client);
      const filtered = allSessions
        .filter((session) => session.id !== currentSessionId)
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() -
            new Date(a.updatedAt).getTime(),
        );
      setSessions(filtered);
    } catch (err) {
      console.error("[CodexResumeSessionDialog] Failed to fetch sessions:", err);
      setError("Failed to load sessions");
    } finally {
      setIsLoading(false);
    }
  }, [client, currentSessionId]);

  useEffect(() => {
    if (open) {
      void fetchSessions();
    }
  }, [fetchSessions, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resume Session</DialogTitle>
          <DialogDescription>
            Select a previous Codex session to continue the conversation.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="py-8 text-center text-sm text-destructive">
              {error}
            </div>
          ) : sessions.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No previous sessions found.
            </div>
          ) : (
            <ScrollArea className="h-[300px] overflow-hidden">
              <div className="space-y-1 pr-4">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => onResume(session.id)}
                    className={cn(
                      "w-full rounded-md px-3 py-2 text-left transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                      "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="max-w-full whitespace-normal break-words text-sm font-medium">
                          {session.title || `Session ${session.id.slice(0, 8)}`}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          <span>{formatRelativeTime(session.updatedAt)}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
