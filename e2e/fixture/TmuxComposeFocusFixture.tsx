import { useState } from "react";
import { TmuxComposeBar } from "../../apps/web/src/components/claude/ClaudeTmuxChatTab.parts";

// Keep the real composer, store, and send/clear lifecycle; defer only transport
// so the browser can inspect focus while a submission is pending.
declare global {
  interface Window {
    finishTmuxSend?: (success: boolean) => void;
  }
}

/** Installed before the fixture renders. */
export function installTmuxComposeFocusFixture() {
  window.orkestrator = {
    invoke: async <T,>(command: string) => {
      if (command === "get_compose_draft") return null as T;
      if (command === "delete_compose_draft") return undefined as T;
      if (command === "save_compose_draft") return { revision: 1 } as T;
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

export function TmuxComposeFocusFixture() {
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(0);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <output data-testid="completed-sends">{completed}</output>
      <TmuxComposeBar
        sessionKey="focus-fixture"
        environmentId="focus-environment"
        disabled={false}
        busy={false}
        submitting={submitting}
        onSubmit={async () => {
          setSubmitting(true);
          try {
            return await new Promise<boolean>((resolve) => {
              window.finishTmuxSend = resolve;
            });
          } finally {
            delete window.finishTmuxSend;
            setSubmitting(false);
            setCompleted((count) => count + 1);
          }
        }}
        onInterrupt={() => {}}
        models={[]}
        selectedModel="sonnet"
        onSelectModel={() => {}}
        selectedEffort="high"
        effortOptions={[]}
        onSelectEffort={() => {}}
        fastModeEnabled={false}
        fastModeAvailable={false}
        onSelectFastMode={() => {}}
        planMode={false}
        onTogglePlanMode={() => {}}
        modelDisabled={submitting}
        modelSwitching={false}
        effortSwitching={false}
        planLocked={submitting}
      />
    </main>
  );
}
