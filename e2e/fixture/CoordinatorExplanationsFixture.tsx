import { useRef, useState } from "react";
import { NativeComposeDock } from "../../apps/web/src/components/chat/NativeComposeDock";
import { NativeComposeBar } from "../../apps/web/src/components/chat/NativeComposeBar";
import type { MentionableInputRef } from "../../apps/web/src/components/chat/MentionableInput";
import { AgentModelPicker } from "../../apps/web/src/components/chat/AgentModelPicker";
import { COORDINATOR_COMPOSER_PLACEHOLDER } from "../../apps/web/src/components/projects/CoordinatorPanelNotices";
import { CoordinatorIntroCard } from "../../apps/web/src/components/projects/CoordinatorIntro";
import { CoordinatorToolbar } from "../../apps/web/src/components/projects/CoordinatorToolbar";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";

const snapshot: CoordinatorSnapshot = {
  workspace: {
    version: 1,
    id: "fixture-coordinator",
    projectId: "fixture-project",
    executionPolicy: "coordinator-read-only",
    lifecycleState: "ready",
    conversations: [],
    selectedConversationId: null,
    repositoryContextRevision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
  projectPath: "/fixture",
  controlMcp: { enabled: true, running: true, error: null },
  workflows: [],
  providerAvailability: { codex: { tier: "enforced", available: true, delegation: true } },
};

export function CoordinatorExplanationsFixture() {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const inputRef = useRef<MentionableInputRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <CoordinatorToolbar
        snapshot={snapshot}
        git={null}
        gitBusy={false}
        fetching={false}
        conversationBusy={false}
        freshness={null}
        runGit={async () => {}}
        prepareSwitch={async () => {}}
        activeTurn={null}
        selectedAgent="codex"
        paused={false}
        onPause={() => {}}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <NativeComposeDock centered>
          <CoordinatorIntroCard />
          <NativeComposeBar
            inputRef={inputRef}
            inputContainerRef={containerRef}
            text={text}
            mentions={[]}
            onTextAndMentionsChange={setText}
            onCursorPositionChange={() => {}}
            onKeyDown={() => {}}
            attachments={[]}
            onRemoveAttachment={() => {}}
            placeholder={COORDINATOR_COMPOSER_PLACEHOLDER}
            primaryControls={
              <AgentModelPicker
                models={[{ platform: "codex", id: "model", label: "Fixture model" }]}
                enabledPlatforms={["codex", "cursor", "pi"]}
                selectedPlatform="codex"
                reasoningOptions={[]}
                selectedModelId="model"
                selectedModelLabel="Fixture model"
                onModelChange={() => {}}
                platformBadges={{
                  codex: {
                    label: "Read-only · Enforced",
                    description: "Enforced",
                    tone: "positive",
                  },
                  cursor: {
                    label: "Read-only · Provider-configured",
                    description: "Provider-configured",
                    tone: "caution",
                  },
                  pi: { label: "Read-only · Advisory", description: "Advisory", tone: "caution" },
                }}
              />
            }
            onSend={() => setSent(true)}
          />
          <button onClick={() => setText("Explain this project")}>Explain this project</button>
          {sent ? <output>Message sent</output> : null}
        </NativeComposeDock>
      </div>
    </main>
  );
}
