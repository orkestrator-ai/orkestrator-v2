import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { AGENT_PLATFORM_LABELS, isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentSuborkView } from "@orkestrator/protocol/suborks";
import { useVirtuosoScrollState } from "@/hooks";
import { toPipelineTranscript } from "@/components/build-pipeline/pipeline-transcript";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { NativeAgentSuborkTranscript } from "@/lib/backend";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { useScopeBackend } from "@/hooks/useScopeBackend";

const messageItemKey = (_index: number, message: NativeMessageType) => message.id;
const SUBORK_FIND = { isActive: false, getSearchText: getNativeMessageSearchText };
const LOADING_TRANSCRIPT = (
  <span className="flex items-center justify-center gap-2">
    <Loader2 className="size-3.5 animate-spin" /> Loading the transcript…
  </span>
);

/**
 * One subork's transcript. The call's row references it in the same
 * content-addressed store a graph step's transcript lives in, so a finished
 * subork reads the same as a running one, and reading touches no provider. It
 * reads again whenever the row says a newer transcript was stored.
 */
function SuborkTranscriptBody({
  environmentId,
  containerId,
  batchId,
  subork,
}: {
  environmentId: string;
  containerId: string | undefined;
  batchId: string;
  subork: NativeAgentSuborkView;
}) {
  const nodeBackend = useScopeBackend();
  const [read, setRead] = useState<NativeAgentSuborkTranscript | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [fromIndex, setFromIndex] = useState(0);
  const revision = subork.transcriptRevision;
  useEffect(() => {
    if (revision === undefined) return;
    let current = true;
    void nodeBackend
      .getNativeAgentSuborkTranscript({
        environmentId,
        batchId,
        suborkId: subork.id,
        fromIndex,
      })
      .then(
        (view) => {
          if (current) {
            setRead(view);
            setError(undefined);
          }
        },
        (reason: unknown) => {
          if (current) setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    return () => {
      current = false;
    };
  }, [environmentId, batchId, subork.id, revision, fromIndex, nodeBackend]);
  const [fallbackCreatedAt] = useState(() => new Date().toISOString());
  const agent = subork.agent;
  const messages = useMemo(
    () =>
      agent && read?.status === "found"
        ? toPipelineTranscript(read.messages, agent, subork.startedAt ?? fallbackCreatedAt)
        : [],
    [agent, read, subork.startedAt, fallbackCreatedAt],
  );
  const { virtuosoRef, scrollProps } = useVirtuosoScrollState({
    isActive: true,
    persistKey: `subork:${batchId}:${subork.id}`,
    environmentId,
    activation: "latest",
  });
  const empty = !agent
    ? (subork.line ?? "This target never started.")
    : revision === undefined
      ? subork.status === "running" || subork.status === "starting"
        ? "This subork is working. Its transcript appears here once the first part is stored."
        : (subork.line ?? "No transcript was stored for this subork.")
      : error
        ? `The transcript could not be read: ${error}`
        : read && read.status !== "found"
          ? "The stored transcript for this subork could not be read."
          : LOADING_TRANSCRIPT;
  const assistantLabel = agent ? AGENT_PLATFORM_LABELS[agent] : "Agent";
  const platform = agent && isAgentPlatform(agent) ? agent : undefined;
  // Stable inputs, so a render here that changes no row leaves the list alone.
  const renderMessage = useCallback(
    (_index: number, message: NativeMessageType, previous: NativeMessageType | null) => (
      <NativeMessage
        message={message}
        previousMessage={previous}
        assistantLabel={assistantLabel}
        containerId={containerId}
        agentExpansionScope={environmentId}
        platform={platform}
      />
    ),
    [assistantLabel, containerId, environmentId, platform],
  );
  const emptyState = useMemo(
    () => (
      <div className="whitespace-pre-wrap break-words px-4 py-12 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    ),
    [empty],
  );
  return (
    <div
      data-testid="subork-transcript"
      className="@container relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {read?.status === "found" && (read.truncated || fromIndex > 0) && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm" role="status">
          <span>
            Partial transcript: messages {read.startIndex + 1}–
            {read.startIndex + read.messages.length} of {read.messageCount}.
          </span>
          {read.messages.length === 0 && (
            <span>This message exceeds the page limit. Next page skips it.</span>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={fromIndex === 0}
            onClick={() => setFromIndex(0)}
          >
            Back to start
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={
              read.startIndex !== fromIndex ||
              read.startIndex + read.messages.length >= read.messageCount
            }
            onClick={() => setFromIndex(read.startIndex + Math.max(1, read.messages.length))}
          >
            Next page
          </Button>
        </div>
      )}
      {error && messages.length > 0 && (
        <p role="alert">The transcript could not be read: {error}</p>
      )}
      <VirtualizedMessageList
        messages={messages}
        computeItemKey={messageItemKey}
        resolvePreviousMessage={findPreviousNativeMessage}
        renderMessage={renderMessage}
        emptyState={emptyState}
        scrollProps={scrollProps}
        virtuosoRef={virtuosoRef}
        find={SUBORK_FIND}
      />
    </div>
  );
}

export function SuborkTranscriptDialog({
  environmentId,
  containerId,
  batchId,
  subork,
  onClose,
}: {
  environmentId: string;
  containerId: string | undefined;
  batchId: string;
  subork: NativeAgentSuborkView;
  onClose: () => void;
}) {
  const facts = [
    subork.agent ? AGENT_PLATFORM_LABELS[subork.agent] : undefined,
    subork.modelLabel ?? subork.model,
    subork.tokens !== undefined ? `${subork.tokens.toLocaleString()} tokens` : undefined,
    subork.readOnly === "advisory" ? "read-only is advisory on this agent" : undefined,
    subork.guarded ? "a change to the workspace fails its answer" : undefined,
  ].filter(Boolean);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="3xl" className="flex h-[85dvh] flex-col gap-3">
        <DialogHeader className="min-w-0">
          <DialogTitle className="truncate">{subork.name}</DialogTitle>
          {/* Wraps: the read-only facts are the part a narrow window must not cut. */}
          <DialogDescription className="break-words">
            {facts.join(" · ") || "Subork"}
          </DialogDescription>
        </DialogHeader>
        <SuborkTranscriptBody
          environmentId={environmentId}
          containerId={containerId}
          batchId={batchId}
          subork={subork}
        />
      </DialogContent>
    </Dialog>
  );
}
