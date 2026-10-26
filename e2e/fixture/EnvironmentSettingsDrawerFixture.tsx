import { useState } from "react";
import { ActionBar } from "../../apps/web/src/components/layout/ActionBar";
import { TerminalProvider } from "../../apps/web/src/contexts/TerminalContext";
import { useProjectStore } from "../../apps/web/src/stores/projectStore";
import { useUIStore } from "../../apps/web/src/stores/uiStore";
import { EnvironmentItem } from "../../apps/web/src/components/environments/EnvironmentItem";
import { AppDialogHost } from "../../apps/web/src/components/layout/AppDialogHost";
import { MobileAppShellLayout } from "../../apps/web/src/components/layout/MobileAppShellLayout";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import type { Environment } from "../../apps/web/src/types";

const ENVIRONMENT_ID = "settings-drawer-environment";

declare global {
  interface Window {
    /** Commands the fixture backend left pending, for diagnosing a stuck dialog. */
    settingsDrawerPendingCommands?: string[];
  }
}

/** Settings load in the background; the dialog renders without their answers. */
function installBackend() {
  const pending: string[] = [];
  window.settingsDrawerPendingCommands = pending;
  delete window.orkestrator;
  window.orkestratorGateway = { enabled: true };
  window.orkestrator = {
    listen: () => () => {},
    invoke: <T,>(command: string) => {
      pending.push(command);
      return new Promise<T>(() => {});
    },
  } as unknown as Window["orkestrator"];
  useUIStore.setState({
    selectedProjectId: "settings-drawer-project",
    selectedEnvironmentId: ENVIRONMENT_ID,
  });
  useProjectStore.setState({
    projects: [
      {
        id: "settings-drawer-project",
        name: "settings-project",
        gitUrl: "",
        localPath: "/fixture/settings-project",
        order: 0,
        addedAt: "2026-10-16T00:00:00.000Z",
      },
    ],
  });
  useEnvironmentStore.setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "settings-drawer-project",
        name: "drawer-environment",
        order: 0,
        environmentType: "local",
        status: "running",
        setupPhase: "ready",
        networkAccessMode: "restricted",
        createdAt: "2026-10-16T00:00:00.000Z",
      } as Environment,
    ],
  });
}

/** The phone shell with a real sidebar row and the dialog host, as `AppShell` composes them. */
export function EnvironmentSettingsDrawerFixture() {
  useState(installBackend);
  const environment = useEnvironmentStore((state) =>
    state.environments.find((candidate) => candidate.id === ENVIRONMENT_ID),
  );
  if (!environment) return null;
  return (
    <TerminalProvider>
      <main className="flex h-screen flex-col bg-background text-foreground">
        <AppDialogHost />
        <MobileAppShellLayout
          selectedProjectId="settings-drawer-project"
          selectedEnvironmentId={null}
          title="Settings drawer fixture"
          filesPanelOpen={false}
          centralPanelStyle={{}}
          actionBar={<ActionBar presentation="grid" />}
          agentInfoButton={null}
          sidebar={
            <div className="pt-12">
              <EnvironmentItem
                environment={environment}
                isSelected={false}
                onSelect={() => {}}
                onDelete={() => {}}
                onStart={() => {}}
                onStop={() => {}}
                onRestart={() => {}}
              />
            </div>
          }
          filesPanel={null}
          onTitleBarMouseDown={() => {}}
        >
          <div>Workspace</div>
        </MobileAppShellLayout>
      </main>
    </TerminalProvider>
  );
}
