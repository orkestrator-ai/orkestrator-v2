import { useRef } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { renderAgentMailCarrier, type AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import { VirtualizedMessageList } from "../../apps/web/src/components/chat/VirtualizedMessageList";
import { getNativeMessageSearchText } from "../../apps/web/src/components/chat/native-message-search";
import { toPipelineTranscript } from "../../apps/web/src/components/build-pipeline/pipeline-transcript";

function message(overrides: Partial<AgentMailMessage>): AgentMailMessage {
  return {
    version: 1,
    id: "mail",
    threadId: "mail",
    requestId: "request",
    createdAt: "2026-11-04T03:00:00.000Z",
    from: {
      kind: "node",
      nodeId: "bk_mini",
      nodeName: "mini",
      role: "coordinator",
      projectId: "project",
      environmentId: "coordinator:c:v",
      tabId: "coordinator-tab",
      title: null,
    },
    toEnvironmentId: "env",
    toTabId: "pipeline-worker:pipeline:build:0:key",
    toIncarnationId: "incarnation",
    body: "",
    bodyBytes: 0,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    placement: "injected",
    revision: 1,
    ...overrides,
  };
}

function row(id: string, role: string, content: string, minute: number) {
  const createdAt = `2026-11-04T03:${String(minute).padStart(2, "0")}:00.000Z`;
  return { id, role, content, parts: [{ type: "text", content }], createdAt };
}

// A worker's stored transcript, as the provider echoed each row: the prompts
// are the delivery envelopes the backend really writes.
const STORED_ROWS = [
  row("build-prompt", "user", "Build the ticket.", 0),
  row("first-update", "assistant", "Reading the parser and its tests.", 1),
  row(
    "steered-mail",
    "user",
    renderAgentMailCarrier(
      message({
        id: "steered",
        subject: "Scope change",
        body: "Please also cover escaped quotes in the tokenizer.\n\nThe failing input is in the ticket.",
      }),
    ),
    2,
  ),
  row("second-update", "assistant", "Covering escaped quotes as well.", 3),
  row(
    "mail-turn",
    "user",
    [
      renderAgentMailCarrier(
        message({
          id: "peer-note",
          from: {
            kind: "tab",
            projectId: "project",
            environmentId: "env-other",
            tabId: "startup-agent",
            incarnationId: "incarnation",
            agent: "codex",
            title: "Codex 1",
          },
          subject: "Heads up",
          body: "I renamed `tokenize` on my branch.",
        }),
      ),
      '<orkestrator-peer-message version="1">\n<orkestrator-peer-payload-json>\n{not json}\n</orkestrator-peer-payload-json>\nInstructions for the agent.\n</orkestrator-peer-message>',
    ].join("\n\n"),
    4,
  ),
  row("final-update", "assistant", "Done. All parser tests pass.", 5),
  row("person", "user", "Why does <orkestrator-peer-message> appear in the old transcript?", 6),
];

export function PipelineWorkerMailFixture() {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const rows = toPipelineTranscript(STORED_ROWS, "claude", "2026-11-04T03:00:00.000Z");
  return (
    <div className="@container mx-auto flex min-h-screen w-full max-w-3xl flex-col bg-background p-2 text-foreground">
      <div data-testid="worker-transcript" className="flex flex-col" style={{ height: 760 }}>
        <VirtualizedMessageList
          messages={rows}
          computeItemKey={(_, item) => item.id}
          renderMessage={(_, item) => (
            <NativeMessage message={item} agentExpansionScope="worker-fixture" />
          )}
          virtuosoRef={virtuosoRef}
          scrollProps={{
            followOutput: () => false,
            atBottomStateChange: () => undefined,
            atBottomThreshold: 50,
            restoreStateFrom: undefined,
          }}
          find={{ isActive: true, getSearchText: getNativeMessageSearchText }}
        />
      </div>
    </div>
  );
}
