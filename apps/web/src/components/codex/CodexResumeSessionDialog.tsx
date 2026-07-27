import { useCallback } from "react";
import {
  listSessions,
  lookupSessionStatus,
  type CodexClient,
} from "@/lib/codex-client";
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
    const [sessions, currentStatus] = await Promise.all([
      listSessions(client),
      currentSessionId
        ? lookupSessionStatus(client, currentSessionId).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const currentThreadId =
      currentStatus?.kind === "found" ? currentStatus.session.threadId : undefined;

    return sessions
      .filter((session) => session.id !== currentThreadId)
      .map((session) => ({
        id: session.id,
        title: session.title,
        activityAt: session.updatedAt,
      }));
  }, [client, currentSessionId]);

  return (
    <NativeResumeSessionDialog
      open={open}
      onOpenChange={onOpenChange}
      agentLabel="Codex"
      fetchSessions={fetchSessions}
      onResume={onResume}
    />
  );
}
