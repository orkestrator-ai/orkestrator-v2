import { useState } from "react";
import { DndContext } from "@dnd-kit/core";
import type { BackendId } from "@orkestrator/protocol/federation";
import { COORDINATOR_LAUNCH_OVERRIDES_COMMAND } from "@orkestrator/protocol/coordinator-launch-overrides";
import { DraggableTabBar } from "../../apps/web/src/components/pane-layout/DraggableTabBar";
import { getWindowScope } from "../../apps/web/src/lib/node-scope/app-window-scope";
import type { NodeScope } from "../../apps/web/src/lib/node-scope/node-scope";
import { NodeScopeProvider } from "../../apps/web/src/lib/node-scope/providers";
import { FakeNodeClient } from "../../apps/web/src/test/render-in-node-scope";
import type { PaneLeaf, TabInfo } from "../../apps/web/src/types/paneLayout";

/** The leaf the command node's coordinator launched a worker on (`?leaf`). */
const LEAF_NODE = "bk_fixture-leaf" as BackendId;

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

/** The leaf's worker: the same environment and tab ids as the command node's own. */
const leafPane: PaneLeaf = {
  kind: "leaf",
  id: "leaf-pane",
  activeTabId: "startup-agent",
  tabs: [
    agentTab("startup-agent", "claude", "Port the parser"),
    agentTab("job-default", "codex", "Lint the port"),
  ],
};

/** Every command the tab strip sent, so the spec can count the coordinator reads. */
const commands: string[] = [];
/** Every command the leaf's strip sent to the leaf. */
const leafCommands: string[] = [];

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
          // Kept on the command node for a worker it launched on the leaf.
          remoteOverrides: [
            {
              nodeId: LEAF_NODE,
              environmentId: "worker",
              tabId: "job-default",
              model: "gpt-5.5",
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
 * The leaf's scope in the app's window, beside its command scope, as a leaf in
 * the window's tree is. The leaf's own coordinator launched nothing, so its
 * answer is empty; anything else it is asked answers nothing.
 */
function openLeafScope(): NodeScope {
  const windowScope = getWindowScope();
  const open = windowScope.get(LEAF_NODE);
  if (open) return open;
  const client = new FakeNodeClient({ nodeId: LEAF_NODE });
  const invokeRaw = client.invokeRaw.bind(client);
  client.invokeRaw = async <T,>(command: string, args?: Readonly<Record<string, unknown>>) => {
    leafCommands.push(command);
    if (command === COORDINATOR_LAUNCH_OVERRIDES_COMMAND) {
      return (await invokeRaw<T>(command, args).catch(() => ({ overrides: [] }))) as T;
    }
    return undefined as T;
  };
  client.respond(COORDINATOR_LAUNCH_OVERRIDES_COMMAND, { overrides: [] });
  return windowScope.open({ role: "leaf", client });
}

/**
 * Opened when this lazily loaded module evaluates, outside any render, since
 * opening a scope notifies the window's providers.
 */
const leafScope = new URLSearchParams(window.location.search).has("leaf") ? openLeafScope() : null;

function LeafStrip({ scope }: { scope: NodeScope }) {
  return (
    <section aria-label="Leaf node" className="border-t border-border">
      <p className="px-3 pt-2 text-xs text-muted-foreground">On the leaf node</p>
      <NodeScopeProvider scope={scope}>
        <DndContext>
          <DraggableTabBar pane={leafPane} environmentId="worker" onTabSelect={() => undefined} />
        </DndContext>
      </NodeScopeProvider>
    </section>
  );
}

/**
 * The real tab strip and the real override store over a fake backend: one
 * worker launched on an override, one on the default, a tab no coordinator
 * touched and a plain terminal. With `?leaf`, a second strip renders a leaf
 * node's worker tabs on that node's scope (docs/architecture/coordinator.md, "Launch defaults").
 */
export function TabLaunchOverrideFixture() {
  useState(installFixture);
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <DndContext>
        <DraggableTabBar pane={pane} environmentId="worker" onTabSelect={() => undefined} />
      </DndContext>
      {leafScope ? <LeafStrip scope={leafScope} /> : null}
      <output data-testid="commands" className="p-4 text-xs text-muted-foreground">
        <button
          onClick={(event) => {
            event.currentTarget.textContent = commands.join(",");
            event.currentTarget.dataset.leafCommands = leafCommands.join(",");
          }}
        >
          Show commands
        </button>
      </output>
    </div>
  );
}
