import { useState } from "react";
import { NativeChatShell } from "../../apps/web/src/components/chat/NativeChatShell";
import { useVirtuosoScrollState } from "../../apps/web/src/hooks/useVirtuosoScrollState";

const messages = Array.from({ length: 100 }, (_, index) => ({
  id: `notice-row-${index}`,
  role: "assistant" as const,
  content: `Transcript row ${index + 1}. A saved response that remains readable while the session reconnects.`,
  createdAt: "2026-11-09T10:00:00Z",
  parts: [
    {
      type: "text" as const,
      content: `Transcript row ${index + 1}. A saved response that remains readable while the session reconnects.`,
    },
  ],
}));

/** Real virtualizer, scroll controller and ResizeObserver; only connection state is synthetic. */
export function NativeDockNoticeFixture() {
  const [notice, setNotice] = useState("none");
  const [tall, setTall] = useState(false);
  const [centered, setCentered] = useState(false);
  const { isAtBottom, scrollToBottom, scrollProps, virtuosoRef } = useVirtuosoScrollState();
  return (
    <main className="flex h-dvh flex-col bg-background text-foreground">
      <nav aria-label="Fixture controls" className="flex shrink-0 flex-wrap gap-2 p-2">
        {["none", "error", "desync", "refresh"].map((value) => (
          <button key={value} onClick={() => setNotice(value)}>
            {value}
          </button>
        ))}
        <button onClick={() => setTall((value) => !value)}>Grow dock</button>
        <button onClick={() => setCentered((value) => !value)}>Center composer</button>
      </nav>
      <section className="min-h-0 flex-1" data-testid="notice-shell">
        <NativeChatShell
          agentLabel="Codex"
          platform="codex"
          agentExpansionScope="fixture-dock-notice"
          isActive
          connectionState={notice === "error" ? "error" : "connected"}
          displayAvailable
          sessionEstablished
          transcriptRefreshing={notice === "refresh"}
          desynced={notice === "desync"}
          onRetry={() => setNotice("none")}
          errorMessage="Unable to reconnect. The saved conversation remains readable."
          messages={messages}
          isLoading={false}
          elapsedSeconds={null}
          finalElapsedSeconds={null}
          centerCompose={centered}
          composer={
            <textarea
              aria-label="Prompt"
              className="w-full rounded-md border bg-background p-3"
              style={{ height: tall ? 180 : 72 }}
            />
          }
          isAtBottom={isAtBottom}
          scrollToBottom={scrollToBottom}
          scrollProps={scrollProps}
          virtuosoRef={virtuosoRef}
        />
      </section>
    </main>
  );
}
