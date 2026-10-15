import { useEffect, useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import {
  CoordinatorPaneTree,
  SortableCoordinatorTab,
} from "../../apps/web/src/components/projects/CoordinatorPaneTree";
import { NativeChatShell } from "../../apps/web/src/components/chat/NativeChatShell";
import { NativeComposeBar } from "../../apps/web/src/components/chat/NativeComposeBar";
import type { MentionableInputRef } from "../../apps/web/src/components/chat/MentionableInput";
import { useEscapeToStop } from "../../apps/web/src/hooks/useEscapeToStop";
import {
  focusCoordinatorPane,
  focusedCoordinatorConversationId,
  reconcileCoordinatorLayout,
  sanitizeCoordinatorPaneLayout,
  type CoordinatorPaneLayout,
} from "../../apps/web/src/lib/coordinator-pane-layout";

const TITLES: Record<string, string> = {
  main: "Coordinator",
  "side-1": "Side 1",
  "side-2": "Side 2",
};
const STORAGE_KEY = "fixture-coordinator-panes";

/** Production composer, Find, and Escape listeners, with deterministic turn state. */
function Conversation({ id, focused }: { id: string; focused: boolean }) {
  const [text, setText] = useState("");
  const [stops, setStops] = useState(0);
  const inputRef = useRef<MentionableInputRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  useEscapeToStop({
    isActive: focused,
    isLoading: true,
    scopeRef: containerRef,
    onStop: () => setStops((count) => count + 1),
  });
  return (
    <section aria-label={`${TITLES[id]} conversation`} data-agent-scope="" className="h-full">
      <output aria-label={`${TITLES[id]} stops`}>{stops}</output>
      <NativeChatShell
        agentLabel="Codex"
        platform="codex"
        agentExpansionScope={`fixture-${id}`}
        isActive
        ownsGlobalShortcuts={focused}
        connectionState="connected"
        displayAvailable
        sessionEstablished
        transcriptSettled
        onRetry={() => {}}
        messages={[]}
        isLoading={false}
        elapsedSeconds={null}
        finalElapsedSeconds={null}
        centerCompose={false}
        isAtBottom
        scrollToBottom={() => {}}
        virtuosoRef={virtuosoRef}
        scrollProps={{
          followOutput: () => false,
          atBottomStateChange: () => {},
          atBottomThreshold: 100,
          restoreStateFrom: undefined,
        }}
        composer={
          <NativeComposeBar
            attachments={[]}
            onRemoveAttachment={() => {}}
            inputRef={inputRef}
            inputContainerRef={containerRef}
            text={text}
            mentions={[]}
            onTextAndMentionsChange={setText}
            onCursorPositionChange={() => {}}
            onKeyDown={() => {}}
            placeholder={`Message ${TITLES[id]}`}
            primaryControls={null}
            onSend={() => {}}
          />
        }
      />
    </section>
  );
}

/** Real dnd-kit, persistence, and native chat controls; selection is a fixture backend stand-in. */
export function CoordinatorPaneTreeFixture() {
  const [layout, setLayout] = useState<CoordinatorPaneLayout>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return (
      (saved && sanitizeCoordinatorPaneLayout(JSON.parse(saved))) ||
      reconcileCoordinatorLayout(null, Object.keys(TITLES))
    );
  });
  const selected = focusedCoordinatorConversationId(layout);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  }, [layout]);
  return (
    <main className="flex h-screen w-screen flex-col bg-background text-foreground">
      <output aria-label="Selected conversation">{selected}</output>
      <div className="min-h-0 flex-1">
        <CoordinatorPaneTree
          layout={layout}
          onLayoutChange={(change) => setLayout((current) => change(current))}
          onFocusPane={(paneId) => setLayout((current) => focusCoordinatorPane(current, paneId))}
          conversationLabel={(id) => TITLES[id] ?? id}
          renderTab={(id, pane, isFocused) => (
            <SortableCoordinatorTab
              key={id}
              conversationId={id}
              paneId={pane.id}
              isActive={pane.activeConversationId === id}
              isFocused={isFocused}
              onClick={(event) => {
                event.stopPropagation();
                setLayout((current) => focusCoordinatorPane(current, pane.id, id));
              }}
            >
              {TITLES[id]}
            </SortableCoordinatorTab>
          )}
          renderStripActions={() => null}
          renderContent={(pane, focused) =>
            pane.activeConversationId && (
              <Conversation id={pane.activeConversationId} focused={focused} />
            )
          }
        />
      </div>
    </main>
  );
}
