// Resume-session picker for the Claude tmux mode tab.
//
// Mirrors `ResumeSessionDialog` (native-mode) but pulls its session list from
// the tmux backend, which reads the JSONL transcripts on disk rather than the
// Agent SDK's session API.

import { useCallback, useEffect, useState } from "react";
import { Clock, Loader2, MessageSquare } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  listPreviousSessions,
  type PreviousSession,
} from "@/lib/claude-tmux-client";

interface ResumeTmuxSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  /** Called with the picked session_id when the user chooses one. */
  onResume: (sessionId: string) => void;
}

function formatRelativeTime(unixSeconds: number): string {
  if (!unixSeconds) return "unknown";
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (ageSec < 60) return "just now";
  const mins = Math.floor(ageSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export function ResumeTmuxSessionDialog({
  open,
  onOpenChange,
  environmentId,
  onResume,
}: ResumeTmuxSessionDialogProps) {
  const [sessions, setSessions] = useState<PreviousSession[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const all = await listPreviousSessions(environmentId);
      setSessions(all);
    } catch (err) {
      console.error("[ResumeTmuxSessionDialog] Failed to list sessions:", err);
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  }, [environmentId]);

  useEffect(() => {
    if (open) {
      void fetchSessions();
    }
  }, [open, fetchSessions]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resume Session</DialogTitle>
          <DialogDescription>
            Pick a previous Claude session recorded for this workspace.
            Selecting one will reload its full transcript and continue the
            conversation in this tab.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="text-center py-8 text-sm text-destructive">
              {error}
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No previous sessions recorded for this workspace yet.
            </div>
          ) : (
            <ScrollArea className="h-[320px] overflow-hidden">
              <div className="space-y-1 pr-4">
                {sessions.map((s) => (
                  <button
                    key={s.session_id}
                    onClick={() => onResume(s.session_id)}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded-md transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                      "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <MessageSquare className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium whitespace-normal break-words max-w-full">
                          {s.title || `Session ${s.session_id.slice(0, 8)}`}
                        </p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatRelativeTime(s.last_activity_unix)}
                          </span>
                          <span className="opacity-60">·</span>
                          <span>
                            {s.message_count}{" "}
                            {s.message_count === 1 ? "message" : "messages"}
                          </span>
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
