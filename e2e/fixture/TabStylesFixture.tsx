import { useState } from "react";
import { DndContext } from "@dnd-kit/core";
import { DesignWorkspaceDialog } from "@/components/design/DesignWorkspaceDialog";
import { EnvironmentSettingsDialog } from "@/components/environments/EnvironmentSettingsDialog";
import { FilesPanelHeader } from "@/components/files-panel/FilesPanelHeader";
import { FeaturesView } from "@/components/kanban/FeaturesView";
import { DraggableTabBar } from "@/components/pane-layout/DraggableTabBar";
import { SkillsSettings } from "@/components/settings/SkillsSettings";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { FeaturePlan } from "@/stores/featurePlanStore";
import { agentActivityStore } from "@/stores/agentActivityStore";
import { claudeTmuxStore, createClaudeTmuxStateKey } from "@/stores/claudeTmuxStore";
import { filesPanelStore } from "@/stores/filesPanelStore";
import { appCommandStore } from "@/test/app-command-store";
import type { TabInfo } from "@/types/paneLayout";

const projectId = "tabs-project";
const environmentId = "tabs-environment";
const now = "2026-01-01T00:00:00.000Z";
const activityTabs: TabInfo[] = [
  { id: "shell", type: "plain" },
  { id: "terminal", type: "codex" },
  { id: "chat", type: "claude-tmux", claudeTmuxData: { environmentId } },
];
const feature: FeaturePlan = {
  id: "tabs-feature",
  projectId,
  title: "Example feature",
  status: "stories",
  summary: "",
  messages: [],
  stories: Array.from({ length: 7 }, (_, index) => ({
    id: `story-${index + 1}`,
    title: `Story ${index + 1}: Keep the workspace accessible`,
    description: "Review the workspace from a narrow pane.",
    acceptanceCriteria: ["All controls are reachable"],
    messages: [],
    createdAt: now,
    updatedAt: now,
  })),
  order: 0,
  createdAt: now,
  updatedAt: now,
};

export function installTabStylesFixture() {
  window.orkestrator = {
    invoke: async (command: string) => {
      switch (command) {
        case "get_feature_plans":
          return [feature];
        case "changes_get_views":
          return { projections: [] };
        case "design_library":
          return {
            ok: true,
            value: {
              entries: [],
              total: 0,
              quota: {
                live: 0,
                liveLimit: 25,
                deleted: 0,
                deletedLimit: 25,
                deletedBytes: 0,
                deletedBytesLimit: 1000000,
              },
            },
          };
        case "list_agent_plugins":
          return {
            agent: "claude",
            plugins: [{ name: "review", status: "configured", source: "user" }],
          };
        case "get_environment_extensions":
          return [
            { agent: "claude", mcpServers: [], plugins: [] },
            { agent: "codex", mcpServers: [], plugins: [] },
          ];
        default:
          return null;
      }
    },
    listen: () => () => undefined,
  } as unknown as Window["orkestrator"];

  appCommandStore(filesPanelStore).setState({
    activeTab: "changes",
    changes: [
      {
        path: "example.ts",
        filename: "example.ts",
        directory: "",
        additions: 1,
        deletions: 0,
        status: "modified",
      },
    ],
    pullRequestTabs: {
      [environmentId]: [
        {
          key: "draft",
          ref: { owner: "example", repo: "workspace", number: 1 },
          view: "summary",
          openRequest: 1,
          state: "open",
          isDraft: true,
        },
        {
          key: "closed",
          ref: { owner: "example", repo: "workspace", number: 2 },
          view: "summary",
          openRequest: 1,
          state: "closed",
        },
      ],
    },
  });
}

function WorkingTabsFixture() {
  const [activeTabId, setActiveTabId] = useState("shell");
  const setWorking = (working: boolean) => {
    const terminal = appCommandStore(agentActivityStore).getState();
    terminal.setTabState("shell", working ? "working" : "idle");
    terminal.setTabState("terminal", working ? "working" : "idle");
    appCommandStore(claudeTmuxStore)
      .getState()
      .setBusy(createClaudeTmuxStateKey(environmentId, "chat"), working);
  };
  return (
    <>
      <DndContext>
        <DraggableTabBar
          pane={{ kind: "leaf", id: "working-tabs", activeTabId, tabs: activityTabs }}
          environmentId={environmentId}
          isPaneFocused
          onTabSelect={setActiveTabId}
        />
      </DndContext>
      <button type="button" onClick={() => setWorking(true)}>
        Start turn
      </button>
      <button type="button" onClick={() => setWorking(false)}>
        End turn
      </button>
    </>
  );
}

export function TabStylesFixture() {
  const view = new URLSearchParams(window.location.search).get("view");
  return (
    <TooltipProvider>
      <div className="h-screen bg-background text-foreground">
        {view === "features" && <FeaturesView projectId={projectId} />}
        {view === "working" && <WorkingTabsFixture />}
        {view === "design" && (
          <DesignWorkspaceDialog
            open
            onOpenChange={() => undefined}
            environmentId={environmentId}
            createTab={() => false}
            loadReadiness={async () => ({
              backend: { state: "connected" },
              protocol: "v2",
              capabilities: null,
              storage: { state: "available" },
              renderer: { state: "ready", ready: true, message: "" },
            })}
          />
        )}
        {view === "files" && (
          <FilesPanelHeader
            onRefresh={() => undefined}
            targetId={environmentId}
            changeEnvironmentId={environmentId}
            onChooseDiffBase={() => undefined}
          />
        )}
        {view === "skills" && (
          <SkillsSettings
            listSkills={async (provider) => ({ provider, roots: [], skills: [], errors: [] })}
          />
        )}
        {view === "extensions" && (
          <EnvironmentSettingsDialog
            open
            initialSection="extensions"
            onOpenChange={() => undefined}
            onUpdate={() => undefined}
            environment={{
              id: environmentId,
              projectId,
              name: "Tab styles environment",
              branch: "main",
              containerId: null,
              status: "running",
              prUrl: null,
              prState: null,
              hasMergeConflicts: null,
              createdAt: now,
              networkAccessMode: "restricted",
              order: 0,
              environmentType: "local",
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
