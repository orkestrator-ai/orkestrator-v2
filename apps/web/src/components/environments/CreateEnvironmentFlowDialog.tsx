import { useState } from "react";
import { renameEnvironmentFromPrompt, updateEnvironmentAgentSettings } from "@/lib/backend";
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
  ) => Promise<Environment>;
  updateEnvironment: (environmentId: string, updates: Partial<Environment>) => void;
  startEnvironment: (environmentId: string, initialPrompt?: string) => Promise<unknown>;
}

interface CreateEnvironmentFlowDialogProps extends CreateEnvironmentFlowOperations {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
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
      const environment = await createEnvironment(
        projectId,
        options.environmentName || undefined,
        options.networkAccessMode,
        options.initialPrompt || undefined,
        options.portMappings.length > 0 ? options.portMappings : undefined,
        options.environmentType,
      );

      const configuredEnvironment = await updateEnvironmentAgentSettings(
        environment.id,
        options.agentType,
        options.agentType === "claude" ? options.claudeMode : null,
        null,
        options.agentType === "opencode" ? options.opencodeMode : null,
        options.agentType === "codex" ? options.codexMode : null,
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

      const initialPromptForNaming = options.initialPrompt.trim();
      const shouldRenameFromInitialPrompt =
        !options.environmentName.trim() && initialPromptForNaming.length > 0;

      void (async () => {
        try {
          await startEnvironment(configuredEnvironment.id, options.initialPrompt);
        } catch (startError) {
          console.error("Failed to auto-start environment:", startError);
          return;
        }

        if (shouldRenameFromInitialPrompt) {
          try {
            await renameEnvironmentFromPrompt(
              configuredEnvironment.id,
              initialPromptForNaming,
            );
          } catch (renameError) {
            console.error("Failed to rename environment from initial prompt:", renameError);
          }
        }
      })();
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
