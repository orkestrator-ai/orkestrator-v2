import { useCallback, useEffect, useRef, useState } from "react";
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
import { formatRelativeTime } from "@/lib/format-relative-time";

/** Agent-neutral row rendered by the picker. */
export interface ResumableSession {
  id: string;
  title?: string;
  /**
   * When this session was last *worked in* — not when it was created.
   *
   * The list is ordered by this, so passing a creation timestamp would bury the
   * session the user most likely wants. Accepts anything `Date` can parse plus
   * Unix seconds via `activityAtUnixSeconds` on the caller's side.
   */
  activityAt?: string | number | Date | null;
  status?: "idle" | "running" | "error";
  /** Optional trailing detail, e.g. "12 messages". */
  detail?: string;
}

interface NativeResumeSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Used in the dialog copy: "Select a previous {agentLabel} session…". */
  agentLabel: string;
  /** Fetches the candidate list. Re-run each time the dialog opens. */
  fetchSessions: () => Promise<ResumableSession[]>;
  onResume: (sessionId: string) => void;
  /** Excluded from the list — resuming the session you are in is a no-op. */
  currentSessionId?: string;
  emptyMessage?: string;
}

/**
 * Session picker shared by every native chat tab.
 *
 * Replaces three near-identical dialogs that differed only in their client
 * type, the timestamp field they sorted on, and whether they rendered status
 * badges. Sorting is always most-recently-active first; the OpenCode copy used
 * to sort on creation time, so its most recently used session was not
 * necessarily at the top.
 */
export function NativeResumeSessionDialog({
  open,
  onOpenChange,
  agentLabel,
  fetchSessions,
  onResume,
  currentSessionId,
  emptyMessage = "No previous sessions found.",
}: NativeResumeSessionDialogProps) {
  const [sessions, setSessions] = useState<ResumableSession[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);

  const loadSessions = useCallback(async () => {
    const requestGeneration = ++requestGenerationRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const all = await fetchSessions();
      if (requestGeneration !== requestGenerationRef.current) return;

      const filtered = all
        .filter((session) => session.id !== currentSessionId)
        .sort((a, b) => activityTimestamp(b) - activityTimestamp(a));
      setSessions(filtered);
    } catch (err) {
      if (requestGeneration !== requestGenerationRef.current) return;

      console.error(
        `[${agentLabel}ResumeSessionDialog] Failed to fetch sessions:`,
        err,
      );
      setError("Failed to load sessions");
    } finally {
      if (requestGeneration === requestGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, [agentLabel, currentSessionId, fetchSessions]);

  useEffect(() => {
    if (open) {
      void loadSessions();
    }

    return () => {
      // Ignore a request started for a previous open cycle, dependency set, or
      // component instance. It may still settle, but it no longer owns state.
      requestGenerationRef.current += 1;
    };
  }, [open, loadSessions]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resume Session</DialogTitle>
          <DialogDescription>
            Select a previous {agentLabel} session to continue the conversation.
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
              {emptyMessage}
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
                        <p className="max-w-full text-sm font-medium break-words whitespace-normal">
                          {session.title || `Session ${session.id.slice(0, 8)}`}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          <span>{formatRelativeTime(session.activityAt)}</span>
                          {session.detail && (
                            <>
                              <span className="opacity-60">·</span>
                              <span>{session.detail}</span>
                            </>
                          )}
                          {session.status === "running" && (
                            <span className="ml-2 text-yellow-500">
                              • Running
                            </span>
                          )}
                          {session.status === "error" && (
                            <span className="ml-2 text-destructive">
                              • Error
                            </span>
                          )}
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

/** Sort key. Unknown timestamps sink to the bottom rather than to 1970. */
function activityTimestamp(session: ResumableSession): number {
  const value = session.activityAt;
  if (value === null || value === undefined || value === "") return 0;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
}
