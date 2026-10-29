import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NodeActivation } from "@orkestrator/protocol/graphs/run";
import { useVirtuosoScrollState } from "@/hooks";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";
import { findNativeAgentAdapter } from "@/components/native-agent/adapter";
import { toPipelineTranscript } from "@/components/build-pipeline/pipeline-transcript";
import { useWorkflowTranscriptArtifacts } from "@/hooks/useWorkflowTranscriptArtifacts";
import { RichTranscriptScopeContext } from "@/lib/chat/rich-identity";
import { graphRunCacheKey, useGraphRunStore } from "@/stores/graphRunStore";

/**
 * An agent activation's transcript, as the build pipeline's stage transcript
 * (`PipelineSessionTranscript`) shows a stage: the same provider-message
 * projection (`toPipelineTranscript`), message renderer, virtualization and
 * in-transcript find. The run record references the transcript in the
 * content-addressed transcript store (a `PipelineTranscriptReference`); the
 * body is read with `graph_run_transcript` whenever that reference moves.
 */
export function GraphActivationTranscript({
  runId,
  environmentId,
  containerId,
  activation,
  isActive,
  ownsGlobalShortcuts,
}: {
  runId: string;
  environmentId: string;
  containerId: string | undefined;
  activation: NodeActivation;
  isActive: boolean;
  ownsGlobalShortcuts: boolean;
}) {
  const session = activation.session;
  const reference = session?.transcript;
  const revision = reference?.manifestRevision ?? null;
  const key = graphRunCacheKey(runId, activation.key);
  const entry = useGraphRunStore((state) => state.transcripts.get(key));
  const loadTranscript = useGraphRunStore((state) => state.loadTranscript);
  useEffect(() => {
    if (!isActive || !reference) return;
    void loadTranscript(runId, activation.key, revision);
  }, [isActive, reference, revision, runId, activation.key, loadTranscript]);

  const [fallbackCreatedAt] = useState(() => new Date().toISOString());
  const agent = session?.agent;
  const messages = entry?.view?.status === "found" ? entry.view.messages : undefined;
  const transcript = useMemo(
    () =>
      agent
        ? toPipelineTranscript(
            messages,
            agent,
            session?.startedAt ?? activation.startedAt ?? fallbackCreatedAt,
          )
        : [],
    [agent, messages, session?.startedAt, activation.startedAt, fallbackCreatedAt],
  );
  const sessionKey = session?.sessionKey;
  const providerSessionId = session?.providerSessionId;
  const conversation = useMemo(
    () =>
      sessionKey
        ? {
            environmentId,
            conversationKey: sessionKey,
            generation: providerSessionId ?? sessionKey,
          }
        : null,
    [environmentId, sessionKey, providerSessionId],
  );
  const { scope, messages: shown } = useWorkflowTranscriptArtifacts(conversation, transcript, {
    canLoadEarlier: false,
  });
  const { virtuosoRef, scrollProps } = useVirtuosoScrollState({
    isActive,
    persistKey: `graph-run:${runId}:${activation.key}`,
    environmentId,
    activation: "latest",
  });
  const agentLabel = (agent && findNativeAgentAdapter(agent)?.label) ?? agent ?? "Agent";
  const running = activation.state === "running" || activation.state === "admitting";

  const empty = !session ? (
    "This node has no agent session."
  ) : !reference ? (
    running ? (
      "This node is running. Its transcript appears here once the first part is stored."
    ) : (
      "No transcript was stored for this node."
    )
  ) : entry?.status === "error" ? (
    `The transcript could not be read: ${entry.error}`
  ) : entry?.view?.status === "missing" || entry?.view?.status === "unavailable" ? (
    "The stored transcript for this node could not be read."
  ) : (
    <span className="flex items-center justify-center gap-2">
      <Loader2 className="size-3.5 animate-spin" /> Loading the transcript…
    </span>
  );

  return (
    <div
      data-testid="graph-run-transcript"
      className="@container relative flex min-h-[24rem] min-w-0 flex-1 flex-col"
    >
      <RichTranscriptScopeContext.Provider value={scope}>
        <VirtualizedMessageList
          messages={shown}
          computeItemKey={(_index, message) => message.id}
          resolvePreviousMessage={findPreviousNativeMessage}
          renderMessage={(_index, message, previous) => (
            <NativeMessage
              message={message}
              previousMessage={previous}
              assistantLabel={agentLabel}
              containerId={containerId}
              agentExpansionScope={environmentId}
              platform={agent && isAgentPlatform(agent) ? agent : undefined}
            />
          )}
          emptyState={
            <div className="py-12 text-center text-sm text-muted-foreground">{empty}</div>
          }
          header={
            (reference && !reference.complete) ||
            (entry?.view?.status === "found" && entry.view.truncated) ? (
              <p className="px-3 py-2 text-center text-[11px] text-muted-foreground">
                {reference && !reference.complete
                  ? `${reference.omittedMessages ?? "Some"} messages were not kept in the stored transcript because of its size limit.`
                  : "Only the start of this transcript is shown: it is longer than one read."}
              </p>
            ) : undefined
          }
          scrollProps={scrollProps}
          virtuosoRef={virtuosoRef}
          find={{
            isActive: ownsGlobalShortcuts && isActive,
            getSearchText: getNativeMessageSearchText,
          }}
        />
      </RichTranscriptScopeContext.Provider>
    </div>
  );
}
