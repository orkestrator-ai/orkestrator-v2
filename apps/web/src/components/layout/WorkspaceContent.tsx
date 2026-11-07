import { lazy, useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { LazyLoadBoundary, LazyLoadInlineErrorFallback } from "@/components/LazyLoadBoundary";
import { ProjectLauncher } from "@/components/projects";
import { TerminalContainer } from "@/components/terminal";
import { useEnvironments } from "@/hooks";
import { useEnvironmentLifecycleService } from "@/hooks/useEnvironments";
import { useGlobalActivityMonitor } from "@/hooks/useGlobalActivityMonitor";
import { useHydrateOncePerEnvironment } from "@/hooks/useHydrateOncePerEnvironment";
import { usePrMonitorService } from "@/hooks/usePrMonitorService";
import type { useProjectHomeActivation } from "@/hooks/useProjectHomeActivation";
import { useUnreadEnvironmentSync } from "@/hooks/useUnreadEnvironmentSync";
import {
  agentSettingsTiers,
  resolvedActionDefault,
  resolvedDefaultAgent,
} from "@/lib/agent-settings";
import * as backend from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createFilesSessionsApi } from "@/lib/backend/files-sessions";
import { createProjectsEnvironmentsApi } from "@/lib/backend/projects-environments";
import {
  environmentHydrationFor,
  hydrateBootMultiReviewWorkflows,
  hydrateBootPromptQueues,
} from "@/lib/boot-hydration";
import { hydrateBuildPipelinesForProject } from "@/lib/build-pipeline-persistence";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useNodeScope } from "@/lib/node-scope/providers";
import { createPromptQueueSources } from "@/lib/prompt-queue-sources";
import { cn } from "@/lib/utils";
import {
  claudeOptionsStore,
  environmentStore,
  useClaudeOptionsStore,
  useConfigStore,
  useEnvironmentStore,
  useUIStore,
} from "@/stores";
import { useProjectStore } from "@/stores/projectStore";
import type { Environment } from "@/types";

const log = createLogger("web.app");

// Kanban, issues, pull requests and the coordinator: nothing there is needed until a project board opens.
const LazyProjectWorkspace = lazy(async () => ({
  default: (await import("@/components/projects/ProjectWorkspace")).ProjectWorkspace,
}));

/**
 * Setup can fail after Docker has successfully created and started the
 * container. The backend reports that lifecycle outcome as `status: "error"`,
 * but the existing container is still the workspace in which retry/override
 * must run. Keep that surface live until setup is resolved.
 */
export function isEnvironmentContainerAvailable(
  environment: Pick<Environment, "containerId" | "environmentType" | "setupPhase" | "status">,
): boolean {
  if (environment.environmentType === "local" || !environment.containerId) return false;
  return (
    environment.status === "running" ||
    (environment.status === "error" && environment.setupPhase === "failed")
  );
}

/**
 * The background work a node's workspace keeps running for that node, in the
 * nearest node scope: PR monitoring, activity, environment lifecycle events
 * and unread sync. `App` runs it for the command scope, `InTreeWorkspace` for
 * a node shown in the window's tree (plan item 4001): one list for both.
 */
export function useNodeWorkspaceServices(): void {
  // Centralized PR monitoring for the node's environments.
  usePrMonitorService();
  // Agent activity for every environment of the node, selected or not.
  useGlobalActivityMonitor();
  // Setup lifecycle events and resume/reconnect reconciliation, once per node.
  useEnvironmentLifecycleService();
  // Opening an environment clears its unread badge for every client.
  useUnreadEnvironmentSync();
}

function warnPromptQueueRestoreFailed(environmentId: string, error: unknown): void {
  log.warn("prompt-queues.restore-failed", { environmentId, error: formatLogError(error) });
}

function warnMultiReviewRestoreFailed(environmentId: string, error: unknown): void {
  log.warn("multi-reviews.restore-failed", { environmentId, error: formatLogError(error) });
}

/**
 * The boot restore of a node's backend-owned lists into `scope`'s stores:
 * prompt queues and Multi Review workflows per environment, build pipelines
 * per project. Call it after the scope's services have started (the change
 * feed before any snapshot read).
 *
 * Each node's restores go through its own boot batcher (`boot-hydration.ts`,
 * one per scope) into its own stores: a leaf's tmux tabs get the leaf's
 * prompt queues and its reviews the leaf's workflows (plan item 4007).
 */
export function useNodeBootHydration(scope: NodeScope): void {
  const environments = useEnvironmentStore((state) => state.environments);
  const promptQueueSources = useMemo(() => createPromptQueueSources(scope), [scope]);
  const hydratePromptQueues = useCallback(
    (environmentId: string) =>
      hydrateBootPromptQueues(environmentId, promptQueueSources, environmentHydrationFor(scope)),
    [promptQueueSources, scope],
  );
  useHydrateOncePerEnvironment(
    environments,
    hydratePromptQueues,
    warnPromptQueueRestoreFailed,
    scope,
  );

  // The single renderer-side hydration pass for backend-owned reviews. Resource
  // change events perform incremental refreshes; this closes the gap after a
  // renderer exit/remount, when the store starts empty.
  const hydrateMultiReviews = useCallback(
    (environmentId: string) =>
      hydrateBootMultiReviewWorkflows(environmentId, environmentHydrationFor(scope), scope),
    [scope],
  );
  useHydrateOncePerEnvironment(
    environments,
    hydrateMultiReviews,
    warnMultiReviewRestoreFailed,
    scope,
  );

  // Pipelines are stored per project, so restore once per project rather than
  // once per environment: a pipeline still in "creating-environment" has no
  // environment to key off yet, and that is exactly the state a crash used to
  // strand. Driven by the project list rather than by the environments' project
  // ids, because a project whose only pipeline never reached an environment has
  // no environment to derive its id from either.
  const projects = useProjectStore((state) => state.projects);
  const pipelineProjectIds = useMemo(
    () => [...new Set(projects.map((project) => project.id))].sort().join(","),
    [projects],
  );
  useEffect(() => {
    if (!pipelineProjectIds) return;
    for (const projectId of pipelineProjectIds.split(",")) {
      void hydrateBuildPipelinesForProject(projectId, undefined, scope).catch((error) => {
        log.warn("build-pipelines.restore-failed", { projectId, error: formatLogError(error) });
      });
    }
  }, [scope, pipelineProjectIds]);
}

export interface WorkspaceContentProps {
  /** What the selected project's home activation reports (`useProjectHomeActivation`). */
  projectHomeActivation: ReturnType<typeof useProjectHomeActivation>;
  /**
   * Whether the host this window runs on lets environments start: macOS
   * privacy access is resolved first. Always true for another machine's.
   */
  startAllowed: boolean;
  /** The node's Docker daemon: `false` refuses container starts, `null` is unknown. */
  dockerAvailable: boolean | null;
}

/**
 * What the central region shows for the nearest node scope: the selected
 * environment's tabs and panes, the selected project's board over its home,
 * or the node's project launcher. The command node's own workspace and a node
 * shown in the window's tree (plan item 4001) both render this, each inside
 * its own `NodeScopeProvider` (report §5.2: one workspace implementation).
 */
export function WorkspaceContent({
  projectHomeActivation,
  startAllowed,
  dockerAvailable,
}: WorkspaceContentProps) {
  const scope = useNodeScope();
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const projectBoardTab = useUIStore((state) => state.projectBoardTab);
  const setProjectBoardTab = useUIStore((state) => state.setProjectBoardTab);
  const environments = useEnvironmentStore((state) => state.environments);
  const getEnvironmentById = useEnvironmentStore((state) => state.getEnvironmentById);
  const config = useConfigStore((state) => state.config);
  const setClaudeOptions = useClaudeOptionsStore((state) => state.setOptions);
  const clearClaudeOptions = useClaudeOptionsStore((state) => state.clearOptions);
  const { startEnvironment, createEnvironment, updateEnvironment } = useEnvironments(null, {
    listenForRenameEvents: false,
  });

  const selectedEnvironment = selectedEnvironmentId
    ? (environments.find((env) => env.id === selectedEnvironmentId) ?? null)
    : null;
  const isProjectHomeSelected = selectedEnvironment?.projectHome === true;
  // A project's page runs on its project home: the board panels cover the
  // home's own tabs, which stay mounted so toolbar actions can open tabs there.
  const showProjectBoard =
    !!selectedProjectId &&
    (!selectedEnvironment || (isProjectHomeSelected && projectBoardTab !== "home"));
  const revealProjectHome = useCallback(() => setProjectBoardTab("home"), [setProjectBoardTab]);

  const handleStartEnvironmentFromOverlay = useCallback(
    async (environmentId: string, initialPrompt?: string): Promise<boolean> => {
      if (!startAllowed) return false;
      const environment = getEnvironmentById(environmentId);
      if (environment?.environmentType !== "local" && dockerAvailable === false) {
        toast.warning("Docker is not running", {
          description: "Container environments are disabled until Docker is available.",
        });
        return false;
      }
      const explicitPrompt = initialPrompt?.trim();
      const storedPrompt =
        !explicitPrompt && !environment?.setupScriptsComplete
          ? environment?.initialPrompt?.trim()
          : undefined;
      const launchPrompt = explicitPrompt || storedPrompt || undefined;
      const existingOptions = scope.store(claudeOptionsStore).getState().getOptions(environmentId);

      if (launchPrompt) {
        // List hydration deliberately excludes attachment bodies. Read the
        // targeted record only for the one launch that needs them — the listed
        // record still says whether there is anything to read, so a prompt with
        // no attachments costs no round trip and cannot be blocked by one.
        let detailedEnvironment = environment;
        /**
         * `undefined` means the backend predates the flag, so the read still has
         * to happen — but a failure then degrades to the listed record rather
         * than refusing the launch, which is what that backend always did.
         * Only a backend that positively says "there are attachments" earns a
         * blocking failure, because that is the only case where starting anyway
         * would run a prompt whose attachments are missing.
         */
        const attachmentState = environment?.hasInitialPromptAttachments;
        if (existingOptions?.initialPromptAttachments === undefined && attachmentState !== false) {
          try {
            const loadedEnvironment = await backendApiForScope(
              scope,
              createProjectsEnvironmentsApi,
              backend,
            ).getEnvironment(environmentId);
            if (!loadedEnvironment) {
              throw new Error(`Environment ${environmentId} was not found`);
            }
            detailedEnvironment = loadedEnvironment;
          } catch (error) {
            log.error("attachments.restore-failed", {
              environmentId,
              error: formatLogError(error),
            });
            if (attachmentState === true) {
              toast.error("Could not restore saved prompt attachments", {
                description:
                  "The environment was not started. Try again to reload its saved prompt.",
              });
              return false;
            }
          }
        }
        const storedAttachments = detailedEnvironment?.initialPromptAttachments?.map(
          (attachment) => ({
            ...attachment,
            ...(attachment.type === "file"
              ? {}
              : {
                  previewUrl:
                    attachment.previewUrl ?? `data:image/png;base64,${attachment.base64Data}`,
                }),
          }),
        );
        const launchOptions = {
          launchAgent: true,
          agentType:
            existingOptions?.agentType ??
            resolvedDefaultAgent(config, environment?.projectId, environment),
          initialPrompt: launchPrompt,
          initialPromptAttachments: existingOptions?.initialPromptAttachments ?? storedAttachments,
          ...(existingOptions?.model ? { model: existingOptions.model } : {}),
          ...(existingOptions?.reasoningEffort
            ? { reasoningEffort: existingOptions.reasoningEffort }
            : {}),
          // Boolean check rather than truthiness: an explicit Normal is a
          // choice the create dialog made, and `false` must survive it.
          ...(typeof existingOptions?.fastMode === "boolean"
            ? { fastMode: existingOptions.fastMode }
            : {}),
        };
        setClaudeOptions(environmentId, launchOptions);
        try {
          const prepared = await backendApiForScope(
            scope,
            createFilesSessionsApi,
            backend,
          ).prepareEnvironmentAgentLaunch(environmentId, {
            agent: launchOptions.agentType,
            initialPrompt: launchPrompt,
            model: launchOptions.model,
            reasoningEffort: launchOptions.reasoningEffort,
            fastMode: launchOptions.fastMode,
            attachments: launchOptions.initialPromptAttachments,
          });
          scope.store(environmentStore).getState().updateEnvironment(environmentId, prepared);
        } catch (error) {
          log.error("startup-launch.persist-failed", {
            environmentId,
            error: formatLogError(error),
          });
          toast.error("Could not prepare the agent launch", {
            description: "The environment was not started because its prompt could not be saved.",
          });
          return false;
        }
      } else if (existingOptions?.initialPrompt?.trim()) {
        clearClaudeOptions(environmentId);
      }

      try {
        // Setup command handling (blocking, placeholder, resolve) is centralized
        // in useEnvironments.startEnvironment() for all code paths.
        await startEnvironment(environmentId, launchPrompt);
        return true;
      } catch (error) {
        log.error("environment.start-failed", { environmentId, error: formatLogError(error) });
        return false;
      }
    },
    [
      clearClaudeOptions,
      scope,
      config,
      dockerAvailable,
      getEnvironmentById,
      startAllowed,
      setClaudeOptions,
      startEnvironment,
    ],
  );

  const handleCreateScriptFromOverlay = useCallback(
    async (environmentId: string, initialPrompt: string) => {
      const environment = getEnvironmentById(environmentId);
      const enabledAgents = config.global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"];
      const actionDefault = resolvedActionDefault(
        agentSettingsTiers(config, environment?.projectId, environment),
        "createScript",
        enabledAgents,
      );

      setClaudeOptions(environmentId, {
        launchAgent: true,
        agentType: actionDefault.agent,
        initialPrompt,
        ...(actionDefault.model ? { model: actionDefault.model } : {}),
        ...(actionDefault.reasoningEffort
          ? { reasoningEffort: actionDefault.reasoningEffort }
          : {}),
      });

      const started = await handleStartEnvironmentFromOverlay(environmentId, initialPrompt);
      if (!started) {
        clearClaudeOptions(environmentId);
      }
    },
    [
      clearClaudeOptions,
      config,
      getEnvironmentById,
      handleStartEnvironmentFromOverlay,
      setClaudeOptions,
    ],
  );

  if (!selectedEnvironment && !selectedProjectId) {
    return (
      <ProjectLauncher
        createEnvironment={createEnvironment}
        updateEnvironment={updateEnvironment}
        startEnvironment={startEnvironment}
      />
    );
  }
  return (
    <div className="relative h-full bg-background">
      {selectedEnvironment && (
        <div
          {...(isProjectHomeSelected
            ? {
                id: "project-panel-home",
                role: "tabpanel",
                "aria-hidden": showProjectBoard,
              }
            : {})}
          className={cn("absolute inset-0 z-10 bg-background", showProjectBoard && "invisible")}
        >
          {/*
            `isContainerRunning` is deliberately not gated on Docker
            availability. A false value means "this container stopped",
            and TerminalContainer answers it by disposing every terminal
            and resetting the pane layout, so feeding a daemon-wide probe
            into a per-environment fact would destroy the user's tabs on a
            transient outage. The daemon state gates *actions* instead:
            handleStartEnvironmentFromOverlay refuses to start a container
            while Docker is down.
          */}
          <TerminalContainer
            environmentId={selectedEnvironment.id}
            containerId={selectedEnvironment.containerId ?? null}
            isContainerRunning={isEnvironmentContainerAvailable(selectedEnvironment)}
            isContainerCreating={selectedEnvironment.status === "creating"}
            isActive
            className="h-full"
            onStartContainer={(initialPrompt) => {
              void handleStartEnvironmentFromOverlay(selectedEnvironment.id, initialPrompt);
            }}
            onCreateScript={(initialPrompt) => {
              void handleCreateScriptFromOverlay(selectedEnvironment.id, initialPrompt);
            }}
            obscured={showProjectBoard}
            onReveal={isProjectHomeSelected ? revealProjectHome : undefined}
          />
        </div>
      )}
      {showProjectBoard && selectedProjectId && (
        <div className="absolute inset-0 z-20 bg-background">
          <LazyLoadBoundary renderError={(details) => <LazyLoadInlineErrorFallback {...details} />}>
            <LazyProjectWorkspace
              projectId={selectedProjectId}
              homeError={projectHomeActivation.error}
              onRetryHome={projectHomeActivation.retry}
            />
          </LazyLoadBoundary>
        </div>
      )}
    </div>
  );
}
