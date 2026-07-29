import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  getContainerGitHubCredentialStatus,
  updateEnvironmentAgentSettings,
  type GitHubCredentialStatus,
} from "@/lib/backend";
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
import type { StartEnvironmentOptions } from "@/hooks/useEnvironments";
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
  startEnvironment: (
    environmentId: string,
    initialPrompt?: string,
    options?: StartEnvironmentOptions,
  ) => Promise<unknown>;
}

interface CreateEnvironmentFlowDialogProps extends CreateEnvironmentFlowOperations {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  projectName?: string;
}

interface PendingGitHubCredentialWarning {
  options: ClaudeOptions;
  status: GitHubCredentialStatus | null;
  resolve: (created: boolean) => void;
  settled: boolean;
  creating: boolean;
}

interface PendingGitHubCredentialPreflight {
  projectId: string;
  cancel: () => void;
}

const PREFLIGHT_CANCELLED = Symbol("preflight-cancelled");

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
  const [pendingCredentialWarning, setPendingCredentialWarning] =
    useState<PendingGitHubCredentialWarning | null>(null);
  const mountedRef = useRef(true);
  const activePreflightRef = useRef<PendingGitHubCredentialPreflight | null>(null);
  const pendingCredentialWarningRef =
    useRef<PendingGitHubCredentialWarning | null>(null);
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

  const settleCredentialWarning = useCallback(
    (
      pending: PendingGitHubCredentialWarning,
      result: { created: boolean },
    ) => {
      if (pending.settled) return;
      pending.settled = true;
      if (pendingCredentialWarningRef.current === pending) {
        pendingCredentialWarningRef.current = null;
        if (mountedRef.current) setPendingCredentialWarning(null);
      }
      pending.resolve(result.created);
    },
    [],
  );

  const cancelPendingCredentialFlow = useCallback(() => {
    const preflight = activePreflightRef.current;
    activePreflightRef.current = null;
    preflight?.cancel();

    const warning = pendingCredentialWarningRef.current;
    const cancellableWarning = warning && !warning.creating ? warning : null;
    if (cancellableWarning) {
      settleCredentialWarning(cancellableWarning, { created: false });
    }

    if (mountedRef.current && (preflight || cancellableWarning)) {
      setIsCreating(false);
    }
  }, [settleCredentialWarning]);

  useEffect(() => {
    if (!open) cancelPendingCredentialFlow();
  }, [cancelPendingCredentialFlow, open]);

  useEffect(() => {
    const preflight = activePreflightRef.current;
    if (preflight && preflight.projectId !== projectId) {
      cancelPendingCredentialFlow();
    }
    const warning = pendingCredentialWarningRef.current;
    if (warning) cancelPendingCredentialFlow();
  }, [cancelPendingCredentialFlow, projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingCredentialFlow();
    };
  }, [cancelPendingCredentialFlow]);

  const performCreate = async (options: ClaudeOptions) => {
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

      void startEnvironment(
        configuredEnvironment.id,
        options.initialPrompt,
        { background: true, silent: true },
      ).catch((startError) => {
        console.error("Failed to auto-start environment:", startError);
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleCreate = async (options: ClaudeOptions): Promise<boolean> => {
    if (!projectId) return false;
    if (options.environmentType === "local") {
      await performCreate(options);
      return true;
    }

    cancelPendingCredentialFlow();
    let cancelPreflight!: () => void;
    const cancelled = new Promise<typeof PREFLIGHT_CANCELLED>((resolve) => {
      cancelPreflight = () => resolve(PREFLIGHT_CANCELLED);
    });
    const preflight: PendingGitHubCredentialPreflight = {
      projectId,
      cancel: cancelPreflight,
    };
    activePreflightRef.current = preflight;
    setIsCreating(true);
    const result = await Promise.race([
      getContainerGitHubCredentialStatus().then(
        (status) => ({ status }),
        (error: unknown) => ({ error }),
      ),
      cancelled,
    ]);

    if (activePreflightRef.current === preflight) {
      activePreflightRef.current = null;
    }
    if (result === PREFLIGHT_CANCELLED) return false;
    if (!mountedRef.current || !open || preflight.projectId !== projectId) {
      return false;
    }
    setIsCreating(false);

    const status = "status" in result ? result.status : null;
    if ("error" in result) {
      console.error("Failed to check GitHub credential status:", result.error);
    }

    if (status?.available) {
      await performCreate(options);
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const pending = {
        options,
        status,
        resolve,
        settled: false,
        creating: false,
      };
      pendingCredentialWarningRef.current = pending;
      setPendingCredentialWarning(pending);
    });
  };

  const dismissCredentialWarning = () => {
    if (isCreating) return;
    const pending = pendingCredentialWarningRef.current;
    if (pending) settleCredentialWarning(pending, { created: false });
  };

  const createWithoutGitHubCredential = async () => {
    const pending = pendingCredentialWarningRef.current;
    if (!pending || pending.creating) return;
    pending.creating = true;

    try {
      await performCreate(pending.options);
      settleCredentialWarning(pending, { created: true });
    } catch (error) {
      console.error("Failed to create environment:", error);
      settleCredentialWarning(pending, { created: false });
    }
  };

  const warningTitle =
    pendingCredentialWarning?.status?.source === "host-cli"
      ? "No GitHub CLI credentials found"
      : pendingCredentialWarning?.status?.source === "pat"
        ? "No GitHub token configured"
        : "GitHub credentials could not be verified";
  const warningDescription =
    pendingCredentialWarning?.status?.source === "host-cli"
      ? "Orkestrator could not read an active GitHub CLI login from the host running Orkestrator. Private repositories will not clone until you run gh auth login or switch to a personal access token in General Settings."
      : pendingCredentialWarning?.status?.source === "pat"
        ? "Personal access token mode is selected, but no token is stored. Private repositories will not clone until you add a token in General Settings or switch to host GitHub CLI credentials."
        : "Orkestrator could not confirm that GitHub credentials are available. Private repositories may fail to clone.";

  return (
    <>
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

      <AlertDialog
        open={pendingCredentialWarning !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) dismissCredentialWarning();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 space-y-2">
                <AlertDialogTitle>{warningTitle}</AlertDialogTitle>
                <AlertDialogDescription>{warningDescription}</AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground">
            Public repositories can still be created without GitHub credentials.
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCreating}>Go back</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => void createWithoutGitHubCredential()}
              disabled={isCreating}
            >
              {isCreating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create anyway
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
