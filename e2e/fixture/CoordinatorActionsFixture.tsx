import { coordinatorActionCards } from "../../apps/web/src/components/projects/coordinator-action-cards";
import type { NativeMessage } from "../../apps/web/src/lib/chat/native-message-types";
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
            ...coordinatorActionCards([
              {
                id: "pr-notice",
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
