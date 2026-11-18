import { useState } from "react";
import {
  DEFAULT_AGENT_MESSAGING_SETTINGS,
  type AgentMailConversationList,
} from "@orkestrator/protocol/agent-mail";
import { AgentMailPanel } from "@/components/agent-mail/AgentMailPanel";
import { NativeStyleChatPanel } from "@/components/kanban/FeaturesView";
import { ComposeBar } from "@/components/terminal/ComposeBar";
import { Button } from "@/components/ui/button";
import { agentMailStore } from "@/stores/agentMailStore";
import { configStore } from "@/stores/configStore";
import { appCommandStore } from "@/test/app-command-store";

const conversations: AgentMailConversationList = {
  revision: 1,
  conversations: [
    {
      key: "user\nfixture-agent",
      participants: [
        { key: "user", kind: "user", displayName: "You", agent: null, canReceive: false },
        {
          key: "fixture-agent",
          kind: "agent",
          displayName: "Fixture agent",
          agent: "codex",
          canReceive: true,
        },
      ],
      lastMessage: {
        version: 1,
        id: "fixture-message",
        threadId: "fixture-thread",
        requestId: "fixture-request",
        createdAt: "2026-11-18T00:00:00Z",
        from: { kind: "user" },
        toEnvironmentId: "fixture-environment",
        toTabId: "fixture-tab",
        toIncarnationId: "fixture-incarnation",
        trust: "user",
        bodyBytes: 13,
        injectDepth: 0,
        threadDepth: 0,
        placement: "stored",
        revision: 1,
      },
      lastPreview: "Fixture draft",
      messageCount: 1,
      attentionCount: 0,
    },
  ],
};

export function installFocusHairlineFixture() {
  window.orkestrator = {
    invoke: async <T,>(command: string) => {
      if (command === "list_agent_mail_conversations") return conversations as T;
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
  const config = appCommandStore(configStore).getState();
  config.setConfig({
    ...config.config,
    global: {
      ...config.config.global,
      agentMessaging: { ...DEFAULT_AGENT_MESSAGING_SETTINGS, enabled: true },
    },
  });
}

export function FocusHairlineFixture() {
  const [draft, setDraft] = useState("");
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <Button onClick={() => appCommandStore(agentMailStore).getState().openPanel({})}>
        Open agent mail
      </Button>
      <AgentMailPanel />
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
