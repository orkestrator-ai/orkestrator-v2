import { useConversationScrollTarget } from "../../apps/web/src/components/native-agent/useConversationScrollTarget";
import { useConversationScrollTargetStore } from "../../apps/web/src/stores/conversationScrollTargetStore";
import { useScopesWithCommandFallback } from "../../apps/web/src/lib/node-scope/providers";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import { NativeChatShell } from "../../apps/web/src/components/chat/NativeChatShell";
import { useVirtuosoScrollState } from "../../apps/web/src/hooks/useVirtuosoScrollState";
import { coordinatorActionCards } from "../../apps/web/src/components/projects/coordinator-action-cards";
import type { NativeMessage } from "../../apps/web/src/lib/chat/native-message-types";
import { useMemo, useState } from "react";
import { CoordinatorActionsPanel } from "../../apps/web/src/components/projects/CoordinatorActionsPanel";
import {
  FloatingNotice,
  FloatingNoticeLayer,
} from "../../apps/web/src/components/ui/floating-notice";

export function CoordinatorActionsFixture() {
  const [anchor, setAnchor] = useState("");
  return (
    <div className="relative h-screen bg-background text-foreground">
      <FloatingNoticeLayer columnRem={56}>
        <FloatingNotice tone="info" label="Agent mail" summary="One message waiting">
          One message waiting
        </FloatingNotice>
        <CoordinatorActionsPanel
          cards={[
            ...coordinatorActionCards([
              {
                id: "pr-notice",
                createdAt: "2026-11-09",
                role: "user",
                content: "",
                parts: [],
                peerMail: {
                  messageId: "pr-notice",
                  kind: "notice",
                  sender: "System",
                  warning: "",
                  subject: "Pull request Search is ready to merge",
                  body: "Pull request: https://github.com/org/repo/pull/42",
                  notice: {
                    resource: { kind: "pull-request", id: "env", label: "Search" },
                    state: "pr-merged",
                    tone: "success",
                    pullRequest: {
                      url: "https://github.com/org/repo/pull/42",
                      number: 42,
                      title: "Improve search and filters",
                    },
                  },
                },
              } as NativeMessage,
            ]),
            {
              id: "topic",
              anchorId: "user",
              index: 0,
              kind: "topic",
              title: "Search",
              done: false,
            },
            {
              id: "question",
              anchorId: "assistant",
              index: 1,
              kind: "question",
              title: "Which option?",
              done: false,
            },
          ]}
          onNavigate={setAnchor}
        />
        <main className="mx-auto max-w-[56rem] p-8">
          <h1>Coordinator conversation</h1>
          <button type="button">Transcript control</button>
          <output data-testid="anchor">{anchor}</output>
        </main>
      </FloatingNoticeLayer>
    </div>
  );
}

/** Exercises the production shell and viewport measurement rather than prebuilt cards. */
export function CoordinatorActionsTranscriptFixture() {
  const navigation = useVirtuosoScrollState();
  const nodeId = useScopesWithCommandFallback().scope.nodeId;
  const [anchor, setAnchor] = useState("");
  const [done, setDone] = useState(false);
  const messages = useMemo<NativeMessage[]>(
    () =>
      Array.from({ length: 50 }, (_, index) => ({
        id: `row-${index}`,
        role: "assistant",
        createdAt: "2026-11-09",
        content: `Conversation row ${index}`,
        parts:
          index === 5 || index === 40
            ? [
                {
                  type: "tool-invocation",
                  content: "",
                  toolName: "orkestrator_mark_question",
                  toolState: "success",
                  toolArgs: { title: `Question at ${index}` },
                },
              ]
            : [{ type: "text", content: `Conversation row ${index}` }],
      })),
    [],
  );
  const highlightedMessageId = useConversationScrollTarget({
    environmentId: "actions-fixture",
    tabId: "coordinator",
    isActive: true,
    messages,
    transcriptSettled: true,
    scrollToIndex: navigation.scrollToIndex,
  });
  const interaction: AgentInteractionRequest = {
    version: 1,
    id: "live-request",
    provider: "codex",
    kind: "question",
    origin: "interactive-native",
    sessionId: "test",
    revision: done ? 2 : 1,
    state: done ? "resolved" : "pending",
    createdAt: Date.parse("2026-11-09"),
    updatedAt: Date.parse("2026-11-09"),
    presentation: { title: "Live blocking question", questions: [] },
  };
  return (
    <div className="relative flex h-screen flex-col">
      <FloatingNoticeLayer columnRem={56}>
        <button onClick={() => navigation.scrollToIndex(0)}>Read start</button>
        <button onClick={() => navigation.scrollToIndex(49)}>Read end</button>
        <button onClick={() => setDone(true)}>Answer question</button>
        <output data-testid="anchor">{anchor}</output>
        <NativeChatShell
          agentLabel="Codex"
          platform="codex"
          isActive
          agentExpansionScope="fixture"
          connectionState="connected"
          onRetry={() => {}}
          messages={messages}
          isLoading={false}
          elapsedSeconds={null}
          finalElapsedSeconds={null}
          centerCompose={false}
          composer={<textarea aria-label="Prompt" />}
          isAtBottom={navigation.isAtBottom}
          scrollToBottom={navigation.scrollToBottom}
          scrollProps={navigation.scrollProps}
          virtuosoRef={navigation.virtuosoRef}
          highlightedMessageId={highlightedMessageId}
          coordinatorInteractions={[interaction]}
          coordinatorNavigate={(id) => {
            setAnchor(id);
            useConversationScrollTargetStore
              .getState()
              .request(
                { nodeId, environmentId: "actions-fixture", tabId: "coordinator" },
                { messageId: id },
              );
          }}
        />
      </FloatingNoticeLayer>
    </div>
  );
}
