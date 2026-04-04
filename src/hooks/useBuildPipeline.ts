import { useCallback } from "react";
import { toast } from "sonner";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useEnvironmentStore } from "@/stores";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useEnvironments } from "@/hooks/useEnvironments";
import * as tauri from "@/lib/tauri";
import type { EnvironmentType } from "@/types";
import type { KanbanTask } from "@/lib/tauri";
import type { PaneNode } from "@/types/paneLayout";

/**
 * Wait for setup scripts to be initiated by the TerminalContainer.
 *
 * For local environments, this waits until the TerminalContainer has consumed
 * the pending setup commands and either:
 *   - set setupScriptsRunning = true (setup scripts are executing), or
 *   - consumed the commands with no scripts to run (hasPendingSetupCommands = false
 *     AND setupScriptsRunning = false AND setupCommandsResolved = true)
 *
 * For container environments, this returns immediately since setup is handled
 * inside the container by workspace-setup.sh (gated by workspaceReady).
 *
 * This prevents the build tab from being added before the TerminalContainer has
 * had a chance to consume and start the setup scripts.
 */
export async function waitForSetupInitiation(
  environmentId: string,
  environmentType: EnvironmentType,
  { maxWaitMs = 30_000, pollMs = 50 }: { maxWaitMs?: number; pollMs?: number } = {},
): Promise<void> {
  if (environmentType !== "local") return;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const store = useEnvironmentStore.getState();
    const resolved = store.setupCommandsResolved.has(environmentId);
    const hasPending = store.pendingSetupCommands.has(environmentId);
    const running = store.setupScriptsRunning.has(environmentId);

    // Setup scripts are running — TerminalContainer has consumed them
    if (running) return;

    // No pending commands and resolved — no setup scripts to run
    if (resolved && !hasPending) return;

    await new Promise((r) => setTimeout(r, pollMs));
  }

  console.warn("[useBuildPipeline] Timed out waiting for setup initiation, proceeding anyway");
}

export function useBuildPipeline() {
  const { createEnvironment, startEnvironment } = useEnvironments(null, { listenForRenameEvents: false });
  const { createPipeline, setPipelineEnvironment, setPhase, setPipelineError } = useBuildPipelineStore();
  const { updateTask } = useKanbanStore();
  const { selectProjectAndEnvironment, setProjectCollapsed } = useUIStore();
  const { setOptions } = useClaudeOptionsStore();

  const startBuild = useCallback(
    async (task: KanbanTask, environmentType: EnvironmentType) => {
      try {
        // 1. Load image data from disk for the task snapshot
        const snapshotImages = await Promise.all(
          (task.images ?? []).map(async (img) => {
            try {
              const data = await tauri.getKanbanImageData(img.id);
              return { filename: img.filename, data };
            } catch {
              return null;
            }
          })
        ).then((results) => results.filter((r): r is { filename: string; data: string } => r !== null));

        // 2. Create pipeline
        const pipelineId = createPipeline({
          taskId: task.id,
          projectId: task.projectId,
          environmentType,
          taskTitle: task.title,
          taskSnapshot: {
            title: task.title,
            description: task.description,
            acceptanceCriteria: task.acceptanceCriteria,
            comments: task.comments.map((c) => ({ text: c.text })),
            images: snapshotImages,
          },
        });

        // 2. Create environment named after the ticket
        const envName = task.title.slice(0, 60);

        const environment = await createEnvironment(
          task.projectId,
          envName,
          environmentType === "containerized" ? "restricted" : "full",
          undefined, // no initial prompt - we handle it via the pipeline
          undefined, // no port mappings
          environmentType,
        );

        // 3. Link pipeline to environment
        setPipelineEnvironment(pipelineId, environment.id);

        // 4. Configure environment for Claude native mode
        const configuredEnvironment = await tauri.updateEnvironmentAgentSettings(
          environment.id,
          "claude",
          "native",
          null,
        );

        // Update environment in store
        useEnvironmentStore.getState().updateEnvironment(environment.id, configuredEnvironment);

        // Store agent options (needed for Claude bridge server to be started)
        setOptions(configuredEnvironment.id, {
          launchAgent: true,
          agentType: "claude",
          initialPrompt: "",
        });

        // 5. Update kanban task with pipeline/environment link
        await updateTask(task.id, {
          environmentId: environment.id,
          buildPipelineId: pipelineId,
        });

        // 6. Expand the project if collapsed and select the environment in the UI
        setProjectCollapsed(task.projectId, false);
        selectProjectAndEnvironment(task.projectId, configuredEnvironment.id);

        // 7. Start the environment
        setPhase(pipelineId, "starting-environment");
        try {
          await startEnvironment(configuredEnvironment.id);
        } catch (startErr) {
          console.error("[useBuildPipeline] Failed to start environment:", startErr);
          setPipelineError(pipelineId, `Failed to start environment: ${startErr instanceof Error ? startErr.message : String(startErr)}`);
          return;
        }

        // 8. Wait for setup scripts to be initiated (TerminalContainer consumes them)
        // This must happen BEFORE the build tab is added, to prevent the build tab
        // from being added to the pane before TerminalContainer's init effect runs
        // (which would skip setup command consumption due to currentTabs.length > 0).
        await waitForSetupInitiation(configuredEnvironment.id, environmentType);

        // 9. Create build tab in the pane layout
        // Wait for the environment pane to be initialized (poll with backoff)
        const buildTabId = `build-${pipelineId}`;
        const isLocal = environmentType === "local";
        const buildTabData = {
          environmentId: configuredEnvironment.id,
          pipelineId,
          taskId: task.id,
          isLocal,
        };

        await waitForPaneAndAddTab(configuredEnvironment.id, buildTabId, buildTabData);

        toast.success("Build pipeline started");
      } catch (error) {
        console.error("[useBuildPipeline] Failed to start build:", error);
        toast.error("Failed to start build pipeline", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [createPipeline, createEnvironment, setPipelineEnvironment, setPhase, setPipelineError, updateTask, selectProjectAndEnvironment, setProjectCollapsed, setOptions, startEnvironment]
  );

  const navigateToBuild = useCallback(
    async (task: KanbanTask) => {
      if (!task.environmentId) return;

      setProjectCollapsed(task.projectId, false);
      selectProjectAndEnvironment(task.projectId, task.environmentId);

      // Poll for the pane state to be available, then find and activate the build tab
      const maxAttempts = 20;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const paneState = usePaneLayoutStore.getState();
        const envState = paneState.environments.get(task.environmentId!);
        if (envState) {
          const result = findBuildTabInTree(envState.root, task.id);
          if (result) {
            paneState.setActiveTab(result.paneId, result.tabId);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    [selectProjectAndEnvironment, setProjectCollapsed]
  );

  return { startBuild, navigateToBuild };
}

/** Search pane tree for a build tab matching a task ID */
function findBuildTabInTree(node: PaneNode, taskId: string): { paneId: string; tabId: string } | null {
  if (node.kind === "leaf") {
    const tab = node.tabs.find((t) => t.type === "claude-build" && t.buildTabData?.taskId === taskId);
    if (tab) return { paneId: node.id, tabId: tab.id };
    return null;
  }
  for (const child of node.children) {
    const result = findBuildTabInTree(child, taskId);
    if (result) return result;
  }
  return null;
}

/** Wait for the environment pane to be initialized, then add the build tab */
async function waitForPaneAndAddTab(
  environmentId: string,
  buildTabId: string,
  buildTabData: import("@/types/paneLayout").BuildTabData,
) {
  const maxAttempts = 20;
  const { addTab } = usePaneLayoutStore.getState();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const paneState = usePaneLayoutStore.getState();
    const envState = paneState.environments.get(environmentId);
    if (envState) {
      const activePaneId = envState.activePaneId ?? "default";
      addTab(activePaneId, {
        id: buildTabId,
        type: "claude-build",
        buildTabData,
      }, environmentId);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  // Fallback: add to default pane even if env pane not found
  addTab("default", {
    id: buildTabId,
    type: "claude-build",
    buildTabData,
  }, environmentId);
}
