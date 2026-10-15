import { useState } from "react";
import {
  CoordinatorPaneTree,
  SortableCoordinatorTab,
} from "../../apps/web/src/components/projects/CoordinatorPaneTree";
import {
  focusCoordinatorPane,
  reconcileCoordinatorLayout,
  type CoordinatorPaneLayout,
} from "../../apps/web/src/lib/coordinator-pane-layout";

const TITLES: Record<string, string> = {
  main: "Coordinator",
  "side-1": "Side 1",
  "side-2": "Side 2",
};

/**
 * The coordinator's tab groups with stand-in conversations, so the browser spec
 * drives real dnd-kit pointer drags and resizable panels without a backend.
 */
export function CoordinatorPaneTreeFixture() {
  const [layout, setLayout] = useState<CoordinatorPaneLayout>(() =>
    reconcileCoordinatorLayout(null, Object.keys(TITLES)),
  );
  return (
    <main className="h-screen w-screen bg-background text-foreground">
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
            <button type="button">{TITLES[id]}</button>
          </SortableCoordinatorTab>
        )}
        renderStripActions={() => null}
        renderContent={(pane) => (
          <section
            aria-label={`${TITLES[pane.activeConversationId ?? ""] ?? "Empty"} conversation`}
            className="grid h-full place-items-center"
          >
            {TITLES[pane.activeConversationId ?? ""] ?? "Empty"}
          </section>
        )}
      />
    </main>
  );
}
