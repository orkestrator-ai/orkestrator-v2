import { useEffect, useMemo, useState } from "react";
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
import { getNativeAgentSuborkTranscript, type NativeAgentSuborkTranscript } from "@/lib/backend";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";

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
  const [read, setRead] = useState<NativeAgentSuborkTranscript | undefined>();
  const [error, setError] = useState<string | undefined>();
  const revision = subork.transcriptRevision;
  useEffect(() => {
    if (revision === undefined) return;
    let current = true;
    void getNativeAgentSuborkTranscript({ environmentId, batchId, suborkId: subork.id }).then(
      (view) => {
        if (current) setRead(view);
      },
      (reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [environmentId, batchId, subork.id, revision]);
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
  const empty = !agent ? (
    (subork.line ?? "This target never started.")
  ) : revision === undefined ? (
    subork.status === "running" || subork.status === "starting" ? (
      "This subork is working. Its transcript appears here once the first part is stored."
    ) : (
      (subork.line ?? "No transcript was stored for this subork.")
    )
  ) : error ? (
    `The transcript could not be read: ${error}`
  ) : read && read.status !== "found" ? (
    "The stored transcript for this subork could not be read."
  ) : (
    <span className="flex items-center justify-center gap-2">
      <Loader2 className="size-3.5 animate-spin" /> Loading the transcript…
    </span>
  );
  const assistantLabel = agent ? AGENT_PLATFORM_LABELS[agent] : "Agent";
  return (
    <div
      data-testid="subork-transcript"
      className="@container relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <VirtualizedMessageList
        messages={messages}
        computeItemKey={(_index, message) => message.id}
        resolvePreviousMessage={findPreviousNativeMessage}
        renderMessage={(_index, message, previous) => (
          <NativeMessage
            message={message}
            previousMessage={previous}
            assistantLabel={assistantLabel}
            containerId={containerId}
            agentExpansionScope={environmentId}
            platform={agent && isAgentPlatform(agent) ? agent : undefined}
          />
        )}
        emptyState={
          <div className="whitespace-pre-wrap break-words px-4 py-12 text-center text-sm text-muted-foreground">
            {empty}
          </div>
        }
        scrollProps={scrollProps}
        virtuosoRef={virtuosoRef}
        find={{ isActive: false, getSearchText: getNativeMessageSearchText }}
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
  ].filter(Boolean);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="3xl" className="flex h-[85dvh] flex-col gap-3">
        <DialogHeader className="min-w-0">
          <DialogTitle className="truncate">{subork.name}</DialogTitle>
          <DialogDescription className="truncate">
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
