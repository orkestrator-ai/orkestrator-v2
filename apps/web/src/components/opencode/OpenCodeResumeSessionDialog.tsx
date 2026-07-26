import { useCallback } from "react";
import { listSessions, type OpencodeClient } from "@/lib/opencode-client";
import {
  NativeResumeSessionDialog,
  type ResumableSession,
} from "@/components/chat/NativeResumeSessionDialog";

interface OpenCodeResumeSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: OpencodeClient;
  onResume: (sessionId: string) => void;
  currentSessionId?: string;
}

export function OpenCodeResumeSessionDialog({
  open,
  onOpenChange,
  client,
  onResume,
  currentSessionId,
}: OpenCodeResumeSessionDialogProps) {
  const fetchSessions = useCallback(async (): Promise<ResumableSession[]> => {
    const sessions = await listSessions(client);
    return sessions.map((session) => ({
      id: session.id,
      title: session.title,
      // Ordered on last activity, not creation time.
      activityAt: session.updatedAt,
    }));
  }, [client]);

  return (
    <NativeResumeSessionDialog
      open={open}
      onOpenChange={onOpenChange}
      agentLabel="OpenCode"
      fetchSessions={fetchSessions}
      onResume={onResume}
      currentSessionId={currentSessionId}
    />
  );
}
