import { useCallback } from "react";
import { toast } from "sonner";
import { useBuildPipelineStore, type BuildPipeline, type BuildPipelineSource } from "@/stores/buildPipelineStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useConfigStore, useEnvironmentStore } from "@/stores";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useEnvironments } from "@/hooks/useEnvironments";
import * as backend from "@/lib/backend";
import { getBuildEnvironmentAgentSettings, resolveBuildPipelineAgent } from "@/lib/build-pipeline-agent";
import type { DefaultAgent, Environment, EnvironmentType } from "@/types";
import type { KanbanTask } from "@/lib/backend";
import type { PaneNode } from "@/types/paneLayout";
import type { TaskSnapshot } from "@/prompts";
import type { LinearIssueDetail } from "@/types/linear";

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

async function renameBuildEnvironmentFromPrompt(environmentId: string, prompt: string): Promise<void> {
  try {
    await backend.renameEnvironmentFromPrompt(environmentId, prompt);
    const renamedEnvironment = await backend.getEnvironment(environmentId);
    if (renamedEnvironment) {
      useEnvironmentStore.getState().updateEnvironment(environmentId, renamedEnvironment);
    }
  } catch (renameErr) {
    console.warn("[useBuildPipeline] Failed to rename environment from task prompt:", renameErr);
  }
}

type BuildPipelineTicketInput = {
  id: string;
  projectId: string;
  title: string;
  taskSnapshot: TaskSnapshot;
  source: BuildPipelineSource;
  namingPrompt: string;
  onPipelineLinked?: (params: { pipelineId: string; environmentId: string }) => Promise<void>;
};

type StartBuildOptions = {
  existingEnvironmentId?: string | null;
};

async function resolveReusableBuildEnvironment(
  environmentId: string | null | undefined,
  projectId: string,
): Promise<Environment | null> {
  const id = environmentId?.trim();
  if (!id) return null;

  const environment = useEnvironmentStore.getState().getEnvironmentById(id)
    ?? await backend.getEnvironment(id);
  if (!environment) return null;
  if (environment.projectId !== projectId) {
    throw new Error(`Environment ${id} does not belong to project ${projectId}`);
  }
  return environment;
}

function linearIssueToTicketInput(issue: LinearIssueDetail, projectId: string): BuildPipelineTicketInput {
  const metadata = [
    `Linear issue: ${issue.identifier}`,
    issue.url ? `URL: ${issue.url}` : "",
    issue.status ? `Status: ${issue.status}` : "",
    issue.teamKey ? `Team: ${issue.teamKey}${issue.teamName ? ` (${issue.teamName})` : ""}` : "",
    issue.assigneeName ? `Assignee: ${issue.assigneeName}` : "",
    issue.priorityLabel ? `Priority: ${issue.priorityLabel}` : "",
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
  ].filter(Boolean);

  const comments = [
    ...metadata.map((text) => ({ text })),
    ...issue.comments.map((comment) => ({
      text: comment.authorName ? `${comment.authorName}: ${comment.body}` : comment.body,
    })),
  ];
  const namingPrompt = [
    issue.identifier,
    issue.title,
    issue.description,
    issue.status,
  ].filter((part) => part.trim().length > 0).join("\n\n");

  return {
    id: issue.id,
    projectId,
    title: `${issue.identifier}: ${issue.title}`,
    namingPrompt,
    source: {
      type: "linear",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueUrl: issue.url,
      status: issue.status,
      teamKey: issue.teamKey,
      updatedAt: issue.updatedAt,
    },
    taskSnapshot: {
      title: `${issue.identifier}: ${issue.title}`,
      description: issue.description,
      acceptanceCriteria: "",
      comments,
      images: [],
    },
  };
}

export function useBuildPipeline() {
  const { createEnvironment, startEnvironment } = useEnvironments(null, { listenForRenameEvents: false });
  const { createPipeline, setPipelineEnvironment, setPhase, setPipelineError, removePipeline } = useBuildPipelineStore();
  const { updateTask } = useKanbanStore();
  const { selectProjectAndEnvironment, setProjectCollapsed } = useUIStore();
  const { setOptions } = useClaudeOptionsStore();
  const config = useConfigStore((state) => state.config);

  const startBuildFromTicket = useCallback(
    async (
      ticket: BuildPipelineTicketInput,
      environmentType: EnvironmentType,
      agentOverride?: DefaultAgent,
      options: StartBuildOptions = {},
    ) => {
      let pipelineId: string | null = null;
      try {
        const agentType = agentOverride ?? resolveBuildPipelineAgent(config, ticket.projectId);
        const agentSettings = getBuildEnvironmentAgentSettings(agentType);
        const reusableEnvironment = await resolveReusableBuildEnvironment(
          options.existingEnvironmentId,
          ticket.projectId,
        );
        const effectiveEnvironmentType = reusableEnvironment?.environmentType ?? environmentType;

        pipelineId = createPipeline({
          taskId: ticket.id,
          projectId: ticket.projectId,
          environmentType: effectiveEnvironmentType,
          agentType,
          taskTitle: ticket.title,
          taskSnapshot: ticket.taskSnapshot,
          source: ticket.source,
        });

        let environment = reusableEnvironment;
        if (!environment) {
          environment = await createEnvironment(
            ticket.projectId,
            undefined,
            effectiveEnvironmentType === "containerized" ? "restricted" : "full",
            undefined, // no initial prompt - we handle it via the pipeline
            undefined, // no port mappings
            effectiveEnvironmentType,
          );
        }

        // 3. Link pipeline to environment
        setPipelineEnvironment(pipelineId, environment.id);

        // 4. Configure environment for the selected pipeline agent.
        let configuredEnvironment = await backend.updateEnvironmentAgentSettings(
          environment.id,
          agentSettings.defaultAgent,
          agentSettings.claudeMode,
          null,
          agentSettings.opencodeMode,
          agentSettings.codexMode,
        );

        // Update environment in store
        useEnvironmentStore.getState().updateEnvironment(environment.id, configuredEnvironment);

        // Claude native mode still relies on the options store to auto-launch the bridge.
        if (agentSettings.shouldLaunchClaude) {
          setOptions(configuredEnvironment.id, {
            launchAgent: true,
            agentType: "claude",
            initialPrompt: "",
          });
        }

        await ticket.onPipelineLinked?.({
          environmentId: configuredEnvironment.id,
          pipelineId,
        });

        // 6. Expand the project if collapsed and select the environment in the UI
        setProjectCollapsed(ticket.projectId, false);
        selectProjectAndEnvironment(ticket.projectId, configuredEnvironment.id);

        const environmentNamingPrompt = (ticket.namingPrompt || ticket.title).trim();

        // 7. Start the environment. Naming must not gate startup: the user
        // should immediately see the worktree/container setup begin under the
        // timestamp name, while the LLM-generated name arrives in the background.
        setPhase(pipelineId, "starting-environment");
        if (configuredEnvironment.status !== "running") {
          try {
            await startEnvironment(configuredEnvironment.id);
            configuredEnvironment = useEnvironmentStore.getState().getEnvironmentById(configuredEnvironment.id)
              ?? await backend.getEnvironment(configuredEnvironment.id)
              ?? configuredEnvironment;
          } catch (startErr) {
            console.error("[useBuildPipeline] Failed to start environment:", startErr);
            setPipelineError(pipelineId, `Failed to start environment: ${startErr instanceof Error ? startErr.message : String(startErr)}`);
            return;
          }
        }

        if (environmentNamingPrompt) {
          void renameBuildEnvironmentFromPrompt(configuredEnvironment.id, environmentNamingPrompt);
        }

        // 8. Wait for setup scripts to be initiated (TerminalContainer consumes them)
        // This must happen BEFORE the build tab is added, to prevent the build tab
        // from being added to the pane before TerminalContainer's init effect runs
        // (which would skip setup command consumption due to currentTabs.length > 0).
        // A reused environment has already completed its first-time setup, so there
        // are no pending setup commands to wait for — skip to avoid a needless poll.
        if (!reusableEnvironment) {
          await waitForSetupInitiation(configuredEnvironment.id, configuredEnvironment.environmentType);
        }

        // 9. Create build tab in the pane layout
        // Wait for the environment pane to be initialized (poll with backoff)
        const buildTabId = `build-${pipelineId}`;
        const isLocal = configuredEnvironment.environmentType === "local";
        const buildTabData = {
          environmentId: configuredEnvironment.id,
          pipelineId,
          taskId: ticket.id,
          isLocal,
        };

        await waitForPaneAndAddTab(configuredEnvironment.id, buildTabId, buildTabData);

        toast.success("Build pipeline started");
      } catch (error) {
        if (pipelineId) removePipeline(pipelineId);
        console.error("[useBuildPipeline] Failed to start build:", error);
        toast.error("Failed to start build pipeline", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
    [config, createPipeline, createEnvironment, setPipelineEnvironment, setPhase, setPipelineError, removePipeline, selectProjectAndEnvironment, setProjectCollapsed, setOptions, startEnvironment]
  );

  const startBuild = useCallback(
    async (
      task: KanbanTask,
      environmentType: EnvironmentType,
      agentOverride?: DefaultAgent,
      options?: StartBuildOptions,
    ) => {
      const snapshotImages = await Promise.all(
        (task.images ?? []).map(async (img) => {
          try {
            const data = await backend.getKanbanImageData(img.id);
            return { filename: img.filename, data };
          } catch {
            return null;
          }
        })
      ).then((results) => results.filter((r): r is { filename: string; data: string } => r !== null));

      const namingPrompt = [
        task.title,
        task.description,
        task.acceptanceCriteria,
      ].filter((part) => part.trim().length > 0).join("\n\n");

      await startBuildFromTicket({
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        namingPrompt,
        source: { type: "kanban", taskId: task.id },
        taskSnapshot: {
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          comments: task.comments.map((c) => ({ text: c.text })),
          images: snapshotImages,
        },
        onPipelineLinked: ({ environmentId, pipelineId }) =>
          updateTask(task.id, {
            environmentId,
            buildPipelineId: pipelineId,
          }),
      }, environmentType, agentOverride, options);
    },
    [startBuildFromTicket, updateTask]
  );

  const startBuildFromLinearIssue = useCallback(
    async (issue: LinearIssueDetail, projectId: string, environmentType: EnvironmentType) => {
      await startBuildFromTicket(linearIssueToTicketInput(issue, projectId), environmentType);
    },
    [startBuildFromTicket]
  );

  const navigateToPipeline = useCallback(
    async (pipeline: Pick<BuildPipeline, "environmentId" | "projectId" | "taskId">) => {
      if (!pipeline.environmentId) return;

      setProjectCollapsed(pipeline.projectId, false);
      selectProjectAndEnvironment(pipeline.projectId, pipeline.environmentId);

      const maxAttempts = 20;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const paneState = usePaneLayoutStore.getState();
        const envState = paneState.environments.get(pipeline.environmentId);
        if (envState) {
          const result = findBuildTabInTree(envState.root, pipeline.taskId);
          if (result) {
            paneState.setActiveTab(result.paneId, result.tabId, pipeline.environmentId);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    [selectProjectAndEnvironment, setProjectCollapsed]
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
            paneState.setActiveTab(result.paneId, result.tabId, task.environmentId);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    [selectProjectAndEnvironment, setProjectCollapsed]
  );

  return { startBuild, startBuildFromLinearIssue, navigateToBuild, navigateToPipeline };
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
