import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Clock, Loader2, MessageSquare } from "lucide-react";
import { toast } from "sonner";
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
  /**
   * Fetches the candidate list. Called exactly once per open, never on a
   * re-render.
   *
   * The latest prop is read through a ref, so the identity does not have to be
   * stable: a chat tab re-renders on every streamed chunk, and keying the fetch
   * on an inline lambda would flash the spinner and rebuild the list under the
   * user's cursor for the whole turn.
   */
  fetchSessions: () => Promise<ResumableSession[]>;
  onResume: (sessionId: string) => void;
  /** Excluded from the list — resuming the session you are in is a no-op. */
  currentSessionId?: string;
  emptyMessage?: string;
  /**
   * Takes a row out of the list (`archived: true`) or puts it back. The
   * provider keeps the conversation either way; this is never a delete. Absent
   * where the platform cannot archive, and the rows then offer no remove.
   */
  onArchive?: (sessionId: string, archived: boolean) => Promise<void>;
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
  onArchive,
}: NativeResumeSessionDialogProps) {
  const [fetchedSessions, setFetchedSessions] = useState<ResumableSession[]>([]);
  const [archiving, setArchiving] = useState<ReadonlySet<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);

  // Latest-props refs, so the fetch below can be keyed on `open` alone.
  const fetchSessionsRef = useRef(fetchSessions);
  const agentLabelRef = useRef(agentLabel);
  useEffect(() => {
    fetchSessionsRef.current = fetchSessions;
    agentLabelRef.current = agentLabel;
  });

  // Each open cycle starts loading from a clean slate, set while rendering so
  // the effect below only issues the request.
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setIsLoading(true);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) return;

    const requestGeneration = ++requestGenerationRef.current;

    void (async () => {
      try {
        const all = await fetchSessionsRef.current();
        if (requestGeneration !== requestGenerationRef.current) return;
        setFetchedSessions(all);
      } catch (err) {
        if (requestGeneration !== requestGenerationRef.current) return;

        console.error(
          `[${agentLabelRef.current}ResumeSessionDialog] Failed to fetch sessions:`,
          err,
        );
        setError("Failed to load sessions");
      } finally {
        if (requestGeneration === requestGenerationRef.current) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      // Ignore a request started for a previous open cycle or component
      // instance. It may still settle, but it no longer owns state.
      requestGenerationRef.current += 1;
    };
  }, [open]);

  /**
   * Derived rather than baked in at fetch time: the exclusion and the ordering
   * both have to stay correct when the session the user is in changes while the
   * picker is open, and neither is a reason to hit the bridge again.
   */
  const sessions = useMemo(
    () =>
      fetchedSessions
        .filter((session) => session.id !== currentSessionId)
        .sort((a, b) => activityTimestamp(b) - activityTimestamp(a)),
    [fetchedSessions, currentSessionId],
  );

  /**
   * Removes the row once the provider confirms, and offers to put it back. A
   * refusal (the conversation is open in another tab, say) leaves it listed.
   */
  const archive = async (session: ResumableSession) => {
    if (!onArchive) return;
    setArchiving((current) => new Set(current).add(session.id));
    try {
      await onArchive(session.id, true);
      setFetchedSessions((current) => current.filter((entry) => entry.id !== session.id));
      toast("Removed from the list", {
        description: "The conversation itself is kept.",
        action: {
          label: "Undo",
          onClick: () => {
            void onArchive(session.id, false)
              .then(() =>
                setFetchedSessions((current) =>
                  current.some((entry) => entry.id === session.id)
                    ? current
                    : [...current, session],
                ),
              )
              .catch((err) =>
                toast.error(err instanceof Error ? err.message : "Could not restore the session"),
              );
          },
        },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the session");
    } finally {
      setArchiving((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
  };

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
            <div className="py-8 text-center text-sm text-destructive">{error}</div>
          ) : sessions.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</div>
          ) : (
            <ScrollArea className="h-[300px] overflow-hidden">
              <div className="space-y-1 pr-4">
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    className={cn(
                      "group flex items-start gap-1 rounded-md transition-colors",
                      "hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <button
                      onClick={() => onResume(session.id)}
                      className={cn(
                        "min-w-0 flex-1 rounded-md px-3 py-2 text-left",
                        "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="max-w-full text-sm font-medium break-words whitespace-normal">
                            {session.title || `Session ${shortResumeSessionId(session.id)}`}
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
                              <span className="ml-2 text-yellow-500">• Running</span>
                            )}
                            {session.status === "error" && (
                              <span className="ml-2 text-destructive">• Error</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                    {onArchive && (
                      <button
                        type="button"
                        aria-label="Remove from list"
                        title="Remove from list (the conversation is kept)"
                        disabled={archiving.has(session.id)}
                        onClick={() => void archive(session)}
                        className={cn(
                          "m-1 shrink-0 rounded-md p-1.5 text-muted-foreground",
                          "opacity-0 group-hover:opacity-100 focus:opacity-100",
                          "hover:bg-background hover:text-foreground disabled:opacity-50",
                          "focus:outline-none focus:ring-2 focus:ring-ring",
                        )}
                      >
                        {archiving.has(session.id) ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Archive className="h-4 w-4" />
                        )}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const ACP_RESUME_TOKEN_PREFIX = "acp-session:";

/**
 * A short form of the provider's own session id, for a row with no title.
 *
 * The resume id is not always the provider's id. The ACP bridge hands out a
 * signed `acp-session:<base64url id>.<signature>` token, whose first eight
 * characters read `acp-sess` on every row, and Pi's is the session file's path,
 * `<dir>/<timestamp>_<uuid>.jsonl`. Both carry the provider's id, so show that.
 * The detail beside the label (Pi's first message, a message count) is what
 * tells two untitled rows apart; this only has to differ between them.
 */
export function shortResumeSessionId(id: string): string {
  let ownId = id;
  if (ownId.startsWith(ACP_RESUME_TOKEN_PREFIX)) {
    const token = ownId.slice(ACP_RESUME_TOKEN_PREFIX.length);
    const separator = token.lastIndexOf(".");
    const decoded = decodeBase64Url(separator > 0 ? token.slice(0, separator) : token);
    if (decoded) ownId = decoded;
  }
  const fileName = ownId.split(/[\\/]/).pop() || ownId;
  const stem = fileName.replace(/\.jsonl?$/i, "");
  const short = (stem.slice(stem.lastIndexOf("_") + 1) || stem).slice(0, 8);
  return short || id.slice(0, 8);
}

/** Printable text, or null for anything that is not base64url-encoded text. */
function decodeBase64Url(encoded: string): string | null {
  if (!encoded || encoded.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
    return /^[\x21-\x7e]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Sort key. Unknown timestamps sink to the bottom rather than to 1970. */
function activityTimestamp(session: ResumableSession): number {
  const value = session.activityAt;
  if (value === null || value === undefined || value === "") return 0;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
}
