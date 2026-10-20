import { useState } from "react";
import { TerminalContainer } from "../../apps/web/src/components/terminal/TerminalContainer";
import { TooltipProvider } from "../../apps/web/src/components/ui/tooltip";
import { TerminalProvider } from "../../apps/web/src/contexts";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { usePaneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import type { Environment } from "../../apps/web/src/types";

const ENVIRONMENT_ID = "setup-recovery-environment";
const CONTAINER_ID = "setup-recovery-container";

type RecoveryRequest = { command: string; environmentId: unknown };

function installBackend(recordRequest: (request: RecoveryRequest) => void) {
  const environment: Environment = {
    id: ENVIRONMENT_ID,
    projectId: "setup-recovery-project",
    name: "Setup recovery",
    branch: "main",
    containerId: CONTAINER_ID,
    status: "error",
    environmentType: "containerized",
    setupPhase: "failed",
    setupScriptsComplete: false,
    order: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    networkAccessMode: "restricted",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
  };
  useEnvironmentStore.setState({ environments: [environment] });
  usePaneLayoutStore.setState({
    activeEnvironmentId: ENVIRONMENT_ID,
    hydration: new Map([[ENVIRONMENT_ID, "done"]]),
    environments: new Map([
      [
        ENVIRONMENT_ID,
        {
          containerId: CONTAINER_ID,
          activePaneId: "agent-pane",
          root: {
            kind: "leaf",
            id: "agent-pane",
            activeTabId: "native-agent",
            tabs: [
              {
                id: "native-agent",
                type: "agent-native",
                displayTitle: "Codex",
                nativeAgentData: {
                  environmentId: ENVIRONMENT_ID,
                  platform: "codex",
                  isLocal: false,
                },
              },
            ],
          },
        },
      ],
    ]),
  });
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "run_environment_setup":
        case "override_environment_setup": {
          recordRequest({ command, environmentId: args?.environmentId });
          return {
            ...environment,
            status: "running",
            setupPhase: command === "run_environment_setup" ? "running" : "ready",
            setupScriptsComplete: command === "override_environment_setup",
          } as T;
        }
        case "list_looped_review_workflows":
        case "list_multi_review_workflows":
        case "get_sessions_by_environment":
          return [] as T;
        default:
          // No provider process is needed: setup gates the real native tab.
          return new Promise<T>(() => {});
      }
    },
  } as Window["orkestrator"];
}

/** Real container, pane stacking and native tab, with deterministic setup commands. */
export function SetupRecoveryFixture() {
  const [requests, setRequests] = useState<RecoveryRequest[]>([]);
  useState(() => installBackend((request) => setRequests((current) => [...current, request])));
  const phase = useEnvironmentStore((state) => state.environments[0]?.setupPhase);
  return (
    <main className="flex h-screen w-screen flex-col bg-background text-foreground">
      <output className="sr-only" data-testid="setup-phase">
        {phase}
      </output>
      <output className="sr-only" data-testid="recovery-requests">
        {JSON.stringify(requests)}
      </output>
      <div className="min-h-0 flex-1">
        <TooltipProvider>
          <TerminalProvider>
            <TerminalContainer
              environmentId={ENVIRONMENT_ID}
              containerId={CONTAINER_ID}
              isContainerRunning
              isActive
            />
          </TerminalProvider>
        </TooltipProvider>
      </div>
    </main>
  );
}
