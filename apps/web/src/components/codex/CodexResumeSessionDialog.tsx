import { useCallback } from "react";
import { listSessions, type CodexClient } from "@/lib/codex-client";
import {
  NativeResumeSessionDialog,
  type ResumableSession,
} from "@/components/chat/NativeResumeSessionDialog";

interface CodexResumeSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: CodexClient;
  onResume: (threadId: string) => void;
  currentSessionId?: string;
}

export function CodexResumeSessionDialog({
  open,
  onOpenChange,
  client,
  onResume,
  currentSessionId,
}: CodexResumeSessionDialogProps) {
  const fetchSessions = useCallback(async (): Promise<ResumableSession[]> => {
    const sessions = await listSessions(client);
    return sessions.map((session) => ({
      id: session.id,
      title: session.title,
      activityAt: session.updatedAt,
    }));
  }, [client]);

  return (
    <NativeResumeSessionDialog
      open={open}
      onOpenChange={onOpenChange}
      agentLabel="Codex"
      fetchSessions={fetchSessions}
      onResume={onResume}
      currentSessionId={currentSessionId}
    />
  );
}
