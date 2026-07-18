import { useState } from "react";
import { updateEnvironmentAgentSettings } from "@/lib/backend";
import { useClaudeOptionsStore, useConfigStore, useUIStore } from "@/stores";
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

export function resolveEnvironmentAgentSettings(options: ClaudeOptions) {
  return {
    defaultAgent: options.agentType,
    claudeMode: options.agentType === "claude" ? options.claudeMode : null,
    opencodeMode: options.agentType === "opencode" ? options.opencodeMode : null,
    codexMode: options.agentType === "codex" ? options.codexMode : null,
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
  createEnvironment,
  updateEnvironment,
  startEnvironment,
}: CreateEnvironmentFlowDialogProps) {
  const [isCreating, setIsCreating] = useState(false);
  const setOptions = useClaudeOptionsStore((state) => state.setOptions);
  const config = useConfigStore((state) => state.config);
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
      const configuredEnvironment = await updateEnvironmentAgentSettings(
        environment.id,
        agentSettings.defaultAgent,
        agentSettings.claudeMode,
        null,
        agentSettings.opencodeMode,
        agentSettings.codexMode,
      );
      updateEnvironment(environment.id, configuredEnvironment);

      setOptions(configuredEnvironment.id, {
        launchAgent: options.launchAgent,
        agentType: options.agentType,
        initialPrompt: options.initialPrompt,
        initialPromptAttachments: options.initialPromptAttachments,
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
      defaultPortMappings={
        projectId ? config.repositories[projectId]?.defaultPortMappings : undefined
      }
    />
  );
}
