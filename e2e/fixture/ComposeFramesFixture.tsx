import { useState } from "react";
import { NativeStyleChatPanel } from "../../apps/web/src/components/kanban/FeaturesView";
import { ComposeBar } from "../../apps/web/src/components/terminal/ComposeBar";
import type { FeaturePlanMessage } from "../../apps/web/src/lib/backend/kanban";

const messages: FeaturePlanMessage[] = Array.from({ length: 30 }, (_, index) => ({
  id: `feature-message-${index}`,
  role: index % 2 ? "assistant" : "user",
  content:
    index === 29
      ? "Final response in the Features transcript."
      : `Feature planning message ${index + 1}.`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
}));

const keepMessage = (content: string) => content;

export function FeaturesComposeFixture() {
  const [draft, setDraft] = useState("");
  return (
    <main className="flex h-dvh flex-col">
      <NativeStyleChatPanel
        messages={messages}
        stripState={keepMessage}
        persistKey="features-compose-fixture"
        draft={draft}
        setDraft={setDraft}
        isRunning={false}
        loadingText="Planning..."
        placeholder="Describe the feature"
        onSend={() => setDraft("")}
      />
    </main>
  );
}

export function TerminalComposeFixture() {
  return (
    <main data-testid="terminal-pane" className="relative h-dvh bg-background">
      <ComposeBar
        sessionKey="terminal-compose-fixture"
        containerId={null}
        isOpen
        className="bottom-[calc(3.5rem+env(safe-area-inset-bottom))]"
        onClose={() => {}}
        onSend={() => {}}
      />
    </main>
  );
}
