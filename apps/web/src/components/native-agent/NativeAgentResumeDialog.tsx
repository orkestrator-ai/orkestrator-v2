import { useEffect, useState } from "react";
import type { NativeAgentResumeEntry } from "@orkestrator/protocol/native-agent";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function NativeAgentResumeDialog({
  open,
  onOpenChange,
  currentSessionId,
  loadSessions,
  onResume,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSessionId?: string;
  loadSessions: () => Promise<NativeAgentResumeEntry[]>;
  onResume: (session: NativeAgentResumeEntry) => Promise<void>;
}) {
  const [sessions, setSessions] = useState<NativeAgentResumeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadSessions()
      .then((next) => { if (!cancelled) setSessions(next); })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadSessions, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Resume session</DialogTitle>
          <DialogDescription>
            Replace this tab’s current session with an earlier conversation.
          </DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No resumable sessions found.</p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {sessions.map((session) => (
              <Button
                key={session.sessionId}
                type="button"
                variant="outline"
                disabled={pendingId !== null || session.sessionId === currentSessionId}
                className="h-auto w-full justify-start px-3 py-2 text-left"
                onClick={() => {
                  setPendingId(session.sessionId);
                  setError(null);
                  void onResume(session)
                    .then(() => onOpenChange(false))
                    .catch((caught) => setError(
                      caught instanceof Error ? caught.message : String(caught),
                    ))
                    .finally(() => setPendingId(null));
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate">{session.title ?? "Untitled session"}</span>
                  {session.updatedAt ? (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {new Date(session.updatedAt).toLocaleString()}
                    </span>
                  ) : null}
                </span>
              </Button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
