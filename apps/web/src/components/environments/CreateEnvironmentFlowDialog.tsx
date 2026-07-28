import { useState } from "react";
import { updateEnvironmentAgentSettings } from "@/lib/backend";
import {
  resolveAgentModeSettings,
  type AgentModeSettings,
} from "@/lib/build-pipeline-agent";
import {
  useClaudeOptionsStore,
  useConfigStore,
  useProjectStore,
  useUIStore,
} from "@/stores";
import type {
  Environment,
  EnvironmentType,
  NetworkAccessMode,
  PortMapping,
} from "@/types";
import { CreateEnvironmentDialog, type ClaudeOptions } from "./CreateEnvironmentDialog";

export interface CreateEnvironmentFlowOperations {
  createEnvironment: (
    projectId: string,
    name?: string,
    networkAccessMode?: NetworkAccessMode,
    initialPrompt?: string,
    portMappings?: PortMapping[],
    environmentType?: EnvironmentType,
    namingPrompt?: string,
  ) => Promise<Environment>;
  updateEnvironment: (environmentId: string, updates: Partial<Environment>) => void;
  startEnvironment: (environmentId: string, initialPrompt?: string) => Promise<unknown>;
}

interface CreateEnvironmentFlowDialogProps extends CreateEnvironmentFlowOperations {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  projectName?: string;
}

export function resolveEnvironmentCreateRequest(options: ClaudeOptions) {
  const initialPromptForNaming = options.initialPrompt.trim();
  return {
    name: options.environmentName || undefined,
    networkAccessMode: options.networkAccessMode,
    initialPrompt: options.initialPrompt || undefined,
    portMappings: options.portMappings.length > 0 ? options.portMappings : undefined,
    environmentType: options.environmentType,
    namingPrompt: !options.environmentName.trim() && initialPromptForNaming
      ? initialPromptForNaming
      : undefined,
  };
}

/**
 * Unlike a build pipeline, the create dialog forwards the modes the user picked
 * instead of forcing native — the shared helper only owns the routing.
 */
export function resolveEnvironmentAgentSettings(options: ClaudeOptions): AgentModeSettings {
  return resolveAgentModeSettings(options.agentType, options);
}

export function resolveEnvironmentAgentLaunchSettings(options: ClaudeOptions) {
  return {
    pendingAgentLaunch: options.launchAgent,
    initialAgentModel: options.launchAgent ? options.model : undefined,
    initialReasoningEffort: options.launchAgent
      ? options.reasoningEffort
      : undefined,
    initialPromptAttachments: options.launchAgent
      ? options.initialPromptAttachments
      : undefined,
  };
}

/**
 * Owns the shared create/configure/start workflow so every project entry point
 * behaves the same way.
 */
export function CreateEnvironmentFlowDialog({
  open,
  onOpenChange,
  projectId,
  projectName: providedProjectName,
  createEnvironment,
  updateEnvironment,
  startEnvironment,
}: CreateEnvironmentFlowDialogProps) {
  const [isCreating, setIsCreating] = useState(false);
  const setOptions = useClaudeOptionsStore((state) => state.setOptions);
  const config = useConfigStore((state) => state.config);
  const storedProjectName = useProjectStore((state) =>
    projectId
      ? state.projects.find((project) => project.id === projectId)?.name
      : undefined,
  );
  const projectName = providedProjectName ?? storedProjectName;
  const setProjectCollapsed = useUIStore((state) => state.setProjectCollapsed);
  const selectProjectAndEnvironment = useUIStore(
    (state) => state.selectProjectAndEnvironment,
  );

  const handleCreate = async (options: ClaudeOptions) => {
    if (!projectId) return;

    setIsCreating(true);
    try {
      const request = resolveEnvironmentCreateRequest(options);
      const environment = await createEnvironment(
        projectId,
        request.name,
        request.networkAccessMode,
        request.initialPrompt,
        request.portMappings,
        request.environmentType,
        request.namingPrompt,
      );

      const agentSettings = resolveEnvironmentAgentSettings(options);
      const launchSettings = resolveEnvironmentAgentLaunchSettings(options);
      const configuredEnvironment = await updateEnvironmentAgentSettings(
        environment.id,
        agentSettings.defaultAgent,
        agentSettings.claudeMode,
        null,
        agentSettings.opencodeMode,
        agentSettings.codexMode,
        launchSettings.pendingAgentLaunch,
        launchSettings.initialAgentModel,
        launchSettings.initialReasoningEffort,
        launchSettings.initialPromptAttachments,
      );
      updateEnvironment(environment.id, configuredEnvironment);

      setOptions(configuredEnvironment.id, {
        launchAgent: options.launchAgent,
        agentType: options.agentType,
        initialPrompt: options.initialPrompt,
        initialPromptAttachments: options.initialPromptAttachments,
        // Mirror the backend write above: a one-shot model only means anything
        // for a launch, and storing it when `launchAgent` is false would leave a
        // stale model in the transient options store for the next reader.
        model: options.launchAgent ? options.model : undefined,
        reasoningEffort: options.launchAgent ? options.reasoningEffort : undefined,
      });

      setProjectCollapsed(projectId, false);
      selectProjectAndEnvironment(projectId, configuredEnvironment.id);

      // Leave the modal as soon as the environment is ready to display. Start
      // and prompt-based naming can continue without blocking the UI.
      onOpenChange(false);

      void startEnvironment(configuredEnvironment.id, options.initialPrompt).catch((startError) => {
        console.error("Failed to auto-start environment:", startError);
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <CreateEnvironmentDialog
      open={open}
      onOpenChange={onOpenChange}
      onCreate={handleCreate}
      isLoading={isCreating}
      projectId={projectId}
      projectName={projectName}
      defaultPortMappings={
        projectId ? config.repositories[projectId]?.defaultPortMappings : undefined
      }
    />
  );
}
