import { useState } from "react";
import { DesignAgentDock } from "../../apps/web/src/components/design/DesignAgentDock";
import type { DesignAgentPanelState } from "../../apps/web/src/types/paneLayout";

export function DesignAgentDockFixture() {
  const [panel, setPanel] = useState<DesignAgentPanelState>({ dock: "left", open: true });
  return (
    <div className="absolute inset-0 bg-background text-foreground">
      <DesignAgentDock
        panel={panel}
        onPanelChange={(patch) => setPanel((current) => ({ ...current, ...patch }))}
        visible
        ownsGlobalShortcuts
        renderCanvas={() => (
          <div data-testid="canvas" className="p-2">
            Canvas
          </div>
        )}
        renderAgent={() => <div className="p-2">Agent conversation</div>}
      />
    </div>
  );
}
