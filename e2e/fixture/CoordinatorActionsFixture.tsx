import { useState } from "react";
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
        <FloatingNotice tone="info" title="Agent mail">
          One message waiting
        </FloatingNotice>
        <CoordinatorActionsPanel
          cards={[
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
