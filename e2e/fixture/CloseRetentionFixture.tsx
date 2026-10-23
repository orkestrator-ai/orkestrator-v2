import { useEffect, useMemo, useState } from "react";
import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { AgentInfoButton } from "../../apps/web/src/components/layout/AgentInfoButton";
import { PaneTree } from "../../apps/web/src/components/pane-layout/PaneTree";
import { Toaster } from "../../apps/web/src/components/ui/sonner";
import { TooltipProvider } from "../../apps/web/src/components/ui/tooltip";
import { createAgentNativeTab } from "../../apps/web/src/components/terminal/TerminalContainer.helpers";
import { getPaneLayout } from "../../apps/web/src/lib/backend";
import {
  createPersistedPaneLayoutInput,
  flushPaneLayoutNow,
  startPaneLayoutPersistence,
} from "../../apps/web/src/lib/pane-layout-persistence";
import { reconcilePersistedLayout } from "../../apps/web/src/lib/pane-layout-restore";
import { useConfigStore } from "../../apps/web/src/stores/configStore";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import {
  getAllLeaves,
  usePaneLayoutStore,
  type EnvironmentPaneState,
} from "../../apps/web/src/stores/paneLayoutStore";

const PANE_ID = "close-retention-pane";

/**
 * Every renderer command goes to the close-retention host, which runs the real
 * backend command registry over real bridges with fake engines. Nothing is
 * answered here, so a renderer that asked for something the real backend does
 * not serve fails visibly instead of being humoured.
 */
function installBackend(environmentId: string, worktreePath: string) {
  useEnvironmentStore.setState({
    environments: [
      {
        id: environmentId,
        projectId: "close-retention-project",
        name: "Close retention",
        order: 0,
        environmentType: "local",
        status: "running",
        setupPhase: "ready",
        worktreePath,
      } as never,
    ],
  });
  // The platforms under test are enabled, as a user who installed them has.
  useConfigStore.setState((state) => ({
    config: {
      ...state.config,
      global: {
        ...state.config.global,
        enabledAgentPlatforms: ["claude", "codex", "opencode", "cursor", "grok", "pi"],
      },
    },
  }));
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      const response = await fetch("/__close-retention/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, args }),
      });
      const body = (await response.json()) as { result?: T; error?: string };
      if (body.error !== undefined) throw new Error(body.error);
      return body.result as T;
    },
  } as Window["orkestrator"];
}

/**
 * Restores the environment's pane layout from the backend the way the app's
 * terminal container does, or seeds a single agent tab on first load, then
 * keeps it persisted with the app's own writer.
 */
async function hydrate(environmentId: string, worktreePath: string, platform: AgentPlatform) {
  const store = usePaneLayoutStore.getState();
  store.setActiveEnvironment(environmentId);
  store.beginHydration(environmentId);
  const persisted = await getPaneLayout(environmentId);
  const restored = reconcilePersistedLayout(persisted, {
    environmentId,
    containerId: null,
    isLocal: true,
    worktreePath,
  });
  if (persisted) {
    // A layout whose last tab was closed is still this environment's layout.
    usePaneLayoutStore.getState().finishHydration(environmentId, restored ?? emptyLayout());
  } else {
    // First visit: one agent tab, saved before anything else happens, as a
    // launched tab is.
    const seeded: EnvironmentPaneState = {
      ...emptyLayout(),
      root: {
        kind: "leaf",
        id: PANE_ID,
        tabs: [
          createAgentNativeTab({
            id: `agent-${platform}-first`,
            platform,
            environmentId,
            isLocal: true,
          }),
        ],
        activeTabId: `agent-${platform}-first`,
      },
    };
    await flushPaneLayoutNow(environmentId, createPersistedPaneLayoutInput(seeded));
    usePaneLayoutStore.getState().finishHydration(environmentId, seeded);
  }
  // For the life of the page, as the app's own writer is.
  startPaneLayoutPersistence({ hydrateDependencies: async () => undefined });
}

let hydration: Promise<void> | undefined;

function emptyLayout(): EnvironmentPaneState {
  return {
    containerId: null,
    activePaneId: PANE_ID,
    backendRevision: 0,
    root: { kind: "leaf", id: PANE_ID, tabs: [], activeTabId: null },
  };
}

let opened = 0;

/**
 * An environment's real pane tree with native agent tabs, backed end to end by
 * the close-retention host. `New agent tab` adds an unassigned agent tab as
 * the app's new-tab action does; `Switch environment` unmounts the panes as
 * leaving for another environment does. The agent information button and the
 * toaster are the app shell's own, for the runtime panel and its notices.
 */
export function CloseRetentionFixture() {
  const query = new URLSearchParams(window.location.search);
  const environmentId = query.get("environment") ?? "";
  const worktreePath = query.get("worktree") ?? "";
  const platform = (query.get("platform") ?? "cursor") as AgentPlatform;
  const [ready, setReady] = useState(false);
  const [away, setAway] = useState(false);
  // As the app's terminal container configures it: a press is a click until
  // the pointer moves, so a tab's close button is not swallowed by a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  useEffect(() => {
    let cancelled = false;
    // Once per page: StrictMode runs this effect twice, and two first-visit
    // seeds would race each other's layout revision.
    hydration ??= (async () => {
      installBackend(environmentId, worktreePath);
      await hydrate(environmentId, worktreePath, platform);
    })();
    void hydration.then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, worktreePath, platform]);
  const node = usePaneLayoutStore((state) => state.environments.get(environmentId)?.root);
  const activePaneId = usePaneLayoutStore(
    (state) => state.environments.get(environmentId)?.activePaneId,
  );
  // As the app shell resolves it: the active pane's active tab.
  const activeTab = useMemo(() => {
    if (!node) return null;
    const pane = getAllLeaves(node).find((leaf) => leaf.id === activePaneId);
    return pane?.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
  }, [activePaneId, node]);
  const newTab = () => {
    opened += 1;
    const store = usePaneLayoutStore.getState();
    const paneId = store.environments.get(environmentId)?.activePaneId ?? PANE_ID;
    store.addTab(
      paneId,
      createAgentNativeTab({
        id: `agent-new-${Date.now().toString(36)}-${opened}`,
        platform: undefined,
        environmentId,
        isLocal: true,
      }),
      environmentId,
    );
  };
  return (
    <TooltipProvider>
      <main className="flex h-screen w-screen flex-col bg-background text-foreground">
        <nav className="flex shrink-0 gap-3 border-b border-border p-2 text-sm">
          <button type="button" onClick={newTab} disabled={!ready || away}>
            New agent tab
          </button>
          <button type="button" onClick={() => setAway(!away)}>
            {away ? "Return to environment" : "Switch environment"}
          </button>
          {ready && !away ? <AgentInfoButton activeTab={activeTab} /> : null}
        </nav>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {away ? (
            <p>Another environment is active</p>
          ) : ready && node ? (
            <DndContext sensors={sensors}>
              <PaneTree node={node} containerId={null} environmentId={environmentId} isActive />
            </DndContext>
          ) : null}
        </div>
      </main>
      <Toaster />
    </TooltipProvider>
  );
}
