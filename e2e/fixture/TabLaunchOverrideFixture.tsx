import { useState } from "react";
import { DndContext } from "@dnd-kit/core";
import { COORDINATOR_LAUNCH_OVERRIDES_COMMAND } from "@orkestrator/protocol/coordinator-launch-overrides";
import { DraggableTabBar } from "../../apps/web/src/components/pane-layout/DraggableTabBar";
import type { PaneLeaf, TabInfo } from "../../apps/web/src/types/paneLayout";

const agentTab = (id: string, platform: "claude" | "codex", displayTitle: string): TabInfo => ({
  id,
  type: "agent-native",
  displayTitle,
  nativeAgentData: { platform, environmentId: "worker" },
});

const pane: PaneLeaf = {
  kind: "leaf",
  id: "pane",
  activeTabId: "startup-agent",
  tabs: [
    agentTab("startup-agent", "claude", "Fix the parser"),
    agentTab("job-default", "codex", "Run the checks"),
    agentTab("user-tab", "claude", "My own tab"),
    { id: "terminal", type: "plain" },
  ],
};

/** Every command the tab strip sent, so the spec can count the coordinator reads. */
const commands: string[] = [];

function installFixture() {
  window.orkestrator = {
    clipboard: {
      readText: async () => "",
      writeText: async () => undefined,
      readImage: async () => null,
      writeImage: async () => undefined,
    },
    process: { exit: async () => undefined },
    window: { startDragging: async () => undefined },
    listen: () => () => undefined,
    invoke: async <T,>(command: string): Promise<T> => {
      commands.push(command);
      if (command === COORDINATOR_LAUNCH_OVERRIDES_COMMAND) {
        return {
          overrides: [
            {
              environmentId: "worker",
              tabId: "startup-agent",
              model: "claude-opus-5-5",
              reasoning: "max",
            },
          ],
        } as T;
      }
      return undefined as T;
    },
  };
  return true;
}

/**
 * The real tab strip and the real override store over a fake backend: one
 * worker launched on an override, one on the default, a tab no coordinator
 * touched and a plain terminal.
 */
export function TabLaunchOverrideFixture() {
  useState(installFixture);
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <DndContext>
        <DraggableTabBar pane={pane} environmentId="worker" onTabSelect={() => undefined} />
      </DndContext>
      <output data-testid="commands" className="p-4 text-xs text-muted-foreground">
        <button
          onClick={(event) => {
            event.currentTarget.textContent = commands.join(",");
          }}
        >
          Show commands
        </button>
      </output>
    </div>
  );
}
