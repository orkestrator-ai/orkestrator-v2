import { useCallback } from "react";
import { listSessions, type ClaudeClient } from "@/lib/claude-client";
import {
  NativeResumeSessionDialog,
  type ResumableSession,
} from "@/components/chat/NativeResumeSessionDialog";

interface ResumeSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: ClaudeClient;
  onResume: (sessionId: string) => void;
  currentSessionId?: string;
}

export function ResumeSessionDialog({
  open,
  onOpenChange,
  client,
  onResume,
  currentSessionId,
}: ResumeSessionDialogProps) {
  const fetchSessions = useCallback(async (): Promise<ResumableSession[]> => {
    const sessions = await listSessions(client);
    return sessions.map((session) => ({
      id: session.id,
      title: session.title,
      activityAt: session.lastActivity,
      status: session.status,
    }));
  }, [client]);

  return (
    <NativeResumeSessionDialog
      open={open}
      onOpenChange={onOpenChange}
      agentLabel="Claude"
      fetchSessions={fetchSessions}
      onResume={onResume}
      currentSessionId={currentSessionId}
    />
  );
}
