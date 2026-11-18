import { useState } from "react";
import { NativeStyleChatPanel } from "@/components/kanban/FeaturesView";
import { ComposeBar } from "@/components/terminal/ComposeBar";

export function installFocusHairlineFixture() {
  window.orkestrator = {
    invoke: async (command: string) => {
      throw new Error(`Unexpected focus fixture command: ${command}`);
    },
    listen: () => () => {},
    clipboard: {
      readText: async () => "",
      writeText: async () => {},
      readImage: async () => null,
      writeImage: async () => {},
    },
    process: { exit: async () => {} },
    window: { startDragging: async () => {} },
  };
}

export function FocusHairlineFixture() {
  const [draft, setDraft] = useState("");
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <NativeStyleChatPanel
        messages={[]}
        stripState={(content) => content}
        persistKey="feature-focus-fixture"
        draft={draft}
        setDraft={setDraft}
        isRunning={false}
        loadingText="Loading feature plan"
        placeholder="Describe the feature or answer Codex..."
        onSend={() => {}}
      />
      <div className="relative h-28 shrink-0">
        <ComposeBar
          sessionKey="terminal-focus-fixture"
          isOpen
          onClose={() => {}}
          onSend={() => {}}
          containerId={null}
        />
      </div>
    </main>
  );
}
